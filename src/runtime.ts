import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { adapters } from './adapters.ts'
import { ahpConversionWarning, nativeAhpHistory, projectAhpHistory, readAhpArchive, type AhpHistory } from './ahp.ts'
import { ahpEndpoint, readAhpHost, type AhpImportEntry } from './ahp-client.ts'
import { dshSessionId, fromDsh, materializeCompleteTurns, materializeTextHistory, projectCompleteTurns, toDsh } from './dsh.ts'
import { readNativeArchives } from './native-history.ts'
import { defaultSourceRoot, discoverFiles, expandHome, pathExists, readBoundedText, writeNewFile } from './io.ts'
import { resolveConfig, type Config, type ResolvedConfig } from './config.ts'
import type {
  ExportOptions,
  ImportOptions,
  MigrationItem,
  MigrationReport,
  PortableConversation,
  ShuttleExportRequest,
  ShuttleImportRequest,
} from './types.ts'
import type {} from '@deepseek-ai/dsh-commands'
import { registerShuttleCommand } from './command.ts'

interface WorkspaceRegistry {
  list(): readonly {
    readonly path: string
    readonly sessionIds: readonly SessionId[]
    attachSession(sessionId: SessionId): Promise<void>
  }[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    shuttle: ShuttleService
  }
}

/** Backend-neutral migration service registered as `ctx.shuttle`. */
export class ShuttleService extends TypertRemoteService {
  static inject = ['sessionPersistence']
  /** Reusable, synchronous conversion for callers that own a new DSH history. */
  readonly materializeTextHistory = materializeTextHistory
  readonly projectCompleteTurns = projectCompleteTurns
  readonly materializeCompleteTurns = materializeCompleteTurns
  private readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'shuttle')
    this.config = resolveConfig(config)
  }

  /** Run an import preview or confirmed import without attaching it to a DSH conversation. */
  async import(request: ShuttleImportRequest, signal?: AbortSignal): Promise<MigrationReport> {
    return await this.importConversations({ ...request, ...(signal === undefined ? {} : { signal }) })
  }

  /** Run an export preview or confirmed export without attaching it to a DSH conversation. */
  async export(request: ShuttleExportRequest, signal?: AbortSignal): Promise<MigrationReport> {
    return await this.exportConversations({ ...request, ...(signal === undefined ? {} : { signal }) })
  }

  /** Preview or import external native artifacts into the configured DSH persistence backend. */
  async importConversations(options: ImportOptions): Promise<MigrationReport> {
    const startedAt = Date.now()
    const dryRun = options.apply !== true
    const warnings: string[] = []
    const items: MigrationItem[] = []
    const root = options.source ?? defaultSourceRoot(options.from)
    if (root === undefined) {
      throw new Error(options.from === 'ahp' ? 'AHP import requires --source with a WebSocket URL or snapshot path'
        : 'OpenCode import requires --source pointing to an opencode export JSON file or directory')
    }
    let targetCwd: string | undefined
    if (options.targetCwd !== undefined) {
      if (options.from !== 'ahp' || options.targetCwd.trim() === '') {
        throw new Error('A target workspace directory is only supported for AHP imports')
      }
      targetCwd = await realpath(expandHome(options.targetCwd))
      if (!(await stat(targetCwd)).isDirectory()) throw new Error('The target workspace must be a local directory')
    }
    const requestedLimit = options.limit ?? this.config.maxSessions
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new Error('limit must be a positive safe integer')
    }
    const limit = Math.min(requestedLimit, this.config.maxSessions)
    const endpoint = options.from === 'ahp' && /^wss?:\/\//iu.test(root) ? ahpEndpoint(root) : undefined
    const sources = endpoint === undefined
      ? this.readArtifacts(options.from, root, limit, options.signal)
      : readAhpHost(endpoint, limit, this.config.maxFileBytes, options.signal)
    const storageOptions = options.signal === undefined ? undefined : { signal: options.signal }
    const existing = new Map((await this.ctx.sessionPersistence.list(storageOptions)).map(({ header }) => [String(header.id), header]))
    const attachToWorkspace = async (id: SessionId, path: string): Promise<void> => {
      try {
        const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
        const workspace = registry?.list().find(item => item.path === path)
        if (workspace !== undefined && !workspace.sessionIds.includes(id)) await workspace.attachSession(id)
      } catch (error: unknown) {
        warnings.push(`Session ${id} was stored, but could not be added to the workspace: ${(error as Error).message}`)
      }
    }

    inputs: for await (const { sourceId, histories, warning } of sources) {
      options.signal?.throwIfAborted()
      if (items.length >= limit) break
      if (warning !== undefined) {
        items.push({ sourceId, source: options.from, target: 'dsh', status: 'failed', messageCount: 0, warning })
        continue
      }
      for (const history of histories) {
        if (items.length >= limit) break inputs
        let value: PortableConversation
        try {
          value = projectAhpHistory(history, options.from)
        } catch (error: unknown) {
          items.push({ sourceId, source: options.from, target: 'dsh', status: 'failed',
            messageCount: 0, warning: (error as Error).message })
          continue
        }
        const conversionWarning = ahpConversionWarning(history, 'dsh')
        const targetId = String(dshSessionId(value))
        if (value.messages.length === 0) {
          items.push({ sourceId: value.id, source: options.from, target: 'dsh', status: 'skipped',
            destination: targetId, messageCount: 0, warning: 'conversation contains no portable messages' })
          continue
        }
        const previous = existing.get(targetId)
        if (previous !== undefined) {
          if (!dryRun && targetCwd !== undefined && previous.cwd === targetCwd) {
            await attachToWorkspace(previous.id, targetCwd)
          }
          items.push({ sourceId: value.id, source: options.from, target: 'dsh', status: 'skipped',
            destination: targetId, messageCount: value.messages.length, warning: 'destination session already exists' })
          continue
        }
        try {
          const materialized = toDsh(targetCwd === undefined ? value : { ...value, cwd: targetCwd })
          if (dryRun) {
            items.push({ sourceId: value.id, source: options.from, target: 'dsh', status: 'planned',
              destination: targetId, messageCount: value.messages.length,
              ...(conversionWarning === undefined ? {} : { warning: conversionWarning }) })
            continue
          }
          const handle = await this.ctx.sessionPersistence.create(materialized.header, storageOptions)
          try {
            await handle.append(materialized.events, storageOptions)
            await handle.flush(storageOptions)
          } finally {
            await handle.close()
          }
          existing.set(targetId, materialized.header)
          if (targetCwd !== undefined) await attachToWorkspace(materialized.header.id, targetCwd)
          items.push({ sourceId: value.id, source: options.from, target: 'dsh', status: 'written',
            destination: targetId, messageCount: value.messages.length,
              ...(conversionWarning === undefined ? {} : { warning: conversionWarning }) })
        } catch (error) {
          items.push({ sourceId: value.id, source: options.from, target: 'dsh', status: 'failed',
            destination: targetId, messageCount: value.messages.length, warning: (error as Error).message })
        }
      }
    }
    if (items.length === 0) warnings.push(`no ${options.from} sessions were found`)
    return { dryRun, startedAt, finishedAt: Date.now(), items, warnings }
  }

  private async *readArtifacts(
    platform: ImportOptions['from'], root: string, limit: number, signal?: AbortSignal,
  ): AsyncGenerator<AhpImportEntry> {
    if (!await pathExists(expandHome(root))) throw new Error(`source path does not exist: ${root}`)
    for (const path of await discoverFiles(platform, root, limit, signal)) {
      signal?.throwIfAborted()
      try {
        const histories = platform === 'ahp'
          ? readAhpArchive(JSON.parse(await readBoundedText(path, this.config.maxFileBytes)))
          : (await readNativeArchives(platform, path, this.config.maxFileBytes)).flatMap(readAhpArchive)
        yield { sourceId: path, histories }
      } catch (error: unknown) {
        yield { sourceId: path, histories: [], warning: error instanceof Error ? error.message : String(error) }
      }
    }
  }

  /** Preview or export DSH sessions as native artifacts accepted by the target tool. */
  async exportConversations(options: ExportOptions): Promise<MigrationReport> {
    const startedAt = Date.now()
    const dryRun = options.apply !== true
    const warnings: string[] = []
    const items: MigrationItem[] = []
    const root = options.destination ?? defaultSourceRoot(options.to) ?? join(cwd(), 'dsh-shuttle-exports')
    const requested = options.sessionIds === undefined ? undefined : new Set(options.sessionIds)
    const storageOptions = options.signal === undefined ? undefined : { signal: options.signal }
    const headers = (await this.ctx.sessionPersistence.list(storageOptions)).map(item => item.header)
    const selected = requested === undefined
      ? headers.slice(0, this.config.maxSessions)
      : headers.filter(header => requested.has(String(header.id)))
    if (requested !== undefined) {
      for (const id of requested) {
        if (!selected.some(header => String(header.id) === id)) warnings.push(`DSH session not found: ${id}`)
      }
    }
    for (const header of selected) {
      options.signal?.throwIfAborted()
      const id = String(header.id)
      try {
        const history = await this.readAhpHistory(SessionId(id), options.signal)
        const value = projectAhpHistory(history)
        const warning = ahpConversionWarning(history, options.to)
        const destination = adapters[options.to].destination(root, value)
        if (await pathExists(destination)) {
          items.push({ sourceId: id, source: 'dsh', target: options.to, status: 'skipped', destination,
            messageCount: value.messages.length, warning: 'destination file already exists' })
          continue
        }
        const encoded = adapters[options.to].serialize(value)
        if (Buffer.byteLength(encoded) > this.config.maxFileBytes) throw new Error('Export exceeds the configured size limit')
        if (dryRun) {
          items.push({ sourceId: id, source: 'dsh', target: options.to, status: 'planned', destination,
            messageCount: value.messages.length, ...(warning === undefined ? {} : { warning }) })
          continue
        }
        await writeNewFile(destination, encoded)
        items.push({ sourceId: id, source: 'dsh', target: options.to, status: 'written', destination,
          messageCount: value.messages.length, ...(warning === undefined ? {} : { warning }) })
      } catch (error) {
        items.push({ sourceId: id, source: 'dsh', target: options.to, status: 'failed', messageCount: 0,
          warning: (error as Error).message })
      }
    }
    return { dryRun, startedAt, finishedAt: Date.now(), items, warnings }
  }

  async readAhpHistory(id: SessionId, signal?: AbortSignal): Promise<AhpHistory> {
    return nativeAhpHistory(await this.readConversation(id, signal))
  }

  /** Read one committed DSH history through a backend-neutral storage handle. */
  async readConversation(id: SessionId, signal?: AbortSignal): Promise<PortableConversation> {
    const options = signal === undefined ? undefined : { signal }
    const handle = await this.ctx.sessionPersistence.open(id, 'read', options)
    try {
      const { events } = await handle.read(undefined, undefined, options)
      const inspection: SessionInspection = { meta: handle.header, inheritedEventCount: handle.inheritedEventCount, events }
      return fromDsh(inspection, true)
    } finally {
      await handle.close()
    }
  }

}

/**
 * Register Remote markers without decorator syntax so the package also runs in
 * test/build pipelines that parse TypeScript without a decorator transform.
 */
function exposeRemote(method: 'import' | 'export'): void {
  const initializers: Array<(this: ShuttleService) => void> = []
  const implementation = ShuttleService.prototype[method]
  const context = {
    private: false,
    static: false,
    name: method,
    addInitializer(initializer: (this: ShuttleService) => void): void { initializers.push(initializer) },
  } as unknown as ClassMethodDecoratorContext<ShuttleService, typeof implementation>
  Remote(method)(implementation as never, context as never)
  const markerTarget = Object.create(ShuttleService.prototype) as ShuttleService
  for (const initialize of initializers) initialize.call(markerTarget)
}

exposeRemote('import')
exposeRemote('export')

/** Mount the migration service. */
export function apply(ctx: Context, config: Config = {}): void {
  const shuttle = new ShuttleService(ctx, config)
  ctx.inject(['commands'], commandCtx => registerShuttleCommand(commandCtx, shuttle))
}
