---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-22T18:00:00"
  target: ".xyz-harness/2026-05-21-/spec.md"
  verdict: fail
  summary: "Spec 评审第1轮，3条MUST FIX：session-pool 最终状态未定义、types.ts 位置未决策、37 种消息类型缺少枚举或引用源"

statistics:
  total_issues: 5
  must_fix: 3
  must_fix_resolved: 0
  low: 2
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md > FR-1 目标结构 + FR-3 接口表"
    title: "session-pool.ts 最终状态和去向不明确"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md > FR-2 变更第1条"
    title: "types.ts 文件位置决策未定（'或'字悬而未决）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "spec.md > AC-1 最后一条"
    title: "37 种 ClientMessage.type 未枚举也未引用定义源"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "spec.md > FR-8"
    title: "createSystemNotification 的 type 参数缺少类型定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md > FR-6 + 目标结构"
    title: "provider-store.ts 是已有文件还是新文件未标注"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-22 18:00
- 评审类型：计划评审（spec 完整性专项）
- 评审对象：`.xyz-harness/2026-05-21-/spec.md`

## 审查维度一：完整性（Six-Element 检查）

| Element | 覆盖状态 | 说明 |
|---------|---------|------|
| Outcomes | ✅ 完整 | Background 清晰描述了核心问题（无 Service 层、上帝类、零 DI）。FR-1~9 均有明确的目标状态和当前状态对比。目标目录结构有完整 tree。 |
| Scope Boundaries | ✅ 完整 | In Scope 3 大类 + Out of Scope 10 项，边界清晰。每项 Out of Scope 都说明了推迟理由。 |
| Constraints | ✅ 完整 | Tech Stack / Invariants / Architecture Constraints / Performance 四层约束，覆盖充分。特别是"WS 协议不变"和"无新功能"两个不变量约束了重构边界。 |
| Decisions Made | ✅ 完整 | D1~D6 均有 Decision + Rationale，格式规范。关键决策（不引入 IoC、不引入异步 I/O、假审批接口直接删除）都有明确的"为什么"。 |
| Task Breakdown | ⚠️ 基本完整 | FR-1~9 按功能拆分，Complexity Assessment 表格标注了依赖关系和风险。但 FR-1 内部的子步骤缺少显式拆分（server.ts 37 个 handler 的迁移顺序）。总体对 spec 粒度而言合格，plan.md 应进一步细化。 |
| Verification | ⚠️ 有缺口 | AC-1~AC-General 共 9 组验收标准，绝大部分可直接验证（文件存在、函数签名、grep 无匹配）。AC-1 最后一条"37 种 type 都有 handler"缺少枚举清单，无法系统性验证（见 Issue #3）。 |

## 审查维度二：一致性（spec vs CLAUDE.md 架构约束）

逐项对照 CLAUDE.md 的关键规则：

| CLAUDE.md 规则 | spec 处理 | 一致性 |
|---------------|----------|--------|
| Rule #1 emit 只传单个 payload | 未改动 emit 模式 | ✅ 一致 |
| Rule #2 Event bus refCount 保护 | FR-9 专门解决 useSession/useProvider 的 refCount 缺失 | ✅ 一致 |
| Rule #3 错误必须重置 isGenerating | 不涉及错误处理路径变更 | ✅ 一致 |
| Rule #5 pi 适配层不信任外部格式 | FR-2 强化 event-adapter 的类型约束，恰好加强此规则 | ✅ 一致 |
| Rule #6 Session 隔离 | Invariant 声明"WS 协议不变"，sessionId 路由不受影响 | ✅ 一致 |
| Sidecar 通信架构 | WS 层只改内部路由逻辑，ClientMessage/ServerMessage 签名不变 | ✅ 一致 |
| 前端编码规范 | FR-8/9 不引入新 UI 组件，不改样式 | ✅ 一致 |

**未发现 spec 与 CLAUDE.md 的架构约束冲突。**

## 审查维度三：可测试性

| AC | 可验证性 | 评估 |
|----|---------|------|
| AC-1: Service Layer | ⚠️ | 前 6 条均可通过 grep/文件检查验证。最后一条"37 种 type 都有 handler"缺乏枚举（见 Issue #3）。`server.ts 行数 ≤ 250L` 是硬指标，可自动检查。 |
| AC-2: Type Safety | ✅ | 4 条均可通过 TypeScript 编译 + grep 验证。"exhaustive check"可通过尝试添加新类型来触发编译错误。 |
| AC-3: DI | ✅ | 6 条均为接口存在性和构造函数签名检查，可通过代码审查或 AST 分析验证。 |
| AC-4: Dead Code | ✅ | 5 条均可通过 grep 验证（搜索被删函数名应无结果）。`npm run build` 是自动化门禁。 |
| AC-5: Message Converter | ✅ | 3 条均可通过文件存在 + import 检查验证。 |
| AC-6: Config Store Split | ✅ | 3 条均可通过函数存在/不存在验证。 |
| AC-7: Scanner Base | ✅ | 2 条均可通过文件存在 + grep 验证。 |
| AC-8: Notification Factory | ✅ | 3 条均可通过 grep 验证。 |
| AC-9: refCount | ⚠️ | 前 2 条可代码审查。第 3 条"split mode 下不重复注册"是行为测试，需要手动验证或 E2E 测试。 |
| AC-General | ✅ | `npm run build` + `npm run dev` 可自动验证。功能验证是手动集成测试。 |

**总体可测试性良好。** 绝大部分 AC 是机械可验证的（文件存在、函数签名、grep 无匹配）。AC-1 和 AC-9 的行为测试部分需要 plan.md 补充测试方案。

## 审查维度四：歧义

### 发现的问题

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 1 | MUST FIX | FR-1 目标结构 + FR-3 接口表 | **session-pool.ts 最终状态不明确。** FR-1 目标结构的 tree 不包含 `session-pool.ts`。但 FR-3 接口表中 `SessionPool` 仍是 `IRpcClient` 的消费者。FR-4 只删除了 `addClient/removeClient/send` 三个方法。FR-5 提取了 `convertPiHistory`。那么提取完成后的 session-pool.ts 还剩什么职责？保留还是删除？如果是保留，应该在目标结构 tree 中列出并标注剩余职责；如果是删除（内容全部迁入 session-service.ts），FR-3 接口表中不应再有 SessionPool。 | 二选一：(A) 在目标结构 tree 中补充 `session-pool.ts`，明确标注其保留职责（哪些方法留下，哪些迁走）；(B) 确认删除，从 FR-3 接口表中移除 SessionPool 行。两种选择都要在 Decisions Made 中记录。 |
| 2 | MUST FIX | FR-2 变更第 1 条 | **types.ts 文件位置未决策。** 原文："将 pi-rpc-types.ts 重命名为 types.ts（移到 pi-adapter 子目录或保持当前位置）"。"或"字表明这是一个悬而未决的二选一，但 Decisions Made 中没有对应条目。这会导致不同实现者可能选择不同方案。 | 在 Decisions Made 中新增一条，明确选择。建议选"保持当前位置"（避免子目录创建 + import 路径全部变更），如果确实需要子目录，说明理由。 |
| 3 | MUST FIX | AC-1 最后一条 | **"所有 37 种 ClientMessage.type 都有对应的 handler（不丢功能）"无法系统性验证。** 37 是一个数字断言，但 spec 既未枚举这 37 种 type，也未引用定义源文件（如 `shared/src/types.ts` 中 `ClientMessage.type` 的联合类型）。FR-1 是整个 spec 中复杂度最高（High）、代码量最大（1174L 重组）的变更，验证覆盖率的方法不应依赖人肉记忆。 | 引用定义源：`ClientMessage.type` 的完整联合类型定义见 `{shared 类型文件路径}`。或在 spec 附录中列出完整清单。Plan.md 应产出"handler 覆盖矩阵"：type → handler 函数名的映射表。 |
| 4 | LOW | FR-8 | **createSystemNotification(type, title, desc) 的 type 参数缺少类型约束。** 签名中 `type` 是什么？string literal union（如 `'info' | 'warning' | 'error'`）？还是自由 string？如果是 union，应该列举；如果是自由 string，说明为什么不需要约束。 | 补充 type 参数的类型定义。可以从现有 5 个调用点归纳出现有类型值。 |
| 5 | LOW | FR-6 + 目标结构 tree | **provider-store.ts 未标注"已有"或"新文件"。** 目标结构中 `config-store.ts`、`skill-store.ts`（新文件）、`agent-store.ts`（新文件）有标注，但 `provider-store.ts` 标注为"缓存逻辑保留, 调用 config-store"，既没写"新文件"也没写"已有"。 | 如果是已有文件（仅修改），标注"（已有，修改）"；如果是新文件，标注"（新文件）"。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### 等级判定校准

- Issue #1 (session-pool 去向): 如果实现者误删 session-pool.ts 中仍需要的逻辑，或误保留已应迁移的代码，会导致功能失效。属"功能失效"类别，MUST FIX。
- Issue #2 (types.ts 位置): 决策缺失会导致不同实现者走不同路线，且后续 plan.md 无法确定文件路径。属"数据语义不一致"风险，MUST FIX。
- Issue #3 (37 types 枚举): 重构 1174L 代码时无法系统性验证 handler 覆盖率，遗漏某个 type 的 handler 会导致功能失效。属"功能失效"风险，MUST FIX。

## 附加观察

1. **FR 执行顺序合理**: Spec 的 Complexity Assessment 明确建议"先 FR-4/5 减小文件体积，再 FR-1/3 核心重构"。依赖关系（FR-3 是 FR-1 前提）也标注了。Plan.md 应遵循此顺序。

2. **风险识别到位**: FR-1 被标记为 High 复杂度 Medium 风险，估算 1174L 代码重组。这是准确的。建议 plan.md 对 FR-1 进一步拆分为多个子 task（如：先提取 session-service，再提取 config-service，最后提取 model-service），降低单次变更的风险面。

3. **不变量定义清晰**: "WS 协议不变"和"功能不变"两条不变量给重构提供了安全的护栏。Plan.md 应设计一个"不变量检查点"——每个 task 完成后 `npm run build` + 手动 smoke test。

4. **Decisions Made 质量高**: D4（假审批接口直接删除的理由：真实审批走 extension_ui_request 事件协议）和 D5（SessionPool WS client 管理删除的理由：scan 确认从未被调用）都有实证支撑，不是凭空决定。

## 结论

需修改后重审。3 条 MUST FIX 均为 spec 定义的精确性问题，修复成本低（每条 5-10 分钟），但对后续 plan.md 和实现的正确性影响大。

### Summary

Spec 评审完成，第1轮，3条MUST FIX（session-pool 去向未定义、types.ts 位置未决策、37 种消息类型缺枚举），需修改后重审。
