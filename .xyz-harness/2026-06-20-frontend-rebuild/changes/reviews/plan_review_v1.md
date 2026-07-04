---
review:
  type: plan_review
  round: 1
  timestamp: "2026-06-20T16:00:00"
  target: ".xyz-harness/2026-06-20-frontend-rebuild/plan.md (+ plan-frontend.md / e2e-test-plan.md / use-cases.md / non-functional-design.md)"
  verdict: pass
  summary: "计划评审完成，第1轮通过，0条MUST FIX，3条SHOULD_FIX（v1范围点+类型来源+命名一致性），3条NIT"

statistics:
  total_issues: 6
  must_fix: 0
  must_fix_resolved: 0
  low: 3
  info: 3

issues:
  - id: 1
    severity: LOW
    location: "plan.md: Spec Coverage Matrix + Task List (T2.2/T1.4)"
    title: "⌘[/⌘] 后退/前进快捷键为 spec §8.5 Round 3 adopted 的 v1 功能，但 plan 无显式 Task 覆盖、矩阵无对应行"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "plan-frontend.md §2: chat.streamSubscribe 签名 (c: StreamChunk) => void"
    title: "StreamChunk 类型在 shared/ 中不存在（已验证），接口契约引用了未定义来源的类型"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan-frontend.md §2 domains/chat (send) vs use-cases.md UC-2 (api.chat.sendMessage)"
    title: "chat 域方法命名跨文档不一致：plan-frontend 用 send，use-cases 用 sendMessage"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: INFO
    location: "plan.md: Execution Groups 各 Group Subagent 字段"
    title: "Subagent 配置仅写 general-purpose ×2，未指定 Model（skill 检查项含 Model）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: INFO
    location: "plan.md: FG1 Subagent 字段 'general-purpose ×2（backend-dev TDD + reviewer）'"
    title: "FG1 标注 backend-dev 语义歧义：本项目 L1 纯前端，FG1 是 api/transport 层（R4），非后端 endpoint"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "plan-frontend.md §1 File Structure"
    title: "文件路径前缀不统一：部分带 renderer/src/，部分仅写 composables/ 或 components.json"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-06-20 16:00
- 评审类型：计划评审（模式一）
- 评审对象：plan.md 主纲 + plan-frontend.md（File Structure + Interface Contracts）+ e2e-test-plan.md + use-cases.md + non-functional-design.md
- 评审维度：spec 完整性 / plan 可行性 / spec-plan 一致性 / Execution Groups / 接口契约 / AC 覆盖矩阵 / Spec Metrics Traceability / DEFERRED 排除 / TDD 与文件路径

### 评审依据核对（已验证）

| 验证项 | 方法 | 结果 |
|--------|------|------|
| shared/ 类型存在性 | `rg` 扫描 `src-electron/shared/src/` | `SessionSummary`✅ `ClientMessage`✅ `ServerMessage`✅ `Message`✅ `PanelTree`✅ `SessionStatus`✅ `MessageStatus`✅；`StreamChunk`❌ 不存在 |
| 五层铁律一致性 | 对照 spec §3 vs plan Task 分组 | features 唯一跨 api+stores✅ stores 不互 import（矩阵 §6.4 有 lint 检查）✅ lib 无业务✅ |
| v1 范围覆盖 | spec §8.5 逐项 vs plan Task | 主聊天流/session 切换创建/基础空态/Overview 进出/auto-scroll/⌘N 均覆盖；**⌘[/⌘] 缺失**（见 issue #1） |
| DEFERRED 排除 | spec §9 27 项 vs plan | Metrics Traceability 有 "§9 DEFERRED 27 项 \| postponed" 行，plan 未覆盖，符合预期✅ |

---

## 一、spec 完整性 ✅

- **目标明确**：一段话可说清（从零重建 renderer，照设计稿落地，mock 优先，联调推迟）
- **范围合理**：§2 In/Out-of-scope 边界清晰，§8.5 v1 收敛 + §9 27 项 DEFERRED 完整记录
- **AC 可量化**：§6 整体验收 5 项均可机器验证（`npm run dev`、`VITE_MOCK=true` 跑通、`rg` 检查、`lint`+`vue-tsc`）
- **待决议项**：`[AMBIGUOUS] Summary 契约`已标记，Traceability 标 postponed，处理规范

## 二、plan 可行性 ✅

- **Task 粒度**：21 个 Task（T0.1-T6.2），每 Task 对应一个 subagent 可独立完成的文件集（≤4 文件），粒度适中，非 TDD 微步骤
- **依赖关系**：依赖图与 Wave 编排自洽（Wave1 FG0+FG1 并行 → Wave2 FG2 → Wave3 FG3+FG4 → Wave4 FG5 → Wave5 FG6），无循环依赖
- **工作量**：greenfield ~50 文件，7 Group，估算现实
- **遗漏检查**：见 issue #1（⌘[/⌘]），其余 v1 in-scope 全覆盖

## 三、spec-plan 一致性 ✅（1 处 v1 功能点归属未明，见 issue #1）

Spec Coverage Matrix 覆盖 §6.1-§6.5、UC-1/2/3、§8.5（基础空态/Overview/auto-scroll）。逐条核对无悬空引用。`[AMBIGUOUS] Summary 契约` 在 Traceability 标 postponed，处理规范。

## 四、Execution Groups 合理性 ✅

| Group | Tasks | Files | ≤10? | 类型 | 依赖 |
|-------|-------|-------|------|------|------|
| FG0 | 3 | ~5 | ✅ | 前端基础 | 无 |
| FG1 | 4 | ~9 | ✅ | 前端 api 层 | 无（与 FG0 并行） |
| FG2 | 2 | ~4 | ✅ | 前端 | FG0 |
| FG3 | 4 | ~6 | ✅ | 前端 | FG2+FG1 |
| FG4 | 3 | ~8 | ✅ | 前端 | FG2 |
| FG5 | 4 | ~8 | ✅ | 前端 | FG4+FG1 |
| FG6 | 2 | ~4 | ✅ | 前端 | FG5+FG3 |

- 文件数全部 ≤10 ✅
- 无混合类型 Group（全前端；FG1 虽标 backend-dev 但实质是前端 api 层，见 issue #5）
- 同组 Task 功能关联紧密 ✅
- Wave 内并行无文件冲突（FG3 改 sidebar/、FG4 改 workspace/+panel/，不重叠）✅
- 每组含 Agent/注入上下文/读取文件/修改文件 ✅（Model 缺失，见 issue #4）
- 上下文引用具体文档（design-tokens.md / ADR / spec 决策编号），不含糊 ✅

## 五、接口契约审查

**AC 覆盖矩阵**：spec §6 全部 5 项 AC + UC-1/2/3 + §8.5 主要项均有矩阵行 ✅。**唯一缺口**：⌘[/⌘]（spec §8.5 Round 3 adopted）无矩阵行（issue #1）。

**类型引用**（已验证 shared/）：
- `SessionSummary` `ClientMessage` `ServerMessage` `Message` `PanelTree` `SessionStatus` `MessageStatus` → 均存在于 shared/，非臆造 ✅
- `StreamChunk` → **shared/ 无此类型**（issue #2）
- `NavEntry` `DerivedStatus` → plan-frontend.md §4 / D6 明确为前端自定义 ✅

**数据流链**（plan-frontend.md §3）：UC-2 发送、UC-3 切换、连接态三条链路方法名均可追溯到 §2 签名表 ✅（chat 域 send/sendMessage 命名分歧见 issue #3）。

## 六、Spec Metrics Traceability ✅

D1-D7 全部 adopted 且映射到具体 Task；§9 DEFERRED 27 项 postponed；`[AMBIGUOUS]` postponed。无悬空指标。

## 七、TDD / 文件路径 / 无占位符 ✅

- Task 用 `- [ ]` checkbox 语法 ✅
- 文件路径在 plan-frontend.md §1 File Structure 具体到文件（路径前缀不统一见 issue #6）
- 接口签名表是设计契约（方法名+参数类型+返回类型），非实现代码，符合 skill 豁免 ✅
- 无 TODO/FIXME/placeholder 占位 ✅
- e2e-test-plan.md 分层策略（L1 单测/L2 组件/L3 契约/L4 人工视觉）+ TS-1~7 场景 + vitest 强制 + fake timers 规范，符合 CLAUDE.md 测试规范 ✅

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | SHOULD FIX | plan.md: Spec Coverage Matrix + Task List | **⌘[/⌘] 快捷键 v1 覆盖 GAP**。spec §8.5 Round 3（G3-003）明确 `⌘[`/`⌘]` 后退/前进 v1 做，归属 navigation store。plan navigation 接口已定义 `back/forward`（T1.4），但**无 Task 明确 keydown 监听→back/forward 的绑定归属**，Spec Coverage Matrix 也无对应行。use-cases.md UC-3 Alternative Paths 仅提 ⌘N，未提 ⌘[/⌘]。 | 二选一：(a) 在 T2.2（MainPanel view 路由）描述补"注册全局 ⌘[/⌘] keydown → navigation.back/forward"，并在矩阵补一行 `§8.5 ⌘[/⌘] 导航 \| navigation.back/forward \| keydown→nav \| T2.2/T1.4`；(b) 若倾向独立 composable（如 `composables/effects/useKeyboardNav.ts`），在 FG2 File Structure 补该文件并在 T2.2 引用。接口已就绪，补几行 glue code 即可，**不阻断**。 |
| 2 | SHOULD FIX | plan-frontend.md §2: chat.streamSubscribe 签名 | **StreamChunk 类型来源未定义**。签名 `(sessionId: string, h: (c: StreamChunk) => void) => () => void` 引用的 `StreamChunk` 在 `src-electron/shared/src/` 全目录搜索**不存在**（已验证，仅有 `message.stream_error` 事件类型和 `MessageStatus`，无 `StreamChunk`）。subagent 实现时不知该自定义还是引用 shared payload。 | 在 plan-frontend.md §2 或 §4 明确 StreamChunk 来源：(a) 给出前端自定义定义（如 `type StreamChunk = { sessionId: string; delta: string; status: MessageStatus }`）；或 (b) 引用 shared/protocol.ts 的 `message.stream_*` 事件 payload 类型并标注；或 (c) 显式标注"前端自定义类型，T1.2/T5.3 实现时定义"。避免契约悬空。 |
| 3 | SHOULD FIX | plan-frontend.md §2 domains/chat vs use-cases.md UC-2 | **chat 域方法命名跨文档不一致**。plan-frontend.md + plan.md Coverage Matrix 统一用 `chat.send(sessionId, text)`；use-cases.md UC-2 Main Flow step 3 写 `api.chat.sendMessage(sessionId, text)`。subagent 按不同文档实现会产生命名分歧。 | 统一为一个名称。建议统一用 `chat.send`（与 transport.send、session.switch 风格一致，更短）。修正 use-cases.md UC-2 step 3 的 `sendMessage` → `send`。 |
| 4 | NIT | plan.md: Execution Groups 各 Group Subagent 字段 | **Subagent Model 未指定**。每组写 `general-purpose ×2` 但缺 Model 字段（如 sonnet/haiku）。skill Execution Groups 检查项含 Model。 | 补 Model，如 `general-purpose/sonnet ×2`。可统一或在复杂 Group（FG5）用更强 model。 |
| 5 | NIT | plan.md: FG1 Subagent 字段 | **FG1 标注 backend-dev 语义歧义**。字段写 `general-purpose ×2（backend-dev TDD + reviewer）`，但本项目 complexity=L1 纯前端，FG1 是 api/transport 层（R4），无后端 endpoint。backend-dev 标注可能误导 subagent 引入后端假设。 | 改为 `general-purpose ×2（frontend-dev TDD + reviewer）`，或注明"api 层 TDD 风格，纯前端，非后端 endpoint"。 |
| 6 | NIT | plan-frontend.md §1 File Structure | **文件路径前缀不统一**。部分带 `renderer/src/`（如 `renderer/src/style.css`），部分仅写 `composables/useChat.test.ts`、`components.json`、`renderer/src/api/index.ts`。subagent 定位文件时需脑补前缀。 | 统一前缀。建议全部用 `renderer/src/` 开头（或统一用相对 renderer 根的路径），`components.json` 标注为项目根。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程。本次 0 条。
> - **SHOULD FIX (LOW)**：建议修复，不阻塞。本次 3 条（v1 功能点归属 / 类型来源 / 命名一致性）。
> - **NIT (INFO)**：观察记录。本次 3 条。

#### 等级判定说明（为何 issue #1-3 不升 MUST_FIX）

按 skill「遗漏的 AC 标记 MUST_FIX」规则，严格地讲 issue #1（⌘[/⌘]）可被视为 AC 覆盖矩阵遗漏。但本次**不升 MUST_FIX**，依据：

1. navigation store 的 `back/forward` 接口已在 T1.4 定义且签名完整（`() => void, 边界 no-op`），底层能力已就绪
2. 快捷键绑定是 glue code（一个 keydown listener），不涉及架构决策、不产生数据丢失/功能失效/时序错误（不满足 skill MUST_FIX 校准规则的 5 种情形）
3. 项目指令明确"只把阻断性问题计入 must_fix"，此遗漏补一行 Task 描述即可解决，不阻断 plan 可行性
4. 接口契约未悬空（back/forward 可调用），仅"调用入口（快捷键）归属未明"

issue #2/#3 同理：类型来源缺失和命名分歧是文档完整性问题，不影响 plan 可行性，subagent 在实现时可在 T1.2/T5.3 内消解。故均标 SHOULD_FIX。

### 结论

**通过（verdict: pass）**

plan 整体质量高：spec 完整性、plan 可行性、Execution Groups 编排、接口契约、Metrics Traceability、TDD/文件路径规范均达标。3 条 SHOULD_FIX 是文档完整性改进（v1 功能点归属 + 类型来源 + 命名一致性），建议在进入 Phase 3 前修正以降低 subagent 执行歧义，但不阻断 gate。

### Summary

计划评审完成，第1轮通过，0条MUST FIX，3条SHOULD_FIX（⌘[/⌘] 快捷键覆盖归属 / StreamChunk 类型来源未定义 / chat.send vs sendMessage 命名不一致），3条NIT（Model 未指定 / backend-dev 标注歧义 / 路径前缀不统一）。
