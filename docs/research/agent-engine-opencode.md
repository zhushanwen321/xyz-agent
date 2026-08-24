# opencode（anomalyco/opencode）无头嵌入驱动能力调研

> 调研日期：2026-08-24。用途：为 subagent 执行层引擎中立抽象（`docs/design/subagent-engine-abstraction.md`）提供接入评估输入。按「九问」统一口径，与 claude-code / codex / kimi-code 调研同构。
>
> 调研对象：`~/GitApp/ai-agent/opencode-anomaly`（anomalyco/opencode，dev 分支 HEAD `0d690c505`，2026-08-24 同步）；本机安装 `~/.opencode/bin/opencode`，版本 1.18.21。

## 结论先行

opencode 的最大差异点是 **HTTP server + SSE 是一等驱动通道**（openapi 3.1.0 规范入库，SDK 由 openapi 生成）：`serve --port 0` 起本地 server 再走 SDK，事件流、abort、权限应答、多 session 并发全有 API 面，比解析 run 的 stdout 可靠。原生 task 工具 + agent .md（兼容 Claude Code 风格 frontmatter）人设迁移成本低。缺 schema 结构化输出与 CLI 超时。

## 1. 驱动通道

**(a) `opencode run`（headless 一次性）**
- 位置参数 prompt；`-m/--model provider/model`、`--agent <name>`、`--variant`（reasoning effort）；`--format default|json`（**json = NDJSON 原始事件流**）；`-c/--continue`、`-s/--session <id>`、`--fork`；`-f/--file` 附件；`--print-logs`；`--attach http://localhost:4096`（**attach 到已运行的 server** 而非本地起实例）；`--auto`（自动批准）、`--command`（执行 slash command）、`--dir`。无 `--timeout` flag。

**(b) `opencode serve`（HTTP server + SSE）— 重点**
- `--port`（默认 0=随机）、`--hostname`（默认 127.0.0.1）、`--cors`、`--mdns`。API 面定义在 `packages/opencode/src/server/routes/instance/httpapi/`（effect HttpApi，端点带 OpenApi annotations），groups：config / control / event / file / instance / mcp / permission / project / pty / question / session / sync / workspace 等。
- **session 组端点**（`groups/session.ts:89-433`）：`GET /session`（list）/ `GET /session/:id` / `GET /session/:id/children`（子 task session）/ `GET /session/:id/message`；`POST /session`（create）/ `PATCH /session/:id`（title/metadata/permission）/ `POST /session/:id/message`（**同步 prompt**）/ `POST /session/:id/prompt_async`（**异步 prompt 立即返回**）/ `POST /session/:id/abort`（**取消运行中 session**）/ `POST /session/:id/fork` / `/revert` 等。
- **事件订阅：`GET /event`，SSE（text/event-stream）**。事件为 Event Manifest 联合：`message.updated`、`message.part.updated`（text / tool / step-start / step-finish part）、`error` 等。
- 权限应答：`POST /session/:id/permissions/:permissionID`。

**(c) SDK**：`@opencode-ai/sdk`（`packages/sdk/js/`，由 `packages/sdk/openapi.json` 生成）——**server API 有正式 openapi 文档化**。run 命令内部就用该 SDK 消费事件流（`cli/cmd/run.ts:692-760`）。

**(d) ACP**：`opencode acp`（Agent Client Protocol server）。

## 2. 输入投递

- run：argv prompt、`--file` 附件、`-s` 多轮续聊。
- server：`POST /session/:id/message`，payload（`session/prompt.ts:71-91`）：`{ sessionID, messageID?, model?, agent?, parts: [{type:"text"|"file"|"agent"|"subtask"}], system?（可覆盖 system prompt）, variant? }`——**parts 支持文本/文件混排，system/agent 可指定**。多轮 = 同 sessionID 重复 POST；运行中插话 = 再次 POST（prompt_async 场景）；abort = 显式端点。
- task 工具支持向运行中 background task 追加上下文（`tool/task.ts:38-41`）。

## 3. 事件流与终态

- run `--format json`：NDJSON，每行 `{type, timestamp, sessionID, ...}`；type 含 `message.updated` / `message.part.updated`（step_start / step_finish / text / tool_use）与 `error`（error 事件 + exitCode=1）。
- 终态判定：step-finish part / session status（`GET /session/status` 返回各 session 状态）；busy 冲突有 `SessionBusyError`。
- server：SSE `/event` 持续推送；完成 = session status 离开 running。

## 4. session 持久化

- **双存储**：sqlite `~/.local/share/opencode/opencode.db`（+wal/shm）+ JSON 文件 `~/.local/share/opencode/storage/{session,message,part,todo,...}/`（每 entity 一个 `ses_*.json`）。
- 路径常量 `packages/core/src/global.ts:7-24`（XDG；`OPENCODE_CONFIG_DIR`、`OPENCODE_TEST_HOME` 可覆盖）。
- 模型：session → message → part 三层；parent/child（task 子 session）。
- resume：`-s <id>` / `-c` / `POST fork`；`opencode export [sessionID]` / `import <file>` 迁移。

## 5. 模型与 provider

- models.dev 目录（`Flag.OPENCODE_MODELS_URL || "https://models.dev"`，本地缓存）。
- 配置 `~/.config/opencode/opencode.json` + 项目级 `.opencode/opencode.json`；自定义 provider（baseURL/headers，`config/provider.ts`）；auth 存 `~/.local/share/opencode/auth.json`。
- CLI：`opencode providers` / `opencode models`。

## 6. 工具与权限

- 权限模型 `Permission.Ruleset`：action `allow/ask/deny`，资源 glob（如 `edit: {"*.md":"allow","*":"deny"}`）；可挂 agent、session（`PATCH /session/:id` 的 permission 字段）。
- 内置 agent 权限示例：build（编辑工具）、plan（禁 edit）、subagent 模式（限定 read/grep/glob/list/bash/webfetch/websearch）。
- `--auto` = 自动放行未显式 deny 的。工具清单含 bash/edit/read/write/glob/grep/webfetch/websearch/task/lsp/plan/question/skill/todo/apply_patch。
- PromptInput 的 tools 字段已 @deprecated（tools 与 permissions 合并到 session）。

## 7. 子代理与嵌套（opencode 特色）

- **原生 task 工具**（`tool/task.ts`）：参数 `description` / `prompt` / `subagent_type`（选 agent）/ `task_id`（**复用/续聊同一子 session**）/ `background`（后台异步，完成后自动通知）。
- **agent 定义三级**：`.opencode/{agent,agents}/**/*.md`（+ 兼容 `{mode,modes}/`）+ 全局 config；frontmatter（`core/src/config/agent.ts:16-28`）：`model/variant/request/system/description/mode/hidden/color/steps/disabled/permissions`（**无独立 tools 字段——tools 走 permissions**）。
- **mode 语义**：`subagent | primary | all`。只有 subagent/all 的 agent 出现在 task 工具的 subagent_type 列表。内置 build/plan（primary）+ general-purpose/research 等 subagent。
- 加载用 gray-matter 且对未加引号冒号做兼容 sanitize（`core/src/config/markdown.ts:23-38`——**刻意兼容 Claude Code 风格配置**）。

## 8. agent 人设与 system prompt

- agent `.md` 正文即 prompt；frontmatter `system` 可额外覆盖。
- 项目指令层级（`session/instruction.ts:53-68`）：全局 `~/.config/opencode/AGENTS.md`（或 `~/.claude/CLAUDE.md`）→ 项目从 cwd 向上第一个命中的 `AGENTS.md`/`CLAUDE.md`，**只取最近一层不叠加**。`OPENCODE_DISABLE_PROJECT_CONFIG` 关闭。
- run/server 均可 `--agent` / PromptInput.agent 选人设。

## 9. 结构化输出

- **无原生 schema 约束**（experimental 组只有 tools JSON schema 查询）。替代：prompt 约定 + 自行抽取最终 text part。**接口需允许降级为 "prompt 约定 + 文本解析"**。

## 分发与版本

- curl 安装脚本（自更新 `~/.opencode/bin`）、npm `opencode-ai`、brew；1.18.x，monorepo（bun + turbo + effect）发布频繁。
- server API：openapi 3.1.0 入库 + 生成 TS SDK，接口稳定性较好。

## 对抽象接口的启示

**预留**：抽象层不应绑死 stdio——Driver 形态需容纳 `connect(url)` 的 HTTP/SSE（opencode 走 serve + SDK 是最稳嵌入方式）；`prompt_async + abort + SSE` 三个正交原语分别建模；事件粒度到 part（text/tool/step 边界）+ sessionID；权限应答回调（optional permission handler，无此能力的引擎降级 allow-all/白名单）；agent 体系原生映射（frontmatter description/mode:model/permissions）；`resume(sessionId)` 与 task_id 续聊。

**降级**：无 schema 结构化输出（outputSchema 标 optional/best-effort）；无 CLI 超时 flag（宿主自管）；run human 格式不适合机器解析（必须 `--format json`）。

**环境隔离**：`OPENCODE_CONFIG_DIR`（重定向全部配置）、`OPENCODE_TEST_HOME`、`--dir`、`--pure`（禁外部插件）、`OPENCODE_DISABLE_PROJECT_CONFIG`（防子代理被宿主项目配置污染）；serve 默认 127.0.0.1 随机端口 + `OPENCODE_SERVER_USERNAME/PASSWORD`。每 subagent 沙箱可组合：独立 config dir + 独立 serve 实例 + `.opencode/agent/` 注入人设。
