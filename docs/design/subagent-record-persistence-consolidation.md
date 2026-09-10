# record 持久化收敛（单一写入口 + 同步写权威）

> **层声明**：技术方案层设计——当前层 = 存储模型与写入口契约，下一层 = 可实施的迁移 PR 单元（§5）。
> **前置依赖**：H1（chat 域统一）→ H2（workflow record 归位）→ H3（service 拆分）依次落地后最后收口——前三者重塑 record 的形状与消费面，本设计在其稳定后统一持久化。
> **基线**：含 L4 已实施形态（`execution/state-marker.ts`：`.finalized`/`.cancelled` 合并 `.state`，读侧兼容旧名，`.alive` 不并入——L4 设计时在途，以落地版为准）。
>
> **一句话结论**：RecordStore 成为 record 状态的**唯一写入口**（意图级操作 API），终态以 `.state` **同步写**为权威；session.jsonl entry 降为过程记录（best-effort）、索引降为可丢缓存；写面从 9 处收口为 1 处（`.alive` 子进程自写为唯一显式豁免）；崩溃窗口语义从「散在各调用方」收为「store 内单点论证一次」。

---

## 1. 背景目标

### 1.1 SCQA

- **S**：一个 subagent record 的状态今天写在多处：session.jsonl 的 `subagent-record` custom entry（主记录，随 pi 的 debounce flush 落盘）、终态 sidecar（L4 后为 `.state`）、`.alive`（pid 探活）、manifest `records/<sa-id>.json`（反查索引）、sessions-index.json（缓存）、主 session 文件的 batchFinalized 覆写、notify-ledger 三类 entry、workflow run state 文件（H2 后其子代理 record 入 store，run 级状态仍在 FileRunStore）。
- **C**：「该写哪几个文件」的知识散落在每个调用方——`finalize-record.ts` 自己凑齐 `.state` + entry + manifest + archive 四件套；`subagent-service` 直接写 batchFinalized entry 与 manifest；每处写面各自处理崩溃窗口（flush 丢终写 / abort 截断 / 批一致性），一致性 bug 要跨多处排查。
- **Q**：如何让 record 状态的真相与写入只有一处？
- **A**：RecordStore 暴露意图级操作（调用方说「发生了什么」，不说「写哪个文件」），所有文件布局知识收进 store 内部；终态走同步写权威。

### 1.2 系统是什么（受众认知铺垫）

RecordStore（`execution/record-store.ts`，1483 行）已是 record 的统一容器：内存持有 running、终态从 session.jsonl 重建、两级读写（light 头 + 全量懒加载）。本设计不是新建模块，而是把它从「容器 + 部分写面」升级为「唯一写入口 + 权威分层」。H3 拆分后其 RecordLifecycle 聚合是消费侧，本设计落在 store 自身接口。

### 1.3 设计目标

- **G1 唯一写入口**：store 外零直写（白名单 = state-marker 内部实现 + `.alive` 子进程自写）。
- **G2 真相分层明确**：终态 = `.state` 同步写（崩溃即持久）；过程 = session.jsonl entry（best-effort，可丢可重建）；缓存 = manifest/sessions-index（可丢可重建）。
- **G3 崩溃窗口单点论证**：每个崩溃形态（flush 丢终写 / abort 截断 / 探活 / 批一致 / 通知存在性）只在 store 内论证一次，调用方无感知。
- **G4 调用方零文件布局知识**：调用方只调意图操作；测试从「拼文件名断言」转为「断言 store 接口语义」。

### 1.4 in / out scope

**in**：store 意图级 API 立面；终态同步写权威；各写点迁移；缓存降级与重建；恢复路径归并；测试面切换。
**out**：pi session 文件本身（pi 子进程写的任务记录，不动）；notify-ledger 的投递账（存在性判定改挂权威，投递/回执机制不动）；WorkflowRun/FileRunStore（run 级状态）；zcode 会话库（C-ext-20 不动）。

---

## 2. 现状与问题分析

### 2.1 写面清单（现状 9 处 → H1/H2 落地后 8 处）

| # | 位置 | 写什么 | 为什么存在（崩溃窗口） | 终态归属 |
|---|------|--------|----------------------|---------|
| 1 | session.jsonl `subagent-record` entry | record 主记录（创建/终态/变迁） | 主记录本体；随 pi debounce flush，暴毙丢尾 | 降为**过程记录**（best-effort） |
| 2 | `.state` sidecar（L4 后） | 终态二态 + reason | 补 #1 丢终写的洞（同步写） | **升为终态权威** |
| 3 | `.alive` | 子进程 pid（子进程自写） | 宿主重启后探活 | **显式豁免**（跨进程，无法收口） |
| 4 | manifest `records/<sa-id>.json` | 反查索引 + 第三套状态词汇 | GUI 列表快速路径 | 降为**缓存**（可重建） |
| 5 | sessions-index.json | identity 探测缓存 | 性能 | 降为**缓存** |
| 6 | 主 session 文件 batchFinalized 覆写 | sync 批成员终态 | 批通知一致性 | 并入 `markBatchFinalized` 意图操作 |
| 7 | notify-ledger 三类 entry | 通知存在性（防重放） | 「不通知」事故族修复 | 存在性判定改读权威；entry 保留为投递账 |
| 8 | workflow run state（FileRunStore） | workflow run 级状态 | workflow 崩溃恢复 | **不动**（run 级 ≠ record 级；H2 后子代理 record 已入 store） |
| 9 | ~~pump 游离 record~~ | —— | —— | H2 删除 |

### 2.2 写点散落实例（证据）

- `finalize-record.ts`：doFinalizeRecord 编排 `.state` 写 + entry 写 + manifest + archive 四件套——文件布局知识在此。
- `subagent-service.ts`：`appendBatchFinalizedEntry`（写主 session 文件）+ `writeBatchMemberManifest`（直写 manifest）绕开 store。
- `record-store.ts` 自身：register/archive/revive 内嵌 entry 写与索引维护——写面部分收口过，但意图边界未立（外部仍可直写 manifest/entry）。

### 2.3 恢复路径现状（6 条）

boot 期 4：store.revive / 孤儿恢复（recoverOrphanRecords）/ 对账 sweep（reconcile-sweep 补注销）/ 通知重放（notify-ledger recoverFromSession）+ sync 批补发；惰性 2：cold-resurrect（H1 后消亡，由标准 revive 承载）/ getFullRecord 磁盘重建。

### 2.4 根因

主记录载体（pi session.jsonl）的落盘可靠性（debounce flush）不满足终态语义，于是每个需要「崩溃后仍正确」的消费方各自打 sidecar/索引补丁——**补丁长在调用方，不在存储**。L4 已经把「同一概念两份形态」合并；本设计把「补丁的所有权」收归存储。

---

## 3. 解决方案

### 3.1 终态：意图级 API（store 唯一写入口）

| 意图操作 | 语义 | 内部写面 |
|---------|------|---------|
| `register(record)` | 创建入册 | entry（best-effort）+ 索引失效 |
| `appendEvent(id, event)` | 事件追加（过程） | entry 变迁（best-effort） |
| `markRoundIdle(id)` | 轮末置闲（chat 容器；round+1——H1 后由 Continuation 调用） | entry + 注销发射点② |
| `markFinalized(id, reason)` | 正常终态 | **`.state` writeSync** + entry + manifest + archive |
| `markCancelled(id)` | 取消终态 | **`.state` writeSync** + entry + tombstone 语义 + archive |
| `markBatchFinalized(ids)` | sync 批终态 | 统一写点（吸收 #6 两处直写） |
| `archive(id)` / `revive(id)` | 内存↔磁盘 | 既有语义 |

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
- **D3 `.alive` 显式豁免**：子进程自写 + 宿主只读，跨进程语义无法收口——文档化豁免（唯一 store 外写者）。
- **D4 通知存在性挂权威**：notify-ledger 的「已通知判定」改读 store 终态（`.state`）而非 entry 尾；ledger entry 保留为投递/回执账（防重放机制不变）。
- **D5 索引/缓存降级**：manifest 与 sessions-index 标注可丢；提供 `rebuildIndexes()`（从 `.state` + entry 尽力重建）；manifest 的第三套状态词汇（running/closed/cancelled）随收口废弃，统一为 ExecutionStatus + ClosedReason。
- **D6 恢复路径归并**（6 → 3）：boot 期 = store.revive+孤儿恢复（含 `.state` 权威读）+ 对账 sweep；通知重放（挂权威）；惰性 = 磁盘重建。sync 批补发并入 boot 批处理；cold-resurrect 已随 H1 消亡。
- **D7 迁移策略**：写点逐个迁（每 PR 一个调用方），store 内部先立 API 再迁外部；迁移期旧直写路径与新 API 并存但旧路径标 deprecated，末单元删除 + 守卫（grep 门：store 外 `writeStateMarker|writeManifest|appendEntry` 零命中，白名单 = store 与 `.alive`）。

### 3.4 错误规格

| 错误 | 触发 | 形态 | 恢复 |
|------|------|------|------|
| writeSync 失败（磁盘满/权限） | markFinalized/Cancelled | **响亮报错**（不静默——终态写失败必须可见），任务收口暂停重试 | 释放磁盘后重试；仍失败则 record 留 running（下次 boot 孤儿恢复终态化） |
| 缓存损坏 | manifest/index 解析失败 | 静默重建（rebuildIndexes） | 无需动作 |
| entry 与 `.state` 不一致 | flush 丢尾 | `.state` 赢（D1） | 无需动作 |

### 3.5 终态数据流

```
调用方 ──意图操作──▶ RecordStore（唯一写入口）
                      ├─ 终态：.state writeSync（权威，崩溃即持久）
                      ├─ 过程：session.jsonl entry（best-effort）
                      ├─ 派生：manifest / sessions-index（可丢缓存，失效重建）
                      └─ 豁免：.alive（子进程自写，宿主只读）
重建（boot/惰性）：.state（终态权威）+ entry（过程尽力）→ record；缓存全部可重建
```

---

## 4. 验收（真实场景；每场景回溯目标）

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| S1 | 终态崩溃窗口 | 派 subagent 至完成瞬间 SIGKILL 宿主（终态写入前后）→ 重启 | record 终态与 closedReason 正确（`.state` 权威；不存在「完成但显示中断」） | G2/G3 |
| S2 | abort 截断窗口 | cancel 在途 subagent 后立即 SIGKILL → 重启 | cancelled 终态不丢（`.state` 同步写） | G2/G3 |
| S3 | 通知不重不漏 | S1/S2 形态下重启 + 正常完成混合 → 观察通知 | 已完成的不再补通知、未送达的重放一次（存在性挂权威后 replay 正确） | G3 |
| S4 | 写面守卫 | 迁移完成后 grep 门 | store 外直写零命中（白名单 = state-marker 内部 + `.alive`） | G1 |
| S5 | 缓存可丢 | 手动删除 manifest/sessions-index → 重启 | 列表/详情照常（重建），无错误静默吞 | G2 |
| S6 | 全功能回归 | one-shot / chat 续聊（H1 后形态）/ workflow（H2 后形态）/ 重启恢复 | 行为与收敛前一致；四包 + extensions 测试全绿 | G4 |

---

## 5. 下一层拆分（PR 单元）

| 单元 | 内容 | justification | 可独立验收 |
|------|------|--------------|-----------|
| P1 | store 意图 API 立面（§3.1 表）+ 内部收编（`.state` 写归 store 内部、markFinalized/markCancelled 同步写） | API 先行，外部未迁即双轨并存 | 单测：API 语义 + `.state` 权威读 |
| P2 | 写点迁移①：finalize-record 四件套 → markFinalized/markCancelled（H3 的 RecordLifecycle 调用面） | 最大写点先迁 | S1/S2 真机 |
| P3 | 写点迁移②：subagent-service 批写（batchFinalized entry + manifest 直写）→ markBatchFinalized；H1 Continuation 的轮末 → markRoundIdle | 批/轮次写点归一 | S3 + 通知 dedup 用例 |
| P4 | 缓存降级 + rebuildIndexes + manifest 状态词汇废弃 + 恢复路径归并（6→3） | 降级与重建最后做（依赖前面权威就位） | S5 + 恢复用例 |
| P5 | 测试面切换（文件名断言 → 接口语义）+ grep 守卫 + 文档/约束回写（C-proc-13 ②发射点/恢复路径描述、troubleshooting） | 守门与文档收尾 | S4 + doc-symbol-drift 绿 |

**文件改动地图**：`execution/record-store.ts`（API 立面）/ `execution/state-marker.ts`（内部化：barrel 停止导出写函数）/ `execution/finalize-record.ts`（编排瘦身为意图调用）/ `execution/subagent-service.ts`（批写迁移）/ `execution/notify-ledger.ts`（存在性判定改读权威）/ `execution/manifest-store.ts` + `sessions-index.ts`（缓存标注 + rebuild）/ 对应 `__tests__/`。

**待验证检查点**：① writeSync 实际时延（D2，P5 实测）；② manifest 被 GUI/runtime 直读的快速路径依赖面（哪些消费方绕 store 读 manifest——迁缓存前逐一核实）；③ pi 主 session 文件 entry 的 flush 窗口实测分布（论证「过程记录可丢」的实际丢失率）。

---

## 附：决策溯源

复杂度审查（2026-09-10）将「9 处持久化」列为 H4；用户裁定方向 = 按领域收口（「不能直接写，应该都是调领域服务」——即本设计的意图级 API + 唯一写入口），L4（`.state` 合并）作为速赢先行铺了权威载体。执行序 = H1 → H2 → H3 → H4（模型 → 消费面 → 结构 → 存储收口，同一条「record 真相与写入只有一处」轴的第四步）。
