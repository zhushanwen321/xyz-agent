# Pi Extension 术语表

> 本术语表整合自 xyz-pi-extensions 项目的 CONTEXT.md。收录 pi 平台通用术语和各 extension 的核心概念。
> 这是 pi extension 开发的必备词汇表。

---

## Pi 平台层

**Extension**
TypeScript 模块，通过 `export default function(pi: ExtensionAPI)` 注册到 Pi 运行时。可注册 Tool、Command、Event Handler、UI 组件。放置于 `~/.pi/agent/extensions/` 或 `.pi/extensions/`。

**ExtensionAPI**
Pi 传递给 Extension 工厂函数的 API 对象。提供 `registerTool()`、`registerCommand()`、`on()`、`registerMessageRenderer()`、`appendEntry()` 等方法。

**Tool**
Extension 通过 `pi.registerTool()` 注册的能力单元。定义 name、parameters schema、execute handler、renderCall/renderResult。模型通过 function calling 调用。

**Command**
Extension 通过 `pi.registerCommand()` 注册的用户命令，以 `/` 开头。用户在编辑器中输入触发，不由模型调用。

**Event**
Pi 运行时生命周期事件。Extension 通过 `pi.on(event, handler)` 监听。核心事件：`session_start`、`before_agent_start`、`agent_start`、`turn_end`、`message_end`、`agent_end`、`session_shutdown`。

**Session**
一次 Pi 对话的完整生命周期。以 JSONL 文件持久化，支持树状分支。状态通过 `ctx.sessionManager` 访问。

**Entry**
Session 中的单条记录。`ctx.sessionManager.getEntries()` 返回全部，`ctx.sessionManager.getBranch()` 返回当前分支。Extension 通过 `pi.appendEntry(type, data)` 写入自定义记录，通过 `type === "custom" && customType === "..."` 读取。

**CustomEntry**
带 `customType` 字段的 Entry，用于 Extension 持久化私有状态。写入：`pi.appendEntry("my-type", data)`；读取：过滤 `entry.type === "custom" && entry.customType === "my-type"`。

**Theme**
TUI 颜色系统。通过 `ctx.ui.theme.fg(token, text)` 使用语义 token（如 "toolTitle"、"success"、"error"）着色，不硬编码 ANSI。

**Agent**
`.md` 文件定义的 agent 配置，包含 frontmatter（name、description、tools）和 body（systemPrompt）。放置于 `~/.pi/agent/agents/`（user 级）或 `.pi/agents/`（project 级）。

**Context Files**
`AGENTS.md` 或 `CLAUDE.md`，作为系统提示词的一部分加载。从 `~/.pi/agent/`、父目录、当前目录自动发现并拼接。

**Skill**
On-demand 能力包，Markdown 格式。通过 `/skill:name` 触发或由 agent 自动加载。放置于 `~/.pi/agent/skills/`、`~/.agents/skills/`、`.pi/skills/`。

**Prompt Template**
可复用的提示词模板，Markdown 格式，支持 `{{variable}}` 插值。通过 `/name` 展开。

**Steering**
Pi 的消息投递机制之一。`deliverAs: "steer"` 在当前 assistant turn 执行完 tool call 后注入，高优先级。用于目标更新、预算警告等需要立即响应的场景。

**Follow-up**
Pi 的消息投递机制之一。`deliverAs: "followUp"` 在 agent 完成所有工作后注入，低优先级。用于常规 continuation。

**Compaction**
长 session 的上下文压缩机制。将旧消息摘要，保留近期消息。有损操作，完整历史保留在 JSONL 中。

**Pi Package**
Extension + Skill + Prompt Template + Theme 的分发单元，通过 npm 或 git 安装。

---

## Extension 专属概念

以下术语属于具体 extension，是该 extension 的核心设计概念。

### Goal（pi-goal）

**Goal**
用户通过 `/goal <objective>` 发起的持久化自主循环。有预算约束、7 态状态机、与 Todo 扩展集成的任务清单。

**GoalStatus**
Goal 的生命周期状态，共 7 种：`active`（驱动 agent 循环）/ `paused`（用户暂停）/ `blocked`（agent 卡住）/ `complete`（终态，任务完成有证据）/ `budget_limited`（终态，token 耗尽）/ `time_limited`（终态，时间耗尽）/ `cancelled`（终态，用户清除）。

**Evidence**
Agent 声明 goal 完成时必须提供的具体验证信息。防止无证据标记完成。

**Budget**
Goal 的资源约束：Token Budget（token 上限）+ Time Budget（时间上限）。

**Verification Todo（验证任务）**
Todo 清单中标记 `isVerification: true` 的任务项。Goal 完成前的硬检查依据，不可取消。

### Todo（pi-todo）

**Todo**
任务管理扩展。Goal 任务管理的唯一来源。Todo 项四态：`pending` / `in_progress` / `completed` / `cancelled`。

### Subagent（pi-subagent-workflow）

**Subagent**
通过 Pi SDK 在进程内或子进程创建独立 session 执行委派任务。主 agent 与 Subagent 之间通过 task prompt（下行）和事件回调（上行）通信。

**Execution Mode**
Workflow 脚本中 Subagent 的执行模式：Single（单 agent 单 task 阻塞）/ Parallel（多 agent 并发）/ Pipeline（串行链式）。

**Background Job**
`background: true` 模式下的 Subagent 运行实例。结果通过 Pi 的 `sendMessage({ deliverAs: "followUp", triggerTurn: true })` 自动注入主对话。

### Context Engineering（pi-context-engineering）

**L0 / L1 / L2**
三级压缩管道：L0 零成本清理 / L1 规则化摘要 / L2 紧急截断。增强（不替代）原生 Compaction。

**Recall**
LLM 通过 `recall_context` 工具按 ID 获取被压缩前的原始内容。压缩的可逆性保障。

**Protected Turn**
最近 N 个 Turn Boundary，其中的 toolResult 不被压缩。N 由 `protectRecentTurns` 配置（默认 2）。

### Permission（pi-permission）

**Permission Mode**
四档权限模式，按严格等级：`yolo`（放行）/ `auto`（AST+规则+AI 三层管道）/ `approve`（规则+人工）/ `strict`（全审批）。

**Permission Pipeline（三层管道）**
auto 模式的安全检查管道：层 1 AST 结构分析 → 层 2 规则匹配 → 层 3 AI Classifier + 用户审批竞速。任一层 allow 放行，deny 拒绝，ask 流向下游。

### Workflow（pi-subagent-workflow）

**External State Pointer**
session JSONL 中指向外部 state 文件的轻量 entry（`customType === "workflow-state-link"`）。解决主 JSONL 膨胀问题。

**Approval Memory**
session-level 持久化已确认 workflow 名称集合，跨 session_start 重建。`workflow-run` tool 的 auto 模式走此 cache 避免重复弹 confirm。

---

## Flagged Ambiguities（易混淆点）

**"压缩"同时存在于 Pi 原生（Compaction）和 Context Engineering（L0/L1/L2）**
Compaction 在 agent loop 外做 token 级 LLM 摘要（不可逆），Context Engineering 在 agent loop 内做消息级规则化处理（可逆 Recall）。两者互补不冲突。

**"任务"统一到 Todo**
Goal 不内嵌任务系统，任务管理统一到 Todo 扩展。Goal 通过只读快照接口读取 Todo 进度，验证任务由 Todo 的 `isVerification` 标记承载。
