---
verdict: pass
---

# 业务用例 — streaming-collapse-clarify

## UC-1: 用户折叠查看 Agent 操作过程

- **Actor**: xyz-agent 用户
- **Preconditions**: 用户已开启"折叠 Agent 操作过程"设置
- **Main Flow**:
  1. 用户发送消息给 AI
  2. AI 回复过程中，streaming 消息以单行紧凑气泡显示（状态文字 + 耗时）
  3. 用户可选择点击气泡查看完整 streaming 内容
  4. AI 回复完成后，消息自动切换为折叠模式：文本内容正常显示，thinking/toolCall 折叠为 summary bar
  5. 用户点击 chip 查看某类操作的详细列表
  6. 用户点击操作行查看完整输出（ToolCallCard/ThinkingBlock 组件渲染）
- **Alternative/Exception Paths**:
  - 用户关闭设置 → 恢复原始 section 渲染模式
  - 消息只有文本无操作 → 不显示 summary bar，直接显示文本
  - 操作超过 8 条 → 显示"还有 N 个"，点击就地展开
- **Postconditions**: 用户获得高信噪比的对话视图，操作过程按需可查
- **Module Boundaries**: 渲染逻辑在 Vue 组件层（AssistantContent → CompactSummaryBar/CompactStreamingBubble），数据来自 Pinia store，不涉及 sidecar 或 Electron 主进程

## UC-2: 用户快速定位历史操作

- **Actor**: xyz-agent 用户
- **Preconditions**: 已有多轮对话，compactStreaming 已开启
- **Main Flow**:
  1. 用户滚动浏览历史对话
  2. 每条已完成消息的 thinking/toolCall 被折叠为 summary bar（一两行）
  3. 用户通过 chip 标签快速识别消息包含的操作类型（思考、read、edit、bash...）
  4. 用户点击感兴趣的 chip 展开操作行
  5. 用户点击具体操作行查看完整输出
- **Postconditions**: 用户快速定位到目标操作，无需在大量 section 块中逐个翻找

## 覆盖映射表

| UC | 覆盖 AC |
|----|---------|
| UC-1 | AC-1, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8 |
| UC-2 | AC-2, AC-3, AC-4, AC-5, AC-6, AC-8 |
