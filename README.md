# DSH Shuttle

DSH Shuttle is a DeepSeek Harness plugin and offline CLI for bidirectional
conversation migration between DSH and Codex, Claude Code, Pi, Reasonix, or
OpenCode.

Every source is projected into a provider-neutral model before conversion to
DSH events or the target's native import format. Text, reasoning, tool
calls/results, timestamps, working directory, and provider/model identity are
preserved where the target supports them.

## Safety

- Operations are dry runs unless `--apply` is present.
- Existing DSH IDs and destination files are skipped, never overwritten.
- Reads are size/count bounded and do not recurse through symlink directories.
- DSH writes use `ctx.sessionPersistence`, so JSONL and SQLite backends work.
- OpenCode's database is never edited directly; Shuttle uses its official
  export/import JSON envelope.

## Install

Install this package through the normal DSH plugin workflow. The bundled
`cordis.patch.yml` mounts `ctx.shuttle` and the `migrate-conversations` skill.
The plugin exports the standard `name`, `inject`, `Config`, and `apply` symbols.

## DSH interface

### Settings UI

Open **Settings → Conversation migration** to use two independent
import and export units without composing a command manually:

1. In **Import to DSH**, choose a source platform and optionally set a source path and limit.
2. In **Export from DSH**, choose a target platform, DSH task, destination, and scope.
3. Preview each unit independently. Settings previews use a dedicated Remote API and never create DSH
   conversations or write destination files.
4. Review that unit's report, check its confirmation, and run the import or export.

The execution button is only available after a successful preview of the
current form. Changing any migration input invalidates that preview.

### Slash command

When the interactive DSH command service is present, type `/shuttle` in the
conversation input to see help. The command result is shown directly in the UI
and is not sent to the model.

```text
/shuttle import codex
/shuttle import codex --source "~/.codex/sessions" --apply
/shuttle export pi --destination "~/.pi/agent/sessions"
/shuttle export opencode --session <id> --destination /tmp/opencode --apply
```

Import and export are previews unless `--apply` is supplied. Export defaults to
the current UI session; pass repeated `--session` flags or `--all` to change the
selection.

## CLI

Build with `pnpm build`, then preview an import:

```bash
node lib/cli.js import --from codex
node lib/cli.js import --from claude-code --source ~/.claude/projects
node lib/cli.js import --from pi --source ~/.pi/agent/sessions
node lib/cli.js import --from reasonix --source ~/.reasonix
```

Review the JSON report and repeat with `--apply`. The default DSH store is
`$DSH_HOME/sessions` or `~/.dsh/sessions`; override it with `--dsh-root`.

Export one or all DSH sessions:

```bash
node lib/cli.js export --to codex --session <id> --destination ~/.codex/sessions --apply
node lib/cli.js export --to pi --destination ~/.pi/agent/sessions --apply
node lib/cli.js export --to reasonix --destination ~/.reasonix --apply
```

Repeat `--session` to select multiple sessions. Omitting it exports up to the
configured `maxSessions`.

### OpenCode

```bash
opencode export <session-id> > /tmp/opencode-session.json
node lib/cli.js import --from opencode --source /tmp/opencode-session.json --apply

node lib/cli.js export --to opencode --session <dsh-session-id> \
  --destination /tmp/dsh-opencode --apply
opencode import /tmp/dsh-opencode/<dsh-session-id>.opencode.json
```

For Reasonix, run `reasonix sessions reindex` if its catalog does not show a
newly written authoritative JSONL session.

## Plugin API

```ts
const preview = await ctx.shuttle.importConversations({
  from: 'codex',
  source: '/path/to/.codex/sessions',
})

await ctx.shuttle.importConversations({
  from: 'codex',
  source: '/path/to/.codex/sessions',
  apply: true,
})

await ctx.shuttle.exportConversations({
  to: 'claude-code',
  sessionIds: ['session-id'],
  destination: '/path/to/.claude/projects',
  apply: true,
})
```

Configuration:

| Field | Default | Meaning |
| --- | ---: | --- |
| `maxFileBytes` | 64 MiB | Maximum size of one external artifact |
| `maxSessions` | 500 | Maximum artifacts/sessions per operation |

## Limitations

- Codex and Claude Code do not promise a stable public on-disk transcript
  schema. Their readers are tolerant, but preview again after upgrades.
- Binary/image attachments become text placeholders when referenced bytes
  cannot be safely copied.
- Provider-private replay state, cache data, UI-only events, token chunks, and
  database indexes are not portable.
- Exported Codex/Claude JSONL matches currently observed envelopes; future
  clients may require an explicit importer or adapter update.
- Shuttle never deletes source history.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm run validate:skill
```
