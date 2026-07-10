# Product

## Register

product

## Users

开发者和技术工作者，主要在后端/系统方向有深度积累，对前端 UI/UX 概念不熟悉但需要长时间（每天 6 小时以上）与 AI Agent 协作完成任务。

典型使用场景：
- 向 AI Agent 下达复杂任务指令（如"重构 auth 模块"）
- Agent 自动拆分为多个 SubAgent 并行执行
- 用户需要监控各 SubAgent 的执行状态、查看已完成的结果、回应需要确认的告警
- 在分屏模式下同时查看主线对话和某个 SubAgent 的详细执行过程
- 通过 Overview 快速鸟瞰不同 Session 的任务总览

## Product Purpose

xyz-agent 是一个 AI Agent 桌面工作台。与 Claude Code、Pi 等工具类似，但核心差异在于**专注长任务管理和 SubAgent 并行执行的可视化**。

> **现状锦点（2026-06）**：愿景强调 SubAgent 并行可视化（P4 分屏/P5 任务树/P6 RPC 桥接仍在路上），实际已落地的差异化亮点是 **多 Session/Panel 工作台 + Session Tree/Fork 导航 + AgentRunBlock 过程折叠 + Markdown 增强 + Plugin 扩展骨架**。本文件描述的是愿景态，落地进度见 ARCHITECTURE.md + DESIGN-LOG.md。

产品要解决的核心问题：
1. 当 AI Agent 自动拆分出多个 SubAgent 并行工作时，用户如何直观地看到整体进度？
2. 当某个 SubAgent 需要用户确认时，如何在不影响当前工作流的情况下及时通知？
3. 当用户同时管理多个复杂任务时，如何快速切换上下文而不丢失状态？

成功标准是：用户可以在不离开当前工作上下文的情况下，掌控所有并行任务的执行状态。

## Brand Personality

**冷蓝暗色 · 开发者工作台**

> 视觉方向由 [ADR-0018](docs/architecture/adr/0018-visual-direction.md) 裁决（2026-06-18）：推翻早期 Warm & Soft 定位，收敛到 zcode-demo 冷蓝暗色。原子值 SSOT 见 [docs/page-design/design-tokens.md](docs/page-design/design-tokens.md)。

三个关键词：冷静、精准、可靠。

- **冷静**：冷暗画布（`#1a1b1f`，2026-07-09 提亮校准以减轻长时间用眼疲劳）+ 冷蓝 accent（`#4f8ef7`），贴近 Cursor / VS Code / Linear 的开发者工具直觉。Inter 字体、无衬线、tech-utility 取向。暗色为真默认（[ADR-0021](docs/architecture/adr/0021-default-theme-direction.md)）。
- **精准**：信息密度高但层次分明。三层视觉语义——base 平铺 / sidebar 透明融合 / main float 浮起——靠 background/border/radius/shadow 表达，不靠装饰堆砌。强调走 Card-Active 的 inset ring，禁止左色条。
- **可靠**：状态反馈即时且准确。运行中的 SubAgent 有实时圆点脉冲，完成的任务有清晰的完成标记，需要确认的告警有明显的视觉层级。SubAgent 并行可视化是核心差异化。

参考感受：Cursor 的冷峻高效、Linear 的精准克制、VS Code 的开发者熟悉感。不是 ChatGPT Web 的极简聊天，不是传统 SaaS 仪表盘的浮夸。

## Anti-references

- **不是传统 SaaS 仪表盘**：拒绝 big-number hero metrics、渐变文字、玻璃拟态卡片
- **不是 ChatGPT/Claude Web UI 的极简聊天**：我们需要展示 SubAgent 并行状态和任务树，不是单线对话
- **不是"黑底绿字"的粗糙极客感**：暗色是默认且优先打磨方向，但区别于终端绿字、高对比硬核 IDE——追求冷蓝精致的暗色，非刺眼粗糙的极客感
- **不是 openhanako 的日式书卷气**：参考其暖色调和低对比度方向，但摒弃纸质纹理、方正印章感、0.5px hairline 边框
- **不是 AI slop**：如果有人看界面能直接说"AI 做的"，就失败了。拒绝默认卡片网格、侧边彩色条纹、模态框作为第一选择

## Design Principles

1. **默认极简，渐进展开**
   默认只显示 Session 列表 + 对话区域。Tab 栏、右侧面板、抽屉都不常驻。更深层的 SubAgent 信息通过 Anchor 下拉切换 → 抽屉展示任务树 → Overview 全局鸟瞰，逐层展开。

2. **通知驱动，不打扰**
   让 Agent 来通知用户，而不是用户去翻找。Header 通知角标 → Toast 弹出 → 对话内联系统消息，三级通知层级按需触发。

3. **数据隔离，面板自洽**
   每个面板 + 它的抽屉是一个完整单元。左面板开右抽屉，右面板开左抽屉，抽屉只展示本面板的任务树。

4. **长时间使用不疲劳**
   这是高优先级。冷蓝暗色底（低亮度画布减少屏幕发光）、充足的留白、柔和的状态过渡（`--duration` 200ms）、无刺眼元素。暗色优先正是为此选择。每天 6 小时以上使用后，用户不应该感到视觉疲劳。

5. **状态即信任**
   每个 SubAgent 的状态变化都必须在 100ms 内反映在 UI 上。运行中、已完成、等待确认、已终止——每种状态都有独特且一致的视觉表达。

## Accessibility & Inclusion

- 暗色主题完整支持（不是反色，而是重新调色的 Dark 变体）
- 所有可交互元素有 hover/focus 状态
- 支持 `prefers-reduced-motion`：关闭圆点脉冲动画、简化过渡效果
- 状态圆点最低 opacity 0.35，保证可见性
- 对比度：Dark theme 的 `--fg` 与 `--bg` 比值 > 7:1

## 功能边界（已实现）

| 模块 | 关键能力 |
|------|----------|
| 多 Session/Panel | 按 cwd 分组、CRUD、切换、搜索；flat `.jsonl` 持久化；Panel↔Session 全局唯一绑定 |
| Session Tree | navigate/fork/clone（经 pi extension，leafId 指针移动） |
| Composer | contenteditable 富文本（slash chip / @mention / #file）、发送/steer/followUp 双队列、slash 命令浮层 |
| Slash 命令 | local（/clear /help）/ protocol（/compact）/ skill（/skill:\<name>）三类；CMD/SK tag 分类 |
| AgentRunBlock | 折叠渲染（thinking/tool 合并 MergeBlock，write/edit 独立卡片，chip 摘要条） |
| Markdown | Shiki 高亮 + 行号 + 复制 + 折叠、GFM 表格、KaTeX、Mermaid 懒加载、DOMPurify 净化 |
| Settings | Provider/Skill/Agent/System 四 tab；Skill/Agent 扫描导入四步流程；实时 WS 同步 |
| Plugin 系统 | Worker Thread 隔离、JSON-RPC 2.0、懒激活、KV 持久化 |
| Provider 管理 | API Key 增删改、默认模型、复用 pi 配置 |

## 非目标 / DEFERRED

**明确不做**：
- Markdown：LaTeX 实时编辑器、Mermaid 交互、代码块 diff 视图、图片渲染优化、代码块内搜索
- slash 命令：自然语言匹配（预留字段）、新增 ws 协议类型（复用已有）、Skill 管理（独立 SkillPane）
- Tree：Summarize(branch summary)、Label 编辑、直接写入 JSONL
- Agent 配置：OverrideParams、ToolPermissions（默认全部允许）
- 搜索：文件内容全文搜索（需 ripgrep 二进制，打包分发成本高）、符号搜索真实数据（需 LSP/tree-sitter，zero base）、危险命令分级与二次确认（当前无真正危险命令）、会话跳转进概览视图（只切换 active session）。`[from: 2026-06-30-search-modal §requirements §8]`
- 前端：原生 HTML 表单元素、Emoji、硬编码颜色、魔数间距
- 数据持久化：不引入 SQLite（用户配置/记录数据量极小，JSON + atomicWrite 足够；SQLite 引入原生依赖与 Electron 打包冲突）；不做跨机器同步（单机本地记录）；冷启动从空数据开始不做历史迁移（YAGNI，老用户升级代价低）。`[from: 2026-07-03-recent-workspaces §requirements §7]`
- 与 pi 的关系：不改 pi 侧任何东西（xyz-agent 数据目录 `~/.xyz-agent/` 与 pi `~/.pi/agent/` 完全隔离）；不清理 pi session 文件（xyz-agent 独立持久化解耦对 pi session 扫描的依赖）。`[from: 2026-07-03-recent-workspaces §requirements §7]`

**DEFERRED 到后续 Phase**：
- SubAgent 拆分/Tab/任务树（P5）、RPC 桥接交互式通信（P6）、Overview 全局鸟瞰（P4）、Drawer 右侧面板（P5）、分屏模式（P4）
- Plugin Phase 2+：完整 agentAPI、Pi 事件桥接、权限检查+Worker 沙箱、安装/卸载 UI、插件间通信隔离、热重载、脚手架 SDK
