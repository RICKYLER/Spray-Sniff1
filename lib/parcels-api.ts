import '@/lib/server-only'
import crypto from 'crypto'
import { getOptionalServerEnv } from '@/lib/server-runtime-env'
import {
  mapParcelsStateToDeliveryStage,
  toComparableTimestampMs,
  type CourierInfo,
  type DeliveryEstimateSummary,
  type TrackingEvent,
  type TrackingResult,
} from '@/lib/tracking-types'

const LIVE_API_BASE = 'https://parcelsapp.com/api/v5'
const MOCK_API_BASE = 'https://parcelsapp.com/api-docs/mock/v5'

export type ParcelsTransportMode =
  | 'parcel'
  | 'postal'
  | 'express'
  | 'air_cargo'
  | 'ocean_freight'
  | 'road_freight'
  | 'rail_freight'

export interface ParcelsCarrier {
  slug: string
  name: string
  phone?: string
  url?: string
}

export interface ParcelsInputRequirements {
  required?: string[]
  any_of?: string[]
  conditional?: string[]
}

export interface ParcelsTrackingCarrier {
  slug: string
  name: string
  input_requirements?: ParcelsInputRequirements
}

export interface ParcelsTrackingCarrierCatalogResponse {
  query: string
  language: string
  carriers: ParcelsTrackingCarrier[]
  total_matches: number
  next_cursor: string | null
  has_more: boolean
  catalog_version: string
}

export interface ParcelsState {
  state: string
  location?: string
  date: string
  utcOffset?: string
  event_code?: string
  station?: string
  timezone?: string
  pieces?: number
  weight?: number
  weight_unit?: string
  volume?: number
  volume_unit?: string
  flight_number?: string
  flight_origin?: string
  flight_destination?: string
  scheduled_departure_date?: string
  scheduled_departure?: string
  scheduled_departure_utc_offset?: string
  scheduled_arrival?: string
  scheduled_arrival_utc_offset?: string
  actual_departure?: string
  actual_departure_utc_offset?: string
  actual_arrival?: string
  actual_arrival_utc_offset?: string
  uld_number?: string
  carrier?: number
}

export interface ParcelsFlightLeg {
  flight_number?: string
  origin?: string
  destination?: string
  status?: string
  scheduled_departure_date?: string
  scheduled_departure?: string
  scheduled_departure_utc_offset?: string
  scheduled_arrival?: string
  scheduled_arrival_utc_offset?: string
  actual_departure?: string
  actual_departure_utc_offset?: string
  actual_arrival?: string
  actual_arrival_utc_offset?: string
  pieces?: number
  weight?: number
  weight_unit?: string
  volume?: number
  volume_unit?: string
}

export interface ParcelsExternalTracking {
  slug: string
  url: string
  trackingId?: string
  method?: string
}

export interface ParcelsShipment {
  trackingId?: string
  error?: string
  accepted_fields?: string[]
  input_requirements?: ParcelsInputRequirements
  status?: string
  origin?: string
  destination?: string
  originCode?: string
  destinationCode?: string
  transportMode?: ParcelsTransportMode | string
  fromAirport?: string
  toAirport?: string
  fromPort?: string
  toPort?: string
  pieces?: number
  weight?: number
  weight_unit?: string
  volume?: number
  volume_unit?: string
  daysInTransit?: number
  flight_legs?: ParcelsFlightLeg[]
  states?: ParcelsState[]
  services?: ParcelsCarrier[]
  detectedCarrier?: ParcelsCarrier
  detected?: number[]
  attributes?: Array<{ l?: string; val?: string; code?: string }>
  externalTracking?: ParcelsExternalTracking[]
}

export interface ParcelsDeliveryEstimateValues {
  mean_days: number
  median_days: number
  typical_days?: {
    min?: number
    max?: number
  }
  remaining_status?: string
  remaining_days?: {
    mean?: number
    median?: number
    min?: number
    max?: number
  }
  estimated_delivery_at?: {
    from?: string
    to?: string
  }
}

export interface ParcelsDeliveryEstimateResult {
  client_reference?: string
  carrier_slug: string
  transport_mode: string
  completion_scope?: string
  route_scope_used?: string
  estimate?: ParcelsDeliveryEstimateValues
  confidence?: {
    level?: string
    score?: number
    sample_count?: number
  }
  error?: {
    code: string
    message: string
  }
}

export interface ParcelsTrackingResultItem {
  tracking_number: string
  state: 'processing' | 'completed'
  from_cache?: boolean
  shipment?: ParcelsShipment
  delivery_estimate?: ParcelsDeliveryEstimateResult
}

export interface ParcelsRejectedShipment {
  index: number
  tracking_number?: string
  code: 'INVALID_TRACKING_NUMBER' | 'DESTINATION_COUNTRY_REQUIRED' | 'INVALID_ADDITIONAL_FIELDS' | string
  message: string
}

export interface ParcelsWebhookRegistration {
  url?: string
  secret?: string
  signature_header?: string
}

export interface ParcelsApiErrorObject {
  code: string
  message: string
  limit?: number
  current?: number
  requested_new?: number
  available?: number
  confirmation_url?: string
  confirmation_expires_at?: string
  rejected?: ParcelsRejectedShipment[]
}

export interface ParcelsTrackingResponse {
  request_id: string
  status: 'processing' | 'completed' | string
  done: boolean
  expires_at?: string
  results?: ParcelsTrackingResultItem[]
  rejected?: ParcelsRejectedShipment[]
  webhook?: ParcelsWebhookRegistration
  error?: ParcelsApiErrorObject
}

export interface ParcelsTrackingItemInput {
  trackingNumber: string
  destinationCountry?: string
  carrierHint?: string
  postalCode?: string
  email?: string
  phone?: string
  additionalFields?: Record<string, string>
}

export interface TrackShipmentOptions extends ParcelsTrackingItemInput {
  webhookUrl?: string
  maxPollSeconds?: number
}

export class ParcelsApiError extends Error {
  status: number
  code: string
  details?: ParcelsApiErrorObject

  constructor(message: string, options: { status: number; code?: string; details?: ParcelsApiErrorObject }) {
    super(message)
    this.name = 'ParcelsApiError'
    this.status = options.status
    this.code = options.code || 'PARCELS_API_ERROR'
    this.details = options.details
  }
}

/**
 * Returns the active ParcelsApp API v5 base URL and optional API token.
 * Defaults to the official v5 mock sandbox when PARCELS_API_KEY is not configured.
 */
export function getParcelsConfig() {
  const apiKey = getOptionalServerEnv('PARCELS_API_KEY')
  const isLive = Boolean(apiKey)
  const baseUrl = isLive ? LIVE_API_BASE : MOCK_API_BASE

  return {
    apiKey,
    baseUrl,
    isLive,
    isMock: !isLive,
    version: 'v5' as const,
  }
}

function getAuthHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  return headers
}

/**
 * Resolves a valid HTTPS webhook callback URL if configured.
 * Parcels v5 rejects non-HTTPS URLs with INVALID_WEBHOOK_URL, so local HTTP origins are omitted.
 */
export function resolveParcelsWebhookUrl(explicitUrl?: string): string | undefined {
  const candidate = explicitUrl?.trim()
  if (candidate) {
    return candidate.startsWith('https://') ? candidate : undefined
  }

  const siteUrl = getOptionalServerEnv('NEXT_PUBLIC_SITE_URL')
  if (!siteUrl) return undefined

  const normalized = siteUrl.replace(/\/$/, '')
  if (!normalized.startsWith('https://')) {
    return undefined
  }

  return `${normalized}/api/webhooks/parcels`
}

async function parseErrorResponse(res: Response, fallbackPrefix: string): Promise<ParcelsApiError> {
  const rawText = await res.text().catch(() => '')
  let parsedError: ParcelsApiErrorObject | undefined

  if (rawText) {
    try {
      const json = JSON.parse(rawText) as { error?: ParcelsApiErrorObject }
      if (json?.error && typeof json.error === 'object') {
        parsedError = json.error
      }
    } catch {
      // Non-JSON upstream error body
    }
  }

  const message = parsedError?.message
    ? `Parcels API v5 (${parsedError.code}): ${parsedError.message}`
    : `${fallbackPrefix} (${res.status}): ${rawText || res.statusText}`

  return new ParcelsApiError(message, {
    status: res.status,
    code: parsedError?.code,
    details: parsedError,
  })
}

/**
 * Initiates a Parcels API v5 asynchronous tracking request for one or more shipments.
 */
export async function createParcelsTrackingBatch(options: {
  shipments: ParcelsTrackingItemInput[]
  language?: 'en' | 'ru'
  webhookUrl?: string
}): Promise<ParcelsTrackingResponse> {
  const { apiKey, baseUrl, isLive } = getParcelsConfig()

  const shipmentsPayload = options.shipments
    .map((item) => {
      const trackingNumber = item.trackingNumber.trim()
      if (!trackingNumber) return null

      const carrierHint = item.carrierHint?.trim() || undefined
      const destinationCountry = item.destinationCountry?.trim() || (carrierHint ? undefined : 'PH')

      const entry: Record<string, unknown> = {
        tracking_number: trackingNumber,
      }
      if (destinationCountry) entry.destination_country = destinationCountry
      if (carrierHint) entry.carrier_hint = carrierHint
      if (item.postalCode?.trim()) entry.postal_code = item.postalCode.trim()
      if (item.email?.trim()) entry.email = item.email.trim()
      if (item.phone?.trim()) entry.phone = item.phone.trim()
      if (item.additionalFields && Object.keys(item.additionalFields).length > 0) {
        entry.additional_fields = item.additionalFields
      }

      return entry
    })
    .filter((item): item is Record<string, unknown> => item !== null)

  if (shipmentsPayload.length === 0) {
    throw new ParcelsApiError('At least one valid tracking number is required.', {
      status: 400,
      code: 'NO_SHIPMENTS',
    })
  }

  const resolvedWebhookUrl = isLive ? resolveParcelsWebhookUrl(options.webhookUrl) : undefined
  const payload: Record<string, unknown> = {
    language: options.language ?? 'en',
    shipments: shipmentsPayload,
  }
  if (resolvedWebhookUrl) {
    payload.webhook_url = resolvedWebhookUrl
  }

  const res = await fetch(`${baseUrl}/trackings`, {
    method: 'POST',
    headers: getAuthHeaders(apiKey),
    body: JSON.stringify(payload),
    cache: 'no-store',
  })

  if (!res.ok) {
    throw await parseErrorResponse(res, 'ParcelsApp API error')
  }

  return (await res.json()) as ParcelsTrackingResponse
}

/**
 * Convenience single-shipment wrapper around `createParcelsTrackingBatch`.
 */
export async function createParcelsTrackingSession(options: {
  trackingNumber: string
  destinationCountry?: string
  carrierHint?: string
  postalCode?: string
  email?: string
  phone?: string
  additionalFields?: Record<string, string>
  webhookUrl?: string
}): Promise<ParcelsTrackingResponse> {
  return createParcelsTrackingBatch({
    webhookUrl: options.webhookUrl,
    shipments: [
      {
        trackingNumber: options.trackingNumber,
        destinationCountry: options.destinationCountry,
        carrierHint: options.carrierHint,
        postalCode: options.postalCode,
        email: options.email,
        phone: options.phone,
        additionalFields: options.additionalFields,
      },
    ],
  })
}

/**
 * Polls a Parcels v5 tracking request until `done: true` or `expires_at` passes.
 * Returns `null` when Parcels returns HTTP 404 (`NO_REQUEST_FOUND` / expired).
 */
export async function pollParcelsTrackingSession(
  requestId: string,
): Promise<ParcelsTrackingResponse | null> {
  const { apiKey, baseUrl } = getParcelsConfig()

  const res = await fetch(`${baseUrl}/trackings/${encodeURIComponent(requestId)}`, {
    method: 'GET',
    headers: getAuthHeaders(apiKey),
    cache: 'no-store',
  })

  if (res.status === 404) {
    return null
  }

  if (!res.ok) {
    throw await parseErrorResponse(res, 'ParcelsApp poll error')
  }

  return (await res.json()) as ParcelsTrackingResponse
}

/**
 * Tracks a shipment synchronously by creating a v5 tracking request and briefly polling
 * if results are not already completed from cache.
 */
export async function trackShipmentSync(
  options: TrackShipmentOptions,
): Promise<{
  response: ParcelsTrackingResponse
  shipmentResult: ParcelsTrackingResultItem | null
  rejected: ParcelsRejectedShipment | null
}> {
  const trimmed = options.trackingNumber.trim()
  if (!trimmed) {
    throw new ParcelsApiError('Tracking number is required.', {
      status: 400,
      code: 'INVALID_TRACKING_NUMBER',
    })
  }

  let session = await createParcelsTrackingSession({
    trackingNumber: trimmed,
    destinationCountry: options.destinationCountry,
    carrierHint: options.carrierHint,
    postalCode: options.postalCode,
    email: options.email,
    phone: options.phone,
    additionalFields: options.additionalFields,
    webhookUrl: options.webhookUrl,
  })

  const findResult = (resp: ParcelsTrackingResponse) =>
    resp.results?.find((r) => r.tracking_number.toLowerCase() === trimmed.toLowerCase()) ??
    resp.results?.[0] ??
    null

  let currentResult = findResult(session)
  const firstRejected = session.rejected?.[0] ?? null

  if (firstRejected && !currentResult) {
    return { response: session, shipmentResult: null, rejected: firstRejected }
  }

  // Return immediately if completed or served from cache
  if (session.done || currentResult?.state === 'completed' || currentResult?.from_cache) {
    return { response: session, shipmentResult: currentResult, rejected: firstRejected }
  }

  const maxSeconds = Math.min(Math.max(options.maxPollSeconds ?? 3, 0), 10)
  const intervalMs = 850
  const maxAttempts = Math.floor((maxSeconds * 1000) / intervalMs)

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))

    try {
      const polled = await pollParcelsTrackingSession(session.request_id)
      if (polled) {
        session = polled
        currentResult = findResult(polled)

        if (session.done || currentResult?.state === 'completed') {
          break
        }
      }
    } catch (pollErr) {
      console.warn('[ParcelsApp v5 Polling Error]:', pollErr)
      break
    }
  }

  return {
    response: session,
    shipmentResult: currentResult,
    rejected: session.rejected?.[0] ?? firstRejected,
  }
}

/**
 * Validates the ParcelsApp HMAC-SHA256 signature on incoming webhook callbacks.
 * Header format: `t=<unix_timestamp>,v1=<hex_signature>`.
 */
export function verifyParcelsWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): { valid: boolean; reason?: string } {
  if (!signatureHeader) {
    return { valid: false, reason: 'Missing Parcels-Signature header.' }
  }

  const parts: Record<string, string> = {}
  for (const item of signatureHeader.split(',')) {
    const [key, value] = item.split('=', 2)
    if (key && value) {
      parts[key.trim()] = value.trim()
    }
  }

  const timestamp = parts.t
  const v1 = parts.v1

  if (!timestamp || !v1) {
    return { valid: false, reason: 'Malformed Parcels-Signature header.' }
  }

  // Reject signatures older than 5 minutes (300 seconds)
  const nowUnix = Math.floor(Date.now() / 1000)
  const eventUnix = parseInt(timestamp, 10)
  if (Number.isNaN(eventUnix) || Math.abs(nowUnix - eventUnix) > 300) {
    return { valid: false, reason: 'Webhook signature timestamp outside the 5-minute tolerance window.' }
  }

  try {
    const signedPayload = `${timestamp}.${rawBody}`
    const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex')

    const v1Buf = Buffer.from(v1, 'hex')
    const expBuf = Buffer.from(expected, 'hex')

    if (v1Buf.length !== expBuf.length || !crypto.timingSafeEqual(v1Buf, expBuf)) {
      return { valid: false, reason: 'Signature mismatch.' }
    }

    return { valid: true }
  } catch (err) {
    return { valid: false, reason: `Signature verification exception: ${String(err)}` }
  }
}

/**
 * Searches the Parcels v5 `GET /tracking-carriers` catalog for canonical slugs
 * accepted by `shipments[].carrier_hint` and their input requirements.
 */
export async function searchTrackingCarriers(options?: {
  query?: string
  language?: 'en' | 'ru'
  cursor?: string
  limit?: number
}): Promise<ParcelsTrackingCarrierCatalogResponse> {
  const { apiKey, baseUrl } = getParcelsConfig()
  const params = new URLSearchParams()

  if (options?.query?.trim()) params.set('query', options.query.trim())
  if (options?.language) params.set('language', options.language)
  if (options?.cursor?.trim()) params.set('cursor', options.cursor.trim())
  if (options?.limit) params.set('limit', String(Math.min(Math.max(options.limit, 1), 100)))

  const qs = params.toString()
  const url = `${baseUrl}/tracking-carriers${qs ? `?${qs}` : ''}`

  const res = await fetch(url, {
    method: 'GET',
    headers: getAuthHeaders(apiKey),
    next: { revalidate: 3600 },
  })

  if (!res.ok) {
    throw await parseErrorResponse(res, 'ParcelsApp tracking-carriers error')
  }

  return (await res.json()) as ParcelsTrackingCarrierCatalogResponse
}

/**
 * Searches canonical carrier slugs eligible for beta delivery-time estimates (`GET /carriers`).
 */
export async function searchEstimateCarriers(options?: {
  query?: string
  transportMode?: ParcelsTransportMode
  limit?: number
}) {
  const { apiKey, baseUrl } = getParcelsConfig()
  const params = new URLSearchParams()

  if (options?.query?.trim()) params.set('query', options.query.trim())
  if (options?.transportMode) params.set('transport_mode', options.transportMode)
  if (options?.limit) params.set('limit', String(Math.min(Math.max(options.limit, 1), 50)))

  const qs = params.toString()
  const url = `${baseUrl}/carriers${qs ? `?${qs}` : ''}`

  const res = await fetch(url, {
    method: 'GET',
    headers: getAuthHeaders(apiKey),
    next: { revalidate: 3600 },
  })

  if (!res.ok) {
    throw await parseErrorResponse(res, 'ParcelsApp delivery-estimate carriers error')
  }

  return res.json()
}

export interface DeliveryEstimateShipmentInput {
  client_reference?: string
  carrier_slug?: string
  carrier_name?: string
  transport_mode: ParcelsTransportMode
  completion_scope?: string
  origin: {
    country_code: string
    admin1_code?: string
    city?: string
    iata?: string
    unlocode?: string
  }
  destination: {
    country_code: string
    admin1_code?: string
    city?: string
    iata?: string
    unlocode?: string
  }
  accepted_at?: string
  shipped_at?: string
  elapsed_days?: number
}

/**
 * Requests beta delivery-time forecasts (`POST /delivery-estimates`).
 */
export async function createDeliveryEstimates(shipments: DeliveryEstimateShipmentInput[]): Promise<{
  results: ParcelsDeliveryEstimateResult[]
  generated_at: string
  model_version: string
}> {
  const { apiKey, baseUrl } = getParcelsConfig()

  const res = await fetch(`${baseUrl}/delivery-estimates`, {
    method: 'POST',
    headers: getAuthHeaders(apiKey),
    body: JSON.stringify({ shipments }),
    cache: 'no-store',
  })

  if (!res.ok) {
    throw await parseErrorResponse(res, 'ParcelsApp delivery-estimates error')
  }

  return res.json()
}

function mapDeliveryEstimateSummary(
  estimateResult?: ParcelsDeliveryEstimateResult,
): DeliveryEstimateSummary | undefined {
  const values = estimateResult?.estimate
  if (!values) return undefined

  return {
    medianDays: values.median_days,
    meanDays: values.mean_days,
    typicalDays: values.typical_days,
    remainingStatus: values.remaining_status,
    remainingDays: values.remaining_days,
    estimatedDeliveryAt: values.estimated_delivery_at,
    confidenceLevel: estimateResult?.confidence?.level,
  }
}

/**
 * Transforms a Parcels API v5 `TrackingResult` item into the application's unified `TrackingResult`.
 */
export function mapParcelsToTrackingResult(
  item: ParcelsTrackingResultItem,
  fallbackTrackingNumber: string,
  extra?: {
    orderId?: string
    requestId?: string
    expiresAt?: string
    internalEvents?: TrackingEvent[]
    defaultCourierName?: string
    defaultCourierSlug?: string
  },
): TrackingResult {
  const shipment = item.shipment
  const trackingNumber = item.tracking_number || shipment?.trackingId || fallbackTrackingNumber
  const detected = shipment?.detectedCarrier || shipment?.services?.[0]
  const externalTrack = shipment?.externalTracking?.[0]

  const carrier: CourierInfo = {
    code: detected?.slug || extra?.defaultCourierSlug || 'courier',
    slug: detected?.slug || extra?.defaultCourierSlug,
    name: detected?.name || extra?.defaultCourierName || 'Courier Partner',
    phone: detected?.phone,
    website: detected?.url,
    externalTrackingUrl: externalTrack?.url,
  }

  const courierEvents: TrackingEvent[] = (shipment?.states ?? []).map((state, index) => {
    const stage = mapParcelsStateToDeliveryStage(state.state)
    return {
      id: `parcels-${trackingNumber}-${index}`,
      datetime: state.date || new Date().toISOString(),
      utcOffset: state.utcOffset,
      timezone: state.timezone,
      eventCode: state.event_code,
      station: state.station,
      status: state.state,
      stage,
      location: state.location || (state.station ? `Station ${state.station}` : 'Courier Transit Hub'),
      description: state.state,
      source: 'courier',
      carrier: carrier.name,
    }
  })

  // Sort merged store milestones and v5 carrier scans chronologically (newest first)
  const mergedEvents = [...(extra?.internalEvents ?? []), ...courierEvents].sort(
    (a, b) =>
      toComparableTimestampMs(b.datetime, b.utcOffset) -
      toComparableTimestampMs(a.datetime, a.utcOffset),
  )

  const rawStatus = shipment?.status || courierEvents[0]?.status || item.state
  const stage =
    item.state === 'processing' && !shipment?.status && courierEvents.length === 0
      ? 'picked_up'
      : mapParcelsStateToDeliveryStage(rawStatus)

  const statusText =
    item.state === 'processing' && !shipment?.status && courierEvents.length === 0
      ? 'Checking Courier Telemetry'
      : stage === 'delivered'
        ? 'Delivered'
        : stage === 'out_for_delivery'
          ? 'Out for Delivery'
          : stage === 'in_transit'
            ? 'In Transit'
            : stage === 'picked_up'
              ? 'Picked Up by Courier'
              : stage === 'failed_attempt'
                ? 'Delivery Attempt Failed'
                : stage === 'exception'
                  ? 'Delivery Exception'
                  : 'In Transit'

  const deliveryEstimate = mapDeliveryEstimateSummary(item.delivery_estimate)

  let estimatedDelivery = 'In transit via courier'
  if (stage === 'delivered') {
    estimatedDelivery = 'Delivered'
  } else if (deliveryEstimate?.estimatedDeliveryAt?.to) {
    estimatedDelivery = `Est. ${new Date(deliveryEstimate.estimatedDeliveryAt.to).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })}`
  } else if (deliveryEstimate?.remainingDays?.median !== undefined) {
    estimatedDelivery = `~${Math.ceil(deliveryEstimate.remainingDays.median)} day(s) remaining`
  } else if (shipment?.daysInTransit) {
    estimatedDelivery = `${shipment.daysInTransit} day(s) in transit`
  }

  return {
    trackingNumber,
    orderId: extra?.orderId,
    requestId: extra?.requestId,
    isProcessing: item.state === 'processing',
    expiresAt: extra?.expiresAt,
    carrier,
    status: stage,
    statusText,
    origin: shipment?.origin,
    destination: shipment?.destination,
    originCode: shipment?.originCode,
    destinationCode: shipment?.destinationCode,
    transportMode: shipment?.transportMode,
    estimatedDelivery,
    deliveryEstimate,
    lastUpdated: mergedEvents[0]?.datetime ?? new Date().toISOString(),
    daysInTransit: shipment?.daysInTransit,
    isLiveCourier: courierEvents.length > 0,
    shipmentError: shipment?.error,
    acceptedFields: shipment?.accepted_fields,
    inputRequirements: shipment?.input_requirements
      ? {
          required: shipment.input_requirements.required,
          anyOf: shipment.input_requirements.any_of,
          conditional: shipment.input_requirements.conditional,
        }
      : undefined,
    events: mergedEvents,
  }
}
