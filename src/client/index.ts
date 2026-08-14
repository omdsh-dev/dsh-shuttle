import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import TYPERT_REMOTE from '../remote.ts'
import { renderReport } from '../command.ts'
import type { MigrationReport, ShuttleExportRequest, ShuttleImportRequest } from '../types.ts'
import { ShuttleSettingsSection, type ShuttleSettingsInjected } from './ShuttleSettingsTab.tsx'
import { en, zh, type ShuttleLocaleKey } from './locales.ts'
import { SHUTTLE_STYLES } from './styles.ts'

export type { ShuttleSettingsInjected, ShuttleSettingsSectionProps } from './ShuttleSettingsTab.tsx'
export { buildShuttleLine, quoteShuttleArgument } from './command.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.shuttle': ShuttleLocaleKey
  }
}

export const NS = 'settings.shuttle'
export const inject = ['slots', 'locale', 'remote']

/** Register Shuttle as a first-class localized section in the Settings sidebar. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  type Result<T> = { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'shuttle-ui: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = '@deepseek-ai/dsh-shuttle'
    tag.dataset.pluginCss = '@deepseek-ai/dsh-shuttle/settings'
    tag.textContent = SHUTTLE_STYLES
    document.head.append(tag)
    return () => { tag.remove() }
  }, 'shuttle-ui: styles')

  const toUiResult = (report: MigrationReport): Awaited<ReturnType<ShuttleSettingsInjected['importConversations']>> => ({
    kind: report.items.some(item => item.status === 'failed') ? 'error' : 'success',
    text: renderReport(report),
  })
  ctx.inject(['remote.shuttle'], (remoteCtx) => {
    const shuttleRemote = remoteCtx.remote as typeof remoteCtx.remote & {
      shuttle: {
        import: (request: ShuttleImportRequest) => Promise<Result<MigrationReport>>
        export: (request: ShuttleExportRequest) => Promise<Result<MigrationReport>>
      }
    }
    const injected: ShuttleSettingsInjected = {
      importConversations: async request => {
        const result = await shuttleRemote.shuttle.import(request)
        if (!result.ok) throw new Error(`shuttle.import failed: ${result.error.code}: ${result.error.message}`)
        return toUiResult(result.value)
      },
      exportConversations: async request => {
        const result = await shuttleRemote.shuttle.export(request)
        if (!result.ok) throw new Error(`shuttle.export failed: ${result.error.code}: ${result.error.message}`)
        return toUiResult(result.value)
      },
    }

    remoteCtx.slots.inject('settings.section', () => remoteCtx.slots.register({
      name: 'settings.section',
      id: 'shuttle',
      order: 17,
      label: () => t('nav'),
      locale: NS,
      inject: (): ShuttleSettingsInjected => injected,
    }, ShuttleSettingsSection))
  })

  return disposeRemote
}
