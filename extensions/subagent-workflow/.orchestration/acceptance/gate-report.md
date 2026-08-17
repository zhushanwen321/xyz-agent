# Milestone Gate 报告 — Workflow 一次性生命周期（S1-S8 终态全场景）

> gate 执行者在最终代码终态（HEAD `cdaea8a54`，U1/U2/U3 全部 committed）上真实执行 S1-S8 全场景验收。
> 场景 SSOT：`docs/design/workflow-one-shot-lifecycle-impl-spec.md` §3。执行日期 2026-08-16。
> 环境：pi 0.84.0 RPC mode + `xiaomi-token-plan-cn/mimo-v2.5-pro` + `--approve --extension $WF`，cwd=/tmp/wf-gate-cwd，session-dir=/tmp/wf-gate-sess，`XYZ_AGENT_DEBUG=1`。全程证据取自 run 快照（`~/.pi/agent/workflow-state/<runId>.jsonl`）、session JSONL entry 流与 RPC 事件流。

## 总结论：**FAIL**

15 个场景项中 14 项 PASS；**S7 crashAt:"second" 自愈路两次执行一次不达通过标准**（概率性竞态，2 次中第 1 次 `scriptResult.b=""` 假成功、PHASE_B 子进程 session 文件 0 份而非要求的 2 份）。根因已代码级定位（§3）：rebuild 后孤儿 `executeAgentCall` 的 finalize 结果经 `postAgentResult` 投给**新 worker** 的同 callId pending，劫持重跑调用为假失败。按「任一场景失败 = FAIL」判 FAIL。

| # | 场景 | 结果 | 关键证据（runId） |
|---|------|------|------|
| S1 | chain 正常完成 | ✅ | wf-1786892034653-m56q24：done/completed；三步产出 `phases_run:[analyze,transform,synthesize]`；快照 `v=wf-run-v2` |
| S6 | 预算终态 | ✅ | wf-1786892107928-mz8ssh：done/budget_limited，`maxTokens=100`，error="Budget exceeded" |
| S5 | 嵌套回归 | ✅ | 父 wf-1786892141539-r5x1sf + 子 wf-1786892141574-ut4lz2 均 done/completed；**父 usedTokens 38814.84 == 子 38814.84（完全相等）**；父 scriptResult.inner 含子三步产出；与 S1 baseline 55013.28 同量级 |
| S2 | 主动 abort | ✅ | wf-1786892269166-ht77xx：done/aborted；tool result `running → done (aborted)`；status 列表 `[done [aborted]] review-fix-loop`；ps 精确过滤残留 0 |
| S4 | 已删能力指引 | ✅ | ① 工具 `{"action":"pause"}` → `Validation failed for tool "workflow": - action: must be equal to one of the allowed values` + Received arguments（pi 核心拦截，isError）；② RPC `/workflows pause <id>` → `Workflow pause has been removed — runs are one-shot. To stop a run early: /workflows abort <runId>`（warning，逐字符含 em-dash） |
| S7-second | 崩溃自愈（second 路） | ❌ **FLAKY 1/2** | 第 1 次 wf-1786892540756-ix3coa：**b=""（假成功）**、PHASE_B session 文件 0 份、workerErrorCount=1、handleReturn 正常收到；第 2 次 wf-1786893020118-frcqo6：b={word:"beta"}、alpha 1 份 + beta 2 份、workerErrorCount=1（通过标准全达）。详见 §3 |
| S7-always | 重试耗尽 | ✅ | wf-1786893146265-vxcjx6：done/failed，error="Worker exited with code 1"，`workerErrorCount=4`、scriptErrorCount 未设 |
| S7-throwAt | script error 分账 | ✅ | wf-1786893207861-hgpya8：done/failed，error="Workflow failed after 3 retries: injected script error"，`scriptErrorCount=4`、workerErrorCount 未设——两计数器互不污染 |
| S3① | kill -9 重启恢复 | ✅ | wf-1786894013703-p9przy：running 中 `kill -9` 主 pi → 重启 + switch_session resume → status `done [failed] error: "Process killed (kill-9 or crash recovery)"`，无 running 幽灵；磁盘快照不回写为已知存量（U2 注记 3，本次一致）。另有 crash 版等价复现：wf-1786893577075-nomey1（进程被 pi-scheduler 崩掉后 resume，同样 "Process killed"） |
| S3②a | 分支导航终止 | ✅ | wf-1786893323828-hcxdxy：running 中经 nav driver 调 `ctx.navigateTree` → done/failed，error="Session switched: run terminated"，v=wf-run-v2；切回后 session 继续可用 |
| S3②b | 切 session 终止 | ✅ | wf-1786893374762-nkiyo8：running 中 `new_session` → done/failed，error="Session shutdown: run terminated"，v=wf-run-v2；新 session 无残留 run |
| C1 | 自愈完成后立即 abort | ✅ | 对已 done/completed 的 wf-1786893020118-frcqo6 发 abort → no-op，快照保持 done/completed 不翻转（终态保护） |
| C2 | 多 run 并发 + 切 session | ✅ | wf-1786893422647-ejj8bs + wf-1786893506596-k7iqtk 双 run 同时 running → new_session → 双双 done/failed "Session shutdown: run terminated"（v=wf-run-v2），ps 泄漏 0 |
| C3 | budget + abort 组合 | ✅ | wf-1786893957157-tg3r8n：tokens:500000（maxTokens 落快照）running 中 abort → done/aborted——大预算不干扰 abort 语义 |
| S8 | 静态终态 | ✅ | §4（grep 双零 + 三命令 + vitest 仅 4 豁免 + 文档抽查） |

组合方式说明：S1/S6/S5/S2/S4/S7 三路/C1/S3②a/S3②b/C2/C3 全部在**同一 pi 进程生命周期内顺序执行**（session `01a00b0c…` 起步，中途两次 new_session），S3① 按手册要求排在 S7 之后（多次 rebuild/terminate 后验证 session 生命周期），kill -9 场景天然需要独立进程（重启 daemon 两次）。

---

## 1. 执行环境与方法

- **进程承载**：pi 经 FIFO（`/tmp/wf-gate-in`）驱动 stdin JSONL，后台 daemon 持有（bash 调用结束会清理后台子进程，run_in_background 守护可跨调用存活）。RPC 报文 `{"id":N,"type":"prompt","message":"…"}`（slash 命令经同一通道）。**方法论注记**：写入 FIFO 的 JSON 必须带换行——无换行的报文滞留 readline 行缓冲，与下一条拼接成双 JSON 触发 `Failed to parse command: Unexpected non-whitespace character after JSON`（本次实测定位，报告留档）。
- **注入脚本**：`/tmp/crash-mid-flight.js`（含 @pi-meta 头，crashAt/throwAt 控制）+ `/tmp/nested-chain.js`（S5 嵌套父脚本）。均不进仓库。
- **分支导航**：pi rpc-mode 无 navigate_tree 命令（U2 注记 1），经 `/tmp/wf-gate-nav.js` driver 扩展注册 `/gatenav <entryId>` 调 `ctx.navigateTree`（ExtensionCommandContext，pi runner.ts:742 证实挂载），与 TUI `/tree` 同一 `AgentSession.navigateTree` 事件链。
- **证据源**：run 快照（终态行为）、session JSONL 的 `pending:register/unregister`、`workflow:log`（error-recovery debug）、`subagents:log`、RPC 事件流。

## 2. 场景执行记录（命令级）

驱动命令形态（S1 为例，其余同构）：

```
prompt → Use the workflow tool now with exactly these arguments:
  {"action":"run","name":"$WF/workflows/chain.js","args":{"task":"Return the single word: hello"}}
S2 abort   → {"action":"abort","runId":"wf-1786892269166-ht77xx"}
S4①        → {"action":"pause","runId":"wf-nonexistent-123"}（预期被 pi 校验拦截）
S4②        → /workflows pause wf-nonexistent-123（RPC prompt 通道）
S7         → {"action":"run","name":"/tmp/crash-mid-flight.js","args":{"crashAt":"second"|"always"}} / {"throwAt":"always"}
S3②a       → run review-fix-loop（targetType:text + batch1=agents/code-reviewer.md）running 中发 /gatenav <第一个 user entry id>
S3②b       → running 中 RPC new_session
S3①        → running 中 kill -9 主 pi PID → 重启 daemon → switch_session → {"action":"status"}
```

关键输出摘录：

- S1 status 列表（组合场景一屏可见全部终态，含 S6/S5）：
  ```
  [done] chain (wf-17868) (5m42s)
  [done [budget_limited]] chain (wf-17868) (4m29s) error: Budget exceeded
  [done] nested-chain (wf-17868) (3m55s)
  [done] chain (wf-17868) (3m55s)
  [done [aborted]] review-fix-loop (wf-17868) (1m47s)
  ```
- S7 分账（快照顶层 `meta`）：always 路 `{"workerErrorCount":4}`（scriptErrorCount 缺省）；throwAt 路 `{"scriptErrorCount":4}`（workerErrorCount 缺省）。
- S3① 恢复后 status：`[done [failed]] review-fix-loop (wf-17868) (54s) error: Process killed (kill-9 or crash recovery)`。
- C1 主 agent 报文：`workflow 已处于 done (completed) 状态，abort 操作无实际效果 — 状态保持 done (completed)`。

## 3. S7-second 路 FAIL 详情（根因已定位）

### 3.1 现象对比

| | 第 1 次 wf-1786892540756-ix3coa（15:02） | 第 2 次 wf-1786893020118-frcqo6（15:10） |
|---|---|---|
| 终态 | done/**completed** | done/completed |
| scriptResult | `{a:{word:"alpha"}, b:""}` ← **假成功** | `{a:{word:"alpha"}, b:{word:"beta"}}` ✅ |
| trace | [completed, **failed**] | [completed, completed] |
| PHASE_A（alpha）session 文件 | 1 份 ✅ | 1 份 ✅ |
| PHASE_B（beta）session 文件 | **0 份**（要求 2 份：崩溃前 + 重跑） ❌ | 2 份 ✅ |
| meta.workerErrorCount | 1（rebuild 发生） | 1（rebuild 发生） |
| 终态 calls[1]（beta call） | **status=running 残留**（重跑 call 被 run 完成连带遗弃） | 正常 |

手册通过标准原文：「b 重跑成功即 discard 生效（若 discard 失效，b replay 假失败/abort 错误）」——第 1 次正是不达 标准的形态。

### 3.2 时序证据链（第 1 次，session JSONL + 日志）

```
15:02:20.774  sa-e986f01f register（alpha）
15:02:32.784  sa-e986f01f unregister（completed）——a 真跑返回（>500ms，setTimeout(300ms) 已注册）
15:02:32.785  sa-a5f1255b register（首次 b 调用）
~15:02:33.1   worker process.exit(1) 触发（注入生效）
15:02:34.046  error-recovery 退避后 rebuild（新 worker 重跑：a replay <50ms 不再注入）
15:02:34.097  sa-a5f1255b unregister（closed）——旧 runtime abort 收割在飞子进程
15:02:34.100  重跑 b dispatch（trace2 startedAt）
15:02:34.101  sa-8963e5eb register（重跑 b 的新子进程）
15:02:34.111  trace2 completedAt（status=failed）——旧调用的迟到 finalize 污染
15:02:34.112  workflow:log "handleReturn"（worker 正常 return {a, b:""}）
15:02:34.113  run saved completed + pending:unregister + workflow-result（假成功落盘）
15:02:34.117  sa-8963e5eb unregister（closed）——run 完成后 terminate worker 连带收割重跑子进程
```

### 3.3 代码级根因（`src/orchestration/error-recovery.ts`）

1. `rebuildRuntime`（:159-188）：`run.replaceRuntime(...)`（新 worker + abort 旧 controller）之后同步 `discardInFlightCalls(run)`（:187，清 status!=="done" 的在飞 call + trace 节点）——**清理 Map 条目，但旧 `executeAgentCall` 的 promise 链仍在飞**。
2. 旧 promise 被 abort 唤醒 → 子进程终止 → finalize 失败结果 `{content:"", error:"Agent call failed…"}` → 回到 `dispatchAgentCall` 的 `.then`（:375-381）。
3. `.then` 的 stale 守卫只查 `run.state.status !== "running"`（:380）——**rebuild 不改 status，守卫放行**；不校验「该 call 实例是否仍属当前 runtime」。
4. `postAgentResult`（:556-563）投递目标是 `run.runtime?.worker`——**已是新 worker**。旧调用的失败结果投给新 worker 的同 callId pending。
5. worker 侧 `agent-result` handler（worker-script-builder.ts:141-152）：失败不 reject、resolve content 回退 → `b = ""` → 脚本 `return {a, b:""}` → `handleReturn` → **done/completed（假成功）**。
6. 旧 finalize 的 `run.state.trace.update(msg.callId, …failed)` 命中**重跑新建的同 stepIndex 节点**（discard 删的是旧节点）——快照 trace[1]=failed 由此而来；重跑 spawn 的子进程（sa-8963e5eb）被 releaseRuntime 连带 terminate，PHASE_B 0 份 session 文件、calls[1] 永久残留 running。

**F2 定稿注释的断言与实测相反**：error-recovery.ts:185-186 声称「后续 finalizeCall 在已移除的 orphan call 上运行（markDone 无外部副作用），trace.update 因节点已移除为 no-op」——实测 `postAgentResult` 有外部副作用（向当前 runtime worker 投递）、`trace.update` 非 no-op（命中重跑新节点）。设计期推理未实测的运行时断言（全局规则 13 的失败模式）。

**触发条件**：旧 call 的 finalize（abort 收割子进程后）与新 worker 重跑到同 callId `await` 的时间窗重叠。窗口毫秒级，概率性——U1 verifier 单次实测未命中、本次 2 次中 1 次命中。

### 3.4 修复方向（不在本 gate 内实施）

`dispatchAgentCall` 的 `.then`/`.catch` 增加孤儿判定：finalize 时校验**该 call 实例是否仍为 `run.state.calls` 中该 callId 的当前实例**（discardInFlightCalls 删除 + 重跑 `calls.set` 新实例后，旧实例 ≠ Map 实例 → 孤儿 → 跳过 postAgentResult / trace.update / store.save，仅记日志）；或在 dispatch 时捕获 runtime 代际引用完成时比对。属 error-recovery 内局部修复，F2 的 discard 落点本身无需移动。**建议补一条回归测试**：模拟「旧 call finalize 晚于重跑 dispatch」的交错（deferred promise 手工编排），断言新 worker 不收到孤儿结果。

## 4. S8 静态终态断言

| 检查 | 结果 |
|---|---|
| `grep -rn "pauseRun\|resumeRun" src/` | **0 命中**（exit 1） |
| `grep -rn '"paused"' src/` | **0 命中**（exit 1） |
| `pnpm extensions:typecheck` | **exit 0** |
| `pnpm extensions:lint` | **exit 0**（0 errors，191 warnings 存量，与 U1/U2 验收时一致） |
| `cd extensions/subagent-workflow && npx vitest run` | **4 failed / 2175 passed**，失败全部在豁免清单：skill-discovery ×2 + spawn-worktree-guidance ×2（ledger 观察项，U1 verifier 双重证实的存量；passed 数较 U2 时 +5 来自认知外 displayAgentName commit 7c4061e0a，无新增失败） |
| `workflows/README.md` | pause/resume 零命中（无残留能力宣传） |
| `CHANGELOG.md` | 两条 BREAKING 完整：889a798f9（enum/verb 收窄 + removed 文案 + session 终止语义 + token 作废）、931e219a0（两态状态机 + wf-run-v2 + v1 跳过 + create-as-running），与代码终态一致 |
| `skills/workflow-script-format/SKILL.md:244` | `Runs are one-shot（无 pause/resume——提前停止用 abort，要新结果重新 run）` ✅ |

（手册 S8b 的「旧 v1 快照启动不崩不显示」已在 U2 验收实测通过，本 gate 抽查静态面；「新快照 v2」由本 gate 全部 run 快照 `v=wf-run-v2` 覆盖。）

## 5. 环境事件与注记（非 subagent-workflow 责任）

1. **pi-scheduler 扩展崩掉主进程（两次）**：用户全局安装的 `@zhushanwen/pi-scheduler`（`~/.pi/agent/npm/node_modules/`）在 `new_session`/`switchSession` 替换 session 后，其定时 tick 回调使用捕获的 stale ctx 抛 `This extension ctx is stale after session replacement or reload…` → 未捕获 → pi 主进程 exit 1（stack：`SchedulerRuntime.onAfterTickCallback` / `tickScheduler`）。第一次（23:20 前后）中断了 C3 首轮（abort prompt 未送达）；重启后 C3 重跑成功；第二次发生在全部场景取证完成之后。**属 pi-scheduler 的 bug，与 subagent-workflow 无关**，但建议向该扩展反馈（tick 回调不应持有跨 session 替换的 ctx）。
2. **workflow 工具单飞限制**：同一 turn 内并行发起多个 run tool call 被拒（`Another workflow operation is in progress`）——接口既有约束；C2 的多 run 并发按「串行 turn 启动、并行存活」完成（双 run 同时 running 已验证）。
3. **kill-9 恢复的磁盘快照不回写**（内存转终态、store 不 save）：U2 verifier 注记 3 已记录的存量行为，本次 S3① 一致复现（status 层判定不受影响）。
4. **meta 计数落盘位置**：`workerErrorCount`/`scriptErrorCount` 在快照**顶层 `meta`**（非 `state.meta`）——本报告证据读取口径。

## 6. 清理与工作区状态

- gate 全部进程（daemon wrapper / FIFO holder / pi / worker）已终止；`/tmp/wf-gate-*`、`/tmp/crash-mid-flight.js`、`/tmp/nested-chain.js`、`/tmp/wf-gate-nav.js` 已删除。
- pi 数据目录中本次 gate 产物已清：`~/.pi/agent/workflow-state/wf-1786892*/3*/4*.jsonl`（16 个）与 `~/.pi/agent/subagents/--private-tmp-wf-gate-cwd--/`。U1/U2 verifier 的历史遗留文件未触碰。
- 仓库工作区与 gate 开始前一致（仅 ledger.md 既有改动），本 gate 未改任何仓库文件（除本报告）。

## 7. 判定汇总

| 维度 | 结果 |
|---|---|
| S1/S5/S6 组合（同进程顺序） | ✅ |
| S2 abort + 进程泄漏 | ✅ |
| S4 已删能力双通道 | ✅ |
| S7 always / throwAt | ✅ |
| **S7 second 自愈** | ❌ 概率性竞态（§3，根因代码级定位 + 修复方向给出） |
| S3 三路终止语义 | ✅（含 crash 版 + 明确 kill -9 版双验证） |
| 组合对抗 C1/C2/C3 | ✅ |
| S8 静态终态（grep/三命令/vitest/文档） | ✅ |

**最终判定：FAIL**——阻塞项唯一且明确：S7 second 路的孤儿投递竞态（error-recovery.ts dispatchAgentCall `.then` 的 stale 守卫不覆盖 runtime 代际）。修复该单点后建议复跑 S7-second ≥3 次确认稳定，其余场景无需重验。

---

## 附录：S7 修复复审（2026-08-16，针对 §3 FAIL 项的修复验证）

> 复审范围：仅验证 §3 S7-second 孤儿竞态修复项与回归，不重复全量验收。修复载体：`src/orchestration/error-recovery.ts`（孤儿守卫 `isOrphanedCall`）+ `src/orchestration/__tests__/error-recovery-handlers.test.ts`（4 回归用例）。

### 复审结论：**PASS**；gate 复判：原 **FAIL 可改判 PASS**

原唯一阻塞项（S7-second 孤儿投递竞态）已修复且经行为证据验证：复审复跑中竞态窗口真实出现并被守卫拦截（见 A.5 守卫拦截日志），`b={word:"beta"}` 来自重跑真实 dispatch。其余 14 项场景 gate 时已 PASS，未受本次改动影响（改动仅插守卫，非孤儿路径与 cdaea8a54 原实现行为等价，见 A.2）。

### A.1 修复 diff 逐项证实（与 builder 声明比对）

| 声明项 | 证实 |
|---|---|
| `isOrphanedCall(run, callId, call)` 实例比对 | ✅ error-recovery.ts:127-129，`run.state.calls.get(callId) !== call` |
| `.then` 路径终态守卫后补孤儿守卫 | ✅ :414-417（status 守卫 :407 之后），return 跳过 postAgentResult/postBudgetUpdate/store.save/budget 检查，留 debug 日志 |
| `.catch` 路径 AbortError 过滤后对称守卫 | ✅ :477-480（AbortError 过滤 :464 之后），return 跳过 markDone/trace.update/postAgentResult |
| `node.live = undefined` 无条件前置 | ✅ :476（原在 markDone 后、trace.update 前，前移后 markDone/trace.update 不读 node.live，语义等价） |
| 删除「orphan 无外部副作用」错误断言注释 | ✅ rebuildRuntime :204-213 替换为正确说明（含 S7-second 实测形态） |
| 新增 4 用例（deferred 手工编排交错） | ✅ 失败路径 / 成功路径 / catch 路径 / 非孤儿不误伤 |
| 越界扫描 | ✅ `git status` 仅 2 修复文件 + ledger.md（改动仅为 U3 commit hash 回填 `<U3待填>`→`cdaea8a54`，非 S7 修复触碰）+ gate-report.md（本文件） |

### A.2 守卫正确性源码核验

1. **实例比对真实实现**（非仅 callId 比对）：dispatchAgentCall :366-367 `new AgentCall` + `calls.set`，promise 链闭包捕获该实例；守卫以闭包实例 vs Map 当前条目比对。callId 会在重跑中复用，实例比对才能区分代际。
2. **三路守卫覆盖完整**：成功结果与失败结果共用 `.then`（:414 单守卫覆盖两形态）；异常走 `.catch`（:477）；AbortError 过滤在守卫之前（:464），abort 收割路径不误触守卫逻辑。
3. **非孤儿路径行为不变**：与 `git show cdaea8a54` 原实现逐段对照——`.then` 仅在 status 守卫后插入守卫；`.catch` 仅 `node.live = undefined` 前移 + 插守卫。非孤儿时守卫恒 false，后续逻辑与原实现相同。
4. **calls Map 写点断言核实**：运行期写点仅 error-recovery.ts 三处——:159（discardInFlightCalls 的 delete）、:351（resolveAgentOpts 失败同步路径 set，同步 return 无异步链）、:367（dispatch 主路径 set）。jsonl-run-store.ts:186 的 set 在 deserializeRun 离线重水合（构造全新 WorkflowRun，无在飞 promise）；lifecycle.ts:186 是新 run 初始状态。判定完备：旧实例从 Map 消失仅有 discard delete 与新 dispatch set 两族，实例不等 ⟺ 旧代际。

### A.3 命令实跑（工作区修复态）

| 命令 | 结果 |
|---|---|
| `pnpm extensions:typecheck` | exit 0 |
| `pnpm extensions:lint` | exit 0（0 errors；error-recovery.ts 存量 warning 1 处 L290 magic 200，不在本次 diff 区域） |
| `cd extensions/subagent-workflow && npx vitest run` | 2179 passed / 4 failed——失败全部在既有豁免清单（skill-discovery ×2 + spawn-worktree-guidance ×2，与本报告 §4 L128 记录一致）；passed 2179 = gate 时 2175 + 新增 4 用例 |
| 单跑 `error-recovery-handlers.test.ts` | 20 passed（原 16 + 新 4） |

### A.4 红性验证

临时将 `isOrphanedCall` 实现改为恒 `return false` → `npx vitest run error-recovery-handlers.test.ts`：**恰好 3 个孤儿用例红**（失败路径 / 成功路径 / catch 路径），非孤儿用例仍绿（守卫关闭不误伤正常路径的反证）。随后从字节级备份还原（md5 `a443a485…` 与基线一致 + `cmp` 逐字节相同），复跑 20 全绿。测试对守卫真实敏感，非恒绿摆设。

### A.5 S7-second 真实 pi 复跑（1 次，环境 pi 0.84.0 RPC + mimo-v2.5-pro + 本包源码 `--extension`）

runId `wf-1786896004327-coapaf`，注入脚本按 §3 手册全文（含 @pi-meta 头 + phases 声明），crashAt:"second"：

| 通过标准（行为证据口径） | 结果 |
|---|---|
| `scriptResult.b.word === "beta"` | ✅ `{a:{word:"alpha"}, b:{word:"beta"}}`，done/completed |
| PHASE_A 子进程 session 文件恰 1 份 | ✅ 1 份（alpha，重跑 replay 不新增） |

补充证据：
- **守卫拦截铁证**：session JSONL 记录 `workflow:log debug "orphan agent call completion dropped" {runId: wf-…-coapaf, callId: 1}`（16:00:29.446）——旧代际首跑 b 的迟到 completion 恰落在重跑 finalize（trace completedAt 16:00:29.464）前 18ms 的竞态窗口内，**被守卫实际拦截**。本次不是「未触发竞态的幸运通过」，而是「原 FAIL 场景重演且被修复阻断」。
- PHASE_B（beta）session 文件 2 份（16:00:19.367 崩溃前首跑 + 16:00:20.294 重跑）——重跑是真实 dispatch；b 的最终结果 sessionId `sa-07d8b4bd` 即重跑子进程。
- trace [completed, completed]、calls [(0,done),(1,done)]（无 running 残留——原 FAIL 第 1 次的 calls[1]=running 形态未复现）、meta.workerErrorCount=1（rebuild 发生的行为证据）。

### A.6 残留声明核验（execute-agent-call.ts finalizeCall 瞬时污染）

builder 声明「重跑完成时覆盖」成立：finalizeCall（execute-agent-call.ts:82-95）的 `trace.update(call.id, …)` 按 stepIndex 经 findByStepIndex 查节点；discard 先 removeByStepIndex 删旧节点、重跑 append 新节点（同 stepIndex 唯一，trace.ts:142 合法路径锚定）。旧 finalize 命中新节点时产生瞬时污染（TUI/中间快照可见），重跑完成时其自身 finalizeCall 再次 update 同 stepIndex 覆盖为正确终态；若旧 finalize 早于重跑 append 到达则 update no-op（trace.ts:9 防御）。终态无污染。该残留为已声明、可接受（修改需侵入 execute-agent-call.ts 重试核心，本次禁改范围）。

### A.7 工作区完整性

复审结束时 `git status` 与复审开始时完全一致（2 修复文件 M + ledger.md M + gate-report.md untracked）；error-recovery.ts / error-recovery-handlers.test.ts / ledger.md 三文件 md5 与复审开始时基线逐一相符（红性验证的临时改动已字节级还原）。复审未修改除本附录外的任何文件。复跑环境已清理（pi daemon / FIFO / 注入脚本 / `/tmp/wf-rv-*` / pi 数据目录本次产物 `wf-1786896004327-coapaf.jsonl` 与 `--private-tmp-wf-rv-cwd--/`）。
