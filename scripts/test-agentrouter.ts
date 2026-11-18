import { products } from '../lib/products'
import {
  buildCaseSummaryMessage,
  buildSupportWelcomeMessage,
  callAgentRouter,
  runConciergeChatTurn,
} from '../lib/support-ai'

async function main() {
  console.log('=== AgentRouter & Bot-First Concierge Diagnostic ===')

  const catalogSample = products.slice(0, 12).map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    price: p.price,
    notes: [...p.topNotes, ...p.middleNotes, ...p.baseNotes].slice(0, 5),
    description: p.description,
    featured: p.featured,
  }))

  console.log('\n1. Testing live callAgentRouter...')
  const directResult = await callAgentRouter({
    system: 'You are a helpful concierge. Reply in 1 short sentence.',
    messages: [{ role: 'user', content: 'Recommend a floral daytime perfume.' }],
  })

  if (directResult) {
    console.log('Direct AgentRouter call succeeded!')
    console.log('Model:', directResult.model)
    console.log('Protocol:', directResult.protocol)
    console.log('Reply:', directResult.text)
  } else {
    console.log(
      'Direct AgentRouter call returned null (expected if token lacks gpt-6.1-sol/gpt-5.6-sol access or default pool is 503).',
    )
  }

  console.log('\n2. Testing Bot-First turn ("hiii") -> must reply & NOT escalate...')
  const greetingTurn = await runConciergeChatTurn({
    userMessage: 'hiii',
    customerName: 'Paul',
    products: catalogSample,
  })
  console.log('Greeting result:', greetingTurn)
  if (!greetingTurn.reply || greetingTurn.escalate) {
    throw new Error('Greeting should produce a bot reply without escalating to admin.')
  }

  console.log('\n3. Testing Bot-First perfume inquiry ("wait what is the best perfume") -> must reply & NOT escalate...')
  const perfumeTurn = await runConciergeChatTurn({
    userMessage: 'wait what is the best perfume',
    customerName: 'Paul',
    products: catalogSample,
  })
  console.log('Perfume result:', perfumeTurn)
  if (!perfumeTurn.reply || perfumeTurn.escalate) {
    throw new Error('Perfume inquiry should produce a catalog-aware bot reply without escalating.')
  }

  console.log('\n4. Testing Escalation trigger ("my bottle arrived damaged, I need a refund") -> must escalate...')
  const damageTurn = await runConciergeChatTurn({
    userMessage: 'my bottle arrived damaged, I need a refund',
    customerName: 'Paul',
    products: catalogSample,
  })
  console.log('Damage/Refund result:', damageTurn)
  if (!damageTurn.reply || !damageTurn.escalate || damageTurn.category !== 'refund_request') {
    throw new Error('Damaged item / refund request should escalate to admin with category refund_request.')
  }

  console.log('\n5. Testing Explicit Human Request ("gusto ko makig-istorya sa admin") -> must escalate...')
  const humanTurn = await runConciergeChatTurn({
    userMessage: 'gusto ko makig-istorya sa admin',
    customerName: 'Paul',
    products: catalogSample,
  })
  console.log('Human request result:', humanTurn)
  if (!humanTurn.reply || !humanTurn.escalate) {
    throw new Error('Explicit admin request should escalate to admin.')
  }

  console.log('\n6. Testing mocked AgentRouter JSON structured escalation & normal replies...')
  const originalFetch = globalThis.fetch
  try {
    process.env.AGENTROUTER_MODEL = 'gpt-6.1-sol'
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      const headers = init?.headers as Record<string, string>
      if (!url.endsWith('/v1/responses') || headers['User-Agent'] !== 'cline/3.0.0' || !headers.Authorization) {
        throw new Error(`Unexpected AgentRouter Responses request: ${url}`)
      }
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            reply: 'For an unforgettable evening, we recommend Midnight Elegance at PHP 2,499.',
            escalate: false,
            category: 'general',
            reason: '',
          }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const mockedNormal = await runConciergeChatTurn({
      userMessage: 'What should I wear to a formal dinner?',
      customerName: 'Paul',
      products: catalogSample,
    })
    console.log('Mocked AgentRouter normal turn:', mockedNormal)
    if (mockedNormal.provider !== 'agentrouter' || mockedNormal.escalate || !mockedNormal.reply.includes('Midnight Elegance')) {
      throw new Error(`Mocked normal turn failed: ${JSON.stringify(mockedNormal)}`)
    }

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            reply: 'I am transferring your payment verification concern to our Live Admin right away.',
            escalate: true,
            category: 'payment_issue',
            reason: 'Customer GCash payment did not sync with PayMongo',
          }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )

    const mockedEscalate = await runConciergeChatTurn({
      userMessage: 'I already paid via GCash 2 hours ago and the status is still pending',
      customerName: 'Paul',
      products: catalogSample,
    })
    console.log('Mocked AgentRouter escalation turn:', mockedEscalate)
    if (
      mockedEscalate.provider !== 'agentrouter' ||
      !mockedEscalate.escalate ||
      mockedEscalate.category !== 'payment_issue'
    ) {
      throw new Error(`Mocked escalation turn failed: ${JSON.stringify(mockedEscalate)}`)
    }
  } finally {
    globalThis.fetch = originalFetch
  }

  console.log('\n7. Testing welcome & case summary helpers...')
  const welcome = await buildSupportWelcomeMessage({
    customer: {
      id: 'test-cust-1',
      name: 'Elena',
      email: 'elena@example.com',
      role: 'USER',
    },
    recentOrders: [],
    recentCases: [],
  })
  const caseCreated = await buildCaseSummaryMessage({
    caseId: 'CASE-TEST-001',
    category: 'general',
    requestMessage: 'Looking for a fresh daytime scent',
  })
  if (!welcome || !caseCreated) {
    throw new Error('Welcome or caseCreated summary failed.')
  }

  console.log('\nAll Bot-First & AgentRouter tests passed!')
}

main().catch((err) => {
  console.error('Diagnostic failed:', err)
  process.exit(1)
})
