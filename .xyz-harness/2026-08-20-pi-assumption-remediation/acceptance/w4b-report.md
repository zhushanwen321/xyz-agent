# W4b 验收报告：textResult 间接 isError 收敛 + execute-agent-call stale 对齐（verifier 对抗式独立验收）

> 日期：2026-08-20。verifier 独立验收，builder 自报一律经证实/证伪。基线 = `w4b-acceptance.md`（commit 899157062）。

## 总结论：**PASS**

C1-C4 全过 + 红性双层证实（行为红 + 编译器防线）+ 防篡改/越界干净。附 1 个 minor finding（注释行号引用失真，文案锚定正确）与 1 个范围外 finding 独立验证**属实**（workflow run 对不存在路径假启动，W4c 立项依据成立）。

## 验收条款判定

| 条款 | 判定 | 证据 |
|---|---|---|
| C1 grep 零第二参残留 + helper 无 isError 参数 | PASS | `grep -rn "textResult(" src`（非测试）仅 3 处单参调用（tool-workflow-script.ts:348 lint 成功 / :435 list 空 / :458 helper 定义）；tool-workflow.ts helper 已删净、零悬空引用；其他文件零 textResult。tsc 独立验证：向单参 helper 传第二参 → `TS2554: Expected 1 arguments, but got 2`（编译期防回潮成立） |
| C2 stale patterns 与真实文案匹配 | PASS | pi 实装 dist `runner.js:352` 与源码 `runner.ts:544` 原文核对一致；node 机械验证：新 patterns `ctx is stale` + `stale after session replacement` 双命中真实文案，旧 patterns（stale context/stalecontext）零命中（原失效成立）；marker 与 scheduler `STALE_CTX_MARKER`（runtime.ts:28）逐字一致；abort 族保留语义正当（见下） |
| C3 三连全绿 | PASS | `extensions:typecheck` exit 0（含 TS definite assignment 编译验证：script tool default 分支 throw 后 switch 出口 result 必然已赋值）；`extensions:lint` 0 errors / 194 存量 warning，W4b 文件零 warning；`extensions:test` exit 0 全包绿（subagent-workflow 166 文件 / 2245 tests） |
| C4 本地 pi CLI 实测 isError=true | PASS | verifier 独立实测 **generate ESM 检测路径**（与 builder 的 not_found 不同路径），隔离 dirs，`tool_execution_end isError=true` + 文案逐字一致（下「实测记录」） |

## 防篡改与越界

- 防篡改：`git diff 899157062 -- .xyz-harness/2026-08-20-pi-assumption-remediation/` 为空、无 untracked——验收文档未被改动。
- 越界扫描：工作区 15 modified + 2 untracked（不含本报告）全部落在并行豁免（W5：`.githooks/`、`packages/core/`、`execution/types.ts`；W6：`AGENTS.md`、`docs/`、`pi-protocol.ts`、`rpc-client.ts`；`chat-app/`）或 W4b 自报 7 文件（tool-workflow.ts、tool-workflow-script.ts、execute-agent-call.ts + 4 测试含新建 throw-paths）内。零越界。
- 红性探针还原验证：`git diff 899157062` 新增行中 `return textResult` 计 0——探针零残留，diff stat 与验收开始时逐文件一致。

## 23 处逐处审查（9 + 14 = 23，与 W4 verifier 判定 SSOT 一致）

机械证据：`git diff 899157062` 两文件的全部文案字符串行均为 diff 上下文行（未变行），变化仅限 `return textResult(` → `throw new Error(`、`, true` 参数与尾逗号删除——**23 处文案逐字保留，零借 throw 顺手改文案**。

### tool-workflow.ts（9 处，helper 整体删除）

| 基线行 | 文案摘要 | 可达性 | 行为变化审查 |
|---|---|---|---|
| 349 | Operation aborted before start | 真实可达 | throw 在 acquireReentryGuard 之前，无 guard 泄漏 |
| 353 | REENTRY_BUSY_MESSAGE | 真实可达 | acquire 失败 = 未持有 guard，throw 无需 release（注释正确） |
| 373 | Unknown action（exhaustive never） | 防御性 | try 内 throw，finally release 兜底；throw 后 finally 分支仍可达性由测试第 5 用例锁定 |
| 420 | run requires 'name' | 防御性 | 无状态，无泄漏 |
| 452 | Detected ... at top level | 真实可达 | 同上 |
| 460 | slug exceeds ... | 真实可达 | 同上 |
| 537 | 'runId' is required | 防御性 | 同上 |
| 541 | Workflow '<runId>' not found | 真实可达 | 同上 |
| 562 | abortRun catch `Error: ${msg}` | 真实可达 | "Error: " 前缀保持（pi catch 不加前缀，见机制核实） |

helper 删除正当性：本文件无非错误纯文本用途（所有成功路径构造对象字面量），删除即签名收缩最强形态。

### tool-workflow-script.ts（14 处，helper 保留单参）

基线行 214 / 244 / 249 / 255 / 263 / 273 / 281 / 293 / 303 / 335 / 344 / 389 / 414 / 450——文案逐字保留（含 em-dash、`\\d` 转义提示、suggestions 列表拼接）。防御性 5 处（Unknown action / generate requires / lint requires / save requires / delete requires，schema 先拦）；真实可达 9 处。

### 行为变化（return isError → throw）pi 侧差异完整核实

`@earendil-works/pi-agent-core` dist agent-loop.js `executePreparedToolCall`（:454-486）：

- 正常 return 路径 `isError: false` **硬编码**——返回值里 result.isError 字段被丢弃（修复前 23 处全部错误被标成功的机制根源）。
- throw 路径 catch → `createErrorToolResult(error.message)`（:519-524）：`content: [{type:"text", text: message}]` 文案原样、无前缀；`details: {}`——**details 丢失为唯一行为差异，W4 已登记接受**（本文件所有 throw 路径原本 details 也是 undefined，无实质损失）。
- default 分支 throw 后 TS definite assignment：`let result: TextContent` 无初始化 + 全 case 赋值/throw → tsc 通过即编译器确认（C3 已验）。

## stale 对齐复核

- 真实文案（dist runner.js:352 = 源码 runner.ts:544，逐字一致）：`This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ...`
- node 机械验证：`["ctx is stale","stale after session replacement"]` 双命中；旧 `["stale context","stalecontext"]` 零命中——原 patterns 对真实文案完全失效（stale 错误曾退化为普通错误重试 3 次），W4b 修复正当性成立。
- marker 跨包一致：`"stale after session replacement"` 与 scheduler `STALE_CTX_MARKER`（extensions/scheduler/src/runtime.ts:28）逐字相同，与 goal/session.ts:39 注释同锚——三处 SSOT 对齐。
- abort 族保留正当性：`context canceled`/`aborted` 保留——execute-agent-call.ts:181 stale 分诊在 :188 `signal.aborted` 分支**之前**，若 abort 族错误在 signal 未置位时出现（子进程内部 cancel 竞态），删除 pattern 会放宽为重试；abort 族重试无意义，保留是收紧语义。两条路径终态相同（finalizeCall failed 不重试），无行为冲突。
- 生产调用方确认：STALE_CONTEXT_PATTERNS 唯一消费者 `isStaleContextErrorMsg` → execute-agent-call.ts:181（agent() 子进程重试分诊），修复后 stale 场景正确短路退避重试。
- 测试复跑：execute-agent-call.test.ts W4b describe 4 用例（真实文案 predicate true / patterns 含双 marker / 真实文案 runner.run 恰 1 次不重试 + trace failed / 普通错误不误命中）独立复跑全绿。

## 实测记录（verifier 独立，隔离环境，探针已清理）

- 环境：`PI_CODING_AGENT_DIR=/tmp/w4b-v-agentdir`（仅 auth.json）、`--session-dir /tmp/w4b-v-sessions`、`--model xiaomi-token-plan-cn/mimo-v2.5-pro`、`--approve --no-builtin-tools --extension <subagent-workflow 源码 index.ts>`，pi 0.84.2 RPC 模式（命令格式 `{"id":N,"type":"prompt","message":...}`，stdin 须保持打开至 turn 完成否则 pi 提前 shutdown）。
- **实测（generate ESM import 检测，W4b 第 5 代表路径，与 builder 的 not_found 不同）**：驱动 LLM 调 `workflow-script {action:"generate", name:"demo-esm", script:"var x = 1; import fs from fs; agent(w)"}` → 输出 `tool_execution_end isError=true`，`content = "Script uses ESM 'import' syntax. Workflow scripts run in a CJS Worker — use require() instead."`（与源码 throw 文案逐字一致，含 em-dash），`details={}`（pi 固定）。模型 assistant 回复明确陈述 "the tool returned an error"——isError 语义真实生效（修复前该文案会被标成功，模型误以为脚本已生成）。
- 清理：/tmp/w4b-v-* 全部删除。

## 红性验证（双层）

1. **行为红**：临时将 ESM import 一处退回 `return textResult(..., true)`（Edit 精确替换）→ `tool-workflow-script-generate.test.ts` TC6 红（`toThrow` 断言失败：函数 resolve 而非 reject，1 failed | 12 passed）。
2. **编译器防线**：同一探针形态下单参 helper 收到第二参 → `tsc --noEmit` 报 `TS2554: Expected 1 arguments, but got 2`（subagent-workflow/src/interface/tool-workflow-script.ts(259,7)）——签名收缩构成编译期防回潮，测试漏网时 tsc 兜底。
3. 还原：Edit 复原 → 13/13 绿；`git diff` 新增行零 `return textResult` 残留，diff stat 与验收开始时一致。

## 范围外发现独立验证：**属实**（builder 报告 workflow run 对不存在路径假启动）

静态链路 + 运行时探针（隔离环境，探针已删）双重证实：

1. `toCachedMeta`（config-loader.ts:119-152）对不可读/不存在文件 catch 后返回 **fail-safe stub**：`{kind:"workflow", name:<stem>, description:"", phases:[], path, available:false, source}`——`getWorkflowByPath`（:285-299）对绝对 .js 引用**永不返回 undefined**（仅 normalizeRef 失败才 undefined）。
2. `WorkflowScriptRegistryImpl.getPath`（registry-impl.ts:77-80）：stub truthy → `toScript(stub)` → 返回 `available:false, sourceCode:""` 的 WorkflowScript 实体。
3. `actionRun`（tool-workflow.ts:428-440）not_found 检查为 `if (!script)` **truthy 检查，不查 available**——stub 实体绕过；对比同函数 not_found suggestions 分支过滤 `wf.available`（:433），主路径与建议列表口径不一致。
4. `validateRunArgs`（args-validator.ts:73）`if (parameters === undefined) return`——stub 无 parameters 直接放行。
5. **运行时探针实证**（真实 WorkflowScriptRegistryImpl，隔离 dirs）：`getPath("/tmp/.../no-such-workflow.js")` 返回 `entity name=no-such-workflow available=false sourceCodeLen=0`（truthy，not_found 绕过证实）；actionRun 一路走进 runWorkflow 启动链（探针瘦 deps 在 workerHost.start 处 crash，反证前置检查全部放行）。
6. 生产后果：LLM 给幻觉/过期路径 → 收到「run 已启动 + runId」而非 not_found（含正确建议列表）→ run 随即失败，错误信息误导且多耗一轮交互。

**W4c 立项依据成立**。修复方向建议（供 W4c 参考，非本次验收范围）：actionRun 入口改 `if (!script || !script.available)` 归入 not_found 分支（最小改动，与 suggestions 过滤口径对齐）。

## Minor finding（不阻塞）

- **注释行号引用失真**：execute-agent-call.ts:50 注释与 execute-agent-call.test.ts:274 注释引用 `runner.ts:531 / dist runner.js:567`，实际为源码 `runner.ts:544` / dist `runner.js:352`（W4 verifier 报告锚点表用的是正确的 352）。文案引文本体逐字正确，仅行号抄写失真。建议 W4c 顺手修正（suggestion 级）。
- tool-workflow-script.ts:348 存量文案含 "✅"（lint 成功提示）为 W4b 之前既有，非本次引入，不新增判定。
