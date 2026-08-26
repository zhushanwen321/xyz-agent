# claude-code 无头嵌入驱动能力调研

> 调研日期：2026-08-24。用途：为 subagent 执行层引擎中立抽象（`docs/design/subagent-engine-abstraction.md`）提供接入评估输入。按「九问」统一口径，与 codex / opencode / kimi-code 调研同构。
>
> 调研环境：本机 CLI `claude 2.1.169`（`/Users/zhushanwen/.local/bin/claude`）；反编译源码仓 `~/GitApp/ai-agent/claude-code-source-code`（对应版本 2.1.88）；官方仓 `~/GitApp/ai-agent/claude-code`（主要 issues/文档）。npm 最新：`@anthropic-ai/claude-code 2.1.241`、`@anthropic-ai/claude-agent-sdk 0.3.241`。

## 结论先行

claude-code 是**无头契约最成熟**的调研对象：headless `-p --output-format stream-json` 官方文档化 + Zod schema 约束；`--json-schema` 原生结构化输出；`CLAUDE_CONFIG_DIR` 干净隔离；agent .md 人设与我们几乎同构。子进程 + stdout 流一条路即可全覆盖（SDK 本质也是 spawn CLI）。

## 1. 驱动通道

**(a) headless CLI（-p/--print）— 最稳定、文档最全**
- `-p, --print`、`--output-format text|json|stream-json`、`--input-format text|stream-json`（`src/main.tsx:976` 起）。
- stream-json 事件有 Zod schema 强约束（`src/entrypoints/sdk/coreSchemas.ts`），契约事实上稳定。
- 对 subagent 极有价值的特殊模式：`--bare`（跳过 hooks/LSP/插件/CLAUDE.md 自动发现，强制 API key 认证）、`--safe-mode`（禁用所有自定义）、`--no-session-persistence`。

**(b) TypeScript SDK（@anthropic-ai/claude-agent-sdk）— v1 query() 稳定，v2 session 标注 UNSTABLE/@alpha**
- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options? })`（`agentSdkTypes.ts:112-120`）——prompt 可为异步流，即支持多轮/steer。
- v2 多轮会话 `unstable_v2_createSession(options)` 标注 @alpha，不依赖。
- `getSessionMessages()` / `listSessions({ dir, limit, offset })`（`agentSdkTypes.ts:178-201`）——官方 session 读取 API。
- 控制协议 `control_request` 子类型含 `interrupt / can_use_tool / set_permission_mode / set_model / get_context_usage / rewind_files / stop_task` 等（`src/entrypoints/sdk/controlSchemas.ts:60-525`）——**interrupt 是一等控制请求**。
- 钩子事件 28 个（`src/entrypoints/sdk/coreTypes.ts:23-53` HOOK_EVENTS）。
- **SDK 底层仍是 spawn claude CLI 子进程走 stream-json，不是进程内库。**

**(c) server / remote 模式 — 不成熟**
- `--remote-control` 挂 claude.ai 远程桥，@internal / 需 OAuth。无通用本地 server 协议。

subagent 场景选 (a) 或 (b)，二者等效（(b) 封装 (a)）。

## 2. 输入投递

- argv 位置参数；`-p` 模式 stdin 也可作 prompt；`--input-format stream-json` 支持运行中持续投递 user 消息（`--replay-user-messages` 配套回执）。
- 多轮：`-c/--continue`、`-r/--resume <sessionId>`、`--fork-session`、`--session-id <uuid>`（**宿主可预指定 UUID**，便于预知 session id）。
- 运行中插话：CLI = `--input-format stream-json` 双向流；SDK = prompt async iterator + control_request `interrupt`。

## 3. 事件流与终态

stream-json 事件 = `SDKMessageSchema` union（`coreSchemas.ts:1854-1876`）：
- `assistant` / `user` / `result`（success / error_during_execution / error_max_turns 等 subtype，`coreSchemas.ts:1409-1431`）/ `stream_event`（配 `--include-partial-messages` 的原始 SSE 块）/ `system`（subtype=init / compact_boundary / status / api_retry / hook_* / task_* 等）/ `SDKToolProgressMessage` / `SDKAuthStatusMessage` / control_request / control_response。
- **终态判定：`type:"result"` 且 `subtype` 枚举**；result 消息自带 cost/duration/usage。

## 4. session 持久化

- jsonl，位置 `~/.claude/projects/<cwd 路径 / 替换为 ->/<sessionId>.jsonl`。
- 行结构：`{type: user|assistant|attachment|queue-operation|last-prompt, parentUuid, uuid, sessionId, timestamp, isSidechain, ...}`——parentUuid 构成树，**isSidechain 即 subagent 分支**。
- resume：`--resume` / `--continue` / `--fork-session`；SDK `listSessions()` / `getSessionMessages()`；`--no-session-persistence` 可关。

## 5. 模型与 provider

- `--model <model>`、`--fallback-model`（过载降级链，仅 print）、`--effort <low|medium|high|xhigh|max>`、`--thinking`、`--max-budget-usd`（仅 print）。
- 环境变量：`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`、`CLAUDE_CODE_USE_BEDROCK/VERTEX`、`apiKeyHelper`（settings 字段）。
- settings 层级可裁剪：`--setting-sources user,project,local` + `--settings <file-or-json>` 追加。
- **`CLAUDE_CONFIG_DIR` 重定向整个 `~/.claude`（隔离首选手段）**。

## 6. 工具与权限

- `--allowedTools/--disallowedTools <tools...>`，规则语法 `Bash(git:*)`；`--tools` 直接白名单内置工具集。
- `--permission-mode`：`acceptEdits | auto | bypassPermissions | default | dontAsk | plan`；`--dangerously-skip-permissions`。
- 权限 hook `PreToolUse`；SDK `canUseTool` 回调可接管权限决策。

## 7. 子代理与嵌套

- 原生 Task/Agent 工具；agent 定义 `~/.claude/agents/*.md`（frontmatter：description/prompt/tools/disallowedTools/model/mcpServers/hooks，`loadAgentsDir.ts:73-101`），也支持 `--agents '<json>'` 直传。
- **嵌套标记：官方子代理 spawn 时透传 `CLAUDECODE` 环境变量**（`spawnMultiAgent.ts:438,645`）——宿主 spawn 前应检测/清理该变量。
- `--agent <name>` 指定 session 用 agent 人设。

## 8. agent 人设与 system prompt

- **一等 flag**：`--system-prompt`（全替换）/ `--append-system-prompt` / `--system-prompt-file` / `--append-system-prompt-file`。
- CLAUDE.md 层级：user → project → local；`--bare` 关自动发现。
- `--exclude-dynamic-system-prompt-sections` 优化 prompt-cache 复用。

## 9. 结构化输出

- **CLI 原生 `--json-schema <schema>`**（help + `main.tsx:976`："JSON Schema for structured output validation"）——官方直接支持 schema 强制输出。
- SDK 无独立 JSON 模式；等价路径 = `tool()` 定义输出工具 + 强制调用。

## 分发与版本

- npm `@anthropic-ai/claude-code`（闭源单包，2.1.x 高频发版）+ `@anthropic-ai/claude-agent-sdk`（与 CLI 同步节奏）；原生安装器 `claude install`。
- 官方文档承诺：headless print / stream-json / resume / SDK query/hooks / settings/权限体系。v2 session API 与 control protocol 标 @alpha/@internal，无承诺。

## 对抽象接口的启示

**预留**：`--json-schema`（outputSchema 可 native 直传）；result 自带 subtype/cost/usage/duration（TaskResult 预留扩展字段）；interrupt 优雅取消；`--session-id` 预指定 UUID；agent .md 双向映射；权限规则字符串数组（`Bash(git:*)` 语法）。

**降级**：无通用本地 server（子进程 + stdout 流即可全覆盖）；无原生超时 flag（只有 --max-turns/--max-budget-usd，超时须宿主 kill 且容忍「硬杀后无 result 事件」）；steer 依赖 stream-json 双向流（标记可选能力）；SDK v2 @alpha 不依赖，多轮统一 `--resume`。

**环境隔离**：`CLAUDE_CONFIG_DIR` 重定向 + `--setting-sources` 裁剪 + `--bare`/`--safe-mode` 屏蔽自定义 + `--no-session-persistence`；认证 `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` env 即够；spawn 前清除 `CLAUDECODE` 防嵌套识别混乱。
