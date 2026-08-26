# MoonshotAI/kimi-code 无头嵌入驱动能力调研

> 调研日期：2026-08-24。用途：为 subagent 执行层引擎中立抽象（`docs/design/subagent-engine-abstraction.md`）提供接入评估输入。按「九问」统一口径，与 claude-code / codex / opencode 调研同构。
>
> 调研对象：`~/GitApp/ai-agent/kimi-code`（MoonshotAI/kimi-code，HEAD `d3b27cc7`，2026-08-24 同步）；本机 `kimi` CLI 0.34.0（`~/.kimi-code/bin/kimi`，repo 内 0.38.0）。

## 结论先行

kimi-code **不是 gemini-cli fork，是全新自研架构**（pnpm monorepo、config.toml、wire.jsonl、自研 ACP + REST/WS server API、agent-core-v2 DI 引擎）。对 subagent 接入最有价值的两点：`--agent-file <path>` 干净的临时人设通道（不污染用户目录）和 `KIMI_CODE_HOME` 一键整仓隔离。缺 schema 结构化输出、无 stdin prompt 投递、**API key 不走环境变量必须写 config.toml**（凭据注入需要配置文件生成步骤）。

## 1. 驱动通道

- **headless 一次性**：`kimi -p/--prompt <prompt>` 非交互；`--output-format text|stream-json` 仅配 -p。
- **server 模式（三条）**：
  - `kimi acp`：ACP (Agent Client Protocol) JSON-RPC over stdio，为 IDE 驱动设计。
  - `kimi web`：本地单进程 REST + WebSocket + Web UI，默认端口 58627，bearer token 鉴权，有 OpenAPI（`/openapi.json`）与 AsyncAPI 文档（docs/en/reference/server-api.md）。`POST /api/v1/sessions` 建会话、`:action` fork/compact/undo/**abort**/**btw**（运行中插话）/children 等完整生命周期端点。
  - `kimi server` 已废弃 → `kimi web`。
- **agent-core-v2 / tower**：agent-core-v2 是下一代引擎（App/Workspace/Session/Agent 四层 DI Scope，实验 flag 切换）；tower 是其多 agent 编排实验 Feature（十个工具 + tower-worker profile，实验 flag 门控）。主线 CLI 行为不受影响。
- **进程内 SDK（关键）**：`packages/node-sdk`（`@moonshot-ai/kimi-code-sdk`，当前 private 未发布）——`createKimiHarness` 进程内建会话/发 prompt/收事件，CLI 的 `-p` 就是经它实现。若发布，是比 spawn CLI 更优的嵌入通道。
- 契约文档化程度高（docs/en 完整 CLI/ACP/server-api/config/providers/env-vars/data-locations 文档）。

## 2. 输入投递

- prompt 仅 argv（`-p`）；**未发现 stdin 投递支持**——超长 prompt 有 argv 限制风险，需引擎侧适配（临时文件）。
- 多轮：`-c/--continue`（本目录最近）、`-S/--session [id]`；两者互斥；-p 可与 resume 组合。
- 运行中插话：server API `POST /api/v1/sessions/{id}:btw`；CLI -p 单次执行无插话通道。

## 3. 事件流与终态

- `--output-format stream-json`：stdout 逐行 JSON，role 序列 `assistant（tool_calls?）→ tool → assistant` + `meta` 行；**thinking 不入 JSONL，进度走 stderr——stdout/stderr 分流严格，便于程序化解析**。
- text 模式：assistant 文本 → stdout；thinking/工具进度 → stderr。
- 终态：**exit code 判定**（goal 模式有专用非零退出码映射 `goalExitCode`，`run-prompt.ts:275-278`）；无统一 exit-code 表。
- server 模式有更细 turn 事件：`turn.started/ended`、`turn.step.started|completed|interrupted|retrying`。

## 4. session 持久化

- 位置：`$KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/agents/{main,<subagentId>}/wire.jsonl` + state.json + 顶层 session_index.jsonl（本机实测结构一致）。
- 格式：**wire.jsonl（agent 事件流含 request trace），非 OpenAI 格式非 sqlite**，官方警告勿手改。
- resume：`--session` / `--continue`；TUI `/fork`；`kimi export` 导出 ZIP。
- **子代理会话独立存于 `agents/<subagentId>/wire.jsonl`**——读 subagent 历史有落点（session 读取需支持 agent 维度）。

## 5. 模型与 provider

- `-m/--model`（模型别名，映射 config.toml `[models.*]`）；`KIMI_MODEL_*` 环境变量族可临时合成 provider。
- provider 类型：`kimi`(OpenAI 兼容) / `anthropic` / `openai` / `openai_responses` / `google-genai` / `vertexai`，均在 `config.toml [providers.<name>]` 配 `base_url + api_key`——完整支持自定义 OpenAI 兼容 baseUrl。
- **关键差异：`KIMI_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` 不从 shell 环境读取，必须写进 config.toml**（env-vars.md 明确 warning）。Kimi 官方账号走 OAuth 设备码流（RFC 8628）。
- **环境隔离：`KIMI_CODE_HOME` 重定位整个数据根（config/sessions/credentials/oauth）**。

## 6. 工具与权限

- approval：`-y/--yolo`（自动批常规，仍可提问）、`--auto`（全自治不提问）、`--plan`（计划模式只读优先）。**`-p` 不能与这三者组合——headless 本身默认 auto 权限策略，静态 deny 规则仍生效**。
- 工具 allow/deny：agent frontmatter `tools` / `disallowedTools`（支持 `mcp__server__*` glob），声明层 + 执行前双层强制；config.toml permission 规则。
- 无 OS 级 sandbox；有 workspaceTrust（未信任时跳过项目级 MCP）。

## 7. 子代理与嵌套

- 原生 Agent tool + 内置 profile：`coder` / `explore`（只读）/ `plan`（无 shell）；`AgentSwarm`（并行群发，独立 timeout_ms）。
- 自定义 subagent：Markdown agent 文件（frontmatter `name/description/whenToUse/tools/disallowedTools/subagents/override` + body 即 system prompt），发现层级 Explicit（`--agent-file`）> Project（`.kimi-code/agents/`、`.agents/agents/`）> User（`~/.kimi-code/agents/`、`~/.agents/agents/`）> Plugin > Built-in。
- **嵌套防护完善**：内置 subagent 不能再派；自定义 agent 默认继承 allowlist 且成员不能再派——委托链保证终止，除非显式 `subagents` 白名单。
- 兼容性：agent 文件忽略 Claude Code 的 `model`、opencode 的 `mode` 字段——**有意做跨工具 agent 文件兼容**。

## 8. agent 人设与 system prompt

- 无 `--append-system-prompt`，但等价能力更强：**`--agent <name>` 直接以指定 agent 跑 headless；`--agent-file <path>` 单文件临时注册并选中（不污染用户目录、优先级最高）**。
- Agent body 是模板：`${base_prompt}` 嵌默认 system prompt、`${agents_md}` 嵌工作区指令、`${plugin_sections}` 注入插件指令——可"包装默认人设"而非全替换。
- 指令层级：project `.kimi-code/AGENTS.md` / `AGENTS.md` ← 用户 `~/.kimi-code/AGENTS.md` + 跨工具 `~/.agents/AGENTS.md`；`$KIMI_CODE_HOME/SYSTEM.md` 永久整体替换默认主 agent system prompt。

## 9. 结构化输出

- **无 schema 强制输出**（全 docs grep 零命中）。只能 prompt 约定 + 解析末条 assistant 消息。

## 分发与版本

- install.sh / npm `@moonshot-ai/kimi-code`；`kimi upgrade` 自更新；迭代快（repo 0.38.0 > 本机 0.34.0）。SDK private 未发布。
- 与 gemini-cli 几乎无 fork 关系。

## 对抽象接口的启示

**预留**：多通道驱动（-p / ACP / REST server / 进程内 SDK 四条）——spawn-CLI 之上预留 server/daemon 模式扩展点；`interrupt()` / `injectMessage()` 能力位（:btw / abort）；persona 落成「写临时 agent 文件 + flag 引用」而非 append-system-prompt；stdout/stderr 分流约定 + stream-json role 序列解析契约；session 读取支持 agent 维度（wire.jsonl 按子代理分目录）；exit code 终态钩子。

**降级**：无 schema 结构化输出（prompt 约定 + 末条 assistant 解析）；无 stdin prompt（超长 prompt argv 限制，需临时文件适配）；无 OS sandbox（宿主层 worktree/cwd + env 隔离兜底）；headless 权限模式不可调（`-p` 固定 auto，permissionMode 需容忍引擎忽略）；**凭据不走 env（接口为每引擎留 `prepareCredentials` 配置文件生成钩子）**。

**环境隔离**：`KIMI_CODE_HOME=<临时目录>` 一键隔离全部状态（比 HOME 重写精准）；配 `--add-dir`、`--skills-dir`（关自动发现防泄入）、`KIMI_DISABLE_TELEMETRY`、显式 `--agent-file` + `--model`，即拼出干净的一次性 subagent 运行环境。
