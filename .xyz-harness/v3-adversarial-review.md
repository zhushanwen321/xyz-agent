# 资源暴露重构 v3 对抗式审查（4 攻击点）

> 审查对象：`/tmp/resource-exposure-redesign-design.md`（v3 终态设计）
> 代码库：`extensions/subagent-workflow/`（当前 main 状态，v3 尚未实施）
> 范围：4 个攻击点逐一裁决；不重报 C1-C12 已修问题，只报 v3 修复本身的新缺陷或集成遗漏。

## 总体裁决

**v3 新机制「需补 fail-fast 传播契约」——不能照实施。** 单一 chokepoint 校验本身设计正确（攻击点 2/4 成立、攻击点 3 无死循环），但 v3 §4.4 写了 `return failFast(...)` 却未定义 `failFast` 的传播机制（throw / return sentinel / 新 reason），而三个调用方的返回契约各不相同且互斥，照做必然至少一条路径行为错误。这是唯一的 must-fix。

---

## 攻击点 1：fail-fast 如何穿透 runWorkflow 的返回契约

### 被攻击 claim（v3 §4.4 原文）

> `const check = validateRunArgs(spec.args, spec.parameters, spec.scriptName);`
> `if (!check.valid) { return failFast({ workflowName: spec.scriptName, errors: check.errors, schema: check.schema, received: spec.args }); }`

且「fail-fast 错误格式（引导 agent 重试）」给出了多行格式（含 schema + received + 重试指引）。

### 代码证据

- `runWorkflow` 签名 `Promise<string>`（`src/orchestration/lifecycle.ts:145-147`），现状仅在 pre-aborted signal 时 throw（`lifecycle.ts:155-158`）。
- `failFast` 未定义、`args-validator.ts` 不存在、`RunSpec` 无 `parameters` 字段（grep 全仓 src/ 确认）——v3 是待实施设计。
- 三个调用点契约各不相同：

| 调用点 | 行号 | runWorkflow 包 try/catch? | runId 用途 | 返回契约 |
|---|---|---|---|---|
| actionRun | `tool-workflow.ts:411` | 无；外层 execute（L295-322）只有 `try/finally` 释放 reentry guard，**无 catch** | "Started ... do NOT poll status"（L423-424）+ `stateFile: deps.store.stateFilePath(runId)`（L427） | `ToolResult`（pi 据 isError/content 判断） |
| runAndWait | `launcher.ts:218` | 无 | 传给 pollRunToResult | `WorkflowRunResult`（status 恒 done，**调方据 reason 判断**，现有 reason: completed/failed/aborted/budget_limited/time_limited，**无校验失败 reason**） |
| executeNestedWorkflow | `launcher.ts:325` | **无——runWorkflow 在 `try`（L341）之前调用，`finally`（removeEventListener）只包 pollRunToResult** | 传给 pollRunToResult | `{ content, parsedOutput?, error? }`（**soft-fail，不抛错**） |

### 逐调用方裁决（throw vs return "" vs return sentinel，每种都至少坏一条）

**actionRun**（`tool-workflow.ts:411`）：
- 若 throw → actionRun 抛错，外层 execute `finally` 仅释放 reentry guard、**无 catch**（L295-322），throw 原样冒泡到 pi tool 执行器。fail-fast 格式化的「schema+received+重试指引」变成未结构化的 raw tool error，agent 在不可控的格式下看到错误（v3 设计的引导重试意图降级）。
- 若 return "" → 报 `Started workflow 'X' (). Running in background — do NOT poll status`，runId="" 且 `stateFile = deps.store.stateFilePath("")`（bogus 路径）。**agent 被显式告知「do NOT poll status」却什么都没启动——静默失败，最坏结果**。

**runAndWait**（`launcher.ts:218`）：
- 若 throw → runAndWait 无 catch，直接抛给 `pi.__workflowRun` 编程调用方。契约是「返回 `WorkflowRunResult`（status 恒 done，据 reason 判断）」——调方拿不到 WorkflowRunResult，契约破裂。
- 若 return "" → `pollRunToResult(runId="")` → `deps.runs.get("")` 未命中 → 返回 `{status:"done", reason:"failed", error:"Run not found"}`（`launcher.ts:155`）。**v3 设计的 schema+received+重试指引全部丢失**（pollRunToResult 无从知道校验错误）。现有 reason 枚举无「校验失败」语义。

**executeNestedWorkflow**（`launcher.ts:325`）：
- 若 throw → runWorkflow 在 `try`（L341）之前抛，`finally`（removeEventListener）**不执行** → `onParentAbort` listener 残留在 parentSignal 上。这是**真实回归**：现状 runWorkflow 仅 pre-abort 抛（罕见），v3 把 throw 扩到校验失败（常见），放大了这个 listener 泄漏到高扇出场景。throw 最终被 `dispatchWorkflowCall` 的 `.catch`（`error-recovery.ts` dispatchWorkflowCall 末尾）接住 → `postResult({error})` → soft-fail 回 worker，但 listener 已泄漏 + error 串是否含完整 schema 取决于 throw 的 message 构造。
- 若 return "" → pollRunToResult "Run not found" → `{content:"", error:"Run not found"}`，schema+received 丢失。

### 裁决：真问题（significant，趋向 blocks-goal）

**v3 §4.4 缺失 failFast 的传播机制定义。** 三种选择（throw / return "" / return 特殊 runId）无一能同时满足三个调用方契约：
- throw：runAndWait 契约破裂（编程调用方据 reason 判断，不接 exception）+ executeNestedWorkflow listener 泄漏回归 + actionRun 变未结构化 tool error。
- return ""：actionRun 静默「Started 但没启动」+ runAndWait/executeNestedWorkflow 的 fail-fast 载荷（schema/received/重试指引）全部降级为 "Run not found"。
- return 特殊 runId：与 return "" 同病（actionRun 报 Started 但 stateFile/runId 无效）。

**实施者必须补三件事**才能照做：(a) 定义 failFast 是 throw 还是结构化返回（v3 未定）；(b) 三个调用方各自把校验失败映射成各自契约内的载体（actionRun → isError ToolResult；runAndWait → 新 reason 如 `"invalid_args"`；executeNestedWorkflow → `{error: 完整 fail-fast 文本}`），并把 runWorkflow 调用纳入各自的错误处理（executeNestedWorkflow 必须把 L325 的 runWorkflow 也包进 try/finally）；(c) runWorkflow 返回 `Promise<string>` 与 `return failFast(...)`（非 string）类型矛盾需消解。

**这是 must-fix：照 v3 字面实施，三条路径必然至少一条行为错误。**

---

## 攻击点 2：模块级 ajv 缓存按「schema 对象引用」作 key 的命中率

### 被攻击 claim（v3 §4.4）

> `const compileCache = new Map<unknown, (d: unknown) => boolean>(); // schema 对象引用 → 编译结果`
> 注释：「schema 来自 meta（registry 60s TTL 缓存内对象引用稳定），故用对象引用作 key。」

### 代码证据

- `config-loader.ts:297-308` `getWorkflow(name)`：TTL 内（`isCacheValid` L65-67）返回 `cached.meta`（L300，**同一对象引用**）；TTL 过期 → `loadWorkflows()` → `discoverWorkflows()`（L282），后者**无条件全量重扫并用新对象 `bucket.set(wf.name, {meta: wf, cachedAt: now})`**（L259-262）覆盖整个 bucket。
- `workflow-script-registry-impl.ts:103-126` `toScript`：**现状每次 new WorkflowScript 且重建 meta 对象（只留 name/description/phases，丢 parameters）**——v3 §1 已点明此 bug，M2 改为 `meta: m.meta` 整对象透传。M2 实施后，`script.meta.parameters === cached.meta.parameters`（同一引用）。
- **关键反驳假设**：每 turn 注入器（`workflow-list-injector.ts` setupWorkflowListInjector → `discoverAllWorkflows` → `discoverResources` **直接调 shared 模块**，不经 config-loader 的 cache bucket）**不污染 ajv 缓存**。已读 `injectors/workflow-list-injector.ts:248-270` 确认它不调 `loadWorkflows`/`discoverWorkflows`，所以每 turn 注入不会重建 bucket。

### 命中率量化

| 场景 | parameters 引用 | ajv 结果 |
|---|---|---|
| 60s 内同 workflow 多次 run（loop/并行嵌套） | 同一（TTL 内 getWorkflow 返回 cached.meta） | **HIT**（v3 claim 成立） |
| TTL 过期（~每分钟一次活跃使用） | 新对象（discoverWorkflows 重建） | MISS → 重编译 |
| `loadAll()`（list action / not-found 建议 / generate-list） | discoverWorkflows 重建全 bucket → 所有 workflow 新对象 | 下次任意 run = MISS |
| invalidate（save/generate/delete + fs.watch，C6） | `cache.clear()`（L313） | 下次 = MISS |

**热 workflow（>1 次/分钟）稳态：约每 60s 重编译一次**（TTL 刷新），但循环内/并行同 workflow 的高频场景缓存确实命中。

### 裁决：设计成立 + 1 处 minor 新缺陷

v3「对象引用稳定」在其适用范围（TTL 内 + 不被 loadAll/invalidate 打断）**准确**，对高频同 workflow 场景（loop/并行嵌套）有真实收益；间隔较远的交互式 run 每次重编译，但小 schema 的 ajv.compile 是微秒级，可忽略。**设计成立**。

**minor 新缺陷**：模块级 `compileCache`（Map）**从不清理**。TTL 刷新 / loadAll / invalidate / fs.watch 后，旧 parameters 对象对应的 ValidateFunction 条目成为孤儿，永远留在 Map。被 distinct schema 版本数上界（小），增长慢，但 v3 未提任何 cleanup。`src/orchestration/args-validator.ts`（M3 新增）应在 invalidate 时清空 compileCache，或在 validateRunArgs 内对 Map size 做上限。severity: minor。

---

## 攻击点 3：error-recovery 是否会把校验失败当瞬时错误重试

### 被攻击 claim

worker 内调 `workflow(Y, args)` 经 error-recovery 路由到 executeNestedWorkflow → runWorkflow。校验失败若以 error 回到 worker，error-recovery 是否用同一份坏 args 无限重试（确定性失败）→ 死循环风险。

### 代码证据

- 校验发生在 runWorkflow 内（M3）**早于** `deps.workerHost.start`（`lifecycle.ts:163`）——校验失败时 worker 根本没启动。
- error-recovery 重试（`error-recovery.ts:380-410` handleWorkerError / `460-490` handleScriptError）作用于**父 run**，且有硬上界 `MAX_WORKER_RETRIES = 3`（`error-recovery.ts:39`）+ 指数退避（1s/2s/4s）。
- 嵌套路径：`dispatchWorkflowCall`（`error-recovery.ts`）→ `onWorkflowCall` → `executeNestedWorkflow` → runWorkflow 校验失败 → 返回/抛 error → `dispatchWorkflowCall` 的 `.then/.catch` → `postResult({error})` 回 worker → worker 内 `workflow()` Promise resolve with error。**这一步本身不触发 error-recovery**。
- 仅当父脚本**随后**对该 error 抛错（如 `if (r.error) throw r.error`）→ worker 发 `{type:"error"}` → handleScriptError → 重试父脚本（用同一 `run.spec.args` 重跑）。若父脚本确定性重调 `workflow(Y, badArgs)`，确定性失败重复至多 3 次 → transition done,failed。**有界，非无限。**

### 裁决：无法证实「无限重试」；minor 确定性重试浪费

「死循环/无限重试」**不成立**——MAX_WORKER_RETRIES=3 硬界。是否触发重试**取决于父脚本是否对嵌套 error 抛错**（脚本相关，非必然）。

**minor 真实交互**：error-recovery **不区分确定性错误（校验失败，不应重试）与瞬时错误（worker 崩溃，应重试）**。v3 把「校验失败」引入为新的确定性错误源，若父脚本抛错则会浪费 3 次 rebuild + 7s 退避后才 failed。这是 v3 引入的新交互（当前无 args 校验，不存在此类确定性失败喂入重试路径），但有界且脚本相关，severity: minor。

---

## 攻击点 4：第 4 条 RunSpec 构造路径再排查

### 被攻击 claim

v3 列了 3 处（actionRun/runAndWait/executeNestedWorkflow）。是否有第 4 处构造 RunSpec 时不拷 parameters → silently 跳过校验（C1 退化）。

### 代码证据

grep `runWorkflow(` 于 src/（排除 __tests__）——恰好 3 处：
- `tool-workflow.ts:411`（actionRun）
- `launcher.ts:218`（runAndWait）
- `launcher.ts:325`（executeNestedWorkflow）

grep `scriptSource:` 构造点（排除定义/注释/测试）——恰好对应这 3 处。`worker-host.ts:50` 只读 `spec.scriptSource`（不构造 RunSpec）。`resumeRun`（`lifecycle.ts:231`）与 `rebuildRuntime`（`error-recovery.ts:140`）**复用 `run.spec`（已持久化、不可变）**——非新构造，且校验已在首次 runWorkflow 完成。

### 裁决：无法证实；v3 枚举完整

**无第 4 处 RunSpec 构造路径。** v3 的 3 点枚举对当前代码库完整。单一 chokepoint 设计（runWorkflow 校验；resume/rebuild 复用已校验 spec）正确，无 silent-skip 路径。

---

## 汇总

| 攻击点 | 裁决 | severity |
|---|---|---|
| 1 fail-fast 传播 | **真问题**：v3 §4.4 未定义 failFast 传播机制，三调用方契约互斥，照做必坏 | significant（must-fix） |
| 2 ajv 缓存命中率 | **设计成立** + minor：compileCache 从不清理，TTL/invalidate 后孤儿条目累积 | minor |
| 3 error-recovery 重试 | **无法证实无限重试**（MAX=3 硬界）+ minor：不区分确定性/瞬时错误，v3 引入新确定性失败源 | minor |
| 4 第 4 条路径 | **无法证实**：v3 3 点枚举完整，无 silent-skip | — |

must-fix：1（攻击点 1）。suggestion：2（攻击点 2 缓存清理、攻击点 3 确定性错误不重试）。
