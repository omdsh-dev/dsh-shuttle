/** Microsoft AHP channel state and Shuttle's portable history. */
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ChatInteractivity, MessageKind, PROTOCOL_VERSION, ResponsePartKind, SessionLifecycle, SessionStatus,
  ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState,
  type ChatState, type ResponsePart, type SessionState, type SessionSummary, type Snapshot,
  type ToolCallResponsePart, type Turn,
} from '@microsoft/agent-host-protocol'
import { z } from 'zod'
import { EXTERNAL_PLATFORMS, type PortableBlock, type PortableConversation, type PortableMessage } from './types.ts'

const URI = z.string().min(1)
const completedCall = z.object({
  status: z.literal('completed'), toolCallId: z.string().min(1), toolName: z.string(),
  toolInput: z.unknown().optional(), success: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.unknown().optional() })).optional(),
})
const contentPart = z.object({
  kind: z.string(),
  id: z.string().optional(),
  content: z.unknown().optional(),
  toolCall: z.unknown().optional(),
})
const turn = z.object({
  id: z.string().min(1), startedAt: z.string().optional(), state: z.string().optional(),
  message: z.object({
    text: z.string(), origin: z.object({ kind: z.string() }),
    model: z.object({ id: z.string() }).optional(),
    attachments: z.array(z.unknown()).optional(),
  }),
  responseParts: z.array(contentPart),
})
const chatState = z.object({
  resource: URI, title: z.string(), modifiedAt: z.string(),
  provider: z.string().optional(), workingDirectories: z.array(URI).optional(),
  turns: z.array(turn), turnsNextCursor: z.string().optional(),
})
const chatCatalog = z.object({ resource: URI, interactivity: z.string().optional() })
const summary = z.object({
  resource: URI, provider: z.string(), title: z.string(), createdAt: z.string(),
  modifiedAt: z.string(), workingDirectories: z.array(URI).optional(),
  chats: z.array(chatCatalog).optional(), defaultChat: URI.optional(),
})
const sessionState = z.object({
  title: z.string(), provider: z.string(), defaultChat: URI.optional(),
  workingDirectories: z.array(URI).optional(),
  chats: z.array(chatCatalog),
})
const snapshot = z.object({ resource: URI, fromSeq: z.number().int().nonnegative(), state: z.unknown() })
const messageOrigin = z.object({
  namespace: z.string(), sessionId: z.string(), messageId: z.string(),
})
const sourceReference = z.object({
  turnId: z.string(), id: z.string(), role: z.enum(['user', 'assistant', 'system', 'tool']),
  sourceSeq: z.number().int().nonnegative().optional(),
  createdAt: z.number().nonnegative().optional(),
  provider: z.string().optional(), model: z.string().optional(),
  origin: messageOrigin,
  inputLengths: z.array(z.number().int().nonnegative()).optional(),
  parts: z.array(z.number().int().nonnegative()),
})
const sourceIndex = z.object({
  source: z.enum([...EXTERNAL_PLATFORMS, 'dsh']),
  id: z.string(), title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  messages: z.array(sourceReference),
})
const provenance = z.object({ version: z.literal(1), chats: z.record(z.string(), sourceIndex) })
type SourceIndex = z.infer<typeof sourceIndex>
type SourceReference = z.infer<typeof sourceReference>
const archive = z.object({
  protocolVersion: z.string().regex(/^1\.\d+\.\d+$/u),
  sessions: z.array(summary).optional(),
  snapshots: z.array(snapshot),
  provenance: provenance.optional(),
})

export const ahpSchemas = { chatState, sessionState, snapshot, summary }

type ChatHistory = z.infer<typeof chatState>
type SessionMetadata = Pick<z.infer<typeof summary>, 'provider' | 'createdAt' | 'workingDirectories'>

function settledState(value?: string): PortableMessage['turnState'] {
  if (value === TurnState.Complete || value === TurnState.Cancelled || value === TurnState.Error) return value
  return undefined
}

function parseTime(value?: string): number | undefined {
  const time = value === undefined ? NaN : Date.parse(value)
  return Number.isFinite(time) && time >= 0 ? time : undefined
}

function localWorkingDirectory(uris?: readonly string[]): string | undefined {
  const uri = uris?.[0]
  if (uri === undefined) return undefined
  try { return fileURLToPath(uri) } catch { return undefined }
}

/** One settled chat, with the session metadata and optional offline source index. */
export interface AhpHistory {
  readonly chat: ChatHistory
  readonly session?: Partial<SessionMetadata> | undefined
  readonly index?: SourceIndex | undefined
  readonly identity?: string | undefined
  readonly local?: boolean | undefined
}

function toolBlock(part: z.infer<typeof contentPart>, result: boolean): PortableBlock | undefined {
  if (part.kind !== ResponsePartKind.ToolCall) return undefined
  const completed = completedCall.safeParse(part.toolCall)
  if (!completed.success) {
    if (result) return undefined
    const abandoned = completedCall.omit({ status: true }).safeParse(part.toolCall)
    if (!abandoned.success) return undefined
    const call = abandoned.data
    return { type: 'tool-call', id: call.toolCallId, name: call.toolName,
      arguments: typeof call.toolInput === 'string' ? call.toolInput : '{}' }
  }
  const call = completed.data
  if (!result) return { type: 'tool-call', id: call.toolCallId, name: call.toolName,
    arguments: typeof call.toolInput === 'string' ? call.toolInput : '{}' }
  return { type: 'tool-result', toolCallId: call.toolCallId,
    content: call.content?.flatMap(item => item.type === 'text' && typeof item.text === 'string' ? [item.text] : []).join('\n') ?? '',
    ...(call.success === false ? { isError: true } : {}) }
}

function indexedMessages(chat: ChatHistory, index: SourceIndex): PortableMessage[] {
  const turns = new Map(chat.turns.map(item => [item.id, item]))
  return index.messages.map(({ parts, inputLengths, ...ref }) => {
    const entry = turns.get(ref.turnId)
    if (entry === undefined) throw new Error('AHP source index references a missing turn')
    const content: PortableBlock[] = []
    const turnState = settledState(entry.state)
    let offset = 0
    for (const length of inputLengths ?? []) {
      content.push({ type: 'text', text: entry.message.text.slice(offset, offset + length) })
      offset += length + 1
    }
    if (inputLengths !== undefined && offset !== entry.message.text.length + 1 && !(offset === 0 && entry.message.text === '')) {
      throw new Error('AHP source index does not match its turn input')
    }
    for (const partIndex of parts) {
      const part = entry.responseParts[partIndex]
      if (part === undefined) throw new Error('AHP source index references a missing response part')
      if (typeof part.content === 'string' && [ResponsePartKind.Markdown, ResponsePartKind.Reasoning].some(kind => kind === part.kind)) {
        content.push({ type: part.kind === ResponsePartKind.Reasoning ? 'reasoning' : 'text', text: part.content })
      } else {
        const block = toolBlock(part, ref.role === 'tool')
        if (block === undefined) throw new Error('AHP source index references an incompatible response part')
        content.push(block)
      }
    }
    return {
      id: ref.id, role: ref.role, turnId: ref.turnId, origin: ref.origin, content,
      ...(turnState === undefined ? {} : { turnState }),
      ...(ref.sourceSeq === undefined ? {} : { sourceSeq: ref.sourceSeq }),
      ...(ref.createdAt === undefined ? {} : { createdAt: ref.createdAt }),
      ...(ref.provider === undefined ? {} : { provider: ref.provider }),
      ...(ref.model === undefined ? {} : { model: ref.model }),
    }
  })
}

/** Summarize archive fields the target conversion cannot carry. */
export function ahpConversionWarning(history: AhpHistory, target: PortableConversation['source']): string | undefined {
  if (target === 'ahp') return undefined
  const notices: string[] = []
  let omitted = 0
  for (const turn of history.chat.turns) {
    omitted += turn.message.attachments?.length ?? 0
    omitted += turn.responseParts.filter(part => ![
      ResponsePartKind.Markdown, ResponsePartKind.Reasoning, ResponsePartKind.ToolCall,
    ].some(kind => kind === part.kind)).length
    omitted += turn.responseParts.filter(part => {
      const result = completedCall.safeParse(part.toolCall)
      return result.success && (result.data.content?.some(block => block.type !== 'text') === true
        || typeof result.data.toolInput === 'object' && result.data.toolInput !== null)
    }).length
  }
  if (omitted > 0) notices.push(`${omitted} AHP attachment, resource, or response item(s) could not be copied`)
  if (history.index === undefined && history.chat.turns.some(turn => turn.responseParts.length > 0)) {
    notices.push('Response timestamps use the AHP turn time when individual times are unavailable')
  }
  if (history.index?.messages.some(ref => ref.role === 'tool' && ref.parts.length === 0)) {
    notices.push('Tool results without a matching call could not be copied')
  }
  if (history.index?.metadata?.['omittedImages']) notices.push('Embedded images were replaced with migration placeholders')
  return notices.length === 0 ? undefined : notices.join('. ')
}

/** Decode the canonical history at a target-format boundary. */
export function projectAhpHistory(history: AhpHistory, platform?: PortableConversation['source']): PortableConversation {
  const { chat, session, index, identity, local } = history
  const projected = fromAhpChat({ ...chat, ...(index === undefined ? {} : { turns: [] }) }, session, identity, local)
  if (index === undefined) return { ...projected, ...(platform === undefined ? {} : { source: platform }) }
  const { title, ...base } = projected
  const displayTitle = index.title ?? (platform === 'ahp' ? title : undefined)
  return {
    ...base, source: platform ?? index.source,
    id: platform === 'ahp' ? projected.id : index.id,
    ...(displayTitle === undefined ? {} : { title: displayTitle }),
    ...(index.metadata === undefined ? {} : { metadata: index.metadata }),
    messages: indexedMessages(chat, index),
  }
}

/** Project only settled AHP turns. Drafts, pending input, live tools and resource fetches stay on the host. */
export function fromAhpChat(
  chat: ChatHistory,
  session?: Partial<SessionMetadata>,
  identity?: string,
  local = false,
): PortableConversation {
  const id = identity ?? chat.resource
  const updatedAt = parseTime(chat.modifiedAt)
  const createdAt = parseTime(session?.createdAt)
    ?? parseTime(chat.turns[0]?.startedAt) ?? updatedAt ?? 0
  const cwd = local ? localWorkingDirectory(chat.workingDirectories ?? session?.workingDirectories) : undefined
  const provider = chat.provider ?? session?.provider
  const messages: PortableMessage[] = []
  for (const entry of chat.turns) {
    const sentAt = parseTime(entry.startedAt)
    const timestamp = sentAt === undefined ? {} : { createdAt: sentAt }
    const turnState = settledState(entry.state)
    const state = turnState === undefined ? {} : { turnState }
    const model = entry.message.model?.id
    const source = { ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }) }
    const inputBlocks: PortableBlock[] = entry.message.text === '' ? [] : [{ type: 'text', text: entry.message.text }]
    for (const item of entry.message.attachments ?? []) {
      if (typeof item === 'object' && item !== null && 'label' in item && typeof item.label === 'string') {
        inputBlocks.push({ type: 'text', text: `[Attachment: ${item.label}]` })
      }
    }
    if (inputBlocks.length > 0) messages.push({
      id: entry.id + ':input', turnId: entry.id, role: entry.message.origin.kind === MessageKind.User ? 'user' : 'system',
      content: inputBlocks, ...state, ...timestamp, ...source,
    })
    let response: PortableBlock[] = []
    const flushResponse = (index: number) => {
      if (response.length === 0) return
      messages.push({ id: entry.id + ':response:' + index, role: 'assistant', turnId: entry.id, content: response, ...state, ...timestamp, ...source })
      response = []
    }
    for (const [index, part] of entry.responseParts.entries()) {
      if (part.kind === ResponsePartKind.Markdown || part.kind === ResponsePartKind.Reasoning) {
        if (typeof part.content === 'string') response.push({
          type: part.kind === ResponsePartKind.Markdown ? 'text' : 'reasoning', text: part.content,
        })
        continue
      }
      if (part.kind !== ResponsePartKind.ToolCall) continue
      const completed = completedCall.safeParse(part.toolCall)
      if (!completed.success) continue
      const call = completed.data
      response.push({
        type: 'tool-call', id: call.toolCallId, name: call.toolName,
        arguments: typeof call.toolInput === 'string' ? call.toolInput : '{}',
      })
      flushResponse(index)
      messages.push({
        id: entry.id + ':result:' + index, role: 'tool', turnId: entry.id, ...state, ...timestamp,
        content: [{
          type: 'tool-result', toolCallId: call.toolCallId,
          content: call.content?.flatMap(item => item.type === 'text' && typeof item.text === 'string' ? [item.text] : []).join('\n') ?? '',
          ...(call.success === false ? { isError: true } : {}),
        }],
      })
    }
    flushResponse(entry.responseParts.length)
  }
  return {
    version: 1, source: 'ahp', id, title: chat.title, createdAt,
    messages: messages.map(message => ({
      ...message, origin: { namespace: 'ahp', sessionId: id, messageId: message.id },
    })),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(cwd === undefined ? {} : { cwd }),
  }
}

/** Read a raw chat Snapshot or an archive bundling official session/chat Snapshots. */
export function readAhpArchive(value: unknown): AhpHistory[] {
  const bundle = archive.safeParse(value)
  if (!bundle.success && typeof value === 'object' && value !== null && 'snapshots' in value) throw bundle.error
  const snapshots = bundle.success ? bundle.data.snapshots : [snapshot.parse(value)]
  const sessions = new Map(bundle.success ? bundle.data.sessions?.map(item => [item.resource, item]) : undefined)
  const owner = new Map<string, Partial<SessionMetadata>>()
  const chats = new Map<string, AhpHistory>()
  for (const record of snapshots) {
    if (!record.resource.startsWith('ahp-session:')) continue
    const state = sessionState.parse(record.state)
    for (const chat of state.chats) owner.set(chat.resource, { ...state, ...sessions.get(record.resource) })
  }
  for (const record of snapshots) {
    if (!record.resource.startsWith('ahp-chat:')) continue
    const chat = chatState.parse(record.state)
    if (chat.resource !== record.resource) throw new Error('AHP chat snapshot resource does not match its state')
    if (chat.turnsNextCursor !== undefined) throw new Error('AHP archive contains an incomplete chat history')
    if (chats.has(record.resource)) throw new Error('Duplicate AHP chat resource')
    if (new Set(chat.turns.map(item => item.id)).size !== chat.turns.length) throw new Error('Duplicate AHP turn ID')
    chats.set(record.resource, { chat, session: owner.get(record.resource),
      index: bundle.success ? bundle.data.provenance?.chats[record.resource] : undefined, local: true })
  }
  if (chats.size === 0) throw new Error('AHP archive contains no chat snapshots')
  return [...chats.values()]
}

/** Compatibility entrypoint for callers of the legacy native-adapter interface. */
export function parseAhp(text: string): PortableConversation[] {
  return readAhpArchive(JSON.parse(text)).map(history => projectAhpHistory(history, 'ahp'))
}

/** Normalize a native boundary record through the same shape as an offline AHP snapshot. */
export function nativeAhpHistory(conversation: PortableConversation): AhpHistory {
  return readAhpArchive(toAhp(conversation))[0]!
}

function iso(time: number): string {
  return new Date(time).toISOString()
}

function archiveTurns(conversation: PortableConversation): { turns: Turn[]; messages: SourceReference[] } {
  const turns: Turn[] = []
  const messages: SourceReference[] = []
  let current: Turn | undefined
  let sourceTurn: string | undefined
  const calls = new Map<string, { part: ToolCallResponsePart; index: number }>()
  const openTurn = (item: PortableMessage, text: string, origin: MessageKind): Turn => {
    const next: Turn = {
      id: 'turn-' + turns.length,
      startedAt: iso(item.createdAt ?? conversation.createdAt),
      message: { text, origin: { kind: origin }, ...(item.model === undefined ? {} : { model: { id: item.model } }) },
      responseParts: [], usage: undefined,
      state: item.turnState === 'cancelled' ? TurnState.Cancelled
        : item.turnState === 'error' ? TurnState.Error : TurnState.Complete,
    }
    calls.clear()
    sourceTurn = item.turnId
    turns.push(next)
    return next
  }
  for (const message of conversation.messages) {
    const input = message.role === 'user' || message.role === 'system'
    const newTurn = current === undefined || (message.turnId !== undefined
      ? sourceTurn !== message.turnId : input)
    const inputBlocks = input ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []
    if (newTurn) current = openTurn(message, inputBlocks.join('\n'),
      input ? (message.role === 'user' ? MessageKind.User : MessageKind.SystemNotification) : MessageKind.Agent)
    if (current === undefined) continue
    const record: SourceReference = {
      id: message.id, role: message.role, turnId: current.id, parts: [],
      origin: message.origin ?? { namespace: conversation.source, sessionId: conversation.id, messageId: message.id },
      ...(message.sourceSeq === undefined ? {} : { sourceSeq: message.sourceSeq }),
      ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }),
      ...(message.provider === undefined ? {} : { provider: message.provider }),
      ...(message.model === undefined ? {} : { model: message.model }),
    }
    messages.push(record)
    if (input && newTurn) {
      record.inputLengths = inputBlocks.map(text => text.length)
      continue
    }
    if (message.model !== undefined && current.message.model === undefined) current.message.model = { id: message.model }
    for (const block of message.content) {
      let part: ResponsePart | undefined
      if (block.type === 'text' || block.type === 'reasoning') part = {
        kind: block.type === 'text' ? ResponsePartKind.Markdown : ResponsePartKind.Reasoning,
        id: current.id + ':part:' + current.responseParts.length, content: block.text,
      }
      else if (block.type === 'tool-call') {
        part = {
          kind: ResponsePartKind.ToolCall,
          toolCall: {
            status: ToolCallStatus.Cancelled, reason: ToolCallCancellationReason.Skipped,
            toolCallId: block.id, toolName: block.name, displayName: block.name,
            invocationMessage: block.name, toolInput: block.arguments,
          },
        }
        calls.set(block.id, { part, index: current.responseParts.length })
      } else {
        const call = calls.get(block.toolCallId)
        const pending = call?.part
        if (pending !== undefined && call !== undefined) {
          record.parts.push(call.index)
          const previous = pending.toolCall
          pending.toolCall = {
            toolCallId: previous.toolCallId, toolName: previous.toolName, displayName: previous.displayName,
            invocationMessage: previous.toolName,
            ...('toolInput' in previous && previous.toolInput !== undefined ? { toolInput: previous.toolInput } : {}),
            status: ToolCallStatus.Completed, confirmed: ToolCallConfirmationReason.NotNeeded, success: block.isError !== true,
            pastTenseMessage: previous.toolName,
            content: [{ type: ToolResultContentType.Text, text: block.content }],
          }
        }
      }
      if (part !== undefined) {
        record.parts.push(current.responseParts.length)
        current.responseParts.push(part)
      }
    }
  }
  return { turns, messages }
}

export interface AhpExport {
  readonly protocolVersion: string
  readonly sessions: SessionSummary[]
  readonly snapshots: Snapshot[]
  readonly provenance?: z.infer<typeof provenance>
}

/** Build a read-only AHP snapshot set. It contains no tool grants or pending actions. */
export function toAhp(conversation: PortableConversation): AhpExport {
  const key = createHash('sha256').update(conversation.source + '\0' + conversation.id).digest('hex').slice(0, 32)
  const id = [key.slice(0, 8), key.slice(8, 12), key.slice(12, 16), key.slice(16, 20), key.slice(20)].join('-')
  const sessionUri = 'ahp-session:/' + id
  const chatUri = 'ahp-chat:/' + id
  const title = conversation.title ?? conversation.id
  const updated = conversation.updatedAt ?? conversation.messages.at(-1)?.createdAt ?? conversation.createdAt
  const modifiedAt = iso(updated)
  const provider = 'dsh-shuttle'
  const workingDirectories = conversation.cwd === undefined ? undefined : [pathToFileURL(conversation.cwd).href]
  const metadata = { title, provider, status: SessionStatus.Idle, ...(workingDirectories === undefined ? {} : { workingDirectories }) }
  const chat = { resource: chatUri, title, status: SessionStatus.Idle, modifiedAt, interactivity: ChatInteractivity.ReadOnly }
  const sessionState: SessionState = {
    ...metadata, lifecycle: SessionLifecycle.Ready, activeClients: [], chats: [chat], defaultChat: chatUri,
  }
  const { turns, messages } = archiveTurns(conversation)
  const chatState: ChatState = { ...chat, turns }
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessions: [{ ...metadata, resource: sessionUri, createdAt: iso(conversation.createdAt), modifiedAt }],
    provenance: { version: 1, chats: { [chatUri]: {
      source: conversation.source, id: conversation.id, messages,
      ...(conversation.title === undefined ? {} : { title: conversation.title }),
      ...(conversation.metadata === undefined ? {} : { metadata: conversation.metadata }),
    } } },
    snapshots: [{ resource: sessionUri, fromSeq: 0, state: sessionState }, { resource: chatUri, fromSeq: 0, state: chatState }],
  }
}

export function serializeAhp(conversation: PortableConversation): string {
  return JSON.stringify(toAhp(conversation), null, 2) + '\n'
}
