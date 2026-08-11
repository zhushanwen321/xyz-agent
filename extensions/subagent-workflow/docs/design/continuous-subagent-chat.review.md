# 审查报告：可持续对话 subagent（Continuous Chat）设计文档

> 审查方式：对抗式。对照 `extensions/subagent-workflow/src/`（execution/ + interface/）源码逐项核实设计中的事实断言。只报告，不修改文档。
> 审查依据：`rubric-design-doc.md`（tech-design skill）。

## Summary

**9 must-fix, 5 suggestions, 2 questions。**

设计骨架完整（SCQA 开篇、五段齐全、§2 根因挖到「完成即终态」三处咬合、§3.2 三方案对比 + 被否效果、探针纪律 ✅/⛔ 标注诚实）。但**「磁盘重建可寻址」「worktree 保留」「回复通知」「wait 语义」四处核心断言与现有代码机制直接冲突**——不改设计或改代码，M2/M3 验收必翻车。

## 核实的准确事实（对照源码通过）

| 设计声明 | 源码位置 | 结论 |
|---|---|---|
| `ExecutionStatus = running/done/failed/cancelled/crashed` | `execution/types.ts:36` | ✅ |
| agent_end 无活跃后代即 `child.kill("SIGTERM")` | `execution/session-runner.ts`（含 pending 差集 keep-alive / recentUnregister 15s 宽限的细化分支，设计简化未提但方向准确） | ✅ |
| 终态 record 立即 archive，`findRecord`/`getMutable` 只查内存 | `execution/record-store.ts`（archive 即删内存；磁盘经 reconstructAll 重建） | ✅ |
| 句柄 `sa-<uuid>` | `execution/subagent-service.ts:707` | ✅ |
| spawn `--mode rpc --session-dir <agentDir>/subagents/<enc>/sessions` | `execution/pi-invocation.ts` + `session-runner.ts`（buildSpawnArgs） | ✅ |
| session 文件只被 session-reconstructor 只读重建 | `execution/session-reconstructor.ts` | ✅ |
| notify 用 `triggerTurn:true + deliverAs:"steer"` | `execution/notifier.ts` doSend | ✅ |
| 3 个 action（start/list/cancel） | `interface/subagent-tool.ts:74` | ✅ |
| pi CLI 支持 `--session <path|id>` | `pi --help`（0.84.0） | ✅ |

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|---|---|---|---|---|
| MUST_FIX | §3.3 决策 3 / §3.1 失败表 / 场景 D | P0-11 事实 | **归属守卫字段错误**：「record 的 `parentRecordId` 必须等于调用方（当前主 agent session）」——`parentRecordId` 是**父 subagent 的 record id**（`types.ts`：层级树构建用，顶层为 undefined），主 agent session 根本没有 record id，顶层 subagent 的 parentRecordId 恒为 undefined，按此实施守卫永不通过。正确的归属字段是 `rootSessionId`（递归链同值 = 主 session id，`subagent-service.ts` collectRecords 已按它过滤）。另：场景 D 的「② 被拒（归属错误）」跨进程时**先被 rootSessionId 过滤成 not found**（`collectRecords` 传 `this.sessionRootId ?? this.sessionId`），报不出 "belongs to a different parent"——归属检查需绕过过滤在磁盘全集里查 | 守卫改用 rootSessionId（或 sessionId）比对；跨进程归属判定需显式设计（查不过滤的全集）；失败文案与恢复指引随之修订 |
| MUST_FIX | §3.3 决策 5 / §5 record-store.ts / 探针 P-6 | P0-12 副作用（认知懒惰） | **idle 态与磁盘重建四分支 sidecar 矩阵冲突**：`record-store.ts` reconstructAll 的矩阵是 `.cancelled → cancelled / .finalized → done/failed / .alive+pid存活 → running / 兜底 → crashed`。idle 记录（不 finalize → 无 .finalized；alive marker 在 spawn 握手时写入、只在 finalize 时 remove）**死 pid 的 .alive 落在兜底分支 → 重建为 crashed**。即使 idle 时删掉 alive marker，也落入兜底 crashed。P-6「idle 跨重启可寻址」按现机制**必失败**——设计声称「磁盘重建可寻址」却未对照矩阵 | 设计必须指定 idle 的 sidecar 处置（新 .idle marker / 扩展矩阵分支 / alive marker 语义），并纳入 §5 文件地图（alive-store / finalized-marker 或新增） |
| MUST_FIX | §3.3 决策 5（worktree 保留）/ 探针 P-5 | P0-12 副作用 | **worktree reaper 会清扫 idle 对话的 worktree**：`worktree-manager.scan()`（`index.ts:295`，session_start 时执行）按「pid > 0 且进程已死 → 孤儿」清理。对话模式轮次结束进程必死（kill 分支不改）而 worktree 保留 → 下一次 session_start 即被 reaper 删除，对话工作目录（含在途文件）丢失，P-5 失败 | 设计需覆盖 worktree-registry/reaper 的 idle 豁免（如 idle 记录保留注册表条目 + reaper 跳过，或对话模式不注册/改判据） |
| MUST_FIX | §5 notifier.ts 行 | P0-12 副作用 | **BgNotifier 60s dedup TTL 会静默丢弃对话回复**：`notifier.ts` DEDUP_TTL_MS=60000，同 subagentId 60s 内第二次 notify 直接跳过。对话模式快速多轮（message → 回复间隔 <60s）第二条回复通知被吞，父 agent 永远等不到回复（G1/G2 断裂）。另 `toNotifyRecord` 的 status 守卫只放行 done/failed/cancelled，idle 态需扩展；设计只提「文案分流」未提这两处 | 对话模式豁免 dedup（或按「轮次」去重而非按 id），notifier status 守卫加 idle 分支；合并窗口（MERGE_WINDOW_MS）对多 subagent 回复合并的语义也需明确 |
| MUST_FIX | §3.1 失败表 / §3.3 决策 3 / §5 item 3 | P0-10 对抗 | **wait 语义自相矛盾 + 机制未设计**：失败表说 running 时 wait 报 busy（「用 message 代替 wait」），决策 3 说 idle 守卫「wait 要求不在运行中」——但 wait 的用途是「阻塞等回复」，subagent 只有在 running 时才有回复可等；idle 时回复早已经 notify 送达，wait 无事可做。两种读法（等 running→idle 转换 vs 仅 idle 可用）互斥。且「阻塞式 tool call 等待异步 agent_end」的机制（现有 tool handler 是同步执行的，agent_end 是异步事件流）完全未设计；wait 期间 subagent 完成还会触发 BgNotifier triggerTurn，wait 返回后 steer 消息重复注入 → 双通道重复消费 | 重新定义 wait 语义（或删除——G1 已由 notify 覆盖）；若保留，明确事件桥接机制与 notify 抑制策略 |
| MUST_FIX | §4 场景 A / 场景 B | P0-11 事实 | **验收上下文编造**：「真实项目（本 worktree），`src/auth.ts` 存在」——本 worktree 根无 src/ 目录、无 auth.ts（已 find 核实）。「分析整个 src/ 目录的导出结构」同样指向不存在的目录。验收场景的上下文是假的，无法照单执行 | 改用真实文件（如 `extensions/subagent-workflow/src/execution/record-store.ts`），场景 B 改用真实目录 |
| MUST_FIX | §5 M2 vs §5 文件地图 session-runner 行 | P0-10 对抗 | **「轮次完成不 archive/kill（标记 idle）」与「第一版不做 kill 分支改造」自相矛盾**：不 kill = 进程保活（方案 A 被否路线，~150MB/对话，且 dispose 时 killAllSpawnedChildren 全清）；kill = resume 重开（决策 1/2 的主线）。两处读法导致完全不同的实现（session-runner 是否改、message 走 stdin 还是重 spawn、P-4 探针是否必要）。文档同时写了两种答案 | 明确 idle 的进程语义：kill + resume（则 M2 措辞改为「不 archive、进程照常回收、标记 idle」）；保活（则文件地图需列出 kill 分支改造） |
| MUST_FIX | §5 item 3 message 路径 / 决策 6 | P0-12 遗漏 | **busy 投递缺进程句柄机制**：busy 时「message 投递 = rpc prompt 命令」需要 record→活 ChildProcess 的映射，现有代码**不存在**——ChildProcess 是 runSpawn 局部变量，`spawnedChildren` Set（session-runner.ts）无 id 关联，record.controller 只是 AbortController。且若 busy 时误走 resume 重开，会出现两个进程同时打开同一 session 文件（pi 无文件锁语义未探针，文件并发写/损坏风险未评估） | 设计消息投递的进程定位机制（record→child 映射或等价物）；补探针：busy 时对活会话 resume 的后果 |
| MUST_FIX | §5 文件地图（遗漏） | P0-12 副作用 | **ExecutionMode 扩展波及面未盘点**：`mode:"conversation"`（若扩展 ExecutionMode）会命中：`session-reconstructor.ts` isIdentityData 校验 `mode ∈ {sync, background}`（**对话 record 重启后重建直接失败 → list 看不到**）、`subagent-service.ts:757` pooled 判定（conversation 不占并发槽 → 并发无上限）、`cancelHandler` `mode !== "background"` 抛 unsupported、`hasRunningBackground` 不计 conversation、`record-store.ts` STATUS_PRIORITY 无 idle 键（排序 NaN）。文件地图未列 session-reconstructor / format / gui-mappers / list-component | 盘点 ExecutionMode 或独立 flag 的全部消费点，逐一列改动；isIdentityData 必改 |
| SUGGESTION | §3.4 探针清单 | P0-16 补充 | 探针未覆盖的运行时断言：resume 后 sessionId/文件名是否稳定（新消息是否写回同一文件）、identity entry 重复 append（session-runner 子进程退出后补写，resume 多轮会重复，reconstructFromFile last-wins 目前无害但需确认）、`--session` 与 `--session-dir` 组合行为、maxTurns/watchdog 每轮重置的语义 | 补 P-8/P-9 探针（M1 前） |
| SUGGESTION | §4 | P0-13 补充 | 验收缺关键场景：§3.1 失败表全部无对应验收（进程崩溃/文件损坏恢复指引、close 后重发 message）；wait 无场景；cancel 对话模式语义（设计自认「实施时验证」）无场景；并发双 session 同时 message 同一 subagent 无场景 | 至少把失败表 5 行各映射一个场景或显式降级为探针 |
| SUGGESTION | §5 item 1 | P0-12 边缘 | resume 时执行参数（maxTurns/graceTurns/worktree/fork/appendSystemPrompt）从哪取——ExecutionRecord 未持久化这些字段，resume spawn 无法复现原执行约束（maxTurns 每轮重置为全量预算） | identity entry 或新 sidecar 持久化执行选项，或明确「resume 只带 session 不带约束」并说明后果 |
| SUGGESTION | §3.3 决策 5 | P0-12 边缘 | 30 天 session-file GC（`session-file-gc.ts` TTL_DAYS=30）与 G4：idle 超过 30 天的对话 session 文件被删 → 句柄失效，恢复指引需覆盖 | 对话模式豁免 GC 或文档明示寿命上限 |
| SUGGESTION | §5 文件地图 | P1 一致性 | GUI/展示层对 idle 的处理未列：format.ts statusIcon switch 无 idle case（兜底 running 语义）、gui-mappers 字符串匹配（idle 落入 done）、list-component 文案——idle 会显示成错误语义 | 展示层文件入地图 |
| QUESTION | §3.1 / 场景 A | P0-13 澄清 | 场景 A 通过标准「第二轮回复明确引用第一轮的具体发现（同一行号/同一问题）」验证的是 **LLM 行为**而非机制——模型未引用（压缩/偷懒）算功能失败吗？验收断言依赖模型表现，需要作者明确这是机制验证还是行为验证，以及失败判定 | 补充「上下文保留」的机制侧断言（如第二轮 message 的 session 文件含第一轮全部 entry） |
| QUESTION | §3.1 wait / G1 | P0-10 澄清 | wait 的增量价值：notify（triggerTurn steer）已异步送达回复，wait 阻塞当前 turn 反而让主 agent 无法并行做别的事。G1「分派后可等待回复」是否必须 wait？若不需要，删掉 wait 可消掉一整个机制的复杂度（决策 1 的 steer 实测结论已证明 pi 侧无需它） | 作者裁定 wait 去留 |

## 判定四态小结

- **通过**：P0-1/2/3（结构、无 delta 链、结论先行）、P0-4（根因三层咬合）、P0-5（使用者视角）、P0-6（抽象概念有例子）、P0-7/8/9（方案对比完整）、P0-14（验收非单测非 mock）、P0-15（5 场景匹配大改动）、P0-17（物理数据流图）、P0-18（失败表带恢复指引）、P1-2（拆分有 justification）
- **不通过**：P0-10（wait 语义、M2 矛盾、G1 通知被 dedup 吞）、P0-11（parentRecordId、src/auth.ts）、P0-12（idle 重建矩阵、worktree reaper、notifier dedup、mode 波及面、进程句柄）、P0-13（场景 A 上下文编造 + 错误路径无验收）、P0-16（探针清单有缺口）
- **不适用**：P1-7（§5 文件地图是拆分指引，未越层到实现细节）
