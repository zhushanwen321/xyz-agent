# data-source-governance 第 2 轮对抗复审报告（round 2）

> 复审对象：第 1 轮修复 6 commit（`332250876` / `90b441fa4` / `afb708380` / `aadc64c11` / `c0a909799` / `a39bad0f9`）+ 遗留项闭环状态。
> 复审方式：独立取证——不信 builder 测试自报，逐项读 diff + 读实现 + 独立探针（3 个临时测试文件，用后已删）+ 全量回归实跑。
> 禁区遵守：用户在途未提交改动（`session-lifecycle.ts` / `process-manager.ts` / untracked `attach-lifecycle.test.ts` / `.xyz-harness/2026-08-19-restore-fork-attach-fix/`）零触碰零 git 写；6 个修复 commit 均未碰在途文件（`git show --name-only` 逐个核实）。

## 结论（先行）

**major 数 = 0，minor 数 = 2（新发现 1 + 遗留 1），observation = 4。循环终止**：第 1 轮唯一 major（CI 凭证半边未闭环）修复验证有效，无修复无效、无修复引入的回归；新发现 1 个 minor 边界漏洞（one-shot 空文本轮的 hasRunning 排除失效 + 注释断言与代码矛盾），不构成 major。

| 维度 | 判定 |
|------|------|
| A 修复有效性（8 项） | 全部 PASS（含独立探针 4 用例） |
| B 新问题扫描 | 无回归；1 个 minor 边界漏洞 + 3 个 observation |
| C 遗留项 | 与 ledger 记录一致；D3 用户在途 deferred 维持；B 残留判 minor 不构成 major |
| D 全量回归 | typecheck 三包 0 errors；lint 0 errors；core 1024 / renderer 3059 全绿；**runtime 32 failed 经完整归因链 100% 属用户在途未提交改动**（修复 commit 域内含真实 LLM 等价性用例全绿） |

---

## A. 修复有效性逐项验证

| # | 修复项 | 判定 | 证据与实测 |
|---|--------|------|-----------|
| A1 | rpc-client resolve 守卫（findings#7/N2） | **PASS** | diff：`rpc-client.ts:342` resolve 分支收紧为 `msg.type === 'response' && msg.id && pending.has(id)`；`bash_execution_update` 进 event-adapter `NULL_EVENTS` 显式 no-op（pi 源码引用齐全）。builder 测试 3 用例（T1 流事件先到不误 resolve / T2 response 不泄漏 listener / T3 多 delta）实跑绿。**独立探针**（临时文件，非 bash 命令域）：P1 用 `getEntries()` 验证守卫对非 bash 命令同样免疫（含虚构未知流事件 `some_future_progress`）→ pending 未 settle、真 response resolve、两条流事件都进 listener；P2 重复 response 落 listener 不崩不二次 resolve；P3 无在途 pending 的幽灵流事件落 listener。4+3 用例全绿，守卫是通用修复非 bash 特判 |
| A2 | pre-auth 队列（findings#3） | **PASS** | `ws-client.ts`：`connectionAuthed` 模块级真源（gen 检查保留），send 在 OPEN 未 auth 时入队返回 true；容量 256 溢出驱逐最老（overflow 通知）；flush 在 `markConnected` 内按序；**清队五路覆盖**——onclose（'closed'）/ auth reject（'auth-failed'）/ setFailed（'disconnected'）/ disconnect()（'disconnected'，含 setRestarting 复用路径）/ overflow 单条驱逐；`onQueueDrop` 单槽广播 → use-connection 消费方对带 id 消息立即 reject pending（不等 65s sweep）。core transport 测试族实跑：**8 文件 58 passed**（invariants ⑥ 五用例：入队+保序 flush / auth-failed 清队 / 超时 close 清队 / 溢出驱逐+保序 / 已 auth 直发无回归；queue-drop 接线测试：立即 reject / 无 id 跳过 / teardown 注销 / mock 模式也注册）。onmessage gen 检查确认（旧代 WS 回调不写新代 authed） |
| A3 | 断连宽限 + stateWatch 汇合（findings#1） | **PASS** | `use-connection.ts`：stateWatch 单一汇合——restarting/failed 迁移立即 rejectAll + clearDisconnectGrace + onRuntimeUnavailable（IPC 监听器退化为只置态）；connected→非 connected rejectAll + armDisconnectGrace()；到期 `getState() !== 'connected'` 才收口。三个对抗追问逐一核实：①**到期已重连**——用例 2 锁定（半程重连成功后越期不收口）；「到期已重连但回放失败」子场景声明依赖 streaming timer 10min 兜底（注释明示权衡，不误伤重连后在途流）。②**flapping 单窗口**——用例 3 锁定（已 armed 不重置，从首次断连起算；连接恢复不清 timer 是有意设计「累计宽容有界」）。③**teardown 泄漏**——**独立探针**：断连 armed 后 teardown，推进 3×GRACE_MS 无 onRuntimeUnavailable 触发（timer 正确清除）。disconnect-grace 5 用例实跑绿；10s 取值有退避序列论证（1+2+4=7s<10s） |
| A4 | turn working（findings#8） | **PASS（带 1 minor 边界）** | result 投影链三处：`shared/subagent.ts` SubagentRecord 补 `result?` 字段；`subagent-extractor.ts:179` 投影 `result`；`renderer/stores/subagent.ts:117` hasRunning 判据改 `running && result === undefined`。legacy 语义：W16 前旧 entry 无 result 字段 → running 无 result 仍算真在跑（旧扩展无 running-resumable 设计，语义正确）。`isRunning` 刻意不收紧的副作用核实：消费方 3 处——SubagentTab 订阅增量流（设计意图：resumable 续轮仍有流活动）/ **MessageStream forceWorking（虚拟 session，ledger 已记录的 B 残留，见 C 节）** / message-turns redrive。测试：turn-working 28 用例 + useBackgroundWork 3 + extractor-result 3 + session store 15 全绿。**边界发现见问题清单 R2-1**：one-shot 空文本成功轮的轮终 result 保持 undefined，该边界下排除失效 |
| A5 | markDead/revive 薄壳（goal-audit#3） | **PASS** | `store.ts`：markDead → `applySnapshot(id, {status:'dead'})`；revive guard 保留（读判定 `?.status === 'dead'` 才写，非 dead 真态不被本地 revive 覆盖）。`applySnapshot` 对不存在 id `if (!target) return` 静默跳过 = 原 markDead `if (target)` 语义等价；status 无 isScan 守卫走 owner 权威覆盖（mergeViewSnapshot）。session store 测试 15 用例绿（含新增薄壳断言） |
| A6 | taste-lint 三修复（W24 minor） | **PASS** | ①stale 检查前移到 factoryBindings 早退前（不 import store 工厂的文件也检测许可表失真；per-file 重复报告取舍已论证）；②detachedMethodRef 文案补 `docs/architecture/data-source-registry.md` 全路径；③paramOwnerFn 改 `Map<paramName, Set<fnName>>`，裁决 `stack.some(fn => bound.has(fn))`。独立复跑：`node --test` 两规则文件 **38 pass / 0 fail**（含新增两条用例：无 store import 文件的 stale 检测、同名形参双函数均报） |
| A7 | CI 双轨（goal-audit#1 major） | **PASS** | 实跑 `XYZ_SKIP_REAL_PI=1 pnpm exec vitest run src/__tests__/equivalence/`：**5 文件 26 passed + 5 文件 17 skipped**，skip 理由 console.warn 双通道可见（env 短路理由指向 TEST-STRATEGY §4）；describe 名注入理由。`REAL_PI_READY` 探测链（pi binary + env key / auth.json stored / models.json apiKey 三源，`PI_CODING_AGENT_DIR` 同源）——**独立探针**验证本机（有凭证、无 env）`REAL_PI_READY = true` 不误判。ci.yml test-runtime job 显式 `XYZ_SKIP_REAL_PI: '1'`（diff 核实）；python yaml.safe_load 语法校验 OK；TEST-STRATEGY §4 双轨声明落表（何时跑完整基线的触发条件明确）。it2 探针升断言（goal-audit#2 minor）：live ref vs 重开 hydrate 的条数 + role 序列 deep equal + 防 0==0 守卫（≥2 条 + u- 前缀乐观 user 存在）——非恒真 |
| A8 | custom 收敛（goal-audit#4） | **PASS** | 双管线消除：customStart effect 不再独立构造 system 消息，改构造 `PiCustomMessageEntry` 喂 `ctx.applyEntryFrame`（与重开 replayEntries 同一 reducer）；display 覆写（COMPLETE_NOTIFY_CUSTOM_TYPES → false）收敛到 apply-entry `custom_message` case 单点（`shared/message.ts` 注释同步）。**守卫不误伤重放**：重放链 `message-converter.ts:124 replayEntries(liftHistoryToEntries(...))` 直接调 core reducer，不产生 message_end 事件帧、不经 registry handler（grep 生产调用链核实）。守卫必要性：event-adapter `handleMessageEnd` 对所有 role（含 custom）统一翻译 `message.message_end` 发前端，pi 双发（customStart 已喂）→ 不拦即双计。id 一致性：`deriveBaseId = entry.id ?? 'e<N>'`——customStart entry 恒有 cm-uuid，两次 applyEntry 调用（per-session state / 空 state overlay 派生）id 一致；timestamp `toMs(ISO string)` 归一为 number（与旧 Message.timestamp 形态一致）；details/content 窄化在 case 内（isLooseRecord / typeof string）。custom-start-equivalence 6 用例实跑绿（live store ≡ replayEntries deep equal + 红性声明） |

## B. 新问题扫描（修复 diff 逐读）

| 检查点 | 结论 |
|--------|------|
| use-connection 重构面（清理时序） | 无回归。行为差异 2 处均无实害：① IPC 重复崩溃事件（state 无迁移）不再重复清理——原清理幂等，少调无损（observation 记录）；② watch flush 使清理延迟一个微任务 tick——10s 宽限问题域无感 |
| custom 收敛热路径（message_end） | 无回归。守卫丢帧的前提（pi 双发契约）经 pi 源码引用核实；customStart 帧丢失时 message_end 同丢（observation 记录，重开 entry 兜底） |
| ws-client `connectionAuthed` 闭包提升 | 无竞态：connect 新代重置 + onmessage/onclose gen 检查保留；connect 幂等早退（OPEN/CONNECTING）不重置——复用现有连接其 auth 态保持，正确 |
| connection-manager 双口径日志 | `authTimers.set`（:134）在日志行（:126）之后 → `+1` 口径正确；handleClose 的 disconnected 日志仍是旧 `total` 口径（authed 池，语义自洽） |
| one-shot 轮终 result | **发现 R2-1（minor）**，见问题清单 |
| aadc64c11 探测实现 | OAuth 凭证不判定可用（保守 skip 方向，取舍已在注释声明）；探测只读不触碰凭证值 |

## C. 遗留项状态核对

| 项 | 状态 | 判定 |
|----|------|------|
| D3（renameSession else throw + cwd 死路径降级） | **deferred 维持**：6 个修复 commit 均未碰 `session-lifecycle.ts`/`process-manager.ts`（`git show --name-only` 逐个核实，见上禁区声明）。工作区两文件仍为用户在途未提交改动 | 不计入本轮（用户领域，修复范围外） |
| B 残留（subagent 虚拟 session forceWorking） | **与 ledger 记录一致**：`MessageStream.vue:202` forceWorking 走 `subagentStore.isRunning`（刻意不收紧），resumable 轮终 running → 虚拟 session 视图末位 turn streaming 卡住，重开（closed）自愈。ledger 记录「需真实流活动信号，超最小修复点」与实况吻合——isRunning 同时服务订阅增量流，收紧需新信号源 | **minor**（如实报，不因已记录降级）：非修复无效（#8 修复目标 = 主 session 显示，已达成）、非回归（既有行为）、非 G1-G4 目标性缺口；但与主 session 判定语义分叉（running+result 不算 working vs 虚拟 session running 即 streaming）是用户可见的不一致，未闭环 |
| findings#2（error turn 复合因素） | **与 ledger 记录一致**：第 1 轮已判「部分成立、无独立修复点」；其两个确凿缺陷（断连无 streaming 复位兜底 + turn 级指示误用 session 级信号）已分别被 332250876（宽限收口 + finalizeAllStreaming 断连路径，store.test 新增 3 用例含瞬态 Map 候选覆盖）与 90b441fa4 修复；restore-tmp 因素归用户在途 | observation：保持记录态即可，无需动作 |

## D. 全量回归独立复跑

| 项 | 结果 |
|----|------|
| core typecheck / runtime typecheck / renderer typecheck（vue-tsc） | **全部 0 errors** |
| core test | **1024 passed + 6 todo**（与 ledger 最终态一致） |
| renderer test | **3059 passed + 3 skipped**（与 ledger 一致） |
| runtime test（无 env，真实 LLM 等价性用例真跑） | **3142 passed + 32 failed** —— 见下方归因 |
| 根 lint | **0 errors**（461 warnings 为存量基线，exit 0） |

**runtime 32 failed 归因（100% 用户在途未提交改动，非修复 commit 回归）**。证据链：

1. 失败分布：全部 32 个失败落在 restore/fork/session-lifecycle 域（session-lifecycle-attach 8 / session-pool-restoresession 5 / session-lifecycle-w11 3 / session-service-fork-scan-count 3 / contract-hardening 2 / fork-orphan-cleanup 2 / session-lifecycle-gate 2 / session-lifecycle-rename 2 / attach-lifecycle（untracked 用户新测试）2 / session-service 1 / session-lifecycle-preset 整文件 1）。6 个修复 commit 的 `--name-only` 均不含任何失败测试的被测模块。
2. 错误样本 A：`[vitest] No "assertPiSessionFile" export is defined on the "../src/infra/pi/process-manager.js" mock`，调用点 `session-lifecycle.ts:558` —— 该行是用户在途 diff 新增（`git diff` 显示 `+ await assertPiSessionFile(...)`，函数本体也是用户 diff 新增导出）。
3. 错误样本 B：`[attach-mismatch] forkSession(...): pi get_state did not return sessionFile...`，throw 点 `process-manager.ts:188` —— 用户在途新增函数 `assertPiSessionFile` 的主动 throw。
4. 错误样本 C（preset 整文件 Failed Suite）：`No "getSettingsPath" export ... on pi-paths.js mock`，触发点 `pi-settings-store.ts:52` 顶层调用。模块图差异：HEAD 版 session-lifecycle 的 `IProcessManager` 是 **type-only import**（不进运行时模块图）；工作区版新增第 29 行**运行时 import** `assertPiSessionFile from process-manager.js` → 拉进 rpc-client → pi-provider-store → pi-settings-store 链，命中 preset 测试 mock 的缺失导出。rpc-client 的 import 在 `332250876^` 与 HEAD 完全相同（该链非本轮引入）。
5. 修复 commit 域内全部测试绿，含真实 LLM 等价性用例（live-reload / broadcast-getstate / chaos / pi-protocol-contract 均在 3142 passed 中，全量跑未设 skip env）。

---

## 问题清单

### 本轮新发现

| # | 级别 | 描述 | 证据 | 修复方向 |
|---|------|------|------|---------|
| R2-1 | **minor** | one-shot 空文本成功轮的轮终 `result` 保持 undefined → hasRunning 排除在该边界失效，#8 形态（完成注入后主 session 末位 turn 永久「工作中」直到重开）重现。且 `shared/subagent.ts:66-79` 注释声称「轮终迁移写点**恒写非空**」与代码事实矛盾——`finalize-record.ts:203-211` 的第四分支 `nextResult = record.result`（首轮 undefined），该分支被 one-shot 空文本成功完成路径真实触达（注释自认「真实可达」），属错误的运行时行为断言 | `extensions/subagent-workflow/src/execution/finalize-record.ts:203-211`（四分支 + `record.status = "running"` 无条件回写 + reportRecordTransition 序列化 `result: record.result`）；`renderer/stores/subagent.ts:117`（`result === undefined` 判据）；`shared/subagent.ts` 注释 vs 代码矛盾 | 三选一：a) 轮终写点对 one-shot 空文本补占位文本（如 "(no output)"，最小改动）；b) 判据补 `round` 信号（轮终恒写 round+1，shared 补投影，`running && result===undefined && round===undefined` 才算真在跑）；c) 最低限度修正 shared 注释断言并登记该边界。推荐 a（写点收敛，判据不动） |
| R2-2 | observation | message_end role-custom 守卫依赖 pi 双发契约（message_start+message_end 成对）：customStart 帧丢失时 message_end 同被丢，live 侧丢帧；重开（entry 持久化）兜底恢复 | `registry.ts:418-421` 守卫 + pi 源码双发引用（注释内） | 无需动作（契约经源码核实）；若 pi 未来改单发形态需同步守卫 |
| R2-3 | observation | use-connection 汇合后 IPC 重复崩溃事件（state 无迁移）不再重复执行清理——原语义每次事件无条件 rejectAll + onRuntimeUnavailable。清理幂等故无实害，但行为差异未在 commit message 声明（注释只覆盖「任何旧态进入均适用」的迁移侧） | `use-connection.ts` stateWatch watch 语义 vs 原 IPC 监听器无条件执行 | 无需动作；可在注释补一句「重复事件（无迁移）不重复清理」 |
| R2-4 | observation | runtime 全量 32 failed（D 节）——用户在途半成品改动的测试破坏，非本轮引入；在用户提交前 `pnpm --filter @xyz-agent/runtime run test` 持续红，ledger「3179 全绿」口径在用户在途改动落定后需重验 | D 节归因链 5 条 | 用户领域：在途改动完成时同步补 mock（assertPiSessionFile / getSettingsPath）与 attach-lifecycle 测试 |

### 遗留项确认（第 1 轮已记录，本轮复核）

| # | 级别 | 描述 | 判定 |
|---|------|------|------|
| R1-遗留-1 | minor | B 残留：subagent 虚拟 session forceWorking 走未收紧的 isRunning，resumable 轮终后虚拟 session 视图末位 turn streaming 卡住（主 session 已修，虚拟 session 未闭环，ledger 记录一致） | minor 维持；修复需「真实流活动」新信号源，超本轮最小修复点，如实报告不降级 |
| R1-遗留-2 | deferred | D3：renameSession else throw + cwd 死路径降级——用户在途文件，本轮未动，deferred 维持 | 用户领域 |
| R1-遗留-3 | observation | findings#2 error turn 复合因素——两个确凿缺陷已随 332250876/90b441fa4 修复，restore 因素归用户在途 | 记录态闭环 |

---

## 循环判定

- 第 1 轮问题闭环：findings#1/#3/#5/#7/#8 + goal-audit#1/#2/#3/#4 + W24 三 minor + 登记表消歧 → **全部验证修复有效**。
- 本轮 major = 0：无修复无效（A1-A8 全 PASS，含独立探针）、无修复引入回归（B 节逐读 + 全量回归归因）、无 G1-G4 目标性缺口新增。
- minor = 2（R2-1 新发现边界 + R1-遗留-1）：均有界、有修复方向、不阻断目标达成。

**建议：循环终止。** R2-1 建议随下个触及 subagent-workflow 的改动顺手修（写点补占位一行）；R1-遗留-1 待「真实流活动信号」方案（如 record 增量流活跃时间戳）单独立项。

## 方法与边界声明

- 独立探针 3 个临时测试文件（rpc-guard 对抗子场景 3 用例 / REAL_PI_READY 本机真值 / grace teardown 泄漏）全部实跑通过后已删除（`ls` 复核）。
- 全量回归均在本仓工作区实跑；runtime 32 failed 的归因采用只读手段（git show/diff/log + 错误堆栈定位），未 stash、未 checkout、未任何 git 写。
- 真实 LLM 等价性用例在本机凭证下全量真跑（无 skip env），消耗为复审判定所需。
- 本报告为 `.xyz-harness/` 审计产物目录新增文件，是本轮唯一文件写操作。
