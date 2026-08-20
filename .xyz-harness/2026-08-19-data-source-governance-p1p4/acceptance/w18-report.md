# W18 verifier 验收报告：runtime 消费管线（entry_appended + get_entries 增量 + extractor 降级）

PASS（10 检查点全过；无 must-fix；两 builder 偏差均裁决接受；minor 观察项 6 条不阻塞。红性两组独立复现全红，还原后哈希与验收开始时逐字节一致）

验收基线：9382ccb57。verifier 独立对抗验收，2026-08-19。

## 检查点 1：防篡改 — PASS

- `git diff 9382ccb57 -- .xyz-harness/.../acceptance/w18-acceptance.md` → 输出为空（未篡改）。
- `git diff 9382ccb57 -- docs/architecture/data-source-governance-plan.md` → 输出为空；§5 W18 节（L567-593）逐段读取与任务书引用一致（NULL_EVENTS r4 核正行号注记、四涉及文件、任务步骤 1-4、验收标准 1-4 原文完整）。
- 登记表 `docs/architecture/data-source-registry.md`：`git diff HEAD -- <registry>` 输出为空（工作区零改动）。`git diff 9382ccb57 --stat` 显示的 26 行差异全部来自已 commit 的 W11/W12/W19（`git log 9382ccb57..HEAD -- <registry>` = 03018faaa / 3d41a29ea / 5ae15ff46），builder 未碰登记表——草稿制成立。
- ledger.md 工作区 diff 为状态流转记录（W13 verified / W18 verifying，主 agent 手笔），非 builder 改动。

## 检查点 2：范围核对 — PASS

W18 实际领地（git status 归属逐文件核实）：

- 生产 9 文件 + 2 删除：event-adapter.ts / event-interpreter.ts / session-service.ts / subagent-extractor.ts / workflow-extractor.ts / types.ts / interfaces.ts / runtime index.ts / shared constants.ts（M）；model-context-cache.ts + 其测试（D）。builder 自报「8 文件」漏计 types.ts（record-entry-appended 事件类型，8 行，纯 W18 内容）——计数口误，非越界。
- 测试 8 改写（自报 7，漏计 w12-owner-snapshot-publish.test.ts——193 行改写，内容全部是 resolver 注入链删除 + 包装类退役的必然连带，归属 W18 合理）+ 2 新增 + 1 删除。
- extensions/ 零改动（git status 0 命中）；replicated-states.config.ts 零改动；core chat 域（packages/core/src/domain/chat/）diff 中 grep `recordEntries|invalidateRecord|entry_appended|subagent-record|workflow-record` = 0 命中（全部是 W13 applySnapshot / W14 pendingBuffer 在途内容）。
- 混合文件归属：shared/index.ts 同文件混 W18 导出（两个 CUSTOM_TYPE 常量）与 W13 在途导出（SessionViewSnapshot）；taste-lint/no-non-owner-store-mutation.mjs 为 W13 的 R2 联动（applySnapshot 单键化）；shared/protocol.ts 为 W13。与 ledger W13 行注记一致，commit 顺序 W18→W13→W14 已锁定。

## 检查点 3：双管线消亡核实 — PASS（核心）

`grep -rn "SubagentsState|WorkflowUpdatesState|applyStart|applyNotify|pendingStartParams|cacheSubagentStartParam" packages/{runtime,core,renderer}/src`（排除测试）→ 唯一命中 event-interpreter.ts:575，且是历史说明注释（「W12-W18 过渡期本方法曾直写…」），非代码。含测试全仓也仅 event-interpreter.ts 一处（同注释）。

event-interpreter 中 subagent/workflow 相关事件处理全景（逐行读码）：

- `record-entry-appended` → `onRecordEntriesInvalidated(sessionId, customType)`（L343-347），payload 不进缓存。
- `handleSubagentBgNotify`（L583-587）：customType 守卫后仅失效回调，details 不再解析。
- `handleWorkflowResult`（L593-597）：同上。
- tool-call-end（L459-467）：SUBAGENT_TOOL_NAMES / WORKFLOW_TOOL_NAMES 命中 → 失效回调（兜底信号）。
- customStart WS 帧转发保留：'message' 分支照常 send；快速路径护栏（text_delta 带 customType 回落完整 handle）在位（L221-231 + workflow-push U4 组用例锁定）。
- event-adapter：`grep -A4 "NULL_EVENTS = "` 无 entry_appended（'turn_start','extension_config','extension_ui_response','response','agent_settled'）；`DISPATCHER.set('entry_appended', handleEntryAppended)` 注册；handleEntryAppended 仅对 SUBAGENT/WORKFLOW_RECORD_CUSTOM_TYPE 产 record-entry-appended，其他 custom（含 entry.type!=='custom'）→ noop。

## 检查点 4：游标三路径读码 — PASS

session-service.ts（RecordEntriesCache L152-163，refreshRecordEntries L635-678）：

- 初始态：cursor=null → `client.getEntries()` 无参全量 + `cache.subagents/workflows.clear()`（全量重建 = 新基线整体替换）；扫描结果全部视新 → 必然发布（测试「初始态全量」断言 subMsgs 长度 1 + stateSnapshot last-value）。
- 增量：`getEntries(cache.cursor)` → `if (leafId !== undefined) cache.cursor = leafId`（L672）——有 leafId 推进、无 leafId（undefined 含 null）保持原 cursor。
- 失效自愈：catch 中 `cache.cursor !== null && isEntryNotFoundError(e)` → warn + `cursor = null` + `continue`（第二轮全量）；`MAX_REFRESH_ROUNDS = 2` 上限防坏 pi 反复全量；其他错误 → warn + return（cursor 保留、不发布）。
- isEntryNotFoundError（L1905-1908）：`/^entry not found/i.test(msg)`——i 标志大小写宽容 + 前缀锚定（不误吞其他含 entry 错误）；与 W20 getHistory 路径（L835）共用同一函数。
- 防抖 = SCALAR_STATE_DEBOUNCE_MS（replicated-states.config.ts:52 = 300ms）；inflight 复用；注册点 initializeManagedSession:1424（不播种，首失效全量）；销毁点 removeSessionEntry:1324-1328（clearTimeout + delete）；applyRecordEntries L708 `sessions.has` 守卫拦销毁后发布。
- applyRecordEntries diff 语义：subagent 逐字段 subagentRecordEquals（L1914+）；workflow 按 status/reason 变化收集增量信号；无变化不发布。

## 检查点 5：scan 读码 — PASS

- subagent-extractor：scanSubagentEntries → collectSelfDescribedSubagentRecords（自描述优先：type==='custom' + customType===SUBAGENT_RECORD_CUSTOM_TYPE + d.v===1 守卫[≠1 warn+skip] + 防御式逐字段提取；Map 同 id 后到覆盖；closedReason 仅 closed 投影）→ null 时 extractSubagentsFromEntriesLegacy（toolCall/toolResult/bg-notify 配对 + listResponse 合并 + sessionFile 时间戳回退，W18 前原磁盘解析原样保留）；extractSubagentsFromSessionFile（冷启动磁盘）→ parseJsonl → 同一 scan。
- workflow-extractor：scanWorkflowEntries → 自描述（d.v===1 entry 层守卫 + snapshot.runId 存在性守卫 + 同 runId 后到覆盖）→ legacy（workflow-state-link + state 文件读取）；两级版本守卫独立：entry 层 d.v≠1（L161-168）与 snapshot 层 SNAPSHOT_VERSION 'wf-run-v2'（L300-308）分开判定——测试「D-5 两级版本独立」用例（workflow-extractor.test.ts:614）锁定；mapValidatedSnapshot 两路共用（结构守卫 + 版本守卫 + trace 数组守卫）。
- 冷启动磁盘与实时增量同一份 scan：getSubagents（session-service:887→893）/getWorkflows（:916→920）均调 extractXxxFromSessionFile → scanXxxEntries，与 refreshRecordEntries 的 scan 为同一函数（D4 达成）。

## 检查点 6：红性验证 — PASS（两组，篡改字节级还原）

组 1（事件直写复活，任务书 a）：在 handleSubagentBgNotify 恢复 W12 过渡态直写（事件 details 直接 send session.subagents 数据帧，绕过 entry 扫描）→
- event-interpreter-subagent-push U2 红：`expected [] to have a length of +0 but got 1`（session.subagents 帧 0→1）
- w18-record-entry-chaos 场景 5 用例同步红（2 failed / 6 passed）
还原（cp 备份回写）后两文件 8/8 绿；sha256 = 3541bfa3…（与验收开始时一致）。

组 2（自愈分支降级，任务书 c）：删 isEntryNotFoundError 分支改普通错误处理（Entry not found 也 return 保留 cursor）→
- session-record-entries「游标失效自愈」用例红（1 failed / 7 passed——其余 7 绿证明该分支为用例独占覆盖，定向性好）
还原后 8/8 绿；sha256 = 2754a239…（一致）。

（任务书 b 选项「删 adapter customType 过滤」未选：session-service 层存在第二道守卫（L602），adapter 过滤无独立单测锚点，组 b 红性不可证伪；a+c 两组已覆盖「事件直写退役」与「自愈」两个核心语义。）

## 检查点 7：混沌用例真实性 — PASS

w18-record-entry-chaos.test.ts 逐行核实：

- mock 层级 = RPC 层（client.getEntries 返回 fixture entry 数组，形态 {type:'custom', customType, data:{v:1,…}} 对齐 pi appendCustomEntry + W16/W17 写点 schema）；生产链路全真实：translate（真 adapter）→ EventInterpreter（真）→ invalidateRecordEntries → 防抖 → getEntries（mock）→ scan → merge → publish（真 MessageBus + mock ws 订阅）。合规（验收文档「mock RPC 层」许可，无 mock pi 本体逻辑）。
- 「拦截 entry_appended 不投递」实现：终态 entry 先 push 进 piEntries（append 已持久化）但对 interpreter 不调用 interpret(translate(entryAppendedPiEvent(...)))——广播丢失语义忠实（append 与广播两环节分离）。
- 对照组在位（用例 1 前半：主信号投递 → 收敛 sa-chaos-1 closed）；「同值」断言能力实证：若兜底失效链断裂（红性组 1 已证），healedMsgs 长度断言（toHaveLength(2)）即红；收敛值断言派生缓存 == pi entry 集合扫描全集（['sa-chaos-1','sa-chaos-2']），与主信号在位时同值（等价性成立）。
- 用例 2（双信号全丢）：先断言 getEntries 未被调用（无失效无拉取），后续 entry_appended 到达 → cursor 仍 null → 首拉全量把丢失窗口 entry 一并收敛（['sa-a','sa-b']）。

## 检查点 8：回归 — PASS

- `cd packages/runtime && pnpm typecheck` → 0 错误。
- `cd packages/runtime && pnpm test` → **278 files / 3160 tests 全部通过**（35.74s，一次全绿，无超时抖动——隔离复跑条款未动用；builder 自报 3160 与实测一致）。equivalence 含 w18-record-entry-chaos（2 用例）与 w12-owner-snapshot-publish 改写在列。
- `grep -rn "getSubagents" packages/runtime/src`：RPC 手动刷新路径完整——session-message-handler.ts:255（'session.getSubagents' 分发）→ session-service.getSubagents:887 → extractSubagentsFromSessionFile:893（磁盘扫描→scan）；getWorkflows 同构（:263→:916→:920）。
- 死代码零调用实测：`grep -rn "setThinkingLevelCache|setModelContextWindowResolver|resolveContextWindow|model-context-cache" packages/ apps/ extensions/` → 生产代码 0 调用（仅 3 处历史注释 + 1 处测试 mock 残留桩，见 minor-2）；model-context-cache.ts 及其测试文件已删，全仓无 import。

## 检查点 9：两偏差裁决 + customType 对齐 — PASS

偏差①（死代码声明位置）：`ls packages/runtime/src/ports/` → 目录不存在；ISessionService 声明实际在 packages/runtime/src/interfaces.ts（L231 invalidateRecordEntries 新增、setThinkingLevelCache 删除均在此）。任务书路径笔误，builder 落点正确。**裁决：接受**。

偏差②（Map 物理位置）：plan 交付物 2 字面写「event-interpreter.ts 的 subagentRecords Map 改纯派生缓存」，交付物 3 写「session-service.ts 做 getEntries(since) 增量编排」。builder 将 Map（RecordEntriesCache.subagents/workflows）与 cursor/防抖/inflight 同体放 session-service——增量 merge 需要旧值做 diff 与同 id 覆盖、发布需要 messageBus，interpreter 两者皆无（组合根只注入失效回调）。Map 与 cursor 分居两文件会引入跨文件状态耦合。验收实质（唯一写方 = entry 扫描、事件直写退役、事件只做失效）全部满足，且 plan 交付物 3 本就指定 session-service 为编排层。**裁决：接受**（plan 交付物 2 的文件名描述与交付物 3 存在内生张力，builder 取舍合理）。

customType 字面量对齐（逐字）：
- shared `SUBAGENT_RECORD_CUSTOM_TYPE = 'subagent-record'` ↔ extensions/subagent-workflow/src/execution/record-entry.ts:25 `"subagent-record"` — 相等。
- shared `WORKFLOW_RECORD_CUSTOM_TYPE = 'workflow-record'` ↔ extensions/subagent-workflow/src/orchestration/jsonl-run-store.ts:128 `"workflow-record"` — 相等。
- 附带核 verified：runtime SNAPSHOT_VERSION 副本 'wf-run-v2' ↔ jsonl-run-store.ts:75 `"wf-run-v2" as const` — 相等；workflow-record entry data schema {v:1, snapshot, updatedAt} ↔ extensions WorkflowRecordEntryData（L138-144）一致。shared 副本注释明确标注权威源在 extensions/（跨包禁 import 理由成立）。

## 检查点 10：登记表撤销草稿核对 — PASS（草稿实体未见，按语义核对）

- 登记表主文件未被 builder 改（检查点 1 实证）——符合验收文档「草稿制」。
- 草稿文本实体不在仓库（untracked 仅 w13/w14 report + 3 测试文件；ledger 仅转述「已交」）。若草稿在主 agent 处，按其转述内容核对终态描述与代码实际状态：
  - #8 撤销方向 = 删「W12-W18 过渡态登记例外」（SubagentsState 包装实例 + applyStart/applyNotify 写入口）→ 终态「entry_appended 失效 + get_entries 增量 + RecordEntriesCache 纯派生 + extractor scan 双路共用 + legacy 兜底」——与本文检查点 3/4/5/7 核实的代码状态逐项一致。
  - #9 撤销方向 = 同构（WorkflowUpdatesState/apply 退役）——一致。
  - 注意点：撤销后 #8 行内「event-interpreter.ts:149 subagentRecords」的行号/文件引用必须同步移除（该 Map 已物理迁移至 session-service.ts:248 recordEntriesCaches），否则登记表与现实脱钩——落表时主 agent 需带上。
- W23 解锁条件（备注「完成后撤销…+ W23 解锁」）：W18 交付实证达成，W23 依赖（W11✓/W13 在途/W18✓）就绪状态以主 agent 台账为准。

## 红性记录汇总

| 组 | 篡改点 | 预期红 | 实测 | 还原后 |
|----|--------|--------|------|--------|
| 1 | handleSubagentBgNotify 恢复直写（send session.subagents 数据帧） | U2 + 混沌红 | U2 红（0→1 帧）+ 混沌红（2 failed） | 8/8 绿，sha256 一致 |
| 2 | isEntryNotFoundError 自愈分支改普通 return | 自愈用例红 | 1 failed / 7 passed | 8/8 绿，sha256 一致 |

终态 git status 与验收开始时一致（两个红性文件 sha256 复核；extensions/replicated-states.config 0 命中）。

## minor 观察项（不阻塞）

1. **builder 自报计数偏差**：生产「8 文件」实为 9（漏 types.ts）；测试「7 改写」实为 8（漏 w12-owner-snapshot-publish.test.ts）。内容归属核实无误，纯计数口误。
2. **测试侧残留桩**：packages/runtime/test/model-service.test.ts:24 仍有 `setThinkingLevelCache: vi.fn()`——ISessionService 已删该方法（interfaces.ts diff 实证），mock 桩残留（vitest 不做严格 excess check 故不红）。建议随手清理。
3. **「命中即权威」混合语义**（plan 字面语义，非 builder 偏差）：scanSubagentEntries/scanWorkflowEntries 只要 ≥1 条有效自描述 entry 即返回纯自描述列表，不与 legacy 解析合并——跨 W16/W17 升级边界的活跃 session 中，升级前创建的旧记录（仅 legacy entry）在有任一自描述 entry 后从列表消失。plan 步骤 4 明文「先扫自描述 customType 无命中再走旧解析」，取舍如此；现实触发面小（升级时旧记录多为终态），留档知悉。
4. **失效不区分 customType 的全量扫描**：subagent-record 失效触发的重拉同时扫描 workflow entries（反之亦然）——applyRecordEntries 无条件跑两个 scan。幂等 merge + diff 抑制下正确性无影响，仅轻微拉取冗余；「正确性优先于按类增量」的合理简化。
5. **shared/constants.ts 3 个 unused eslint-disable warnings 归属**：L179/188/198，git blame 全部指向存量 commit 5cc2d61aec（2026-08-18，PLUGIN_NOTIFY_LIMITS/UI_TOAST_LIMITS 区域）——非 W18 diff 引入（W18 仅在 L24-45 新增常量），也非 W13/W14 在途（builder 猜测有误，实为已 commit 存量）。按 pre-commit MANDATORY 原则，W18 commit 时若被 hook 检出需正面修复（一行删 disable 即可）。
6. **adapter customType 过滤无独立单测锚点**：handleEntryAppended 的过滤逻辑只被 session-service 层守卫测试间接覆盖（invalidateRecordEntries L602 第二道守卫有专测）；若未来有人删 adapter 过滤，无直接用例变红（行为仍被第二道守卫兜住，风险低）。可补一个 translate 层用例。
