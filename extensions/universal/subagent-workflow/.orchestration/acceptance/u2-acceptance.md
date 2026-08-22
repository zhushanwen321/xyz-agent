# U2 验收标准 — 类型与持久化收窄（RunStatus 两态 + 创建即 running + 快照 v2）

> **R7 勘误（2026-08-16，主 agent，验收后）**：单测验收 #1「v1 头 + paused → 跳过」的 fixture status 以 **running** 落地——`"paused"` 字面量与 S8b 双零 grep 断言冲突（验收条款自身矛盾），且版本守卫与 status 值无关、v1 running 残留跳过正是 D-5 边界声明的接受语义。verifier 复核成立（u2-report 裁决复核节），验收语义等价。

> **builder 与 verifier 禁止修改本文件。** 权威规格：`docs/design/workflow-one-shot-lifecycle-impl-spec.md` §0（F4 第二段/F5/F6/F8/F9）+ §2（U2 改动清单）。前置：U1 已 committed（889a798f9）。
>
> status: verified（PASS，见 u2-report.md）

## 目标

RunStatus 收窄两态（删 "paused" 死值）；「创建即 running」（构造 I1 调整 + assignRuntime 校验 + runs.set 后移）；meta.pausedAt 删；ReleaseMode 收窄 "terminal"；SNAPSHOT_VERSION bump wf-run-v2 + 旧 v1 跳过；WorkflowToolDetails 死类型收窄；gui-mappers/format 死分支清理；**U1 遗留的 6 处 pauseRun/resumeRun 残留清零**（全域 grep 归零）。typecheck/lint/test 全绿。

## 交付物（文件级，对照子文档 §2.1/§2.2）

源码 10 文件：`src/orchestration/models/types.ts`、`src/orchestration/models/workflow-run.ts`、`src/orchestration/models/run-runtime.ts`、`src/orchestration/models/run-state.ts`（注释）、`src/orchestration/models/run-spec.ts`（注释）、`src/orchestration/lifecycle.ts`（仅创建路径 :178/:205/:220 + 残余注释）、`src/orchestration/jsonl-run-store.ts`、`src/interface/tool-workflow.ts`（仅 WorkflowToolDetails :232/:286-288）、`src/interface/gui-mappers.ts`、`src/interface/views/format.ts`

测试 5 文件：`jsonl-run-store-session-file.test.ts`（含 :404 注释清理）、`gui.test.ts`（含 :429/:437 fixture 改名）、`WorkflowsView-signature.test.ts`、`crash-recovery.test.ts`、以及 `src/orchestration/models/trace.ts:156` / `budget.ts:103` / `run-runtime.ts:27` 的注释清理（源码文件在清单内，无新增测试文件）

## 接口契约（签名锁定）

1. **`RunStatus = "running" | "done"`**；`VALID_RUN_TRANSITIONS = { running: ["done"], done: [] }`；`ALL_RUN_STATUSES = ["running", "done"]`（types.ts）
2. **创建即 running（F4 第二段）**：lifecycle.ts runWorkflow 初始 `status:"running"`（:178）+ `deps.runs.set` 移到 assignRuntime 后（:205→:220 之后）；workflow-run.ts 构造 `validateInvariants` 跳过 I1 构造期检查（I1 完整校验移 assignRuntime 末尾——assignRuntime 已有 validateInvariants 调用 :232 则在该处生效）+ assignRuntime 前置校验改 `status==="running" && runtime===undefined`（:222-224）
3. **`meta.pausedAt` 删除**（workflow-run.ts :53-54 定义 + jsonl-run-store.ts :205 反序列化 + 序列化投影）
4. **`ReleaseMode = "terminal"`**（run-runtime.ts :30）+ workflow-run.ts :243 `release("pause")` → `release("terminal")`
5. **`SNAPSHOT_VERSION = "wf-run-v2"`**（jsonl-run-store.ts :61）+ v1 文件 loadAll 静默跳过（注释按子文档 U2-5 定稿文案）
6. **`WorkflowToolDetails`** lifecycle 分支收窄 `"abort"` 单值（tool-workflow.ts :232）+ buildWorkflowGui severity 分支简化（:286-288）——与 gui.test.ts pause action 用例同一 commit 处置
7. **U1 遗留 6 处清零**：`grep -rn "pauseRun\|resumeRun" src/` 全域零命中（trace.ts:156 / budget.ts:103 / run-runtime.ts:27 注释改写、gui.test.ts:429/:437 fixture 改名、jsonl-run-store-session-file.test.ts:404 注释改写）

## 单测验收

1. jsonl-run-store-session-file.test.ts：paused 快照用例改写为 v1 跳过用例（v1 头 + paused → 跳过不崩不显示）；新增 v2 序列化断言（`version:"wf-run-v2"`、status 无 paused、投影无 pausedAt）
2. gui.test.ts：paused 映射用例删 + pause/resume lifecycle action 用例随 WorkflowToolDetails 收窄删
3. WorkflowsView-signature.test.ts：签名改写（无 paused 态渲染）
4. crash-recovery.test.ts :139：union 收窄两态
5. lifecycle.test.ts 若有创建路径瞬态断言（构造 paused）需同步为 running（属创建路径改动的连带，允许触碰该文件的对应用例）

## E2E real 验收（子文档 §3 手册；注入脚本**必须带 `@pi-meta` 头**——U1 verifier 注记 ①：phases 必填，裸脚本 registry 标 available=false）

- **S3**（崩溃与切换作废）：① kill -9 重启 → done/failed 含 "Process killed"；②a 分支导航（TUI /tree）→ "Session switched: run terminated"；②b 切 session（/new 或 RPC switch_session）→ "Session shutdown: run terminated"
- **S5**（嵌套回归）：nested-chain.js 父子均 completed + 预算共享
- **S6**（预算终态）：tokens:100 → done/budget_limited
- **S8b**：`grep -rn '"paused"' src/` 零命中（历史注释/CHANGELOG 除外）+ `grep -rn "pauseRun\|resumeRun" src/` 全域零命中 + 旧 v1 快照启动不崩不显示 + 新快照 v2 + 三命令全绿

## 通过命令

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-subagent-continuous-chat
pnpm extensions:typecheck && pnpm extensions:lint   # exit 0
cd extensions/subagent-workflow && npx vitest run    # 仅豁免 4 存量失败
grep -rn "pauseRun\|resumeRun" src/                 # 零命中
grep -rn '"paused"' src/                            # 零命中（CHANGELOG/docs 除外）
```

## 禁改清单（U2 领地外）

- U1 已验收的**行为语义**：terminateRunningRuns / discardInFlightCalls 落点 / 4 守卫 isTerminal 简化 / 接口面（enum/verb/提示文案）——只允许因类型收窄产生的**机械编译适配**（如注释行号平移），行为改动 = FAIL
- `src/index.ts`（U1 领地，U2 不碰——session handler 已终态化）
- `src/interface/commands.ts` / `command-actions.ts` / `views/WorkflowsView.ts`（U1 领地；仅当类型收窄导致编译错时的最小适配需在汇报中逐条列出并说明）
- `src/__tests__/command-actions.test.ts` / `robustness-low-batch1.test.ts` / `command-handlers.test.ts` / `index-session-start.test.ts` / error-recovery 系列测试（U1 已验收；同理仅机械适配可碰）
- 两份设计文档、.review/ 报告、.orchestration/（verifier 禁改）
