# DSH Shuttle

**兼容版本**：DeepSeek Harness `0.2.3-alpha.2`，使用 Node.js `^24.22.3 || >=26.13.1`。

DSH Shuttle 是一个 DeepSeek Harness 插件和命令行工具，通过 Microsoft Agent Host Protocol（AHP）交换已完成的会话历史，也支持 Codex、Claude Code、Pi、Reasonix 和 OpenCode 原生文件。

所有迁移都以 AHP 的已结束会话历史为中间格式，再写成 DSH 事件或目标工具可读取的原生格式。快照的版本化来源索引保留源消息身份、边界和时间。写入 DSH 时也会保存来源索引。目标支持时，会保留文本、推理、工具调用/结果、时间戳、工作目录、
模型和供应商信息。

## 安全约定

- 默认只预演；只有显式传入 `--apply` 才写入。
- 已存在的 DSH 会话 ID 或目标文件只会跳过，绝不覆盖。
- 外部文件有大小和数量上限，不递归跟随符号链接。
- 写入 DSH 始终调用 `ctx.sessionPersistence`，兼容 JSONL 和 SQLite。
- OpenCode 通过官方 JSON 导出或桥接插件读取历史，不修改数据库。

## DSH 界面命令

### 设置页

打开 **设置 → 对话迁移**，可以在两个互不影响的单元中完成双向迁移：

1. 在“导入到 DSH”中选择来源平台。使用 AHP 时，需要填写宿主地址或快照路径。
2. 在“从 DSH 导出”中选择目标平台、DSH 任务、目标路径和范围。
3. 分别预览；设置页预览通过独立接口执行，不会创建 DSH 对话或写入目标文件。
4. 检查对应单元的报告、勾选确认，再执行导入或导出。

界面支持 AHP、Codex、Claude Code、Pi、Reasonix 和 OpenCode。执行按钮只有在当前表单
完成一次成功预览后才会出现；修改该单元的任何迁移参数都会让旧预览失效。

### 斜杠命令

交互式 DSH 组合加载插件后，可直接在对话输入框输入 `/shuttle` 查看帮助。结果只在
界面显示，不会作为消息发送给模型。

```text
/shuttle import ahp --source ws://127.0.0.1:8765
/shuttle import codex
/shuttle import codex --source "~/.codex/sessions" --apply
/shuttle export pi --destination "~/.pi/agent/sessions"
/shuttle export opencode --session <会话ID> --destination /tmp/opencode --apply
```

没有 `--apply` 时只预演。导出默认选择当前界面会话，也可以重复使用 `--session`
或通过 `--all` 选择全部会话。

## 命令行

先执行 `pnpm build`。预演导入：

```bash
node lib/cli.js import --from codex
node lib/cli.js import --from claude-code --source ~/.claude/projects
node lib/cli.js import --from pi --source ~/.pi/agent/sessions
node lib/cli.js import --from reasonix --source ~/.reasonix
```

检查 JSON 报告后，加 `--apply` 执行。默认 DSH 路径是
`$DSH_HOME/sessions` 或 `~/.dsh/sessions`，可用 `--dsh-root` 覆盖。

从 DSH 导出：

```bash
node lib/cli.js export --to codex --session <会话ID> --destination ~/.codex/sessions --apply
node lib/cli.js export --to pi --destination ~/.pi/agent/sessions --apply
node lib/cli.js export --to reasonix --destination ~/.reasonix --apply
```

重复传 `--session` 可以选择多个会话；省略时最多导出 `maxSessions` 个。

### Microsoft Agent Host Protocol

```bash
node lib/cli.js import --from ahp --source ws://127.0.0.1:8765
node lib/cli.js export --to ahp --session <id> --destination /tmp/dsh-ahp --apply
node lib/cli.js import --from ahp --source /tmp/dsh-ahp/<id>.ahp.json --apply
node lib/cli.js serve-ahp --session <id> --port 8765
```

远端宿主使用 `wss://`。Shuttle 协商 AHP 1.1 或 1.0，读取会话目录，包括以 `pi:/…` 发布的既有 Pi 会话。Shuttle 请求最近 50 个已结束回合，宿主返回游标时再分页读取更早的回合。迁移保留文本、推理、已完成的工具调用及其文本结果。草稿、附件和远端工作目录留在源宿主。可在设置中填写目标 DSH 工作区目录，或在导入命令中使用 `--cwd`。`/shuttle` 导入 AHP 时默认使用当前工作区。

导出的 JSON 文件包含 AHP 会话和对话快照。`serve-ahp` 在本机回环地址提供显式选定的快照，AHP 客户端可用标准读取方法拉取。停止命令即可关闭端点。协议没有通用的历史上传命令。[Microsoft AHP 规范](https://microsoft.github.io/agent-host-protocol/)

Codex、Claude Code、Pi、Reasonix 和 OpenCode 使用各自的原生会话格式。
一次性迁移可用 `import --from <平台> --source <路径>` 直接导入，由 Shuttle 在内部转换为 AHP。
也可以把明确选定的文件或目录作为本机只读 AHP 端点提供给其他客户端。

```bash
node lib/cli.js serve-ahp --from pi --source /path/to/session.jsonl --port 8765
node lib/cli.js import --from ahp --source ws://127.0.0.1:8765 --apply
```

桥接在启动时读取快照，按请求提供每页最多 50 个回合。选择目录时可用 `--limit` 限制会话数。
Pi 导入重新打开会话时所选的已保存分支。Reasonix 可直接读取 `sessions/` 下的会话 JSONL；
`sessions-v4` 事件存储需先由 Reasonix 转成 JSONL。

### 将原生历史带入 Fusion

在同一个 DSH profile 启用 Shuttle 和 Fusion。在 Shuttle 的命令行启动上面的本机桥接后，
打开目标工作区中的 DSH 会话。预演导入，确认来源和目标后再执行。

```text
/shuttle import ahp --source ws://127.0.0.1:8765 --limit 1
/shuttle import ahp --source ws://127.0.0.1:8765 --limit 1 --apply
```

`/shuttle` 会将 AHP 历史导入当前工作区。使用 CLI 时，可用 `--cwd /path/to/project`
指定目标工作区。打开一个已导入的会话，在标题栏选择 **融合对话**，或执行 `/fuse`
并填写另一个已导入的会话 ID。[Fusion 中文文档](https://github.com/omdsh-dev/dsh-fusion/blob/main/README.zh.md)

### OpenCode

OpenCode 客户端使用原生会话。临时迁移可直接读取官方导出的 JSON，由 Shuttle 转成 AHP，再写入 DSH。

```bash
opencode session export <session-id> > /tmp/opencode-session.json
node lib/cli.js import --from opencode --source /tmp/opencode-session.json --apply
```

OpenCode 1.x 使用 `opencode export <session-id>`。Shuttle 也可以导出供 OpenCode 1.x 的 `opencode import` 读取的 JSON。

持续接入可在 OpenCode 宿主配置支持历史分页的 `opencode-ahp`，然后用 Shuttle 读取宿主地址。
OpenCode 客户端可以继续用原来的方式打开会话。

```bash
node lib/cli.js import --from ahp --source 'ws://127.0.0.1:8765/ahp?token=<token>' --cwd /path/to/project --apply
```

Reasonix 写入的是权威会话 JSONL；如果目录未出现新会话，执行
`reasonix sessions reindex` 重建索引。

## 插件 API

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

配置项：`maxFileBytes` 默认 64 MiB；`maxSessions` 默认 500。

## 已知限制

- Codex 和 Claude Code 没有承诺稳定的公开磁盘格式；升级后应先预演。
- 无法安全复制原始字节的图片/二进制附件会转换成文本占位符。
- 厂商私有重放状态、缓存、纯 UI 事件、逐 token 片段和数据库索引不会迁移。
- 当前导出的 Codex/Claude JSONL 匹配已观察到的格式，未来可能需要更新适配器。
- 插件不会删除任何源记录。
