---
verdict: pass
---

# Streaming 折叠模式 — Agent 操作过程折叠

## Background

用户在使用 xyz-agent 的过程中，AI 助手的每条回复可能包含大量 thinking 块和 tool call 操作（read/edit/bash/grep/write 等）。在 GUI 界面中，这些操作的视觉重量过大，导致：

1. **视觉疲劳（花眼）** — 大量 section 缩进块 + 彩色边框 + 文本，长时间使用后眼睛容易疲劳
2. **信息密度失衡** — 用户最关心的 text 输出被淹没在 thinking/toolCall 的视觉噪声中
3. **长对话难以扫视** — 几十轮对话后，每个 turn 都包含多个操作块，用户无法快速定位关键内容

### 已有基础设施

- **`stores/settings.ts`** — 已有 `autoExpandThinking`、`autoExpandToolCalls` 两个聊天显示设置
- **`components/chat/ThinkingBlock.vue`** — 现有 thinking 块组件，支持单行 toggle + 可展开内容
- **`components/chat/ToolCallCard.vue`** — 现有 tool call 卡片组件，支持单行 toggle + 可展开内容 + tool renderer
- **`lib/message-layout.ts`** — `groupIntoSections()` 将消息内容按 thinking/toolCall/text 分组
- **`components/settings/SystemPane.vue`** — 聊天显示设置 UI
- **`components/panel/ChatPanel.vue`** — 主聊天面板，管理消息列表 + streaming 消息渲染

### 参考 Demo

- `docs/designs/chip-expand-demo.html` — 最终确认的交互原型
- `docs/designs/views_chat-collapse-demo-B.html` — Summary Chip 方案参考

## Functional Requirements

### FR-1: 设置开关

新增 `compactStreaming` 开关（默认关闭），位于系统设置 → 聊天显示 → "折叠 Agent 操作过程"。

- 开关描述："将 Thinking/ToolCall 合并为摘要标签"
- 与 `autoExpandThinking` / `autoExpandToolCalls` 的关系：`compactStreaming=true` 时，这两项不生效（因为 thinking/toolCall 不再以 section 方式渲染）
- 持久化到 localStorage（已有 persist 机制）

### FR-2: Completed 消息折叠

当 `compactStreaming=true` 且消息已完成（`status === 'complete'`）时：

- 不渲染 `groupedIntoSections()` 产生的 thinking/toolCall section
- 改为渲染 **Summary Bar**（灰色边框条），包含：
  - "过程" 标签（10px uppercase muted）
  - 聚合 chip（pill 形状），每种操作类型一个：
    - Thinking → 紫色/terracotta pill，显示 "思考 N" + 耗时
    - 同一 toolName 的 tool call → 绿色 pill，显示 "toolName N"
  - chevron 箭头（点击展开/收起全部 detail）
- 文本内容（`message.content`）**始终正常渲染**，不受折叠影响
- summary bar 下方的 block groups 区域：
  - 点击 chip → 展开该类型的所有独立操作行
  - 每个操作行显示：`● toolName 路径 耗时`
  - 点击操作行 → 展开该操作的完整输出
  - 多个 chip 可同时选中（AND 关系）

### FR-3: Streaming 消息折叠

当 `compactStreaming=true` 且消息正在 streaming 时：

- 不渲染 `<StreamingMessage>`（现有全量渲染）
- 改为渲染 **Compact Streaming Bubble**（单行小气泡）：
  - 左侧脉冲圆点（accent 色呼吸动画）
  - 中间状态文字，按优先级从以下推导：
    1. thinking 活跃中 → "思考中..."
    2. toolCall 运行中 → "toolName 路径"
    3. 有文本内容 → 前 60 字预览
    4. 无内容 → "等待响应..."
  - 右侧耗时
  - 点击 → 展开为完整 `<MessageBubble :is-streaming="true" />`（复用现有渲染链）

### FR-4: 交互模型

| 触发 | 效果 |
|------|------|
| 点击 chip | 展开/收起该类型的所有操作行 |
| 点击操作行 | 展开/收起该操作的完整输出。展开后**复用 `ToolCallCard` / `ThinkingBlock` 组件**渲染完整内容，内部遵循 `autoExpandThinking` / `autoExpandToolCalls` 设置 |
| 点击 summary bar 空白/chevron | 展开/收起所有类型 |
| 点击 streaming bubble | 展开/收起完整 streaming 消息 |
| streaming 结束（`status === 'complete'`） | 自动收回 streaming bubble，切换为 CompactSummaryBar（已完成消息的折叠模式） |
| 多个 chip 同时激活 | AND 关系 |

### FR-5: Overflow 处理

- 单个 tool call 类型的操作数超过 8 条时，只展示前 8 条，底部显示 "还有 N 个"。**点击后就地展开该类型全部操作行**（去掉 8 条上限），再次点击收回为前 8 条
- 操作类型过多时（chip 数量超过 4 种），自动截断展示前 4 个 chip + "+N more" overflow chip。点击 "+N more" 展开所有 chip
- Chip 上的数值统一显示 tool call 调用次数

## Acceptance Criteria

1. [ ] 设置页面出现 "折叠 Agent 操作过程" 开关，可正常开关
2. [ ] 开关关闭时，聊天行为完全不变（回归）
3. [ ] 开关开启时，已完成消息显示 summary bar + chips，不显示 section 结构
4. [ ] 点击 chip 展开对应的操作行，再点收起
5. [ ] 点击操作行展开完整内容，再点收起
6. [ ] 点击 summary bar 空白区域展开/收起全部
7. [ ] streaming 消息显示为单行紧凑气泡，点击展开完整视图
8. [ ] 文本内容始终正常渲染
9. [ ] lint 0 errors, 0 warnings on new files

## Constraints

- **前端渲染进程** — Vue 3 + TypeScript + Pinia + Tailwind CSS v3
- **数据源不可变** — 不修改 `Message` / `ToolCall` / `ThinkingBlock` 类型定义
- **不破坏现有模式** — 所有改动通过 `compactStreaming` 开关控制，关闭时完全回归
- **复用现有渲染链** — 展开 streaming bubble 时复用 `MessageBubble` + `AssistantContent`；操作行展开时复用 `ToolCallCard` / `ThinkingBlock` 组件（含 tool renderer），**不做纯文本降级**
- **不修改 useChat.ts 全局事件处理器** — 所有改动在组件层

## Complexity Assessment

- **修改范围**：5 个文件（2 新 + 3 改）
- **核心逻辑**：chip 聚合 + 两层展开交互（Vue reactive Set + computed）
- **风险点**：与现有 `autoExpandThinking` 设置的交互语义需要清晰
- **估计工时**：2-3 天（1 天核心逻辑 + 1 天 UI 打磨 + 0.5 天测试验证）

## 当前实现状态

| 组件/文件 | 状态 | 说明 |
|-----------|------|------|
| `stores/settings.ts` | ✅ Done | + `compactStreaming: ref(false)` + persist |
| `components/settings/SystemPane.vue` | ✅ Done | + Toggle 行 |
| `components/chat/CompactSummaryBar.vue` | ✅ Done | 完整实现，含芯片聚合 + block group + 行展开 |
| `components/chat/CompactStreamingBubble.vue` | ✅ Done | 完整实现，含状态推导 + 脉冲动画 + 展开 |
| `components/chat/AssistantContent.vue` | ✅ Done | + compact 模式条件分支 |
| `components/panel/ChatPanel.vue` | ✅ Done | + compact streaming bubble 条件渲染 |
| **验证/测试** | ❌ Missing | 未在 dev 环境验证；无单元测试 |
| **Tool renderer 集成** | ❌ Missing | 当前操作行展开显示纯文本 body，需改为复用 `ToolCallCard` / `ThinkingBlock` 组件 |

## Out of Scope

- 会话历史回溯兼容（已保存的 session 历史消息的渲染兼容性）
- 动画过渡（展开/收起时的平滑动画）

## Open Questions

## Resolved Ambiguities

1. ✅ compactStreaming 展开后的各 block 遵循 `autoExpandThinking` / `autoExpandToolCalls` 设置
2. ✅ "+N more" overflow 在 v1 实现
3. ✅ Chip 数值统一用 tool call 调用次数
4. ✅ 操作行展开复用 `ToolCallCard` / `ThinkingBlock` 组件（不做纯文本降级）
5. ✅ overflow "还有 N 个" 点击后就地展开该类型全部操作行
6. ✅ streaming bubble 在 streaming 结束时自动收回为 CompactSummaryBar
