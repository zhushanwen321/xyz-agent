---
verdict: pass
---

# E2E Test Plan — streaming-collapse-clarify

## Test Scenarios

### TS-1: 设置开关回归
- 关闭 compactStreaming → 聊天完全使用 section 渲染（ThinkingBlock + ToolCallCard 在 AssistantSection 内）
- 开启 compactStreaming → completed 消息使用 summary bar

### TS-2: Completed 消息折叠渲染
- 有 thinking + toolCalls 的 completed 消息 → 显示 summary bar + chips
- 只有 text 无 thinking/toolCalls → 不显示 summary bar，直接显示文本
- 点击 chip → 展开该类型操作行，操作行内渲染 ToolCallCard/ThinkingBlock
- 点击已展开 chip → 收起该类型
- 点击 summary bar 空白 → 展开/收起全部类型
- 多个 chip 同时选中 → 各自类型独立展开

### TS-3: 操作行 ToolCallCard/ThinkingBlock 渲染
- thinking 操作行展开 → 渲染 ThinkingBlock 组件（非纯文本）
- toolCall 操作行展开 → 渲染 ToolCallCard 组件（含 tool renderer）
- autoExpandThinking=false → 操作行内的 ThinkingBlock 默认收起
- autoExpandToolCalls=false → 操作行内的 ToolCallCard 默认收起

### TS-4: Overflow 就地展开
- 同一 toolName 超过 8 条调用 → 显示前 8 条 + "还有 N 个"
- 点击 "还有 N 个" → 该类型全部操作行展开
- 再次点击 → 收回为前 8 条（如需双向切换）

### TS-5: Streaming bubble 自动收回
- streaming 中点击 bubble → 展开完整 MessageBubble
- streaming 结束 → bubble 自动消失，消息切换为 CompactSummaryBar
- 不点击 bubble → streaming 结束后直接切换为 CompactSummaryBar

### TS-6: Lint 验证
- `npm run lint` → 0 errors, 0 warnings

## Test Environment
- `npm run dev` 启动 Electron + Vite HMR
- 在系统设置中开启 compactStreaming
- 发送需要 tool call 的消息（如让 AI 读文件），观察 streaming 和 completed 状态
