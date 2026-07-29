# message-stream virtua/vue 迁移设计

完整设计文档：[design.md](./design.md)

## 这是什么

message-stream 组件从当前**手写虚拟滚动 + 两套打架的 scrollTop 写入者**（delta 补偿 vs RO scrollToBottom），迁移到 `virtua/vue` 库的架构设计文档。**仅设计，不含实现代码**。

## 关键决策一句话摘要

- 选 `Virtualizer`（非 `VList`），复用现有 `scrollEl`；follow 状态机自建（改造 `useChatScroll` → `useVirtuaFollow`）；streaming/editing pin 用 `:keepMounted`；展开保位靠 virtua `$fixScrollJump`（**删除 `scrollAdjustDelta` 整条通路**）；session 切换用 `<Virtualizer :key="sessionId">`（**删除 settling guard**）；rail jump 用 `scrollToIndex`；瞬时块仍在外层 absolute 定位；trace `<Transition>` JS hooks 保留 + `stickGuardPaused` 改计数器（修 P5）。

## 调研结论

virtua/vue（MIT, 0.50.0, 3635 stars, 2026-07-25 仍活跃维护）适合，方向 A 前提成立。Vue 绑定是一等公民，`Virtualizer` + `keepMounted` + `shift` + `scrollToIndex({align})` 覆盖全部需求，且内部已声明 `overflow-anchor: none`（消除潜在跳变源）。

## wave 划分（5 个，wave 5 可选）

Wave 0 依赖接入 → Wave 1 `useVirtuaFollow` 单测 → Wave 2 rail/pin/瞬时块向后兼容改造 → Wave 3 MessageStream.vue 核心切换 → Wave 4 删旧文件 → Wave 5（可选）批量收起串行化。详见 design.md §8。

## 最大风险

Transition 与 virtua RO 的交互（design.md §6.1）——需在 Electron 内手工验证 trace 收起瞬间的视口稳定性。
