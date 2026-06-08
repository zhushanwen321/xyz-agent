---
verdict: pass
---

# Non-Functional Design: AgentRunBlock

## 1. 稳定性

改动集中在渲染层（message-layout.ts + 新组件），不触及数据层（useChat.ts、event-adapter.ts、shared types）。风险点：MergeBlock streaming 的 setInterval 计时器必须在组件卸载时清理，否则内存泄漏。通过 Vue 的 `onUnmounted` 钩子清理即可。

compactStreaming=false 时完全走现有路径，新代码不会执行。设置变更只影响后续消息的分组逻辑，不回溯修改已渲染的消息。

## 2. 数据一致性

不适用。本次改动不涉及数据存储变更。standaloneTools 通过 Pinia persist 插件写入 `~/.xyz-agent/config.json`，复用现有 settings 的持久化机制。分组逻辑是纯函数（输入 contentBlocks + standaloneTools → 输出 sections），无副作用，无并发问题。

## 3. 性能

分组逻辑 `groupByContentBlocks` 对每个 contentBlock 做 O(1) 查找（isMergeBlock 内部 find 是 O(n)，但 toolCalls 数组通常 ≤50，可忽略）。可在实现时预构建 `toolCalls` 的 Map（refId → ToolCall）优化为 O(1)。

MergeBlock streaming 的 setInterval(1000) 只在 streaming 状态存在，complete 后清除。同时存在的 timer 最多 1 个。

50+ contentBlocks 的极端场景：分组遍历 O(50)，渲染 O(50) 个组件。每个 MergeBlock 内部的展开/折叠用 v-if 控制子组件，折叠时不挂载 ThinkingBlock/ToolCallCard，性能无压力。

## 4. 业务安全

不适用。本次改动不涉及权限控制或敏感数据处理。standaloneTools 设置项只影响 UI 展示方式，不影响 Agent 执行逻辑或数据安全。

## 5. 数据安全

不适用。不涉及敏感信息处理。文件路径显示在 StandaloneToolCard 中是 Agent 已有行为，不引入新的信息暴露。
