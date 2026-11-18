import { NextRequest, NextResponse } from 'next/server'
import { getRequestActor } from '@/lib/server-auth'
import { handleConciergeChatTurn } from '@/lib/support'
import type { SupportChatRequest } from '@/lib/support-types'

export async function POST(request: NextRequest) {
  try {
    const actor = await getRequestActor(request)
    if (!actor) {
      return NextResponse.json(
        { error: 'Sign in with your customer account to chat with the concierge.' },
        { status: 401 },
      )
    }

    const body = (await request.json().catch(() => null)) as Partial<SupportChatRequest> | null
    const message = typeof body?.message === 'string' ? body.message : ''

    if (!message.trim()) {
      return NextResponse.json({ error: 'Enter a message before sending it.' }, { status: 400 })
    }

    const history = Array.isArray(body?.history)
      ? body.history.filter(
          (turn): turn is { role: 'user' | 'assistant'; content: string; createdAt?: string } =>
            Boolean(turn) &&
            typeof turn === 'object' &&
            (turn.role === 'user' || turn.role === 'assistant') &&
            typeof turn.content === 'string',
        )
      : undefined

    const orderId = typeof body?.orderId === 'string' && body.orderId.trim() ? body.orderId.trim() : undefined

    const result = await handleConciergeChatTurn(actor, {
      message,
      history,
      orderId,
    })

    return NextResponse.json(result)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to process your concierge message.'

    return NextResponse.json({ error: message }, { status: 500 })
  }
}
