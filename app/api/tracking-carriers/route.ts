import { NextRequest, NextResponse } from 'next/server'
import { getRequestActor } from '@/lib/server-auth'
import { ParcelsApiError, searchTrackingCarriers } from '@/lib/parcels-api'

/**
 * Proxies Parcels API v5 `GET /tracking-carriers` for Admin/Staff delivery
 * management so canonical `carrier_hint` slugs and input rules can be selected
 * without exposing `PARCELS_API_KEY` to the browser.
 */
export async function GET(request: NextRequest) {
  try {
    const actor = await getRequestActor(request)
    if (!actor || (actor.role !== 'ADMIN' && actor.role !== 'STAFF')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    const query = request.nextUrl.searchParams.get('query')?.trim() || ''
    const cursor = request.nextUrl.searchParams.get('cursor')?.trim() || undefined
    const limitParam = Number(request.nextUrl.searchParams.get('limit') || '20')
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 20

    const catalog = await searchTrackingCarriers({
      query,
      language: 'en',
      cursor,
      limit,
    })

    return NextResponse.json(catalog)
  } catch (error) {
    if (error instanceof ParcelsApiError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status >= 400 && error.status < 600 ? error.status : 502 },
      )
    }

    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : 'Unable to load Parcels v5 tracking carriers.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
