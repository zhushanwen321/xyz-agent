# 验证报告：9 个 must-fix 闭合核对（continuous-subagent-chat.md 修订版）

> 验证方式：逐条对照修订后文档 + 源码核实修复基础。只核 9 个 must-fix 是否闭合，不扩大范围。

## Summary

**9/9 CLOSED，0 NOT-CLOSED，0 PARTIAL。** 新增 2 个 INFO 级 NEW-FINDING（不阻塞）。关键事实均经源码核实（rootSessionId 字段、reconstructAll 四分支矩阵、worktree scan 判据、notifier dedup/守卫、spawnedChildren Set、isIdentityData/pooled/cancelHandler）。

## 逐条判定

| # | 判定 | 依据（文档位置 → 源码核实） |
|---|------|------------------------------|
| 1 | **CLOSED** | 决策 3 改用 `rootSessionId`（引用 `execution-record.ts:154`，实测 rootSessionId 定义于 154 行 ✅），并写明被否原因（顶层 parentRecordId 恒 undefined）。跨进程判定显式设计「绕过 collectRecords 过滤查磁盘全集再比对 rootSessionId，报 not owned 而非 not found」——实测 `collectRecords` 的 rootSessionFilter 在内存与磁盘源都过滤（record-store.ts:201/211/236），修复方向正确。§5 item 6 + 场景 D（② 被拒 not owned / ④ 被拒 not found）同步更新 |
| 2 | **CLOSED** | 决策 5 指定 idle sidecar 处置：新增 `.idle` sidecar（单行 JSON `{id, sessionFile, rootSessionId, round}`，与 `.alive`/`.finalized` 同目录同格式族——实测 alive-store.ts 即 `${sessionFile}.alive` 单行 JSON ✅）+ 重建矩阵扩展「`.idle` 存在 → idle」分支、兜底 crashed 不变。实测 record-store.ts reconstructAll 现有矩阵（.cancelled / .finalized / .alive+pid 存活 / 兜底 crashed）与文档描述一致，idle 分支插在兜底前，修复方向正确。§5 item 7 + 文件地图 record-store.ts 行已列 |
| 3 | **CLOSED** | 决策 5 明确 reaper 豁免：判据改为「pid 死 **且无 `.idle` sidecar**」才清理；对话模式 worktree 随 `.idle` 存在而保留。实测 worktree-manager.scan()（index.ts:295，session_start 执行）判据为「pid>0 且 isProcessAlive 失败 → 孤儿」（worktree-manager.ts:209-211），文档描述准确，豁免点明确。§5 item 7 + 文件地图列了 worktree-manager.ts + worktree-registry.ts 两个文件（均实测存在） |
| 4 | **CLOSED** | 决策 9 明确两处修复：dedup 对对话模式豁免（按「轮次」去重而非 subagentId）+ `toNotifyRecord` status 守卫加 idle。实测 `DEDUP_TTL_MS=60000`（notifier.ts:53）✅、`toNotifyRecord` 守卫「非 done/failed/cancelled 返回 undefined」（subagent-service.ts:443-445）✅，修复对象真实存在。§5 item 7 notifier.ts 行已列 |
| 5 | **CLOSED** | 决策 7 明确裁决删除 wait，被否理由三条完整（语义矛盾：running 时阻塞挂起 turn 与 G3 冲突；机制缺口：同步 tool handler 等异步 agent_end 无事件桥接；收益为零：notify 已送达）。§1 out-of-scope 同步删除、§5 item 4「无 wait（决策 7）」、G1 统一由 notify 覆盖，全文无残留 wait 语义矛盾 |
| 6 | **CLOSED** | 场景 A 上下文改为 `extensions/subagent-workflow/src/execution/record-store.ts`（实测存在，19.5KB）✅；场景 B 改为 `extensions/subagent-workflow/src/execution/` 目录（实测存在）✅。另补了机制侧通过标准（session 文件含第一轮全部 entry，不依赖 LLM 表现）——顺带闭合了原 QUESTION 1 |
| 7 | **CLOSED** | 进程语义统一裁定为 **kill + resume**：决策 5「进程照常 SIGTERM 回收（session-runner 的 kill 分支不改）」+ §3.1 插入消息路径「idle：resume 重开 session 后 prompt」+ M2 措辞「轮次完成 → 进程回收 + 写 .idle sidecar + record 标记 idle（不 archive）」+ 文件地图 session-runner.ts「kill 分支不改」。四处读法一致，无残留矛盾；方案 A（保活）被否理由完整保留 |
| 8 | **CLOSED** | 决策 6 明确设计进程定位机制：`spawnedChildren` Set → `Map<recordId, ChildProcess>`（或等价注册表）。实测 `spawnedChildren = new Set<ChildProcess>()`（session-runner.ts:193）确无 id 关联 ✅，修复方向正确。busy 误走 resume 的双开并发风险在「被否」理由中覆盖。§5 item 5 + 文件地图已列 |
| 9 | **CLOSED** | 决策 8 改为「不扩展 ExecutionMode，独立 chatMode 标志」，从根上消掉 mode 消费点波及；被否理由完整列举消费点且逐一核实：isIdentityData `mode ∈ {sync, background}`（session-reconstructor.ts:235 ✅）、pooled 判定 `record.mode === "background"`（subagent-service.ts:757 ✅）、cancelHandler `mode !== "background"` 抛 unsupported（subagent-actions.ts:245-246 ✅）、hasRunningBackground（subagent-service.ts:432 ✅）、STATUS_PRIORITY（record-store.ts:36 ✅）。§5 item 3 明确 chatMode 随 identity entry 持久化 |

## NEW-FINDING（仅与 9 项直接相关，均 INFO 级）

| 级别 | 位置 | 描述 |
|------|------|------|
| INFO | §5 文件地图 record-store.ts 行 | **STATUS_PRIORITY 补 idle 键未列入改动清单**（决策 8 将其列为被否方案的波及点，但 idle 态本身是 ExecutionStatus 新值，`Record<ExecutionStatus, number>` 字面量缺 idle 键会触发 TS2741 编译错误，实施期必然被迫补上——类型系统兜底，故 INFO 级不阻塞；建议文件地图补一句以防实施者困惑） |
| INFO | 决策 6 / §5 item 5 | 行号引用轻微偏移：`spawnedChildren` 实际定义于 session-runner.ts:193，文档写 :211（:211 附近是 kill 遍历函数）。语义不受影响，建议核对 |

## 附带确认（原审查报告 2 个 QUESTION 的处置）

- QUESTION 1（场景 A 依赖 LLM 表现）：场景 A 通过标准已补机制侧断言（session 文件 entry 完整性），已闭合。
- QUESTION 2（wait 去留）：决策 7 删除 wait，已闭合。

## 结论

9 个 must-fix 全部闭合，修复方向与现有源码机制吻合，未发现修订引入的新自相矛盾。2 个 INFO 级 NEW-FINDING 不改变通过判定，可在实施期顺手处理。
