# W1 验收标准：活跃 session label 直写全量切 set_session_name RPC

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §2 W1 节（L85-119，基线 commit 见 ledger）是 W1 的验收权威。builder 与 verifier 禁止修改两者。
> 规格 SSOT = plan W1 节「目标 / 前置依赖 / 涉及文件 / 任务步骤 / 验收标准」全文；本文档不重复转抄，只做锁定提炼与协调条款补充。两者冲突时以 plan 为准并上报主 agent。

## 目标（一句话）

活跃 session **label 链路**的全部 xyz 直写 pi JSONL 路径切换为经 pi：手动 rename 切 `set_session_name` RPC + `tryPersistLabel` turn_end/agent_end 兜底直写整体删除 + 显式初始 label 改经 RPC（create/fork）；派生初始 label 退役为显示派生。非活跃 rename 直写保持不动（legacy 例外，W2 登记 W11 移除）。

## 交付物（plan W1「涉及文件」清单，文件级）

1. `packages/runtime/src/infra/pi/rpc-client.ts` — 新增 `setSessionName(name: string)`（`sendCommand('set_session_name', { name })`，success 检查对齐文件既有约定，方法风格/JSDoc 对齐 `getState`）
2. `packages/runtime/src/services/ports/pi-engine.ts` — `IPiEngine` 接口声明 `setSessionName`（RpcPiEngine 委托实现）——缺此声明步骤 2 typecheck 必失败
3. `packages/runtime/src/services/session/session-lifecycle.ts` — `renameSession`（L284）活跃分支切 RPC；create（L234）/ forkSession（L633）显式 label 经 RPC；删 L294 `labelPersisted` 重置
4. `packages/runtime/src/services/session/session-service.ts` — 删 `tryPersistLabel`（L1282-1286）及其在 `handleTurnUsageSideEffects`（L878）/ `handleTurnEndSideEffects`（L902）的调用、`labelPersisted` 初始化（L1191）；两 handler docstring 中「承载 tryPersistLabel」段落同步移除
5. `packages/runtime/src/services/session/types.ts` — 删 `labelPersisted` 字段声明（L110）
6. `packages/runtime/test/rpc-client.test.ts` — 补 `setSessionName` 用例
7. `packages/runtime/test/session-service.test.ts` + `test/session-service-w3.test.ts` — rename 活跃分支直写断言改 RPC 断言；tryPersistLabel 用例删除/改写
8. `packages/runtime/test/session-lifecycle-rename.test.ts` [新增] — 活跃分支走 RPC / create-fork 显式 label 走 RPC / 派生 label 不触发 RPC / 非活跃分支不变

## 接口契约（锁定）

- `setSessionName(name: string)`：命令名必须是字面量 `'set_session_name'`，参数 `{ name }`；返回处理遵循该文件 `sendCommand` 既有 success 检查约定（规则：`sendCommand` 必须检查 `success`）。
- `renameSession` 活跃分支：`getRpcClient(sessionId)` 返回 undefined（pi 崩溃窗口）**必须 throw**（走既有失败路径 toast）；禁止可选链静默 no-op（UI 显示新名、零持久化、无提示的静默丢写 = 验收失败）。RPC 调用失败（success false / 超时）同样抛错。
- create/fork 显式 label 的 RPC 失败**不阻断** create/fork（label 留内存显示 + console.error 上报）。
- 保留：`session.label` 内存更新与 `sessionMetaCache.setLabel(...)`（P0 阶段 metaCache 未删，W9 再删）。
- 禁碰（W1 明确不动）：非活跃分支 `else` 的 `persistSessionName` 调用；`persistHandedOff` / `patchSessionCwd`（非 label 链路，W11 处置）；`infra/pi/session-file-utils.ts` 内 `persistSessionName` 实现本体（非活跃分支仍在用）。

## 单测验收（plan W1 步骤 6，逐条可查）

- rpc-client 用例覆盖 `set_session_name` 命令名与参数。
- session-lifecycle-rename.test.ts 四断言组：活跃 rename 走 RPC、create/fork 显式 label 走 RPC、派生 label（basename）不触发 RPC、非活跃分支仍走 persistSessionName。
- session-service-w3.test.ts 的 tryPersistLabel 直写断言删除。

## 通过命令（builder 自验 + verifier 实跑）

1. `cd packages/runtime && pnpm typecheck && pnpm test` → exit 0
2. 代码级 grep（plan W1 验收 1，四条全过）：
   - `grep -n "set_session_name" packages/runtime/src/infra/pi/rpc-client.ts` ≥1 命中
   - `sed -n '284,312p' packages/runtime/src/services/session/session-lifecycle.ts`：`if (session)` 分支内无 `persistSessionName` 调用且 `else` 分支仍有
   - `grep -rn "tryPersistLabel\|labelPersisted" packages/runtime/src packages/runtime/test --include="*.ts"` 命中数 = 0（机制含自述注释整体退场）
   - `grep -n "setSessionName" packages/runtime/src/services/session/session-lifecycle.ts` ≥2 命中（活跃 rename + create/fork 显式 label）
3. 行为级回归（plan W1 验收 3 中可在单测层验证的子集）：mock 层面断言见单测验收；真实环境行为（pnpm dev 场景）**留给 P0 gate**，本 wave 不要求。

## 禁改清单（越界 = 验收失败）

- `docs/architecture/data-source-governance-plan.md`、`docs/architecture/data-source-governance.md`、本 acceptance 文档
- `packages/runtime/src/infra/pi/session-file-utils.ts`（persistSessionName / persistHandedOff / patchSessionCwd 实现本体均不动——W11 领地）
- `packages/runtime/src/services/session/session-meta-cache.ts`（W9 领地）
- 既有测试文件除清单第 7 条列出的两个（session-service.test.ts / session-service-w3.test.ts）与 rpc-client.test.ts 外不动
- 禁止 git add/commit/push（主 agent 统一提交）；禁止 `--no-verify` / SKIP_*；禁止 mock 框架（fixture 用真实 tmp）；禁止 `any`

## 备注

- 行号引用以 plan 基线 commit 的源码为准；W1 执行时若行号漂移，按符号名定位，如实记录偏差。
- 完成后 W2 解锁（登记表 legacy 例外以 W1 后现状登记）。
