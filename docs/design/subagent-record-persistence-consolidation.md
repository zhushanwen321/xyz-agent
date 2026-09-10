# record 持久化收敛（单一写入口 + 同步写权威）

> **层声明**：技术方案层设计——当前层 = 存储模型与写入口契约，下一层 = 可实施的迁移 PR 单元（§5）。
> **前置依赖**：H1（chat 域统一）→ H2（workflow record 归位）→ H3（service 拆分）依次落地后最后收口——前三者重塑 record 的形状与消费面，本设计在其稳定后统一持久化。
> **基线**：含 L4 已实施形态（`execution/state-marker.ts`：`.finalized`/`.cancelled` 合并 `.state`，读侧兼容旧名，`.alive` 不并入——L4 设计时在途，以落地版为准）。
>
> **一句话结论**：RecordStore 成为 record 状态的**唯一写入口**（意图级操作 API），终态以 `.state` **同步写**为权威；session.jsonl entry 降为过程记录（best-effort）、索引降为可丢缓存；写面从 9 处收口为 1 处；`.alive` 写面随 H1 消亡退役（v4 证伪「子进程自写」前提——全仓唯一写者是 cold-resurrect 宿主自写，见 D3）；崩溃窗口语义从「散在各调用方」收为「store 内单点论证一次」。

---

## 1. 背景目标

### 1.1 SCQA

- **S**：一个 subagent record 的状态今天写在多处：session.jsonl 的 `subagent-record` custom entry（主记录，随 pi 的 debounce flush 落盘）、终态 sidecar（L4 后为 `.state`）、`.alive`（pid 探活）、manifest `records/<sa-id>.json`（反查索引）、sessions-index.json（缓存）、主 session 文件的 batchFinalized 覆写、notify-ledger 三类 entry、workflow run state 文件（H2 后其子代理 record 入 store，run 级状态仍在 FileRunStore）。
- **C**：「该写哪几个文件」的知识散落在每个调用方——`finalize-record.ts` 自己凑齐 `.state` + entry + manifest + archive 四件套；`subagent-service` 直接写 batchFinalized entry 与 manifest；每处写面各自处理崩溃窗口（flush 丢终写 / abort 截断 / 批一致性），一致性 bug 要跨多处排查。
- **Q**：如何让 record 状态的真相与写入只有一处？
- **A**：RecordStore 暴露意图级操作（调用方说「发生了什么」，不说「写哪个文件」），所有文件布局知识收进 store 内部；终态走同步写权威。

### 1.2 系统是什么（受众认知铺垫）

RecordStore（`execution/record-store.ts`，1466 行）已是 record 的统一容器：内存持有 running、终态从 session.jsonl 重建、两级读写（light 头 + 全量懒加载）。本设计不是新建模块，而是把它从「容器 + 部分写面」升级为「唯一写入口 + 权威分层」。H3 拆分后其 RecordLifecycle 聚合是消费侧，本设计落在 store 自身接口。

### 1.3 设计目标

- **G1 唯一写入口**：store 外零直写（白名单 = store 内部实现；`.alive` 写面随 H1 消亡退役——D3）。
- **G2 真相分层明确**：终态 = `.state` 同步写（崩溃即持久）；过程 = session.jsonl entry（best-effort，可丢可重建）；缓存 = manifest/sessions-index（可丢可重建）。
- **G3 崩溃窗口单点论证**：每个崩溃形态（flush 丢终写 / abort 截断 / 探活 / 批一致 / 通知存在性）只在 store 内论证一次，调用方无感知。
- **G4 调用方零文件布局知识**：调用方只调意图操作；测试从「拼文件名断言」转为「断言 store 接口语义」。

### 1.4 in / out scope

**in**：store 意图级 API 立面；终态同步写权威；各写点迁移；缓存降级与重建；恢复路径归并；测试面切换。
**out**：pi session 文件本身（pi 子进程写的任务记录，不动）；notify-ledger 的投递账（存在性判定改挂权威，投递/回执机制不动）；WorkflowRun/FileRunStore（run 级状态）；zcode 会话库（C-ext-20 不动）。

---

## 2. 现状与问题分析

### 2.1 写面清单（现状 9 处活跃写面；H1/H2 落地后 pump 游离 record 消亡）

| # | 位置 | 写什么 | 为什么存在（崩溃窗口） | 终态归属 |
|---|------|--------|----------------------|---------|
| 1 | session.jsonl `subagent-record` entry | record 主记录（创建/终态/变迁） | 主记录本体；随 pi debounce flush，暴毙丢尾 | 降为**过程记录**（best-effort） |
| 2 | `.state` sidecar（L4 后） | 终态二态 + reason | 补 #1 丢终写的洞（同步写） | **升为终态权威** |
| 3 | `.alive` | pid marker（**全仓唯一写者 = cold-resurrect 宿主自写，`cold-resurrect.ts:152`——「子进程自写」前提经 v4 源码核实证伪**） | 宿主重启后探活 | **随 H1 消亡退役**（D3：U6 删唯一写者后零写者；探活读面退役清单归 P4；存量残留 boot 清理；删除动作归口 store 内部非豁免对象） |
| 4 | manifest `records/<sa-id>.json` | 反查索引 + 第三套状态词汇 | GUI 列表快速路径 | 降为**缓存**（可重建） |
| 5 | sessions-index.json | identity 探测缓存 | 性能 | 降为**缓存** |
| 6 | 主 session 文件 batchFinalized 覆写 | sync 批成员终态 | 批通知一致性 | 并入 `markBatchFinalized` 意图操作 |
| 7 | notify-ledger 三类 entry | 通知存在性（防重放） | 「不通知」事故族修复 | 存在性判定改读权威；entry 保留为投递账 |
| 8 | workflow run state（FileRunStore） | workflow run 级状态 | workflow 崩溃恢复 | **不动**（run 级 ≠ record 级；H2 后子代理 record 已入 store） |
| 10 | pending:register/unregister entry（v2 补录） | 跨进程通知记账（session-pending 判定依据） | goal 守卫/后代判定口径 | 发射点①-④随对应意图操作；**发射点⑤ = reconcile-sweep 直写**（D7 白名单保留域） |
| 9 | ~~pump 游离 record~~ | —— | —— | H2 删除 |

### 2.2 写点散落实例（证据）

- `finalize-record.ts`：doFinalizeRecord 编排 `.state` 写 + entry 写 + manifest + archive 四件套——文件布局知识在此。
- `subagent-service.ts`：`appendBatchFinalizedEntry` 的 entry 部分实际经 `store.reportSubagentRecord` 落盘（v2 措辞修正），真正绕开 store 的只有 `writeBatchMemberManifest`（manifest 直写）。
- `record-store.ts` 自身：register/archive/revive 内嵌 entry 写与索引维护——写面部分收口过，但意图边界未立（外部仍可直写 manifest/entry）。

### 2.3 恢复路径现状（6 条 + v2 补录第 7 条）

boot 期 4：store.revive / 孤儿恢复（recoverOrphanRecords）/ 对账 sweep（reconcile-sweep 补注销）/ 通知重放（notify-ledger recoverFromSession）+ sync 批补发；惰性 2：cold-resurrect（H1 后消亡，由标准 revive 承载）/ getFullRecord 磁盘重建；**manifest tmp 恢复（v2 补录，双宿主）**：subagent-service 启动扫描（:735）+ subagent-workflow extension boot 钩子（`session-lifecycle.ts:392-402`，oncePerProcess）——去向判定见 D6（随缓存降级退役为 tmp 静默删除）。

### 2.4 根因

主记录载体（pi session.jsonl）的落盘可靠性（debounce flush）不满足终态语义，于是每个需要「崩溃后仍正确」的消费方各自打 sidecar/索引补丁——**补丁长在调用方，不在存储**。L4 已经把「同一概念两份形态」合并；本设计把「补丁的所有权」收归存储。

---

## 3. 解决方案

### 3.1 终态：意图级 API（store 唯一写入口）

| 意图操作 | 语义 | 内部写面 |
|---------|------|---------|
| `register(record)` | 创建入册 | entry（best-effort）+ 索引失效 |
| `appendEvent(id, event)` | 事件追加（过程） | entry 变迁（best-effort） |
| `markRoundStarted(id)` | 轮始重置（v2 补：status=running + result/resumable 清除——热路径 `subagent-service.ts:1398-1401` 与冷续轮 `subagent-service.ts:1497` 两写点归口） | entry（best-effort） |
| `markRoundIdle(id, outcome)` | 轮末收口（**名称沿用，形态 = 保持 running-resumable，非置 idle**——status 写 idle 会断 SP-5 升级链与 hasRunning 判据；v3 补全簿记全集）；**内部簿记全集 = doFinalizeRoundToIdle 现状簿记 + H1 D7 增量，逐项**：① status **保持 running**（v4 B-1「旧 idle 折入 running」）；② result 写入规则（成功=content / 失败=前值??失败摘要 + lastError）；③ round+1；④ **closedReason 清除**（[S10]：前置 closed+closedReason 不清则 "gc"/"cancelled" 残留泄漏进 list 投影与 notify 载荷）；⑤ **resumable=true**（GUI waiting 判据）；⑥ **idleSince 刷新**（idle-GC 判据）；⑦ **`.alive` 删除**（轮终必做，漏删则探活误判存活）；⑧ 注销发射点②；⑨ reportRecordTransition（entry 携带新 round 与本轮 result）。调用方 = H1 Continuation + **one-shot settleOneShotOutcome**（SP-5 成功分支共享，非仅 chat 容器；均在 `subagent-service.ts`） | entry + `.alive` 删 + 注销② |
| `markFinalized(id, reason)` | 正常终态 | **`.state` writeSync** + entry + manifest + archive + **`.alive` 删除（存量清障）** |
| `markCancelled(id)` | 取消终态 | **`.state` writeSync** + entry + tombstone 语义 + archive + **`.alive` 删除（存量清障——现行 cancelBackground 删点 `subagent-service.ts:3084` 归口）** |
| `markBatchFinalized(ids)` | sync 批终态（统一写点，吸收 #6 两处直写）；**内部写序显式复刻 barrier（v2）**：manifest 落盘（writeSyncBatchManifestBarrier）先于批通知写账——「通知可达 ⇒ 索引就位」构造性保证（session-reader 指针行反查依赖），缓存降级下 barrier 不可删 | barrier + 批 entry + manifest |
| `adoptEngineDeath(id, {error})`（v2 补） | 引擎死亡收养（error/result/resumable 三写，`subagent-service.ts:2403-2407` 归口；**适用面 = 仅 tool record——非 chatMode；workflow origin 随 H2 豁免（origin 维度，无引擎维度：pi 与 zcode 引擎同经 RemoteEngine 协议客户端，engine_crashed 分诊对两者同样可达，v4 删「非 pi 引擎」误限）**） | entry（best-effort） |
| `archive(id)` / `revive(id)` | 内存↔磁盘 | 既有语义 |

**字段级写点全集 → 操作映射（v2；v4 补全十字段点名）**：① status——轮始→`markRoundStarted`、轮终保持 running→`markRoundIdle`、终态→`markFinalized`/`markCancelled`；② result——轮始清→`markRoundStarted`、轮终写→`markRoundIdle(outcome)`、终态→`markFinalized` 序言；③ round——轮终+1→`markRoundIdle`；④ closedReason——终态→`markFinalized`/`markCancelled`、轮终清除→`markRoundIdle`；⑤ resumable——轮始清/轮终置 true→`markRoundStarted`/`markRoundIdle`、收养→`adoptEngineDeath`；⑥ idleSince——轮终刷新→`markRoundIdle`（v4 补点名）；⑦ sessionFile——回填族归 `register`/`markFinalized` 序言；⑧ turns——事件累积族→`appendEvent`（execution-record.ts 事件归约，v4 补点名）；⑨ lastError——轮终失败→`markRoundIdle` failed 载荷；⑩ error——收养/失败→`adoptEngineDeath`/`markRoundIdle`。映射全集表由 P1 产出并随 API 落地核对（P1 验收含「十字段逐一有归口行」核对项）。

**副作用归属边界（v2）**：`markFinalized`/`markCancelled` 只吸收**持久化面**（`.state`/entry/manifest/archive）；collectPatch（Step 0）、worktree cleanup（Step 3b）、pending 注销发射点①、onFinalized 钩子**留调用方编排**——store 不新增 worktree/通知注册表依赖，调用方「零文件布局知识」边界保持（文件布局 ≠ 副作用编排）。

调用方（H3 的 RecordLifecycle 聚合、notifier、collect-coordinator、H1 的 Continuation）只调上述操作；**禁止**绕过 store 直接触碰 state-marker / manifest / entry writer（lint/审查守卫 + barrel 不导出内部写器）。

### 3.2 多方案对比

| 方案 | 长期合理性 | 短期成本 | 风险 | 判定 |
|------|-----------|---------|------|------|
| **A. 唯一写入口 + `.state` 同步写权威**（本设计） | 高：真相一处、崩溃窗口单点论证、测试面收口 | 中：API 立面 + 写点迁移 3-4 PR | 低：L4 已铺 `.state`；writeSync 仅终态两次写 | **选定** |
| B. 只立意图 API、不改权威分层（jsonl 仍是主记录，sidecar 仍是补丁） | 中：调用面收口但双真源仍在（entry 与 `.state` 谁赢的问题依旧） | 低 | 中：崩溃窗口论证仍分散 | 否——治标：§2.4 的根因（补丁长在调用方）只解了一半 |
| C. record 状态全量迁独立存储（SQLite，仿 zcode 会话库） | 高（一致性最强） | 高：新存储 + 全量迁移 + 双写过渡 | 高：与 pi session 生态（reader/GC/extension）兼容面大 | 否——为 ~秒级终态写引入独立 DB 过度；zcode 用 SQLite 是其上游既有形态，pi 侧无此约束 |

### 3.3 关键决策

- **D1 权威分层**（见 §1.3 G2）：终态判定一律以 `.state` 为准；重建时 entry 与 `.state` 冲突 → `.state` 赢（entry 丢尾是常态）。**被否**：entry 为主 `.state` 为校验（双真源未除）。
- **D2 writeSync 代价**：终态每 record 至多两次同步写（finalized/cancelled）；实测门 = 终态路径时延增量（预期 <1ms 量级，P5 实测；不可接受再议）。
- **D3 `.alive` 写面随 H1 消亡退役（v4 改判——「子进程自写跨进程豁免」前提证伪）**：全仓唯一写者 = cold-resurrect（宿主 `process.pid` 自写，`cold-resurrect.ts:152`；pi-subagent-cli / subagent-engine-sdk / extensions 全部零命中）——L4「`.alive` 不动（子进程自写跨进程）」的前提经源码核实**不成立**；H1 U6 删 cold-resurrect 后 `.alive` **零写者**。处置四件：①写面随写者消亡——`.alive` 不再列入豁免，G1 白名单仅剩 store 内部；②**删除动作归口 store 内部**（markFinalized/markCancelled/markRoundIdle 内部写面含 `.alive` unlink——存量残留清障语义；「宿主只读」措辞废止，unlink 是写面操作非豁免对象）；③**探活读面退役清单（v5 穷举四处，逐处显式处置）**：(a) record-store 重建分支探活判定（:1244/:1362 isProcessAlive + ALIVE_SOFT_TIMEOUT_MS）——移除，非终态统一落分支 4 兜底 running（v4 B-1 既有定案），终态判定由 `.state` 权威分支承接；(b) findForeignLiveInstance——随 cold-resurrect 已消亡；(c) **worktree-manager（v6 再处置——v5「判据换血」基于错误数据流被轮 4 证伪）**：`.alive` 读物（collectAlivePids :608-625）唯一消费点 = reconcileEncSegment **方向二**（:460，物理有 → 注册无的残留段自愈）；:346/:681 注册表 pid 判据属 scan 阶段一（遍历注册表条目），从不消费 `.alive`——v5 对它的「换血」是空操作，对方向二是**判据清零**：自愈补写分支（:465-483）失去 pid 源，cleanupDeadSegment（:525-537）退化为「未注册 + mtime>60s → 强删 worktree + branch -D」，而注册表丢条目是登记在案的预期通道（worktree-registry.ts 头注释锁重试降级兜底 + PS-12 自愈分支），该场景属主进程与 subagent 存活、worktree 在用，「活进程绝不删」语义**不**保留。**修正处置（选项 i）：方向二活信号同 (d) 换进程内权威——service 活跃 record 注册表**：自愈补写分支的存活判据改从运行中 record 的 worktree 绑定匹配（物理段路径 ↔ record worktree 句柄路径，进程内权威；精确映射机制 = 实施期核验点⑧）；跨重启承接不变（孤儿 stdin-EOF 自灭秒级窗 ≪ 60s SPAWN_GRACE_MS + boot 清理后置于 revive 完成）；**P4 验收补反向场景「注册表丢条目 + 属主存活 → 不删」**；(d) **session-file-gc D-024 安全网（:95-102 cleanExpiredJsonl 的 `.alive` 探活保护「活进程 session 不删」）——同款换血**：判据换 service 活跃 record 注册表（进程内权威），删除行为保留（备注：现 `.alive` 探活顺带保护「另一共存宿主实例」的闲置 jsonl，进程内注册表不覆盖跨实例——H1 后 `.alive` 零写者使该增量稳态为空，登记为理论性不构成回归）；**两护栏处置先于/同批于 boot 清理（D3 ④）——boot 清掉 marker 即消除护栏数据源，护栏退役必须显式先行，禁清单外静默失效**。另 **externalInstance 死字段链清理（v5 补）**：types.ts:844 字段声明 + record-entry.ts:35 投影注释 + subagent-actions-core.ts:695-701 fork-from 守卫 3（恒不触发）+ alive-store.ts:5 过时模块头注释（「子进程启动时写 .alive」与实装不符）——随分支 3 移除一并清理，纳入 P4/P5 回写；④boot 批处理兜底清理全量残留 marker。溯源注记：本条改判 supersede L4 的 `.alive` 处置理由。
- **D4 通知存在性挂权威（v2 拆两个判定）**：①**终态通知门**（notifyGate/重建终态优先级）——改读 `.state` 权威，成立；②**E1 sync 批待通知判定**——**显式维持 entry 尾形态判定源**（sync one-shot 成功成员崩溃时恒 running+resumable 形态、无 `.state` 可读——轮终回 idle 不写终态 sidecar；判定源 = 主 session 文件末条 entry（collectMode=sync 且无 batchFinalized 标记）+ 缓冲快照，`sync-rebuild.ts:11-21` 语义不变）。**被否**：E1 判定也挂 `.state`（无权威可读，补发失效 = 「不通知」事故族复发）。ledger entry 保留为投递/回执账（防重放机制不变）。
- **D5 索引/缓存降级（v2 补全闭环三要素 + 词汇全景；v4 补双写终点与 barrier 钉死）**：manifest 与 sessions-index 标注可丢；`rebuildIndexes()`（从 `.state` + entry 尽力重建）。**触发时机**：boot revive 完成后全量重建 + 反查 miss 惰性重建双通道。**失败降级**：rebuild 产出失败（子 session 已 GC/损坏）→ 回退全扫子 session 目录（record-store.ts:20-23 sessions-index「损坏静默回退全扫」同款先例）。**量级**：sessions-index 重建 = 全量冷扫（identity 头尾探测），基线引用现成量具 `extensions/universal/subagent-workflow/bench/cold-scan.bench.ts`（P4 实测入表）；重审触发 = 冷扫 P95 显著劣化（数值 P4 定）则保留原索引机制。**消费方枚举（v2 扩 extensions）**：GUI/runtime 直读之外，**session-reader extension**（独立 npm 包独立进程）以 manifest 为 identity 富字段主路径与孤儿/cleanedUp 判定来源（`session-reader/src/discovery/subagents.ts:23-50`）、外部进程无法触发宿主 rebuild——**前向兼容判定**：manifest 写侧保留旧状态词汇字段 + 新增 ExecutionStatus/ClosedReason 字段双写过渡（无版本号磁盘 schema 不做破坏性变更），S5 补 session-reader 视角断言。**双写终点（v4）**：旧词汇字段**永久保留为投影字段，只降权威地位不删字段**（与无版本 schema 兼容一致；session-reader 直读旧 status 字段，删字段 = 富字段降级）；词汇全景③「废弃」限指权威地位。**barrier 判据钉死（v4）**：writeSyncBatchManifestBarrier 等待的是 manifest 文件写完成（allSettled），与字段集无关——双写过渡不影响 barrier 语义。**状态词汇全景（v2）**：① ExecutionStatus+ClosedReason（内部权威，收口目标）② ExternalState(active/ended)（对外投影，设计决策 10 细则 3 刻意契约——**保留不收口**）③ manifest 三态（**权威地位废弃**、投影字段永久保留，双写过渡）④ TerminalState 二态（`.state`，权威载体）——另 ProjectedOutcome 为投影非词汇，不在范围。
- **D6 恢复路径归并（6 → 3；v2 补录第 7 条）**：boot 期 = store.revive+孤儿恢复（含 `.state` 权威读）+ 对账 sweep；通知重放（挂权威）；惰性 = 磁盘重建。sync 批补发并入 boot 批处理；cold-resurrect 已随 H1 消亡。**manifest tmp 恢复（v2 补录，现状第 7 条）**：recoverTmpFiles 双宿主（subagent-service 启动扫描 :735 + subagent-workflow extension boot 钩子 `session-lifecycle.ts:392-402`）——**随缓存降级退役为「tmp 静默删除」**（manifest 已可丢可重建，promote 语义失效）；extension 侧 boot 钩子触点列入 P4 改动地图。
- **D7 迁移策略（v2 守卫口径重定义 + 双轨语义归一；v4 白名单随 D3 改判收缩）**：写点逐个迁（每 PR 一个调用方），store 内部先立 API 再迁外部；迁移期旧直写路径与新 API 并存但旧路径标 deprecated，末单元删除 + 守卫。**grep 门（v2 重定义）**：①模式改真实导出名 `writeFinalizedState|writeCancelledState|writeManifest|saveIndex`（v1 的 `writeStateMarker` 是 state-marker.ts 模块私有函数 :81，grep 恒零命中假绿；现存直写点 :3072 writeCancelledState 即漏网例）；②entry 写面按 customType 限定（`subagent-record` 字面量——appendEntry 是 pi 全局通路，全域禁不可行）；③**白名单逐域**：store 内部 / notify-ledger 投递账 entry（§2.1 #7 保留设计）/ reconcile-sweep 注销 entry（发射点⑤，D6 保留）/ pending:register-unregister 通道 / 各 extension 自有域（**`.alive` 域随 D3 v4 改判移除——写面退役后无豁免对象**）；④扫描根 = `packages/*/src`（tests 首轮豁免、extensions 按域白名单）。**双轨失败语义归一（v2）**：窗口期旧直写路径维持现行静默 best-effort 语义，响亮报错语义随该调用方迁移到意图 API 时生效——单点论证（G3）在迁移完成后成立。

### 3.4 错误规格

| 错误 | 触发 | 形态 | 恢复 |
|------|------|------|------|
| writeSync 失败（磁盘满/权限） | markFinalized/Cancelled | **响亮报错**（不静默——终态写失败必须可见），任务收口暂停重试（**v2 补参数：重试 3 次指数退避 100ms 起；仍失败 logger.error 响亮暴露（日志 error 级 + GUI 通知面）+ record 留 running**（boot 孤儿恢复终态化闭环承接，record-store :764 侧写 `.state` "gc" 先例）） | 释放磁盘后重试；仍失败则 record 留 running（下次 boot 孤儿恢复终态化） |
| 缓存损坏 | manifest/index 解析失败 | 静默重建（rebuildIndexes；rebuild 自身失败 → 回退全扫，D5） | 无需动作 |
| entry 与 `.state` 不一致 | flush 丢尾 | `.state` 赢（D1） | 无需动作 |

### 3.5 终态数据流

```
调用方 ──意图操作──▶ RecordStore（唯一写入口）
                      ├─ 终态：.state writeSync（权威，崩溃即持久）
                      ├─ 过程：session.jsonl entry（best-effort）
                      ├─ 派生：manifest / sessions-index（可丢缓存，失效重建）
                      └─ .alive：写面随 H1 退役（D3）——删除归口 store 内部（存量清障）+ boot 清理
重建（boot/惰性）：.state（终态权威）+ entry（过程尽力）→ record；缓存全部可重建
```

---

## 4. 验收（真实场景；每场景回溯目标）

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| S1 | 终态崩溃窗口 | 派 subagent 至完成瞬间 SIGKILL 宿主（终态写入前后——**v2 补时点手段：debug fault-injection 探针在终态写前注入延迟/挂起点，或固定动作序列 + 重复采样 20 次口径**，毫秒级窗口需确定性命中）→ 重启 | record 终态与 closedReason 正确（`.state` 权威；不存在「完成但显示中断」） | G2/G3 |
| S2 | abort 截断窗口 | cancel 在途 subagent 后立即 SIGKILL → 重启 | cancelled 终态不丢（`.state` 同步写） | G2/G3 |
| S3 | 通知不重不漏 | S1/S2 形态下重启 + 正常完成混合 → 观察通知 | 已完成的不再补通知、未送达的重放一次（存在性挂权威后 replay 正确）；**E1 sync 批补发照常（D4 ②判定源维持 entry 尾——崩溃的 sync 成员补发不失效）** | G3 |
| S4 | 写面守卫 | 迁移完成后 grep 门（D7 v2 口径：真实导出名 + customType 限定 + 白名单逐域 + 扫描根 src） | store 外 record 域直写零命中（白名单外） | G1 |
| S5 | 缓存可丢 | 手动删除 manifest/sessions-index → 重启 | 列表/详情照常（重建），无错误静默吞；**session-reader 视角：identity 投影/孤儿判定不因 manifest 重建窗口静默降级失败（双写过渡字段在）；重启后 E1 补发批通知的指针行消费正常（barrier 保留）** | G2 |
| S6 | 全功能回归 | one-shot / chat 续聊（H1 后形态）/ workflow（H2 后形态）/ 重启恢复 | 行为与收敛前一致；四包 + extensions 测试全绿 | G4 |
| S7 | pi 生态表面不变（v2 反向场景） | H4 实施后：pi CLI / session-reader / session-manager 读同一 session 文件对比实施前；触发 compaction 后检查 ledger/pending entry 保留；diff session 文件格式 | pi 读面行为不变；compaction 后 ledger/pending entry 保留行为回归（**顺带收口 P-B4 探针**——「compaction 对 entry 的保留行为实装未验证」在册项）；session 文件无 xyz-agent 侧格式漂移（customType 白名单外零新增） | G4 |

---

## 5. 下一层拆分（PR 单元）

| 单元 | 内容 | justification | 可独立验收 |
|------|------|--------------|-----------|
| P1 | store 意图 API 立面（§3.1 表全原语）+ 内部收编（`.state` 写归 store 内部、markFinalized/markCancelled 同步写）+ **字段级写点全集映射表产出 + state-marker 注释同步改写（best-effort→权威语义，doc-symbol-drift 面）** | API 先行，外部未迁即双轨并存 | 单测：API 语义 + `.state` 权威读。**revert 最小单元 = 本 PR；落盘兼容：API 未被外部消费，零落盘变化** |
| P2 | 写点迁移①：finalize-record 四件套 → markFinalized/markCancelled（H3 的 RecordLifecycle 调用面）**含两条 `.alive` 删点归口（finalizeRecord Step3 :171-176 + cancelBackground :3084，v4 补）**；副作用编排留调用方（§3.1 边界） | 最大写点先迁 | S1/S2 真机。**revert = 本 PR；旧直写路径同 PR 内删除（无窗口残留）** |
| P3 | 写点迁移②：subagent-service 批写（manifest 直写 → markBatchFinalized 含 barrier 复刻）；H1 Continuation 轮末 + one-shot 共享点 → markRoundIdle(outcome) | 批/轮次写点归一 | S3 + 通知 dedup 用例。**revert = 本 PR；同批删旧路径** |
| P4 | 缓存降级 + rebuildIndexes（触发/降级/量级三要素落地）+ manifest 词汇双写过渡（旧字段永久保留投影地位、新字段权威）+ 恢复路径归并（6→3 含 tmp 恢复退役 + extension boot 钩子触点）+ **`.alive` 探活读面退役（D3 ③四处穷举：record-store 判定移除 + worktree-manager/session-file-gc 护栏判据换血（注册表 pid，护栏语义保留）+ externalInstance 死字段链清理；护栏处置先于/同批于 boot 清理）+ boot 批处理清理全量残留 marker（D3 ④）** | 降级与重建最后做（依赖前面权威就位） | S5 + 恢复用例 + session-reader 视角。**revert = 本 PR + P3（词汇双写先行使缓存格式前向兼容）；缓存本身可丢可重建 = 天然回滚通道** |
| P5 | 测试面切换（文件名断言 → 接口语义）+ grep 守卫（D7 v2 口径）+ 文档/约束回写（C-proc-13 ②发射点/恢复路径描述、troubleshooting、state-marker 注释） | 守门与文档收尾 | S4 + S7 + doc-symbol-drift 绿。**revert = 守卫与文档，无落盘面** |

**文件改动地图**：`execution/record-store.ts`（API 立面）/ `execution/state-marker.ts`（内部化：barrel 停止导出写函数）/ `execution/finalize-record.ts`（编排瘦身为意图调用）/ `execution/subagent-service.ts`（批写迁移）/ `execution/notify-ledger.ts`（存在性判定改读权威）/ `execution/manifest-store.ts` + `sessions-index.ts`（缓存标注 + rebuild）/ 对应 `__tests__/`。

**待验证检查点**：① writeSync 实际时延（D2，P5 实测）；② manifest 被 GUI/runtime 直读的快速路径依赖面（哪些消费方绕 store 读 manifest——迁缓存前逐一核实）；③ pi 主 session 文件 entry 的 flush 窗口实测分布（论证「过程记录可丢」的实际丢失率）；⑧ worktree 方向二活信号的精确映射机制（物理段路径 ↔ record worktree 句柄路径的匹配实现，D3 ③(c)）。

---

## 附：决策溯源与被否谱系

复杂度审查（2026-09-10）将「9 处持久化」列为 H4；用户裁定方向 = 按领域收口（「不能直接写，应该都是调领域服务」——即本设计的意图级 API + 唯一写入口），L4（`.state` 合并）作为速赢先行铺了权威载体。执行序 = H1 → H2 → H3 → H4（模型 → 消费面 → 结构 → 存储收口，同一条「record 真相与写入只有一处」轴的第四步）。

**被否谱系（自包含记录：曾提方案 —— 击穿原因 —— 修正形态）**：

1. **「markRoundIdle(id) 无载荷原语 + 调用方仅 chat 容器」**——塞不下轮终 result 写入规则（entry 重建源双滞后）、漏 `.alive` 删除（探活误判存活）、one-shot SP-5 共享调用点同样经此——修正为 outcome 载荷 + 内部簿记全集（含 status 保持 running-resumable）+ 双调用方标注。
2. **「grep 门 pattern = writeStateMarker|writeManifest|appendEntry」**——`writeStateMarker` 是 state-marker.ts 模块私有函数，外部不可调用，恒零命中假绿（现存直写点 writeCancelledState 漏网）；`appendEntry` 全域禁与自身保留面（notify-ledger 投递账/reconcile-sweep 注销/extensions 域）直接矛盾——修正为真实导出名全集 + customType 限定 + 白名单逐域 + 扫描根口径。
3. **「缓存可丢可重建（只声明重建源）」**——缺触发时机、失败降级、外部进程消费方（session-reader 以 manifest 为富字段主路径与孤儿判定来源且无法触发宿主重建）、批通知指针屏障语义、重建量级基线——修正为 D5 三要素 + 前向兼容双写 + S5 指针消费场景。
4. **「存在性判定一律改读 `.state`（无范围限定）」**——E1 sync 批待通知判定的对象（成功成员崩溃形态）恒 running+resumable、无 `.state` 可读，照搬即补发失效（「不通知」事故族复发）——修正为 D4 拆两判定（终态通知门挂权威 / E1 判定源维持 entry 尾）。
5. **「恢复路径 6 条（清单完备）」**——漏 manifest tmp 恢复双宿主（service 启动扫描 + extension boot 钩子触点）——修正为 §2.3 补录 + D6 退役判定（tmp 静默删除）+ P4 触点。
6. **「七原语隐含覆盖现存写点」**——轮始重置/引擎死亡收养/sessionFile 回填族/lastError 四组写点无归口——修正为 markRoundStarted/adoptEngineDeath 新增原语 + 回填归序言 + 字段级映射表（P1 产出）。
7. **「`.alive` 子进程自写跨进程豁免（沿袭 L4 处置理由）」**——前提经源码核实证伪：全仓唯一写者 = cold-resurrect 宿主自写（`cold-resurrect.ts:152`），「子进程自写」不存在；H1 U6 删唯一写者后 `.alive` 零写者，豁免条目指向将不存在的写面，且「宿主只读」与 markRoundIdle 的删除动作自相矛盾——修正为写面随 H1 消亡退役（D3 四件：删除归口 store / 读面退役清单 / boot 清理 / 白名单收缩）。
