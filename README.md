# DSH Shuttle

**Compatibility**: DeepSeek Harness `0.2.3-alpha.2`, using Node.js `^24.22.3 || >=26.13.1`.

DSH Shuttle is a DeepSeek Harness plugin and CLI for conversation migration. It exchanges completed history
with Microsoft Agent Host Protocol (AHP) hosts and supports native files from
Codex, Claude Code, Pi, Reasonix, and OpenCode.

Every migration uses AHP settled chat history between its source and target adapters. The versioned snapshot index preserves source message identities, boundaries, and timestamps through offline conversions and DSH persistence. Text, reasoning, tool
calls/results, timestamps, working directory, and provider/model identity are
preserved where the target supports them.

## Safety

- Operations are dry runs unless `--apply` is present.
- Existing DSH IDs and destination files are skipped, never overwritten.
- Reads are size/count bounded and do not recurse through symlink directories.
- DSH writes use `ctx.sessionPersistence`, so JSONL and SQLite backends work.
- Shuttle reads OpenCode history through its official JSON export or a host bridge.
  It never edits the OpenCode database.

## Install

Install this package through the normal DSH plugin workflow. The bundled
`cordis.patch.yml` mounts `ctx.shuttle` and the `migrate-conversations` skill.
The plugin exports the standard `name`, `inject`, `Config`, and `apply` symbols.

## DSH interface

### Settings UI

Open **Settings → Conversation migration** to use two independent
import and export units without composing a command manually:

1. In **Import to DSH**, choose a source platform. For AHP, enter a host URL or a snapshot path.
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
/shuttle import ahp --source ws://127.0.0.1:8765
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

### Microsoft Agent Host Protocol

```bash
node lib/cli.js import --from ahp --source ws://127.0.0.1:8765
node lib/cli.js export --to ahp --session <id> --destination /tmp/dsh-ahp --apply
node lib/cli.js import --from ahp --source /tmp/dsh-ahp/<id>.ahp.json --apply
node lib/cli.js serve-ahp --session <id> --port 8765
```

Use `wss://` for a remote host. Shuttle negotiates AHP 1.1 or 1.0, reads the
session catalog, including existing Pi sessions advertised as `pi:/…`. Shuttle asks for the latest 50 completed turns, then follows older pages when the host provides a cursor. AHP transfer preserves text,
reasoning, and completed tool calls with text results. Live drafts, attachments,
and remote working directories stay on the source host. Choose a local workspace
directory in Settings or pass `--cwd` to import into that workspace. The
`/shuttle` command defaults to the current workspace for AHP imports. The JSON export bundles
AHP session and chat snapshots. `serve-ahp` exposes only explicitly selected
snapshots on loopback until you stop it. AHP clients can pull that history using
the standard read methods. The protocol has no general-purpose history upload
command. [Microsoft AHP reference](https://microsoft.github.io/agent-host-protocol/)

For Codex, Claude Code, Pi, Reasonix and OpenCode clients that use native session
files, `import --from <platform> --source <path>` converts the files through AHP.
Use `serve-ahp --from <platform> --source <path>` to expose the selected native
history as a read-only AHP endpoint and import it through the same paged protocol.

```bash
node lib/cli.js serve-ahp --from pi --source /path/to/session.jsonl --port 8765
node lib/cli.js import --from ahp --source ws://127.0.0.1:8765 --apply
```

The bridge reads a snapshot at startup and serves it in pages of up to 50
turns on request. Pass `--limit` with a directory to bound the session
selection. Pi uses the branch that it reopens from the saved file. For
Reasonix pass a session transcript JSONL, such as a file under `sessions/`.
The `sessions-v4` event store requires a Reasonix conversion to JSONL first.

### Bring native history into Fusion

Enable Shuttle and Fusion in the same DSH profile. Start the loopback bridge
above, then open a DSH conversation in the target workspace. Preview the
import and apply it after checking the source and destination.

```text
/shuttle import ahp --source ws://127.0.0.1:8765 --limit 1
/shuttle import ahp --source ws://127.0.0.1:8765 --limit 1 --apply
```

`/shuttle` puts the AHP import in the current workspace. For CLI imports,
select the target workspace with `--cwd /path/to/project`. Open an imported
conversation and select **Fuse conversations** in the header, or run `/fuse`
with the id of another imported conversation. [Fusion documentation](https://github.com/omdsh-dev/dsh-fusion/blob/main/README.md)

### OpenCode

For a one-off migration, export the native session and let Shuttle convert it to AHP
before writing to DSH.

```bash
opencode session export <session-id> > /tmp/opencode-session.json
node lib/cli.js import --from opencode --source /tmp/opencode-session.json --apply
```

OpenCode 1.x uses `opencode export <session-id>`. Shuttle can also write JSON
for `opencode import` in OpenCode 1.x.

For a live connection, configure an `opencode-ahp` bridge with history pagination
on the OpenCode host. OpenCode clients keep using their native sessions.

```bash
node lib/cli.js import --from ahp --source 'ws://127.0.0.1:8765/ahp?token=<token>' --cwd /path/to/project --apply
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
| `maxFileBytes` | 64 MiB | Maximum size of one external artifact or AHP chat history |
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
