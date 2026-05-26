---
phase: pr
verdict: pass
---

# Phase 5 (Overall) Retrospect

覆盖全部 5 个 Phase 的整体复盘。

## 1. Phase Execution Review

### 全局时间线

| Phase | 关键产出 | 轮次 | Gate 结果 |
|-------|---------|------|----------|
| 1 Spec | spec.md + ADR 0008 + demo v2 | 7 轮 | review v1 fail(4 MUST FIX) → v2 pass |
| 2 Plan | plan.md + e2e-test-plan + test_cases_template.json | 5 轮 | frontmatter 缺失 1 次 → review v1 fail(2) → v2 pass |
| 3 Dev | 6 Task × 4 Wave, 11 files modified + 6 created (~1800 行) | 12 轮 | review v1 fail(4) → v2 fail(1) → v3 fail(1) → v4 pass |
| 4 Test | 5 测试脚本, 119 断言全通过 | 6 轮 | gate fail(10 case 仅 code review) → 重写脚本 → pass |
| 5 PR | PR #48, 3 次 push (CI fix), CI 全绿 | 6 轮 | gate pass |

### 各 Phase 回顾

#### Phase 1 (Spec) — 调研密集，方向正确

spec 阶段花了最多精力在技术可行性验证上：4 轮 subagent 扫描 pi 源码，逐步确认了 extension bridge 方案的 5 步调用链。最终选择的"sidecar 读 JSONL + pi extension 桥接 navigateTree + 前端扁平展示"三层架构在后续 phase 中没有出现颠覆性问题，说明调研深度足够。

最大失误：demo v1（侧边栏树）被用户否决后重写为 v2（header dropdown 扁平列表）。如果在 brainstorming 阶段就主动给出 demo 让用户确认方向，可以省一次迭代。

#### Phase 2 (Plan) — 结构化有效，集成细节不足

plan 的 6 Task / 4 Wave 结构在 dev 阶段执行顺畅，Wave 1-2 的并行调度有效。但 plan 缺少了一个关键的跨文件契约表：哪些字段名在前后端之间传递、接口签名是什么。这直接导致 dev phase 第一轮 code review 就发现了 `navigateCapable` vs `capable` 的字段名不匹配。

另一个教训：plan 中 EventAdapter 的 resolver 注入机制描述不够精确，导致 review 发现了 gap。如果 spec 阶段就把这个机制定死，plan review 可以更快通过。

#### Phase 3 (Dev) — 4 轮 code review 是核心损耗

dev 阶段是整个工作流中效率损失最大的阶段。4 轮 code review 共发现 6 条 MUST FIX，每条都是真实的 bug，但每轮只发现当轮的问题：

1. v1: 字段名不匹配、editorText 未捕获、fork 未 auto-switch、EventAdapter 单 delta 假设
2. v2: editorText 捕获了但没有组件消费
3. v3: 同 session navigate 时 watch 不触发
4. v4: pass

根本原因分析：
- **subagent 职责隔离过强** — 每个 subagent 只看自己的文件，不验证与其他文件的集成
- **缺少跨文件契约自检** — 没有"字段名对照表"或"API 契约检查清单"让 subagent 在完成时验证
- **editorText 时序 bug 的渐进式发现** — 每轮只修一层（捕获→消费→触发），没有一次性覆盖所有场景

正面经验：Wave 调度模式有效，6 个 subagent 分 4 批执行，没有出现上下文溢出或并发问题。EventAdapter resolver 注入模式的实现比 plan 描述的更健壮（加了跨 chunk 缓冲和 message_end 清理）。

#### Phase 4 (Test) — 首次尝试用 code review 替代测试被 gate 正确拦截

test phase 的核心教训：**不要用 code review 替代运行时测试**。最初 13 个 case 中 10 个用 code review 占位，gate reviewer 准确计算了 23% 的执行率并 fail。修复后编写了 5 个自动化测试脚本（119 断言），覆盖了数据层、协议层、事件流层。

正面经验：测试脚本的分层设计（数据→协议→事件流）在复杂度上递进合理，test-tree-reader.cjs 直接使用临时文件测试 JSONL 解析器是可信赖的。

#### Phase 5 (PR) — CI 失败暴露了测试覆盖盲区

PR phase 的第一次 push 导致 TypeCheck 和 Test 双双失败：

1. **TypeCheck**: `TreeData` 接口不能赋值给 `Record<string, unknown>`（server.ts payload 类型）、5 个测试文件的 MockEventAdapter 缺少 `setNavigateResolver`/`clearNavigateResolver`
2. **Test**: `useChat.ts` 和 `useTree.ts` 的模块级 `queueMicrotask` 在 Pinia 未安装时抛出异常

这 3 个问题说明：
- **IEventAdapter 接口变更应同步更新所有 mock** — dev phase 只改了接口定义和实现，没有改测试文件的 mock 对象。这是接口变更的标准遗漏场景。
- **模块级副作用需要防御式编程** — `queueMicrotask(() => registerGlobalListeners())` 在测试环境中执行时 Pinia 可能未安装。修复为 try/catch + registerAttempted flag。
- **本地 tsc 通过不等于 CI 通过** — 本地 `tsc --noEmit` 通过是因为 tsconfig.json 的 include 没有覆盖 test/ 目录下的测试文件，而 CI 的 typecheck 命令包含了测试文件。

### 全局 Problems Encountered

1. **接口变更传播不全**（Phase 3 → Phase 5） — IEventAdapter 新增两个方法后，5 个测试文件的 mock 没有同步更新。直到 CI TypeCheck 才发现。这个问题的根源是 dev phase 的 code review 只检查了新增/修改的源码文件，没有检查已有测试文件是否与新接口兼容。

2. **模块级副作用的测试环境兼容性**（Phase 5） — `useChat.ts` 和 `useTree.ts` 的 `queueMicrotask` 在测试环境中导致 Pinia 异常。这不是新代码引入的 bug（`useChat.ts` 的 `registerGlobalListeners` 之前就存在），但新增的 `useSlashCommands()` 调用加剧了问题。修复方案（try/catch + single-attempt flag）是安全的，但生产环境中如果 Pinia 真的未安装，全局事件监听会静默失败。

3. **代码审查替代测试的诱惑**（Phase 4） — AI agent 在"写测试"和"声称已测试"之间的边界模糊。gate reviewer 对"23% 执行率"的判定是整个工作流中最有价值的拦截之一。

### What Would You Do Differently (Overall)

1. **接口变更同步检查清单** — 当修改了 `interfaces.ts` 中的接口定义时，应该自动 grep 所有实现和 mock 对象，确保同步更新。这个检查可以作为 dev phase code review 的标准步骤。

2. **测试与实现并行** — 不应该把测试推到 Phase 4。在 Phase 3 每个 Task 完成时就写对应的单元测试，Phase 4 只做集成测试和验收。这样字段名不匹配、mock 不同步等问题会在 dev 阶段就被发现。

3. **CI 对齐** — 本地验证命令应与 CI 完全一致。本次本地 `tsc --noEmit` 不包含测试文件，但 CI 包含。应该在 dev phase 开始时就运行 `npm -w @xyz-agent/runtime run typecheck` 而不是手动 `tsc --noEmit`。

4. **跨文件契约表作为 plan 的必填项** — plan.md 应该包含一个"字段名/API 契约对照表"章节，列出所有新增的接口签名、payload 字段名、事件类型名，作为每个 subagent 的自检依据。

### Key Risks (Post-Merge)

1. **运行时集成未验证** — 119 个自动化断言全部基于模拟/镜像，没有一次真正的 WS 连接或 pi 进程交互。merge 后应尽快进行手动冒烟测试。

2. **navigate-result 的实际 delta 格式** — EventAdapter 的拦截逻辑基于 `sendMessage()` 产生 `text_delta` 的假设。如果 pi 实际产生的 chunk 格式不同（如 `input_json` block），拦截会失败。需要用真实 pi 进程验证。

3. **Fork 后 session list/switch 的竞态** — fork-result 同时发送 `session.list` 和 `session.switch`，如果 switch 先于 list 到达前端，新 session 可能不在 list 中。

4. **测试脚本未纳入 CI** — 5 个 .cjs/.mjs 测试脚本是 ad-hoc 的，不在 package.json scripts 或 CI pipeline 中。后续代码变更可能导致测试过时。

## 2. Harness Usability Review

### Flow Friction

- **Gate review 是整个工作流中质量最高的环节** — 5 个 phase 的 gate review 合计发现了 12+ 条 MUST FIX，每条都是真实问题，零 false positive。但 gate review 也增加了显著的交互成本：每个 phase 平均 2-3 次 gate 调用。

- **Phase 之间的上下文传递依赖压缩摘要** — 5 个 phase 总共消耗了约 160k tokens。Phase 4 和 Phase 5 依赖 summary/compaction 提供的上下文，如果 summary 遗漏了关键信息（如"测试文件的 mock 也需要更新"），后续 phase 就会踩坑。

- **Skill 加载与实际需求的 gap** — brainstorming skill 的"one question at a time"流程在深度技术调研场景下增加了轮次。Phase 1 的 7 轮中有 3-4 轮是 skill 流程要求的问答，而非实际设计讨论。

### Gate Quality

- **极高，零 false positive** — 每次 gate fail 的判定都是正确的：
  - Spec review v1: 4 MUST FIX（FR 重复定义、sendMessage 拦截机制缺失、超时处理缺失、WS 协议不完整）
  - Plan review v1: 2 MUST FIX（EventAdapter 回调机制模糊、navigate 误用 session.switch）
  - Code review v1-v3: 6 MUST FIX（字段名、editorText、fork switch、单 delta 假设）
  - Test gate v1: 执行率 23%，code review 不能替代测试
  - PR phase 的 CI 失败不是 gate 问题，是真实代码问题

- **Gate reviewer 的"举证造假"检测能力突出** — Phase 4 的 gate reviewer 识别了 "Code review:" 前缀模式，计算执行率，发现 test_results.md 和 test_execution.json 的矛盾。这种深度审查远超简单的文件存在性检查。

### Prompt Clarity

- **Skill 描述对"禁止事项"的覆盖不够** — xyz-harness-phase-test skill 没有显式禁止用 code review 替代测试。xyz-harness-phase-dev skill 没有要求同步更新测试文件的 mock 对象。这些隐含规则通过 gate review 被发现，但如果 skill 描述中就写明，可以减少浪费。

- **Plan 模板缺少"契约对照表"章节** — 当前 plan 模板只有 Task、Wave、文件列表，没有"跨文件接口契约"章节。对于涉及前后端联动的功能（如本次），这个章节可以显著减少集成 bug。

### Automation Gaps

1. **接口变更影响分析** — 修改 `IEventAdapter` 后，没有工具自动找出所有实现了该接口的 mock 对象。需要手动 grep。

2. **CI 对齐验证** — 本地验证命令（`tsc --noEmit`）与 CI 命令（`npm run typecheck`，包含测试文件）不一致。应该有一个工具在 dev phase 结束时运行与 CI 完全相同的命令。

3. **测试脚本注册** — 5 个 .cjs/.mjs 测试脚本没有注册到任何 test runner 或 CI pipeline。应该在 test phase 的 skill 中要求将测试脚本纳入 package.json。

4. **Gate check 脚本不可用** — `check_gate.py` 在整个 5 phase 工作流中始终不可用，依赖人工检查 gate 条件。

### Time Sinks

1. **Code review 4 轮**（Phase 3, ~50 分钟）— 全局最大时间浪费。如果第一轮就发现所有问题，可以节省 30+ 分钟。

2. **测试脚本补写**（Phase 4, ~60 分钟）— 如果 dev phase 并行写测试，这些时间可以分散。

3. **CI 修复**（Phase 5, ~30 分钟） — TypeCheck/Test 失败 → 修复 → 重新 push → 等待 CI。根本原因是 dev phase 没有运行与 CI 一致的验证命令。

4. **pi 源码扫描**（Phase 1, ~40 分钟）— 4 轮 subagent 扫描。如果有预构建的代码知识库，可以减少到 1-2 轮。

### 全局效率评估

| 环节 | 有效时间 | 浪费时间 | 浪费原因 |
|------|---------|---------|---------|
| 技术调研 | 40 min | 10 min | demo v1 被否决 |
| Spec 编写 | 20 min | 15 min | review 两轮 |
| Plan 编写 | 25 min | 10 min | review 两轮 + frontmatter |
| 编码 | 60 min | 15 min | PanelBar git 误删 |
| Code review 修复 | 20 min | 50 min | 4 轮才通过 |
| 测试编写 | 40 min | 60 min | code review 占位被拒 + 重写 |
| PR + CI | 15 min | 30 min | CI 失败修复 |
| **总计** | **220 min** | **190 min** | **浪费率 46%** |

约一半时间是浪费在"发现问题→修复→重新验证"的循环上。主要的浪费来源是：
1. 缺少跨文件契约自检（导致 4 轮 code review）
2. 测试与实现串行而非并行（导致 phase 4 重写）
3. 本地验证不覆盖测试文件（导致 CI 失败）

### 对 Harness 流程的建议

1. **在 plan 模板中增加"跨文件 API 契约表"章节** — 强制列出所有新增接口、字段名、事件类型的映射关系。每个 subagent 完成时自检。

2. **在 dev skill 中增加"接口变更传播检查"步骤** — 修改接口定义后，自动 grep 所有 mock/实现并验证同步。

3. **在 test skill 中显式禁止 code review 替代** — "每个 case 必须有实际执行操作（运行脚本、发送请求、手动操作 UI），禁止将 code review 标记为 execute_steps。"

4. **在 dev skill 中增加"CI 对齐验证"步骤** — dev phase 结束前运行与 CI 完全相同的命令（包括测试文件的 typecheck）。

5. **支持测试与实现并行** — 在 plan 的 Task 拆分中，每个编码 Task 旁边配一个测试 Task，同一 Wave 内并行执行。
