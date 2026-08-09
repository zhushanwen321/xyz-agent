# 验收标准：workflow/subagent run 级 model/thinkingLevel override 移植（Option B）

> **配套设计文档**：`/tmp/workflow-model-thinkinglevel-migration-design.md`（v6，Option B 对称注入）
> **本文件定位**：Definition of Done——实施这份移植时「怎么做完」才算完成。每条都有客观验证方式（命令 / grep / 断言）。
> **核实状态**：所有 grep 模式、行号、测试文件路径均已对照两分支实际代码核实（2026-09-10）。
>
> **路径约定**：
> - 当前分支（移植目标）：`<CUR>` = `/Users/zhushanwen/Code/xyz-agent-workspace/feat-optimize-subagent-workflow-load`
> - 源分支（搬入来源）：`<SRC>` = `/Users/zhushanwen/Code/xyz-agent-workspace/fix-workflow-subagent-thinking-level`
> - 子包根：`<PKG>` = `extensions/subagent-workflow`（两分支相对路径一致）

---

## 1. DoR（Definition of Ready — 开始实施前）

实施者必须在动代码前逐条确认以下前置条件，任一不满足先补齐。

- [ ] **两分支 worktree 就绪**：`git --git-dir=<CUR>/.bare worktree list` 输出含 `feat-optimize-subagent-workflow-load` 与 `fix-workflow-subagent-thinking-level` 两行
- [ ] **当前分支领先 main 的 commit 数与文档一致**：`cd <CUR> && git rev-list --count main..HEAD` 返回值 ≥ 32（设计文档 §0.1 声明 32，实施时以实际为准，偏差大需停下核查）
- [ ] **当前分支依赖装好**：`cd <CUR>/extensions/subagent-workflow && node -e "require('vitest/package.json').version"` exit 0（vitest ^4.1.8 可加载）；若失败跑 `cd <CUR> && pnpm install`
- [ ] **基线测试绿**（确认当前分支改动前是干净的起点）：
  ```bash
  cd <CUR>/extensions/subagent-workflow && npx vitest run \
    src/execution/__tests__/model-resolver.test.ts \
    src/orchestration/__tests__/worker-script-builder.test.ts \
    src/interface/__tests__/detectors.test.ts \
    src/__tests__/review-fix-loop-utils.test.ts
  ```
  全绿才开工（这 4 个文件是本次改动直接触碰的，基线必须先绿）
- [ ] **基线静态检查绿**：`cd <CUR> && pnpm extensions:typecheck && pnpm extensions:lint` 两命令均 exit 0
- [ ] **设计文档核实点与当前代码一致**（抽样 3 条，防止文档基于过期代码）：
  - `grep -n 'const THINKING_ORDER' <CUR>/<PKG>/src/execution/model-resolver.ts` 输出含 `"xhigh"` 且**不含** `"max"`、**不含** `export`（确认 A 类搬入对象存在）
  - `grep -c 'TOOL_TOP_LEVEL' <CUR>/<PKG>/src/interface/tool-workflow.ts` ≥ 3（定义/注释/使用各一处）
  - `grep -n 'const MODEL' <CUR>/<PKG>/workflows/review-fix-loop.js` 输出含 `$ARGS.model`（确认 D 类改造对象存在）

---

## 2. DoD（Definition of Done — 实施完成）

### A. 文件级验收（按设计文档 §5 文件地图）

#### A1. `src/execution/model-resolver.ts`（A 类 · THINKING_ORDER 加 max + export）

- [ ] **A1.1** `grep -n 'export const THINKING_ORDER' <CUR>/<PKG>/src/execution/model-resolver.ts` 命中一行（从 `const` 升格为 `export const`）
- [ ] **A1.2** 该行含 `"max"` 且为末位：`grep 'THINKING_ORDER = \[.*"max"\]' <CUR>/<PKG>/src/execution/model-resolver.ts` 命中（完整序列 `off/minimal/low/medium/high/xhigh/max`）
- [ ] **A1.3** SSOT 注释存在：`grep -i 'SSOT\|单一.*改\|新增级别只改' <CUR>/<PKG>/src/execution/model-resolver.ts` 命中（搬入源分支的 SSOT 说明注释）
- [ ] **A1.4** `resolveModel` 第 102 行 `if (paramOverride?.model)` 未被改动（P0-10 消解机制不动）：`sed -n '102p' <CUR>/<PKG>/src/execution/model-resolver.ts` 输出 `  if (paramOverride?.model) {`

#### A2. `src/orchestration/worker-script-builder.ts`（A 类 · $MODEL/$THINKING_LEVEL 注入 + agent() fallback）

- [ ] **A2.1** `$MODEL` global 注入存在：`grep -F 'const $MODEL = (workerData.model && typeof workerData.model === "string") ? workerData.model : undefined;' <CUR>/<PKG>/src/orchestration/worker-script-builder.ts` 命中
- [ ] **A2.2** `$THINKING_LEVEL` global 注入存在：`grep -F 'const $THINKING_LEVEL = (workerData.thinkingLevel && typeof workerData.thinkingLevel === "string") ? workerData.thinkingLevel : undefined;' <CUR>/<PKG>/src/orchestration/worker-script-builder.ts` 命中
- [ ] **A2.3** string 分支 fallback：`grep -F 'secondArg.model) || $MODEL' <CUR>/<PKG>/src/orchestration/worker-script-builder.ts` 命中，且 `grep -F 'secondArg.thinkingLevel) || $THINKING_LEVEL'` 命中
- [ ] **A2.4** task/agent 分支 fallback：`grep -F 'model: firstArg.model || $MODEL' <CUR>/<PKG>/src/orchestration/worker-script-builder.ts` 命中，且 `grep -F 'thinkingLevel: firstArg.thinkingLevel || $THINKING_LEVEL'` 命中
- [ ] **A2.5** object.prompt 分支 fallback：`grep -F 'if (!opts.model && $MODEL) opts.model = $MODEL;' <CUR>/<PKG>/src/orchestration/worker-script-builder.ts` 命中，且 `grep -F 'if (!opts.thinkingLevel && $THINKING_LEVEL) opts.thinkingLevel = $THINKING_LEVEL;'` 命中
- [ ] **A2.6** 优先级链注释存在：`grep -F 'agent() explicit > $MODEL global' <CUR>/<PKG>/src/orchestration/worker-script-builder.ts` 命中

#### A3. `src/orchestration/worker-host.ts`（A 类 · workerData 透传 model/thinkingLevel）

- [ ] **A3.1** workerData 含 model：`grep -A2 'budget:' <CUR>/<PKG>/src/orchestration/worker-host.ts | grep -F 'model: spec.model'` 命中
- [ ] **A3.2** workerData 含 thinkingLevel：`grep -F 'thinkingLevel: spec.thinkingLevel' <CUR>/<PKG>/src/orchestration/worker-host.ts` 命中

#### A4. `src/execution/__tests__/model-resolver.test.ts`（A 类 · 追加 P1/P2 探针）

- [ ] **A4.1** P1 探针存在（:max 后缀剥离）：`grep -F "P1: resolves model passed with ':max' suffix" <CUR>/<PKG>/src/execution/__tests__/model-resolver.test.ts` 命中
- [ ] **A4.2** P1 探针断言 resolveModel 成功（非 throw）：该 `it(...)` 块内 `expect(r.model).toBeTruthy()` 或等价（grep `'mock-model:max'\|':max'` 命中 + 无 `.toThrow`）
- [ ] **A4.3** P2 探针存在（availableThinkingLevels 含 max 末位）：`grep -F "P2: includes 'max' as the last level" <CUR>/<PKG>/src/execution/__tests__/model-resolver.test.ts` 命中
- [ ] **A4.4** P2 探针断言：`grep -F '["high", "xhigh", "max"]' <CUR>/<PKG>/src/execution/__tests__/model-resolver.test.ts` 命中
- [ ] **A4.5** 既有 L1/L2/L3 测试未被破坏：`grep -c '"resolveModel — three-layer priority"' <CUR>/<PKG>/src/execution/__tests__/model-resolver.test.ts` = 1
- [ ] **A4.6** 既有 `availableThinkingLevels` 子集断言未被改成全量（防止误改）：`grep -F '["off", "low", "high", "xhigh"]' <CUR>/<PKG>/src/execution/__tests__/model-resolver.test.ts` 命中（这是 line 292 的既有 subset 断言，**不应**被改成含 max）

#### A5. `src/orchestration/__tests__/worker-script-builder.test.ts`（A 类 · 改 1 条既有断言 + 追加 P3/P4，须与 A2 同批迁移）

- [ ] **A5.1** 既有 string-branch 断言已改：`grep -F 'secondArg.thinkingLevel) || $THINKING_LEVEL' <CUR>/<PKG>/src/orchestration/__tests__/worker-script-builder.test.ts` 命中（原为 `|| undefined`）
- [ ] **A5.2** 新增 model string-branch 断言：`grep -F 'secondArg.model) || $MODEL' <CUR>/<PKG>/src/orchestration/__tests__/worker-script-builder.test.ts` 命中
- [ ] **A5.3** P3/P4 describe 块存在：`grep -F 'P3/P4 run-level model/thinkingLevel global injection + agent() fallback' <CUR>/<PKG>/src/orchestration/__tests__/worker-script-builder.test.ts` 命中
- [ ] **A5.4** P3/P4 覆盖三分支（string/task-agent/object.prompt）共 6 个 it：`grep -c 'falls back to \$MODEL\|injects \$MODEL when opts.model omitted' <CUR>/<PKG>/src/orchestration/__tests__/worker-script-builder.test.ts` ≥ 3（model 部分；thinkingLevel 对称另有 3 个）

#### A6. `.xyz-harness/workflow-subagent-thinking-level/{spec,review}.md`（A 类 · 新建设计文档）

- [ ] **A6.1** 目录存在：`ls <CUR>/.xyz-harness/workflow-subagent-thinking-level/spec.md <CUR>/.xyz-harness/workflow-subagent-thinking-level/review.md` 两文件均存在（从 `<SRC>/.xyz-harness/workflow-subagent-thinking-level/` 复制）
- [ ] **A6.2** 文件非空：`wc -c <CUR>/.xyz-harness/workflow-subagent-thinking-level/spec.md` ≥ 30000（源 spec ~33KB），review ≥ 9000

#### A7. `src/orchestration/models/run-spec.ts`（B 类 · RunSpec 加 model?/thinkingLevel?）

- [ ] **A7.1** model 字段存在：`grep -F 'readonly model?: string;' <CUR>/<PKG>/src/orchestration/models/run-spec.ts` 命中
- [ ] **A7.2** thinkingLevel 字段存在：`grep -F 'readonly thinkingLevel?: string;' <CUR>/<PKG>/src/orchestration/models/run-spec.ts` 命中
- [ ] **A7.3** 注释改写为 Option B（不含已推翻的 D5/args merge 描述）：`grep -i 'D5\|args merge\|对称.*worker global\|经 workerData' <CUR>/<PKG>/src/orchestration/models/run-spec.ts`——若命中 D5/args merge 说明注释未改写（**失败**）；命中 Option B/workerData 说明改写正确（**通过**）
- [ ] **A7.4** 既有 `parameters?` 字段未被破坏：`grep -F 'readonly parameters?: Record<string, unknown>;' <CUR>/<PKG>/src/orchestration/models/run-spec.ts` 命中

#### A8. `src/interface/subagent-tool.ts`（B 类 · thinkingLevel 枚举从 THINKING_ORDER 派生）

- [ ] **A8.1** import THINKING_ORDER：`grep -F 'import { THINKING_ORDER } from "../execution/model-resolver.ts"' <CUR>/<PKG>/src/interface/subagent-tool.ts` 命中
- [ ] **A8.2** 枚举派生（不再硬编码）：`grep -F 'StringEnum(THINKING_ORDER' <CUR>/<PKG>/src/interface/subagent-tool.ts` 命中
- [ ] **A8.3** 硬编码枚举已删除：`grep -F 'StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"]' <CUR>/<PKG>/src/interface/subagent-tool.ts` **无命中**（旧硬编码必须消失）

#### A9. `src/interface/tool-workflow.ts`（C 类 · 架构断裂重写，核心文件）

- [ ] **A9.1** TOOL_TOP_LEVEL 加 model：`grep -A12 'const TOOL_TOP_LEVEL = new Set' <CUR>/<PKG>/src/interface/tool-workflow.ts | grep -F '"model"'` 命中
- [ ] **A9.2** TOOL_TOP_LEVEL 加 thinkingLevel：`grep -A12 'const TOOL_TOP_LEVEL = new Set' <CUR>/<PKG>/src/interface/tool-workflow.ts | grep -F '"thinkingLevel"'` 命中
- [ ] **A9.3** WorkflowParams 加 model 字段：`grep -F 'model: Type.Optional' <CUR>/<PKG>/src/interface/tool-workflow.ts` 命中
- [ ] **A9.4** WorkflowParams 加 thinkingLevel 字段：`grep -F 'thinkingLevel: Type.Optional' <CUR>/<PKG>/src/interface/tool-workflow.ts` 命中
- [ ] **A9.5** actionRun 的 runWorkflow 调用透传 model：`grep -B2 -A15 'runId = await runWorkflow' <CUR>/<PKG>/src/interface/tool-workflow.ts | grep -F 'model: params.model'` 命中
- [ ] **A9.6** actionRun 的 runWorkflow 调用透传 thinkingLevel：`grep -B2 -A15 'runId = await runWorkflow' <CUR>/<PKG>/src/interface/tool-workflow.ts | grep -F 'thinkingLevel: params.thinkingLevel'` 命中
- [ ] **A9.7** **无 args merge**（Option B 关键不变式）：`grep -F '{ ...params.args, model' <CUR>/<PKG>/src/interface/tool-workflow.ts` **无命中**；`grep -F 'args = { ...params.args' <CUR>/<PKG>/src/interface/tool-workflow.ts` **无命中**
- [ ] **A9.8** 既有 `const args = params.args ?? {}` 未被改动：`grep -n 'const args = params.args ?? {}' <CUR>/<PKG>/src/interface/tool-workflow.ts` 命中（这是设计文档 D-T3' 明确「不改」的锚点）
- [ ] **A9.9** promptGuidelines 加 model/thinkingLevel 默认省略条：`grep -i 'model.*thinkingLevel.*omit\|顶层 model\|inherit.*main agent' <CUR>/<PKG>/src/interface/tool-workflow.ts` 命中（新增的 prompt 条目，文案含 model/thinkingLevel 默认继承语义）

#### A10. `src/interface/__tests__/detectors.test.ts`（C 类 · TC3g 修订 + 解冲突）

- [ ] **A10.1** TC3g 第一条 toEqual 删 "model"：`grep -A8 'TC3g:' <CUR>/<PKG>/src/interface/__tests__/detectors.test.ts | grep -F '["maxFixAttempts", "convergeNewIssues", "convergeRounds"]'` 命中（不再含 `"model"`）
- [ ] **A10.2** TC3g 第二条（args 内 model）保持不变：`grep -A6 'args: { model: "ds-flash"' <CUR>/<PKG>/src/interface/__tests__/detectors.test.ts | grep -F '["convergeRounds"]'` 命中
- [ ] **A10.3** 该测试文件运行通过：`cd <CUR>/extensions/subagent-workflow && npx vitest run src/interface/__tests__/detectors.test.ts` exit 0（包含 TC3g/TC3i 等所有用例）

#### A11. `workflows/review-fix-loop.js`（D 类 · 3 处改动）

- [ ] **A11.1** MODEL 改读 $MODEL：`grep -F 'const MODEL = $MODEL;' <CUR>/<PKG>/workflows/review-fix-loop.js` 命中
- [ ] **A11.2** 旧的 `$ARGS.model` 读取已删：`grep -F 'typeof $ARGS.model === "string"' <CUR>/<PKG>/workflows/review-fix-loop.js` **无命中**
- [ ] **A11.3** @pi-meta 的 model 声明已删：`grep -A30 '@pi-meta' <CUR>/<PKG>/workflows/review-fix-loop.js | grep -F 'model: { type: string }'` **无命中**
- [ ] **A11.4** fail 文案已删 `/model`：`grep -F '未知参数' <CUR>/<PKG>/workflows/review-fix-loop.js` 输出的那行**不含** `model`（grep 同行再 `| grep model` 应无命中）。完整命令：`grep '未知参数' <CUR>/<PKG>/workflows/review-fix-loop.js | grep -c '/model'` = 0
- [ ] **A11.5** 三处 agent 调用仍传 `model: MODEL`（未误删）：`grep -c 'model: MODEL,' <CUR>/<PKG>/workflows/review-fix-loop.js` ≥ 3（review batch / aggregator / fix 三处，行号原 384/619/848 附近）

#### A12. `workflows/review-fix-loop-utils.cjs`（D 类 · VALID_ARG_KEYS 删 model）

- [ ] **A12.1** VALID_ARG_KEYS 不含 model：`grep -A5 'const VALID_ARG_KEYS = new Set' <CUR>/<PKG>/workflows/review-fix-loop-utils.cjs | grep -F '"model"'` **无命中**
- [ ] **A12.2** 其余 16 个键未误删（原 17 项删 model 剩 16）：`grep -A8 'const VALID_ARG_KEYS = new Set' <CUR>/<PKG>/workflows/review-fix-loop-utils.cjs | grep -c '"'` ≥ 16（粗估键数；精确校验由 A12.3 测试覆盖）

#### A13. `src/__tests__/review-fix-loop-utils.test.ts`（D 类 · 删 expected 数组 model 项，v4 遗漏项）

- [ ] **A13.1** expected 数组删 model：`grep -B2 -A10 'VALID_ARG_KEYS（未知参数 fail-fast 白名单）' <CUR>/<PKG>/src/__tests__/review-fix-loop-utils.test.ts | grep -F '"model"'` **无命中**（原 line 59 的 `"model"` 项删除）
- [ ] **A13.2** 该测试文件运行通过：`cd <CUR>/extensions/subagent-workflow && npx vitest run src/__tests__/review-fix-loop-utils.test.ts` exit 0

#### A14. 无需改动文件的「负向」验收（防止误改）

- [ ] **A14.1** `lifecycle.ts` 未被改 model/thinkingLevel 透传（workerHost.start 三处传整个 spec，自动透传）：`grep -F 'spec.model\|spec.thinkingLevel' <CUR>/<PKG>/src/orchestration/lifecycle.ts` **无命中**（透传由 RunSpec 字段自动完成，不应在 lifecycle 里显式写）
- [ ] **A14.2** `error-recovery.ts` 同理：`grep -F 'spec.model\|spec.thinkingLevel' <CUR>/<PKG>/src/orchestration/error-recovery.ts` **无命中**
- [ ] **A14.3** 4 个不读 args 的内置 workflow 零改动：`cd <CUR>/<PKG> && git diff main -- workflows/chain.js workflows/parallel.js workflows/map-reduce.js workflows/scatter-gather.js` 无输出（这 4 个文件不在本次改动范围）
- [ ] **A14.4** `launcher.ts` 嵌套 workflow 未补 model 透传（L1 已知限制，本次不修）：`grep -F 'model: parentRun.spec.model' <CUR>/<PKG>/src/orchestration/launcher.ts` **无命中**

---

### B. 测试级验收（设计文档 §6 探针 + 现有测试）

**统一测试命令**（修正设计文档 §6 路径——`src/` 在 `extensions/subagent-workflow/` 下，不是 `extensions/` 下）：
```bash
cd <CUR>/extensions/subagent-workflow && npx vitest run \
  src/execution/__tests__/model-resolver.test.ts \
  src/orchestration/__tests__/worker-script-builder.test.ts \
  src/interface/__tests__/detectors.test.ts \
  src/__tests__/review-fix-loop-utils.test.ts
```

#### B1. 11 个探针逐条通过标准

| 探针 | 类型 | 通过标准 | 验证方式 |
|---|---|---|---|
| **P1** | 单测 | `:max` 后缀被 stripThinkingSuffix 剥离，resolveModel 命中不 throw | A4.1 + A4.2 + 上面的 vitest 命令含 model-resolver.test.ts 全绿 |
| **P2** | 单测 | availableThinkingLevels 列出 max 且为末位 | A4.3 + A4.4 + vitest 全绿 |
| **P3** | 集成（降级源码断言） | $MODEL global 注入 + agent() 三分支 fallback | A2.1-A2.5（源码）+ A5.3/A5.4（测试）+ vitest run worker-script-builder.test.ts 全绿 |
| **P4** | 集成（降级源码断言） | $THINKING_LEVEL global 注入 + agent() 三分支 fallback | A2.1/A2.2 + A5.3/A5.4 + vitest 全绿 |
| **P5** | 集成 | review-fix-loop 顶层 model → $MODEL → MODEL → agent() → resolveModel 整链 paramOverride 透传 | **降级为 grep 链验证**（无 worker harness）：①A11.1（MODEL=$MODEL）②A11.5（model:MODEL 透传）③A1.4（resolveModel :102 paramOverride?.model truthy）④model-resolver.test.ts 的 L1 测试（A4.5）守护纯函数优先级。worker harness 建成后补运行时断言 |
| **P6** | 单测 | subagent schema thinkingLevel 枚举含 max | A8.2（派生）+ 运行 `cd <CUR>/extensions/subagent-workflow && node -e "const m=require('./src/execution/model-resolver.ts'); console.log(m.THINKING_ORDER)"` 因 ts 文件无法直接 require，改用 grep 验证 A8.1+A8.2 后「派生即含 max」由 TS 类型系统 + A1.2 共同保证 |
| **P7** | 单测 | findFlattenedArgKeys 对顶层 model/thinkingLevel 不误报 | A10.1（TC3g 第一条无 model）+ A10.3（detectors.test.ts 全绿） |
| **P-T2** | 集成（降级断言） | VALID_ARG_KEYS 白名单删 model 后不崩 | A12.1 + A13.2（utils.test.ts 全绿，含 batchl 误拼 fail-fast 测试） |
| **P-T3** | 集成 | 对称验证：model+thinkingLevel 都不进 $ARGS；都经 global | **part 1（可执行）**：A9.7（无 args merge）+ A9.8（args 不变）。**part 2（降级）**：A2.1-A2.5 源码断言覆盖「注入逻辑写对」。运行时真生效需 worker harness（本次降级） |
| **P-T4** | 单测 | TC3g 修订后通过 | A10.1 + A10.2 + A10.3 |
| **P-D1** | 集成 | Option B 改造正确性：review-fix-loop 4 处代码改对 + agent 继承 | **part 1（grep）**：A11.1-A11.4（4 处代码）+ A12.1（utils.cjs）+ A13.1（utils.test.ts）。**part 2（降级）**：A11.5（三处 model:MODEL 透传）+ 整链由 P5 覆盖。运行时端到端见 D2 |

- [ ] **B1.1** P1 通过（按上表）
- [ ] **B1.2** P2 通过
- [ ] **B1.3** P3 通过（part 1 源码断言）
- [ ] **B1.4** P4 通过（part 1 源码断言）
- [ ] **B1.5** P5 通过（grep 链验证，4 个子点全绿）
- [ ] **B1.6** P6 通过（派生 + 类型系统保证）
- [ ] **B1.7** P7 通过
- [ ] **B1.8** P-T2 通过
- [ ] **B1.9** P-T3 通过（part 1 可执行；part 2 降级并在文档标注）
- [ ] **B1.10** P-T4 通过
- [ ] **B1.11** P-D1 通过（part 1 grep；part 2 端到端见 D2）

#### B2. 现有测试不破坏

- [ ] **B2.1** review-fix-loop-utils.test.ts 全绿（D 类改的断言同步）：A13.2
- [ ] **B2.2** model-resolver.test.ts 全绿（含 L1/L2/L3 + 既有 availableThinkingLevels subset 断言）：`cd <CUR>/extensions/subagent-workflow && npx vitest run src/execution/__tests__/model-resolver.test.ts` exit 0
- [ ] **B2.3** worker-script-builder.test.ts 全绿（含改后的 string-branch 断言 + P3/P4）：`cd <CUR>/extensions/subagent-workflow && npx vitest run src/orchestration/__tests__/worker-script-builder.test.ts` exit 0
- [ ] **B2.4** detectors.test.ts 全绿（含 TC3g/TC3i）：A10.3
- [ ] **B2.5** 整包测试全绿（排除降级探针的运行时部分）：`cd <CUR>/extensions/subagent-workflow && npx vitest run` exit 0（全量回归）

---

### C. 静态检查验收

- [ ] **C1** typecheck exit 0：`cd <CUR> && pnpm extensions:typecheck` exit 0（= `cd extensions && npx tsc --noEmit`）
- [ ] **C2** lint exit 0：`cd <CUR> && pnpm extensions:lint` exit 0（= `npx eslint extensions/`）
- [ ] **C3** RunSpec 加字段后类型链路完整（tsc 已覆盖，额外抽查）：`grep -rn 'spec.model\|spec.thinkingLevel' <CUR>/<PKG>/src/orchestration/` 应只在 `worker-host.ts` 出现（透传点），其他文件靠 RunSpec interface 类型推断，tsc 报错则 C1 已拦截
- [ ] **C4** subagent-tool.ts import THINKING_ORDER 后无循环依赖（tsc 已覆盖）：C1 通过即无循环依赖（tsc 会报 circular）
- [ ] **C5** 无新增 `any` / `as any`（前端规范）：`git diff main -- <CUR>/<PKG>/src/ | grep -E '^\+.*:\s*any\b|^\+.*as any\b'` 无新增行（extensions/ 由 taste/no-unsafe-cast 规则 warn，C2 已覆盖）

---

### D. 端到端验收

> 这部分需要 dev runtime 环境（`pnpm dev` + 真实 pi 子进程）。若实施者无法启动 dev 环境，至少完成 D1 的 grep 验证 + 把 D2/D3/D4 标注为「待用户手工验收」并明确说明。

- [ ] **D1** review-fix-loop 能用顶层 `--model` 跑（grep 可验证 + 运行时由用户确认）：
  - grep 侧：A11.1（MODEL=$MODEL）+ A11.5（model:MODEL 透传）已保证 plumbing
  - 运行时侧（待用户确认）：启动 dev，调一次 `{"action":"run","name":"...review-fix-loop.js","args":{...},"model":"<某可用 model>"}`，观察 review batch agent 是否用指定 model（查 trace 或 agent-call 日志）
- [ ] **D2** review-fix-loop 端到端无回归（设计文档 §7 检查点 7）：启动 dev 跑一次完整 review-fix-loop run（最小 batch），run 正常进入 review→aggregate→fix 阶段并最终 done，无「未知参数: model」报错
- [ ] **D3** 4 个不读 args 的内置 workflow（chain/parallel/map-reduce/scatter-gather）顶层 model 继承：调 `{"action":"run","name":"...chain.js","args":{"task":"...","agents":"..."},"model":"<某可用 model>"}`，观察 chain 内 agent 是否用指定 model。4 个 workflow 抽验 1 个即可（A14.3 已保证 4 个零改动，继承机制相同）
- [ ] **D4** 顶层 `thinkingLevel: "max"` 生效：调 `{"action":"run","name":"...chain.js","args":{...},"thinkingLevel":"max"}`，目标 model 支持 max 时不被 clamp（查 agent-call 的 thinkingLevel 字段为 max）。若目标 model 不支持 max 则 clamp 到最高可用（pre-existing 行为，非回归）

---

### E. 回归与边界验收（设计文档 §7 检查点 + 已知限制）

#### E1. §7 待验证检查点（逐条）

- [ ] **E1.1**（§7-1）pi SDK 对 tool params 未知字段策略：顶层 model/thinkingLevel 不被 pi 拒绝。验证：D1/D2/D3/D4 任一端到端调用成功（pi 接受了带 model 的 tool call）。若 pi 拒绝未知字段，C5 schema 已声明（A9.3/A9.4）应被 pi 识别为合法字段
- [ ] **E1.2**（§7-2）worker-script-builder 字符串拼接正确性：$MODEL/$THINKING_LEVEL 注入转义/作用域正确。验证：A2.1-A2.6（源码 grep）+ B1.3/B1.4（P3/P4 测试）。运行时由 D 覆盖
- [ ] **E1.3**（§7-3）resume/rebuild 路径透传：三处 workerHost.start 都传 spec，override 在 pause→resume 保留。验证：
  - grep 侧：A14.1（lifecycle workerHost.start 传 spec）+ A14.2（error-recovery 传 run.spec）+ RunSpec 加字段（A7.1/A7.2）→ 自动透传
  - 运行时侧（建议）：跑一次 run → pause → resume，确认 resume 后 agent 仍用原顶层 model
- [ ] **E1.4**（§7-4）GUI 侧不报错：workflow renderCall 展示 model——out-of-scope 但确认不崩。验证：D2 端到端跑时观察 GUI 无 JS error
- [ ] **E1.5**（§7-5）错误呈现层级：顶层 model 无效时，resolveModel lookupAndResolve 抛错 → SubprocessAgentRunner.run try/catch → AgentResult.error（单 call 失败被吞，workflow 继续）。验证：**主动构造**——传一个不存在的 model `{"action":"run",...,"model":"nonexistent/x"}`，期望：workflow 不整体崩溃，单 agent 报 model not found 错误（查 trace），workflow 继续后续 agent。**不期望**：workflow 整体终止
- [ ] **E1.6**（§7-6）thinkingLevel 非法值：经 $THINKING_LEVEL → resolveThinkingLevel 对非法 requested 静默 clamp 到最高可用（pre-existing）。验证：传 `{"action":"run",...,"thinkingLevel":"invalid-level"}`，期望：不 throw，clamp 到目标 model 最高可用级别（查 agent-call thinkingLevel 字段）
- [ ] **E1.7**（§7-7）Option B review-fix-loop 回归：改 D 类 5 处后跑 utils.test.ts + 一次端到端。验证：A13.2（单测）+ D2（端到端）

#### E2. §7 已知限制（逐条确认行为符合声明，非 bug）

- [ ] **E2.1**（L1）嵌套 workflow 不继承外层 override：`executeNestedWorkflow` 构建子 RunSpec 时不设 model/thinkingLevel → 子 worker global undefined → agent() fallback ctxModel，**静默降级**（不崩）。验证：
  - grep 侧：A14.4（launcher 未补 model 透传）
  - 行为侧：跑一个含嵌套 workflow() 调用的 workflow（外层传 model），观察嵌套层 agent 用的是 ctxModel 而非外层 model（**符合 L1 声明**）。若嵌套层用了外层 model 则 L1 限制被打破（可能是意外补了透传，查 A14.4）
- [ ] **E2.2**（L2 breaking）review-fix-loop 不再接受 `args.model`：删 VALID_ARG_KEYS 的 model 后，旧调用 `--args model=x` fail-fast（未知参数: model）。验证：
  - 构造调用 `{"action":"run","name":"...review-fix-loop.js","args":{"model":"x",...其他必填}}`，期望：返回 `未知参数: model` 错误（fail-fast），**不**启动 run
  - grep 侧：A12.1（VALID_ARG_KEYS 无 model）+ A11.4（fail 文案无 model——但「未知参数」机制本身仍触发）

#### E3. whitespace model 边界（设计文档 §2.2 诚实声明项）

- [ ] **E3.1** Option B 抛 lookup 错（非 trim 降级）：传 `{"action":"run",...,"model":"  "}`（纯空白），期望：resolveModel :102 `paramOverride?.model` truthy（`"  "` 是 truthy string）→ lookupAndResolve → 抛 `Model "  " not found` 类错误。**验证**：构造此调用，期望 workflow 内 agent 报 model not found（E1.5 的错误吞咽机制接管，单 call 失败 workflow 继续）。**注意**：这与源分支 Option A 的 `.trim()` 静默降级**不等价**，是 Option B 已知行为变更，**不算 bug**（畸形输入现实概率极低）

---

## 3. 验收检查表（实施者逐条勾选，按实施顺序）

> 顺序原则：A 类（干净搬入）→ B 类（叠加）→ C 类（重写）→ D 类（依赖 A2 的 $MODEL，须在 A2 后）→ 静态/测试/端到端。

### 阶段 0：DoR（开工前，§1）
- [ ] DoR-1 两 worktree 就绪
- [ ] DoR-2 commit 数 ≥ 32
- [ ] DoR-3 vitest 可加载
- [ ] DoR-4 基线 4 文件测试绿
- [ ] DoR-5 基线 typecheck + lint 绿
- [ ] DoR-6 设计文档核实点 3 条抽样一致

### 阶段 1：A 类搬入（6 文件）
- [ ] A1.1-A1.4 model-resolver.ts（THINKING_ORDER + export + 注释 + resolveModel 未动）
- [ ] A2.1-A2.6 worker-script-builder.ts（$MODEL/$THINKING_LEVEL 注入 + 三分支 fallback + 注释）
- [ ] A3.1-A3.2 worker-host.ts（workerData 透传）
- [ ] A6.1-A6.2 .xyz-harness 设计文档复制
- [ ] A4.1-A4.6 model-resolver.test.ts 追加 P1/P2（**A4 须在 A1 后**——否则 P1/P2 引用 max 会红）
- [ ] A5.1-A5.4 worker-script-builder.test.ts 改断言 + 追加 P3/P4（**须与 A2 同批**——否则 P3/P4 引用 $MODEL 会红）

### 阶段 2：B 类叠加（2 文件）
- [ ] A7.1-A7.4 run-spec.ts（model?/thinkingLevel? + 注释改写 + parameters 未破坏）
- [ ] A8.1-A8.3 subagent-tool.ts（import + 派生 + 硬编码删除）

### 阶段 3：C 类重写（2 文件）
- [ ] A9.1-A9.9 tool-workflow.ts（TOOL_TOP_LEVEL + WorkflowParams + actionRun 透传 + 无 args merge + prompt）
- [ ] A10.1-A10.3 detectors.test.ts（TC3g 修订 + 第二条不变 + 全绿）

### 阶段 4：D 类改造（3 文件，须在 A2 后）
- [ ] A11.1-A11.5 review-fix-loop.js（MODEL=$MODEL + @pi-meta 删 model + fail 文案删 model + 三处 agent 透传未误删）
- [ ] A12.1-A12.2 review-fix-loop-utils.cjs（VALID_ARG_KEYS 删 model）
- [ ] A13.1-A13.2 review-fix-loop-utils.test.ts（expected 删 model + 全绿）

### 阶段 5：负向验收（防误改）
- [ ] A14.1 lifecycle.ts 未显式写 spec.model
- [ ] A14.2 error-recovery.ts 同理
- [ ] A14.3 4 个内置 workflow 零改动
- [ ] A14.4 launcher.ts 嵌套未补透传（L1 限制保留）

### 阶段 6：静态检查
- [ ] C1 typecheck exit 0
- [ ] C2 lint exit 0
- [ ] C3 RunSpec 类型链路（tsc 覆盖）
- [ ] C4 无循环依赖（tsc 覆盖）
- [ ] C5 无新增 any

### 阶段 7：测试级（11 探针 + 现有测试）
- [ ] B1.1-B1.11 11 探针逐条
- [ ] B2.1-B2.5 现有测试不破坏（含全量回归 B2.5）

### 阶段 8：端到端（需 dev 环境）
- [ ] D1 review-fix-loop 顶层 model（grep + 运行时）
- [ ] D2 review-fix-loop 端到端无回归
- [ ] D3 4 内置 workflow model 继承（抽验 1 个）
- [ ] D4 thinkingLevel="max" 生效

### 阶段 9：回归与边界
- [ ] E1.1-E1.7 §7 七个检查点
- [ ] E2.1 L1 嵌套限制行为符合
- [ ] E2.2 L2 breaking 行为符合
- [ ] E3.1 whitespace model 抛 lookup 错（Option B 已知行为）

### 阶段 10：完成即提交
- [ ] 所有改动 git commit（遵循「完成即提交」规范，commit message 英文 conventional commits）
- [ ] 工作区无脏文件（`git status` 干净，或剩余文件均为认知外改动并已说明）

---

## 4. 失败处理

### 4.1 哪些是 blocker（必须解决才能声明完成）

| 失败项 | 性质 | 处理 |
|---|---|---|
| DoR 任一 | blocker | 不开工，先补齐前置（装依赖、拉 worktree、修基线红测试） |
| C1 typecheck / C2 lint | blocker | 必须正面修复，禁止 `--no-verify` 或 SKIP_* 变量。typical：RunSpec 字段类型、subagent-tool import 路径、review-fix-loop.js 字符串转义 |
| A 类搬入后基线测试红（B2.2/B2.3） | blocker | 多半是 A4/A5 与 A1/A2 未同批迁移（设计文档明确警告「须同批」）。修复：补齐同批迁移 |
| A9.7 命中 args merge | blocker | Option B 核心不变式被破坏。修复：删除 args merge，回到 `const args = params.args ?? {}` 单行 |
| A11.5 三处 model:MODEL 误删 | blocker | review-fix-loop 三处 agent 调用失去 model 透传。修复：恢复 `model: MODEL,` |
| B2.5 全量测试非绿 | blocker | 逐个排查失败用例：本次改动范围内的必须修；范围外的预存失败需单独评估（见项目 AGENTS.md cw v1 testRunner cwd 失效条目） |
| E1.5 顶层 model 无效导致 workflow 整体崩溃 | blocker | 与设计声明不符（应单 call 吞错 workflow 继续）。查 SubprocessAgentRunner.run 的 try/catch 是否被破坏 |

### 4.2 哪些可接受（非 blocker，标注后可声明完成）

| 失败项 | 性质 | 处理 |
|---|---|---|
| D2/D3/D4 端到端无法运行（无 dev 环境） | 可接受 | 标注「待用户手工验收」，grep 侧（D1）必须完成。在汇报中**明确声明**哪些 D 项未运行时验证 |
| P3/P4/P-T3-part2/P-D1-part2 运行时断言（需 worker harness） | 可接受（本次降级） | 设计文档 §6 已声明降级为源码字符串断言。标注「part 2 待 worker harness 建成后补」，part 1（源码断言）必须通过 |
| E3.1 whitespace model 抛错 | 可接受（已知行为） | 这是 Option B v5 诚实声明的行为变更，**非 bug**。在汇报中说明即可 |
| E2.1 嵌套 workflow 不继承外层 model | 可接受（L1 限制） | 设计文档 §7 L1 明确声明，本次不修。长期增强项 |
| E2.2 review-fix-loop args.model fail-fast | 可接受（L2 breaking） | 设计文档 §7 L2 明确声明，是 Option B 的预期破坏性变更 |

### 4.3 通用失败处理原则

1. **先 grep 后运行**：每个验收点先做 grep 侧（快、确定），grep 通过再跑测试/端到端。grep 失败直接定位代码未改对，回去修代码。
2. **不跳过检查**：pre-commit hook 检出的问题（lint / vue_rules_checker / runtime bundle 等）必须全部正面修复，禁止 `SKIP_*` 变量（项目 AGENTS.md「Lint / Git Hooks 问题处理原则」）。
3. **认知外改动不碰**：若 git status 出现非本次会话产生的改动，不提交、不修改、不删除，先与用户确认（全局防护规则 0）。
4. **失败要出声**：任一验收点失败，在汇报中放最前，明确列出未完成项与原因，禁止静默跳过（全局防护规则 3）。
5. **回滚边界**：仅本次会话产生的改动可回滚（`git checkout -- <file>`）；认知外改动禁止回滚。若改动跨多个 commit，用 `git revert <commit>` 而非 reset。

### 4.4 「无法提交」的处理

若穷尽正面修复后仍有检查失败导致无法 git commit（如认知外改动冲突、检查规则误报已确认但修复成本过高）：
- **不得** `git commit --no-verify` 静默跳过
- **必须**在汇报中明确说明未提交原因 + 已尝试的修复路径 + 建议的下一步
- 由用户决定是否人工介入或放宽规则

---

## 附录：核实记录（实施者可跳过）

本验收标准的每个 grep 模式、行号、测试文件路径均对照两分支实际代码核实（2026-09-10）：

| 核实点 | 当前分支状态 | 源分支状态 | 对应验收项 |
|---|---|---|---|
| THINKING_ORDER | line 64 `const`，无 max，无 export | line 70 `export const`，含 max | A1.1/A1.2 |
| TOOL_TOP_LEVEL | 8 键（action/name/slug/runId/args/tokens/time/error），无 model/thinkingLevel | — | A9.1/A9.2 |
| argKeysFromMeta 排除 TOOL_TOP_LEVEL | line 140 `if (!TOOL_TOP_LEVEL.has(k))` | — | A9.1（机制保证） |
| actionRun 锚点 | line 468 `const args = params.args ?? {}` + line 476 `runId = await runWorkflow(` | — | A9.5-A9.8 |
| review-fix-loop MODEL | line 165 `typeof $ARGS.model === "string" && $ARGS.model.trim()` | line 165 `const MODEL = $MODEL;` | A11.1/A11.2 |
| review-fix-loop fail 文案 | line 118 含 `/model/` | — | A11.4 |
| review-fix-loop @pi-meta model | line 47 `model: { type: string }` | 已删 | A11.3 |
| review-fix-loop 三处 `model: MODEL,` | line 335（display）/384/619/848 | — | A11.5 |
| VALID_ARG_KEYS | line 16 含 `"model"` | 已删 | A12.1 |
| utils.test.ts expected | line 59 含 `"model"` | 已删 | A13.1 |
| worker-script-builder $MODEL | **无** | line 111 注入 | A2.1 |
| worker-host workerData | line 54-68 无 model/thinkingLevel | 含 `model: spec.model, thinkingLevel: spec.thinkingLevel` | A3.1/A3.2 |
| RunSpec | 有 parameters?，无 model?/thinkingLevel? | 有 model?/thinkingLevel? | A7.1/A7.2 |
| subagent-tool thinkingLevel | line 94 硬编码 `["off"..."xhigh"]` | line 98 `StringEnum(THINKING_ORDER, ...)` | A8.1-A8.3 |
| TC3g 第一条 | line 115 `["model", "maxFixAttempts", ...]` | 无 model | A10.1 |
| TC3g 第二条 | line 122 `["convergeRounds"]`（args 内 model） | — | A10.2 |
| model-resolver.test.ts | 356 行，有 L1/L2/L3，无 P1/P2/max | 有 P1（line 255）+ P2（line 199/317） | A4.1-A4.6 |
| worker-script-builder.test.ts | string-branch 断言 `\|\| undefined`，无 P3/P4 | `\|\| $THINKING_LEVEL` + P3/P4 block（line 265-328） | A5.1-A5.4 |
| resolveModel paramOverride | line 102 `if (paramOverride?.model)` | 同 | A1.4 |
| subagent-service resolveIdentity | line 628，line 637 `{ model: opts.model, thinkingLevel: opts.thinkingLevel }` | 同 | P5 链路③ |
| lifecycle workerHost.start | line 202（runWorkflow）/ 318（resumeRun）传 spec | 同 | A14.1/E1.3 |
| error-recovery workerHost.start | line 147（rebuildRuntime）传 run.spec | 同 | A14.2/E1.3 |
| launcher executeNestedWorkflow | line 341 RunSpec 无 model/thinkingLevel | 同 | A14.4/E2.1 |
| WORKFLOW_ACTIONS | 5 项（run/status/pause/resume/abort），无 info | 同 | （MF-1 v6 确认） |
| 4 内置 workflow | chain/parallel/map-reduce/scatter-gather 读 $ARGS.task/target/operation，不读 $ARGS.model | 同 | A14.3 |
| .xyz-harness/workflow-subagent-thinking-level | **不存在**（repo root） | spec.md(33KB) + review.md(10KB) | A6.1/A6.2 |
| extensions scripts | typecheck=`cd extensions && npx tsc --noEmit`；lint=`npx eslint extensions/`；test=`pnpm -r --filter '@zhushanwen/pi-*' test` | — | C1/C2/B2.5 |
