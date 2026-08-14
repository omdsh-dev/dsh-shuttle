import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { fromDsh, toDsh } from '../src/dsh.ts'
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

    const projected = fromDsh({ meta: materialized.header, events: materialized.events })
    expect(projected.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(projected.messages.flatMap(message => message.content).find(block => block.type === 'tool-result'))
      .toMatchObject({ toolCallId: 'c1', content: 'ok' })
  })

  it('marks imported system context so it survives a DSH round trip', () => {
    const input: PortableConversation = {
      version: 1, id: 'system', source: 'pi', createdAt: 1000,
      messages: [{ id: 's1', role: 'system', content: [{ type: 'text', text: 'be concise' }] }],
    }
    const materialized = toDsh(input)
    expect(fromDsh({ meta: materialized.header, events: materialized.events }).messages[0]?.role).toBe('system')
  })
})
