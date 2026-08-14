import { describe, expect, it } from 'vitest'
import { adapters } from '../src/adapters.ts'
import type { ExternalPlatform, PortableConversation } from '../src/types.ts'

const sample: PortableConversation = {
  version: 1,
  id: 'fixture-1',
  source: 'dsh',
  title: 'Migration fixture',
  cwd: '/tmp/project',
  createdAt: Date.parse('2026-01-02T03:04:05.000Z'),
  messages: [
    { id: 'user-1', role: 'user', createdAt: 1_767_322_645_000,
      content: [{ type: 'text', text: 'Inspect package.json' }] },
    { id: 'assistant-1', role: 'assistant', createdAt: 1_767_322_646_000,
      provider: 'test-provider', model: 'test-model', content: [
        { type: 'reasoning', text: 'I should read it.' },
        { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"package.json"}' },
      ] },
    { id: 'tool-1', role: 'tool', createdAt: 1_767_322_647_000,
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: '{"name":"demo"}' }] },
    { id: 'assistant-2', role: 'assistant', createdAt: 1_767_322_648_000,
      content: [{ type: 'text', text: 'The package is named demo.' }] },
  ],
}

describe('external adapters', () => {
  for (const platform of Object.keys(adapters) as ExternalPlatform[]) {
    it(`${platform} serializes and parses a portable conversation`, () => {
      const native = adapters[platform].serialize(sample)
      const [parsed] = adapters[platform].parse(native, { path: `/tmp/${platform}.json`, now: sample.createdAt })
      expect(parsed).toBeDefined()
      expect(parsed!.messages.some(message => message.content.some(block => block.type === 'text'))).toBe(true)
      expect(parsed!.messages.some(message => message.content.some(block => block.type === 'tool-call'))).toBe(true)
      expect(parsed!.messages.some(message => message.content.some(block => block.type === 'tool-result'))).toBe(true)
    })
  }

  it('keeps Codex JSONL in the documented rollout envelope', () => {
    const rows = adapters.codex.serialize(sample).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(rows[0]).toMatchObject({ type: 'session_meta' })
    expect(rows.some(row => row['type'] === 'response_item')).toBe(true)
  })

  it('deduplicates Codex event_msg/response_item mirrors and tolerates a live tail', () => {
    const text = [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'same' } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'same' }] } }),
      '{"type":"response_item"',
    ].join('\n')
    const [parsed] = adapters.codex.parse(text)
    expect(parsed!.messages).toHaveLength(1)
  })

  it('writes OpenCode official export/import envelope', () => {
    const value = JSON.parse(adapters.opencode.serialize(sample)) as Record<string, unknown>
    expect(value).toHaveProperty('info')
    expect(value).toHaveProperty('messages')
  })
})
