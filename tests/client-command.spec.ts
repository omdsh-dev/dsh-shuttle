import { describe, expect, it } from 'vitest'
import { buildShuttleLine, quoteShuttleArgument } from '../src/client/command.ts'

describe('Shuttle UI command builder', () => {
  it('builds a dry-run import with safely quoted paths', () => {
    expect(buildShuttleLine({
      direction: 'import', platform: 'codex', path: '/tmp/My "Codex" data', limit: '25', all: false,
    }, false)).toBe('/shuttle import codex --source "/tmp/My \\"Codex\\" data" --limit 25')
  })

  it('builds a confirmed all-session export', () => {
    expect(buildShuttleLine({
      direction: 'export', platform: 'opencode', path: '/tmp/out', limit: '', all: true,
    }, true)).toBe('/shuttle export opencode --destination "/tmp/out" --all --apply')
  })

  it('rejects invalid limits and preserves backslashes', () => {
    expect(() => buildShuttleLine({
      direction: 'import', platform: 'pi', path: '', limit: '0', all: false,
    }, false)).toThrow('invalid-limit')
    expect(quoteShuttleArgument('C:\\agent data')).toBe('"C:\\\\agent data"')
  })
})
