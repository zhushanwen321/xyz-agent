# U1 验收报告 — 行为删除（pause/resume 全链路 + session 终止重定位）

> verifier 独立验收（对抗式，builder 自报全部经独立证实）。验收基线 commit `2cff4d3f8`，验收日期 2026-08-16。
> 权威标准：`u1-acceptance.md`（含 R6 裁决）+ `docs/design/workflow-one-shot-lifecycle-impl-spec.md` §0/§1/§3。

## 总结论：**PASS**

全部硬项（防篡改 / 三命令 / grep 断言 / 契约 7 条 / 禁改清单 / E2E S1+S2+S4+S7 + 对抗抽查）通过。失败项：无。3 条环境注记（非 FAIL，详见 §6）。

---

## 1. 防篡改

| 检查 | 结果 |
|---|---|
| `git diff 2cff4d3f8 -- .orchestration/ docs/design/` | **空**（零改动） |
| `git status --short` | 恰 16 文件，逐文件比对全部在允许清单（7 源 + 7 测试 + R6 裁决 2 测试），无清单外改动 |
| 验收文档 sha256 | `92aab784775a28e4823e892129562f0b0f334a8997e8e110b0fa0b7e15de8d93`（u1-acceptance.md） |
| 设计文档 sha256 | `a0738ade50a66b45fa953d7d1c9dcd06de3927b1684740ad4d7c72a87f2edf97`（workflow-one-shot-lifecycle-impl-spec.md） |
| E2E 全程结束后复查 | 工作区仍为同 16 文件（与验收开始时 `git status --short` 逐行 diff 一致），验收/设计文档 diff 仍为空 |

改动文件清单（与验收文档「交付物」+ R6 裁决 1 完全一致）：

- 源码 7：`src/orchestration/lifecycle.ts`、`src/orchestration/error-recovery.ts`、`src/index.ts`、`src/interface/tool-workflow.ts`、`src/interface/commands.ts`、`src/interface/command-actions.ts`、`src/interface/views/WorkflowsView.ts`
- 测试 9：`lifecycle.test.ts`、`error-recovery-handlers.test.ts`、`error-recovery-workflow-call.test.ts`、`launcher-nested-workflow.test.ts`、`workflow-nesting-e2e.test.ts`、`command-handlers.test.ts`、`index-session-start.test.ts` + R6 扩入 `command-actions.test.ts`、`robustness-low-batch1.test.ts`

## 2. 命令实跑（仓库根 / 包目录）

### 2.1 `pnpm extensions:typecheck` → **exit 0**

```
> cd extensions && npx tsc --noEmit
TYPECHECK_EXIT=0
```

### 2.2 `pnpm extensions:lint` → **exit 0**（0 errors，191 warnings 存量）

```
✖ 191 problems (0 errors, 191 warnings)
LINT_EXIT=0
```

builder 改动文件无新增 warning：对 7 个改动源文件单独跑 eslint → 仅 1 warning（`error-recovery.ts:263:140 no-magic-numbers 200`），经基线比对确认为存量行平移（基线 :232 的 `slice(0, 200)`，builder 在其上方新增 31 行导致行号位移，同一行代码）。当前 7 文件 warning 总数 1 ≤ 基线对应行数，数学上不可能有新增。

### 2.3 `cd extensions/subagent-workflow && npx vitest run` → **4 failed / 2171 passed**，失败全部在豁免清单

```
 ❯ src/orchestration/__tests__/skill-discovery.test.ts (6 tests | 2 failed)
     × user 次之：仅 user/npm 存在时返回 user 路径
     × npm 兜底：仅 npm 包内存在时返回包内 skills 路径
 ❯ src/execution/__tests__/spawn-worktree-guidance.test.ts (2 tests | 2 failed)
     × worktree 模式 → appendSystemPrompt content 含 worktree 认知纠正提示
     × 非 worktree 模式 → content 不含 worktree 认知提示
 Test Files  2 failed | 161 passed (163)
      Tests  4 failed | 2171 passed (2175)
```

与豁免清单（skill-discovery ×2 / spawn-worktree-guidance ×2）完全一致，无额外失败。

### 2.4 `grep -rn "pauseRun\|resumeRun" src/` → 恰 6 处，全部清单外

```
src/__tests__/gui.test.ts:429        （fixture 字符串）
src/__tests__/gui.test.ts:437        （fixture 字符串）
src/orchestration/models/run-runtime.ts:27   （存量注释）
src/orchestration/models/budget.ts:103       （存量注释）
src/orchestration/models/trace.ts:156        （存量注释）
src/orchestration/__tests__/jsonl-run-store-session-file.test.ts:404 （存量注释）
```

与验收标准 S8a 清单逐条匹配；U1 领地（7 源 + 8 测试文件）内零命中。6 处残留全部属 U2 处置范围。

## 3. 存量失败归因（独立证实）

1. **文件交集为空**：`git diff --name-only`（16 文件）与两失败测试文件及其被测模块求交集 = 空。传递依赖核验：`skill-discovery.ts` 仅 import node 内置 + pi 包；`spawn-worktree-guidance.test.ts` 被测 `session-runner.ts` 只引用 `./lifecycle-manager.ts`（execution 层，非 orchestration/lifecycle.ts，不在改动清单）。
2. **stash 基线复跑**：`git stash` → 基线（2cff4d3f8，无 builder 改动）下跑两文件 → `Tests 4 failed | 4 passed (8)`，同样 4 个失败 → `git stash pop` 原样恢复。stash 前后 `git status --short` 逐行 diff 一致（STATUS_IDENTICAL）。

结论：4 失败先于 builder 改动存在，与本 diff 无关。归因成立。

## 4. 接口契约 7 条对照（源码逐条核验）

| # | 契约 | 结果 | 证据 |
|---|---|---|---|
| 1 | `terminateRunningRuns(deps, reason)` 签名 + per-run 行为 + 不调 onRunDone + try/catch 不中断 | ✅ | `lifecycle.ts:322-344`：签名一致；循环体 `state.error = reason` → `transition("done","failed")` → `await store.save` → `emit("pending:unregister",{reason:"failed"})`；函数体无 `deps.onRunDone` 调用（lifecycle.ts 全文 onRunDone 仅 :292 abortRun 内）；catch 记 log 后继续下一 run。测试 4 用例断言真实：用例② `expect(deps.onRunDone).not.toHaveBeenCalled()`（vi.fn 调用记录）；用例④ bad run save 抛 "disk full" 后 good run 仍 save + unregister |
| 2 | 删除导出 pauseRun / resumeRun | ✅ | diff 显示两函数整段删除（-108 行块）；grep 全域无存活定义 |
| 3 | discardInFlightCalls 移入 error-recovery.ts 模块级私有，唯一调用点 = rebuildRuntime 内 replaceRuntime 后同步 | ✅ | `error-recovery.ts:134`（非 export 的 function）；唯一调用 `:187`，位于 `run.replaceRuntime(...)` 之后紧邻下一语句，同函数内无 await 间隔；grep 全域其余命中均为注释/测试。MUST_FIX (round-4 #1) 标记已随移除，注释按 F2 重写 |
| 4 | WorkflowAction 收窄 3 值；WorkflowRpcAction 删 pause/resume 增 lifecycle-removed | ✅ | `tool-workflow.ts:53-61`：`"run" \| "status" \| "abort"` + WORKFLOW_ACTIONS 同步；`command-actions.ts:18-22`：联合类型精确匹配；`actionLifecycle` 签名收窄 `action: "abort"`；execute case pause/resume 分支删除 |
| 5 | 原因串字面值 | ✅ | `index.ts` session_tree：`"Session switched: run terminated"`；session_shutdown：`"Session shutdown: run terminated"`——逐字符匹配（W2TC16 测试亦断言 session_shutdown 路径字面值） |
| 6 | removed 提示文案逐字 + warning 级 | ✅ | `commands.ts` lifecycle-removed case：`` `Workflow ${parsed.verb} has been removed — runs are one-shot. To stop a run early: /workflows abort <runId>` `` warning 级；E2E 实测输出逐字一致（§5 S4②） |
| 7 | promptGuidelines 新增句逐字 | ✅ | `tool-workflow.ts`：`Runs are one-shot: there is no pause/resume — to stop a run early use abort; for a fresh result start a new run.` 逐字符匹配 |

### 4.1 单测验收 5 组抽查（防空洞断言）

| 组 | 结果 | 证据 |
|---|---|---|
| lifecycle.test.ts | ✅ | pauseRun/resumeRun describe 整删；terminateRunningRuns 套件恰 4 用例对应验收 1①-④；用例④断言 bad run 的 unregister 被 save 失败短路（`emit` not called with bad id）+ good run 正常落盘——精确反映实现顺序 |
| error-recovery 系列 | ✅ | `error-recovery-handlers.test.ts:341`「rebuildRuntime 后同步清理在飞 call」：注入 running(call 7)/done(call 8) 双 call + `removeByStepIndex` spy，断言 `calls.has(7)===false`、`calls.has(8)===true`、spy 以 7 调用恰 1 次；paused 守卫用例全数改 isTerminal 语义 |
| command-handlers.test.ts | ✅ | 3 用例断言 removed 文案逐字（pause 带 id / pause 无 id / resume 带 id）+ `mockedAbortRun` not called + warning 级 |
| index-session-start.test.ts | ✅ | W2TC16 用 deferred gate 真实验证 await 边界：terminate 未 resolve（mock 挂起）→ `await Promise.resolve()` 后 dispose **未被调**；resolve 后 dispose 被调恰 1 次 + 原因串字面值断言 + 二次 shutdown 幂等（间接证 sessionState 清理顺序） |
| launcher-nested / workflow-nesting-e2e | ✅ | deps mock 已无 pauseRun/resumeRun 字段（vitest 全绿即证） |

### 4.2 禁改清单核验

- 禁改 5 文件 diff **全空**：`models/types.ts`、`models/workflow-run.ts`、`jsonl-run-store.ts`、`gui-mappers.ts`、`views/format.ts`
- `runWorkflow` 创建路径一行未动：lifecycle.ts 全部 diff hunk 中无一落入基线 :155-235 函数体（hunk 1 模块头注释 / hunk 2 scheduleTimeBudget 注释（:115 前）/ hunk 3 起于 :235 函数结尾 `return runId; }` 之后的 pauseRun/resumeRun/discardInFlightCalls 删除 / hunk 4 abortRun 后新增 / hunk 5-6 evict 注释）
- error-recovery paused 守卫清理完整：handleWorkerMessage/handleWorkerError/handleWorkerExit/handleScriptError 4 处 `isTerminal(run) \|\| status==="paused"` → `isTerminal(run)`；scheduleRebuild 重检 `isTerminal \|\| status!=="running"` → `isTerminal`；:148 注释指向 rebuildRuntime 重排

## 5. E2E 真实 pi 环境（pi 0.84.0，mimo-v2.5-pro，--approve --extension $WF，XYZ_AGENT_DEBUG=1）

RPC 报文格式（实测确认）：`{"id":"N","type":"prompt","message":"..."}`（pi 0.84 用 `type` 字段非 `command`）；slash 命令经同一 prompt 通道（`_tryExecuteExtensionCommand` 立即执行不进 LLM）。完整日志：/tmp/wf-log-s1d.txt、-s2c.txt、-s4.txt、-s7c/s7d/s7e.txt、-atk.txt。

### S1 正常完成回归 → ✅ PASS

- run：`{"action":"run","name":"$WF/workflows/chain.js","args":{"task":"Return the single word: hello"}}`
- 最终快照（wf-1786885640888-x87ymq）：`status=done reason=completed`；scriptResult 含三步产出 `{"status":"ok","phases_run":["analyze","transform","synthesize"],"final":{...}}`；trace 3 步全 completed
- 完成通知链路完整：wf- run 的 `pending:unregister`（reason=completed）出现于 session 事件流，主 agent 收到 workflow-result 通知后正常总结

### S2 主动 abort → ✅ PASS

- run review-fix-loop（targetType:text + batch1=扩展 agents/code-reviewer.md）→ 30s 后主 agent 调 `{"action":"abort","runId":"wf-1786886602289-bl65mi"}`
- 最终快照：`status=done reason=aborted`；tool result：`Workflow 'review-fix-loop' (wf-1786886602289-bl65mi): running → done (aborted)`
- `ps` 精确过滤（session 目录/扩展路径，排除用户自有 pi 会话与其他 worktree 实例）→ **残留 worker/pi 子进程 0**

### S4 已删能力指引 → ✅ PASS

- ① LLM 逐字调 `{"action":"pause","runId":"wf-nonexistent-123"}` → pi 核心校验拦截：`Validation failed for tool "workflow": - action: must be equal to one of the allowed values` + `Received arguments:{...}`（结构化错误，`isError:true`，无成功 payload）——文本匹配验收标准
- ② RPC `/workflows pause wf-nonexistent-123` → `extension_ui_request {method:"notify", message:"Workflow pause has been removed — runs are one-shot. To stop a run early: /workflows abort <runId>", notifyType:"warning"}`——与契约 #6 逐字符一致（含 em-dash）
- ③ 补全无 pause/resume：pi rpc mode 无补全请求入口（rpc-mode.ts 无 completion 命令，不可 E2E 探测），以源码 diff 为证——`getArgumentCompletions` 列表仅剩 `abort`，二段条件 `parts[0] === "abort"`

### S7 崩溃自愈三路（D-3 核心）→ ✅ PASS

**second 路（自愈）**：run wf-1786886075773-m9r03k（24s 完成）
- `status=done reason=completed`，`scriptResult: {"a":{"word":"alpha"},"b":{"word":"beta"}}`——**b 重跑成功 = discard 生效**
- **subagent session 文件计数（决定性判据）**：`find ~/.pi/agent/subagents -name "*.jsonl" -newer /tmp/wf-marker` 共 3 份 = alpha 恰 1 份（13-14-36-706，仅含 alpha prompt）+ beta **2 份**（13-14-50-895 崩溃前的 + 13-14-52-047 重跑的，均仅含 beta prompt）——alpha replay 缓存不重复耗 token（F2 genuinely-done 保留），beta 在飞被 discard 后全新重跑
- `meta.workerErrorCount=1`（崩溃 1 次 + rebuild 1 次）；崩溃前 beta 调用 finalize 为 failed（error: "Agent call failed (aborted or unknown error)"，即「假失败」真实产生）——若 discard 失效此假失败将被 replay 污染输出，实测 b 为正确重跑结果
- 环境注记：见 §6-1、§6-2

**always 路（耗尽）**：run wf-1786886237894-z86k2j（8s 完成）
- `status=done reason=failed error="Worker exited with code 1"`，`meta.workerErrorCount=4`、scriptErrorCount 未设
- `MAX_WORKER_RETRIES=3`（error-recovery.ts:57）：初次崩溃(count 1)→rebuild→崩(2)→rebuild→崩(3)→rebuild→崩(4)→耗尽 failed——**3 次重建后 done/failed**，与手册断言一致

**throwAt 路（script error 分账）**：run wf-1786886270577-jc1v66（8s 完成）
- `status=done reason=failed error="Workflow failed after 3 retries: injected script error"`，`meta.scriptErrorCount=4`、**workerErrorCount 未设**
- 两计数器互不污染：always 路 worker=4/script 未设；throwAt 路 script=4/worker 未设——分账清晰

（顺带二次验证：S2 首跑缺 batch1 参数触发真实脚本错误 → 同样 3 次重试后 done/failed，scriptError 重试路径复现一致）

### 对抗抽查（自设计，abort 不存在 runId）→ ✅ PASS

`{"action":"abort","runId":"wf-does-not-exist-999"}` → `isError:true` + 可操作错误：`Workflow 'wf-does-not-exist-999' not found. Use action:status to list active runs and their runIds.`（指向恢复动作）；随后 `{"action":"status"}` 正常返回 `No workflows in current session.`（isError:false）。terminateRunningRuns 多 run 部分失败行为已有单测覆盖（§4.1 用例④，mock 调用记录证据）。

## 6. 环境注记（非 FAIL 项）

1. **S7 注入脚本需补 @pi-meta 头**：手册 §3 提供的脚本全文无 `/* @pi-meta */` 块，registry（config-loader `parseResourceMeta`）解析不到 meta → `available=false` → `sourceCode=""` → runWorkflow 以空脚本启动 → 秒完成 completed（scriptResult=null、零 agent 调用，实测两次复现）。且 `phases` 为 workflow meta 必填字段（无 phases 仍 parse null）。**属验收手册脚本资产缺陷，非 builder 改动问题**——本验收为脚本补 `@pi-meta`（name/description/phases/parameters）后三路全部跑通。建议 U3 文档回写时在手册补注此约束。
2. **「扩展日志含 rebuild 轨迹」不可直接满足**：error-recovery 的 handleWorkerExit/scheduleRebuild/rebuildRuntime 路径无 `deps.log` 调用（基线即如此，grep 实证），~/.pi/agent/logs/ 与 session workflow:log 均无 rebuild 字样。以行为证据替代判定：workerErrorCount 计数 + beta 双 session 文件 + scriptResult 正确——rebuild 与 discard 生效已被充分证明。该断言期望与代码实际不符（存量状态），不构成 U1 FAIL。
3. **S4③ 补全探测**：pi rpc-mode 无 completion 请求入口，补全断言以源码 diff 为证（列表仅 abort）。

## 7. 判定汇总

| 硬项 | 结果 |
|---|---|
| 防篡改（验收/设计文档零改动 + 16 文件清单内） | ✅ |
| `pnpm extensions:typecheck` exit 0 | ✅ |
| `pnpm extensions:lint` exit 0 且改动文件无新增 warning | ✅ |
| vitest 仅 4 豁免失败 + 归因独立证实（交集空 + stash 基线复跑同败） | ✅ |
| grep 恰 6 处清单外残留，领地内零命中 | ✅ |
| 契约 7 条（源码 + 测试双重核验） | ✅ |
| 禁改 5 文件 diff 空 + runWorkflow 创建路径未动 | ✅ |
| E2E：S1 / S2 / S4 / S7 三路 / 对抗抽查 | ✅ 全过 |

**最终判定：PASS**——U1 交付符合规格，可进入 commit 与 U2。
