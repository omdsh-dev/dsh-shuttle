/** Local, read-only AHP export of an explicitly selected snapshot set. */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { ActionType, PROTOCOL_VERSION, type RootState, type Snapshot } from '@microsoft/agent-host-protocol'
import { z } from 'zod'
import { HISTORY_PROTOCOL_VERSIONS } from './ahp-client.ts'
import type { AhpExport } from './ahp.ts'

const ROOT = 'ahp-root://'
const TURN_PAGE_SIZE = 50
const envelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
})
const handshake = z.object({
  channel: z.literal(ROOT), clientId: z.string().min(1), protocolVersions: z.array(z.string()),
  initialSubscriptions: z.array(z.string()).max(100).optional(),
})
const pageRequest = z.object({
  channel: z.literal(ROOT), limit: z.number().int().positive().optional(),
  cursor: z.string().regex(/^(0|[1-9]\d*)$/u).optional(),
})
const channel = z.object({ channel: z.string() })
const subscription = channel.extend({ view: z.object({ turns: z.number().int().nonnegative().optional() }).optional() })
const turnPageRequest = channel.extend({ cursor: z.string().optional() })

export interface AhpSnapshotHost {
  url: string
  close(): Promise<void>
  closed: Promise<void>
}

/** Serve native AHP snapshots to local CLI clients without exposing store or Agent mutation. */
export async function startAhpSnapshotHost(archive: AhpExport, port = 0, maxSnapshotBytes = 64 * 1024 * 1024): Promise<AhpSnapshotHost> {
  if (archive.protocolVersion !== PROTOCOL_VERSION) throw new Error('Unsupported export protocol version')
  const root: RootState = { agents: [{ provider: 'dsh-shuttle', displayName: 'DSH Shuttle', description: 'Read-only exported history', models: [] }] }
  const snapshots = new Map<string, Snapshot>([[ROOT, { resource: ROOT, fromSeq: 0, state: root }]])
  for (const snapshot of archive.snapshots) {
    if (Buffer.byteLength(JSON.stringify(snapshot)) > maxSnapshotBytes) throw new Error('AHP snapshot exceeds the configured size limit')
    if (snapshots.has(snapshot.resource)) throw new Error('Duplicate AHP channel in export')
    snapshots.set(snapshot.resource, snapshot)
  }
  const server = new WebSocketServer({
    host: '127.0.0.1', port, maxPayload: 64 * 1024, perMessageDeflate: false,
    // Local command-line clients are admitted. Refuse browser-origin upgrades.
    verifyClient: ({ req }: { req: IncomingMessage }) => req.headers.origin === undefined,
  })
  const closed = new Promise<void>(resolve => server.once('close', resolve))
  const sequence = { current: 0 }
  server.on('connection', socket => serveConnection(socket, archive, snapshots, sequence))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('AHP host did not bind a TCP port')
  let stopping = false
  return {
    url: `ws://127.0.0.1:${address.port}`,
    closed,
    close: () => {
      if (!stopping) {
        stopping = true
        for (const socket of server.clients) socket.terminate()
        server.close()
      }
      return closed
    },
  }
}

function serveConnection(
  socket: WebSocket, archive: AhpExport, snapshots: ReadonlyMap<string, Snapshot>, sequence: { current: number },
): void {
  let initialized = false
  const windows = new Map<string, { remaining: number; cursor?: string }>()
  const currentSnapshot = (resource: string): Snapshot | undefined => {
    const snapshot = snapshots.get(resource)
    return snapshot === undefined ? undefined : { ...snapshot, fromSeq: sequence.current }
  }
  const send = (value: object, onSent?: () => void) => {
    if (socket.readyState !== socket.OPEN) return
    if (socket.bufferedAmount > 1024 * 1024) { socket.close(1008, 'AHP receiver is too slow'); return }
    socket.send(JSON.stringify(value), error => {
      if (error) socket.terminate()
      else onSent?.()
    })
  }
  socket.on('error', () => { socket.terminate() })
  socket.on('message', (data, binary) => {
    if (binary) {
      socket.close(1003, 'AHP uses JSON text frames')
      return
    }
    let message: unknown
    try { message = JSON.parse(data.toString()) }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return }
    const request = envelope.safeParse(message)
    if (!request.success) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } })
      return
    }
    const { id, method, params } = request.data
    if (id === undefined) {
      if (initialized && method === 'unsubscribe') {
        const input = channel.safeParse(params)
        if (input.success) windows.delete(input.data.channel)
      }
      return
    }
    const success = (result: unknown) => send({ jsonrpc: '2.0', id, result })
    const fail = (code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } })
    if (method === 'ping') { success({}); return }
    if (method === 'initialize' && !initialized) {
      const input = handshake.safeParse(params)
      if (!input.success) { fail(-32602, 'Invalid initialize parameters'); return }
      const version = HISTORY_PROTOCOL_VERSIONS.find(candidate => input.data.protocolVersions.includes(candidate))
      if (version === undefined) {
        send({ jsonrpc: '2.0', id, error: {
          code: -32005, message: 'Unsupported protocol version', data: { supportedVersions: HISTORY_PROTOCOL_VERSIONS },
        } })
        socket.close()
        return
      }
      initialized = true
      success({
        protocolVersion: version, serverSeq: sequence.current, serverInfo: { name: 'dsh-shuttle' },
        snapshots: (input.data.initialSubscriptions ?? []).flatMap(uri => {
          const snapshot = currentSnapshot(uri)
          if (snapshot && 'turns' in snapshot.state) windows.set(uri, { remaining: 0 })
          return snapshot ?? []
        }),
      })
      return
    }
    if (!initialized) { fail(-32600, 'Initialize first'); return }
    if (method === 'listSessions') {
      const input = pageRequest.safeParse(params)
      if (!input.success) { fail(-32602, 'Invalid catalog parameters'); return }
      const offset = Number(input.data.cursor ?? 0)
      if (!Number.isSafeInteger(offset) || offset > archive.sessions.length) { fail(-32602, 'Invalid cursor'); return }
      const end = offset + Math.min(input.data.limit ?? 100, 100)
      success({ items: archive.sessions.slice(offset, end), ...(end < archive.sessions.length ? { nextCursor: String(end) } : {}) })
      return
    }
    if (method === 'subscribe') {
      const input = subscription.safeParse(params)
      if (!input.success) { fail(-32602, 'Invalid subscription parameters'); return }
      const resource = input.data.channel
      const snapshot = currentSnapshot(resource)
      if (snapshot === undefined) { fail(-32001, 'Channel not found'); return }
      const newest = input.data.view?.turns
      if ('turns' in snapshot.state) {
        const { state } = snapshot
        const remaining = newest === undefined ? 0 : Math.max(0, state.turns.length - Math.min(newest, TURN_PAGE_SIZE))
        const cursor = remaining > 0 ? randomUUID() : undefined
        windows.set(resource, { remaining, ...(cursor === undefined ? {} : { cursor }) })
        if (cursor !== undefined) {
          success({ snapshot: { ...snapshot, state: { ...state, turns: state.turns.slice(remaining), turnsNextCursor: cursor } } })
          return
        }
      }
      success({ snapshot })
      return
    }
    if (method === 'fetchTurns') {
      const input = turnPageRequest.safeParse(params)
      if (!input.success) { fail(-32602, 'Invalid history page parameters'); return }
      const { channel: resource, cursor } = input.data
      const window = windows.get(resource)
      const state = snapshots.get(resource)?.state
      if (window === undefined || state === undefined || !('turns' in state)) {
        fail(-32602, 'Subscribe to the chat first')
        return
      }
      if (cursor !== undefined && cursor !== window.cursor) { fail(-32602, 'Unknown history cursor'); return }
      if (window.remaining === 0) { success({}); return }
      const remaining = Math.max(0, window.remaining - TURN_PAGE_SIZE)
      const turnsNextCursor = remaining > 0 ? randomUUID() : undefined
      windows.set(resource, { remaining, ...(turnsNextCursor === undefined ? {} : { cursor: turnsNextCursor }) })
      send({ jsonrpc: '2.0', method: 'action', params: {
        channel: resource, serverSeq: ++sequence.current, action: {
          type: ActionType.ChatTurnsLoaded, turns: state.turns.slice(remaining, window.remaining),
          ...(turnsNextCursor === undefined ? {} : { turnsNextCursor }),
        },
      } }, () => success({}))
      return
    }
    fail(-32601, 'This read-only AHP host does not support that method')
  })
}
