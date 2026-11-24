import { Context } from '@deepseek-ai/cordis'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionLogOffset, validateSessionLog } from '@deepseek-ai/dsh-session'
import { fromDsh, materializeCompleteTurns, projectCompleteTurns, toDsh } from '../src/dsh.ts'
import type { PortableConversation } from '../src/types.ts'

describe('DSH projection', () => {
  it('creates a replay-valid balanced event log and projects the current surface', () => {
    const input: PortableConversation = {
      version: 1,
      id: 'native-roundtrip',
      source: 'claude-code',
      cwd: '/tmp/work',
      createdAt: 1000,
      messages: [
        { id: 'u1', role: 'user', content: [{ type: 'text', text: 'run it' }] },
        { id: 'a1', role: 'assistant', provider: 'anthropic', model: 'claude-test', content: [
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"true"}' },
        ] },
        { id: 't1', role: 'tool', content: [
          { type: 'tool-result', toolCallId: 'c1', content: 'ok' },
        ] },
        { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ],
    }
    const materialized = toDsh(input)
    expect(() => Session.create(materialized.header.id, structuredClone(materialized.events), materialized.header)).not.toThrow()
    expect(materialized.events.map(event => event.type)).toContain('tool/call')
    expect(materialized.events.map(event => event.type)).toContain('tool/result')

    const projected = fromDsh({ meta: materialized.header, inheritedEventCount: SessionLogOffset(0), events: materialized.events })
    expect(projected.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(projected.messages.flatMap(message => message.content).find(block => block.type === 'tool-result'))
      .toMatchObject({ toolCallId: 'c1', content: 'ok' })
  })

  it('persists tool pairings across assistant fragments when materializing a complete turn', async () => {
    const input: PortableConversation = {
      version: 1, source: 'claude-code', id: 'multi-call', createdAt: 1000,
      messages: [
        { id: 'user', role: 'user', content: [{ type: 'text', text: 'Read both' }] },
        { id: 'one', role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 'read', arguments: '{}' }] },
        { id: 'two', role: 'assistant', content: [
          { type: 'tool-call', id: 'b', name: 'read', arguments: '{}' },
          { type: 'tool-call', id: 'incomplete', name: 'read', arguments: '{}' },
        ] },
        { id: 'results', role: 'tool', content: [
          { type: 'tool-result', toolCallId: 'b', content: 'denied', isError: true },
          { type: 'tool-result', toolCallId: 'a', content: 'ok' },
        ] },
      ],
    }
    const source = toDsh(input)
    const inspection = { meta: source.header, inheritedEventCount: SessionLogOffset(0), events: source.events }
    const turns = projectCompleteTurns(inspection)
    const target = { ...source.header, id: SessionId('fused-pairs') }
    const events = materializeCompleteTurns(turns, { sessionId: target.id, createdAt: 2000, sequenceOffset: 0 })
    validateSessionLog(target, events)
    const calls = events.filter(event => event.type === 'tool/call')
    const results = events.filter(event => event.type === 'tool/result')
    expect(results.map(event => event.sourceEventSeqs)).toEqual([[calls[1]!.seq], [calls[0]!.seq]])
    expect(results.map(event => event.data.message.toolCallId)).toEqual([calls[1]!.data.callId, calls[0]!.data.callId])
    expect(results.map(event => event.data.message.isError)).toEqual([true, false])
    expect(calls).toHaveLength(2)
    const root = await mkdtemp(join(tmpdir(), 'shuttle-complete-tools-'))
    const ctx = new Context()
    try {
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      for (const [header, log] of [[source.header, source.events], [target, events]] as const) {
        const writer = await ctx.sessionPersistence.create(header)
        try {
          await writer.append(log)
          await writer.flush()
        } finally {
          await writer.close()
        }
        const reader = await ctx.sessionPersistence.open(header.id, 'read')
        try {
          const stored = await reader.read()
          expect(projectCompleteTurns({
            meta: reader.header, events: stored.events, inheritedEventCount: reader.inheritedEventCount,
          }).map(turn => turn.identity)).toEqual(turns.map(turn => turn.identity))
        } finally {
          await reader.close()
        }
      }
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('marks imported system context so it survives a DSH round trip', () => {
    const input: PortableConversation = {
      version: 1, id: 'system', source: 'pi', createdAt: 1000,
      messages: [{ id: 's1', role: 'system', content: [{ type: 'text', text: 'be concise' }] }],
    }
    const materialized = toDsh(input)
    expect(fromDsh({ meta: materialized.header, inheritedEventCount: SessionLogOffset(0), events: materialized.events }).messages[0]?.role).toBe('system')
  })
})
