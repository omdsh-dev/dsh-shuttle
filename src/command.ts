import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { ShuttleService } from './runtime.ts'
import { EXTERNAL_PLATFORMS, type ExternalPlatform, type MigrationReport } from './types.ts'

const PLATFORMS = new Set<ExternalPlatform>(EXTERNAL_PLATFORMS)
const HELP = [
  'DSH Shuttle conversation migration:',
  '/shuttle import <platform> [--source <path-or-ahp-url>] [--cwd <ahp-target-workspace>] [--limit <n>] [--apply]',
  '/shuttle export <platform> [--destination <path>] [--session <id> ...|--all] [--apply]',
  'Platforms: ahp, codex, claude-code, pi, reasonix, opencode.',
  'Without --apply, Shuttle only previews. Export defaults to the current session.',
].join('\n')

export type ShuttleCommandRequest =
  | { action: 'help' }
  | { action: 'import'; platform: ExternalPlatform; source?: string; targetCwd?: string; limit?: number; apply: boolean }
  | { action: 'export'; platform: ExternalPlatform; destination?: string; sessionIds?: string[]; all: boolean; apply: boolean }

function tokenize(input: string): string[] {
  const tokens: string[] = []
  let token = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  let active = false
  for (const char of input.trim()) {
    if (escaped) {
      token += char
      active = true
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      active = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else token += char
      active = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      active = true
      continue
    }
    if (/\s/u.test(char)) {
      if (active) {
        tokens.push(token)
        token = ''
        active = false
      }
      continue
    }
    token += char
    active = true
  }
  if (escaped) throw new Error('input ends with an incomplete escape')
  if (quote !== undefined) throw new Error('input contains an unclosed quote')
  if (active) tokens.push(token)
  return tokens
}

function platform(value: string | undefined): ExternalPlatform {
  if (value !== undefined && PLATFORMS.has(value as ExternalPlatform)) return value as ExternalPlatform
  throw new Error(`platform must be one of: ${[...PLATFORMS].join(', ')}`)
}

function optionValue(tokens: readonly string[], index: number, name: string): string {
  const value = tokens[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

/** Parse `/shuttle` input without invoking a shell or expanding paths. */
export function parseShuttleInput(rawInput: string): ShuttleCommandRequest {
  const tokens = tokenize(rawInput)
  const action = tokens[0]
  if (action === undefined || action === 'help' || action === '--help' || action === '-h') return { action: 'help' }
  if (action !== 'import' && action !== 'export') throw new Error(`unknown action "${action}"; use import or export`)
  const target = platform(tokens[1])
  let source: string | undefined
  let targetCwd: string | undefined
  let destination: string | undefined
  let limit: number | undefined
  const sessionIds: string[] = []
  let all = false
  let apply = false

  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--apply') {
      apply = true
      continue
    }
    if (action === 'import' && token === '--source') {
      source = optionValue(tokens, index, '--source')
      index += 1
      continue
    }
    if (action === 'import' && target === 'ahp' && token === '--cwd') {
      targetCwd = optionValue(tokens, index, '--cwd')
      index += 1
      continue
    }
    if (action === 'import' && token === '--limit') {
      const raw = optionValue(tokens, index, '--limit')
      limit = Number(raw)
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer')
      index += 1
      continue
    }
    if (action === 'export' && token === '--destination') {
      destination = optionValue(tokens, index, '--destination')
      index += 1
      continue
    }
    if (action === 'export' && token === '--session') {
      sessionIds.push(optionValue(tokens, index, '--session'))
      index += 1
      continue
    }
    if (action === 'export' && token === '--all') {
      all = true
      continue
    }
    throw new Error(`unknown or invalid option "${token}" for ${action}`)
  }
  if (action === 'import') return {
    action, platform: target, apply,
    ...(source !== undefined ? { source } : {}),
    ...(targetCwd === undefined ? {} : { targetCwd }),
    ...(limit !== undefined ? { limit } : {}),
  }
  if (all && sessionIds.length > 0) throw new Error('--all cannot be combined with --session')
  return {
    action, platform: target, apply, all,
    ...(destination !== undefined ? { destination } : {}),
    ...(sessionIds.length > 0 ? { sessionIds } : {}),
  }
}

export function renderReport(report: MigrationReport): string {
  const counts = new Map<string, number>()
  for (const item of report.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1)
  const headline = report.dryRun ? 'Preview complete (no files were written).' : 'Migration complete.'
  const summary = ['planned', 'written', 'skipped', 'failed']
    .map(status => `${status}: ${counts.get(status) ?? 0}`).join(', ')
  const details = report.items.slice(0, 20).map(item => {
    const target = item.destination === undefined ? '' : ` → ${item.destination}`
    const warning = item.warning === undefined ? '' : ` (${item.warning})`
    return `- [${item.status}] ${item.sourceId}${target}${warning}`
  })
  if (report.items.length > details.length) details.push(`- … ${report.items.length - details.length} more item(s) omitted`)
  const warnings = report.warnings.map(warning => `- warning: ${warning}`)
  return [headline, summary, ...details, ...warnings].join('\n')
}

/** Execute one parsed UI command against the same backend-neutral service as the CLI. */
export async function executeShuttleCommand(
  shuttle: ShuttleService,
  invocation: Pick<CommandInvocation, 'rawInput' | 'signal' | 'agent'>,
): Promise<CommandResult> {
  try {
    const request = parseShuttleInput(invocation.rawInput)
    if (request.action === 'help') return { kind: 'success', text: HELP }
    const targetCwd = request.action === 'import' && request.platform === 'ahp'
      ? request.targetCwd ?? invocation.agent.session.header.cwd
      : undefined
    const report = request.action === 'import'
      ? await shuttle.importConversations({
          from: request.platform,
          apply: request.apply,
          signal: invocation.signal,
          ...(request.source !== undefined ? { source: request.source } : {}),
          ...(targetCwd === undefined ? {} : { targetCwd }),
          ...(request.limit !== undefined ? { limit: request.limit } : {}),
        })
      : await shuttle.exportConversations({
          to: request.platform,
          apply: request.apply,
          signal: invocation.signal,
          ...request.all
            ? {}
            : { sessionIds: request.sessionIds ?? [String(invocation.agent.session.id)] },
          ...(request.destination !== undefined ? { destination: request.destination } : {}),
        })
    const text = renderReport(report)
    return report.items.some(item => item.status === 'failed')
      ? { kind: 'error', text }
      : { kind: 'success', text }
  } catch (error) {
    if (invocation.signal.aborted) throw error
    return { kind: 'error', text: `Shuttle: ${(error as Error).message}\n\n${HELP}` }
  }
}

/** Register the optional DSH UI command when the commands service is composed. */
export function registerShuttleCommand(ctx: Context, shuttle: ShuttleService): void {
  ctx.effect(() => ctx.commands.register({
    name: 'shuttle',
    description: 'Preview or migrate conversations between DSH and coding agents',
    input: { hint: '<import|export> <platform> [options]' },
    handler: invocation => executeShuttleCommand(shuttle, invocation),
  }), 'shuttle: command')
}
