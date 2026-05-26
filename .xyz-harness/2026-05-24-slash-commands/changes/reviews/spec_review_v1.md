---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-24T22:00:00"
  target: ".xyz-harness/2026-05-24-slash-commands/spec.md"
  verdict: fail
  summary: "计划评审完成，第1轮，4条MUST FIX，需修改后重审"

statistics:
  total_issues: 6
  must_fix: 4
  must_fix_resolved: 0
  low: 1
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR1/FR2/FR3/FR4"
    title: "缺少 WS 消息协议规格表"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR3"
    title: "Extension sendMessage 结果拦截机制未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "spec.md:FR6/FR3"
    title: "Extension 加载失败无检测和回退机制"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: MUST_FIX
    location: "spec.md:FR3"
    title: "sendMessage 异步结果缺少超时处理"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "spec.md:通用"
    title: "未覆盖 VITE_MOCK 模式的 mock 数据"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "spec.md:Complexity Assessment"
    title: "风险点已识别但未转化为 AC 或需求约束"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录

- 评审时间：2026-05-24 22:00
- 评审类型：计划评审（spec 完整性）
- 评审对象：`.xyz-harness/2026-05-24-slash-commands/spec.md`

---

## 1. Six-element 覆盖度检查

| 要素 | 状态 | 说明 |
|------|------|------|
| **Outcomes（目标）** | ✅ 明确 | Background 清晰地描述了问题（pi TUI 有 tree/fork/clone 但 xyz-agent GUI 没有）和目标（在 GUI 中支持 session 分支结构查看、历史节点导航、从历史节点创建分支）|
| **Scope boundaries（范围）** | ✅ 明确 | Constraints 章节和"不在范围"列表清晰地划定了边界——Summarize、Label 编辑、/resume、/new、/name、直接写入 JSONL 都不在第一版范围内 |
| **Constraints（约束）** | ✅ 完整 | 技术约束（不改 pi 源码、JSONL 只读、leafId 内存状态、Extension 结果必须主动 sendMessage）和已有基础设施都清楚列出 |
| **Decisions made（决策）** | ⚠️ 隐式 | 多数决策（Extension 方案而非修改 pi、扁平+条件缩进而非全树展开）有描述但未明确记录决策理由。特别是"为什么用 Extension 方案"只说"不改 pi 源码"而未说明这是否是唯一方案。非 MUST FIX 级别，但 plan 阶段应该补充 |
| **Task breakdown（任务分解）** | N/A | spec 级别不需要完整 task breakdown，FR1-FR6 按功能模块划分，粒度合理 |
| **Verification（验证）** | ✅ 合格 | AC1-AC6 覆盖了主要功能路径。详见第 2 节 |

---

## 2. Acceptance Criteria 可测试性分析

| AC | 可测试性 | 说明 |
|----|---------|------|
| AC1 | ✅ 可测试 | 5 条 criteria 均为具体行为验证，包括边缘情况（孤儿节点、未 flush 文件）|
| AC2 | ✅ 可测试 | 视觉和行为描述具体（点击展开/关闭、缩进规则、颜色、label 标签、filter 按钮、操作栏），通过截图对比或 Playwright 可验证 |
| AC3 | ✅ 可测试 | 调用链步骤清晰，每个环节可独立验证（sidecar 发送的 RPC、extension handler 触发、结果回传、前端渲染、no-op、错误提示）|
| AC4 | ✅ 可测试 | sidebar 新增、自动切换、输入框预填、旧 session 不受影响——均可写 E2E 测试 |
| AC5 | ✅ 可测试 | 简单直接，sidebar 新增 |
| AC6 | ✅ 可测试 | 启动参数、命令列表、不影响其他功能 |

**整体评价**：AC 质量高，每一条都指向可验证的行为。**但 AC 覆盖了"正常路径"，未覆盖所有关键失败路径**（见第 4 节）。

---

## 3. 模糊术语检查

未发现未标注的模糊术语。所有术语在上下文中都有明确含义：

- "type 图标（U/A/S）"——User/Assistant/System，标准 pi 术语
- "绿色脉冲点"——视觉描述，足够 css 实现
- "扁平列表为主，只有分叉点才缩进"——行为描述清晰
- "branch count badge"——标准 UI 模式

无明显需要 `[AMBIGUOUS]` 标记的术语。

---

## 4. 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | **MUST FIX** | spec.md:FR1/FR2/FR3/FR4 | **缺少 WS 消息协议规格表**。FR1 定义 `session.tree-data`，FR3 定义 `session.tree-navigate`，FR4 定义 `session.tree-fork`，但 spec 没有给出任何消息的完整 payload schema。这导致 sidecar 和前端实现者依赖各自理解，极易产生兼容性断裂。 | 新增一个"WS 消息协议"章节，定义所有新增消息类型的 payload schema，包括请求/响应/推送的方向、字段名和类型、可选必选标记。关键消息：`session.tree-data`（推送）、`session.tree-navigate`（请求）、`session.tree-fork`（请求）、navigate 结果回传（推送）。 |
| 2 | **MUST FIX** | spec.md:FR3 | **Extension `sendMessage()` 结果拦截机制未定义**。FR3 中 `ctx.sendMessage()` 产生的输出会通过 pi RPC 事件流以正常 assistant 消息的形式发出（message_start → content_block_delta → message_stop）。spec 未定义 sidecar 如何在事件流中识别这是 navigate 结果（`__xyz_type: "navigate-result"`）而不是一条真实的 assistant 回复。如果 sidecar 不拦截，navigate 结果会被当作普通消息插入聊天记录，产生 DB 混乱。 | 在 FR3 调用链中明确：sidecar 的 RPC event adapter 必须在处理 content_block_delta 时检测 `__xyz_type` 标记，将 navigate 结果路由到 trees 而非 chat store。同时说明：因为 navigate 不触发 LLM 调用（`summarize: false`），`sendMessage()` 会产生 `input_json` block 而非 `text` block，需要验证 `message.content[0].type === "input_json"` 才能解析。**建议：先写独立验证脚本** 确认 RPC 事件流中 navigate 结果的实际格式（参见 CLAUDE.md 规则 #4）。 |
| 3 | **MUST FIX** | spec.md:FR6/FR3 | **Extension 加载失败无检测和回退机制**。spec 定义 pi 通过 `--extension xyz-agent-extension.js` 加载 extension。但如果 pi 启动时未配置该参数、extension 文件路径错误、或 `registerCommand` 抛出异常，`xyz-navigate` 命令将不存在。此时 navigate 功能会静默失败——用户点击 Navigate 后 sidecar 发送 prompt，pi 返回"unknown command"，且没有错误提示。 | 在 FR6 中增加：（1）sidecar 启动后通过 `get_commands` RPC 验证 `xyz-navigate` 是否在返回的命令列表中（source 应为 "extension"）；（2）验证失败时 sidecar 应输出 error log 并阻止前端展示 tree 面板的 navigate 按钮；（3）前端检测到 navigate 功能不可用时，tree 节点的操作栏不应显示 Navigate 选项（或显示"Extension 未加载"灰色状态）。 |
| 4 | **MUST FIX** | spec.md:FR3 | **`sendMessage()` 异步结果缺少超时处理**。Complexity Assessment 的风险点 #2 明确写道"Extension sendMessage() 的结果到达时间不确定，需要超时处理"，但 AC3 中没有对应的超时验收条件，FR3 的调用链也没有提到超时阈值和超时后的行为。如果 navigate 请求发出后 extension runner 挂起或 `navigateTree` 因某种原因不返回，前端会永远卡在等待状态。 | 在 FR3 中明确：sidecar 发送 `/xyz-navigate` prompt 后启动一个超时计时器（建议 5s），超时后（1）取消 pending 请求；（2）向前端发送错误消息；（3）在 UI 中显示"Navigate 超时"提示。AC3 增加一条："Navigate 超时场景：延时应显示错误提示，UI 不卡死"。 |
| 5 | **LOW** | spec.md:通用 | **未覆盖 VITE_MOCK 模式的 mock 数据**。项目 CLAUDE.md 声明 `VITE_MOCK=true` 环境变量在 ws-client 层拦截。但 spec 只描述了真实 pi 调用链，没有提供 mock 数据供 mock 模式下开发/测试使用。开发者在 mock 模式下无法独立验证前端树面板 UI。 | 建议在 spec 中补充 mock data 格式说明，或至少在 plan.md 中增加 mock 适配 task。 |
| 6 | **INFO** | spec.md:Complexity Assessment | **风险点已识别但未转化为 AC 或需求约束**。Complexity Assessment 列出了 3 条主要风险点：（1）JSONL 未 flush；（2）sendMessage 到达时间不确定；（3）Navigate 后前端刷新。其中（1）在 AC1 有覆盖，但（2）和（3）没有转化为任何 AC 或 FR 中的约束。**注意到 spec 作者已经意识到这些问题，但修补缺位。** | 将风险点（2）转化为 AC 超时条件（见 #4），风险点（3）转化为明确的刷新时序描述（先清空 → 加载树数据 → 按树节点重新渲染消息 → 更新 leaf 指针）。 |

---

## 5. 与项目 CLAUDE.md 架构约束的一致性

| CLAUDE.md 规则 | 一致性 | 说明 |
|---------------|--------|------|
| 规则 #1: emit 只传单个 payload | ✅ 一致 | `session.tree-navigate { sessionId, targetEntryId }`——单对象 payload |
| 规则 #4: 外部系统对接先验证 | ❌ **遗漏** | FR6 的 extension 和 FR3 的 navigate 调用链涉及 pi 的 RPC 协议。Spec 未要求先写独立验证脚本确认 RPC 事件流中 `sendMessage()` 结果的格式。由于 navigate 使用 `summarize: false`，`sendMessage` 产生的是 `input_json` block 而非常规 `text` block，格式差异需要验证。**建议：在 plan 或 FR 中补充 "先写 tools/verify-navigate-rpc.cjs 验证 RPC 事件流格式" 的步骤。** |
| 规则 #5: pi 适配层不信任外部格式 | ⚠️ 部分覆盖 | Spec 定义了 Extension 的输出格式（`__xyz_type: "navigate-result"`），但未定义 sidecar 如何在 RPC 事件流中解析此格式。实际落地时 sidecar 必须按 #5 规则不信任外部格式，但由于 #2 提到的拦截机制未定义，此规则无法被遵守。 |
| 规则 #6: Session 隔离 | ✅ 一致 | 所有 WS 消息都携带 `sessionId` |
| 前端编码规范: 禁止原生 HTML | N/A | spec 不定义具体 HTML 元素 |
| 前端编码规范: 禁止 Emoji | N/A | spec 描述"绿色脉冲点"——css 实现即可 |

---

## 6. 数据流单点故障分析

### Navigate 调用链故障点

```
Frontend WS → [ws drop - no recovery] → Sidecar RPC → [extension not loaded] → pi navigateTree → sendMessage() → [timeout - no fallback] → RPC events → [intercept undefined] → Frontend
```

| 故障点 | 覆盖率 | 风险 |
|--------|--------|------|
| WS 连接中断 | ❌ 未覆盖 | 任何 WS 消息丢失时无重试/队列机制。需要确认项目是否已有 WS 重连队列 |
| Extension 未加载 | ❌ 未覆盖 | 见 MUST FIX #3 |
| sendMessage 未返回 | ❌ 未覆盖 | 见 MUST FIX #4 |
| RPC 事件流解析错误 | ❌ 未覆盖 | 见 MUST FIX #2 |

### Fork 调用链故障点

```
Frontend WS → Sidecar RPC fork → [fork fails - no error format] → get_state → Frontend
```

- `fork` RPC 失败时的错误格式未定义。pi 的 `fork` 命令在输入不合法（如 entryId 不存在）时如何返回错误？spec 没有定义 sidecar 如何处理 fork 失败。**建议：在 FR4 中补充 fork 错误场景处理。**

### Tree 数据读取故障点

```
Sidecar read .jsonl → [file not exist / empty] → build tree
```

- AC1 覆盖了"未 flush"场景（空文件），但未覆盖"文件被并发写入时读取到不完整行"的场景。pi 写入 JSONL 不是原子操作（append line），sidecar 读取时可能读到不完整的最后一行。
  **影响：** 不完整行会导致 `JSON.parse` 抛异常，当前未有 try-catch 兜底。**建议：在 FR1 中说明 sidecar 读取 JSONL 时需 try-catch 逐行解析，跳过格式错误的行。**

---

## 结论

**需修改后重审。** 4 条 MUST FIX 问题：

1. **缺少 WS 消息协议规格表** — 无 schema 定义，sidecar 和前端会各自解读
2. **`sendMessage()` 结果拦截机制未定义** — navigate 结果会混入聊天消息流
3. **Extension 加载失败无检测和回退** — navigate 功能可能静默失效
4. **缺少 `sendMessage` 超时处理** — 已识别的风险点未转化为 AC

重点关注问题 #2：这是架构层面的 gap——`sendMessage()` 的输出会走 pi RPC 的完整事件流（message_start / content_block_delta / message_stop），sidecar 必须知道如何从正常聊天消息中区分出 navigate 结果。这是一个在 spec 层面就应该定义的边界条件，而不应留给实现者去探索。

建议：先写 `tools/verify-navigate-rpc.cjs` 独立验证脚本确认 RPC 事件流中 navigate 结果的实际格式（遵循 CLAUDE.md 规则 #4），再将验证结果反馈回 spec 的调用链描述。

## Summary

计划评审完成，第1轮，4条MUST FIX，需修改后重审
