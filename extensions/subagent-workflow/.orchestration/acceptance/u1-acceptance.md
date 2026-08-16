# U1 验收标准 — 行为删除（pause/resume 全链路 + session 终止重定位）

> **builder 与 verifier 禁止修改本文件。** 权威规格：`docs/design/workflow-one-shot-lifecycle-impl-spec.md`（子文档，§0 定稿总表 + §1 U1 改动清单）。本文件与子文档冲突时以子文档为准，两者同 commit 基线锁定。
>
> status: pending

## 目标

pause/resume 从全部接口面与生命周期消失；session 切换/关闭当刻 running run 转 done,failed（新 helper `terminateRunningRuns`）；discardInFlightCalls 移入 error-recovery 并在 rebuildRuntime 内 replaceRuntime 后同步调用。**创建路径完全不动**（初始 "paused" 瞬态两步保留——「创建即 running」属 U2）。完成后 typecheck/lint/test 全绿。

## 交付物（文件级，逐条对照子文档 §1.1/§1.2）

源码（7 文件）：`src/orchestration/lifecycle.ts`、`src/orchestration/error-recovery.ts`、`src/index.ts`、`src/interface/tool-workflow.ts`、`src/interface/commands.ts`、`src/interface/command-actions.ts`、`src/interface/views/WorkflowsView.ts`

测试（7 文件）：`lifecycle.test.ts`、`error-recovery-handlers.test.ts`、`error-recovery-workflow-call.test.ts`、`launcher-nested-workflow.test.ts`、`workflow-nesting-e2e.test.ts`、`command-handlers.test.ts`、`index-session-start.test.ts`

## 接口契约（签名锁定）

1. **新增导出** `lifecycle.ts`：`export async function terminateRunningRuns(deps: LifecycleDeps, reason: string): Promise<void>`——per-run 行为按子文档 F1：`state.error = reason` → `transition("done","failed")` → `await store.save(run)` → `pending:unregister`（reason:"failed"）；**不调 onRunDone**；per-run try/catch 不中断其余。
2. **删除导出**：`pauseRun`、`resumeRun`（lifecycle.ts）。
3. **`discardInFlightCalls`**：从 lifecycle.ts 删除，移入 error-recovery.ts 模块级私有；唯一调用点 = `rebuildRuntime` 内 `run.replaceRuntime(...)` 之后同步调用（无 await）。
4. **`WorkflowAction`**（tool-workflow.ts）收窄为 `"run" | "status" | "abort"`；`WorkflowRpcAction`（command-actions.ts）删 pause/resume、增 `{ action: "lifecycle-removed"; verb: "pause" | "resume" }`。
5. **原因串字面值**：session_tree → `"Session switched: run terminated"`；session_shutdown → `"Session shutdown: run terminated"`。
6. **命令 removed 提示文案**（逐字）：`` `Workflow ${parsed.verb} has been removed — runs are one-shot. To stop a run early: /workflows abort <runId>` ``（warning 级）。
7. **promptGuidelines 新增句**（逐字）：`Runs are one-shot: there is no pause/resume — to stop a run early use abort; for a fresh result start a new run.`

## 单测验收（逐条可查，测试名可对应）

1. lifecycle.test.ts：pauseRun/resumeRun 两 describe 删除；新增 `terminateRunningRuns` 套件 ≥4 用例（仅 running 被终止 / 每 run 发 pending:unregister 且不调 onRunDone / state.error 与 reason 字段落值 / 单 run save 抛错不中断其余）
2. error-recovery 系列：paused 守卫用例删除或改 isTerminal 语义；新增 rebuildRuntime 后 discard 生效用例（在飞清除、done 保留）
3. command-handlers.test.ts：pause/resume 命令用例删；新增 `/workflows pause <id>` → removed 提示断言
4. index-session-start.test.ts：mock 改 terminateRunningRuns；W2TC16 重写为「terminate 完成（save 后）→ dispose」顺序断言
5. launcher-nested / workflow-nesting-e2e：deps mock 删 pauseRun/resumeRun 字段

## E2E real 验收（真实 pi 环境，子文档 §3 手册命令级步骤）

- **S1**（正常完成）：chain.js run → done/completed，result 含三步产出（无 v2 断言——U2 范围）
- **S2**（主动 abort）：review-fix-loop 进行中 abort → done/aborted；`ps` 无残留 worker/pi 子进程
- **S4**（已删能力指引）：工具调 pause → `Validation failed for tool "workflow"`；RPC `/workflows pause <id>` → removed 提示；补全无 pause/resume
- **S7**（崩溃自愈，D-3 核心行为验收）：注入脚本三路（second 自愈 / always 耗尽 / throwAt 分账）——**b 重跑成功 = discard 生效；a 子进程 session 文件恰 1 份 = 不重复耗 token**

## 通过命令

```bash
cd extensions/subagent-workflow
pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test   # 三者全绿
grep -rn "pauseRun\|resumeRun" src/ && echo "MUST BE EMPTY" || echo "OK: zero refs"   # S8a
```

## 禁改清单（U1 领地外）

- `src/orchestration/models/types.ts`（RunStatus 三态保留）、`src/orchestration/models/workflow-run.ts`（构造/assignRuntime/创建路径全不动）、`src/orchestration/jsonl-run-store.ts`、`src/interface/gui-mappers.ts`、`src/interface/views/format.ts`
- `tool-workflow.ts` 的 WorkflowToolDetails 类型（:232/:286-288——U2 范围）
- `lifecycle.ts` 的 runWorkflow 创建路径（:155-235 中 status 初始化/runs.set/assignRuntime 顺序不动）
- 两份设计文档（docs/design/ 下）、.review/ 报告、本 .orchestration/ 目录
