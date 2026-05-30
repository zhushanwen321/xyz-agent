---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-30T22:15:00"
  target: ".xyz-harness/2026-05-30-statusline-design/spec.md"
  verdict: fail
  summary: "Spec 评审第 1 轮，4 条 MUST FIX（数据流歧义、chip 路由规则缺失、thinking level 映射不一致、model picker 行为未定义），需修改后重审"

statistics:
  total_issues: 10
  must_fix: 4
  low: 3
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-1, FR-2, AC-1"
    title: "setStatus 数据流路径歧义：两条并行通道未指定前端主通道"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md:AC-5"
    title: "Session Strip vs Global Statusbar 的 chip 路由规则缺失"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "spec.md:FR-3 (Thinking level picker)"
    title: "Thinking level 6 级定义与现有 ModelInfo.thinkingLevelMap 类型不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "spec.md:FR-3 (Model picker)"
    title: "Model picker 选择后的生效机制未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md:FR-6"
    title: "updateStatusBarItem 新增参数的向后兼容性未声明"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "spec.md:FR-4 (Cost)"
    title: "Cost 数据来源 chatStore.cost 的计算和存储逻辑未说明"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "spec.md:FR-5, AC-4"
    title: "commandId 对应的命令注册和执行机制未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "spec.md:Constraints"
    title: "bridge:event 修复在 Constraints 提到但无对应 FR"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: INFO
    location: "spec.md:AC-1"
    title: "AC-1 '1 秒内'的性能要求缺乏自动化验证方法"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: INFO
    location: "spec.md:FR-2"
    title: "statusline plugin 对 setStatus 文本的解析规则未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-30 22:15
- 评审类型：计划评审（Spec 完整性审查）
- 评审对象：`.xyz-harness/2026-05-30-statusline-design/spec.md`

## 评审维度与方法

本次评审聚焦方法论第 1 项「spec 完整性」，按六元素逐项检查：

| 六元素 | 判定 | 说明 |
|--------|------|------|
| Outcomes（目标/成果） | ✅ 通过 | 目标清晰：打通 pi extension setStatus → 前端的数据管道，新增 3 个 UI 组件 |
| Scope boundaries（范围边界） | ✅ 通过 | 有明确的 In/Out（setWidget 不实现、Quota bars 不实现） |
| Constraints（约束） | ✅ 通过 | 技术栈、编码规范、不可修改 pi extension 等约束明确 |
| Decisions（关键决策） | ⚠️ 部分缺失 | 有关键架构决策，但 4 处决策点缺乏定义（见 MUST FIX #1-#4） |
| Verification（验证标准） | ⚠️ 部分缺失 | AC-1 到 AC-6 覆盖主要 FR，但 AC-5 的 chip 路由规则未定义导致不可测试 |
| Business cases（业务用例） | ✅ 通过 | UC-1 到 UC-4 覆盖 4 个典型场景，包含 split panel 边界场景 |

---

## 逐项检查

### 1. 目标明确性 ✅

一段话能说清楚：打通 pi extension setStatus 与 xyz-agent plugin statusBarUpdate 两条数据通道，通过 InputToolbar / SessionStrip / GlobalStatusbar 三个 UI 组件呈现运行时状态。

### 2. 范围合理性 ✅

- In scope: 7 个 FR（FR-1 到 FR-7），从 event-adapter 修复到前端组件到文档
- Out of scope 明确列出：setWidget、Quota bars
- 粒度适中，没有过大或过小的问题

### 3. 验收标准可测试性 ⚠️

大部分 AC 可测试，但存在 2 个问题：

**AC-5 信息不重复**："每个 extension status chip 在 Session Strip（per-session）或 Global Statusbar（全局）二选一显示，不同时出现"——路由规则未定义，无法写测试验证。详见 MUST FIX #2。

**AC-1 第 3 条**："前端通过 `extension.status_update` 消息类型接收数据"——如果数据统一走 plugin 通道，前端应接收 `plugin:statusBarUpdate`，此 AC 描述与架构图矛盾。详见 MUST FIX #1。

### 4. [待决议] 项 ⚠️

Spec 没有显式 `[待决议]` 标记，但存在 4 处隐含的待决议（MUST FIX #1-#4）。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spec.md:FR-1, FR-2, AC-1 | **数据流路径歧义**：FR-1 说 event-adapter 将 setStatus 翻译为 `extension.status_update` 广播到前端；FR-2 说 statusline built-in plugin 通过 hooks 接收后再转发为 `plugin:statusBarUpdate`。AC-1 第三条说"前端通过 `extension.status_update` 消息类型接收数据"。两条路径并存，但未指明前端的主通道是哪个。若两条同时存在则数据重复，若只走一条则 AC 描述错误。此外，`extension.status_update` 使用点号格式，不符合 CLAUDE.md 中 Server→Client 的冒号+camelCase 命名约定（现有 `plugin:statusBarUpdate` 是正确格式）。 | 明确唯一数据流路径。建议：event-adapter 翻译 setStatus 后**仅**发送到 plugin hooks（不直接广播到前端），由 statusline plugin 转发为 `plugin:statusBarUpdate`，前端统一监听 `plugin:statusBarUpdate`。删除或修正 AC-1 第三条。 |
| 2 | MUST FIX | spec.md:AC-5 | **chip 路由规则缺失**：AC-5 要求"每个 extension status chip 在 Session Strip（per-session）或 Global Statusbar（全局）二选一显示，不同时出现"，但没有任何规则定义什么条件下 chip 去 Session Strip、什么条件下去 Global Statusbar。无路由规则 = AC 不可验证 = 无法写测试。 | 在 FR-4 或 FR-5 中定义 chip 路由规则。例如：有 sessionId 关联的 per-session chip → Session Strip；无 sessionId 关联的全局 chip → Global Statusbar。或者按 key 定义映射表。 |
| 3 | MUST FIX | spec.md:FR-3 | **Thinking level 6 级与现有类型不一致**：FR-3 定义了固定 6 级 thinking level（off / minimal / low / medium / high / xhigh）。但代码库中 `ModelInfo.thinkingLevelMap` 的类型是 `Record<string, string \| null>`（`src-electron/shared/src/provider.ts:38`），这是一个**模型相关**的映射表（key 是级别名，value 是对应参数值或 null），而非固定的 6 级枚举。不同模型可能有不同级别的 thinking level。Spec 的固定 6 级定义与现有类型冲突，且未说明这 6 级如何映射到各模型的实际参数。 | 将 FR-3 的 thinking level picker 改为动态读取 `ModelInfo.thinkingLevelMap` 的 keys 作为可选级别。删除固定的 6 级枚举。如果 6 级是业务决策，需在 spec 中说明如何对齐各模型 thinkingLevelMap 的差异。 |
| 4 | MUST FIX | spec.md:FR-3 | **Model picker 选择后行为未定义**：FR-3 说 Model picker"点击展开下拉选择"，但没有定义选择新模型后如何生效。是否发送 RPC 命令到 pi？哪个 RPC 命令？是否需要重启 session？是否影响当前对话？这是 Input Toolbar 的核心交互之一，缺少行为定义将导致实现分歧。现有 `providerStore` 有 `models: ModelInfo[]`（模型列表）可用，但 session 级别的模型切换机制未定义。 | 新增一段说明 model 切换的完整行为：(1) 切换方式（RPC 命令名或通过 sidecar 中转），(2) 切换后对当前 session 的影响（是否需要新建 session、是否仅影响后续请求），(3) 失败时的回退策略。如果 pi 暂不支持 runtime 模型切换，应将 Model picker 降级为"仅显示"功能，在 spec 中标记 `[待决议]`。 |
| 5 | LOW | spec.md:FR-6 | **向后兼容性未声明**：FR-6 扩展 `updateStatusBarItem()` RPC 参数，新增 `tooltip`、`commandId`、`priority`（均为 optional）。但未声明对现有 plugin 的向后兼容性保证。现有 plugin 调用 `updateStatusBarItem(id, text)` 不传新参数时是否正常工作？ | 在 FR-6 补充一句："新增参数均为 optional，现有 plugin 不传新参数时行为不变，默认 priority=100。" |
| 6 | LOW | spec.md:FR-4 | **Cost 数据来源不明确**：FR-4 说 Session Strip 显示"本次 session 累计费用"，数据来源为 `chatStore(cost)`。但当前 chatStore 中是否有 cost 字段？如果需要新增，数据从哪获取（pi `get_state` 的 token 用量 × 模型定价？还是 pi 直接返回费用？）？建议明确 cost 的计算方式。 | 补充 cost 的数据来源说明。如果是已有字段，注明现有代码位置。如果需要计算，说明计算公式和数据源。 |
| 7 | LOW | spec.md:FR-5, AC-4 | **commandId 机制未定义**：AC-4 说"有 commandId 的 chip 可点击触发命令"。但 commandId 对应的命令在哪里注册？是 pi 的 slash command？是 xyz-agent 的自定义 command？点击后的执行路径是什么？ | 在 FR-5 或 FR-6 中补充 commandId 的注册和执行机制说明。如果是 Phase 2+ 功能，标记 `[待实现]`。 |
| 8 | INFO | spec.md:Constraints | **bridge:event 修复无对应 FR**：Constraints 中提到"本次同时修复 `server.ts` 中 `bridge:event` 只打日志不调用 `pluginService.handleBridgeEvent()` 的问题"。验证代码确认：`server.ts:715-720` 的 `bridge:event` case 确实只 `console.log` 后返回空响应，未调用 `pluginService.handleBridgeEvent()`。但这个修复没有对应的 FR 条目，仅作为 Constraint 旁注存在。建议为基础设施修复增加一个 FR 或将 FR-1 范围扩展为"接通 setStatus 数据管道 + 修复 bridge:event 路由"。 | 将 bridge:event 修复纳入 FR-1 或新增 FR-1a。 |
| 9 | INFO | spec.md:AC-1 | **"1 秒内"缺乏自动化验证方法**：AC-1 说"前端 Global Statusbar 在 1 秒内显示对应文本"。跨进程通信（pi → sidecar → WS → 前端渲染）延迟难以在自动化测试中精确测量。建议改为定性描述（如"setStatus 事件到达前端后立即渲染"），或将性能要求移到非功能性需求章节。 | 改为"setStatus 事件到达前端后在下一个渲染帧内显示"或直接去掉时间约束（数据流本身就是实时推送）。 |
| 10 | INFO | spec.md:FR-2 | **setStatus 文本解析规则未定义**：FR-2 说 statusline plugin"解析 pi extension 输出的 setStatus 文本（如 goal 的 '◆ Goal 3/20 \| 2/5 tasks'）"，Complexity Assessment 也承认"文本格式不固定"。但没有定义解析规则或容错策略——是正则匹配特定格式？还是直接透传原始文本？如果解析失败怎么处理？如果是纯透传（最简单的方案），则 FR-2 中"解析"一词有误导性。 | 明确策略：(A) 纯透传文本，不做解析（推荐，最简方案，FR-2 中的 "解析" 改为 "提取"）；或 (B) 定义解析规则和 fallback。 |

---

## 架构一致性检查

| CLAUDE.md 架构规则 | Spec 合规性 | 说明 |
|---|---|---|
| **规则 5：pi 适配层不信任外部格式** | ✅ | event-adapter 是唯一适配点，翻译 setStatus 为内部格式 |
| **规则 7：所有消息必须带 sessionId** | ⚠️ | FR-1 的 payload 包含 `sessionId` ✅，但 FR-2 的 plugin hooks 是否传递 sessionId 未说明 |
| **规则 11：Plugin Service 是唯一适配层** | ⚠️ | 如果 event-adapter 直接广播 `extension.status_update` 到前端，绕过了 PluginService，可能违反此约束。需确认数据流路径 |
| **WS 命名约定：Server→Client 用冒号** | ❌ | `extension.status_update` 用点号，违反 `plugin:statusBarUpdate` 的冒号约定 |
| **数据目录隔离（~/.xyz-agent/ vs ~/.pi/）** | ✅ | statusline plugin 作为 built-in plugin 存放在 `resources/plugins/`，不涉及 pi 数据目录 |
| **前端编码规范** | ✅ | Constraints 中明确引用了 xyz-ui、Tailwind、行数上限等规范 |

---

## FR ↔ AC 覆盖矩阵

| FR | AC | 覆盖状态 | 备注 |
|----|-----|---------|------|
| FR-1: Event-adapter 接入 setStatus | AC-1 | ⚠️ | AC-1 第 3 条描述可能与实际数据流路径矛盾（见 MUST FIX #1） |
| FR-2: statusline built-in plugin | AC-1 | ⚠️ | AC-1 覆盖了端到端结果，但 FR-2 内部的解析规则未定义（见 INFO #10） |
| FR-3: Input Toolbar | AC-2 | ⚠️ | AC-2 覆盖了 UI 展示，但 thinking level 映射和 model picker 行为缺失（见 MUST FIX #3, #4） |
| FR-4: Session Strip | AC-3 | ✅ | AC-3 覆盖完整 |
| FR-5: Global Statusbar 重构 | AC-4 | ⚠️ | AC-4 覆盖了展示，但 commandId 执行机制未定义（见 LOW #7） |
| FR-6: Plugin statusBarUpdate 增强 | 无独立 AC | ❌ | FR-6 无对应 AC。tooltip/commandId/priority 的功能如何验证？ |
| FR-7: Built-in Plugin 开发指南 | AC-6 | ✅ | AC-6 覆盖完整 |
| — | AC-5（信息不重复） | ⚠️ | 跨 FR 的全局约束，但路由规则缺失导致不可测试（见 MUST FIX #2） |

---

## 数据流可行性分析

### 完整管道：pi extension → plugin → frontend

```
pi extension (goal/todo/...)
  │ ctx.ui.setStatus("goal", "◆ Goal 3/20 | 2/5 tasks")
  ▼
pi RPC: extension_ui_request { method: "setStatus", key: "goal", text: "..." }
  │
  ▼
event-adapter.ts (sidecar)
  │ 翻译为 ServerMessage type: "extension.status_update"
  │ payload: { sessionId, key, text }
  ▼
??? 歧义点 ???
  ├── 路径 A: server.ts 直接广播到前端 → 前端监听 extension.status_update
  └── 路径 B: server.ts → pluginService.handleBridgeEvent()
              → statusline plugin hooks.onPiEvent('setStatus')
              → api.ui.updateStatusBarItem()
              → plugin-service 广播 plugin:statusBarUpdate
              → 前端监听 plugin:statusBarUpdate
```

**问题**：
1. **路径 A vs B 未选定**：Spec 同时描述了两条路径但没有指明哪条是主通道
2. **路径 A 违反 WS 命名约定**：`extension.status_update` 用点号
3. **路径 B 依赖 bridge:event 修复**：`server.ts:715-720` 当前 bridge:event 只打日志，Constraints 提到修复但无对应 FR
4. **FR-2 说 plugin "附加 metadata"**：priority/tooltip 从何而来？pi extension 的 setStatus 只有 (key, text)，没有 priority 和 tooltip。statusline plugin 需要一个映射表（如 goal → priority=10, tooltip="Goal progress"）或规则来生成这些 metadata，但 spec 未定义

---

## 结论

**需修改后重审**。

Spec 的整体方向正确（打通两条数据通道、统一 UI 展示），架构图清晰，业务用例覆盖充分。但存在 4 个 MUST FIX 级别的问题，主要集中在：

1. **数据流核心路径未收敛**——两条并行通道并存但未选定主通道
2. **AC 可测试性不足**——chip 路由规则和 thinking level 映射缺失导致对应 AC 无法写测试
3. **关键交互行为缺失**——Model picker 选择后的生效机制未定义

建议修改后重新提交评审。

### Summary

Spec 评审完成，第 1 轮，4 条 MUST FIX，需修改后重审。
