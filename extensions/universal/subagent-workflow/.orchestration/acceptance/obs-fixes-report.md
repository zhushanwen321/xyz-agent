# obs-fixes 验收报告（verifier 独立验收）

> unit：obs-fixes（OB2 S7 残留瞬时污染守卫 + OB3 rebuild 可观察性）
> 验收基线：commit `d2853b11b971c0432d065ae61adf1abe855043ef` 的 `.orchestration/acceptance/obs-fixes-acceptance.md`
> 验收人：verifier（对抗式独立验收，builder 自报全部实测证实）
> 日期：2026-08-17

## 总结论：**PASS**

---

## 1. 防篡改检查

| 检查项 | 结果 |
|---|---|
| `git diff d2853b11b -- …/obs-fixes-acceptance.md` | 输出为空（未篡改） |
| 验收文档 sha256 | `95088218bbfb9937fc1ad0ce5171f210a7ed4e5a16920799a7ac7daafd3b2537` |
| 工作区改动范围 | 恰好等于交付清单 4 文件（见下），无越界修改 |

初始 `git status --porcelain=v1` 扫描结果（验收开始时）：

```
 M extensions/subagent-workflow/src/orchestration/__tests__/error-recovery-handlers.test.ts
 M extensions/subagent-workflow/src/orchestration/__tests__/execute-agent-call.test.ts
 M extensions/subagent-workflow/src/orchestration/error-recovery.ts
 M extensions/subagent-workflow/src/orchestration/execute-agent-call.ts
```

与交付清单逐文件一致，无其他 tracked 改动。

**会话中途观察（非 builder 越界）**：验收过程中出现 untracked 新文件 `extensions/subagent-workflow/.orchestration/acceptance/slice5-conformance-report.md`（初始扫描时不存在）。时间上与并行执行的 slice5 verifier 写报告吻合，不属于本 unit 交付物；verifier 未触碰该文件，仅记录。4 个 M 文件全程未被该并行任务触碰（全量 git diff sha256 验收前后一致，见 §7）。

## 2. 命令实跑

| 命令 | 结果 |
|---|---|
| `pnpm extensions:typecheck` | exit 0 |
| `pnpm extensions:lint` | exit 0（0 errors / 188 warnings） |
| `cd extensions/subagent-workflow && npx vitest run` | **164 files / 2196 passed / 0 failed**（27.52s） |

- 2196 与 builder 自报一致；验收文档基线 2187 + 新增 9 条（U1-U5 五条 + U6 一条 + U7 两条 + U8 一条）= 2196，数目吻合。
- **lint 零新增告警核验**：4 文件单独跑 eslint——两个测试文件被 eslint ignore（无告警可能）；`execute-agent-call.ts` 零告警；`error-recovery.ts` 唯一告警 `315:140 No magic number: 200`，该行为 `logger.error(…slice(0, 200)…)`（malformed agent-call 消息守卫），**不在任何 diff hunk 内**（本文件 diff hunk 仅覆盖 discardInFlightCalls ~149-166、rebuildRuntime ~184-236、dispatchAgentCall 调用行 ~415-426）——确认为存量行号漂移，builder 说法属实。
- **ENOTEMPTY flaky（差异点 d）**：本次全量 run 未复现，全绿。builder 的环境竞态归因无法证伪亦无法证实；验收以本次实测全绿为准。

## 3. U1-U8 条款对照

| 条款 | 验收要求 | 实测 | 判定 |
|---|---|---|---|
| U1 | 谓词 true + 成功路径 → trace.update 0 次，markDone 保留 | `vi.spyOn(trace, "update")` 真实 spy 断言 `not.toHaveBeenCalled()`；`call.status === "done"`、`result.content === "OK"` | ✓ |
| U2 | 谓词 true + stale-context 路径 → 同上 | error `"context canceled"` 命中 stale 分支，spy 0 次 + markDone 保留 | ✓ |
| U3 | 谓词 true + 信号 abort 路径 → 同上 | error `"old generation failure"`（刻意不含 stale 模式词）+ 预先 abort，spy 0 次 + markDone 保留 | ✓ |
| U4 | 谓词 undefined → trace.update **恰 1 次** | `toHaveBeenCalledTimes(1)` + `trace.find(0)?.status === "completed"` | ✓ |
| U5 | 递归重试透传 | fake timers 推进退避，`runner.run` 恰 2 次、`attempts === 2`，重试后终态 spy 仍 0 次 | ✓ |
| U6 | S3 场景重放（本 unit 核心行为断言） | 见 §5 详述 | ✓ |
| U7×2 | L1/L4 按序（含 runId）；带 budgetTimeMs + 注入时含 L2 | L4 index > L1 index；L1 payload `toMatchObject({runId})`、L4 `toEqual({runId})`；L2 在 L1 之后 L3 之前，payload `toEqual({runId, budgetTimeMs: 5000})`；无 budgetTimeMs 时断言 L2 不打 | ✓ |
| U8 | callIds 升序 + 与 Map 实际移除集合一致 | dispatch 插入序 5→3，L3 payload `toEqual({runId, callIds: [3, 5], count: 2})`（升序 ≠ 插入序）；Map.has(5)/has(3) false + trace.find(5)/find(3) undefined | ✓ |
| 既有回归 | S7-second 4 用例 + rebuildRuntime 既有用例全绿 | 守卫失效红性 run 中 4 条 S7-second 用例仍绿（.then/.catch 守卫独立生效）；全量 2196 全绿 | ✓ |

测试真实性核验：U1-U5 用真实 `Trace`/`AgentCall`/`Budget` 对象（仅 runner port 为 mock，属端口边界合理 mock），spy 为对真实对象方法 `vi.spyOn(trace, "update")` 的调用计数，非只断终态。U6-U8 用真实 `WorkflowRun`/`RunRuntime`/`ConcurrencyGate`/`Trace`/`Budget` 聚合根（makeRealRun），`deps.runner`/`workerHost`/`log` 为 port mock。

## 4. U6 核心行为断言详查

测试真实构造了完整 S3 序列（error-recovery-handlers.test.ts「U6/S3 场景重放」）：

1. dispatch callId=9，runner 挂起 deferredA（模拟在飞子进程）
2. `rebuildRuntime`（真实 replaceRuntime：同步 abort 旧 controller + discard 移除 Map/trace 条目）
3. 再次 dispatch 同 callId=9 → 新实例（断言 `rerunCall !== oldCall`）+ 新 trace 节点 running
4. 旧 deferredA 以非 stale 失败 resolve → 旧 executeAgentCall 醒来走 `signal.aborted` finalize 调用点
5. 断言：新 trace 节点 `status === "running"`、`result === undefined`、`completedAt === undefined`（三者齐全，正是污染会改变的字段）；旧实例 `status === "done"` + result 保留；`rerunCall.status === "running"`；旧结果未投新 worker（findAgentResultPost 为 undefined）
6. 收尾 resolve deferredB → 新节点转 completed（证明非孤儿路径守卫不误伤）

路径正确性核验：`"old generation failure"` 不含 STALE_CONTEXT_PATTERNS 任何模式词，确实绕开 stale 快速路径、落到 aborted 分支的 finalize——与测试注释声称一致。

## 5. 行为对抗抽查（5 条）

### 5.1 execute-agent-call.ts diff 审读

- **5 个 finalize 调用点全传谓词**：172（stale）、179（aborted）、186（budget 超限）、196（退避期间 abort）、205（终态）——逐一核对，无遗漏（全文件恰 5 处调用 + 1 处定义）。
- **递归点透传**：200 行 `executeAgentCall(call, runner, budget, signal, trace, onEvent, stream, isOrphaned)`。
- **守卫位置精确**：105 行 `if (isOrphaned?.()) return;` 在 markDone（100）/setSessionId（103）/setSessionFile（104）之后、trace.update（106）之前——只 skip trace.update，三个同步保留项完好，与接口契约一致。
- **零 logger import**：26-32 行 import 全部为 `import type`，无日志通道引入。
- **重试/退避/预算分支零触碰**：diff 仅含文档注释、签名、谓词追加，无任何分支条件改动。

### 5.2 error-recovery.ts diff 最小性

改动恰好三族：① `discardInFlightCalls` 返回值（`void → number[]` 升序，含 doc 更新）；② `rebuildRuntime` L1-L4 日志 + timeBudgetTimer 改写 + 1 行既有注释更新；③ `dispatchAgentCall` 的 `executeAgentCall` 调用行追加第 8 参 `() => isOrphanedCall(run, msg.callId, call)` + 注释。`isOrphanedCall` 定义（127-129）、`.then` 守卫块（442）、`.catch` 守卫块（505）、`resolveAgentOpts` 失败同步路径（370-389）均不在 diff 中——零触碰。签名契约 `isOrphaned?: () => boolean`（159 行）与验收文档锁定一致。

### 5.3 timeBudgetTimer 三元→if 控制流等价性（差异点 a）

- 条件表达式逐字符一致：`run.spec.budgetTimeMs && run.spec.budgetTimeMs > 0 && deps.scheduleTimeBudget`。
- 真分支：先赋值 `timeBudgetTimer = deps.scheduleTimeBudget(...)` 再打 L2；假分支：变量保持 `undefined` 初值——与原三元产值完全一致。
- 异常语义：`scheduleTimeBudget` 抛错时异常传播点相同（L2 尚未执行）；唯一新增理论抛错点是 `deps.log` 自身抛错（logger port 按契约不抛，且 L1/L3/L4 同模式，为验收文档强制要求的日志点本身）。
- 类型：新声明 `ReturnType<typeof setTimeout> | undefined` 与 ports.ts 137-140 行 port 签名返回类型**逐字相同**，tsc exit 0 佐证。
- **裁决：语义等价，接受。**

### 5.4 S2 等价性推演（守卫跳过 vs 现状 no-op）

trace.ts `update()`（118-120 行）：`const node = this.findByStepIndex(stepIndex); if (!node) return;`——节点不存在时 no-op 不抛错。S2 窗口（discard 后、重跑 append 前）：calls.get(callId) === undefined ≠ call → 新守卫 true → 跳过 update；旧实现调用 update 但 byIndex 无该键 → no-op。两者状态影响均为零，行为等价；且 discardInFlightCalls 同步删除 Map 条目与 trace 节点（同一循环），不存在「Map 已删但 trace 节点残留」的中间态。验收文档 S2「等价」结论经代码证实。

### 5.5 U6 红性实证（见 §7）

## 6. 差异点 a-d 裁决汇总

| # | 差异点 | 裁决 | 依据 |
|---|---|---|---|
| a | timeBudgetTimer 三元→if | **接受** | §5.3：条件/产值/异常传播点一致，类型与 port 签名逐字相同 |
| b | L2 打点条件 = scheduleTimeBudget 被实际调用的分支（返回 undefined 也打） | **接受** | 生产实现 lifecycle.ts:125-141 恒返回 timer（undefined 仅为 port 类型兼容/测试替身），分支入口打点 ≡ 重排成功打点；验收文档 U7 正向条件即「带 budgetTimeMs + scheduleTimeBudget 注入时含 L2」（未要求检查返回值），负向条件「无 budgetTimeMs 时 L2 不打」已满足（U7-1 断言缺席） |
| c | U8 经 L3 payload 断言 discardInFlightCalls 返回值（模块私有无法直测） | **接受** | discardInFlightCalls 唯一调用点即 rebuildRuntime，L3 payload 第 4 参传入的就是返回数组本体（error-recovery.ts:228-232），payload 断言 ≡ 返回值断言；测试同时断言 Map/trace 实际移除集合闭环 |
| d | builder 首跑遇 subagent-service-message-close.test.ts ENOTEMPTY flaky | **未复现** | 本次全量 run 全绿（164 files / 2196 passed）。归因无法证伪亦无法证实，不影响验收判定（以 verifier 实跑为准） |

## 7. 红性验证记录（守卫失效 → U6 必红）

**改前指纹固化**：

- `error-recovery.ts` sha256 = `dcfaf7a9425b14a36b28a12a555ef0e58838967886262f1d0cf5f9d3b61220c3`
- 全量 `git diff` sha256 = `6f205d2187b6cc67e3d000a737120cf65437c94183889b2dbbc5611ac83c1062`

**注入失效**：422 行谓词 `() => isOrphanedCall(run, msg.callId, call)` → `() => false`（仅此一处，grep 确认全文件恰 1 处）。

**红**（error-recovery-handlers.test.ts 全文件 24 条）：

```
 ❯ src/orchestration/__tests__/error-recovery-handlers.test.ts (24 tests | 1 failed)
     × U6/S3 场景重放：discard + 重跑替换后，旧 finalize 不污染重跑新 trace 节点…
 AssertionError: expected 'failed' to be 'running' // Object.is equality
 Received: "failed"
 Tests  1 failed | 23 passed (24)
```

失败点恰为 S3 污染的核心字段（新节点 status 被旧 finalize 污染为 failed）；其余 23 条全绿——含 8353f6b60 的 4 条 S7-second 孤儿守卫回归用例（.then/.catch 守卫独立于 OB2，失效互不波及），证明 U6 精确锚定本 unit 行为、非连带失败。

**字节级还原**：`cp` 回写备份 → 复核指纹：file sha256 = `dcfaf7a9…`（与改前一致）、全量 `git diff` sha256 = `6f205d21…`（与改前一致）、`git status` 仍为原 4 个 M 文件（+ §1 所述并行 verifier 的 untracked 报告文件）。

**绿**（还原后复跑两个 OB2 测试文件）：

```
 Test Files  2 passed (2)
      Tests  34 passed (34)
```

## 8. 禁改清单核对

| 禁改项 | 结果 |
|---|---|
| 验收文档本体 | 未改（git diff 空 + sha256 固化） |
| isOrphanedCall 定义 + .then/.catch 守卫块 | 不在 diff 中，零触碰 |
| resolveAgentOpts 失败同步路径（~337-357 旧编号） | 不在 diff 中，零触碰 |
| execute-agent-call.ts 重试/退避/预算决策逻辑 | 仅加守卫与参数，无分支条件改动 |
| slice5 已实施区（wave1/wave2 全部文件） | git status 仅 4 交付文件，无涉及 |
| 性能勿动清单 | 无涉及 |
| git 写操作（add/commit/push） | 未执行 |

## 9. 结论

**PASS**。4 文件交付与验收基线（接口契约 / 场景表 S1-S3 / U1-U8 / 禁改清单）全项符合；三条通过命令实跑全绿（typecheck exit 0 / lint exit 0 零新增 / vitest 2196 passed 0 failed）；U6 红性验证闭环（红 → 字节级还原 → 绿）；4 个披露口径差异点全部裁决接受（d 为未复现记录在案）。
