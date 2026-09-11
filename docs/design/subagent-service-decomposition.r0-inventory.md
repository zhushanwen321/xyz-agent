# SubagentService 拆分 R0 产出：三清单 + 两条机械对账

R0 实施单元产出（实施依据：[impl-plan](subagent-service-decomposition.impl-plan.md) §2 R0 行 / [设计](subagent-service-decomposition.md) §2.1 + §3.3 D1/D6 + §5）。本文档是 R1-R4 全部抽取单元的实施依据（检查点②）。

- **基线**：HEAD = impl-plan 提交（37a53dbb7 之后的 impl-plan commit）；R0 执行日 2026-09-10（会话时钟 2026-09-12）
- **领地**：`packages/subagent-core/src/execution/subagent-service.ts`（纯移动）+ 本文档（新建）；`execution/__tests__/` 只读零改动 ✓
- **行号口径**：本文全部行号 = **R0 重排后**的 subagent-service.ts（3620 行，类体 :334-:3445）。重排前行号在清单①中对照给出

---

## 0 基线绿核对（G4 前置）

| 项 | 结果 |
|---|---|
| R0 前基线 | `npx vitest run`（subagent-core 全量）：**2903 passed / 4 skipped（2907），195 文件 194 passed + 1 skipped，15.42s**，exit 0 |
| R0 后复跑 | **2903 passed / 4 skipped（2907），15.35s**，exit 0——与基线逐项一致，零断言变化 |
| workflow-state-root.test.ts GC 写回用例 | **未复现红**（本次全量绿，GC 写回用例含在内）。定性归档：2026-09-11 单次红 + 本次复跑绿 = 疑似环境相关偶发（与 impl-plan 记录一致），不构成基线红豁免项；若后续复现，按「单日 3 次」口径定性并记录复现条件。R0 未做任何修复（环境定性归档，不修复）✓ |
| tsc --noEmit | 零错误 |
| eslint（单文件） | 0 error / 1 warning（max-lines 1842/1700，与 impl-plan 残留风险⑤基线值**完全一致**——折算行 skipComments/skipBlankLines 下新增注释与空行不计入，纯移动未改变折算行） |

---

## 1 分区整理结果（纯移动零抽取）

类体成员按域归属重排为 **18 个分区**（分区注释 `// ── …（R0 重排）──` 风格，位置见 grep 输出）：

| 序 | 分区（注释头） | 行区间 | 域 / 目标聚合 |
|---|---|---|---|
| 1 | 域 #1 依赖装配（壳组合根；R1-R4 抽取后留壳） | :336-:478 | #1 → 壳 |
| 2 | 对外聚合面（域 #0，壳终态保留 D3） | :479-:507 | #0 → 壳保留 |
| 3 | 域 #2 session 注入 + ALS/嵌套身份基线（R1 SessionBaselines） | :508-:684 | #2 → R1 |
| 4 | 域 #5 sync 批（R2 SyncCollectDomain） | :685-:974 | #5 → R2 |
| 5 | 域 #3 孤儿/manifest 恢复（R3 RecordLifecycle） | :975-:1097 | #3 → R3 |
| 6 | 域 #4 回收面（R3 RecordLifecycle） | :1098-:1236 | #4 → R3 |
| 7 | 域 #13 身份解析/record 创建（R3 RecordLifecycle） | :1237-:1397 | #13 → R3 |
| 8 | 域 #8 查询面（R3 RecordLifecycle） | :1398-:1461 | #8 → R3 |
| 9 | 域 #10 action 网关（R3 RecordLifecycle） | :1462-:1535 | #10 → R3 |
| 10 | 域 #11 close 三路（R3 RecordLifecycle） | :1536-:1653 | #11 → R3 |
| 11 | 域 #17 取消（R3 RecordLifecycle） | :1654-:1746 | #17 → R3 |
| 12 | 域 #18 finalize 簇（R3 RecordLifecycle，H4 落点 D5） | :1747-:1807 | #18 → R3 |
| 13 | 域 #6 model 解析（R4 RunOrchestration） | :1808-:1822 | #6 → R4 |
| 14 | 域 #7 run 域执行入口（R4 RunOrchestration） | :1823-:1893 | #7 → R4 |
| 15 | 域 #12 await 入口（R4 RunOrchestration） | :1894-:2006 | #12 → R4 |
| 16 | 域 #14 引擎编排（R4 RunOrchestration；含 H2 workflow 族 + Continuation 协作面） | :2007-:3245 | #14 → R4 |
| 17 | 域 #15 pool/worktree 资源（R4 RunOrchestration） | :3246-:3290 | #15 → R4 |
| 18 | 壳生命周期编排与断言（dispose 时序留壳 = R3 检查点③；D4 断言面） | :3291-:3445 | 壳 |

域 #9/#16（H1 后消亡）与 #14 增项（H2 workflow 族）按 impl-plan 预期处理；类外部分（imports/接口/模块常量 :1-:333 与类外 workflow helper/单例访问器 :3446-:3620）未动（R6 领地）。

### 纯移动自证（三重机械验证）

1. **重排脚本断言**：113 个成员块逐块首行锚点断言通过；覆盖完整性断言通过（块行 ∪ 空行 ∪ 删除横幅行 = 类体全部行，无遗漏无重叠）；非空行多重集守恒断言通过。
2. **独立复核（git 层面）**：剔除横幅/分区注释行后，新旧文件非空行多重集 md5 一致——
   ```bash
   diff <(git show HEAD:packages/subagent-core/src/execution/subagent-service.ts | grep -v '^\s*$' | grep -vE '^\s*// ── ' | sort | md5) \
        <(grep -v '^\s*$' packages/subagent-core/src/execution/subagent-service.ts | grep -vE '^\s*// ── ' | sort | md5)
   # → MULTISET-IDENTICAL
   ```
3. **删增行清单（全部为注释行）**：
   - 删除 11 行 = 旧分区横幅注释（被新域分区注释取代，同一意图）：`:610 生命周期（index.ts 调）` / `:1325 执行（subagent-tool 调）` / `:1455 对话模式投递（M2-B3 message action 调用）` / `:1482 对话模式 message/close action 支持（M2-B3）` / `:1698 编排层专用接口（workflow 消费）` / `:2033 状态查询（TUI 调）` / `:2080 执行内部：身份解析 + record 创建` / `:2241 引擎分支（D4/D10…U0）` / `:2596 执行内部：run + finalize（workflow 域 sync 面…）` / `:3065 [H1 U2] ConversationContinuation 装配与 host 面` / `:3359 内部`（行号 = 重排前）
   - 新增 18 行 = 上表 18 条域分区注释；另有意格式性空行调整（块间分隔统一）
   - **方法体/签名/修饰符/字符串/日志文案零改动**（多重集守恒的构造性推论）；`git diff --stat` = 3138 行变更（1586+/1554-），其中内容行全部为移位

---

## 2 清单① 实例字段逐个归属表

**字段口径（重收敛）**：impl-plan 残留风险①的「字段声明 17」为不可复跑的粗口径（实测尝试多种 grep 均无法数出 17，见 §5 偏差 B-3）；R0 重收敛口径 = **类体字段声明全集 34 个**（含 queries/chatActions 聚合面 2 个 readonly、含内联初始化字段、含构造器后散落的 stopIdleGc）。构造器内 `this.*` 赋值 = **12 处**（与 impl-plan 一致）。

### 2.1 字段归属（34 个）

| # | 字段 | 重排后 | 重排前 | 归属域 | 目标聚合 | 备注 |
|---|------|-------|--------|--------|---------|------|
| 1 | pool | :338 | :334 | #1 | 壳 | 构造器赋值 |
| 2 | store | :339 | :335 | #1 | 壳 | 构造器赋值；跨域共享（#2 setPi/revive、#3、#5、#8、#10、#18） |
| 3 | modelService | :340 | :336 | #1 | 壳 | 构造器赋值 |
| 4 | cwd | :341 | :337 | #1 | 壳 | 构造器赋值 |
| 5 | worktreeManager | :342 | :338 | #1 | 壳 | 构造器赋值；消费方 #4/#11/#17/#18/#12/#14 |
| 6 | getMainSessionFile | :343 | :339 | #1 | 壳 | 构造器赋值；进程级注入，initSession 透传 |
| 7 | notifyHost | :351 | :394 | #1 | 壳 | 内联 createNotifyHost；通知面本体已外置 notify-host.ts；跨域消费（#5 flushBatch/E9、#11 closeChatIdle、#17 cancel、#18 finalize、watchdog 通知） |
| 8 | manifestStore | :357 | :492 | #1 | 壳 | 构造器赋值；跨域消费（#3 恢复、#5 manifest 屏障、#17、#18 finalize） |
| 9 | recordsDir | :363 | :498 | #1 | 壳 | 构造器赋值；#5 屏障 warn 路径文案消费 |
| 10 | sessionsDir | :370 | :505 | #1 | 壳 | 构造器赋值；#18 finalize deps 消费 |
| 11 | queries | :483 | :467 | #0 | 壳保留（D3） | 聚合面投影（消费方 23+ 处） |
| 12 | chatActions | :502 | :486 | #0 | 壳保留（D3） | 聚合面投影 |
| 13 | uiRequestHandler | :511 | :341 | #2 | R1 | 构造器赋值；dispose 置 stub（跨聚合写边 C-3） |
| 14 | dialogQueue | :515 | :344 | #2 | R1 | |
| 15 | uiObservability | :518 | :346 | #2 | R1 | 偏差 B-4：impl-plan R1 字段清单未列 |
| 16 | pi | :520 | :347 | #2 | R1 | initSession 注入（late-bound，D4 getter 注入形态的依赖源） |
| 17 | sessionId | :523 | :349 | #2 | R1 | |
| 18 | mainSessionFile | :526 | :351 | #2 | R1 | |
| 19 | sessionRootId | :533 | :357 | #2 | R1 | |
| 20 | execNesting | :549 | :372 | #2 | R1 | 偏差 B-4：R1 清单未列（嵌套身份基线） |
| 21 | forkDepthBaseline | :552 | :374 | #2 | R1 | |
| 22 | rootCwd | :558 | :379 | #2 | R1 | |
| 23 | streamSink | :561 | :381 | #2 | R1 | getter getStreamSink = D3+ 壳保留消费点 |
| 24 | isIdleFn | :565 | :384 | #2 | R1 | |
| 25 | forkDepthAls | :572 | :419 | #2 | R1 | 偏差 B-4：R1 清单未列（fork 深度 ALS） |
| 26 | collectCoordinator | :688 | :401 | #5 | R2 | 构造器赋值；装配闭包依赖 notifyHost/e9ConvertedIds/store |
| 27 | e9ConvertedIds | :695 | :407 | #5 | R2 | E9 防御过滤集 |
| 28 | settledRescanState | :703 | :414 | #5 | R2 | 跨聚合写边 C-2/C-1（initSession 直写 null / dispose 直改 .disposed） |
| 29 | stopIdleGc | :1217 | :956 | #4 | R3 | GC timer stop 句柄 |
| 30 | coldLookupDeps | :1466 | :440 | #10 | R3 | 唯一消费方 = getRecordForAction 冷查分支 |
| 31 | continuations | :2019 | :436 | #14 协作面 | R4 | Continuation 实例表（设计 §3.1「归 RunOrchestration 协作面」）；终态清理点 onRecordFinalizedCleanup 被 #4/#11/#17/#18 调用（跨域汇聚点 C-5） |
| 32 | roundSupervisor | :2028 | :457 | #14 协作面 | R4 | 偏差 B-6（归属争议登记）：noteRun*/adopt 消费在 #14，bootPartition（initSession）/dispose（壳时序）消费在壳；R4 抽取时若撕扯可评估留壳 |
| 33 | _disposed | :3293 | :386 | 壳 | 留壳 | assertReady（D4 断言面）/initSession 复活/dispose 消费 |
| 34 | _seq | :3294 | :387 | 壳 | 留壳 | **死字段**：全文件零消费（grep `_seq` 仅声明行）；建议 R1+ 单元顺手删除（R0 纯移动不删，偏差 B-7 登记） |

### 2.2 构造器内 this.* 赋值归属（12 处，重排后构造器 :372-:480）

| # | 赋值 | 重排后行 | 归属域 | 目标聚合 |
|---|------|---------|--------|---------|
| 1 | `this.cwd` | :373 | #1 | 壳 |
| 2 | `this.modelService` | :374 | #1 | 壳 |
| 3 | `this.getMainSessionFile` | :375 | #1 | 壳 |
| 4 | `this.uiRequestHandler` | :376 | #2 | R1 |
| 5 | `this.pool` | :380 | #1 | 壳 |
| 6 | `this.worktreeManager` | :381 | #1 | 壳 |
| 7 | `this.rootCwd` | :388 | #2 | R1 |
| 8 | `this.sessionsDir` | :391 | #1 | 壳 |
| 9 | `this.recordsDir` | :392 | #1 | 壳 |
| 10 | `this.manifestStore` | :393 | #1 | 壳 |
| 11 | `this.store` | :394 | #1 | 壳 |
| 12 | `this.collectCoordinator` | :408 | #5 | R2 |

赋值归属跟字段走（D1 第一级「首个系统性写它的域所属」——构造器是装配点，字段运行时写点见各字段行备注）。R1 抽取时构造器内的 #2 赋值（uiRequestHandler/rootCwd）与 R2 的 #5 赋值（collectCoordinator）需随聚合迁移或经 Init 参数下沉，实施形态 R1/R2 自定。

### 2.3 已知跨聚合边（后续单元收敛义务）

| # | 边 | 位置（重排后） | 收敛归属 |
|---|---|---|---|
| C-1 | **壳 dispose 直改 SyncCollect 内部态 `settledRescanState.disposed`**（impl-plan R0 行点名项） | dispose 内（壳生命周期区） | R2 兑现：收敛为显式接口（如 `syncCollect.lazyDispose()`） |
| C-2 | initSession（#2）直写 `this.settledRescanState = null`（#5 字段） | initSession 内 | R1×R2 交界：R1 抽取 initSession 后写 #5 内部态——与 C-1 同接口收敛，或 R2 提供重置方法 |
| C-3 | dispose（壳）直写 `this.uiRequestHandler = disposedUiRequestStub`（#2 字段）+ 直调 `uiObservability.resetMissingHandlerWarnings()` | dispose 内 | R1：SessionBaselines 暴露 stub 化方法（如 `disposeSessionUi()`），dispose 编排改调用 |
| C-4 | dispose（壳）直调 `this.continuations.clear()`（#14 Continuation 状态） | dispose 内 | R4：Continuation 协作面暴露 clear 方法 |
| C-5 | `onRecordFinalizedCleanup`（#14 Continuation 域方法）被 #4 disposeAllRecords / #11 closeChatIdle / #17 cancelBackground / #18 finalizeRecord（经 doFinalizeRecord onFinalized 钩子）调用 | :3162 起（#14 区） | R3/R4 交界：跨域汇聚点，抽取后经壳编排或显式接口；R3 抽取 finalize 簇时保留回调注入形态（现状 doFinalizeRecord deps.onFinalized 已是显式注入，天然兼容） |
| C-6 | `roundSupervisor` 装配闭包 `finalizeClosed` 调 `this.finalizeRecord`（#18 域方法） | :2028 装配处 | R4：闭包经壳 late-bound 读取或显式注入 finalize 委托（现状 deps 惰性闭包形态天然兼容聚合化） |
| C-7 | `notifyHost` 装配闭包读 `this.pi`/`this.store`/`this.isIdleFn`（#2+#1 字段） | :351 装配处 | R1：闭包惰性求值经 this 读取，聚合化后仍读壳 getter（D4 late-bound 形态），天然兼容 |

---

## 3 清单② record 字段写点通道边界表（D1 第二级）

**通道分类**（D1 v3）：**A = 直写共享 record 对象**（内存态赋值，不经 store 方法）/ **B = store 写**（register/archive/reportRecordTransition/reportSubagentRecord/revive 等）/ **C = 模块函数写**（execution-record.ts 的 tryTransition/completeRecord/createRecord——壳直调共享底层）/ **D = E1 重建投影**（sync-rebuild.ts 模块函数 + manifest 反查索引投影）/ **E = sidecar 落盘**（state-marker / finalize-record 的磁盘标记，非内存 record 写）。

**SyncCollect（#5/R2）直调 store 的通道已显式标出，不得改道 RecordLifecycle（D1 v3 约束）**。

### 3.1 直写赋值写点（16 行 = 机械对账②口径）

| # | 写点方法（域分区） | 赋值行（重排后） | record 字段 | 通道 |
|---|---|---|---|---|
| 1 | promoteSessionFileFromEngineHandle（#4） | :1213 | sessionFile | A（终态化锚点提升；消费方 disposeAllRecords/cancelBackground） |
| 2 | closeSubagent（#11） | :1577 | closeAfterRound = true | A |
| 3 | executeAndAwait（#12） | :1949 | worktreeHandle | A |
| 4 | runWorkflowEngineTask（#14） | :2292 | engineHandle（创建期回填） | A |
| 5 | executeViaEngine（#14） | :2397 | worktreeHandle | A |
| 6 | runEngineTask·backfillEngineHandle（#14） | :2514 | engineHandle（运行中初建回填） | A（并随 B：reportRecordTransition 落 entry） |
| 7 | runEngineTask·backfillEngineHandle（#14） | :2533 | engineHandle（补缺合并） | A（同上随 B） |
| 8 | runEngineTask（#14） | :2576 | engineHandle（终态权威回填） | A |
| 9 | adoptResumableAfterEngineDeath（#14） | :2623 | error | A（并随 B：reportRecordTransition） |
| 10 | adoptResumableAfterEngineDeath（#14） | :2624 | result = undefined | A（同上） |
| 11 | adoptResumableAfterEngineDeath（#14） | :2625 | resumable = true | A（同上） |
| 12 | finalizeEngineOutcome（#14） | :2643 | sessionFile | A（并随 E：writeBindingForRecord） |
| 13 | runAndFinalize（#14） | :2713 | engineHandle | A |
| 14 | outcomeToAgentResult（#14） | :2794 | sessionFile | A（并随 E：writeBindingForRecord） |
| 15 | consumeCloseAfterRound（#14） | :2816 | closeAfterRound = undefined | A |
| 16 | kickOffChatRound（#14） | :2955 | sessionFile | A（并随 E：writeBindingForRecord） |

### 3.2 间接写点通道（不经赋值语句，按通道声明）

| 写点 | 域分区 | record 字段面 | 通道 |
|---|---|---|---|
| createRecordForMode → createRecord + store.register（:1237 区） | #13 | 全字段（创建期一次性） | C + B |
| tryTransition / completeRecord 调用点（disposeAllRecords #4 / closeChatIdle #11 / cancelBackground #17 / settleOneShotOutcome·finalizeFailed·finalizeAborted·onOneShotSettledWatchdogTimeout #14/#18） | #4/#11/#17/#14/#18 | status/closedReason/result/turnCount/endedAt | C（execution-record.ts 模块函数，壳直调共享底层） |
| store.archive 调用点（disposeAllRecords #4 / cancelBackground #17 / doFinalizeRecord 经 #18） | #4/#17/#18 | 内存表移除（终态归档） | B |
| store.reportRecordTransition 调用点（backfillEngineHandle #14 / adopt #14 / Continuation revive 闭包 continuationFor #14 / rematerialize 无） | #14 | entry 落盘投影（live→reload 同步） | B |
| **appendBatchFinalizedEntry → store.reportSubagentRecord**（:685 区） | **#5（R2）** | collectMode/batchFinalized 落标 | **B·SyncCollect 直调 store（落标通道）——不得标归 RecordLifecycle（D1 v3）** |
| E1 重建快照（runSyncCollectRecoveryScan → syncRebuildToNotifyMember / bufferedMemberFallbackRecord，sync-rebuild.ts） | #5 | 重建快照（通知成员投影，非内存 record 写） | D·E1 重建投影 |
| manifest 反查索引（writeBatchMemberManifest / writeSyncBatchManifestBarrier #5；rematerializeReconnectableEntryManifests #3；writeManifestBestEffort 调用点 #4/#17/#18） | #5/#3/#4/#17/#18 | manifest 文件（反查索引投影） | D·manifest 投影写（best-effort） |
| sidecar 落盘（writeRecordBinding #14 / updateRecordBinding·writeCancelledState #17 / writeFinalizedState 经 doFinalizeRecord #18） | #14/#17/#18 | 磁盘绑定/终态标记（非内存 record） | E |

### 3.3 通道边界结论（R1-R4 实施约束）

1. **A 通道（16 处直写）**：H3 零行为变化下**不收口**（H4 写原语落点）；R4 抽取 RunOrchestration 时 12 处随迁（#14 区），R3 迁 1 处（promoteSessionFileFromEngineHandle），R2/R1 零直写。
2. **#5 SyncCollect 的 store 直调通道**（appendBatchFinalizedEntry → reportSubagentRecord、scanLastRecordEntries 读）保持原样随 R2 迁移，**不得改道 RecordLifecycle**。
3. record 对象仍是跨聚合共享可变对象（D1 两级归属的第二级现状）；聚合间经壳共享 record 引用，字段级写点分布即上表——R3「store 与终态迁移入口的唯一宿主」= store 入口 + 终态迁移语义宿主，**非唯一访问者**。

---

## 4 清单③ 深绑测试全集（D6）

**grep 口径**：`grep -rn "as unknown as\|ServiceInternals" packages/subagent-core/src/execution/__tests__/` → **28 文件 / 87 处命中**（与 impl-plan 残留风险⑥一致）。逐文件定性：**13 文件真深绑 / 15 文件断言转型等非深绑**。

改写形态三分类（D6 口径）：**SI** = ServiceInternals 内部访问（重定义路径）/ **FR** = 运行时字段替换（依赖「闭包经 this 读取」语义）/ **SP** = spyOn 内部方法或 bracket 调私有方法。

### 4.1 真深绑文件（12 个）

| 文件 | 命中 | 深绑形态 | 深绑目标（域 → 抽取单元） | 改写形态预判 |
|---|---|---|---|---|
| collect-coordinator-service.test.ts | 3 | **FR**（:73 替换 notifyHost）+ 读 modelService（:201） | notifyHost（#1 留壳）+ collectCoordinator 闭包（#5 → R2） | notifyHost 替换在 R2 后失效（flushBatch 闭包随聚合持引用）→ 改「构造参数注入 mock」（检查点① flushBatch 显式依赖注入的连带面） |
| collect-mixed-dispatch.test.ts | 2 | **FR**（:73 替换 notifyHost） | 同上 | 同上 |
| sync-collect-recovery.test.ts | 7 | **FR**（:182 替换 notifyHost）+ 读 store（:382/:1023/:1095）+ **SP**（:474 spyOn internal.manifestStore.writeManifest）+ 读 modelService（:626） | #5 全域（→ R2）+ manifestStore（#1 留壳） | R2 改写主力文件：notifyHost 注入化 + ServiceInternals 重定义（store 路径随 R2 聚合实例）+ manifestStore spyOn 路径不变（留壳） |
| subagent-service-notify-gate.test.ts | 5 | **SI**（:77/:186 读 store）+ **SP**（:111/:145 bracket 调私有方法） | store（#1 留壳字段）+ 私有方法（#5/#14） | ServiceInternals 重定义；bracket 私有方法路径随 R2/R4 聚合实例 |
| dispose-manifest-recovery.test.ts | 5 | **SI**（store.register 直写 ×4） | store（→ R3 RecordLifecycle 域测试面） | ServiceInternals 重定义（store 路径随 R3） |
| subagent-service-recovery-bounds.test.ts | 5 | **SI**（:93 读 store）+ **SP**（:99 callPrivate bracket 调私有方法） | #5 E1/settled 重扫域（→ R2） | ServiceInternals 重定义 + callPrivate 路径随 R2 聚合实例 |
| subagent-service-multiproc-guard.test.ts | 3 | **SI**（:59/:74 读 store）；:51 mock 转型非深绑 | store（→ R3） | ServiceInternals 重定义 |
| subagent-service-parent-guard.test.ts | 4 | **SI**（:88/:98 internals 全量访问） | store + execNesting 基线（#2 → R1） | ServiceInternals 重定义（路径随 R1 聚合 + 壳 store） |
| conversation-continuation.test.ts | 13 | **SI**（:632/:1237 读 store）+ **SP**（:683 读 collectCoordinator 并 spyOn route；:880 bracket 调私有 settleOneShotOutcome；:951 直调 roundSupervisor.adoptOnProcessDeath）+ 读 continuations（:826）；6 处 mock 转型非深绑 | 跨域最广：store（R3）+ collectCoordinator（R2）+ settleOneShotOutcome/roundSupervisor/continuations（R4） | R2/R3/R4 各步分别声明：spyOn 路径随聚合实例；bracket 私有方法改聚合面调用或 ServiceInternals 重定义；roundSupervisor 路径随其归属（B-6） |
| get-record-for-action-restart.test.ts | 2 | **SI**（:150 读 store） | #10/#8 域（→ R3） | ServiceInternals 重定义 |
| delivery-methods.test.ts | 1 | **SI**（:253 读 continuations Map 断言 pendingCount） | #14 Continuation 协作面（→ R4） | ServiceInternals 重定义（continuations 路径随 R4 聚合实例） |
| record-binding.test.ts | 5 | **SI**（:516 读 store）；:335/:338 故意类型错误、:470 mock 转型非深绑 | store（→ R3） | ServiceInternals 重定义 |
| gc-timer.test.ts | 2 | **SI**（:102 读 store） | #4 GC timer 域（→ R3） | ServiceInternals 重定义 |

### 4.2 非深绑文件（15 个，无需改写）

| 文件 | 命中 | 定性 |
|---|---|---|
| record-store.test.ts | 3 | ManifestStore/ManifestRecord mock 断言转型（record-store 自有测试，非 service 内部） |
| workflow-agent-dispatch.test.ts | 2 | PiLike mock 断言转型 |
| channel-registry-handshake.test.ts | 2 | 故意类型错误测试（channel 域，与 service 无关） |
| worktree-manager.test.ts | 1 | execFile mock 转型 |
| subagent-actions-core.test.ts | 1 | fake SubagentService 外部注入（actions 层黑盒测试） |
| execution-record.test.ts | 2 | record DTO 字段断言（execution-record 自有测试） |
| workflow-state-root.test.ts | 1 | PiLike 转型（workflow-state-root 自有测试） |
| subprocess-agent-runner.test.ts | 1 | fake service 构造转型（SAR 黑盒测试） |
| ui-request-handler-factory.test.ts | 3 | ExtensionContext mock 转型 |
| chat-engine-routing.test.ts | 1 | FakeProc as ChildProcess |
| agent-result-mapper.test.ts | 1 | DTO 转型 |
| explicit-agent-ref-guard.test.ts | 1 | PiLike mock 转型 |
| helpers/mock-extension-api.ts | 2 | Proxy mock 构造（公共 helper，非测试本体） |
| start-collect-guard.test.ts | 2 | fake service 注入（start handler 黑盒测试） |
| finalize-record.test.ts | 3 | doFinalizeRecord deps mock 转型（finalize-record 独立模块自有测试） |

> **终版计数：真深绑 13 文件（SI 9 / FR 3 / SP 混合 4，部分文件多形态）/ 非深绑 15 文件。**R1-R4 每步按本表逐文件声明改写形态，断言强度不降（S4 判据）；R5 归位时以本表为迁移依据并复核。

---

## 5 两条机械对账（验收硬门）

### 对账① 清单①行数 vs 类字段声明 grep 计数

```bash
# 字段声明口径（类体 :334-:3445，private/readonly 可选双前缀 + 名字后直接类型注解或初始化等号）
awk 'NR>=334 && NR<=3445' packages/subagent-core/src/execution/subagent-service.ts \
  | grep -cE '^  (private )?(readonly )?[a-zA-Z_][a-zA-Z0-9_]* *[:=]'
# → 34
```

```bash
# 构造器 this.* 赋值口径（构造器 :372-:480，四空格缩进直赋值）
awk 'NR>=372 && NR<=480' packages/subagent-core/src/execution/subagent-service.ts \
  | grep -cE '^    this\.[a-zA-Z_][a-zA-Z0-9_]* *='
# → 12
```

**结果：字段表 34 行 == grep 34 ✓；构造器赋值表 12 行 == grep 12 ✓。**

### 对账② 写点通道表 vs record 字段赋值 grep 计数

```bash
# record 直写赋值口径（行首缩进 + record.<字段> = 赋值；注释行因行首为 // 天然排除）
grep -cE '^[[:space:]]*record\.[a-zA-Z_]+ *= ' packages/subagent-core/src/execution/subagent-service.ts
# → 16
```

**结果：§3.1 直写赋值写点表 16 行 == grep 16 ✓**（§3.2 间接通道为按通道聚合的声明行，不在本口径内——口径边界已写明）。

> 注：类体行区间 :334-:3445 与构造器区间 :372-:480 为 R0 重排后值，R1-R4 每步抽取后区间会漂移，对账命令须随单元重锚定（grep 锚定符号，禁止沿用旧行号）。

---

## 6 与设计域表 / impl-plan 不符的归属偏差登记

| # | 偏差 | 处置 |
|---|---|---|
| B-1 | 设计 §2.1 域表 #11 close 三路含「chat 分路 H1 后消亡」，但 deliverChatMessage（chat 投递面 H1 后收窄为 Continuation 转发）仍存活且域表未归属 | R0 判归 #14 Continuation 协作面区（设计 §3.1「H1 已立的 ConversationContinuation 归 RunOrchestration 协作面」同判） |
| B-2 | 设计 §2.1 把 finalizeRoundToIdle 物理归 #18 finalize 簇；impl-plan R4 明确「settleOneShotOutcome（含 finalizeRoundToIdle wrapper）」归 RunOrchestration | 按 impl-plan 归 #14 区（两文档冲突以单元表为准） |
| B-3 | impl-plan「字段声明 17（含 queries/chatActions 2 个 readonly）」口径不可复现（实测自然子集均 ≠ 17：无内联初始化字段恰 17 但不含 queries/chatActions；全集 34） | R0 重收敛（残留风险①授权）：统一口径 = 类体字段声明全集 **34**，机械对账①以 34 为准 |
| B-4 | impl-plan R1 字段清单 10 个（pi/sessionId/mainSessionFile/sessionRootId/forkDepthBaseline/rootCwd/streamSink/isIdleFn/dialogQueue/uiRequestHandler）漏列 uiObservability/execNesting/forkDepthAls | R0 判归 #2（会话基线族语义），R1 实施以本清单为准（impl-plan R1 验收条款「归属以 R0 ①清单为准」已授权） |
| B-5 | 设计域表未列的 helper 成员归属：writeBindingForRecord（消费方全在 #14 → 归 #14）、promoteSessionFileFromEngineHandle（#4/#17 共用 → 归 #4）、consumeCloseAfterRound（settleOneShotOutcome 唯一消费 → 归 #14）、collectSyncSection（#5 与 getCollectSyncDefault 共用读点 → 归 #5） | 按唯一/主要消费方归属，已落分区 |
| B-6 | roundSupervisor 归属争议：主要消费 #14（noteRun*/adoptOnProcessDeath），但 bootPartition（initSession）/dispose（壳时序）消费在壳；两文档单元表均未显式分配 | R0 暂归 #14 协作面分区；R4 抽取时若字段撕扯可评估留壳（设计 §3.4 风险 2 的 owner: pending 形态），争议不超阈值不触发边界重审 |
| B-7 | `_seq` 为零消费死字段（全文件仅声明行） | R0 纯移动不删；建议 R1+ 单元顺手删除并跑全量（登记待清理） |
| B-8 | 旧分区横幅注释 11 行被新域分区注释取代（删除行全部为注释，内容注释零删改） | 纯移动自证 §1 第 3 条已列全量删增清单；`// ── 执行内部…` 等横幅语义由域分区注释 + 方法级 JSDoc 承接 |

---

## 7 R0 改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/subagent-core/src/execution/subagent-service.ts` | 类体分区重排（纯移动 + 18 分区注释，删 11 旧横幅注释） |
| `docs/design/subagent-service-decomposition.r0-inventory.md` | 新建（本文档） |

领地外零改动。工作区既有认知外改动 `M docs/design/timeout-zcode-turn-and-settled-watchdog.md`（impl-plan 残留风险⑧登记项）本单元未触碰、不提交、不撤销。
