import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { nativeAhpHistory, projectAhpHistory } from '../src/ahp.ts'
import { adapters } from '../src/adapters.ts'
import { fromDsh, toDsh } from '../src/dsh.ts'
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
      const translated = projectAhpHistory(nativeAhpHistory(parsed!))
      expect(translated.messages.map(({ id, createdAt, role, content }) => ({ id, createdAt, role, content })))
        .toEqual(parsed!.messages.map(({ id, createdAt, role, content }) => ({ id, createdAt, role, content })))
      const { header, events } = toDsh(translated)
      const restored = fromDsh({ meta: header, events, inheritedEventCount: SessionLogOffset(0) })
      expect(restored.messages.flatMap(message => message.content).some(block => block.type === 'tool-result')).toBe(true)
      const [roundTrip] = adapters[platform].parse(adapters[platform].serialize(restored))
      expect(roundTrip?.messages.flatMap(message => message.content).some(part => part.type === 'tool-result')).toBe(true)
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

  it('imports native OpenCode V2 history with settled tools and excludes the unfinished tail', () => {
    const [parsed] = adapters.opencode.parse(JSON.stringify({
      info: { id: 'ses_v2', title: 'V2 fixture', location: { directory: '/tmp/v2-project' }, time: { created: 1 } },
      messages: [
        { type: 'user', id: 'msg_user', text: 'Read both', time: { created: 1 } },
        { type: 'assistant', id: 'msg_first', time: { created: 2, completed: 3 },
          model: { id: 'my-model', providerID: 'my-provider' }, finish: 'tool-calls', content: [
            { type: 'reasoning', text: 'Check both files' },
            { type: 'tool', id: 'call-ok', name: 'read',
              state: { status: 'completed', input: { path: 'good' }, content: [{ type: 'text', text: 'File content' }] } },
            { type: 'tool', id: 'call-error', name: 'read', state: { status: 'error', input: { path: 'bad' },
              content: [{ type: 'text', text: 'Attempted' }], error: { type: 'ToolError', message: 'File not found' } } },
          ] },
        { type: 'assistant', id: 'msg_second', time: { created: 4, completed: 5 },
          finish: 'stop', content: [{ type: 'text', text: 'Only one file exists' }] },
        { type: 'user', id: 'msg_draft', text: 'Draft', time: { created: 6 } },
        { type: 'assistant', id: 'msg_partial', time: { created: 7 }, content: [{ type: 'text', text: 'Partial' }] },
      ],
    }))
    expect(parsed).toMatchObject({ id: 'ses_v2', cwd: '/tmp/v2-project' })
    const history = nativeAhpHistory(parsed!)
    expect(history.chat.turns).toHaveLength(1)
    expect(history.chat.turns[0]?.responseParts).toMatchObject([
      { kind: 'reasoning', content: 'Check both files' },
      { kind: 'toolCall', toolCall: { toolCallId: 'call-ok', toolName: 'read', toolInput: '{"path":"good"}',
        success: true, content: [{ text: 'File content' }] } },
      { kind: 'toolCall', toolCall: { toolCallId: 'call-error', toolName: 'read', toolInput: '{"path":"bad"}',
        success: false, content: [{ text: 'Attempted\nFile not found' }] } },
      { kind: 'markdown', content: 'Only one file exists' },
    ])
    expect(projectAhpHistory(history).messages.map(item => item.id)).toEqual([
      'msg_user', 'msg_first', 'msg_first:tools', 'msg_second',
    ])
  })

  it('preserves consecutive identical Codex turns and reads structured tool output as text', () => {
    const rows = [
      { type: 'response_item', payload: { type: 'message', id: 'first', role: 'user', content: [{ type: 'input_text', text: 'check' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'check' } },
      { type: 'response_item', payload: { type: 'message', id: 'second', role: 'user', content: [{ type: 'input_text', text: 'check' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'check' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'code-call', name: 'read', input: 'check' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'code-call',
        output: [{ type: 'input_text', text: 'first line' }, { type: 'input_text', text: 'second line' }] } },
    ]
    const [parsed] = adapters.codex.parse(rows.map(row => JSON.stringify(row)).join('\n'))
    expect(parsed!.messages.filter(item => item.role === 'user').map(item => item.id)).toEqual(['first', 'second'])
    expect(parsed?.messages.at(-1)?.content).toEqual([
      { type: 'tool-result', toolCallId: 'code-call', content: 'first line\nsecond line' },
    ])
  })

  it('pairs Claude Code tool results in mixed user records with the prior turn', () => {
    const rows = [
      { type: 'user', uuid: 'prompt', message: { role: 'user', content: 'Read both files' } },
      { type: 'assistant', uuid: 'call', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Check the files' },
        { type: 'tool_use', id: 'claude-call', name: 'Read', input: { path: 'missing' } },
      ] } },
      { type: 'user', uuid: 'mixed', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'claude-call', is_error: true, content: [{ type: 'text', text: 'Not found' }] },
        { type: 'text', text: 'Try another file' },
      ] } },
    ]
    const [parsed] = adapters['claude-code'].parse(rows.map(row => JSON.stringify(row)).join('\n'))
    const { chat } = nativeAhpHistory(parsed!)
    expect(chat.turns.map(turn => turn.message.text)).toEqual(['Read both files', 'Try another file'])
    expect(chat.turns[0]?.responseParts).toMatchObject([
      { kind: 'reasoning', content: 'Check the files' },
      { kind: 'toolCall', toolCall: { toolCallId: 'claude-call', success: false, content: [{ text: 'Not found' }] } },
    ])
  })

  it('uses the last saved Pi branch and preserves its paired tool result', () => {
    const row = (id: string, parentId: string | null, role: string, content: unknown, extra = {}) =>
      ({ type: 'message', id, parentId, message: { role, content, ...extra } })
    const rows = [
      { type: 'session', version: 3, id: 'tree' },
      row('root', null, 'user', 'Question'),
      row('old', 'root', 'assistant', 'Abandoned response'),
      row('call', 'root', 'assistant', [{ type: 'toolCall', id: 'pi-call', name: 'read', arguments: {} }]),
      row('result', 'call', 'toolResult', [{ type: 'text', text: 'Paired result' }], { toolCallId: 'pi-call' }),
      { type: 'session_info', id: 'tail', parentId: 'result', name: 'New branch' },
    ]
    const [parsed] = adapters.pi.parse(rows.map(item => JSON.stringify(item)).join('\n'))
    expect(parsed!.messages.map(item => item.id)).toEqual(['root', 'call', 'result'])
    expect(nativeAhpHistory(parsed!).chat.turns[0]?.responseParts).toMatchObject([
      { kind: 'toolCall', toolCall: { toolCallId: 'pi-call', success: true, content: [{ text: 'Paired result' }] } },
    ])
  })

  it('writes OpenCode official export/import envelope', () => {
    const value = JSON.parse(adapters.opencode.serialize(sample)) as Record<string, unknown>
    expect(value).toHaveProperty('info')
    expect(value).toHaveProperty('messages')
  })
})
