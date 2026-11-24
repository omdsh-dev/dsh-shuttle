#!/usr/bin/env node

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ShuttleService } from './runtime.ts'
import { toAhp, type AhpExport } from './ahp.ts'
import { readNativeArchives } from './native-history.ts'
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_SESSIONS, discoverFiles } from './io.ts'
import { startAhpSnapshotHost } from './ahp-host.ts'
import { EXTERNAL_PLATFORMS, type ExternalPlatform } from './types.ts'

const PLATFORMS = new Set<ExternalPlatform>(EXTERNAL_PLATFORMS)

function platform(value: string | undefined, flag: string): ExternalPlatform {
  if (value !== undefined && PLATFORMS.has(value as ExternalPlatform)) return value as ExternalPlatform
  throw new Error(`${flag} must be one of: ${[...PLATFORMS].join(', ')}`)
}

function usage(): string {
  return `dsh-shuttle import --from <platform> [--source <path-or-ahp-url>] [--cwd <ahp-target-workspace>] [--dsh-root <path>] [--limit <n>] [--apply]\n`
    + `dsh-shuttle export --to <platform> [--session <id> ...] [--destination <path>] [--dsh-root <path>] [--apply]\n\n`
    + 'dsh-shuttle serve-ahp --session <id> [--session <id> ...] [--port <port>] [--dsh-root <path>]\n'
    + 'dsh-shuttle serve-ahp --from <native-platform> --source <path> [--limit <n>] [--port <port>]\n'
    + 'Without --apply, import and export only print a migration plan. Existing destinations are never overwritten.\n'
}

function positiveInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('--limit must be a positive integer')
  return parsed
}

async function* nativeExports(
  from: ExternalPlatform, source: string, limit: number,
): AsyncGenerator<AhpExport> {
  if (from === 'ahp') throw new Error('serve-ahp --from requires a native platform')
  const paths = await discoverFiles(from, source, limit)
  let count = 0
  for (const path of paths) {
    for (const archive of await readNativeArchives(from, path, DEFAULT_MAX_FILE_BYTES)) {
      if (!archive.snapshots.some(({ state }) => 'turns' in state && state.turns.length > 0)) continue
      yield archive
      if (++count === limit) return
    }
  }
}

async function serveHistory(archives: AsyncIterable<AhpExport>, port: number): Promise<void> {
  const exports: AhpExport[] = []
  let bytes = 0
  for await (const archive of archives) {
    bytes += Buffer.byteLength(JSON.stringify(archive))
    if (bytes > DEFAULT_MAX_FILE_BYTES) throw new Error('Selected AHP snapshots exceed the combined size limit')
    exports.push(archive)
  }
  if (exports.length === 0) throw new Error('No conversations with history were found')
  const host = await startAhpSnapshotHost({
    protocolVersion: exports[0]!.protocolVersion,
    sessions: exports.flatMap(entry => entry.sessions).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
    snapshots: exports.flatMap(entry => entry.snapshots),
  }, port)
  const stop = () => { void host.close() }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    process.stdout.write(host.url + '\n')
    await host.closed
  } finally {
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    await host.close()
  }
}

async function* dshExports(shuttle: ShuttleService, ids: readonly string[]): AsyncGenerator<AhpExport> {
  for (const id of ids) yield toAhp(await shuttle.readConversation(SessionId(id)))
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command !== 'import' && command !== 'export' && command !== 'serve-ahp') {
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
      cwd: { type: 'string' },
      destination: { type: 'string' },
      session: { type: 'string', multiple: true },
      'dsh-root': { type: 'string' },
      limit: { type: 'string' },
      port: { type: 'string' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })
  if (values.help) {
    process.stdout.write(usage())
    return
  }
  if (values.cwd !== undefined && command !== 'import') throw new Error('--cwd is only valid for AHP imports')
  const port = Number(values.port ?? 0)
  if (command === 'serve-ahp') {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be between 0 and 65535')
    if (values.from !== undefined || values.source !== undefined) {
      if (values.session !== undefined || values['dsh-root'] !== undefined) {
        throw new Error('Select a native source or DSH sessions')
      }
      if (values.source === undefined || values.source.trim() === '') throw new Error('Specify --source for native history')
      const from = platform(values.from, '--from')
      const limit = Math.min(values.limit === undefined ? DEFAULT_MAX_SESSIONS : positiveInteger(values.limit), DEFAULT_MAX_SESSIONS)
      await serveHistory(nativeExports(from, values.source, limit), port)
      return
    }
  } else if (values.port !== undefined) {
    throw new Error('--port is only valid with serve-ahp')
  }
  const dshRoot = resolve(values['dsh-root'] ?? join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'sessions'))
  const ctx = new Context()
  const store = await ctx.plugin(SessionStore)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: dshRoot })
  const shuttle = new ShuttleService(ctx)
  try {
    if (command === 'serve-ahp') {
      const ids = [...new Set(values.session)]
      if (ids.length === 0) throw new Error('serve-ahp requires --session or --from and --source')
      if (ids.length > DEFAULT_MAX_SESSIONS) throw new Error(`serve-ahp accepts at most ${DEFAULT_MAX_SESSIONS} sessions`)
      await serveHistory(dshExports(shuttle, ids), port)
      return
    }
    const report = command === 'import'
      ? await shuttle.importConversations({
          from: platform(values.from, '--from'),
          ...(values.source !== undefined ? { source: values.source } : {}),
          ...(values.cwd !== undefined ? { targetCwd: values.cwd } : {}),
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
