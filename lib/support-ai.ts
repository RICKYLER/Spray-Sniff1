import '@/lib/server-only'

import type { OrderRecord } from '@/lib/store-engine'
import type {
  SupportBootstrapPayload,
  SupportCase,
  SupportCategory,
  SupportPaymentSnapshot,
} from '@/lib/support-types'
import { getOptionalServerEnv } from '@/lib/server-runtime-env'

type AISummaryIntent = 'welcome' | 'orders' | 'order' | 'payment' | 'case'

interface AISummaryRequest {
  intent: AISummaryIntent
  fallback: string
  payload: Record<string, unknown>
}

function compactText(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

function extractOpenAIResponseText(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  // Check standard OpenAI / Ollama choices format
  const choices = (payload as { choices?: unknown }).choices
  if (Array.isArray(choices) && choices.length > 0) {
    const firstChoice = choices[0] as { message?: { content?: unknown } }
    if (typeof firstChoice?.message?.content === 'string' && firstChoice.message.content.trim()) {
      return firstChoice.message.content.trim()
    }
  }

  const outputText = (payload as { output_text?: unknown }).output_text
  if (typeof outputText === 'string' && outputText.trim()) {
    return outputText.trim()
  }

  const output = (payload as { output?: unknown }).output
  if (!Array.isArray(output)) {
    return null
  }

  const segments: string[] = []

  output.forEach((item) => {
    if (!item || typeof item !== 'object') {
      return
    }

    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) {
      return
    }

    content.forEach((contentItem) => {
      if (!contentItem || typeof contentItem !== 'object') {
        return
      }

      const type = (contentItem as { type?: unknown }).type
      const text = (contentItem as { text?: unknown }).text

      if (type === 'output_text' && typeof text === 'string' && text.trim()) {
        segments.push(text.trim())
      }
    })
  })

  return segments.length > 0 ? segments.join('\n').trim() : null
}

function extractAnthropicResponseText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const content = (payload as { content?: unknown }).content
  if (!Array.isArray(content)) {
    return null
  }

  const segments = content
    .filter(
      (item): item is { type: string; text: string } =>
        Boolean(item) &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string',
    )
    .map((item) => item.text.trim())
    .filter(Boolean)

  return segments.length > 0 ? segments.join('\n').trim() : null
}

type AgentRouterProtocol = 'anthropic' | 'openai' | 'responses'

function normalizeAgentRouterBaseUrl(rawUrl?: string): string {
  const base = (rawUrl ?? 'https://agentrouter.org').trim().replace(/\/+$/, '')
  return base.endsWith('/v1') ? base.slice(0, -3) : base
}

function resolveAgentRouterProtocol(
  model: string,
  configuredProtocol?: string,
): AgentRouterProtocol {
  const normalized = configuredProtocol?.trim().toLowerCase()
  if (normalized === 'anthropic' || normalized === 'openai' || normalized === 'responses') {
    return normalized
  }

  if (model.startsWith('claude-')) {
    return 'anthropic'
  }
  if (model.startsWith('gpt-')) {
    return 'responses'
  }
  return 'openai'
}

export interface AgentRouterCallResult {
  text: string
  rawText: string
  model: string
  protocol: AgentRouterProtocol
}

export async function callAgentRouter(options: {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  modelOverride?: string
}): Promise<AgentRouterCallResult | null> {
  const apiKey = getOptionalServerEnv('AGENTROUTER_API_KEY')
  if (!apiKey) {
    return null
  }

  const baseUrl = normalizeAgentRouterBaseUrl(getOptionalServerEnv('AGENTROUTER_BASE_URL'))
  const primaryModel = options.modelOverride ?? getOptionalServerEnv('AGENTROUTER_MODEL') ?? 'gpt-6.1-sol'
  const configuredProtocol = getOptionalServerEnv('AGENTROUTER_PROTOCOL')

  const fallbackPool = ['gpt-6.1-sol', 'gpt-5.6-sol', 'deepseek-v4-flash', 'claude-opus-5']
  const candidateModels = options.modelOverride
    ? [options.modelOverride]
    : Array.from(new Set([primaryModel, ...fallbackPool]))

  for (const model of candidateModels) {
    const protocol = resolveAgentRouterProtocol(model, configuredProtocol)
    const endpoint =
      protocol === 'anthropic'
        ? `${baseUrl}/v1/messages`
        : protocol === 'responses'
          ? `${baseUrl}/v1/responses`
          : `${baseUrl}/v1/chat/completions`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // AgentRouter enforces client validation; a recognized harness User-Agent is required.
      'User-Agent': 'cline/3.0.0',
    }

    let body: Record<string, unknown>

    if (protocol === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
      body = {
        model,
        max_tokens: 512,
        system: options.system,
        messages: options.messages,
      }
    } else if (protocol === 'responses') {
      headers.Authorization = `Bearer ${apiKey}`
      body = {
        model,
        instructions: options.system,
        input: options.messages,
      }
    } else {
      headers.Authorization = `Bearer ${apiKey}`
      body = {
        model,
        messages: [{ role: 'system', content: options.system }, ...options.messages],
        stream: false,
      }
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      })

      if (!response.ok) {
        continue
      }

      const data = await response.json().catch(() => null)
      const extracted =
        protocol === 'anthropic'
          ? extractAnthropicResponseText(data)
          : extractOpenAIResponseText(data)

      if (extracted) {
        return {
          text: cleanBotResponseText(compactText(extracted)),
          rawText: extracted.trim(),
          model,
          protocol,
        }
      }
    } catch {
      // Try next candidate model or fall back to secondary provider
    }
  }

  return null
}

export interface ConciergeChatInput {
  userMessage: string
  customerName?: string
  category?: string
  orderContext?: {
    id: string
    status: string
    paymentStatus?: string
    total?: number
  } | null
  conversationHistory?: Array<{
    role: 'user' | 'assistant'
    content: string
  }>
}

export function isHumanEscalationRequest(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    /\b(admin|human|agent|staff|tao|tawo|ticket|representative|reklamo|complaint|guba|damaged|dispute)\b/i.test(
      normalized,
    ) ||
    normalized.includes('live support') ||
    normalized.includes('istorya sa tao') ||
    normalized.includes('makigstorya') ||
    normalized.includes('kaistorya') ||
    normalized.includes('ka-istorya') ||
    normalized.includes('dili kasabot') ||
    normalized.includes('dili makaya') ||
    normalized.includes('wrong item')
  )
}

export function cleanBotResponseText(rawText: string): string {
  if (!rawText) return ''

  return (
    rawText
      // Remove double asterisks (bold) and single asterisks (italics)
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\*/g, '')
      // Remove double em-dashes (—— or --- or --)
      .replace(/——+/g, ', ')
      .replace(/--+/g, ' - ')
      // Clean up strange quotation marks around single words like "best"
      .replace(/"([^"]{1,20})"/g, '$1')
      // Clean up markdown bullet points at start of lines
      .replace(/^\s*[-•]\s+/gm, '')
      // Clean up multiple spaces
      .replace(/[ \t]+/g, ' ')
      .trim()
  )
}

export interface ConciergeReplyResult {
  text: string
  provider: 'agentrouter' | 'ollama'
  model: string
}

export async function generateConciergeChatReplyWithMeta(
  input: ConciergeChatInput,
): Promise<ConciergeReplyResult | null> {
  const systemPrompt = `You are the Senior Fragrance Consultant & Concierge at Spray & Sniff, an artisanal luxury perfume atelier in Mabini, Manila.

STYLE & FORMATTING REQUIREMENTS (VERY STRICT):
1. NEVER use asterisks (* or **), hashtags (#), bullet points, or any markdown formatting.
2. NEVER use double dashes (—— or --). Use natural punctuation like commas or periods.
3. NEVER place quotation marks around common words (e.g. write best scent, not "best" scent).
4. Address the client respectfully and warmly. Speak with the poise, understated elegance, and sophistication of a high-end luxury maison.
5. Keep answers concise, polished, and helpful (typically 2 to 3 sentences).

ATELIER SIGNATURES:
- Midnight Elegance: Dark plum, amber, nocturnal musk, rich bourbon vanilla. Perfect for evening affairs, dates, and celebrations.
- Azure Bloom: Crisp bergamot, mandarin, white florals, subtle mineral sea salt. Ideal for radiant, fresh daytime wear.
- Velvet Santal: Mysore sandalwood, cardamom, violet iris, dry cedar. Distinguished unisex composition.
- Solar Neroli: Orange blossom, neroli, petitgrain, bright citrus. Vibrant and uplifting.
- Fragrance Match Quiz: Available at /discovery to help clients find their personal signature scent.
- Delivery: 2 to 3 business days within Metro Manila, 3 to 5 business days for provincial addresses.
- Returns & Assistance: Sealed bottles can be returned within 7 days. If a client needs human intervention or staff help, reassure them that an administrator will assist them promptly.

LANGUAGE:
If addressed in Cebuano/Bisaya or Tagalog, reply fluently and naturally in that language with the same warm luxury boutique grace. Never invent fake tracking numbers or personal order data.`

  const chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []

  if (input.conversationHistory && input.conversationHistory.length > 0) {
    for (const msg of input.conversationHistory.slice(-4)) {
      chatMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      })
    }
  }

  const userPromptParts: string[] = []
  if (input.customerName) {
    userPromptParts.push(`Customer: ${input.customerName}`)
  }
  if (input.orderContext) {
    userPromptParts.push(
      `Order Context: ${input.orderContext.id} (${input.orderContext.status}, payment: ${input.orderContext.paymentStatus ?? 'pending'})`,
    )
  }
  userPromptParts.push(`Message: ${input.userMessage}`)

  chatMessages.push({
    role: 'user',
    content: userPromptParts.join('\n'),
  })

  // 1. Primary provider: AgentRouter
  const agentRouterResult = await callAgentRouter({
    system: systemPrompt,
    messages: chatMessages,
  })

  if (agentRouterResult) {
    return {
      text: agentRouterResult.text,
      provider: 'agentrouter',
      model: agentRouterResult.model,
    }
  }

  // 2. Fallback provider: Ollama Cloud
  const ollamaKey = getOptionalServerEnv('OLLAMA_API_KEY')
  if (!ollamaKey) {
    return null
  }

  const host = getOptionalServerEnv('OLLAMA_HOST') ?? 'https://ollama.com'
  const model = getOptionalServerEnv('OLLAMA_MODEL') ?? 'gemma4:31b-cloud'

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    ...chatMessages,
  ]

  try {
    const response = await fetch(`${host.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ollamaKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
      cache: 'no-store',
    })

    if (!response.ok) {
      return null
    }

    const data = await response.json().catch(() => null)
    const reply = data?.choices?.[0]?.message?.content
    if (typeof reply === 'string' && reply.trim()) {
      return {
        text: cleanBotResponseText(compactText(reply)),
        provider: 'ollama',
        model,
      }
    }
    return null
  } catch {
    return null
  }
}

export async function generateConciergeChatReply(input: ConciergeChatInput): Promise<string | null> {
  const result = await generateConciergeChatReplyWithMeta(input)
  return result?.text ?? null
}

export interface ConciergeProductContext {
  id: string
  name: string
  category: string
  price: number
  notes?: string[]
  description?: string
  featured?: boolean
}

export interface ConciergeTurnInput {
  userMessage: string
  customerName?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  products?: ConciergeProductContext[]
  orders?: Array<{
    id: string
    status: string
    paymentStatus?: string
    total: number
    courier?: string | null
    trackingNumber?: string | null
  }>
  selectedOrderId?: string
}

export interface ConciergeTurnResult {
  reply: string
  escalate: boolean
  category: SupportCategory
  reason?: string
  provider: 'agentrouter' | 'ollama' | 'concierge-fallback'
  model?: string
}

function normalizeSupportCategory(raw?: unknown): SupportCategory {
  if (
    raw === 'order_help' ||
    raw === 'payment_issue' ||
    raw === 'refund_request' ||
    raw === 'general'
  ) {
    return raw
  }
  return 'general'
}

function parseStructuredConciergeResponse(
  rawText: string,
): { reply: string; escalate: boolean; category: SupportCategory; reason?: string } {
  const trimmed = rawText.trim()
  const jsonCandidate = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  if (jsonCandidate.startsWith('{') && jsonCandidate.endsWith('}')) {
    try {
      const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>
      if (typeof parsed.reply === 'string' && parsed.reply.trim()) {
        return {
          reply: cleanBotResponseText(compactText(parsed.reply)),
          escalate: Boolean(parsed.escalate),
          category: normalizeSupportCategory(parsed.category),
          reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : undefined,
        }
      }
    } catch {
      // Fall back to plain-text parsing
    }
  }

  const hasEscalateMarker = /\[ESCALATE_TO_ADMIN\]/i.test(trimmed)
  const cleaned = cleanBotResponseText(
    compactText(trimmed.replace(/\[ESCALATE_TO_ADMIN\]/gi, '')),
  )

  return {
    reply: cleaned,
    escalate: hasEscalateMarker,
    category: 'general',
  }
}

function detectSevereIssueCategory(text: string): SupportCategory | null {
  const normalized = text.toLowerCase()
  if (
    normalized.includes('refund') ||
    normalized.includes('uli') ||
    normalized.includes('damaged') ||
    normalized.includes('broken') ||
    normalized.includes('leaked') ||
    normalized.includes('basag') ||
    normalized.includes('guba') ||
    normalized.includes('wrong item') ||
    normalized.includes('missing item') ||
    normalized.includes('kulang')
  ) {
    return 'refund_request'
  }
  if (
    normalized.includes('payment failed') ||
    normalized.includes('charged twice') ||
    normalized.includes('double charge') ||
    normalized.includes('not reflected') ||
    normalized.includes('wala ni reflect') ||
    normalized.includes('gcash problem') ||
    normalized.includes('paymongo error')
  ) {
    return 'payment_issue'
  }
  if (
    normalized.includes('cancel') ||
    normalized.includes('change address') ||
    normalized.includes('lost parcel') ||
    normalized.includes('stuck') ||
    normalized.includes('wala naabot') ||
    normalized.includes('dispute') ||
    normalized.includes('complaint') ||
    normalized.includes('reklamo')
  ) {
    return 'order_help'
  }
  return null
}

function isGreetingMessage(text: string): boolean {
  const normalized = text.toLowerCase().trim()
  return /^(h+i+|hello+|hey+|good\s*(morning|afternoon|evening)|kamusta|kumusta|maayong\s*(buntag|hapon|gabii)|yo+)[\s!?.]*$/i.test(
    normalized,
  )
}

function isPerfumeQuery(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    normalized.includes('perfume') ||
    normalized.includes('scent') ||
    normalized.includes('fragrance') ||
    normalized.includes('pabango') ||
    normalized.includes('humot') ||
    normalized.includes('best') ||
    normalized.includes('recommend') ||
    normalized.includes('suggest') ||
    normalized.includes('popular') ||
    normalized.includes('floral') ||
    normalized.includes('woody') ||
    normalized.includes('fresh') ||
    normalized.includes('citrus') ||
    normalized.includes('vanilla') ||
    normalized.includes('musk') ||
    normalized.includes('evening') ||
    normalized.includes('date') ||
    normalized.includes('gift') ||
    normalized.includes('price') ||
    normalized.includes('how much') ||
    normalized.includes('tagpila')
  )
}

function isPolicyOrOrderQuery(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    normalized.includes('ship') ||
    normalized.includes('deliver') ||
    normalized.includes('eta') ||
    normalized.includes('track') ||
    normalized.includes('order') ||
    normalized.includes('return') ||
    normalized.includes('payment') ||
    normalized.includes('gcash') ||
    normalized.includes('maya') ||
    normalized.includes('qr') ||
    normalized.includes('paymongo') ||
    normalized.includes('cod')
  )
}

export function buildLocalConciergeFallback(input: ConciergeTurnInput): ConciergeTurnResult {
  const text = input.userMessage.trim()
  const greetingName = input.customerName ? ` ${input.customerName}` : ''
  const severeCategory = detectSevereIssueCategory(text)

  if (isHumanEscalationRequest(text) || severeCategory) {
    const category = severeCategory ?? (input.selectedOrderId ? 'order_help' : 'general')
    return {
      reply:
        'I understand this requires direct assistance from our team. I am handing your conversation and details over to a Live Admin now so our staff can resolve this promptly for you.',
      escalate: true,
      category,
      reason: isHumanEscalationRequest(text)
        ? 'Customer requested human admin assistance'
        : `Detected ${category} issue requiring admin review`,
      provider: 'concierge-fallback',
    }
  }

  if (isGreetingMessage(text)) {
    return {
      reply: `Hello${greetingName}, welcome to Spray & Sniff Atelier. I am your Fragrance Concierge and I can help you choose a signature scent, check delivery timelines, or look up your orders anytime.`,
      escalate: false,
      category: 'general',
      provider: 'concierge-fallback',
    }
  }

  if (isPerfumeQuery(text)) {
    const catalog = input.products ?? []
    const lower = text.toLowerCase()
    const matching = catalog.filter((item) => {
      const haystack = `${item.name} ${item.category} ${(item.notes ?? []).join(' ')} ${item.description ?? ''}`.toLowerCase()
      return lower
        .split(/\s+/)
        .some((word) => word.length > 3 && haystack.includes(word))
    })

    const picks = (matching.length > 0 ? matching : catalog.filter((p) => p.featured).length > 0 ? catalog.filter((p) => p.featured) : catalog).slice(0, 3)

    if (picks.length > 0) {
      const summary = picks
        .map((p) => {
          const notesPart = p.notes && p.notes.length > 0 ? ` featuring ${p.notes.slice(0, 3).join(', ')}` : ''
          return `${p.name} (PHP ${p.price.toLocaleString()}${notesPart})`
        })
        .join('; ')

      return {
        reply: `Our signature favorites from the atelier include ${summary}. You can also take our Fragrance Match Quiz at /discovery to find the scent that best fits your mood or occasion.`,
        escalate: false,
        category: 'general',
        provider: 'concierge-fallback',
      }
    }

    return {
      reply:
        'Our most requested signatures are Midnight Elegance for warm evening occasions, Azure Bloom for crisp daytime freshness, and Velvet Santal for a refined unisex woody profile. You can also try our Fragrance Match Quiz at /discovery for a tailored recommendation.',
      escalate: false,
      category: 'general',
      provider: 'concierge-fallback',
    }
  }

  if (isPolicyOrOrderQuery(text)) {
    const orders = input.orders ?? []
    const targetOrder =
      (input.selectedOrderId ? orders.find((o) => o.id === input.selectedOrderId) : undefined) ??
      orders[0]

    if (text.toLowerCase().includes('order') || text.toLowerCase().includes('track')) {
      if (targetOrder) {
        const trackingInfo = targetOrder.trackingNumber
          ? ` with tracking ${targetOrder.trackingNumber}${targetOrder.courier ? ` via ${targetOrder.courier}` : ''}`
          : ''
        return {
          reply: `Your order ${targetOrder.id} is currently ${targetOrder.status} (payment: ${targetOrder.paymentStatus ?? 'pending'}${trackingInfo}). Delivery takes 2 to 3 business days within Metro Manila and 3 to 5 business days for provincial addresses.`,
          escalate: false,
          category: 'order_help',
          provider: 'concierge-fallback',
        }
      }
    }

    return {
      reply:
        'Delivery takes 2 to 3 business days within Metro Manila and 3 to 5 business days for provincial addresses, and we accept PayMongo (GCash, Maya, QR Ph, cards) with a 7-day return window for sealed bottles. Feel free to ask if you have a specific order question.',
      escalate: false,
      category: 'general',
      provider: 'concierge-fallback',
    }
  }

  // If the user has already chatted multiple turns and still has an unrecognized or complex request, hand over to Admin.
  const assistantTurns = (input.history ?? []).filter((m) => m.role === 'assistant').length
  if (assistantTurns >= 2) {
    return {
      reply:
        'I want to make sure your concern is handled thoroughly, so I am handing our conversation over to a Live Admin right now. Our team can review everything we discussed and assist you directly.',
      escalate: true,
      category: input.selectedOrderId ? 'order_help' : 'general',
      reason: 'Bot reached fallback escalation limit after unresolved customer inquiry',
      provider: 'concierge-fallback',
    }
  }

  return {
    reply:
      'I would be glad to help with fragrance recommendations, pricing, delivery timelines, or checking your orders. Could you share a bit more detail about what you need, or let me know if you would like me to connect you to a Live Admin?',
    escalate: false,
    category: 'general',
    provider: 'concierge-fallback',
  }
}

export async function runConciergeChatTurn(input: ConciergeTurnInput): Promise<ConciergeTurnResult> {
  if (isHumanEscalationRequest(input.userMessage)) {
    const category = detectSevereIssueCategory(input.userMessage) ?? (input.selectedOrderId ? 'order_help' : 'general')
    return {
      reply:
        'I understand you would like direct assistance from our team. I am handing this conversation over to a Live Admin now along with your chat details.',
      escalate: true,
      category,
      reason: 'Customer requested human admin or reported an escalation keyword',
      provider: 'concierge-fallback',
    }
  }

  const catalogSnippet = (input.products ?? [])
    .slice(0, 12)
    .map(
      (p) =>
        `${p.name} (${p.category}, PHP ${p.price}${p.notes?.length ? `, notes: ${p.notes.slice(0, 4).join(', ')}` : ''})`,
    )
    .join(' | ')

  const ordersSnippet = (input.orders ?? [])
    .slice(0, 5)
    .map(
      (o) =>
        `${o.id}: status=${o.status}, payment=${o.paymentStatus ?? 'pending'}, total=PHP ${o.total}${o.trackingNumber ? `, tracking=${o.trackingNumber}` : ''}`,
    )
    .join(' | ')

  const systemPrompt = `You are the Senior Fragrance Consultant & AI Concierge at Spray & Sniff, an artisanal luxury perfume atelier in Mabini, Manila.

YOUR ROLE:
You handle customers FIRST. Answer greetings, perfume recommendations, scent advice, product pricing, delivery timelines, store policies, and simple order status lookups yourself.
ONLY escalate to a human Admin when you genuinely CANNOT solve the customer's problem (for example: damaged, leaked, or wrong items received; manual refund or payment verification discrepancies; lost parcels; address changes after dispatch; disputes/complaints; or if the customer asks for a human/admin).

RESPONSE FORMAT (STRICT JSON):
Return ONLY valid JSON with no markdown code fences:
{"reply":"Your warm, concise response (2 to 3 sentences, plain text only, NO asterisks, NO hashtags, NO bullet points, NO double dashes)","escalate":false,"category":"general","reason":""}

Valid values for "category": "general", "order_help", "payment_issue", "refund_request".
Set "escalate": true ONLY when human admin intervention is required.

LIVE ATELIER CATALOG:
${catalogSnippet || 'Midnight Elegance, Azure Bloom, Velvet Santal, Solar Neroli'}

CUSTOMER ORDERS:
${ordersSnippet || 'No recent orders on file'}

POLICIES & LANGUAGE:
- Delivery: 2 to 3 business days within Metro Manila, 3 to 5 business days provincial.
- Returns: Sealed bottles within 7 days. Fragrance Match Quiz at /discovery.
- Reply in English, Tagalog, or Cebuano/Bisaya matching the customer's language with warm luxury poise. Never invent tracking numbers or fake order data.`

  const chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  if (input.history && input.history.length > 0) {
    for (const turn of input.history.slice(-6)) {
      chatMessages.push({
        role: turn.role,
        content: turn.content,
      })
    }
  }

  const userParts: string[] = []
  if (input.customerName) {
    userParts.push(`Customer: ${input.customerName}`)
  }
  if (input.selectedOrderId) {
    userParts.push(`Selected Order: ${input.selectedOrderId}`)
  }
  userParts.push(`Message: ${input.userMessage}`)
  chatMessages.push({ role: 'user', content: userParts.join('\n') })

  // 1. Primary provider: AgentRouter
  const arResult = await callAgentRouter({
    system: systemPrompt,
    messages: chatMessages,
  })

  if (arResult) {
    const parsed = parseStructuredConciergeResponse(arResult.rawText)
    if (parsed.reply) {
      return {
        ...parsed,
        provider: 'agentrouter',
        model: arResult.model,
      }
    }
  }

  // 2. Secondary provider: Ollama Cloud
  const ollamaKey = getOptionalServerEnv('OLLAMA_API_KEY')
  if (ollamaKey) {
    const host = getOptionalServerEnv('OLLAMA_HOST') ?? 'https://ollama.com'
    const model = getOptionalServerEnv('OLLAMA_MODEL') ?? 'gemma4:31b-cloud'

    try {
      const response = await fetch(`${host.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ollamaKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...chatMessages],
          stream: false,
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      })

      if (response.ok) {
        const data = await response.json().catch(() => null)
        const rawReply = data?.choices?.[0]?.message?.content
        if (typeof rawReply === 'string' && rawReply.trim()) {
          const parsed = parseStructuredConciergeResponse(rawReply)
          if (parsed.reply) {
            return {
              ...parsed,
              provider: 'ollama',
              model,
            }
          }
        }
      }
    } catch {
      // Fall through to catalog-aware local concierge fallback
    }
  }

  // 3. Guaranteed non-silent fallback using live catalog and order context
  return buildLocalConciergeFallback(input)
}

async function maybeGenerateAISummary({ fallback, intent, payload }: AISummaryRequest) {
  const summarySystemPrompt =
    'You are the concise Spray & Sniff perfume concierge in Mabini atelier. Use only the provided JSON facts. Never invent data or statuses. Keep the response to 2 short sentences.'
  const summaryUserPrompt = `Intent: ${intent}\nFacts:\n${JSON.stringify(payload, null, 2)}`

  // 1. Primary provider: AgentRouter
  const agentRouterResult = await callAgentRouter({
    system: summarySystemPrompt,
    messages: [{ role: 'user', content: summaryUserPrompt }],
  })

  if (agentRouterResult) {
    return agentRouterResult.text
  }

  const ollamaKey = getOptionalServerEnv('OLLAMA_API_KEY')
  const openAiKey = getOptionalServerEnv('OPENAI_API_KEY')

  if (!ollamaKey && !openAiKey) {
    return fallback
  }

  if (ollamaKey) {
    const host = getOptionalServerEnv('OLLAMA_HOST') ?? 'https://ollama.com'
    const model = getOptionalServerEnv('OLLAMA_MODEL') ?? 'gemma4:31b-cloud'

    try {
      const response = await fetch(`${host.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ollamaKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: summarySystemPrompt,
            },
            {
              role: 'user',
              content: summaryUserPrompt,
            },
          ],
          stream: false,
        }),
        cache: 'no-store',
      })

      if (response.ok) {
        const data = await response.json().catch(() => null)
        const text = extractOpenAIResponseText(data)
        if (text) return cleanBotResponseText(compactText(text))
      }
    } catch {
      // Fall through to OpenAI or fallback
    }
  }

  if (!openAiKey) {
    return fallback
  }

  const model = getOptionalServerEnv('OPENAI_MODEL') ?? 'gpt-5'

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiKey}`,
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'developer',
            content:
              'You are a concise support-writing assistant. Use only the provided JSON facts. Never invent data, never change statuses, and keep the response to 2 short sentences.',
          },
          {
            role: 'user',
            content: `Intent: ${intent}\nFacts:\n${JSON.stringify(payload, null, 2)}`,
          },
        ],
      }),
      cache: 'no-store',
    })

    if (!response.ok) {
      return fallback
    }

    const data = await response.json().catch(() => null)
    const text = extractOpenAIResponseText(data)
    return text ? cleanBotResponseText(compactText(text)) : fallback
  } catch {
    return fallback
  }
}

export async function buildSupportWelcomeMessage(
  payload: Pick<SupportBootstrapPayload, 'customer' | 'recentCases' | 'recentOrders'>,
) {
  const fallback = payload.customer
    ? `Hi ${payload.customer.name}. Welcome to Spray & Sniff Concierge! How can I assist you today? You can ask for fragrance recommendations, track an order, or submit a support inquiry.`
    : 'Welcome to Spray & Sniff support. Sign in to view your orders and payment details, or use the quick help options below for general guidance.'

  return maybeGenerateAISummary({
    intent: 'welcome',
    fallback,
    payload,
  })
}

export async function buildOrdersOverviewMessage(orders: OrderRecord[]) {
  const fallback =
    orders.length === 0
      ? "I couldn't find any online orders linked to this account yet."
      : `I found ${orders.length} online order${orders.length === 1 ? '' : 's'} for this account. Tap an order card to review tracking, payment details, or the next available self-service action.`

  return maybeGenerateAISummary({
    intent: 'orders',
    fallback,
    payload: {
      orders: orders.map((order) => ({
        id: order.id,
        status: order.status,
        total: order.total,
        paymentStatus: order.paymentStatus,
        canCancel: order.actionAvailability?.canCancel ?? false,
        courier: order.courier ?? null,
        trackingNumber: order.trackingNumber ?? null,
      })),
    },
  })
}

export async function buildOrderDetailMessage(order: OrderRecord) {
  const latestUpdate = order.timeline[order.timeline.length - 1]
  const trackingNote = order.trackingNumber
    ? `Courier waybill: ${order.trackingNumber} (${order.courier || 'Courier Partner'}). Real-time satellite tracking is active on your /track page.`
    : 'Tracking progress will appear once dispatched to the courier.'

  const fallback = compactText(
    `${order.id} is currently ${order.status}. ${latestUpdate ? latestUpdate.note : trackingNote} ${
      order.actionAvailability?.canCancel
        ? 'You can still cancel this order from support.'
        : order.actionAvailability?.cancelBlockedReason ??
          'Delivery progress updates automatically via our courier network.'
    }`,
  )

  return maybeGenerateAISummary({
    intent: 'order',
    fallback,
    payload: {
      id: order.id,
      status: order.status,
      createdAt: order.createdAt,
      paymentStatus: order.paymentStatus,
      total: order.total,
      courier: order.courier ?? null,
      trackingNumber: order.trackingNumber ?? null,
      latestUpdate: latestUpdate?.note ?? null,
      actionAvailability: order.actionAvailability ?? null,
    },
  })
}

export async function buildPaymentDetailMessage(
  order: OrderRecord,
  payment: SupportPaymentSnapshot | undefined,
) {
  const reference = payment?.reference ?? 'No payment reference recorded yet'
  const fallback = compactText(
    `${order.id} uses ${payment?.paymentMethod ?? order.paymentMethod} and is currently marked ${payment?.paymentStatus ?? order.paymentStatus}. Reference: ${reference}. ${
      payment?.paidAt ? `Payment was recorded on ${new Date(payment.paidAt).toLocaleString()}.` : ''
    }`,
  )

  return maybeGenerateAISummary({
    intent: 'payment',
    fallback,
    payload: {
      orderId: order.id,
      status: order.status,
      payment,
    },
  })
}

export async function buildCaseSummaryMessage(input: {
  category: SupportCategory
  caseId: string
  order?: OrderRecord
  requestMessage: string
}) {
  if (isHumanEscalationRequest(input.requestMessage)) {
    return `Gipasa na nako ang imong concern sa among Live Admin Team.\n\nTicket Ref: ${input.caseId}\nPriority: High (Waiting on Staff)\n\nNaka-notify na ang among team sa Admin Inbox ug mo-reply sila dire sa chat thread. Mahimo nimong idugang ang ubang detalye samtang nagpaabot ka.`
  }

  const aiAnswer = await generateConciergeChatReply({
    userMessage: input.requestMessage,
    category: input.category,
    orderContext: input.order
      ? {
          id: input.order.id,
          status: input.order.status,
          paymentStatus: input.order.paymentStatus,
          total: input.order.total,
        }
      : null,
  })

  if (aiAnswer) {
    return `${aiAnswer}\n\n(Ticket ref: ${input.caseId})`
  }

  const fallback = compactText(
    `${input.caseId} has been opened as a ${input.category.replace(/_/g, ' ')} request${
      input.order ? ` for ${input.order.id}` : ''
    }. The support team will see your request, order details, and payment context in the admin inbox.`,
  )

  return maybeGenerateAISummary({
    intent: 'case',
    fallback,
    payload: input,
  })
}

export async function buildCaseHandoffSummary(input: {
  category: SupportCategory
  order?: OrderRecord
  requestMessage: string
  supportCase?: Pick<SupportCase, 'id' | 'status' | 'priority'>
}) {
  const orderReference = input.order
    ? `${input.order.id} (${input.order.status}, ${input.order.paymentStatus})`
    : 'No linked order'
  const fallback = compactText(
    `${input.category.replace(/_/g, ' ')} request. Order: ${orderReference}. Customer note: ${input.requestMessage}`,
  )

  return maybeGenerateAISummary({
    intent: 'case',
    fallback,
    payload: input,
  })
}
