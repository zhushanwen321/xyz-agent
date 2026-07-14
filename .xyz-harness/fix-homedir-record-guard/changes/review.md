# Code Review — fix-homedir-record-guard (方案A)

## 审查范围
- commit: `f15f0ec5` fix(homedir): WorkspaceService.record 加 homedir 守卫（方案A），移除 W5 源头判断统一到 service 层
- 改动文件：4 个（workspace-service.ts / session-lifecycle.ts / workspace-service-homedir.test.ts 新建 / session-lifecycle-w5.test.ts 调整）
- 审查方式：独立对抗性审查，逐路径追踪 4 条 record 调用链 + homedir() 比较可靠性验证
- 验证手段：git show 全 diff、Read 全文、vitest 实跑 2 文件 7 用例、ESLint 实跑、node REPL 验证 os.homedir() 行为

## 发现的问题

| # | 维度 | 问题 | 严重度 | 位置 |
|---|------|------|--------|------|
| 1 | 边界条件 | 存量 homedir 记录无法自愈：守卫只挡「新 record」，`loadFromFile` 加载持久化文件时不过滤 homedir。若 recent-workspaces.json 在本修复前已写入 homedir 条目，重启后该条目永久残留列表（直到 LRU 淘汰）。无迁移/清理逻辑。影响面小（homedir 污染是近期才引入），但自愈能力缺失 | should_fix | recent-workspaces-store.ts:loadFromFile |
| 2 | 业务逻辑 | homedir 根目录项目被误伤：守卫是精确 `===`，若用户真的在 `$HOME` 根目录放项目（少数人直接在 ~ git init）并发首条消息，该项目永不进最近工作区列表。JSDoc 已隐式承认（「homedir 永远是已知的」），权衡可接受，但未在注释明示此副作用 | nit | workspace-service.ts:27 |
| 3 | 边界条件（Windows）| Windows 盘符大小写不敏感风险：`os.homedir()` 返回 `C:\Users\xxx`（大写 C），但若某调用路径产生的 cwd 是 `c:\Users\xxx`（小写）或经不同 API 得到变体，`===` 会漏过。经核查当前 3 条 runtime 路径的 cwd 全部源自 `os.homedir()`/`process.cwd()`/Electron `dialog.filePaths[0]`，三者均返回大写规范盘符，实测一致，**当前代码无实际触发**。但守卫无规范化（如 `path.normalize` + 大小写归一）兜底，未来新增 record 调用点若引入非规范来源会静默漏过 | nit | workspace-service.ts:27 |
| 4 | 测试覆盖 | 缺少 symlink home / 尾斜杠变体的负向测试。守卫核心假设是「cwd 与 homedir() 字符串恒等」，但测试只断言 `record(homedir())` 被挡，未覆盖 `record(homedir() + '/')` 或 `record(homedir() + '/.')` 是否漏网（会漏网，但无测试文档化这一已知限制） | nit | workspace-service-homedir.test.ts |

**确认正确（无问题）**：

- **核心假设成立（重点验证项）**：`homedir() === cwd` 比较对当前全部 4 条调用路径可靠，逐一验证：
  1. `session-lifecycle.ts:113` create 降级路径：`sessionCwd = homedir()`（line 51），`record(sessionCwd)` 传的就是 `homedir()` 返回值本身，`===` 恒成立 ✅
  2. `message-dispatcher.ts:107` 发消息路径：`activeSession.cwd` 由 `initializeManagedSession(id, client, cwd, ...)` 赋值（session-service.ts:564 `cwd`），降级时该 cwd 即 `sessionCwd = homedir()`，字符串同源 ✅
  3. `workspace-message-handler.ts:38` 前端 RPC 直选路径：cwd 来自 Electron `dialog.showOpenDialog` 的 `filePaths[0]`（privileged-handlers.ts:52），Electron 返回规范化绝对路径无尾斜杠，与 `os.homedir()` 同形 ✅
  4. 列表自繁殖路径：选中已记录条目 → `selectWorkspace(cwd)` → `workspaceStore.record(cwd)` → 同 RPC 链路，若 cwd 是 homedir 则被挡 ✅
- `restoreSession`/`forkSession` 自身不调 record（确认 lifecycle 内仅 line 113 一处 record），其 homedir 降级污染经 dispatcher 发首条消息时被挡 ✅
- 移除 W5 的 `sessionCwd === requestedCwd` 判断后，create 降级路径完全依赖 service 层：`record(sessionCwd)` 无条件调用，homedir 过滤下沉到 `WorkspaceService.record`，无「create 传 homedir 但 service 没过滤」漏洞 ✅
- 类型安全：`homedir(): string` 与 `cwd: string` 比较无类型问题 ✅
- import 位置规范：`import { homedir } from 'node:os'` 置于文件顶部、其他 import 之前（node 内建优先），符合项目约定（对比 session-lifecycle.ts:15 同模式）✅
- 注释风格：JSDoc 扩展「homedir 守卫（方案A）」段落，与既有 INV-1 注释风格一致，说明了堵死的 4 条路径，符合项目注释约定 ✅
- 测试调整语义正确：`session-lifecycle-w5.test.ts` 第 2 用例从「降级不调 record」改为「降级仍调 record 传 homedir」，准确反映「lifecycle 无条件 record + service 层过滤」的新职责分层，注释 `[方案A]` 标注清晰 ✅
- 实跑结果：2 文件 7 用例全绿，ESLint 0 error ✅

## plan 覆盖核对

**注意**：`.xyz-harness/fix-homedir-record-guard/` 下未找到 `plan.json`（目录为空，仅 changes/ 子目录）。以下核对基于 commit message 与背景描述中所述的 W1 4 条 changes 逐条确认落地。

### 方案A 改动核对（基于 commit message 声称的 4 条）

- [x] workspace-service.ts record() 加 `if (cwd === homedir()) return` 守卫 + import homedir — 完全落地（line 11 import + line 27 守卫）
- [x] session-lifecycle.ts 移除 W5 的 `sessionCwd === requestedCwd` 判断，恢复为 `if (!options?.hidden) record(sessionCwd)` — 完全落地（line 109-114，旧判断移除，注释更新说明归位 service 层）
- [x] workspace-service-homedir.test.ts 新建 service 守卫 3 用例 — 完全落地（homedir 被挡 / 普通路径透传 / 空串 INV-1 回归）
- [x] session-lifecycle-w5.test.ts 调整用例语义 — 完全落地（第 2 用例改语义 + describe 标题改 + 注释标注 [方案A]）

### U1-U5 测试覆盖核对（基于背景描述）

- [x] U1 service 守卫挡 homedir — workspace-service-homedir.test.ts 用例 1
- [x] U2 service 守卫放行普通路径 — workspace-service-homedir.test.ts 用例 2
- [x] U3 INV-1 空串回归（守卫未破坏既有不变式）— workspace-service-homedir.test.ts 用例 3
- [x] U4 create 降级仍调 record（传 homedir，过滤归 service）— session-lifecycle-w5.test.ts 第 2 用例
- [x] U5 create 未降级正常 record — session-lifecycle-w5.test.ts 第 1 用例

## 结论
- **must_fix: 0**
- should_fix: 1（#1 存量 homedir 记录无自愈）— **已在 review 后修复**：`recent-workspaces-store.ts` 的 `loadFromFile` 解析循环加 `if (record.cwd === home) continue`，存量 homedir 条目重启后自愈清除
- nit: 3（#2 homedir 根项目被误伤未在注释明示 / #3 无规范化兜底当前无触发 / #4 缺尾斜杠变体负向测试）

**核心结论：方案A 的核心假设（homedir() 路径 `===` 比较可靠）成立。** 逐一验证全部 4 条 record 调用路径，cwd 与 homedir() 在当前代码中字符串同源、同形（均来自 `os.homedir()` / `process.cwd()` / Electron dialog 规范化路径），无尾斜杠/大小写/symbol 差异。一处堵死全部路径的架构目标达成，移除 W5 双重判断后职责分层清晰（lifecycle 无条件 record，service 层统一过滤）。

测试 7/7 全绿，ESLint 0 error，import/注释规范符合约定。**review 通过**。#1 已在 review 后补 `loadFromFile` homedir 过滤修复。
