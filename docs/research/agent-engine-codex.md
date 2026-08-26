# openai/codex 无头嵌入驱动能力调研

> 调研日期：2026-08-24。用途：为 subagent 执行层引擎中立抽象（`docs/design/subagent-engine-abstraction.md`）提供接入评估输入。按「九问」统一口径，与 claude-code / opencode / kimi-code 调研同构。
>
> 调研对象：`~/GitApp/ai-agent/codex-cli`（openai/codex，HEAD `a305084705`，2026-08-24 同步）。本机未装 codex CLI，结论全部基于仓库源码与文档。

## 结论先行

codex 提供**四层通道**（exec 一次性 / app-server JSON-RPC / TS SDK / mcp-server），其中 **app-server 是契约最完备的参考样板**：核心原语 Thread→Turn→Item、`generate-json-schema` 机器契约、`turn/steer` 运行中插话、`--output-schema` 原生结构化输出。限制：自定义 provider 只支持 OpenAI Responses API（`wire_api = "chat"` 已移除）。

## 1. 驱动通道

**(a) `codex exec`（一次性 headless）**
- `codex-rs/exec/src/cli.rs:22`；`--json` 输出 JSONL 事件流（:60-65）；`-o/--output-last-message FILE` 写最终消息到文件（:72-77）。
- 子命令：`exec resume`（带 prompt）、`exec fork`、`exec review`（:170-180）。

**(b) `codex app-server`（JSON-RPC 2.0 常驻服务）— 重点**
- 官方定位："the interface Codex uses to power rich interfaces such as the Codex VS Code extension"（`codex-rs/app-server/README.md:3`）。
- 协议：JSON-RPC 2.0（wire 省略 jsonrpc 头）；传输 stdio JSONL / unix socket（`codex app-server proxy`）/ `--listen off`。
- **核心原语：Thread（会话）→ Turn（一轮）→ Item（消息/命令/文件变更）**。生命周期：`initialize` → `thread/start|resume|fork` → `turn/start` → 流式 item 通知 → `turn/completed`；中断 `turn/interrupt`。
- **Schema 可生成且版本锁定**：`codex app-server generate-ts / generate-json-schema --out DIR`，产物与运行版本严格匹配——接口契约稳定性的关键机制。
- 方法面约 130+：thread/turn/item 三族 + fs/* + process/* + mcpServer/*（内置 MCP 客户端管理）+ account/config/model/permissionProfile/skills/review/remoteControl 等；实验方法需 `initialize` 时 `capabilities.experimentalApi: true` opt-in。

**(c) TS SDK（@openai/codex-sdk）**：spawn CLI 走 exec JSONL（"spawns the CLI and exchanges JSONL events"，`sdk/typescript/README.md`）。`codex.startThread()` → `thread.run()/runStreamed()`，同 Thread 多次 run 即多轮。

**(d) `codex mcp`**（原 mcp-server，已更名）：把 codex agent 暴露为 MCP tool server。

契约稳定性：exec 事件 serde 定义（`exec/src/exec_events.rs`）；app-server Rust 类型 + 可生成 schema；README 约 700 行 API 文档。核心 thread/turn/item 面稳定（VS Code 扩展依赖）。

## 2. 输入投递

- exec：argv 位置参数或 stdin（`-` / 管道；两者并存时 stdin 作 `<stdin>` 块附加，`cli.rs:78-81`）；`--image/-i` 附件。
- 多轮：`exec resume <SESSION_ID|--last> [PROMPT]`；fork：`exec fork`。
- **运行中插话：app-server `turn/steer`**（exec 一次性模式无此能力）；输入排队 `thread/queue/add|start`。

## 3. 事件流与终态

exec `--json` 事件（`exec_events.rs:6-34`）：`thread.started`（含 thread_id，可 resume）/ `turn.started` / **`turn.completed`（含 token usage）** / **`turn.failed`（含 error.message）** / `item.started|updated|completed`（item 类型：agent_message / reasoning / command_execution / file_change / mcp_tool_call / web_search 等）/ `error`。

**终态判定：`turn.completed`（usage）或 `turn.failed`（error）+ exit code**。app-server 错误码枚举：BadRequest / Unauthorized / UsageLimitExceeded / ContextWindowExceeded / SandboxError / SessionBudgetExceeded / InternalServerError。

## 4. session 持久化

- rollout jsonl：`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`（文件名编码 thread_id + rollout_id，`rollout_file_name.rs:13-20`）；另有 SQLite state_db。
- resume：`exec resume` / app-server `thread/resume` / `thread/fork`；读取历史：`thread/items/list`、`thread/turns/list`、`thread/read`。
- **一次性任务不落盘：`codex exec --ephemeral`（cli.rs:41-42）**；app-server `thread/start {ephemeral:true}`。

## 5. 模型与 provider

- `--model/-m`；`--oss` / `--local-provider lmstudio|ollama`。
- 自定义 provider：`~/.codex/config.toml` `[model_providers.<id>]`（base_url / env_key / wire_api）；**`wire_api = "chat"` 已移除，只支持 "responses"**（`model-provider-info/src/lib.rs:57`）——接非 OpenAI 协议 provider 受限。
- API key 从 env_key 指定的环境变量读取；`OPENAI_API_KEY` 默认；支持 ChatGPT 账号登录。
- **环境隔离：`CODEX_HOME` 重定位整个 `~/.codex`（auth/config/sessions）**；`--ignore-user-config`；`-p/--profile` 叠加 `$CODEX_HOME/<name>.config.toml`。

## 6. 工具与权限

- sandbox：`-s/--sandbox read-only | workspace-write | danger-full-access`（macOS Seatbelt / Linux landlock+bubblewrap，跨平台语义不齐，抽象层当「建议值」）；`--add-dir` 额外可写目录。
- approval：`--approval-mode on-request | never`（枚举只剩这两个）；旁路 `--dangerously-bypass-approvals-and-sandbox`（alias `--yolo`）。
- app-server：turn/start 可逐 turn 覆盖 sandbox/approval policy；审批交互走 server→client 请求。

## 7. 子代理与嵌套

- 有原生 subagent（协议层 `SessionSource::SubAgent` / `ThreadSpawn`，`codex-rs/protocol/src/protocol.rs:2595-2741`；collaboration-mode-templates）。
- 但 **multiAgentMode 已 deprecated/ignored，官方建议改用 reasoning effort 触发**——机制活跃变动期，不宜依赖，嵌套编排自己做。

## 8. agent 人设与 system prompt

- 覆盖 base system prompt：config `base_instructions` + `developer_instructions`（`core/src/config/mod.rs:666-673`），经 `-c key=value` 传入。
- AGENTS.md（user/project 层级）；`-p/--profile` 配置叠加层；skills 体系。
- exec 传人设最实用路径：`-c developer_instructions="..."` 或 prompt 内联 + 临时 CODEX_HOME 放 AGENTS.md。

## 9. 结构化输出

- **一等公民：`codex exec --output-schema FILE`**（JSON Schema 文件，`cli.rs:50-51`）；SDK 封装 `outputSchemaFile.ts`（schema 对象写临时文件传 flag）；samples `structured_output.ts` / `structured_output_zod.ts`。
- 终态载体：`item.completed` 的 agent_message——"a JSON string when structured output is requested"（`exec_events.rs:106-107`）。走 Responses API 原生 `text_format/json_schema` 强约束。

## 分发与版本

- npm `@openai/codex` / `@openai/codex-sdk`、brew、GitHub Release、cargo。Rust 周版本模式高频发版。
- app-server：仓库 README 详尽 + generate-ts/json-schema 机器契约；大量方法 experimental 需 opt-in，核心 thread/turn/item 面稳定。

## 对抽象接口的启示

**预留**：双通道（exec spawn 型 + app-server 常驻型）——抽象层应支持「run 型」与「session 型」两种实现策略；`outputSchema` 进接口一等参数（codex 直映射 `--output-schema`）；steer / interrupt 分列两个可选能力；多轮即同 threadId 再 start turn（resume 语义自然）；事件模型可对齐 `thread.started / item.* / turn.completed{usage} / turn.failed{error}`；借鉴 generate-json-schema 做我们引擎适配层的类型自检。

**降级**：自定义 provider 只能走 Responses API（provider 抽象不能假设通用）；exec 模式无运行中插话（只有杀进程）；multi-agent 机制变动期不依赖；sandbox 跨平台语义不齐当建议值。

**环境隔离**：`CODEX_HOME=<tmpdir>` 整仓隔离 + `--ignore-user-config` + `--ephemeral`（不落盘）是 subagent 沙箱化一次 spawn 的最佳组合；临时 `--profile` 叠加层传人设/模型配置不污染用户 config。
