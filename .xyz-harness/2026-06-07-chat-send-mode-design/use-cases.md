---
verdict: pass
---

# Use Cases — Chat Send Mode & Queue Display

## UC-1: 用户通过 UI 切换发送模式

**Actor:** 用户
**Preconditions:** 聊天面板打开，输入框可见
**Main Flow:**
1. 用户看到输入框上方显示当前模式 "Send · Enter"
2. 用户点击文字区域
3. Popover 展开显示三个选项
4. 用户选择 "Steer"
5. Popover 关闭，文字更新为 accent 色 "Steer · ⌘+Enter"
6. 用户输入消息并 Enter 发送
7. 消息以 steer 模式发出，消息气泡显示 steer chip

**Alternative Paths:**
- 2a. 用户使用 Ctrl+Enter 快捷键直接切换 → 跳到步骤 5
- 4a. 用户点击 popover 外部 → popover 关闭，模式不变

**Postconditions:** 当前发送模式已切换，后续发送使用新模式
**Module Boundaries:** SendModeStatusBar → ChatInput → server.ts → rpc-client → pi

## UC-2: 用户在 AI 忙碌时发送 follow-up 消息

**Actor:** 用户
**Preconditions:** AI 正在生成回复（isGenerating=true）
**Main Flow:**
1. 用户切换到 Follow-up 模式（Alt+Enter 或 UI 点击）
2. 用户输入消息并发送
3. 前端发送 `message.follow_up` WS 消息给 runtime
4. Runtime 调用 `sessionService.followUpMessage()` → `client.followUp()` → pi `follow_up` RPC
5. pi 将消息排入 `_followUpMessages[]`，触发 `queue_update` 事件
6. 前端收到 `queue_update`，Queue Component 展示排队消息
7. AI 完成当前 turn，处理 follow-up 消息
8. `queue_update` 更新，消息从队列移除
9. 消息出现在消息流中，带 follow-up chip

**Alternative Paths:**
- 4a. Session 不活跃 → runtime 报错，前端显示错误提示
- 8a. 队列全部处理完 → 显示 "队列已完成" banner，3 秒后消失

**Postconditions:** follow-up 消息被 AI 处理，消息出现在消息流中
**Module Boundaries:** ChatInput → server.ts → session-service → rpc-client → pi → event-adapter → useChat → chatStore → QueueComponent

## UC-3: 用户在 AI 忙碌时发送 steer 消息

**Actor:** 用户
**Preconditions:** AI 正在生成回复（isGenerating=true）
**Main Flow:**
1. 用户切换到 Steer 模式（Ctrl+Enter 或 UI 点击）
2. 用户输入消息并发送
3. 前端发送 `message.steer` WS 消息给 runtime
4. Runtime 调用 `sessionService.steerMessage()` → `client.steer()` → pi `steer` RPC
5. pi 将消息排入 `_steeringMessages[]`，触发 `queue_update` 事件
6. 前端收到 `queue_update`，Queue Component 展示 steer 条目
7. AI 在下一个工具调用间隙处理 steer 消息（不 abort 当前 turn）
8. `queue_update` 更新，消息从队列移除
9. 消息出现在消息流中，带 steer chip

**Postconditions:** steer 消息在工具调用间隙被注入，当前 turn 继续完成
**Module Boundaries:** 同 UC-2

## UC-4: 用户 abort AI 生成

**Actor:** 用户
**Preconditions:** AI 正在生成回复
**Main Flow:**
1. 用户点击停止按钮（或触发 `message.abort`）
2. Runtime 调用 `sessionService.abort()` → `client.abort()` → pi `abort` RPC
3. Pi 中止当前生成，`message.complete` 事件带 `stopReason: 'aborted'`
4. event-adapter 转发 stopReason 给前端
5. useChat.onComplete 读取 stopReason
6. chatStore.completeStream 设置 `isInterrupted: true`
7. MessageBubble 渲染 Interrupted Marker（"—— 已中断 ——"）
8. 消息整体 opacity 降低

**Postconditions:** AI 停止生成，消息标记为已中断
**Module Boundaries:** ChatInput → server.ts → session-service → rpc-client → pi → event-adapter → useChat → chatStore → MessageBubble

## UC-5: 窄面板下的模式切换与队列展示

**Actor:** 用户
**Preconditions:** Split panel 已开启，单个 panel 宽度 < 520px
**Main Flow:**
1. 用户看到 Mode Switcher 只显示当前模式名（无快捷键提示）
2. 用户点击模式名 → popover 展开（功能不变）
3. 用户发送 follow-up → Queue 退化为 "☰ N 条待处理" badge
4. 用户点击 badge → 展开完整队列（overlay）
5. AI 处理完 → badge 消失

**Postconditions:** 窄面板下所有功能可用，只是形式简化
**Module Boundaries:** SendModeStatusBar + QueueComponent + container query CSS

## Coverage Matrix

| UC | AC |
|----|----|
| UC-1 | AC1, AC2, AC3, AC4, AC5 |
| UC-2 | AC5, AC7, AC8, AC9 |
| UC-3 | AC4, AC7, AC8, AC9 |
| UC-4 | AC6 |
| UC-5 | AC1a, AC1b |
