import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import type {
  ExternalPlatform,
  ParseContext,
  PortableBlock,
  PortableConversation,
  PortableMessage,
} from './types.ts'
import { safeSegment } from './io.ts'
import { parseAhp, serializeAhp } from './ahp.ts'

type JsonRecord = Record<string, unknown>

export interface ExternalAdapter {
  readonly platform: ExternalPlatform
  parse(text: string, context?: ParseContext): PortableConversation[]
  serialize(conversation: PortableConversation): string
  destination(root: string, conversation: PortableConversation): string
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function timestamp(value: unknown, fallback: number): number {
  const numeric = number(value)
  if (numeric !== undefined) return numeric
  const text = string(value)
  if (text !== undefined) {
    const parsed = Date.parse(text)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function jsonString(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function lines(text: string): JsonRecord[] {
  const output: JsonRecord[] = []
  const sourceLines = text.split(/\r?\n/u)
  for (const [index, line] of sourceLines.entries()) {
    if (line.trim() === '') continue
    try {
      const value = record(JSON.parse(line))
      if (value !== undefined) output.push(value)
    } catch (error) {
      // A live append-only transcript may be observed between writes. Ignore
      // only its unterminated final fragment; malformed committed rows fail.
      if (index === sourceLines.length - 1 && !text.endsWith('\n') && !text.endsWith('\r')) continue
      throw new Error(`invalid JSONL at line ${index + 1}: ${(error as Error).message}`)
    }
  }
  return output
}

function blockText(blocks: readonly PortableBlock[]): string {
  return blocks.flatMap(block => {
    if (block.type === 'text' || block.type === 'reasoning') return [block.text]
    if (block.type === 'tool-result') return [block.content]
    return []
  }).join('\n')
}

function textBlocks(value: unknown): PortableBlock[] {
  if (typeof value === 'string') return value === '' ? [] : [{ type: 'text', text: value }]
  if (!Array.isArray(value)) return []
  const result: PortableBlock[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      result.push({ type: 'text', text: item })
      continue
    }
    const part = record(item)
    if (part === undefined) continue
    const type = string(part['type'])
    const text = string(part['text']) ?? string(part['content'])
    if (type === 'thinking' || type === 'reasoning' || type === 'analysis' || type === 'summary_text') {
      const thinking = string(part['thinking']) ?? text
      if (thinking !== undefined) result.push({ type: 'reasoning', text: thinking })
    } else if (type === 'tool_use' || type === 'tool-call' || type === 'toolCall') {
      result.push({
        type: 'tool-call',
        id: string(part['id']) ?? string(part['toolCallId']) ?? '',
        name: string(part['name']) ?? string(part['toolName']) ?? 'unknown',
        arguments: jsonString(part['input'] ?? part['arguments'] ?? part['args']),
      })
    } else if (type === 'tool_result' || type === 'tool-result' || type === 'toolResult') {
      result.push({
        type: 'tool-result',
        toolCallId: string(part['tool_use_id']) ?? string(part['toolCallId']) ?? 'unknown',
        content: toolOutputText(part['content']),
        ...(part['is_error'] === true || part['isError'] === true ? { isError: true } : {}),
      })
    } else if (text !== undefined) {
      result.push({ type: 'text', text })
    }
  }
  return result
}

function toolOutputText(value: unknown): string {
  if (Array.isArray(value)) {
    const text = blockText(textBlocks(value))
    if (text !== '' || value.length === 0) return text
  }
  return jsonString(value)
}

function message(
  role: PortableMessage['role'],
  content: PortableBlock[],
  input: { id?: string | undefined; createdAt?: number | undefined; provider?: string | undefined; model?: string | undefined } = {},
): PortableMessage {
  return {
    id: input.id ?? '',
    role,
    content,
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  }
}

function conversation(input: {
  id?: string | undefined
  source: ExternalPlatform
  path?: string | undefined
  cwd?: string | undefined
  createdAt?: number | undefined
  title?: string | undefined
  messages: PortableMessage[]
  metadata?: Record<string, unknown> | undefined
}): PortableConversation {
  const createdAt = input.createdAt ?? input.messages[0]?.createdAt ?? Date.now()
  return {
    version: 1,
    id: input.id ?? safeSegment(input.path === undefined ? randomUUID() : basename(input.path).replace(/\.jsonl?$/u, '')),
    source: input.source,
    createdAt,
    messages: input.messages.map((item, ordinal) => ({
      ...item,
      id: item.id || `message-${ordinal}`,
      content: item.content.map((block, index) => block.type === 'tool-call' && block.id === ''
        ? { ...block, id: `call-${ordinal}-${index}` } : block),
    })),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  }
}

function iso(time: number): string {
  return new Date(time).toISOString()
}

function jsonl(rows: readonly unknown[]): string {
  return `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
}

function codexParse(text: string, context: ParseContext = {}): PortableConversation[] {
  const now = context.now ?? Date.now()
  const rows = lines(text)
  let id: string | undefined
  let cwd: string | undefined
  let createdAt = now
  const messages: PortableMessage[] = []
  let lastText: { source: 'event' | 'response'; mirrorMatched: boolean } | undefined
  const appendText = (item: PortableMessage, source: 'event' | 'response') => {
    const prior = messages.at(-1)
    if (lastText !== undefined && !lastText.mirrorMatched && lastText.source !== source
      && prior?.role === item.role && JSON.stringify(prior.content) === JSON.stringify(item.content)) {
      if (source === 'response') messages[messages.length - 1] = item
      lastText.mirrorMatched = true
      return
    }
    messages.push(item)
    lastText = { source, mirrorMatched: false }
  }
  for (const row of rows) {
    const payload = record(row['payload']) ?? row
    const outerType = string(row['type'])
    const type = string(payload['type']) ?? outerType
    const time = timestamp(row['timestamp'] ?? payload['timestamp'], now)
    const nativeId = string(payload['id'])
    if (outerType === 'session_meta' || type === 'session_meta') {
      id = string(payload['id']) ?? id
      cwd = string(payload['cwd']) ?? cwd
      createdAt = timestamp(payload['timestamp'] ?? row['timestamp'], createdAt)
      continue
    }
    if (outerType === 'response_item') {
      if (type === 'message') {
        const role = string(payload['role'])
        if (role === 'user' || role === 'assistant' || role === 'system') {
          appendText(message(role, textBlocks(payload['content']), { id: nativeId, createdAt: time }), 'response')
        }
      } else if (type === 'function_call' || type === 'custom_tool_call' || type === 'mcp_tool_call') {
        lastText = undefined
        messages.push(message('assistant', [{
          type: 'tool-call',
          id: string(payload['call_id']) ?? string(payload['id']) ?? '',
          name: string(payload['name']) ?? 'unknown',
          arguments: jsonString(payload['arguments'] ?? payload['input']),
        }], { id: nativeId, createdAt: time }))
      } else if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'mcp_tool_call_output') {
        lastText = undefined
        const callId = string(payload['call_id'])
        if (callId === undefined) continue
        const output = record(payload['output'])
        messages.push(message('tool', [{
          type: 'tool-result',
          toolCallId: callId,
          content: toolOutputText(output?.['content'] ?? payload['output']),
          ...(payload['success'] === false || output?.['isError'] === true ? { isError: true } : {}),
        }], { id: nativeId, createdAt: time }))
      } else if (type === 'reasoning') {
        const content = textBlocks(payload['summary'] ?? payload['content']).map(block =>
          block.type === 'text' ? { type: 'reasoning' as const, text: block.text } : block)
        if (content.length > 0) appendText(message('assistant', content, { id: nativeId, createdAt: time }), 'response')
      }
    } else if (outerType === 'event_msg') {
      if (type === 'task_started' || type === 'task_complete' || type === 'turn_aborted') lastText = undefined
      if (type === 'user_message' || type === 'agent_message' || type === 'agent_reasoning') {
        const role = type === 'user_message' ? 'user' : 'assistant'
        const body = string(payload['message']) ?? string(payload['text'])
        if (body !== undefined) appendText(message(role, [{
          type: type === 'agent_reasoning' ? 'reasoning' : 'text', text: body,
        }], { id: nativeId, createdAt: time }), 'event')
      }
    }
  }
  return [conversation({ id, source: 'codex', path: context.path, cwd, createdAt, messages })]
}

function codexSerialize(value: PortableConversation): string {
  const rows: unknown[] = [{
    timestamp: iso(value.createdAt),
    type: 'session_meta',
    payload: {
      id: value.id,
      timestamp: iso(value.createdAt),
      cwd: value.cwd ?? process.cwd(),
      originator: 'dsh-shuttle',
      source: 'cli',
    },
  }]
  for (const item of value.messages) {
    const time = iso(item.createdAt ?? value.createdAt)
    const regular = item.content.filter(block => block.type === 'text' || block.type === 'reasoning')
    if (regular.length > 0 && item.role !== 'tool') {
      rows.push({ timestamp: time, type: 'response_item', payload: {
        type: item.content.every(block => block.type === 'reasoning') ? 'reasoning' : 'message',
        ...(item.content.every(block => block.type === 'reasoning')
          ? { summary: regular.map(block => ({ type: 'summary_text', text: blockText([block]) })) }
          : { role: item.role, content: regular.map(block => ({
              type: item.role === 'assistant' ? 'output_text' : 'input_text',
              text: blockText([block]),
            })) }),
      } })
    }
    for (const block of item.content) {
      if (block.type === 'tool-call') rows.push({ timestamp: time, type: 'response_item', payload: {
        type: 'function_call', name: block.name, arguments: block.arguments, call_id: block.id,
      } })
      if (block.type === 'tool-result') rows.push({ timestamp: time, type: 'response_item', payload: {
        type: 'function_call_output', call_id: block.toolCallId, output: block.content,
      } })
    }
  }
  return jsonl(rows)
}

function claudeParse(text: string, context: ParseContext = {}): PortableConversation[] {
  const now = context.now ?? Date.now()
  let id: string | undefined
  let cwd: string | undefined
  let createdAt = now
  const messages: PortableMessage[] = []
  for (const row of lines(text)) {
    const type = string(row['type'])
    const source = record(row['message']) ?? row
    const role = string(source['role']) ?? (type === 'user' || type === 'assistant' ? type : undefined)
    id = string(row['sessionId']) ?? id
    cwd = string(row['cwd']) ?? cwd
    const time = timestamp(row['timestamp'], now)
    createdAt = Math.min(createdAt, time)
    if (role === 'user' || role === 'assistant' || role === 'system') {
      const blocks = textBlocks(source['content'])
      const ordinary = blocks.filter(block => block.type !== 'tool-result')
      const results = blocks.filter(block => block.type === 'tool-result')
      const uuid = string(row['uuid'])
      if (role === 'user' && results.length > 0) {
        messages.push(message('tool', results, { id: uuid === undefined || ordinary.length === 0 ? uuid : uuid + ':tools', createdAt: time }))
      }
      if (ordinary.length > 0) messages.push(message(role, ordinary, {
        id: uuid, createdAt: time,
        provider: role === 'assistant' ? 'anthropic' : undefined,
        model: string(source['model']),
      }))
      if (role !== 'user' && results.length > 0) {
        messages.push(message('tool', results, { id: uuid === undefined || ordinary.length === 0 ? uuid : uuid + ':tools', createdAt: time }))
      }
    }
  }
  return [conversation({ id, source: 'claude-code', path: context.path, cwd, createdAt, messages })]
}

function claudeSerialize(value: PortableConversation): string {
  let parentUuid: string | null = null
  const rows: unknown[] = []
  for (const item of value.messages) {
    const uuid = item.id || randomUUID()
    const role = item.role === 'tool' ? 'user' : item.role
    const content = item.content.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text }
      if (block.type === 'reasoning') return { type: 'thinking', thinking: block.text }
      if (block.type === 'tool-call') return { type: 'tool_use', id: block.id, name: block.name, input: parseArguments(block.arguments) }
      return { type: 'tool_result', tool_use_id: block.toolCallId, content: block.content, ...(block.isError ? { is_error: true } : {}) }
    })
    rows.push({
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd: value.cwd ?? process.cwd(),
      sessionId: value.id,
      version: 'dsh-shuttle',
      type: role,
      uuid,
      timestamp: iso(item.createdAt ?? value.createdAt),
      message: {
        role,
        content,
        ...(role === 'assistant' && item.model !== undefined ? { model: item.model } : {}),
      },
    })
    parentUuid = uuid
  }
  return jsonl(rows)
}

/** Pi reopens a persisted tree at its last written entry. Follow its parents. */
function piBranch(entries: JsonRecord[]): JsonRecord[] {
  const leaf = entries.at(-1)
  if (leaf === undefined || !('parentId' in leaf)) return entries
  const byId = new Map<string, JsonRecord>()
  for (const entry of entries) {
    const id = string(entry['id'])
    if (id !== undefined) byId.set(id, entry)
  }
  const branch: JsonRecord[] = []
  const seen = new Set<JsonRecord>()
  let entry: JsonRecord | undefined = leaf
  while (entry !== undefined) {
    if (seen.has(entry)) throw new Error('Pi session contains a cycle in its parent chain')
    seen.add(entry)
    branch.push(entry)
    const parent = string(entry['parentId'])
    entry = parent === undefined ? undefined : byId.get(parent)
  }
  return branch.reverse()
}

function piParse(text: string, context: ParseContext = {}): PortableConversation[] {
  const rows = lines(text)
  const header = rows.find(row => row['type'] === 'session')
  const now = context.now ?? Date.now()
  const messages: PortableMessage[] = []
  for (const row of piBranch(rows.filter(item => item['type'] !== 'session'))) {
    if (row['type'] !== 'message') continue
    const source = record(row['message'])
    if (source === undefined) continue
    const role = string(source['role'])
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'toolResult') continue
    const blocks = textBlocks(source['content'])
    const createdAt = timestamp(source['timestamp'] ?? row['timestamp'], now)
    if (role === 'toolResult') {
      messages.push(message('tool', [{
        type: 'tool-result',
        toolCallId: string(source['toolCallId']) ?? 'unknown',
        content: blockText(blocks),
        ...(source['isError'] === true ? { isError: true } : {}),
      }], { id: string(row['id']), createdAt }))
    } else {
      messages.push(message(role, blocks, {
        id: string(row['id']), createdAt,
        provider: string(source['provider']), model: string(source['model']),
      }))
    }
  }
  return [conversation({
    id: string(header?.['id']), source: 'pi', path: context.path,
    cwd: string(header?.['cwd']), createdAt: timestamp(header?.['timestamp'], now), messages,
  })]
}

function piSerialize(value: PortableConversation): string {
  const rows: unknown[] = [{
    type: 'session', version: 3, id: value.id,
    timestamp: iso(value.createdAt), cwd: value.cwd ?? process.cwd(),
  }]
  let parentId: string | null = null
  for (const item of value.messages) {
    const id = item.id || randomUUID()
    const toolResult = item.content.find(block => block.type === 'tool-result')
    const content: unknown[] = []
    for (const block of item.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text })
      else if (block.type === 'reasoning') content.push({ type: 'thinking', thinking: block.text })
      else if (block.type === 'tool-call') content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) })
      else content.push({ type: 'text', text: block.content })
    }
    rows.push({
      type: 'message', id, parentId, timestamp: iso(item.createdAt ?? value.createdAt),
      message: toolResult === undefined ? {
        role: item.role === 'tool' ? 'user' : item.role,
        content,
        ...(item.provider !== undefined ? { provider: item.provider } : {}),
        ...(item.model !== undefined ? { model: item.model } : {}),
      } : {
        role: 'toolResult', toolCallId: toolResult.toolCallId,
        content, ...(toolResult.isError ? { isError: true } : {}),
      },
    })
    parentId = id
  }
  return jsonl(rows)
}

function reasonixParse(text: string, context: ParseContext = {}): PortableConversation[] {
  const now = context.now ?? Date.now()
  const messages: PortableMessage[] = []
  let createdAt = now
  for (const row of lines(text)) {
    const role = string(row['role'])
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue
    const time = timestamp(row['createdAt'], now)
    createdAt = Math.min(createdAt, time)
    const blocks: PortableBlock[] = []
    const body = string(row['content']) ?? string(row['raw_content'])
    if (body !== undefined && body !== '') blocks.push({ type: 'text', text: body })
    const reasoning = string(row['reasoning_content'])
    if (reasoning !== undefined && reasoning !== '') blocks.push({ type: 'reasoning', text: reasoning })
    const calls = Array.isArray(row['tool_calls']) ? row['tool_calls'] : []
    for (const callValue of calls) {
      const call = record(callValue)
      const fn = record(call?.['function'])
      if (call === undefined) continue
      blocks.push({
        type: 'tool-call', id: string(call['id']) ?? '',
        name: string(fn?.['name']) ?? string(call['name']) ?? 'unknown',
        arguments: jsonString(fn?.['arguments'] ?? call['arguments']),
      })
    }
    if (role === 'tool') {
      messages.push(message('tool', [{
        type: 'tool-result', toolCallId: string(row['tool_call_id']) ?? 'unknown', content: body ?? '',
        ...(row['isError'] === true || row['is_error'] === true ? { isError: true } : {}),
      }], { id: string(row['id']), createdAt: time }))
    } else {
      messages.push(message(role, blocks, { id: string(row['id']), createdAt: time }))
    }
  }
  return [conversation({ source: 'reasonix', path: context.path, createdAt, messages })]
}

function reasonixSerialize(value: PortableConversation): string {
  const rows = value.messages.map(item => {
    const text = item.content.filter(block => block.type === 'text').map(block => blockText([block])).join('\n')
    const reasoning = item.content.filter(block => block.type === 'reasoning').map(block => blockText([block])).join('\n')
    const result = item.content.find(block => block.type === 'tool-result')
    const calls = item.content.filter((block): block is Extract<PortableBlock, { type: 'tool-call' }> => block.type === 'tool-call')
    return {
      role: item.role,
      ...(text !== '' ? { content: text } : {}),
      ...(reasoning !== '' ? { reasoning_content: reasoning } : {}),
      ...(calls.length > 0 ? { tool_calls: calls.map(call => ({
        id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
      })) } : {}),
      ...(result !== undefined ? { tool_call_id: result.toolCallId, content: result.content } : {}),
      createdAt: iso(item.createdAt ?? value.createdAt),
    }
  })
  return jsonl(rows)
}

function opencodeV2Parse(rows: readonly unknown[], info: JsonRecord | undefined, context: ParseContext): PortableConversation {
  const now = context.now ?? Date.now()
  const messages: PortableMessage[] = []
  let turn: PortableMessage[] = []
  let last: JsonRecord | undefined
  let unsettledTool = false

  const finish = (superseded = false) => {
    const input = turn[0]
    const waiting = last?.['finish'] === 'tool-calls'
    if (input !== undefined && number(record(last?.['time'])?.['completed']) !== undefined
      && !unsettledTool && (!waiting || superseded)) {
      input.turnState = last?.['finish'] === 'error' || last?.['error'] !== undefined ? 'error'
        : waiting ? 'cancelled' : 'complete'
      messages.push(...turn)
    }
    turn = []
    last = undefined
    unsettledTool = false
  }

  for (const value of rows) {
    const row = record(value)
    if (row === undefined) continue
    const id = string(row['id'])
    const createdAt = timestamp(record(row['time'])?.['created'], now)
    if (row['type'] === 'user' || row['type'] === 'synthetic') {
      finish(true)
      turn.push(message(row['type'] === 'user' ? 'user' : 'system', [
        { type: 'text', text: string(row['text']) ?? '' },
      ], { id, createdAt }))
      continue
    }
    if (row['type'] !== 'assistant' || turn.length === 0 || !Array.isArray(row['content'])) continue

    last = row
    unsettledTool = false
    const blocks: PortableBlock[] = []
    const results: PortableBlock[] = []
    for (const partValue of row['content']) {
      const part = record(partValue)
      if (part === undefined) continue
      const type = part['type']
      if ((type === 'text' || type === 'reasoning') && typeof part['text'] === 'string') {
        blocks.push({ type, text: part['text'] })
        continue
      }
      if (type !== 'tool') continue
      const state = record(part['state'])
      const failed = state?.['status'] === 'error'
      if (state === undefined || (!failed && state['status'] !== 'completed')) {
        unsettledTool = true
        continue
      }
      const callId = string(part['id'])
      if (callId === undefined) continue
      const outputs = Array.isArray(state['content']) ? state['content'].flatMap(value => {
        const item = record(value)
        return item?.['type'] === 'text' && typeof item['text'] === 'string' ? [item['text']] : []
      }) : []
      const error = string(record(state['error'])?.['message'])
      if (failed && error !== undefined && !outputs.includes(error)) outputs.push(error)
      blocks.push({ type: 'tool-call', id: callId, name: string(part['name']) ?? 'unknown',
        arguments: jsonString(state['input']) })
      results.push({ type: 'tool-result', toolCallId: callId, content: outputs.join('\n'),
        ...(failed ? { isError: true } : {}) })
    }

    const model = record(row['model'])
    turn.push(message('assistant', blocks, {
      id, createdAt, provider: string(model?.['providerID']), model: string(model?.['id']),
    }))
    if (results.length > 0) turn.push(message('tool', results, {
      id: id === undefined ? undefined : id + ':tools', createdAt,
    }))
  }
  finish()

  return conversation({
    id: string(info?.['id']), source: 'opencode', path: context.path,
    cwd: string(record(info?.['location'])?.['directory']), title: string(info?.['title']),
    createdAt: timestamp(record(info?.['time'])?.['created'], now), messages,
  })
}

function opencodeParse(text: string, context: ParseContext = {}): PortableConversation[] {
  const root = record(JSON.parse(text))
  if (root === undefined || !Array.isArray(root['messages'])) throw new Error('invalid OpenCode export: expected { info, messages }')
  const info = record(root['info'])
  if (root['messages'].some(value => {
    const type = record(value)?.['type']
    return type === 'user' || type === 'synthetic' || type === 'assistant'
  })) return [opencodeV2Parse(root['messages'], info, context)]
  const now = context.now ?? Date.now()
  const messages: PortableMessage[] = []
  const callIds = new Set<string>()
  for (const entryValue of root['messages']) {
    const entry = record(entryValue)
    const msg = record(entry?.['info'])
    if (entry === undefined || msg === undefined || !Array.isArray(entry['parts'])) continue
    const role = string(msg['role'])
    if (role !== 'user' && role !== 'assistant') continue
    if (role === 'user' && entry['parts'].some(value => record(value)?.['type'] !== 'tool')) callIds.clear()
    const blocks: PortableBlock[] = []
    const results: PortableBlock[] = []
    for (const partValue of entry['parts']) {
      const part = record(partValue)
      if (part === undefined) continue
      const type = string(part['type'])
      if (type === 'text' && typeof part['text'] === 'string') blocks.push({ type: 'text', text: part['text'] })
      else if (type === 'reasoning' && typeof part['text'] === 'string') blocks.push({ type: 'reasoning', text: part['text'] })
      else if (type === 'tool') {
        const state = record(part['state'])
        const callId = string(part['callID']) ?? string(part['id']) ?? 'unknown'
        const name = string(part['tool']) ?? 'unknown'
        if (state?.['status'] === 'completed' || state?.['status'] === 'error') {
          if (!callIds.has(callId)) {
            blocks.push({ type: 'tool-call', id: callId, name, arguments: jsonString(state['input']) })
            callIds.add(callId)
          }
          results.push({ type: 'tool-result', toolCallId: callId,
            content: string(state['output']) ?? string(state['error']) ?? '',
            ...(state['status'] === 'error' ? { isError: true } : {}) })
        } else {
          blocks.push({ type: 'tool-call', id: callId, name, arguments: jsonString(state?.['input']) })
          callIds.add(callId)
        }
      }
    }
    const timeRecord = record(msg['time'])
    const id = string(msg['id'])
    const createdAt = timestamp(timeRecord?.['created'], now)
    if (blocks.length !== 0 || results.length === 0) {
      messages.push(message(role === 'user' && blocks.some(block => block.type === 'tool-call') ? 'assistant' : role, blocks, {
        id, createdAt, provider: string(msg['providerID']), model: string(msg['modelID']),
      }))
    }
    if (results.length !== 0) messages.push(message('tool', results, {
      id: id === undefined || blocks.length === 0 ? id : id + ':tools', createdAt,
    }))
  }
  const time = record(info?.['time'])
  return [conversation({
    id: string(info?.['id']), source: 'opencode', path: context.path,
    cwd: string(info?.['directory']), title: string(info?.['title']),
    createdAt: timestamp(time?.['created'], now), messages,
  })]
}

function opencodeSerialize(value: PortableConversation): string {
  const sessionId = value.id.startsWith('ses_') ? value.id : `ses_${safeSegment(value.id)}`
  const messageIds = value.messages.map((item, index) =>
    item.id.startsWith('msg_') ? item.id : `msg_${safeSegment(item.id, String(index))}`)
  const messages = value.messages.map((item, messageIndex) => {
    const messageId = messageIds[messageIndex]!
    const parts = item.content.map((block, partIndex) => {
      const common = { id: `prt_${messageIndex}_${partIndex}`, sessionID: sessionId, messageID: messageId }
      if (block.type === 'text' || block.type === 'reasoning') return { ...common, type: block.type, text: block.text }
      if (block.type === 'tool-call') return { ...common, type: 'tool', callID: block.id, tool: block.name,
        state: { status: 'pending', input: parseArguments(block.arguments), raw: block.arguments } }
      return { ...common, type: 'tool', callID: block.toolCallId, tool: 'unknown',
        state: block.isError
          ? { status: 'error', input: {}, error: block.content, time: { start: item.createdAt ?? value.createdAt, end: item.createdAt ?? value.createdAt } }
          : { status: 'completed', input: {}, output: block.content, title: 'Imported tool result', metadata: {}, time: { start: item.createdAt ?? value.createdAt, end: item.createdAt ?? value.createdAt } } }
    })
    const created = item.createdAt ?? value.createdAt
    return {
      info: item.role === 'assistant' ? {
        id: messageId, sessionID: sessionId, role: 'assistant',
        parentID: messageIds[messageIndex - 1] ?? `msg_${safeSegment(value.id)}_root`,
        modelID: item.model ?? 'imported', providerID: item.provider ?? 'dsh-shuttle',
        mode: 'build', agent: 'build', path: { cwd: value.cwd ?? process.cwd(), root: value.cwd ?? process.cwd() },
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created, completed: created }, finish: 'stop',
      } : {
        id: messageId, sessionID: sessionId, role: 'user',
        time: { created }, agent: 'build', model: { providerID: 'dsh-shuttle', modelID: 'imported' },
      },
      parts,
    }
  })
  return `${JSON.stringify({
    info: {
      id: sessionId,
      slug: safeSegment(value.title ?? value.id),
      projectID: 'global',
      directory: value.cwd ?? process.cwd(),
      title: value.title ?? `Imported from DSH: ${value.id}`,
      version: '1',
      time: { created: value.createdAt, updated: value.updatedAt ?? value.createdAt },
    },
    messages,
  }, null, 2)}\n`
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return { raw: value }
  }
}

const datedDestination = (root: string, value: PortableConversation): string => {
  const date = new Date(value.createdAt)
  const y = String(date.getUTCFullYear()).padStart(4, '0')
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  const stamp = iso(value.createdAt).replace(/[:.]/gu, '-')
  return join(root, y, m, d, `rollout-${stamp}-${safeSegment(value.id)}.jsonl`)
}

export const adapters: Record<ExternalPlatform, ExternalAdapter> = {
  ahp: {
    platform: 'ahp', parse: parseAhp, serialize: serializeAhp,
    destination: (root, value) => join(root, `${safeSegment(value.id)}.ahp.json`),
  },
  codex: { platform: 'codex', parse: codexParse, serialize: codexSerialize, destination: datedDestination },
  'claude-code': {
    platform: 'claude-code', parse: claudeParse, serialize: claudeSerialize,
    destination: (root, value) => join(root, safeSegment(value.cwd ?? 'imported'), `${safeSegment(value.id)}.jsonl`),
  },
  pi: {
    platform: 'pi', parse: piParse, serialize: piSerialize,
    destination: (root, value) => join(root, `--${safeSegment(value.cwd ?? 'imported')}--`, `${iso(value.createdAt).replace(/[:.]/gu, '-')}_${safeSegment(value.id)}.jsonl`),
  },
  reasonix: {
    platform: 'reasonix', parse: reasonixParse, serialize: reasonixSerialize,
    destination: (root, value) => join(root, 'sessions', `${safeSegment(value.id)}.jsonl`),
  },
  opencode: {
    platform: 'opencode', parse: opencodeParse, serialize: opencodeSerialize,
    destination: (root, value) => join(root, `${safeSegment(value.id)}.opencode.json`),
  },
}

export function parseConversation(platform: ExternalPlatform, text: string, context?: ParseContext): PortableConversation[] {
  return adapters[platform].parse(text, context)
}

export function serializeConversation(platform: ExternalPlatform, value: PortableConversation): string {
  return adapters[platform].serialize(value)
}
