export type ShuttleDirection = 'import' | 'export'
export type ShuttlePlatform = 'codex' | 'claude-code' | 'pi' | 'reasonix' | 'opencode'

export interface ShuttleFormValue {
  direction: ShuttleDirection
  platform: ShuttlePlatform
  path: string
  limit: string
  all: boolean
}

/** Quote one argument for Shuttle's own tokenizer (this is not a shell command). */
export function quoteShuttleArgument(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** Build the slash command shared by preview and confirmed execution. */
export function buildShuttleLine(value: ShuttleFormValue, apply: boolean): string {
  const parts = ['/shuttle', value.direction, value.platform]
  const path = value.path.trim()
  if (path !== '') {
    parts.push(value.direction === 'import' ? '--source' : '--destination', quoteShuttleArgument(path))
  }
  if (value.direction === 'import' && value.limit.trim() !== '') {
    const limit = Number(value.limit)
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid-limit')
    parts.push('--limit', String(limit))
  }
  if (value.direction === 'export' && value.all) parts.push('--all')
  if (apply) parts.push('--apply')
  return parts.join(' ')
}
