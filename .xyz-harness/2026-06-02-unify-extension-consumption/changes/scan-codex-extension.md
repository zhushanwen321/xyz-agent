# Codex CLI Extension/Plugin 机制分析

> 源码: ~/GitApp/codex-cli/ (Rust monorepo, codex-rs/)

## 1. 双层架构：Extension API（编译时）+ Plugin 系统（运行时）

Codex 的扩展机制分两层，职责完全分离：

**Extension API**（`codex-rs/ext/extension-api/`）：编译时 trait 协议，面向 Codex 内置功能模块。采用 **Contributor 模式** — 每个 feature 实现一个或多个 `Contributor` trait 注册到 `ExtensionRegistryBuilder`，构建出不可变 `ExtensionRegistry`。提供的 contributor 类型：
- `ContextContributor` — 注入 prompt 片段（系统提示组装阶段）
- `ToolContributor` — 注册原生工具（Rust tool executor）
- `ToolLifecycleContributor` — 工具执行前后生命周期回调
- `ThreadLifecycleContributor` / `TurnLifecycleContributor` — 线程/轮次生命周期
- `ApprovalReviewContributor` — 拦截审批决策
- `TurnItemContributor` — 后处理模型输出 item
- `ConfigContributor` / `TokenUsageContributor` — 配置变更和 token 用量通知

Extension 通过 `ExtensionData`（类型安全的 `HashMap<TypeId, Arc<dyn Any>>`）在 session/thread/turn 三级作用域共享状态。不涉及动态加载，纯编译期注册。

**Plugin 系统**（`codex-rs/core-plugins/` + `codex-rs/plugin/`）：运行时动态加载，面向第三方。Plugin 是一个目录结构，通过 `codex-plugin/manifest.json` 声明元数据，包含四种能力：
- **Skills**（`skills/` 目录）— Markdown 格式的指令集
- **MCP Servers**（`.mcp.json`）— 声明 MCP tool server
- **App Connectors**（`.app.json`）— 连接外部应用
- **Hooks**（`hooks/hooks.json`）— 8 种生命周期事件的外部命令钩子

## 2. 发现与加载

Plugin 通过 **配置层栈**（`ConfigLayerStack`）发现：从 `config.toml` 的 `[plugins]` 段读取已安装插件列表（`plugin_id = { enabled = true }`），然后从本地缓存目录（`~/.codex/plugins/cache/<marketplace>/<name>/<version>/`）加载 manifest 和资源。

加载流程（`core-plugins/src/loader.rs`）：
1. 从配置层栈收集 `PluginConfig` 列表
2. 对每个插件：读取 manifest → 加载 skills → 加载 MCP server 定义 → 加载 app 定义 → 加载 hooks
3. 汇总为 `PluginLoadOutcome`（包含所有 skill roots、MCP servers、hooks、apps）

## 3. Hooks 机制（跨 TUI/非 TUI）

Hooks 是 Plugin 对外暴露行为的主要方式。支持 8 种事件：`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`SessionStart`、`UserPromptSubmit`、`Stop`。每个 hook 是一个外部命令（shell 命令），Codex 通过子进程执行并解析 JSON 输出。这使 hooks 天然与 TUI 解耦 — 无论前端是 TUI、app server 还是 headless，hooks 都通过相同的进程调用机制运行。

## 4. Marketplace 与版本管理

Plugin 有 **marketplace** 概念（如 `openai-curated`、`openai-bundled`），plugin ID 格式为 `<name>@<marketplace>`。版本通过 `PluginStore` 管理，本地缓存按 `plugins/cache/<marketplace>/<name>/<version>/` 组织。支持 remote plugin（通过 ChatGPT API 同步安装状态）、git marketplace（自动 upgrade）。

## 5. 第三方集成路径

第三方开发者通过以下方式集成：
- 创建 plugin 目录（含 `codex-plugin/manifest.json`）
- 在 manifest 中声明 skills/MCP/hooks/apps 路径
- 用户在 `config.toml` 的 `[plugins]` 中配置路径和启用状态
- 或通过 marketplace 分发（需 OpenAI 审核）

**与 xyz-agent 的关键差异**：Codex 的 extension API 是 Rust 编译时 trait，第三方只能通过 plugin（文件系统 manifest + hooks 命令）扩展，不支持动态代码加载。xyz-agent 的 plugin 系统基于 Worker Thread + JS runtime，允许第三方直接运行代码。
