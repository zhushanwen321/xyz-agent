# Code Review：fix-landing-dir-popover

## 审查范围

本 topic 4 个 commit（`084320f8..HEAD`）：
- `00b0560a` feat(W1): MAX_RECORDS 10→6 + popover slice
- `806bda9e` feat(W2): workspace.detectBare RPC + landing isBare driven by pendingCwd
- `edaed331` feat(W3): default landing cwd to last active session's cwd
- `9236227d` test(W1): red tests + ADR 0039 + harness

派 reviewer subagent 按 6 维度审查（type-safety / error-handling / edge-case / test-coverage / plan-completeness / design-consistency）。主 agent 甄别 reviewer 发现后，确认 3 个 Major 问题。

## 发现的问题

| ID | severity | dimension | 问题 | ref |
|----|----------|-----------|------|-----|
| R1 | must-fix | error-handling | detectBare handler 无 try/catch + cwd 守卫，service 抛错会破坏 RPC 契约（前端 pending Promise 永不 resolve），与同文件 record 分支不对称 | workspace-message-handler.ts:63-68 |
| R2 | must-fix | test-coverage | detectBare handler 测试只覆盖正常路径（DB-1/2/3），缺 service 抛错路径（DB-5）和空 cwd 路径（DB-4），无法验证 R1 的守卫逻辑 | workspace-detect-bare-handler.test.ts |
| R3 | should-fix | edge-case | initApp reduce 用 `>` 而非 `>=`，lastActiveAt 相同时取后者（不稳定），无测试锁定 | useSidebar.ts initApp |

## 核实过程（甄别 reviewer 发现）

reviewer 的路径探索能力弱（多次 read 失败、文件名猜错），但其核心判断经主 agent 核实：

- **M1 核实**：detectBare 确实有专门测试文件 `workspace-detect-bare-handler.test.ts`（reviewer 说"零覆盖"是错的，它没找到文件）。但 DB-1/2/3 只覆盖正常路径，**缺失败路径**——这条成立，记为 R2。
- **M2 核实**：detectBare 分支确实无 cwd 守卫/try-catch。对比 record 分支有完整守卫 + 注释「校验失败仍必须 reply，否则前端 pending Promise 永不 resolve」。detectBare 缺这个对称性。service.detectBare → detector.detect 内部对 ENOENT 兜底不抛，但空 cwd 会导致 `join('','.bare')` 解析到 process.cwd()（逻辑静默错误），且无防御性 catch。成立，记为 R1。
- **M3 核实**：`a.lastActiveAt > b.lastActiveAt` 相同时间戳取后者。改为 `>=` 取首个（稳定）。影响轻微（相同时间戳罕见，UI 预填），但审查维度明确点名且无测试，记为 R3。

## 未采纳的 reviewer 发现（甄别为非 bug）

- m1 watch immediate 触发 detectBare(null)：实现已守卫（`if(!cwd){isBare=false;return}`），非 bug。
- m2 isBare ref per-session 隔离：landing 单 flow，watch 重新触发即更新，无泄漏，符合 AGENTS.md 7.6 例外。非 bug。
- m3 WorkspaceDetector(fs) 符合 FsLike：node:fs statSync 兼容。非 bug。
- m4 Landing isBareWorkspace `flow.isBare?.value` 冗余可选链：useNewTaskFlow 总是返回 isBare，`?.` 无害防御性。非 bug。
- m5 protocol.ts 四层类型映射完整对称：核查通过。
- m6 workspace-service.ts list() 注释残留「≤10」：文档漂移，顺手在 R1 修复时一并更新。
- m7 store.list() 冗余 slice：防御性编程，非 bug。
- m8 emit 单 payload：符合规范。

## 修复方案

R1+R2 一起修（handler 加守卫+catch，补 DB-4/DB-5 测试验证守卫）；R3 改 `>=` + 补 IC-6 测试。派 worker 执行（commit 待回填）。

## 整体评估

实现质量扎实：protocol 四层类型对称、FR-1~4 全落地、ADR 0039 解耦一致、错误兜底到位、编码规范合规（无 any / 无原生 HTML / emit 单 payload）。

主要风险是测试覆盖深度（R2），修复后 test 阶段可放心推进。

**修复 R1/R2/R3 后可进 test 阶段。**
