# U2 验收报告 — 类型与持久化收窄（RunStatus 两态 + 创建即 running + 快照 v2）

> verifier 独立验收（对抗式，builder 自报全部经独立证实）。验收基线 commit `ce9302111`（= 验收时 HEAD，builder 改动为工作区未提交状态），验收日期 2026-08-16。
> 权威标准：`u2-acceptance.md`（契约 7 条 + 禁改清单）+ `docs/design/workflow-one-shot-lifecycle-impl-spec.md` §0（F4 第二段/F5/F6/F8）+ §2 + §3。

## 总结论：**PASS**

全部硬项（防篡改 / 三命令 / 双 grep 归零 / 契约 7 条 / 两项 builder 裁决复核 + 三项重点抽查 / U1 保护面 / E2E S3 三路 + S5 + S6 + S8b + 自由对抗 2 条）通过。失败项：无。3 条环境注记 + 1 条认知外事件通报（非 FAIL，详见 §6/§7）。

---

## 1. 防篡改

| 检查 | 结果 |
|---|---|
| `git diff ce9302111 --stat -- .orchestration/ docs/design/` | **空**（零改动） |
| 验收开始时 `git status --porcelain` | 恰 17 文件（12 源 + 5 测试），逐文件比对全部在允许清单（u2-acceptance.md 交付物 + 单测验收 5 允许的 lifecycle.test.ts），无清单外改动 |
| U1 领地 5 文件 diff | **全空**：`src/index.ts`、`src/interface/commands.ts`、`src/interface/command-actions.ts`、`src/interface/views/WorkflowsView.ts`、`src/orchestration/error-recovery.ts`——builder「零触碰」声明属实（比「机械适配需逐条汇报」的许可更严格，实际一处未碰） |
| E2E 全程结束后复查 | 验收/设计文档 diff 仍为空；双 grep 复跑仍零命中；typecheck 复跑仍 exit 0 |

改动文件清单（12 源 + 5 测试，与验收文档交付物完全一致）：

- 源码 12：`models/types.ts`、`models/workflow-run.ts`、`models/run-runtime.ts`、`models/run-state.ts`、`models/run-spec.ts`、`models/trace.ts`、`models/budget.ts`、`orchestration/lifecycle.ts`、`orchestration/jsonl-run-store.ts`、`interface/tool-workflow.ts`、`interface/gui-mappers.ts`、`interface/views/format.ts`
- 测试 5：`__tests__/gui.test.ts`、`execution/__tests__/crash-recovery.test.ts`、`interface/views/__tests__/WorkflowsView-signature.test.ts`、`orchestration/__tests__/jsonl-run-store-session-file.test.ts`、`orchestration/__tests__/lifecycle.test.ts`（允许项：创建路径瞬态断言同步 + 新增创建即 running 两用例）

## 2. 命令实跑

### 2.1 `pnpm extensions:typecheck` → **exit 0**

```
> cd extensions && npx tsc --noEmit
TYPECHECK_EXIT=0
```

（验收末尾认知外事件出现后复跑一次，仍 exit 0，见 §7。）

### 2.2 `pnpm extensions:lint` → **exit 0**（0 errors，191 warnings 存量）

```
✖ 191 problems (0 errors, 191 warnings)
LINT_EXIT=0
```

191 warnings 与 U1 验收时数字一致（存量）。

### 2.3 `cd extensions/subagent-workflow && npx vitest run` → **4 failed / 2170 passed**，失败全部在豁免清单

```
 ❯ src/orchestration/__tests__/skill-discovery.test.ts (6 tests | 2 failed)
 ❯ src/execution/__tests__/spawn-worktree-guidance.test.ts (2 tests | 2 failed)
 Test Files  2 failed | 161 passed (163)
      Tests  4 failed | 2170 passed (2174)
```

与豁免清单（skill-discovery ×2 / spawn-worktree-guidance ×2，U1 verifier 已双重证实为存量：文件交集空 + stash 基线复现，ledger 已记录）完全一致，无额外失败。两失败文件及被测模块均不在本次 17 文件 diff 内。

### 2.4 双 grep → **双零命中**

```
grep -rn "pauseRun\|resumeRun" src/   → 0 命中（exit 1）
grep -rn '"paused"' src/              → 0 命中（exit 1）
```

U1 遗留 6 处（gui.test.ts:429/:437 fixture、trace.ts:156 / budget.ts:103 / run-runtime.ts:27 / jsonl-run-store-session-file.test.ts:404 注释）全部按 U2-5/U2-8 定稿处置（fixture 改名 / 注释改写），全域真零。

## 3. 接口契约 7 条对照（源码 + 测试双重核验）

| # | 契约 | 结果 | 证据 |
|---|---|---|---|
| 1 | `RunStatus = "running" \| "done"`；`VALID_RUN_TRANSITIONS = { running: ["done"], done: [] }`；`ALL_RUN_STATUSES = ["running","done"]` | ✅ | types.ts diff：三处同步收窄 + :20-25 状态机注释 3→2 态 |
| 2 | 创建即 running 三点（初始 running + runs.set 移 assignRuntime 后 + I1 构造期跳过 / assignRuntime 末尾校验 / assignRuntime 前置改 `status==="running" && runtime===undefined`） | ✅ | lifecycle.ts:181 `status:"running"`；:220 assignRuntime → :225 `deps.runs.set`；workflow-run.ts 构造仅 `validateInvariantI2()`，assignRuntime 末尾 `validateInvariants()` 恢复 I1，前置校验改 `status !== "running"` throw。lifecycle.test.ts 新增 2 用例精确锚定（worker.start 执行时 `deps.runs.size===0`；worker.start 抛错 → `runs.size===0` + save 未调 + pending:register 未发） |
| 3 | `meta.pausedAt` 删除（定义 + 反序列化 + 序列化投影） | ✅ | workflow-run.ts WorkflowRunMeta 定义删；jsonl-run-store.ts RunSnapshot.meta 与 deserializeRun meta 重建删；序列化投影 `meta: run.meta` 直投（源类型已无字段）。W9 单测断言 `snapshot.meta` not have pausedAt |
| 4 | `ReleaseMode = "terminal"` + release("terminal") | ✅ | run-runtime.ts:31 单值类型 + 注释改写单一 terminal 语义；workflow-run.ts releaseRuntime 调 `release("terminal")` |
| 5 | `SNAPSHOT_VERSION = "wf-run-v2"` + v1 跳过 + 注释定稿文案 | ✅ | jsonl-run-store.ts:71；:165 版本守卫 `snapshot.v !== SNAPSHOT_VERSION → null`；:63-68 版本历史注释含「v1 running 残留跳过 = 静默消失不显示，接受（父文档 D-5 边界声明）」逐义对齐 |
| 6 | WorkflowToolDetails 收窄 `"abort"` 单值 + buildWorkflowGui severity 简化 + gui.test.ts 同 commit 处置 | ✅ | tool-workflow.ts lifecycle 分支 `action: "abort"`；severity 恒 `warn`（删除 pause/resume 判定）；gui.test.ts 同一工作区改动删 pause/resume 用例、abort 用例保留且断言加强（label/value/severity 三字段）——无中间态 |
| 7 | U1 遗留 6 处清零 | ✅ | §2.4 双 grep 零命中；6 处逐一在 diff 中核实处置方式 |

### 3.1 两项 builder 自报裁决复核（对抗式重点）

**(a) abortRun 防御分支删除（原 :273-278）— 裁决成立 ✅**

- 不可达论证：现版 abortRun（lifecycle.ts:257-289）流程 `runs.get → not found throw` → **`:271 done no-op return`** → error 记录 → transition("done")。RunStatus 两态收窄后，通过 :271 的 run 类型上只可能是 `"running"`；运行时亦无 "paused" 来源（transition 无 paused 写入者——VALID_RUN_TRANSITIONS 单边 running→done；v1 快照在 deserializeRun :165 版本守卫即返回 null，不进 runs Map）。原防御条件 `!== "running" && !== "paused"` 在两态世界恒 false。
- 「只删守卫不删行为」：diff 显示删除的恰为 6 行防御 if 块；abortRun 其余行为序列（done no-op / state.error / transition / store.save / pending:unregister / onRunDone）与基线逐行一致。

**(c) v1 跳过用例 fixture 用 running 而非 paused — 合理裁决 ✅**

jsonl-run-store.ts:165 版本守卫是纯 `snapshot.v !== SNAPSHOT_VERSION` 字符串比较，**完全先于且独立于 status 字段消费**——fixture 的 status 值对跳过判定零影响，running 与 paused 等价。且「v1 running 残留跳过」正是 U2-5 注释定稿的 D-5 边界接受语义（v1 running 静默消失不显示），用 running 反而直接锚定了该声明的语义。测试断言 `loadAll() resolves.toEqual([])` 真实验证「跳过、不崩、不显示」。

### 3.2 其余三项重点抽查

**(b) 创建即 running 三点** — ✅ 见契约 #2。补充核验：`reconstruct` 静态工厂保留（签名 `(runId, spec, state, meta)` 不变，内部 `new WorkflowRun(...)` 四参），第 5 参 `reconstructMode` 从 constructor 删除——typecheck exit 0 证明无调用方传参（crash-recovery.test.ts 等 reconstruct 消费方零改动即编译通过）；「构造即 running」与「重水合 running 快照」共用「构造期跳过 I1」语义，两路径在 workflow-run.ts 构造函数收敛为同一行 `validateInvariantI2()`。

**(d) 快照 v2 双向核对** — ✅ 序列化（serializeRun `v: SNAPSHOT_VERSION`、meta 直投无 pausedAt、status 只可能两态）/ 反序列化（版本守卫 + meta 重建无 pausedAt + `WorkflowRun.reconstruct` 接受 running 快照）双向闭合；W9 两用例（v1 跳过 + v2 序列化三断言）；E2E 层 S3①/S5/S6/S8b 全部实跑 run 快照首行 `v=wf-run-v2`。

**(e) WorkflowToolDetails 收窄与 gui.test.ts 同 commit** — ✅ 见契约 #6；同一工作区 diff（无中间提交序列），buildWorkflowGui 死分支（pause 判定）与用例删除同 diff hunk 群，无「先收窄挂测试」窗口。

## 4. U1 保护面核验

- 5 文件 diff 全空（§1 表）。
- U1 行为语义抽核（防收窄伴随的行为漂移）：`terminateRunningRuns`（lifecycle.ts:322-344 区段）签名/per-run 行为/不调 onRunDone 逐行未动（仅函数头注释因 §8 注释清理改写「paused」措辞）；error-recovery.ts 零触碰 = discardInFlightCalls 落点/F2 语义原样；abortRun 除删除不可达守卫外行为未动（§3.1a）。
- E2E 层 U1 语义回归（S3 三路 error 文案逐字含 "Process killed" / "Session switched: run terminated" / "Session shutdown: run terminated"）——U1 验收的终止文案在 U2 收窄后行为不变。

## 5. E2E 真实 pi 环境（pi 0.84.0，mimo-v2.5-pro，--approve --extension $WF，XYZ_AGENT_DEBUG=1）

RPC 报文 `{"id":"N","type":"prompt","message":"..."}`（U1 报告已锚定）。全部场景真实跑通，证据字段取自快照文件与 tool result 事件流。

### S3① kill -9 崩溃恢复 → ✅ PASS

run `wf-1786888850895-j4k0t7`（review-fix-loop，targetType:text + batch1=扩展 agents/code-reviewer.md）：进行中快照 `v=wf-run-v2 status=running` → `kill -9` 主 pi 进程 → 同 SESSION_DIR 重启 + switch_session resume → `{"action":"status"}` 返回 `status=done reason=failed error="Process killed (kill-9 or crash recovery)"`，无 running 幽灵（列表仅此 1 run 且终态）。**顺带验证「构造期跳过 I1」的重水合消费者**：v2 running 快照（无 runtime）经 `WorkflowRun.reconstruct` 构造合法。

### S3②a 分支导航（Session switched 路径）→ ✅ PASS

run `wf-1786889152368-ha8yb1` 进行中 → 等价触发分支导航（见注记 1）→ 快照落盘 `status=done reason=failed error="Session switched: run terminated"`（`v=wf-run-v2`）。

### S3②b 切 session（Session shutdown 路径）→ ✅ PASS

run `wf-1786888903722-dztmkr` 进行中 → `new_session` RPC（= TUI `/new` 的 RPC 形态，走 before_switch("new") + teardownCurrent("new") → session_shutdown）→ 快照落盘 `status=done reason=failed error="Session shutdown: run terminated"`；新 session 的 status 查询无残留 run。

### S5 嵌套回归 → ✅ PASS

- baseline：chain.js 单独跑 = done/completed，usedTokens **25860**
- 父 run `/tmp/nested-chain.js`（@pi-meta 头，name/description/phases/parameters——U1 注记合规）= `done/completed`，scriptResult 含子 chain 三步产出（phases_run=[analyze,transform,synthesize]，final.summary="hello"）
- 子 run `wf-1786889254861-3za7zy` = `done/completed`
- **预算并入铁证**：父脚本自身零 agent() 调用（仅一次 workflow() 嵌套），父 usedTokens **24371.16 == 子 run usedTokens 24371.16（完全相等）**；与 baseline 量级一致（±6% 属 LLM run 波动）——子消耗原样计入父预算。

### S6 预算终态 → ✅ PASS

run `wf-1786889319890-5e2jpa`（chain.js + `tokens:100`）→ `v=wf-run-v2 status=done reason=budget_limited`（快照 budget.maxTokens=100）。

### S8b 旧 v1 快照兼容 → ✅ PASS

手工构造 v1 快照（`v:"wf-run-v1"`、status running、meta 含 pausedAt，含完整 spec/budget 字段）+ session JSONL append workflow-state-link 指针（格式对齐真实样本）→ 重启 + switch_session resume：**进程不崩**（alive）、`{"action":"status"}` **不显示** v1 run（runs 列表无 wf-u2-v1-legacy）、对照 v2 run 正常显示。新跑 run 快照 `v=wf-run-v2`（S3①/S5/S6 全部快照亦然）。

### 自由对抗 A：创建即 running 后极快 abort 竞态 → ✅ PASS

run `wf-1786889429763-ys789t`（review-fix-loop）——tool result 返回 running 的瞬间（轮询周期 500ms，命中即 `steer` 抢占注入 abort prompt，不等当前 turn 结束，全程 5.5s 内）→ 快照 `v=wf-run-v2 status=done reason=aborted`；status 查询无 running 幽灵。runs.set 后移 + I1 跳过窗口在真实时序下无异常外泄。

### 自由对抗 B：v2 快照 running 中途 kill -9 的恢复幂等 → ✅ PASS

S3① 的 run 磁盘快照在恢复后仍为 running（见注记 3）→ **再次**全新 pi 进程 resume 同 session → 不崩，status 返回 `done/failed + "Process killed"`（completedAt 更新为本次恢复时刻），单 run 条目无重复、无 running 幽灵——v2 running 快照的恢复循环幂等。

## 6. 环境注记（非 FAIL 项）

1. **S3②a 等价触发的实现方式**：pi rpc-mode 无 `navigate_tree` 命令（rpc-mode.ts 全部 case 清单核实，navigateTree 仅经扩展命令 ctx 暴露——`createCommandContext` 平铺 `ctx.navigateTree`）。按任务说明 §6 授权，用 /tmp 驱动扩展（`/tmp/u2-nav-driver.js`，注册 `/u2nav <entryId>` 命令调 `ctx.navigateTree`，**非被测物、不进仓库**）在真实 pi 进程内等价触发同一 `AgentSession.navigateTree` → session_tree 事件链。实际命令：`{"type":"prompt","message":"/u2nav <早期 user entry id>"}`。
2. **stateFile 实际位置**：`~/.pi/agent/workflow-state/<runId>.jsonl`（resolveSessionDir → pi agentDir），spec §3 S1 写的 `$SESSION_DIR/workflow-state/` 与实际布局不符——存量布局（非 U2 引入），建议 U3 回写更正。
3. **S3① 磁盘快照不回写**：kill-9 恢复（index.ts:455-466）只在内存转终态、不调 store.save——磁盘最后一行仍 running。存量行为（U1 领地代码，U2 零触碰），恢复循环幂等（对抗 B 证实），不构成 U2 FAIL。
4. **S5 判定说明**：脚本内机械条件 `parentTokens >= baselineTokens` 因 LLM run 波动为 false，按验收标准原文「对照单独跑 chain.js 的量级」人工判定 PASS；父==子 usedTokens 完全相等是强于量级对照的决定性证据。

## 7. 认知外事件通报（防护规则 0，未处理）

验收末尾（22:11-22:12 CST，最后一个 E2E 场景结束后）工作区新增 2 个**非 U2 清单**文件改动：`src/interface/tool-render.ts`（+import displayAgentName + renderSubagentCall 取短名）与 `src/shared/agent-ref.ts`（+displayAgentName 函数，agent ref 显示 basename 短名功能）。

判定依据：内容与 U2 语义无关（UI 显示名优化）；与本人全部 E2E prompt 语义无关（均为 workflow run/status/abort/导航）；mtime 在对抗 B 结束之后。来源不明（疑为用户或其他 agent 会话在同一 worktree 工作）。按防护规则 0 **未提交、未修改、未撤销**；复跑 `pnpm extensions:typecheck` 仍 exit 0，该事件不影响 U2 验收判定（builder 17 文件 diff 内容未受影响，双 grep 复查仍零命中）。**移交 orchestrator 决策**。

## 8. 判定汇总

| 硬项 | 结果 |
|---|---|
| 防篡改（验收/设计文档零改动 + 17 文件恰在允许清单） | ✅ |
| `pnpm extensions:typecheck` exit 0 | ✅ |
| `pnpm extensions:lint` exit 0（0 errors） | ✅ |
| vitest 仅 4 豁免存量失败 | ✅ |
| `grep pauseRun\|resumeRun` 与 `grep '"paused"'` 双零命中 | ✅ |
| 契约 7 条（源码 + 测试双重核验） | ✅ |
| builder 两项自报裁决复核（abortRun 不可达删除 / v1 running fixture） | ✅ 成立 |
| 三项重点抽查（创建即 running / 快照 v2 双向 / WorkflowToolDetails 同 commit） | ✅ |
| U1 保护面（5 文件 diff 空 + 行为语义 E2E 回归） | ✅ |
| E2E：S3① / S3②a / S3②b / S5 / S6 / S8b | ✅ 全过 |
| 自由对抗 ≥1（极快 abort 竞态 / 恢复幂等，共 2 条） | ✅ |

**最终判定：PASS** —— U2 交付符合规格，可进入 commit 与 U3。遗留：§7 认知外改动待用户/orchestrator 决策（不阻塞 U2）。
