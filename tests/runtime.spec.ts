import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adapters } from '../src/adapters.ts'
import { ShuttleService } from '../src/runtime.ts'
import { SHUTTLE_REMOTE_DESCRIPTORS } from '../src/remote.ts'
import { apply } from '../src/runtime.ts'
import type { PortableConversation } from '../src/types.ts'

const cleanup: string[] = []

afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('ShuttleService', () => {
  it('exposes import and export as conversation-independent Remote methods', () => {
    const ctx = new Context()
    const shuttle = new ShuttleService(ctx)
    expect(remoteMethods(shuttle)).toEqual([
      { method: 'import', invocation: { kind: 'direct' } },
      { method: 'export', invocation: { kind: 'direct' } },
    ])
    expect(SHUTTLE_REMOTE_DESCRIPTORS.map(descriptor => descriptor.method)).toEqual(['import', 'export'])
  })

  it('registers /shuttle when the interactive command service is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-shuttle-command-'))
    cleanup.push(root)
    const ctx = new Context()
    const store = await ctx.plugin(SessionStore)
    const persistence = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const commands = await ctx.plugin(CommandRuntime)
    try {
      apply(ctx)
      await new Promise(resolve => setTimeout(resolve, 0))
      const agent = { session: ctx.sessions.create('command-agent' as never) }
      expect(ctx.commands.find(agent as never, 'shuttle')).toMatchObject({
        name: 'shuttle',
        input: { hint: '<import|export> <platform> [options]' },
      })
    } finally {
      await commands.dispose()
      await persistence.dispose()
      await store.dispose()
    }
  })

  it('previews, imports, refuses duplicates, and exports through real JSONL persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-shuttle-'))
    cleanup.push(root)
    const source = join(root, 'source.jsonl')
    const dshRoot = join(root, 'dsh')
    const output = join(root, 'out')
    const fixture: PortableConversation = {
      version: 1, id: 'integration', source: 'dsh', cwd: '/tmp/project', createdAt: 1000,
      messages: [
        { id: 'u', role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      ],
    }
    await writeFile(source, adapters.codex.serialize(fixture), 'utf8')

    const ctx = new Context()
    const store = await ctx.plugin(SessionStore)
    const persistence = await ctx.plugin(JsonlSessionPersistence, { root: dshRoot, compression: 'none' })
    const shuttle = new ShuttleService(ctx)
    try {
      const preview = await shuttle.importConversations({ from: 'codex', source })
      expect(preview.dryRun).toBe(true)
      expect(preview.items[0]?.status).toBe('planned')
      expect(await ctx.sessionPersistence.list()).toHaveLength(0)

      const imported = await shuttle.importConversations({ from: 'codex', source, apply: true })
      expect(imported.items[0]?.status).toBe('written')
      const [header] = await ctx.sessionPersistence.list()
      expect(header).toBeDefined()

      const duplicate = await shuttle.importConversations({ from: 'codex', source, apply: true })
      expect(duplicate.items[0]?.status).toBe('skipped')

      const exported = await shuttle.exportConversations({
        to: 'pi', sessionIds: [String(header!.header.id)], destination: output, apply: true,
      })
      expect(exported.items[0]?.status).toBe('written')
      const text = await readFile(exported.items[0]!.destination!, 'utf8')
      expect(adapters.pi.parse(text)[0]?.messages).toHaveLength(2)
    } finally {
      await persistence.dispose()
      await store.dispose()
    }
  })
})
