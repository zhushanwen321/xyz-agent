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

产品要解决的核心问题：
1. 当 AI Agent 自动拆分出多个 SubAgent 并行工作时，用户如何直观地看到整体进度？
2. 当某个 SubAgent 需要用户确认时，如何在不影响当前工作流的情况下及时通知？
3. 当用户同时管理多个复杂任务时，如何快速切换上下文而不丢失状态？

成功标准是：用户可以在不离开当前工作上下文的情况下，掌控所有并行任务的执行状态。

## Brand Personality

**冷蓝暗色 · 开发者工作台**

> 视觉方向由 [ADR-0018](docs/architecture/adr/0018-visual-direction.md) 裁决（2026-06-18）：推翻早期 Warm & Soft 定位，收敛到 zcode-demo 冷蓝暗色。原子值 SSOT 见 [docs/designs/design-tokens.md](docs/designs/design-tokens.md)。

三个关键词：冷静、精准、可靠。

- **冷静**：纯黑画布（`#0d0d0f`）+ 冷蓝 accent（`#4f8ef7`），贴近 Cursor / VS Code / Linear 的开发者工具直觉。Inter 字体、无衬线、tech-utility 取向。暗色为真默认（[ADR-0021](docs/architecture/adr/0021-default-theme-direction.md)）。
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
