---
name: migrate-conversations
description: Safely preview and migrate coding-agent conversation history between DeepSeek Harness (DSH) and Codex, Claude Code, Pi, Reasonix, or OpenCode. Use when a user wants to import, export, move, copy, back up, or convert agent transcripts involving DSH.
---

# Migrate Conversations

Use the bundled `dsh-shuttle` CLI. Treat source records as read-only and never
invent a destructive cleanup step.

Inside an interactive DSH UI, prefer the equivalent `/shuttle` command so the
preview and final report remain visible to the user. Use the CLI when the UI
command service is unavailable.

## Workflow

1. Identify the direction, platform, source or destination path, and optional
   DSH session IDs. Supported values are `codex`, `claude-code`, `pi`,
   `reasonix`, and `opencode`.
2. Run the command without `--apply`. Present planned, skipped, and failed
   counts plus every warning.
3. Verify the intended DSH root. The default is `$DSH_HOME/sessions`, falling
   back to `~/.dsh/sessions`.
4. Only after the user confirms the preview, repeat the exact command with
   `--apply`.
5. Read the final JSON report. Report written destinations, skips, and failures;
   do not infer success from process exit alone.

## Commands

Import to DSH:

```bash
dsh-shuttle import --from <platform> [--source <path>] [--dsh-root <path>]
dsh-shuttle import --from <platform> [same options] --apply
```

Export from DSH:

```bash
dsh-shuttle export --to <platform> [--session <id>] [--destination <path>]
dsh-shuttle export --to <platform> [same options] --apply
```

Repeat `--session` to select several DSH sessions. Omit it to select all up to
the configured limit.

## Platform handling

- Codex, Claude Code, Pi, and Reasonix can use their conventional default roots.
  Prefer explicit paths when multiple installations or profiles exist.
- OpenCode import requires JSON created by `opencode export <id>`.
- DSH-to-OpenCode produces official interchange JSON. Run
  `opencode import <file>` afterward; never edit `opencode.db`.
- After writing Reasonix JSONL, suggest `reasonix sessions reindex` only if the
  session is absent from its catalog.

## Safety and fidelity

- Absence of `--apply` is the dry-run boundary. Do not bypass it.
- Shuttle never overwrites a target. A skip is not a successful copy.
- Never delete source sessions unless the user separately requests deletion.
- Explain that images may become placeholders and provider-private replay/cache
  state is not portable.
- Codex and Claude Code formats may change. On parse failure, preserve the file,
  report its path and error, and do not manually rewrite the source.
