import { isAbsolute } from 'node:path'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type ContentBlock,
} from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { PortableBlock, PortableConversation, PortableMessage } from './types.ts'
import { safeSegment } from './io.ts'

function dshContent(blocks: readonly PortableBlock[]): ContentBlock[] {
  const result: ContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text' || block.type === 'reasoning') result.push(block)
    else if (block.type === 'tool-call') result.push({
      type: 'tool-call', id: CallId(block.id), name: block.name, arguments: block.arguments,
    })
  }
  return result
}

/** Deterministic DSH id used for conflict detection and repeatable previews. */
export function dshSessionId(value: PortableConversation): SessionId {
  return SessionId(`shuttle-${value.source}-${safeSegment(value.id)}`)
}

export interface DshMaterialization {
  header: SessionHeader
  events: SessionEvent[]
}

/** Convert a portable conversation into a balanced, replay-valid DSH event log. */
export function toDsh(value: PortableConversation): DshMaterialization {
  const id = dshSessionId(value)
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Math.max(0, Math.trunc(value.createdAt)),
    ...(value.cwd !== undefined && isAbsolute(value.cwd) ? { cwd: value.cwd } : {}),
  }
  const session = Session.create(id, [], header)
  let turn = 0
  let step = 0
  let turnOpen = false
  let stepOpen = false
  const callSeq = new Map<string, number>()

  const startTurn = (): void => {
    if (turnOpen) return
    turn += 1
    step = 0
    session.append('turn/start', { turn })
    turnOpen = true
  }
  const closeStep = (): void => {
    if (!stepOpen) return
    session.append('step/end', { turn, step })
    stepOpen = false
  }
  const closeTurn = (): void => {
    if (!turnOpen) return
    closeStep()
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    turnOpen = false
  }
  const startStep = (): void => {
    startTurn()
    closeStep()
    step += 1
    session.append('step/start', { turn, step })
    stepOpen = true
  }

  for (const item of value.messages) {
    if (item.role === 'user' || item.role === 'system') {
      closeTurn()
      startTurn()
      const content = dshContent(item.content).filter(block => block.type !== 'tool-call')
      if (content.length === 0) continue
      session.append('user/message', createUserMessage({
        content,
        source: item.role === 'system'
          ? { kind: 'plugin', plugin: 'dsh-shuttle:system', form: 'instructions' }
          : { kind: 'user' },
      }), { surfaceOp: 'append' })
      continue
    }

    if (item.role === 'assistant') {
      startStep()
      const content = dshContent(item.content)
      if (content.length > 0) {
        session.append('assistant/message', {
          turn,
          step,
          message: createAssistantMessage({
            content,
            source: { provider: item.provider ?? value.source, model: item.model ?? 'imported' },
          }),
        }, { surfaceOp: 'append' })
      }
      for (const block of item.content) {
        if (block.type !== 'tool-call') continue
        const event = session.append('tool/call', {
          turn, step, callId: CallId(block.id), name: block.name, arguments: block.arguments,
        })
        callSeq.set(block.id, event.seq)
      }
      if (!item.content.some(block => block.type === 'tool-call')) closeStep()
      continue
    }

    startTurn()
    if (!stepOpen) {
      step += 1
      session.append('step/start', { turn, step })
      stepOpen = true
    }
    for (const block of item.content) {
      if (block.type !== 'tool-result') continue
      const sourceSeq = callSeq.get(block.toolCallId)
      session.append('tool/result', {
        turn,
        step,
        message: createToolResultMessage({
          callId: CallId(block.toolCallId),
          content: [{ type: 'text', text: block.content }],
          isError: block.isError ?? false,
        }),
        ...(block.isError ? { error: { name: 'ImportedToolError', code: 'SHUTTLE_IMPORTED_ERROR' } } : {}),
      }, {
        surfaceOp: 'append',
        ...(sourceSeq !== undefined ? { sourceEventSeqs: [sourceSeq] } : {}),
      })
    }
    closeStep()
  }
  closeTurn()

  const events = structuredClone(session.events) as SessionEvent[]
  // Replay through the canonical validator before returning anything writable.
  Session.create(id, structuredClone(events), header)
  return { header, events }
}

function portableContent(content: readonly { type: string; [key: string]: unknown }[]): PortableBlock[] {
  const blocks: PortableBlock[] = []
  for (const block of content) {
    if (block.type === 'text' || block.type === 'reasoning') {
      if (typeof block['text'] === 'string') blocks.push({ type: block.type, text: block['text'] })
    } else if (block.type === 'tool-call') {
      blocks.push({
        type: 'tool-call',
        id: String(block['id']),
        name: typeof block['name'] === 'string' ? block['name'] : 'unknown',
        arguments: typeof block['arguments'] === 'string' ? block['arguments'] : '{}',
      })
    } else if (block.type === 'tool-result') {
      const nested = Array.isArray(block['content'])
        ? portableContent(block['content'] as { type: string; [key: string]: unknown }[])
        : []
      blocks.push({
        type: 'tool-result',
        toolCallId: String(block['toolCallId']),
        content: nested.filter(item => item.type === 'text' || item.type === 'reasoning')
          .map(item => item.text).join('\n'),
        ...(block['isError'] === true ? { isError: true } : {}),
      })
    } else if (block.type === 'image') {
      blocks.push({ type: 'text', text: '[Image attachment omitted during migration]' })
    }
  }
  return blocks
}

/** Project the current DSH message surface into the portable model. */
export function fromDsh(inspection: SessionInspection): PortableConversation {
  const replay = Session.create(inspection.meta.id, structuredClone(inspection.events), structuredClone(inspection.meta))
  const current = new Set(replay.surface.nodes)
  const messages: PortableMessage[] = []
  for (const event of inspection.events) {
    if (!current.has(event.seq)) continue
    if (event.type === 'user/message') {
      const source = event.data.source
      const rawContent = event.data.content as unknown as { type: string; [key: string]: unknown }[]
      if (source.kind === 'tool') {
        messages.push({ id: String(event.data.id), role: 'tool', createdAt: event.time, content: portableContent(rawContent) })
      } else {
        messages.push({
          id: String(event.data.id),
          role: source.kind === 'plugin' && source.plugin === 'dsh-shuttle:system' ? 'system' : 'user',
          createdAt: event.time,
          content: portableContent(rawContent),
        })
      }
    } else if (event.type === 'tool/result') {
      messages.push({
        id: String(event.data.message.id),
        role: 'tool',
        createdAt: event.time,
        content: portableContent(event.data.message.content as unknown as { type: string; [key: string]: unknown }[]),
      })
    } else if (event.type === 'assistant/message') {
      const source = event.data.message.source
      messages.push({
        id: String(event.data.message.id),
        role: 'assistant',
        createdAt: event.time,
        provider: source.provider,
        model: source.model,
        content: portableContent(event.data.message.content as unknown as { type: string; [key: string]: unknown }[]),
      })
    }
  }
  return {
    version: 1,
    id: String(inspection.meta.id),
    source: 'dsh',
    createdAt: inspection.meta.createdAt,
    messages,
    ...(inspection.meta.cwd !== undefined ? { cwd: inspection.meta.cwd } : {}),
  }
}
