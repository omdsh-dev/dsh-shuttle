import { constants } from 'node:fs'
import { access, mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { ExternalPlatform } from './types.ts'

export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
export const DEFAULT_MAX_SESSIONS = 500

export function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2))
  return resolve(input)
}

export function defaultSourceRoot(platform: ExternalPlatform): string | undefined {
  switch (platform) {
    case 'codex': return join(process.env['CODEX_HOME'] ?? join(homedir(), '.codex'), 'sessions')
    case 'claude-code': return join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'projects')
    case 'pi': return join(homedir(), '.pi', 'agent', 'sessions')
    case 'reasonix': return process.env['REASONIX_STATE_HOME'] ?? process.env['REASONIX_HOME'] ?? join(homedir(), '.reasonix')
    case 'opencode': return undefined
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function acceptedFile(platform: ExternalPlatform, path: string): boolean {
  const name = basename(path)
  if (platform === 'opencode') return extname(name) === '.json'
  if (extname(name) !== '.jsonl') return false
  if (platform === 'reasonix') {
    return !name.endsWith('.events.jsonl') && !name.endsWith('.guardian.jsonl')
  }
  return true
}

export async function discoverFiles(
  platform: ExternalPlatform,
  input: string,
  limit = DEFAULT_MAX_SESSIONS,
  signal?: AbortSignal,
): Promise<string[]> {
  const root = expandHome(input)
  const first = await stat(root)
  if (first.isFile()) return acceptedFile(platform, root) ? [root] : []
  if (!first.isDirectory()) return []
  const found: string[] = []
  const pending = [root]
  while (pending.length > 0 && found.length < limit) {
    signal?.throwIfAborted()
    const current = pending.pop()
    if (current === undefined) break
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => b.name.localeCompare(a.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && acceptedFile(platform, path)) found.push(path)
      if (found.length >= limit) break
    }
  }
  return found.sort()
}

export async function readBoundedText(path: string, maxBytes = DEFAULT_MAX_FILE_BYTES): Promise<string> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`not a regular file: ${path}`)
  if (info.size > maxBytes) throw new Error(`session file exceeds ${maxBytes} bytes: ${path}`)
  return readFile(path, 'utf8')
}

/** Create a new file without replacing an existing destination. */
export async function writeNewFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(path).catch(() => {})
    throw error
  }
  await handle.close()
}

export function safeSegment(value: string, fallback = 'session'): string {
  const normalized = value.normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized.slice(0, 120) || fallback
}
