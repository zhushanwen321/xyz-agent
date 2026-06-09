---
target: .xyz-harness/2026-06-07-chat-send-mode-design/spec.md
total_score: 24
p0_count: 0
p1_count: 3
timestamp: 2026-06-07T13-51-18Z
slug: z-harness-2026-06-07-chat-send-mode-design-spec-md
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Queue 可见性好；Global Loading Bar 与已有信号冗余 |
| 2 | Match System / Real World | 3 | Steer/Follow-up 保留英文是对的，但缺少新用户的心理模型引导 |
| 3 | User Control and Freedom | 3 | 模式自由切换；队列"清除"按钮的后端行为未定义 |
| 4 | Consistency and Standards | 2 | Mode Switcher 三段式和 Queue Component 都是设计系统中不存在的新模式 |
| 5 | Error Prevention | 2 | Steer 无确认直接打断生成；队列清除无确认 |
| 6 | Recognition Rather Than Recall | 3 | Send Chip 让历史消息可追溯；队列让 pending 可见 |
| 7 | Flexibility and Efficiency | 3 | 键盘快捷键保留，点击替代路径增加 |
| 8 | Aesthetic and Minimalist Design | 2 | Global Loading Bar 是第三个 AI 状态信号；Queue 区域视觉密度高 |
| 9 | Error Recovery | 1 | 被中断消息无恢复路径；队列清除不可逆 |
| 10 | Help and Documentation | 2 | i18n key 定义了但 Mode Switcher 无 tooltip 解释各模式含义 |
| **Total** | | **24/40** | **Acceptable — 需要改进后才能达到设计系统的标准** |

---

## Anti-Patterns Verdict

**LLM assessment**: 整体不构成 AI slop。spec 的 ASCII wireframe 风格朴实、决策表有理有据。但有两个模式接近产品 register 的 reflex：

1. **三段式分段控制器** 是 iOS/SaaS 的默认"选择器"答案。对于一个只有 3 个选项、且默认 Send 占 90% 使用率的场景，一个全尺寸的三段按钮是过度设计。当前 `SendModeStatusBar` 的一行文字 + 快捷键提示反而更轻量。
2. **队列列表 + header + badge + 状态指示 + 清除按钮** 这个组合的信息密度偏高，在输入框上方这个黄金位置堆叠了过多元素。

**Deterministic scan**: 无发现（Markdown spec，非 markup）。不适用。

**Visual overlays**: 无（spec 文档，无浏览器目标）。

---

## Overall Impression

这份 spec 解决的三个问题都是真实的：模式发现难、队列不可见、AI 状态分散。问题诊断精确，功能边界清晰（Out of Scope 写得很好）。但解决方案在"输入框区域"这个最敏感的 UI 位置上叠加了太多新元素（Mode Switcher + Queue Component + Global Loading Bar），与设计系统的"Warm & Soft · 有温度的 AI 工作台"和"克制"原则产生了张力。

最大的机会：**重新审视三者的优先级和必要层级**。不是每个问题都需要一个持久化 UI 组件。

---

## What's Working

1. **问题诊断精确**。Background 的三个缺口分析是真实痛点，不是虚构需求。queue_update 事件已经存在于 chatStore 但没有 UI 消费方，这个 gap 被准确识别了。

2. **Send Chip 的设计决策**。普通 Send 不显示 chip（避免视觉噪音），steer 用 warning 色、follow-up 用 agent 色——语义色映射与设计系统一致。chip 放在时间戳旁而不是气泡内，不改变气泡尺寸，这是对的。

3. **键盘快捷键与点击的双路径**。没有因为加了 UI 就削弱键盘路径。Enter/Ctrl+Enter/Alt+Enter 保持不变，UI 只增加可发现性。

---

## Priority Issues

### [P1] Mode Switcher 对分屏窄面板缺少响应式策略

**What**: spec 画出了一整行 `[ Send | Steer | Follow-up ] [Model] [Thinking ▴] [▌32%] [↑12.4k/↓3.2k] [↑发送]`，但在 split panel 模式下宽度可能只有 ~400px。当前 InputToolbar 在窄面板下已经很紧凑，再加一个三段式选择器会挤压其他元素或导致换行。

**Why it matters**: xyz-agent 的 split panel 是核心使用模式（同时看两个 session）。工具栏在窄面板下溢出 = 每次发送都要水平滚动或丢失功能可见性。

**Fix**: Mode Switcher 应该有压缩态。当宽度不足时，退化为一个单按钮 dropdown（显示当前模式 + 箭头），而非始终展开三段。或者在 spec 中明确响应式断点策略。

**Suggested command**: `/impeccable adapt`

### [P1] Global Loading Bar 与现有状态信号冗余

**What**: spec 说"不依赖各内部组件的 loading 动画（ThinkingBlock pulse / ToolCallCard spinner 保留不动）"——等于在消息流内部已有两套状态指示的同时，再加一个全局条。三套信号指向同一个事实："AI 在工作"。

**Why it matters**: 设计系统的"Aesthetic and Minimalist Design"原则要求每个元素都有不可替代的功能目的。Global Loading Bar 的信息增量是"AI 在工作"，这与已有的消息流内指示器完全重叠。对于长时间使用的场景（每天 6 小时），多一个持续运动的元素 = 多一份视觉疲劳源。

**Fix**: 两个方向（二选一）：
- (A) **去掉 Global Loading Bar**，依赖消息流内的 ThinkingBlock + ToolCallCard 指示。它们已经够用。
- (B) **保留但改为 conditionally aggressive**：只在 AI 超过 5 秒无任何 ThinkingBlock/ToolCallCard 输出时才出现，作为"卡住了"的信号而非默认状态。

**Suggested command**: `/impeccable distill`

### [P1] 队列"清除"按钮的后端行为和数据一致性未定义

**What**: FR4 的 Queue Component header 有 `[清除]` 按钮，但 Constraints 里说"WS 协议路由和事件处理已存在，本次仅做前端 UI"。清除操作是否发 WS 消息给 pi？pi 是否支持清空 `_followUpMessages[]` 和 `steering[]`？如果不通知 pi，前端清空后 pi 仍会继续处理队列，导致消息突然出现在消息流中（用户以为已清除但实际没有）。

**Why it matters**: 这不是 UI 细节，是功能正确性。一个"清除"按钮如果不能真正清除，比没有清除按钮更糟糕。

**Fix**: 如果 pi 不支持 `queue.clear` 命令，把"清除"按钮从 spec 中移除，改为只读展示。如果支持，在 spec 的 WS 协议表中补充 `message.queue_clear` 消息定义。

**Suggested command**: `/impeccable harden`

### [P2] Interrupted Marker 的数据来源未验证

**What**: FR3 说"被 steer 打断的 AI 消息底部显示中断标记"，但 spec 没有说明前端如何判断一条消息是"被中断"而非"正常结束"。pi 的 RPC 响应中是否有 `interrupted: true` 字段？还是前端需要通过"消息以 `...` 截断 + 下一条是 steer 用户消息"来推断？

**Why it matters**: 如果数据源不明确，实现时可能需要靠推测逻辑（fragile），或者这个功能根本无法可靠实现。

**Fix**: 在 spec 的 Constraints 或 Key Decisions 中补充：中断状态的数据来源是什么（pi event 字段 / 推断逻辑）。如果 pi 不提供此字段，将 FR3 降级为"nice-to-have"或移除。

**Suggested command**: `/impeccable clarify`

### [P2] Queue Component 与 WidgetDock 的布局切换造成视觉跳动

**What**: spec 说"Queue 有消息时，WidgetDock 小标签置于 queue list 尾部（右对齐）；Queue 为空时 WidgetDock 正常展示。" 这意味着当最后一条队列消息被处理时，WidgetDock 从 queue list 尾部跳到独立位置。如果有 WidgetDock 展开（目前 MAX_WIDGET_COLUMNS = 2），过渡更复杂。

**Why it matters**: 输入框上方是用户视线的高频经过区域。布局跳动打断输入节奏。

**Fix**: 统一 WidgetDock 位置：始终在 Queue Component 下方（或上方），不管队列是否有消息。Queue 为空时该区域只有 WidgetDock；有消息时 Queue 展开但 WidgetDock 不移动。

**Suggested command**: `/impeccable layout`

---

## Persona Red Flags

### Alex (Power User)

- **三段式按钮是减速带**。Alex 90% 的时间用 Send，不需要一个显眼的三段选择器占据工具栏空间。当前 `SendModeStatusBar` 一行灰色小字更符合 power user 的期望：需要时扫一眼，不需要时忽略。三段式按钮把 10% 使用频率的模式提到了和 90% 模式同等的视觉权重。
- **Queue Component 占用输入区上方空间**。Alex 高频发送，Queue 的 header + list 推高了输入框位置，减少了消息流可见面积。对于通常只有 0-1 条排队消息的场景，一个完整的列表组件过于重量级。
- **无键盘快捷键管理队列**。spec 没有定义用键盘操作队列的方式（如 Esc 清除队列）。Alex 只能靠鼠标点清除。

### Jordan (First-Timer)

- **"Steer" 和 "Follow-up" 术语无 inline 解释**。Mode Switcher 只显示标签文字，没有 tooltip 或简短描述告诉 Jordan "Steer = 打断当前回答" / "Follow-up = 排队等回答完再处理"。i18n 表里有中文翻译（"中断发送"/"排队发送"），但 spec 没有指定 tooltip 展示哪个文案。
- **队列 widget 的脉冲点（pulsing dot）含义不明确**。Jordan 看到 `◌` 符号但不知道它在"等待"什么。需要 `aria-label` 或 tooltip 辅助。

### Sam (Accessibility-Dependent User)

- **Mode Switcher 三段式按钮的焦点管理未定义**。三个 `<button>` 之间的焦点顺序、选中状态的 `aria-pressed` 标记、焦点样式都没有在 spec 中指定。
- **Global Loading Bar 使用 `aria-hidden="true"`**，但这意味着屏幕阅读器用户完全无法感知 AI 状态。如果保留这个组件，需要提供替代的 ARIA live region。

---

## Minor Observations

1. **i18n key 重复**：`queue.pending` 出现了两次（"N 条消息待处理" 和 "待处理"），key 相同但含义不同。需要拆分为 `queue.pendingCount` 和 `queue.itemPending`。

2. **spec 的 FR1 wireframe 与实际 InputToolbar 不匹配**：wireframe 展示 `[↑发送]` 用箭头，但实际代码中空闲态是 `↑` SVG 图标，流式态是 `■` 停止符号。spec 应标注发送按钮形态不变（Constraints 里已提及，但 wireframe 应更准确）。

3. **Send Chip 的 `chip.steer` 和 `chip.followup` 使用英文**，这是好的决策（Key Decisions 表已说明理由）。但 `section.steer` / `section.followup` 的用途不明——在哪个 UI 位置使用这些 key？spec 没有标注。

4. **Queue Component 的 `queue.done` banner**（"队列已完成 · N 条已处理"）会在所有队列消息处理完后显示。这个 banner 何时消失？永不？5 秒后？spec 没有说明。

5. **spec 的 `verdict: draft`** 前置标记是正确的。但在进入 plan 阶段前，建议补充一个"Open Questions"章节，把上述数据来源问题（中断标记、队列清除）列为阻塞性疑问。

---

## Questions to Consider

- Send 模式占 90% 使用率。把 Send/Steer/Follow-up 放在同等视觉权重上，是否会让用户高估 Steer 和 Follow-up 的使用频率？一个"当前是 Send，点击可切换为 Steer 或 Follow-up"的单入口会不会更克制？

- 如果去掉 Global Loading Bar（只保留消息流内的指示器），用户真的会"不知道 AI 在工作"吗？还是说 ThinkingBlock 的 pulse 和 ToolCallCard 的 spinner 已经足够？

- 队列通常有 0-1 条消息。为一个大多数时候为空的数据结构设计一个持久的 header + list 组件，是否值得？能不能在输入框旁边显示一个简单的 badge（如 `1 follow-up pending`），点击展开详情？

---

**Trend for `z-harness-2026-06-07-chat-send-mode-design-spec-md`: First run for this target, no trend yet.**
