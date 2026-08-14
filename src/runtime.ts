import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { adapters } from './adapters.ts'
import { fromDsh, toDsh } from './dsh.ts'
import { defaultSourceRoot, discoverFiles, pathExists, readBoundedText, writeNewFile } from './io.ts'
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    shuttle: ShuttleService
  }
}

/** Backend-neutral migration service registered as `ctx.shuttle`. */
export class ShuttleService extends TypertRemoteService {
  static inject = ['sessionPersistence']
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
      throw new Error('OpenCode import requires --source pointing to an `opencode export` JSON file or directory')
    }
    if (!await pathExists(root)) {
      throw new Error(`source path does not exist: ${root}`)
    }
    const requestedLimit = options.limit ?? this.config.maxSessions
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new Error('limit must be a positive safe integer')
    }
    const files = await discoverFiles(
      options.from,
      root,
      Math.min(requestedLimit, this.config.maxSessions),
      options.signal,
    )
    if (files.length === 0) warnings.push(`no ${options.from} session artifacts found under ${root}`)
    const existing = new Set((await this.ctx.sessionPersistence.list(options.signal)).map(header => String(header.id)))

    for (const path of files) {
      options.signal?.throwIfAborted()
      let conversations: PortableConversation[]
      try {
        const text = await readBoundedText(path, this.config.maxFileBytes)
        conversations = adapters[options.from].parse(text, { path })
      } catch (error) {
        items.push({
          sourceId: path, source: options.from, target: 'dsh', status: 'failed', messageCount: 0,
          warning: (error as Error).message,
        })
        continue
      }
      for (const value of conversations) {
        const materialized = toDsh(value)
        const targetId = String(materialized.header.id)
        if (value.messages.length === 0) {
          items.push({ sourceId: value.id, source: options.from, target: 'dsh', status: 'skipped',
            destination: targetId, messageCount: 0, warning: 'conversation contains no portable messages' })
          continue
        }
        if (existing.has(targetId)) {
          items.push({ sourceId: value.id, source: options.from, target: 'dsh', status: 'skipped',
            destination: targetId, messageCount: value.messages.length, warning: 'destination session already exists' })
          continue
        }
        if (dryRun) {
          items.push({ sourceId: value.id, source: options.from, target: 'dsh', status: 'planned',
            destination: targetId, messageCount: value.messages.length })
          continue
        }
        try {
          await this.ctx.sessionPersistence.create(materialized.header)
          await this.ctx.sessionPersistence.append(materialized.header.id, materialized.events)
          existing.add(targetId)
          items.push({ sourceId: value.id, source: options.from, target: 'dsh', status: 'written',
            destination: targetId, messageCount: value.messages.length })
        } catch (error) {
          items.push({ sourceId: value.id, source: options.from, target: 'dsh', status: 'failed',
            destination: targetId, messageCount: value.messages.length, warning: (error as Error).message })
        }
      }
    }
    return { dryRun, startedAt, finishedAt: Date.now(), items, warnings }
  }

  /** Preview or export DSH sessions as native artifacts accepted by the target tool. */
  async exportConversations(options: ExportOptions): Promise<MigrationReport> {
    const startedAt = Date.now()
    const dryRun = options.apply !== true
    const warnings: string[] = []
    const items: MigrationItem[] = []
    const root = options.destination ?? defaultSourceRoot(options.to) ?? join(cwd(), 'dsh-shuttle-exports')
    const requested = options.sessionIds === undefined ? undefined : new Set(options.sessionIds)
    const headers = await this.ctx.sessionPersistence.list(options.signal)
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
        const value = fromDsh(await this.ctx.sessionPersistence.inspect(SessionId(id), options.signal))
        const destination = adapters[options.to].destination(root, value)
        if (await pathExists(destination)) {
          items.push({ sourceId: id, source: 'dsh', target: options.to, status: 'skipped', destination,
            messageCount: value.messages.length, warning: 'destination file already exists' })
          continue
        }
        if (dryRun) {
          items.push({ sourceId: id, source: 'dsh', target: options.to, status: 'planned', destination,
            messageCount: value.messages.length })
          continue
        }
        await writeNewFile(destination, adapters[options.to].serialize(value))
        items.push({ sourceId: id, source: 'dsh', target: options.to, status: 'written', destination,
          messageCount: value.messages.length })
      } catch (error) {
        items.push({ sourceId: id, source: 'dsh', target: options.to, status: 'failed', messageCount: 0,
          warning: (error as Error).message })
      }
    }
    return { dryRun, startedAt, finishedAt: Date.now(), items, warnings }
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
