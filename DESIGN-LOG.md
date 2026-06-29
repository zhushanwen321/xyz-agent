# 设计历史索引（DESIGN-LOG）

> 跨主题导航。`.xyz-harness/{date}-{topic}/` 是一次性设计产出目录；本文件是按领域归类的高层索引，帮助快速定位历史决策。每个 topic 目录含 spec.md / plan.md / use-cases.md / non-functional-design.md / e2e-test-plan.md / retrospect.md 等（按 workflow 阶段产出）。

## 按领域归类

### 项目起点 / 架构重构

| Topic | 摘要 |
|-------|------|
| `2026-05-06-hello-pi` | MVP 起点：pi GUI 壳（原设计 Tauri+Radix，后迁 Electron） |
| `2026-05-22-pixyz-agent-1-...-pi` | 跨平台打包 + pi 与 xyz-agent 边界厘清 |
| `2026-06-20-frontend-rebuild` | 前端 v3 重建（L0-L4 组件分层） |
| `2026-06-23-render-runtime-integration` | renderer + runtime 集成 |
| `2026-05-21-` | （主题名缺失，待补） |

### Runtime / 进程 / 隔离

| Topic | 摘要 |
|-------|------|
| `2026-06-07-instance-isolation` | dev/prod 实例完全隔离（XYZ_AGENT_DATA_DIR 心智锚点）→ NFR §安全 |
| `2026-06-07-streaming-collapse` / `-clarify` | 流式消息折叠渲染 |
| `2026-06-08-agent-run-block-refactor` | AgentRunBlock 折叠（thinking/tool 合并 MergeBlock，write/edit 独立卡片） |
| `2026-06-28-message-stream-working-state` | message stream 工作态设计 |

### 新建任务 / Session 流程

| Topic | 摘要 |
|-------|------|
| `2026-06-26-new-task-landing` | 新建任务 Landing 态（含 test-strategy.md） |
| `2026-06-28-lite-composer-slash-trigger` | composer 输入 / 触发 slash 浮层（lite-plan） |
| `2026-06-28-lite-slash-command-fix` | slash 时序竞争修复 + landing 预创建 session（含 retrospect.md） |

### Composer / 输入区

| Topic | 摘要 |
|-------|------|
| `2026-05-11-slash-command` | slash 命令系统（local/protocol/skill 三类） |
| `2026-05-24-slash-commands` | Session Tree navigate/fork/clone（pi extension） |
| `2026-06-05-chat-send-mode-design` / `-round1` | chat 发送模式（Enter/Shift-Enter/steer/followUp） |
| `2026-06-07-chat-send-mode-design` | send/steer/followUp 双队列 |
| `2026-06-22-composer-ux-fixes` | composer UX 修正 |

### Skill / Agent / Provider 配置

| Topic | 摘要 |
|-------|------|
| `2026-05-12-settings-redesign` | Settings 四 tab 重设计（Provider/Skill/Agent/System） |
| `2026-05-14-skill-use` / `2026-05-14-skill-slash-skill-...` | skill 扫描导入 + slash menu |
| `2026-05-15-agent-use` / `2026-05-15-agent...` | agent 扫描导入 |
| `2026-05-30-provider-model-mapping` / `-thinking-level-preset` | provider 模型映射 + thinking level 预设 |
| `2026-06-10-model-lifecycle-fixes` | model 生命周期修复 |

### 插件系统（最大子系统，占 runtime 49%）

| Topic | 摘要 |
|-------|------|
| `2026-05-26-plugin-arch-refactor-phase1` | 插件架构重构 Phase 1 |
| `2026-05-27-clarify-plugin-phase1` | Phase 1 需求澄清（Worker 隔离/懒激活/状态机） |
| `2026-05-27-bundle-pi-extensions` | 打包 pi extensions |
| `2026-05-28-plugin-system-phase2` / `-frontend-dx` | Phase 2 + 前端 DX |
| `2026-05-29-plugin-arch-remaining-and-ci-fix` / `-remaining-phases` | 剩余 phase + CI 修复（API stub 真实对接） |
| `2026-06-07-pi-extension-install` | pi extension 安装 |
| `2026-06-02-extension-user-install-and-settings` | 用户安装 + settings |
| `2026-06-02-unify-extension-consumption` | 统一 extension 消费 |

### 导航 / 窗口 / 侧栏

| Topic | 摘要 |
|-------|------|
| `2026-05-10-window-management` | 多窗口管理 |
| `2026-06-01-global-nav-stack` / `-navigation` | 全局导航栈 |
| `2026-06-22-sidebar-polish` | 侧栏打磨 |
| `2026-06-28-sidebar-project-file-tree` | 侧栏项目文件树 |

### 渲染 / Markdown / 状态展示

| Topic | 摘要 |
|-------|------|
| `2026-05-19-markdown-render` | Markdown 渲染（Shiki+GFM+KaTeX+Mermaid+DOMPurify） |
| `2026-05-30-statusline-design` | Statusline 三区设计 |
| `2026-05-08-ui-design-review` | UI 设计评审 |

### TUI Bridge / 工具

| Topic | 摘要 |
|-------|------|
| `2026-05-05-tui-bridge-phase0` / `-review` | TUI bridge Phase 0 + 评审 |

## 关键决策节点（影响架构）

- **2026-05-22**：确定 Electron（弃 Tauri）+ Runtime 独立 Node WebSocket 服务架构
- **2026-05-27 clarify-plugin-phase1**：Plugin Worker Thread 隔离模型确立（trusted 共享 / untrusted 独占）
- **2026-06-07 instance-isolation**：dev/prod 数据隔离方案（XYZ_AGENT_DATA_DIR SSOT）→ NFR.md
- **2026-06-08 agent-run-block-refactor**：AgentRunBlock 折叠模型（MergeBlock）确立，不改共享 message.ts 契约
- **2026-06-20 frontend-rebuild**：前端 v3 L0-L4 组件分层重建
- **2026-06-28 lite-slash-command-fix**：Runtime broadcast 时序竞争根因定位 + 主动拉取模式确立 → ARCHITECTURE.md 不变式#3

## 维护

- 新设计完成后，在「按领域归类」对应分组追加一行
- 重大架构决策追加到「关键决策节点」
- topic 目录命名：`{yyyy-MM-dd}-{kebab-topic}`，lite workflow 用 `lite-` 前缀
