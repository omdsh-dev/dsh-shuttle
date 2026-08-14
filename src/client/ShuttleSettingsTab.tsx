import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShuttleExportRequest, ShuttleImportRequest } from '../types.ts'
import type { ShuttleLocaleKey } from './locales.ts'

export interface ShuttleSettingsInjected {
  importConversations: (request: ShuttleImportRequest) => Promise<ShuttleUiResult>
  exportConversations: (request: ShuttleExportRequest) => Promise<ShuttleUiResult>
}

export type ShuttleUiResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

export type ShuttleSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.shuttle'>
  & InjectFace<ShuttleSettingsInjected>

interface DisplayResult {
  kind: ShuttleUiResult['kind']
  text: string
  mode: 'preview' | 'apply'
  signature: string
}

interface SessionOption {
  id: SessionId
  title: string
}

const PLATFORMS: readonly { value: ShuttleImportRequest['from']; label: ShuttleLocaleKey }[] = [
  { value: 'codex', label: 'platformCodex' },
  { value: 'claude-code', label: 'platformClaude' },
  { value: 'pi', label: 'platformPi' },
  { value: 'reasonix', label: 'platformReasonix' },
  { value: 'opencode', label: 'platformOpencode' },
]

function useMigrationRun(
  signature: string,
  operation: (apply: boolean) => Promise<ShuttleUiResult>,
  t: (key: ShuttleLocaleKey) => string,
): {
    pending: 'preview' | 'apply' | undefined
    result: DisplayResult | undefined
    previewReady: boolean
    confirmed: boolean
    setConfirmed: (value: boolean) => void
    run: (mode: 'preview' | 'apply') => Promise<void>
  } {
  const [result, setResult] = useState<DisplayResult | undefined>()
  const [pending, setPending] = useState<'preview' | 'apply' | undefined>()
  const [confirmedSignature, setConfirmedSignature] = useState<string | undefined>()
  const request = useRef(0)
  const previewReady = result?.mode === 'preview' && result.kind === 'success' && result.signature === signature

  const run = async (mode: 'preview' | 'apply'): Promise<void> => {
    if (pending !== undefined) return
    const currentRequest = ++request.current
    setPending(mode)
    try {
      const commandResult = await operation(mode === 'apply')
      if (request.current !== currentRequest) return
      setResult({
        kind: commandResult.kind,
        text: commandResult.text ?? (commandResult.kind === 'success' ? t('ready') : t('commandFailed')),
        mode,
        signature,
      })
      if (mode === 'apply') setConfirmedSignature(undefined)
    } catch (error) {
      if (request.current !== currentRequest) return
      setResult({
        kind: 'error',
        text: error instanceof Error ? error.message : t('commandFailed'),
        mode,
        signature,
      })
    } finally {
      if (request.current === currentRequest) setPending(undefined)
    }
  }

  return {
    pending,
    result,
    previewReady,
    confirmed: confirmedSignature === signature,
    setConfirmed: value => { setConfirmedSignature(value ? signature : undefined) },
    run,
  }
}

function Result({ result, signature, t }: {
  result: DisplayResult | undefined
  signature: string
  t: (key: ShuttleLocaleKey) => string
}): ReactNode {
  if (result === undefined || result.signature !== signature) return null
  return (
    <div className="dsh-shuttle__result" data-kind={result.kind} role="status" aria-live="polite">
      <div className="dsh-shuttle__result-header">
        <strong>{t(result.mode === 'preview' ? 'previewTitle' : 'runTitle')}</strong>
        <span className="dsh-shuttle__badge">{result.kind}</span>
      </div>
      <pre>{result.text}</pre>
    </div>
  )
}

function Confirmation({ confirmed, pending, label, action, onConfirm, onApply, t }: {
  confirmed: boolean
  pending: 'preview' | 'apply' | undefined
  label: string
  action: string
  onConfirm: (value: boolean) => void
  onApply: () => void
  t: (key: ShuttleLocaleKey) => string
}): ReactNode {
  return (
    <div className="dsh-shuttle__confirm">
      <p>{t('ready')}</p>
      <label>
        <input type="checkbox" checked={confirmed} onChange={event => { onConfirm(event.currentTarget.checked) }} />
        <span>{label}</span>
      </label>
      <div className="dsh-shuttle__actions">
        <button
          className="dsh-shuttle__button dsh-shuttle__button--primary"
          type="button"
          disabled={!confirmed || pending !== undefined}
          onClick={onApply}
        >
          {pending === 'apply' ? t('applying') : action}
        </button>
      </div>
    </div>
  )
}

function ImportUnit({ importConversations, t }: Pick<ShuttleSettingsSectionProps, 'importConversations' | 't'>): ReactNode {
  const [platform, setPlatform] = useState<ShuttleImportRequest['from']>('codex')
  const [source, setSource] = useState('')
  const [limit, setLimit] = useState('')
  const limitValid = limit.trim() === '' || (Number.isSafeInteger(Number(limit)) && Number(limit) > 0)
  const signature = JSON.stringify({ platform, source, limit })
  const controller = useMigrationRun(signature, async apply => await importConversations({
    from: platform,
    ...(source.trim() === '' ? {} : { source: source.trim() }),
    ...(limit.trim() === '' ? {} : { limit: Number(limit) }),
    ...(apply ? { apply: true } : {}),
  }), t)

  const preview = (event: FormEvent): void => {
    event.preventDefault()
    if (limitValid) void controller.run('preview')
  }

  return (
    <section className="dsh-shuttle-unit" aria-labelledby="dsh-shuttle-import-title">
      <div className="dsh-shuttle-unit__header">
        <span className="dsh-shuttle-unit__index">1</span>
        <div><h3 id="dsh-shuttle-import-title">{t('importUnitTitle')}</h3><p>{t('importUnitDescription')}</p></div>
      </div>
      <form className="dsh-shuttle__form" onSubmit={preview}>
        <div className="dsh-shuttle__grid">
          <label className="dsh-shuttle__field">
            <span>{t('platform')}</span>
            <select value={platform} onChange={event => { setPlatform(event.currentTarget.value as ShuttleImportRequest['from']) }}>
              {PLATFORMS.map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
            </select>
          </label>
          <label className="dsh-shuttle__field">
            <span>{t('limit')}</span>
            <input type="number" inputMode="numeric" min={1} step={1} value={limit} placeholder={t('limitPlaceholder')} aria-invalid={!limitValid} onChange={event => { setLimit(event.currentTarget.value) }} />
          </label>
          <label className="dsh-shuttle__field dsh-shuttle__field--wide">
            <span>{t('source')}</span>
            <input type="text" value={source} spellCheck={false} placeholder={t('sourcePlaceholder')} onChange={event => { setSource(event.currentTarget.value) }} />
          </label>
        </div>
        {!limitValid ? <p className="dsh-shuttle__validation" role="alert">{t('invalidLimit')}</p> : null}
        <div className="dsh-shuttle__actions">
          <button className="dsh-shuttle__button" type="submit" disabled={controller.pending !== undefined || !limitValid}>
            {controller.pending === 'preview' ? t('previewing') : t('previewImport')}
          </button>
        </div>
        <Result result={controller.result} signature={signature} t={t} />
        {controller.previewReady ? <Confirmation
          confirmed={controller.confirmed}
          pending={controller.pending}
          label={t('confirmImport')}
          action={t('applyImport')}
          onConfirm={controller.setConfirmed}
          onApply={() => { void controller.run('apply') }}
          t={t}
        /> : null}
      </form>
    </section>
  )
}

function ExportUnit({ exportConversations, sessions, current, t }: Pick<ShuttleSettingsSectionProps, 'exportConversations' | 't'> & {
  sessions: readonly SessionOption[]
  current: SessionId | undefined
}): ReactNode {
  const [platform, setPlatform] = useState<ShuttleExportRequest['to']>('codex')
  const [destination, setDestination] = useState('')
  const [all, setAll] = useState(false)
  const [selectedSession, setSelectedSession] = useState<SessionId | undefined>()
  const sessionId = selectedSession !== undefined && sessions.some(session => session.id === selectedSession)
    ? selectedSession
    : current ?? sessions[0]?.id
  const canRun = all || sessionId !== undefined
  const signature = JSON.stringify({ platform, destination, all, sessionId })
  const controller = useMigrationRun(signature, async apply => await exportConversations({
    to: platform,
    ...(all ? {} : { sessionIds: sessionId === undefined ? [] : [String(sessionId)] }),
    ...(destination.trim() === '' ? {} : { destination: destination.trim() }),
    ...(apply ? { apply: true } : {}),
  }), t)

  const preview = (event: FormEvent): void => {
    event.preventDefault()
    if (canRun) void controller.run('preview')
  }

  return (
    <section className="dsh-shuttle-unit" aria-labelledby="dsh-shuttle-export-title">
      <div className="dsh-shuttle-unit__header">
        <span className="dsh-shuttle-unit__index">2</span>
        <div><h3 id="dsh-shuttle-export-title">{t('exportUnitTitle')}</h3><p>{t('exportUnitDescription')}</p></div>
      </div>
      <form className="dsh-shuttle__form" onSubmit={preview}>
        <div className="dsh-shuttle__grid">
          <label className="dsh-shuttle__field">
            <span>{t('exportPlatform')}</span>
            <select value={platform} onChange={event => { setPlatform(event.currentTarget.value as ShuttleExportRequest['to']) }}>
              {PLATFORMS.map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
            </select>
          </label>
          <label className="dsh-shuttle__field">
            <span>{t('task')}</span>
            <select value={sessionId ?? ''} disabled={all || sessions.length === 0} onChange={event => { setSelectedSession(event.currentTarget.value as SessionId) }}>
              {sessions.length === 0 ? <option value="">{t('noTask')}</option> : null}
              {sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}
            </select>
          </label>
          <label className="dsh-shuttle__field dsh-shuttle__field--wide">
            <span>{t('destination')}</span>
            <input type="text" value={destination} spellCheck={false} placeholder={t('destinationPlaceholder')} onChange={event => { setDestination(event.currentTarget.value) }} />
          </label>
          <fieldset className="dsh-shuttle__scope dsh-shuttle__field--wide">
            <legend>{t('exportScope')}</legend>
            <div className="dsh-shuttle__scope-options">
              <label><input type="radio" name="shuttle-export-scope" checked={!all} onChange={() => { setAll(false) }} />{t('currentTask')}</label>
              <label><input type="radio" name="shuttle-export-scope" checked={all} onChange={() => { setAll(true) }} />{t('allTasks')}</label>
            </div>
          </fieldset>
        </div>
        {!canRun ? <p className="dsh-shuttle__validation" role="alert">{t('noSession')}</p> : null}
        <div className="dsh-shuttle__actions">
          <button className="dsh-shuttle__button" type="submit" disabled={controller.pending !== undefined || !canRun}>
            {controller.pending === 'preview' ? t('previewing') : t('previewExport')}
          </button>
        </div>
        <Result result={controller.result} signature={signature} t={t} />
        {controller.previewReady ? <Confirmation
          confirmed={controller.confirmed}
          pending={controller.pending}
          label={t('confirmExport')}
          action={t('applyExport')}
          onConfirm={controller.setConfirmed}
          onApply={() => { void controller.run('apply') }}
          t={t}
        /> : null}
      </form>
    </section>
  )
}

/** First-class Settings section with independent import and export units. */
export function ShuttleSettingsSection({ importConversations, exportConversations, t, useSessions }: ShuttleSettingsSectionProps): ReactNode {
  const sessionState = useSessions(state => ({ ids: state.ids, byId: state.byId, current: state.current }))
  const sessions = sessionState.ids.map(id => ({ id, title: sessionState.byId[id]?.displayTitle ?? id }))

  return (
    <section className="dsh-shuttle dsh-shuttle-section" data-shuttle-ui aria-labelledby="dsh-shuttle-title">
      <header className="dsh-shuttle-section__header">
        <h2 id="dsh-shuttle-title">{t('title')}</h2>
        <p>{t('description')}</p>
      </header>
      <div className="dsh-shuttle__units">
        <ImportUnit importConversations={importConversations} t={t} />
        <ExportUnit exportConversations={exportConversations} sessions={sessions} current={sessionState.current} t={t} />
      </div>
    </section>
  )
}
