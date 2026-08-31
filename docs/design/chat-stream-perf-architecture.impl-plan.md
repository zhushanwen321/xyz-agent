# impl-plan — 聊天链路性能架构改造（chat-stream-perf-architecture）

> 设计文档：[chat-stream-perf-architecture.md](./chat-stream-perf-architecture.md)（已对抗式审查修复，commit `9787c2611`，0 must-fix / 3 suggestion 全修）。
> **计划性质：事后补建**（代码先行倒挂场景——A/B/D 三单元已于 2026-08-31 实施并 committed，本计划按 dev-flow「状态恢复」校准规则依 git log 回建，供阶段 3 一致性审查与阶段 5 双级验收作为状态事实源）。
> **diff 审查区间**：`1fe7f4626..af96fa94c`（恰含 u-A / u-B / u-D 三个实现 commit）。

## 0. 章节映射（设计文档内容 → 实物位置）

| 设计文档章节 | 实物 |
|--------------|------|
| §2.1 数据流 / §1 背景目标 | 文档自身（背景性，无独立代码） |
| §2.2 + §3.1 候选 A | `packages/core/src/domain/chat/message-turns.ts` + `__tests__/message-turns.incremental.test.ts`（u-A） |
| §2.3 + §3.2 候选 B | `packages/core/src/domain/chat/apply-entry.ts` + `__tests__/apply-entry-fold-equivalence.test.ts`（u-B） |
| §2.4 + §3.3 候选 D | `packages/renderer/src/composables/features/sidebar/`（useSidebar 新轨）、`packages/core/src/domain/session/use-session.ts`、`useChatViewDeps.ts`、`useTraceJump.ts` + 59 文件批次（u-D） |
| §3.4 候选 C | 无代码（撤销登记 + 重启信号） |
| §4 验收 | Gate A（全量测试）+ Gate B（场景表逐行签收）；S1-S5 执行时点见文档 §4.2 引言（9787c2611 登记） |

## 1. 单元表与状态表

| 单元 | 内容 | 领地（白名单） | 证据 | 状态 |
|------|------|---------------|------|------|
| u-A | toRenderItemsIncremental 尾部快车道三车道 | core/domain/chat/message-turns.ts + 其增量测试 | commit `3fa710aee` | committed |
| u-B | apply-entry transient fold + ChatStateCollector | core/domain/chat/apply-entry.ts + fold 等价套件 | commit `3c099d409` | committed |
| u-D | useSidebar 双轨一次性收尾（含 selectSessionFallback 端口 + enterEmptyChatState + 重命名清扫） | renderer sidebar/session 编排 + core/domain/session + 59 文件批次 | commit `af96fa94c` | committed |
| u-doc | 设计文档产出 + 对抗式审查修复 | docs/design/chat-stream-perf-architecture.md | `a6414f1ba` + `9787c2611` | committed |
| u-gateA | Gate A 整体测试验收（core/renderer/ui 全量 + typecheck + lint） | 只读验证 + 本计划状态表 | Gate A 验收（见变更历史 2026-09-01 阶段 5 条） | committed |
| u-gateB | Gate B 验收场景表逐行签收（§4.1 证据复核 + §4.2 S1-S5 状态） | 只读签收 + 本计划状态表 | Gate B 签收（见变更历史 2026-09-01 阶段 5 条） | committed |

DAG：u-A ∥ u-B ∥ u-D（并行实施，文件集不重叠）→ u-doc（事后沉淀，已含审查）→ u-gateA → u-gateB。

## 2. 合理偏差登记表

（2026-09-01 阶段 3 一致性审查产出；两区 reviewer 独立审查，实现零正确性缺陷）

| # | 偏差 | 证据 | 处置 |
|---|------|------|------|
| P1 | 恒等复用从车道①推广到车道②透明 append / 空 trigger turn 折叠形态——D-A3「零重算承诺」的合理超集 | message-turns.ts:449-507，测试 incremental.test.ts:755-774 | 已同步设计文档 §3.1 D-A3 |
| P2 | fillHostToolCall 新增 tcs===undefined 防御分支（原调用点不可达），纯防御行为不变 | apply-entry.ts 派生段 | 无需文档动作 |
| P3 | real-pi 池本地实跑全绿（runtime 全量 4115 passed，含 chaos / pi-protocol-contract / session-manager-full-e2e）；唯一失败 workflow-extractor 属 extensions 领地并行改动（R2 归因） | 审查期实跑 | 已同步设计文档 §4.1 / §5.2（R1 风险降级为 CI 独立复检） |
| P4 | newSession 延迟 create 分支保留裸 navigation.push 不走 enterEmptyChatState（无参 startFlow 会清 fallback cwd）——D-D2 的机制辨析型增强 | use-session.ts:296-298 + :368-369 | 已同步设计文档 D-D2 |
| P5 | core 测试以构造性断言（switchSession not-called）锁死端口语义，超出 D-D1 最低验收 | use-session.test.ts 新增 4 用例 | 无需文档动作 |

## 3. 残留风险与变更历史

- **2026-09-01 阶段 5 双级验收（双绿交付）**：
  - **Gate A（subagent 全量验收）**：core 94 文件 1397 passed / ui 57 文件 554 passed / renderer 全量 3663 passed + 3 failed / 三包 typecheck 绿 / 领地 lint 0 errors 8 warnings（全存量非本波次 diff）/ doc-drift 守卫 exit 0。**3 个失败经证据链归因全部为基线既有/认知外，非本波次引入**（2 例：`useChat-subagent-directive.test.ts` 前导空格——基线前 commit `8f93d7feb` whitespace 保真与 U2b trim 期望冲突；1 例：`system-page-rename-model.test.ts` 全量并发超时、单跑 6/6 过）。零容忍扫描：本波次 diff 新增行 SKIP_*/skip/todo/eslint-disable 零命中。覆盖矩阵：59 文件逐一无无人认领区。→ 登记 R4/R5。
  - **Gate B（subagent 逐行签收）**：§4.1 五行 4 consistent + 1 mismatch（行 2 计数 206 → 实测 138，已修，系登记漂移非行为问题）；§4.2 S1-S4 全部 scheduled（登记原文与 `9787c2611` 逐字一致；S5 前置「未 push」经 `git branch -r --contains` 三 commit 全空核实成立）；§4.3 六行边界锚点全部落实到用例级无 gap；通过标准可检验性——S2/S3/S5 完全可检验，S1 缺对比基线来源（已补登记：checkout `1fe7f4626` 重跑 profile），S4「与删除前一致」依赖执行人认知（旧轨已删无法同机 A/B，执行注意项）。
  - **双绿判定**：Gate A 领地内全绿（失败全归因基线既有并登记）+ Gate B 签收通过（mismatch 已修、scheduled 行有明确登记时点）→ **交付**。
- **2026-09-01 阶段 3 一致性审查轮 1（两区独立 reviewer）+ 修复清零**：unreasonable 3 条全修——U1 D-A5 分支顺序不变量补代码侧锚点（groupRenderInput 注释，message-turns.ts:271-273）；U4 sessions-entry.ts:19 注释路径补 sidebar/ 段；U2 两设计文档登记进 check-doc-symbol-drift DOC_MODULE_MAP（守卫复跑 exit 0 零 drift，af96fa94c 的「clean」声明自此有真实检查力）。 unreasonable 另 1 条（commit message「11 consumers」实为 10）系已落地 commit 的口径漂移，不改写历史，以设计文档 10/12 口径为准。doc_errors 4 条主 agent 亲修：D-A2/§4.1 用例计数 36+8 → 35+9（基线实测 35 it）、§4.1 runtime 81 → 76 tests（7 文件口径）、§2.4 与 D-D3 的已删符号 useSidebarNew 去反引号（守卫口径）。5 条 reasonable 入本登记表 P1-P5。
- **2026-09-01 校准事件（计划补建）**：本计划非实施前置产物，系代码先行场景下按 git log（`3fa710aee` / `3c099d409` / `af96fa94c`）与工作区实物回建；基线 `1fe7f4626`（恰为本波次三实现 commit 之前最后一个 commit）。设计文档已经用户方对抗式审查并修复（`9787c2611`），审查结论登记执行时点：S1-S4 随下次 prerelease 真机验收执行、S5 随本分支首次 push 后 CI。
- **残留风险 R1**：u-B 的 real-pi 池——**已降级**：本地预验全绿（P3），剩余 = push 后 CI 独立环境复检（S5）。
- **残留风险 R2**：本 worktree 存在并行会话的活跃提交与认知外改动（extensions/、`packages/shared/src/mandatory-extensions.json`、`scripts/probe-third-host-integration.mjs`）——不在本计划领地，Gate A 若因之出 failures 须归因区分，不计入本计划单元失败。
- **残留风险 R3**：S1-S4 真实场景收益实证未执行（登记时点：随下次 prerelease）——交付口径为「行为等价已锁定（测试级），收益实证待 S1-S5」。
- **残留风险 R4（基线既有失败，非本波次，建议用户独立裁决）**：① `useChat-subagent-directive.test.ts` 2 例——`8f93d7feb`（whitespace 去 trim 保真）使 sendSubagentDirective 的 text/task 可能携带前导空格直达 extension，与 U2b 测试 trim 期望冲突。这是**真实语义疑点**：定向通道应局部 trim，还是更新 U2b 期望（保真语义下空格属用户输入）。② `system-page-rename-model.test.ts` 全量并发 5s 超时（单跑过，mount 1066ms 偏慢）——建议独立优化 mock 链路。
- **残留风险 R5（执行注意项）**：S4 的「与删除前一致」基线依赖执行人认知（旧轨已删无法同机 A/B 对比），prerelease 执行时按 §4.2 S4 的 7 类操作清单 + 回退订阅断言核对。
