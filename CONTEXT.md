# 统一语言（Ubiquitous Language）

> 完整版见 [`docs/architecture/context.md`](docs/architecture/context.md)（领域术语表 SSOT）。
> 本文件是 design workflow 的精简统一语言，审查 subagent 对齐用。

## 核心术语

### Session（会话）
与 pi 引擎的一个对话实例。每个 session 绑定一个工作目录（`cwd`）和（若该目录是 git 仓库）一个分支。持久化在 `~/.xyz-agent/sessions/` 下扁平 `.jsonl` 文件。生命周期：create → active/idle → compact → restore → delete。

### isActive（执行态 SSOT）[from: unify-session-active-state] [from: session-active-state-completion]
用户视角的「session 在忙」信号。定义：`isGenerating ∨ pendingSend`。UI 层（圆点/状态点/Composer/Panel 守卫）统一消费此信号，不直接用 isGenerating。isCompacting 是独立互斥态（compact 期间不可 steer/abort），不并入 isActive，但 deriveStatus 第 4 参数 isCompacting=true 时也返回 running（视觉态属 running）。

### Task（任务）
**「任务」是「会话」的产品化措辞，1:1 同义。** 对用户暴露的概念叫"任务"（更贴近工作意图），系统/代码层统一叫"session"。不存在"一个任务跨多 session"的聚合实体。

### Panel（面板）
Session 的视口。每个 Panel 最多绑定一个 Session；每个 Session 同一时刻全局只能绑定到一个 Panel（跨窗口唯一）。

### Agent Runtime
xyz-agent 的后端 Node.js 服务进程。托管 pi 子进程生命周期、协议翻译（pi JSON RPC ↔ WebSocket）、session CRUD、配置持久化。前端不直接与 pi 通信。对应目录 `packages/runtime/`。

### TaskNode / ToolCall
树形任务引擎节点 / pi 单次工具调用记录（底层概念，详见完整版）。

### Generating State
两标志共同描述 session 运行态：
- `isGenerating`：pi 是否处理中（发消息即 true，agent_end 即 false）
- `streamingMessage`：当前逐字输出消息
- 两者可能不同步：`isGenerating=true && streamingMessage=null` = pi 已收请求但未开始输出

### Tool Approval / Human Confirm
危险操作确认机制。三选一：Allow（本次允许）/ Deny（拒绝）/ Always（永久允许）。任务级操作开放输入框。UI 弹窗 60s 超时自动关闭。

## 本主题相关语义

- **「新建任务」**：用户从「无活跃会话」进入「准备开聊」的业务动作。终点是 session 发出第一条消息。5 步流程：落地空态 → 选目录 popover → 选分支 popover → 系统原生目录选择器 → 创建分支 modal。
- **directory / branch**：session 的元信息，非任务本体。显示为 composer 顶部 chip，可随时改。
