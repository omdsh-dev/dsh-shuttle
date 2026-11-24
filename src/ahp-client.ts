/** Read completed session history from a Microsoft Agent Host Protocol server. */
import { createHash, randomUUID } from 'node:crypto'
import { ActionType, PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@microsoft/agent-host-protocol'
import { AhpClient, type Subscription } from '@microsoft/agent-host-protocol/client'
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws'
import { ahpSchemas, type AhpHistory } from './ahp.ts'

const ROOT = 'ahp-root://'
export const HISTORY_PROTOCOL_VERSIONS = [PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS.filter(version => version.startsWith('1.'))]
const REQUEST_TIMEOUT_MS = 10_000
const CHAT_TURN_WINDOW = 50

export function ahpEndpoint(input: string): URL {
  const endpoint = new URL(input)
  if (endpoint.username !== '' || endpoint.password !== '' || endpoint.hash !== '') {
    throw new Error('AHP endpoints must not contain user information or fragments')
  }
  if (endpoint.protocol !== 'wss:' && !(endpoint.protocol === 'ws:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) {
    throw new Error('Use wss:// for a remote AHP host or ws:// on loopback')
  }
  return endpoint
}

async function connectSocket(endpoint: URL, signal?: AbortSignal): Promise<WebSocketTransport> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const opening = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  opening.throwIfAborted()
  const socket = new WebSocket(endpoint)
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      opening.removeEventListener('abort', cancel)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onFailure)
      socket.removeEventListener('close', onFailure)
    }
    const cancel = () => {
      cleanup()
      socket.close()
      reject(opening.reason)
    }
    const onOpen = () => { cleanup(); resolve() }
    const onFailure = () => { cleanup(); reject(new Error('Could not connect to the AHP host')) }
    opening.addEventListener('abort', cancel, { once: true })
    socket.addEventListener('open', onOpen, { once: true })
    socket.addEventListener('error', onFailure, { once: true })
    socket.addEventListener('close', onFailure, { once: true })
  })
  return WebSocketTransport.fromSocket(socket)
}

function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

function checkedSize(value: unknown, maxBytes: number): number {
  const size = sizeOf(value)
  if (size > maxBytes) throw new Error(`AHP conversation exceeds ${maxBytes} bytes`)
  return size
}

async function nextTurnPage(subscription: Subscription, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const stop = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  stop.throwIfAborted()
  let cancel: () => void = () => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancel = () => { reject(stop.reason) }
    stop.addEventListener('abort', cancel, { once: true })
  })
  try {
    for (;;) {
      const event = await Promise.race([subscription.next(), interrupted])
      if (event.done) throw new Error('AHP subscription ended before the history page arrived')
      if (event.value.type === 'action' && event.value.params.action.type === ActionType.ChatTurnsLoaded) {
        return event.value.params.action
      }
    }
  } finally { stop.removeEventListener('abort', cancel) }
}

async function readChat(client: AhpClient, resource: string, maxBytes: number, signal?: AbortSignal) {
  const { result, subscription } = await client.subscribe(resource, { view: { turns: CHAT_TURN_WINDOW } })
  try {
    const initial = ahpSchemas.snapshot.parse(result.snapshot)
    if (initial.resource !== resource) throw new Error('Unexpected resource in AHP chat snapshot')
    let bytes = checkedSize(initial.state, maxBytes)
    const state = ahpSchemas.chatState.parse(initial.state)
    if (state.resource !== resource) throw new Error('Unexpected resource in AHP chat state')
    const pages = [state.turns]
    const cursors = new Set<string>()
    let cursor = state.turnsNextCursor
    while (cursor !== undefined) {
      if (cursors.has(cursor) || cursors.size >= 500) throw new Error('AHP history pagination did not finish')
      cursors.add(cursor)
      signal?.throwIfAborted()
      await client.request('fetchTurns', { channel: resource, cursor })
      const action = await nextTurnPage(subscription, signal)
      bytes += checkedSize(action.turns, maxBytes - bytes)
      const page = ahpSchemas.chatState.parse({ ...state, turns: action.turns }).turns
      pages.push(page)
      cursor = action.turnsNextCursor
    }
    state.turns = pages.reverse().flat()
    return state
  } finally {
    await client.unsubscribe(resource)
    await subscription.close()
  }
}

export interface AhpImportEntry {
  sourceId: string
  histories: AhpHistory[]
  warning?: string
}

/** Stream independently valid chats from a host. Read-only imports never dispatch AHP actions. */
export async function* readAhpHost(endpoint: URL, limit: number, maxBytes: number, signal?: AbortSignal): AsyncGenerator<AhpImportEntry> {
  const publicEndpoint = endpoint.origin + endpoint.pathname
  const transport = await connectSocket(endpoint, signal)
  const client = new AhpClient(transport, { requestTimeoutMs: REQUEST_TIMEOUT_MS })
  const cancel = () => { void client.shutdown() }
  signal?.addEventListener('abort', cancel, { once: true })
  const visitedSessions = new Set<string>()
  const visitedChats = new Set<string>()
  try {
    client.connect()
    signal?.throwIfAborted()
    const init = await client.initialize({ clientId: 'dsh-shuttle-' + randomUUID(), protocolVersions: HISTORY_PROTOCOL_VERSIONS })
    if (!HISTORY_PROTOCOL_VERSIONS.includes(init.protocolVersion)) throw new Error('AHP host selected an unsupported protocol version')
    let cursor: string | undefined
    const cursors = new Set<string>()
    do {
      const page = await client.request('listSessions', {
        channel: ROOT, limit: Math.min(100, limit - visitedChats.size), ...(cursor === undefined ? {} : { cursor }),
      })
      checkedSize(page, maxBytes)
      for (const item of page.items) {
        signal?.throwIfAborted()
        if (visitedChats.size >= limit || visitedSessions.size >= limit * 4) return
        const sessionSummary = ahpSchemas.summary.parse(item)
        const resource = sessionSummary.resource
        // Pi advertises existing terminal sessions under pi:/ and expects its catalog URI.
        if (!resource.startsWith('ahp-session:') && !/^pi:\/[^/?#]+$/u.test(resource)) continue
        if (visitedSessions.has(resource)) continue
        visitedSessions.add(resource)
        try {
          let session = sessionSummary
          // A catalog with chat URIs lets the host open the chat directly with a bounded view.
          let chats = session.chats
          if (chats === undefined) {
            const { result, subscription } = await client.subscribe(resource)
            const raw = result.snapshot
            await client.unsubscribe(resource)
            await subscription.close()
            const snap = ahpSchemas.snapshot.parse(raw)
            if (snap.resource !== resource) throw new Error('Unexpected resource in AHP session snapshot')
            checkedSize(snap.state, maxBytes)
            const state = ahpSchemas.sessionState.parse(snap.state)
            session = { ...sessionSummary, ...state }
            chats = state.chats
          }
          const { defaultChat } = session
          const ordered = defaultChat === undefined
            ? chats : [...chats].sort((a, b) => Number(b.resource === defaultChat) - Number(a.resource === defaultChat))
          for (const chat of ordered) {
            if (visitedChats.size >= limit) return
            if (!chat.resource.startsWith('ahp-chat:') || chat.interactivity === 'hidden'
              || visitedChats.has(chat.resource)) continue
            visitedChats.add(chat.resource)
            try {
              const history = await readChat(client, chat.resource, maxBytes, signal)
              const identity = createHash('sha256').update(publicEndpoint + '\0' + chat.resource).digest('hex')
              yield {
                sourceId: chat.resource,
                histories: [{ chat: history, session, identity }],
              }
            } catch (error: unknown) {
              signal?.throwIfAborted()
              yield { sourceId: chat.resource, histories: [], warning: error instanceof Error ? error.message : String(error) }
            }
          }
        } catch (error: unknown) {
          signal?.throwIfAborted()
          yield { sourceId: resource, histories: [], warning: error instanceof Error ? error.message : String(error) }
        }
      }
      cursor = page.nextCursor
      if (cursor !== undefined && (cursors.has(cursor) || cursors.size >= limit + 1)) {
        throw new Error('AHP session catalog pagination did not finish')
      }
      if (cursor !== undefined) cursors.add(cursor)
    } while (cursor !== undefined && visitedChats.size < limit)
  } finally {
    signal?.removeEventListener('abort', cancel)
    await client.shutdown()
  }
}
