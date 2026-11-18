import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseAdminClient } from '@/lib/supabase-server'
import { getRequestActor } from '@/lib/server-auth'
import { getOptionalServerEnv } from '@/lib/server-runtime-env'
import {
  ParcelsApiError,
  createParcelsTrackingBatch,
  pollParcelsTrackingSession,
} from '@/lib/parcels-api'
import {
  saveParcelsTrackingRequest,
  syncOrderWithParcelsShipment,
} from '@/lib/tracking-sync'

interface ActiveShipmentRow {
  id: string
  status: string
  courier: string | null
  courier_slug?: string | null
  tracking_number: string | null
}

const ACTIVE_SYNC_STATUSES = ['Processing', 'Shipped', 'In Transit', 'Out for Delivery']
const BATCH_CHUNK_SIZE = 20

function isMissingCourierSlugError(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false
  const msg = (error.message || '').toLowerCase()
  return error.code === '42703' || error.code === 'PGRST204' || msg.includes('courier_slug')
}

async function isAuthorizedSyncCaller(request: NextRequest): Promise<boolean> {
  const cronSecret = getOptionalServerEnv('CRON_SECRET')
  if (cronSecret) {
    const authHeader = request.headers.get('authorization')?.trim()
    if (authHeader === `Bearer ${cronSecret}`) {
      return true
    }
  }

  const actor = await getRequestActor(request)
  return actor?.role === 'ADMIN'
}

/**
 * Batch-syncs active online shipments with Parcels API v5 (`POST /trackings`).
 * Callable by an ADMIN user from `/admin/orders` or by a scheduled cron job
 * presenting `Authorization: Bearer <CRON_SECRET>`.
 */
export async function POST(request: NextRequest) {
  try {
    if (!(await isAuthorizedSyncCaller(request))) {
      return NextResponse.json(
        { error: 'Only administrators or authorized cron jobs can run delivery sync.' },
        { status: 403 },
      )
    }

    const body = (await request.json().catch(() => null)) as { orderIds?: string[] } | null
    const filterOrderIds = Array.isArray(body?.orderIds)
      ? body.orderIds.map((id) => String(id).trim()).filter(Boolean)
      : []

    const supabase = createSupabaseAdminClient()

    const runOrdersQuery = async (cols: string) => {
      let query = supabase
        .from('store_orders')
        .select(cols)
        .eq('source', 'ONLINE')
        .in('status', ACTIVE_SYNC_STATUSES)
        .not('tracking_number', 'is', null)

      if (filterOrderIds.length > 0) {
        query = query.in('id', filterOrderIds)
      }

      return query.order('created_at', { ascending: false }).limit(100)
    }

    let res = await runOrdersQuery('id, status, courier, courier_slug, tracking_number')
    if (res.error && isMissingCourierSlugError(res.error)) {
      res = await runOrdersQuery('id, status, courier, tracking_number') as typeof res
    }

    if (res.error) {
      throw res.error
    }

    const orders = ((res.data ?? []) as unknown as ActiveShipmentRow[]).filter(
      (o) => typeof o.tracking_number === 'string' && o.tracking_number.trim().length > 0,
    )

    if (orders.length === 0) {
      return NextResponse.json({
        ok: true,
        checked: 0,
        updated: 0,
        checkpointsAdded: 0,
        pending: 0,
        message: 'No active online orders with assigned tracking numbers were found.',
      })
    }

    let updatedCount = 0
    let checkpointCount = 0
    let pendingCount = 0
    const requestIds: string[] = []
    const rejected: Array<{ orderId?: string; trackingNumber?: string; code: string; message: string }> = []

    for (let i = 0; i < orders.length; i += BATCH_CHUNK_SIZE) {
      const chunk = orders.slice(i, i + BATCH_CHUNK_SIZE)
      const orderByTracking = new Map<string, ActiveShipmentRow>()

      for (const order of chunk) {
        const key = order.tracking_number!.trim().toLowerCase()
        if (!orderByTracking.has(key)) {
          orderByTracking.set(key, order)
        }
      }

      let session = await createParcelsTrackingBatch({
        shipments: chunk.map((order) => ({
          trackingNumber: order.tracking_number!.trim(),
          carrierHint: order.courier_slug || undefined,
          destinationCountry: 'PH',
        })),
      })

      requestIds.push(session.request_id)

      // Briefly poll once if not immediately completed from cache
      if (!session.done) {
        await new Promise((resolve) => setTimeout(resolve, 1200))
        const polled = await pollParcelsTrackingSession(session.request_id).catch(() => null)
        if (polled) {
          session = polled
        }
      }

      for (const order of chunk) {
        await saveParcelsTrackingRequest({
          response: session,
          trackingNumber: order.tracking_number!.trim(),
          orderId: order.id,
          carrierHint: order.courier_slug || null,
        })
      }

      for (const rej of session.rejected ?? []) {
        const matchedOrder = rej.tracking_number
          ? orderByTracking.get(rej.tracking_number.trim().toLowerCase())
          : undefined
        rejected.push({
          orderId: matchedOrder?.id,
          trackingNumber: rej.tracking_number,
          code: rej.code,
          message: rej.message,
        })
      }

      for (const item of session.results ?? []) {
        if (item.state === 'processing') {
          pendingCount++
          continue
        }

        const matchedOrder = orderByTracking.get(item.tracking_number.trim().toLowerCase())
        if (!matchedOrder) continue

        const syncRes = await syncOrderWithParcelsShipment(matchedOrder, item)
        if (syncRes.updatedStatus) updatedCount++
        if (syncRes.recordedCheckpoint) checkpointCount++
      }
    }

    return NextResponse.json({
      ok: true,
      checked: orders.length,
      updated: updatedCount,
      checkpointsAdded: checkpointCount,
      pending: pendingCount,
      requestIds,
      rejected,
      message:
        updatedCount > 0 || checkpointCount > 0
          ? `Synced ${orders.length} shipment(s): ${updatedCount} status advancement(s), ${checkpointCount} checkpoint update(s).`
          : `Checked ${orders.length} shipment(s); ${pendingCount > 0 ? `${pendingCount} still awaiting courier response (webhooks/refresh will update).` : 'all statuses are already up to date.'}`,
    })
  } catch (error) {
    if (error instanceof ParcelsApiError) {
      return NextResponse.json(
        { ok: false, error: error.message, code: error.code },
        { status: error.status >= 400 && error.status < 600 ? error.status : 502 },
      )
    }

    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : 'Unable to synchronize delivery updates.'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
