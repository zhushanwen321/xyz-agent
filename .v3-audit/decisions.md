# v3 审查裁决记录

> 日期：2026-06-21
> 原则：长期合理、架构合理。优先长期方案，标注短期兜底。

## DEC-01 · SessionItem 激活标识方向（对应 RC-10）

**问题**：SessionItem 激活态，sidebar/spec.md（左竖条+bg-elevated）与 draft-session-item.html §4（弃左竖条用 inset ring）冲突。

**裁决：分层处理**

| 组件 | 激活标识 | 依据 |
|---|---|---|
| **SessionItem（列表项）** | inset accent ring + bg-elevated（删左竖条） | draft §4 裁决，列表项语境 |
| **Panel（工作主区）** | 保留四层（左竖条 + inset ring + bg + opacity） | workspace/spec.md 论证 + W09 确认 |

**理由**：
- 列表项有明确行边界，inset ring + bg 足够指示激活，左竖条+亮底是 AI slop 反模式（draft §4 论证成立）
- 工作主区需要最强焦点信号，左竖条（实色锚点）与 inset ring（半透明内描边）协同不冗余，四层各有职责
- 语境不同 → 激活强度不同，有语义依据

**落地动作**：
1. SessionItem.vue：删 absolute 左竖条 span，改 `ring-1 ring-inset ring-accent`（激活态）
2. sidebar/spec.md §会话项：更新激活标识描述对齐 draft §4
3. Panel 激活标识不动

---

## DEC-02 · Composer min-height 40 vs 56

**问题**：design-system.md §4 说 56px，draft-composer-states.html CSS 实际 40px，实现 40px。

**裁决：以 draft 为准（40px），无需改代码**

**理由**：
- draft（Composer 专属详细稿）权威性高于 design-system.md（通用原语层）
- draft CSS 值经设计验证，是最终视觉稿
- design-system.md 的 56 可能是早期值或 Textarea 原语通用推荐

**落地动作**：
1. 代码不改（实现已与 draft 一致）
2. design-system.md §4：更新为"Textarea 原语默认 40px，Composer 场景沿用，如需更大可 class 覆写"
3. W02 BUI-TA-02 判定修正：偏差 → 非偏差（design-system.md 文档待更新）

---

## DEC-03 · Composer S6 死胡同 UI

**问题**：isStreaming 时输入区可用（能打字）但 Enter 被阻止（不能发送），placeholder 误导"按停止中断"。死胡同 UI，P0 阻断。

**裁决：长期方案 B（实现 steer），短期兜底 A 变种**

**长期方案 B**：
- ⏎ 在 isStreaming 时触发 `rt.steer()`（排队引导，不打断当前回合）
- Alt+⏎ 触发 `rt.followup()`（开新一轮）
- 这是设计原意，彻底消除死胡同，兑现 v3 steer 护城河功能
- 设计明确："steer 提交本身不受 abort 问题影响，可以实施"

**短期兜底（后端 steer RPC 未就绪时）**：
- isStreaming 时禁用输入区（`disabled`，消除死胡同）
- placeholder 改为中性"AI 工作中…"（消除"按停止中断"的误导，因为停止按钮已明确可见）
- 不保留"能打字不能发"的半吊子状态
- 后端 steer RPC 就绪后切换到方案 B

**不选方案 C（等 G-019）的理由**：死胡同是 P0 阻断，用户体验持续受损，不能等整个 G-019（含 followup/双队列/pending 气泡）一起做。steer 提交是最小可实施单元。

**落地动作**：
1. 先确认后端 steer RPC 是否就绪（查 pi RPC 是否支持 steer 命令）
2. 若就绪 → 直接实现方案 B（steer ⏎ 提交 + accent ring + placeholder 对齐设计）
3. 若未就绪 → 实施短期兜底（禁用输入 + placeholder 修正），并登记 TODO 等 RPC

---

## 裁决影响追踪

| 裁决 | 影响的 wave/条目 | 状态变更 |
|---|---|---|
| DEC-01 | W07 SB-L3-03（SessionItem 激活态） | ⚠ → 待修（删竖条改 ring） |
| DEC-01 | W09 WP-L2-03（Panel 激活态） | 不变（Panel 保留四层） |
| DEC-02 | W02 BUI-TA-02（Textarea min-height） | ⚠偏差 → 非偏差（文档待更新） |
| DEC-02 | W12 WP-L3-17（Composer 输入中态 min-height） | 待澄清 → 已裁决（40px 为准） |
| DEC-03 | W12 WP-L3-20（Composer S6 死胡同） | P0 待修（方案 B 或兜底） |
