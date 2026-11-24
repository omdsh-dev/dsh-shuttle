import { Context } from '@deepseek-ai/cordis'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId, SessionLogOffset, SessionSeq, validateSessionLog } from '@deepseek-ai/dsh-session'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { parseAhp, projectAhpHistory, serializeAhp, toAhp } from '../src/ahp.ts'
import { ahpEndpoint, readAhpHost, type AhpImportEntry } from '../src/ahp-client.ts'
import { startAhpSnapshotHost } from '../src/ahp-host.ts'
import { fromDsh, materializeCompleteTurns, projectCompleteTurns, toDsh } from '../src/dsh.ts'
import { ShuttleService } from '../src/runtime.ts'
import type { PortableConversation } from '../src/types.ts'

const original: PortableConversation = {
  version: 1, source: 'dsh', id: 'protocol-proof', cwd: '/tmp/project', title: 'AHP proof', createdAt: 1000,
  messages: [
    { id: 'q', role: 'user', createdAt: 2000, content: [{ type: 'text', text: 'check' }] },
    { id: 'a', role: 'assistant', content: [
      { type: 'reasoning', text: 'thinking' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
    ] },
    { id: 'r', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: 'fixture', isError: true }] },
    { id: 'f', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ],
}

describe('Microsoft AHP history', () => {
  it('round-trips a read-only snapshot and writes native DSH text, tool results, title, and time', () => {
    const saved = toAhp(original)
    expect(saved.protocolVersion).toBe('1.1.0')
    expect(saved.snapshots.map(item => item.resource.split(':')[0])).toEqual(['ahp-session', 'ahp-chat'])
    const [portable] = parseAhp(serializeAhp(original))
    expect(portable).toMatchObject({ source: 'ahp', title: original.title, cwd: original.cwd, createdAt: 1000 })
    expect(portable!.messages.map(item => item.role)).toEqual(original.messages.map(item => item.role))
    const native = toDsh(portable!)
    const replay = fromDsh({ meta: native.header, events: native.events, inheritedEventCount: SessionLogOffset(0) })
    expect(replay.title).toBe('AHP proof')
    expect(replay.messages.find(item => item.role === 'user')).toMatchObject({ createdAt: 2000 })
    expect(replay.messages.find(item => item.role === 'tool')?.content[0]).toEqual(original.messages[2]!.content[0])
    expect(native.events).toContainEqual(expect.objectContaining({
      type: 'user/message',
      data: expect.objectContaining({ source: { kind: 'plugin:dsh-shuttle:history-boundary', form: 'recall' } }),
    }))
    expect(replay.messages.map(item => item.role)).toEqual(original.messages.map(item => item.role))
  })

  it('combines whole turns and remaps calls, results, and provenance to the target', () => {
    const source = original.messages.map((message, index) => ({ ...message, createdAt: 2000 + index * 100, turnState: 'error' as const }))
    const [first] = parseAhp(serializeAhp({ ...original, messages: source }))
    const [second] = parseAhp(serializeAhp({ ...original, id: 'other', messages: source }))
    const capture = (value: PortableConversation) => {
      const { header, events } = toDsh(value)
      return { meta: header, events, inheritedEventCount: SessionLogOffset(0) }
    }
    const a = projectCompleteTurns(capture(first!))
    const b = projectCompleteTurns(capture(second!))
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0]?.identity).not.toBe(b[0]?.identity)
    const options = { sessionId: SessionId('complete'), createdAt: 9000, sequenceOffset: 1 }
    const history = materializeCompleteTurns([...a, ...b], options)
    const header = { id: options.sessionId, version: 4 as const, isSeeded: false, createdAt: options.createdAt }
    const events = [{
      type: 'session/title' as const, seq: SessionSeq(0), time: 9000,
      data: { title: 'Complete turns', messageSeqs: [], source: { kind: 'user' as const } },
    }, ...history]
    validateSessionLog(header, events)
    expect(history.filter(item => item.type === 'turn/start')).toHaveLength(2)
    expect(history.filter(item => item.type === 'turn/end').map(item => item.data.reason.kind)).toEqual(['error', 'error'])
    const calls = history.filter(item => item.type === 'tool/call')
    const results = history.filter(item => item.type === 'tool/result')
    expect(new Set(calls.map(item => item.data.callId)).size).toBe(2)
    expect(results.map(item => item.data.message.toolCallId)).toEqual(calls.map(item => item.data.callId))
    expect(results.map(item => item.sourceEventSeqs)).toEqual(calls.map(item => [item.seq]))
    expect(results.every(item => item.data.message.isError)).toBe(true)
    const replay = fromDsh({ meta: header, events, inheritedEventCount: SessionLogOffset(0) })
    expect(replay.messages.map(message => message.origin?.messageId)).toEqual([...source, ...source].map(message => message.id))
    expect(replay.messages.map(message => message.createdAt)).toEqual([...source, ...source].map(message => message.createdAt))
  })

  it('previews without writing, imports once from a real AHP WebSocket, then exports an AHP file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shuttle-ahp-'))
    const ctx = new Context()
    const host = await startAhpSnapshotHost(toAhp(original))
    try {
      await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
      const sessionIds: SessionId[] = []
      const path = await realpath(root)
      const removeWorkspace = ctx.provide('workspaceRegistry', {
        list: () => [{ path, sessionIds, attachSession: async (id: SessionId) => { sessionIds.push(id) } }],
      })
      const shuttle = new ShuttleService(ctx)
      const request = { from: 'ahp' as const, source: host.url, targetCwd: root }
      expect((await shuttle.importConversations(request)).items).toEqual([expect.objectContaining({ status: 'planned' })])
      expect(await ctx.sessionPersistence.list()).toEqual([])
      expect(sessionIds).toEqual([])
      const result = await shuttle.importConversations({ ...request, apply: true })
      expect(result.items).toEqual([expect.objectContaining({ status: 'written' })])
      expect(await ctx.sessionPersistence.list()).toEqual([expect.objectContaining({
        header: expect.objectContaining({ cwd: await realpath(root) }),
      })])
      expect((await shuttle.importConversations({ ...request, apply: true })).items).toEqual([
        expect.objectContaining({ status: 'skipped' }),
      ])
      expect(sessionIds).toEqual([result.items[0]!.destination])
      await removeWorkspace()
      const report = await shuttle.exportConversations({ to: 'ahp', destination: join(root, 'exports'), apply: true })
      expect(report.items).toEqual([expect.objectContaining({ status: 'written', destination: expect.stringMatching(/\.ahp\.json$/) })])
    } finally {
      await host.close()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serves 137 ordered turns with connection-scoped cursors and an action before each reply', async () => {
    const messages = Array.from({ length: 137 }, (_, i) =>
      ({ id: 'u-' + i, role: 'user' as const, content: [{ type: 'text' as const, text: 'Question ' + i }] }))
    const archive = toAhp({ ...original, messages })
    const chat = archive.snapshots[1]!.resource
    const host = await startAhpSnapshotHost(archive)
    const open = async () => {
      const ws = new WebSocket(host.url)
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      const frames: Record<string, any>[] = []
      let id = 0
      ws.on('message', raw => frames.push(JSON.parse(raw.toString())))
      const rpc = async (method: string, params: object) => {
        const index = frames.length
        const requestId = ++id
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }))
        const reply = await vi.waitFor(() => {
          const event = frames.find(frame => frame.id === requestId)
          if (event === undefined) throw new Error('waiting for ' + method)
          return event
        })
        return { result: reply.result, error: reply.error,
          notifications: frames.slice(index, frames.indexOf(reply)).filter(frame => frame.method !== undefined) }
      }
      await rpc('initialize', { channel: 'ahp-root://', clientId: 'test', protocolVersions: ['1.1.0'] })
      return rpc
    }
    try {
      const first = await open()
      const other = await open()
      expect((await other('subscribe', { channel: chat })).result.snapshot.state.turns).toHaveLength(137)
      const initial = (await first('subscribe', { channel: chat, view: { turns: 50 } })).result.snapshot.state
      expect(initial.turns).toHaveLength(50)
      const cursor = initial.turnsNextCursor
      expect((await other('fetchTurns', { channel: chat, cursor })).error.code).toBe(-32602)
      const middleResponse = await first('fetchTurns', { channel: chat, cursor })
      expect(middleResponse.result).toEqual({})
      expect(middleResponse.notifications[0]?.params.action.type).toBe('chat/turnsLoaded')
      const middle = middleResponse.notifications[0]?.params.action
      expect(middle.turns).toHaveLength(50)
      expect((await first('fetchTurns', { channel: chat, cursor })).error.code).toBe(-32602)
      const oldestResponse = await first('fetchTurns', { channel: chat, cursor: middle.turnsNextCursor })
      const oldest = oldestResponse.notifications[0]?.params.action
      expect(oldest.turns).toHaveLength(37)
      expect(oldest.turnsNextCursor).toBeUndefined()
      expect([...oldest.turns, ...middle.turns, ...initial.turns].map(turn => turn.message.text))
        .toEqual(messages.map(message => message.content[0]!.text))
    } finally {
      await host.close()
    }
  })

  it.each(['catalog', 'session snapshot'])('pages Pi history using chat addresses from the %s', async discovery => {
    const archive = toAhp(original)
    const session = { ...archive.snapshots[0]!, resource: 'pi:/existing-session' }
    const chatResource = 'ahp-chat://default/' + Buffer.from(session.resource).toString('base64url')
    const chat = { ...archive.snapshots[1]!, resource: chatResource }
    const subscriptions: Array<{ channel: string; view?: { turns?: number } }> = []
    const requestedCursors: string[] = []
    const now = new Date(6000).toISOString()
    const before = {
      id: 'older', startedAt: now, message: { text: 'older input', origin: { kind: 'user' } },
      responseParts: [], state: 'complete',
    }
    const after = {
      ...before, id: 'newer', message: { text: 'newer input', origin: { kind: 'user' } },
    }
    const middle = { ...before, id: 'middle', message: { text: 'middle input', origin: { kind: 'user' } } }
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      server.on('connection', socket => socket.on('message', raw => {
        const { id, method, params } = JSON.parse(raw.toString())
        if (id === undefined) return
        const reply = (result: object) => socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
        if (method === 'initialize') reply({ protocolVersion: '1.1.0', serverSeq: 0, snapshots: [] })
        if (method === 'listSessions') reply({ items: [{
          ...archive.sessions[0], resource: session.resource, provider: 'pi',
          ...(discovery === 'catalog' ? { defaultChat: chatResource, chats: [{ resource: chatResource }] } : {}),
        }] })
        if (method === 'subscribe') subscriptions.push(params)
        if (method === 'subscribe' && params.channel === session.resource) reply({ snapshot: {
          ...session, state: { ...session.state, defaultChat: chatResource, chats: [{ resource: chatResource }] },
        } })
        if (method === 'subscribe' && params.channel === chat.resource) reply({
          snapshot: { ...chat, state: {
            ...chat.state, resource: chatResource, turns: [after], turnsNextCursor: 'older-1', activeTurn: { message: { text: 'private draft' } },
          } },
        })
        if (method === 'fetchTurns') {
          requestedCursors.push(params.cursor)
          const firstPage = params.cursor === 'older-1'
          socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'action', params: {
            channel: chat.resource, serverSeq: requestedCursors.length, action: {
              type: 'chat/turnsLoaded', turns: [firstPage ? middle : before],
              ...(firstPage ? { turnsNextCursor: 'older-2' } : {}),
            },
          } }))
          reply({})
        }
      }))
      const entries: AhpImportEntry[] = []
      for await (const entry of readAhpHost(ahpEndpoint(`ws://127.0.0.1:${address.port}`), 1, 64 * 1024)) {
        entries.push(entry)
      }
      expect(entries).toHaveLength(1)
      expect(subscriptions).toEqual([
        ...(discovery === 'session snapshot' ? [{ channel: session.resource }] : []),
        { channel: chatResource, view: { turns: 50 } },
      ])
      expect(requestedCursors).toEqual(['older-1', 'older-2'])
      expect(projectAhpHistory(entries[0]!.histories[0]!).messages.flatMap(item => item.content))
        .toEqual([{ type: 'text', text: 'older input' }, { type: 'text', text: 'middle input' }, { type: 'text', text: 'newer input' }])
    } finally {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    }
  })
})
