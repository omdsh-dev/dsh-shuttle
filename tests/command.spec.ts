import { describe, expect, it, vi } from 'vitest'
import { executeShuttleCommand, parseShuttleInput } from '../src/command.ts'
import type { ShuttleService } from '../src/runtime.ts'

describe('/shuttle command', () => {
  it('parses quoted paths without invoking a shell', () => {
    expect(parseShuttleInput(' import claude-code --source "/tmp/Claude Projects" --limit 12 --apply '))
      .toEqual({
        action: 'import', platform: 'claude-code', source: '/tmp/Claude Projects', limit: 12, apply: true,
      })
  })

  it('rejects conflicting export selection', () => {
    expect(() => parseShuttleInput('export pi --all --session one')).toThrow(/cannot be combined/u)
  })

  it('exports the current UI session by default and renders a preview', async () => {
    const exportConversations = vi.fn().mockResolvedValue({
      dryRun: true,
      startedAt: 1,
      finishedAt: 2,
      warnings: [],
      items: [{
        sourceId: 'session-current', source: 'dsh', target: 'pi', status: 'planned',
        destination: '/tmp/out.jsonl', messageCount: 2,
      }],
    })
    const service = { exportConversations } as unknown as ShuttleService
    const result = await executeShuttleCommand(service, {
      rawInput: ' export pi --destination /tmp/out',
      signal: new AbortController().signal,
      agent: { session: { id: 'session-current' } },
    } as never)
    expect(exportConversations).toHaveBeenCalledWith(expect.objectContaining({
      to: 'pi', apply: false, sessionIds: ['session-current'], destination: '/tmp/out',
    }))
    expect(result).toMatchObject({ kind: 'success' })
    expect(result.text).toContain('Preview complete')
  })

  it('returns help for an empty invocation', async () => {
    const result = await executeShuttleCommand({} as ShuttleService, {
      rawInput: '', signal: new AbortController().signal, agent: { session: { id: 's' } },
    } as never)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('/shuttle import')
  })
})
