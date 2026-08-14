# DSH Shuttle

DSH Shuttle 是一个 DeepSeek Harness 插件和离线命令行工具，用于在 DSH 与
Codex、Claude Code、Pi、Reasonix、OpenCode 之间双向迁移编程对话记录。

插件先把各厂商记录转换成统一中间格式，再写成 DSH 事件或目标工具可读取的
原生格式。目标支持时，会保留文本、推理、工具调用/结果、时间戳、工作目录、
模型和供应商信息。

## 安全约定

- 默认只预演；只有显式传入 `--apply` 才写入。
- 已存在的 DSH 会话 ID 或目标文件只会跳过，绝不覆盖。
- 外部文件有大小和数量上限，不递归跟随符号链接。
- 写入 DSH 始终调用 `ctx.sessionPersistence`，兼容 JSONL 和 SQLite。
- OpenCode 只使用 `opencode export/import` 的官方 JSON，不修改数据库。

## DSH 界面命令

### 设置页

打开 **设置 → 对话迁移**，可以在两个互不影响的单元中完成双向迁移：

1. 在“导入到 DSH”中选择来源平台，按需填写来源路径和数量。
2. 在“从 DSH 导出”中选择目标平台、DSH 任务、目标路径和范围。
3. 分别预览；设置页预览通过独立接口执行，不会创建 DSH 对话或写入目标文件。
4. 检查对应单元的报告、勾选确认，再执行导入或导出。

界面支持 Codex、Claude Code、Pi、Reasonix 和 OpenCode。执行按钮只有在当前表单
完成一次成功预览后才会出现；修改该单元的任何迁移参数都会让旧预览失效。

### 斜杠命令

交互式 DSH 组合加载插件后，可直接在对话输入框输入 `/shuttle` 查看帮助。结果只在
界面显示，不会作为消息发送给模型。

```text
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

### OpenCode

```bash
opencode export <session-id> > /tmp/opencode-session.json
node lib/cli.js import --from opencode --source /tmp/opencode-session.json --apply

node lib/cli.js export --to opencode --session <dsh-session-id> \
  --destination /tmp/dsh-opencode --apply
opencode import /tmp/dsh-opencode/<dsh-session-id>.opencode.json
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
