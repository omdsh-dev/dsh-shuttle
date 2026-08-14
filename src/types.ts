/** Provider-neutral conversation model used at every migration boundary. */

export type ExternalPlatform = 'codex' | 'claude-code' | 'pi' | 'reasonix' | 'opencode'
export type Platform = ExternalPlatform | 'dsh'
export type PortableRole = 'system' | 'user' | 'assistant' | 'tool'

export type PortableBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'tool-result'; toolCallId: string; content: string; isError?: boolean }

export interface PortableMessage {
  id: string
  role: PortableRole
  content: PortableBlock[]
  createdAt?: number
  provider?: string
  model?: string
}

export interface PortableConversation {
  version: 1
  id: string
  source: Platform
  title?: string
  cwd?: string
  createdAt: number
  updatedAt?: number
  messages: PortableMessage[]
  metadata?: Record<string, unknown>
}

export interface ParseContext {
  path?: string
  now?: number
}

export interface MigrationItem {
  sourceId: string
  source: Platform
  target: Platform
  status: 'planned' | 'written' | 'skipped' | 'failed'
  destination?: string
  messageCount: number
  warning?: string
}

export interface MigrationReport {
  dryRun: boolean
  startedAt: number
  finishedAt: number
  items: MigrationItem[]
  warnings: string[]
}

export interface ImportOptions {
  from: ExternalPlatform
  source?: string
  apply?: boolean
  limit?: number
  signal?: AbortSignal
}

export interface ExportOptions {
  to: ExternalPlatform
  sessionIds?: string[]
  destination?: string
  apply?: boolean
  signal?: AbortSignal
}

/** JSON-safe request accepted by the settings-page Remote API. */
export type ShuttleImportRequest = Omit<ImportOptions, 'signal'>

/** JSON-safe request accepted by the settings-page Remote API. */
export type ShuttleExportRequest = Omit<ExportOptions, 'signal'>
