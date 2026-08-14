#!/usr/bin/env node

import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ShuttleService } from './runtime.ts'
import type { ExternalPlatform } from './types.ts'

const PLATFORMS = new Set<ExternalPlatform>(['codex', 'claude-code', 'pi', 'reasonix', 'opencode'])

function platform(value: string | undefined, flag: string): ExternalPlatform {
  if (value !== undefined && PLATFORMS.has(value as ExternalPlatform)) return value as ExternalPlatform
  throw new Error(`${flag} must be one of: ${[...PLATFORMS].join(', ')}`)
}

function usage(): string {
  return `dsh-shuttle import --from <platform> [--source <path>] [--dsh-root <path>] [--limit <n>] [--apply]\n`
    + `dsh-shuttle export --to <platform> [--session <id> ...] [--destination <path>] [--dsh-root <path>] [--apply]\n\n`
    + 'Without --apply, commands only print a migration plan. Existing destinations are never overwritten.\n'
}

function positiveInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('--limit must be a positive integer')
  return parsed
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command !== 'import' && command !== 'export') {
    process.stdout.write(usage())
    process.exitCode = command === undefined || command === '--help' || command === '-h' ? 0 : 2
    return
  }
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      source: { type: 'string' },
      destination: { type: 'string' },
      session: { type: 'string', multiple: true },
      'dsh-root': { type: 'string' },
      limit: { type: 'string' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })
  if (values.help) {
    process.stdout.write(usage())
    return
  }
  const dshRoot = resolve(values['dsh-root'] ?? join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'sessions'))
  const ctx = new Context()
  const store = await ctx.plugin(SessionStore)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: dshRoot })
  const shuttle = new ShuttleService(ctx)
  try {
    const report = command === 'import'
      ? await shuttle.importConversations({
          from: platform(values.from, '--from'),
          ...(values.source !== undefined ? { source: values.source } : {}),
          ...(values.limit !== undefined ? { limit: positiveInteger(values.limit) } : {}),
          apply: values.apply,
        })
      : await shuttle.exportConversations({
          to: platform(values.to, '--to'),
          ...(values.session !== undefined ? { sessionIds: values.session } : {}),
          ...(values.destination !== undefined ? { destination: values.destination } : {}),
          apply: values.apply,
        })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.items.some(item => item.status === 'failed')) process.exitCode = 1
  } finally {
    await persistence.dispose()
    await store.dispose()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`dsh-shuttle: ${(error as Error).message}\n`)
  process.exitCode = 1
})
