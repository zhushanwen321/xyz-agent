---
verdict: pass
---

# E2E Test Plan — Chat Send Mode & Queue Display

## Test Scenarios

### TS-1: Mode Switcher 交互（AC1, AC2, AC3）
1. 点击 Mode Switcher 文字 → popover 展开
2. 选择 Steer → 文字变为 accent 色 "Steer · ⌘+Enter"
3. 选择 Follow-up → 文字变为 warning 色 "Follow-up · ⌥+Enter"
4. 选择 Send → 文字恢复 muted 色 "Send · Enter"
5. Ctrl+Enter 快捷键 → 切换到 Steer 并更新文字
6. Alt+Enter 快捷键 → 切换到 Follow-up 并更新文字
7. Enter 快捷键 → 切换到 Send 并更新文字

### TS-2: Send Chips（AC4, AC5）
1. 以 Steer 模式发送消息 → 用户消息时间戳旁显示橙色 "steer" chip
2. 以 Follow-up 模式发送消息 → 用户消息时间戳旁显示蓝绿色 "follow-up" chip
3. 以 Send 模式发送消息 → 无 chip 显示

### TS-3: Interrupted Marker（AC6）
1. AI 生成中点击停止按钮 → assistant 消息底部显示 "—— 已中断 ——" 标记
2. assistant 消息整体 opacity 降低

### TS-4: Queue Component（AC7, AC8, AC9）
1. AI 忙碌时发送 follow-up → Queue Component 出现，显示消息预览和 follow-up badge
2. AI 忙碌时发送 steer → Queue Component 新增 steer 条目
3. AI 处理完排队消息 → 条目从队列消失，消息出现在消息流中
4. 队列清空 → Queue Component 平滑收起
5. 队列全处理完 → 显示 "队列已完成" banner，3 秒后消失

### TS-5: Global Loading Bar（AC10, AC11）
1. AI 开始生成 → 顶部 3px accent 色条扫动动画
2. AI 空闲 → 条消失（高度归零）
3. 开启 prefers-reduced-motion → 静态半透明条，无动画

### TS-6: 窄面板响应式（AC1a, AC1b）
1. Split panel 50/50 → Mode Switcher 只显示模式名，无快捷键提示
2. Split panel 50/50 → Queue 退化为 "☰ N 条待处理" badge
3. 点击 badge → 展开完整队列

### TS-7: Steer/Follow-up RPC 改造验证
1. AI 生成中发送 follow-up → 不报错（之前会报 "Agent is already processing"）
2. AI 生成中发送 steer → 当前 turn 继续完成（不 abort），steer 在工具调用间隙注入
3. 发送 follow-up → 检查浏览器控制台有 queue_update 事件到达

## Test Environment

- 开发模式：`npm run dev`
- 需要连接真实的 pi 进程（非 mock 模式）
- 测试 steer/follow-up 需要触发较长的 AI 生成任务（如代码分析），以便在 AI 忙碌时操作
- prefers-reduced-motion 测试：macOS 系统设置 → 辅助功能 → 显示 → 减弱动态效果
- Split panel 测试：面板顶部 split 按钮
