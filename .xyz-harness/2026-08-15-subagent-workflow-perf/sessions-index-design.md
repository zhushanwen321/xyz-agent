# sessions-index.json 持久化索引：消灭冷扫描的全量 identity 探测

| 项 | 值 |
|---|---|
| 日期 | 2026-08-15 |
| 模块 | `extensions/subagent-workflow`（`@zhushanwen/pi-subagent-workflow`） |
| 状态 | 设计稿（待实现） |
| 读者 | 会使用 subagent-workflow、但不了解本轮性能分析的开发者 |
| 性能基线 | 2026-08 对真实 sessions 目录（1744 个 jsonl / 586MB）的实测 |

---

## 1. 背景与目标

**结论：进程重启后的首次 `collectRecords`（冷扫描）实测 2.7s，瓶颈是「对全部 session 文件重新探测 identity」；identity 一旦确定几乎不变，把它持久化到一个自校验的索引文件（`sessions-index.json`），冷扫描可从 2.7s 降到 300ms 以内（预期 100-200ms），且任何索引异常都安全回退到今天的全量探测行为。**

subagent-workflow 的终态 record 不驻内存：`RecordStore.collectRecords`（`extensions/subagent-workflow/src/execution/record-store.ts:303`）每次都从 `sessions/*.jsonl` 重建列表。进程内已有三层缓存把**热路径**压到毫秒级（详见 §2.2），但它们全是内存态——**进程重启后清零**。xyz-agent 的 session-pool 为每个面板 session 各起一个 pi 进程，任一新进程的第一次列表查询都要对全部文件做一遍 identity 探测（head 64KB 读 → miss 则 tail 64KB 读 → 极少数全文 fallback），实测 2.7s：约 7k 次 stat syscall + 约 10k 次读 syscall / 186MB 读取，全同步串行，阻塞 event loop。

目标：

1. **冷扫描时间 2.7s → ≤300ms**（10 倍起步），手段是消灭「重复探测已知不变量」。
2. **零行为变化**：列表输出（id/agent/task/status/排序/过滤）与无索引时完全一致；索引只是探测结果的缓存。
3. **零新增依赖、零锁协议**：多 pi 进程共享同一 sessionsDir 时无需文件锁，靠原子写 + 读侧校验保证正确性。
4. **可降级**：索引损坏、版本不兼容、并发写坏，最坏结果只是退回今天的全量探测，永不产生错误数据。

非目标（已由前序优化解决，本文不动）：

- 进程内热路径（目录 mtime 快路径 + per-file stat 缓存，已优化到 ~1-2ms）。
- 详情懒加载（`getFullRecord`，重数据按需全量重建）。

---

## 2. 现状与问题分析

### 2.1 数据形态：sessionsDir 与 identity entry

**结论：每个 subagent session 是一个 append-only 的 jsonl 文件，identity（id/agent/task/rootSessionId 等）由 session-runner 在创建时写进一条 custom entry，之后几乎不再变化——这是「可持久化」的物理根据。**

- 目录布局：`<agentDir>/subagents/<enc>/sessions/`（`extensions/subagent-workflow/src/execution/path-encoding.ts:33-38`，`<enc>` 是 cwd 编码段）。同 `<enc>` 段下还有 `records/`（manifest 目录）。同一 cwd 的多个 pi 进程（xyz-agent session-pool）共享同一个 sessions 目录。
- 文件内容：第 1 行 session header，第 2-3 行附近一条 `customType:"subagent-identity"` entry（`extensions/subagent-workflow/src/execution/session-reconstructor.ts:129-130`），携带 `{id, agent, mode, task, slug, startedAt, rootSessionId, parentRecordId, depth, forkDepth, chatMode}`。之后是 message entries 持续 append。
- **identity 的唯一变化场景**：续聊（resume）时 `session_start` 再次触发，新 identity entry append 到文件尾部附近——代码注释记录了实测分布：约 34% 文件的 identity 在头 64KB，约 65% 在尾 64KB，~0.2% 需全文 fallback（`extensions/subagent-workflow/src/execution/session-reconstructor.ts:484-487`、`:569-573`）。
- sidecar 三件套（活态状态，**不在本文索引范围内**）：`<file>.cancelled`（tombstone JSON）、`<file>.finalized`（空标记）、`<file>.alive`（pid+startedAt 单行 JSON，见 `extensions/subagent-workflow/src/execution/alive-store.ts:26-31`）。

### 2.2 现有缓存体系分层

**结论：现有缓存是「L0 目录戳 → L1 文件戳 → L2 id 索引」三层内存结构，全部随进程死亡；identity 探测结果只活在 L1 里，重启即失。**

| 层 | 位置 | 内容 | 失效机制 | 生命周期 |
|---|---|---|---|---|
| L0 `dirStamp` | 内存（`record-store.ts:197-199`） | sessionsDir 的 mtime | 目录 mtime 变化（新建/删除/重命名/sidecar 写入必改）→ 走慢路径；未变 → 跳过 readdir + N×4 stat，直接复用 L1（`record-store.ts:420-437`） | 进程内 |
| L1 `fileCache` | 内存（`record-store.ts:194`） | per-file：light identity + sidecar 状态矩阵 + full 懒加载 + **负缓存**（确认无 identity 的文件，`record-store.ts:136-142`） | jsonl + 3 sidecar 共 4 个 stat 戳（`{mtimeMs, size}`，`record-store.ts:91-95`）逐一比对；任一不匹配 → 只重建该文件（`record-store.ts:475-534`） | 进程内 |
| L2 `idToFile` | 内存（`record-store.ts:196`） | record id → 文件路径 | 随 L1 同步维护/修剪 | 进程内 |
| —（缺失） | **磁盘** | **identity 探测结果** | — | **跨进程/跨重启** |

`dispose()` 清空 L0/L1/L2（`record-store.ts:380-386`）；`findLightById` 的注释直白点出了空洞：「idToFile 未热（进程重启后尚未扫描过）时返回 undefined，调用方自行兜底全目录扫描」（`record-store.ts:536-546`）。

### 2.3 冷扫描成本拆解

**结论：2.7s 里 stat 只占几十毫秒，成本主体是 identity 探测的 186MB 内容读取——而其中约 99.8% 的探测结果与上次进程生命周期内完全相同。**

冷扫描（新进程首次 `reconstructAll`，`record-store.ts:410-466`）每文件做：

| 步骤 | syscall 量级 | 数据量 | 备注 |
|---|---|---|---|
| jsonl + 3 sidecar 各一次 statSync | 4 × 1744 ≈ 7k | — | 几十 ms，是**正确性机制**（识别变化），不可省 |
| identity 探测：head 64KB → tail 64KB → 全文 fallback | ~10k 次读 | **~186MB** | **2.7s 的大头**；append-only 文件每轮内容读的基本是上次读过的字节 |
| sidecar payload 读取（存在的 .cancelled/.alive） | 少量小文件 | <1KB/个 | 毫秒级 |
| 扫描后写负缓存 | 内存 | — | 无 IO |

关键观察：**identity 是文件的稳定派生量**——锚定在「探测时的 `{mtimeMs, size}`」上，只要 stat 戳不变，探测结果必然不变（append 必变 size）。因此探测结果可以持久化，冷启动时「1 次索引读 + N 次 stat」替代「N 次 head/tail 读」。

### 2.4 问题本质

**结论：这是「纯派生量缺少持久化层」的问题——不是算法问题，是缓存层次缺失。**

现有三层缓存解决了进程内的重复扫描，但没有一层跨进程。每次重启付出 2.7s 的代价换取的信息，上一次重启已经算过一遍。修复方式是给 L1 的 identity 部分补一个磁盘形态（下称 L-1），加载后灌入 L1，运行期行为完全交给现有机制接管。

---

## 3. 解决方案

### 3.1 方案对比

**结论：推荐方案 A（单一 JSON 索引文件，sessions 目录的兄弟位置），它是长期方案——自校验派生缓存、无新依赖、无锁、降级路径天然；per-record sidecar 与 SQLite 均否决。**

| | 方案 A：单一 `sessions-index.json` 【长期方案·推荐】 | 方案 B：per-record sidecar `<file>.meta` 【短期方案】 | 方案 C：SQLite | 方案 D：扩展 manifest |
|---|---|---|---|---|
| 形态 | sessions 目录兄弟位置放一个 JSON 文件，`basename → {锚定戳, identity, 负标记}` | 每个 jsonl 旁多一个 meta 文件 | `better-sqlite3` 单库文件 | 在 `records/<id>.json` 里补 identity + 锚定戳 |
| 长期架构合理性 | **高**。纯派生缓存，读侧逐条戳校验，陈旧索引只浪费探测时间、绝不产生错误数据；无 schema 迁移负担（version 字段兜底）；不侵入 L0/L1 语义 | 低。引入第四种 sidecar 类型：readdir 过滤、GC 清理（`session-file-gc.ts` 的 sidecar 清单要加一类）、目录 mtime 被 meta 写入频繁改变 → **击穿所有进程的 L0 快路径**（每次 meta 写都让全体进程多跑一轮 readdir+N×4 stat） | 低。pi extension 保持零原生依赖（纯 JS 分发）；WAL/SHM 引入新目录状态；1744 条 KV 用 SQL 是杀鸡用牛刀 | 低。manifest 在 finalize 时写（`manifest-store.ts` 的写入方是 finalizeRecord），running/crashed record 没有 manifest，覆盖面天然不全；且 manifest 无 jsonl 锚定戳，无法安全跳过探测。FR-8 已把它用作 orphan 兜底，职责不该混 |
| 短期成本 | 新模块 ~150 行 + RecordStore 两个接入点 + 测试 | 与 A 相当 | 高（依赖、构建、打包） | 中，但正确性补不齐 |
| 风险 | 索引文件本身的并发写（§3.2.3-② 已解）；体积增长（§3.2.3-⑥ 已评估） | 1744+ 新文件的 inode 压力 + L0 击穿是结构性缺陷 | 原生模块跨平台（win/arm64）构建矩阵 | 探测跳不过去，等于没解决问题 |

### 3.2 推荐方案详细设计（方案 A）

#### 3.2.1 索引文件位置与格式

**结论：放 `<enc>/sessions-index.json`（sessions 目录的**兄弟**、与 `records/` 平级），不放 sessionsDir 内部——写入不改变 sessionsDir 的 mtime，不击穿 L0 快路径。**

位置推导：`RecordStore` 已持有 `sessionsDir`，取 `path.dirname(sessionsDir)` 即得 `<enc>` 段，无需改构造签名。三个佐证：

1. 若放 sessionsDir 内部：每次索引写入改目录 mtime → 本进程与其他进程的 L0 快路径全部失效一轮（readdir + 7k stat ≈ 50ms），多进程下互相扰动。兄弟位置完全无此问题。
2. `reconstructAll` 的 readdir 过滤是 `f.endsWith(".jsonl")`（`record-store.ts:441-442`），兄弟位置的 `.json` 天然不会被当成 session 文件。
3. GC 的 `.json` 清理只在 `records/` 子目录内开启（`extensions/subagent-workflow/src/execution/session-file-gc.ts:62-68`，注释明确「其他位置不能匹配 .json——否则会误删 worktree reaper 状态文件」），兄弟位置不会被 GC 误删；索引是自校验缓存，也**不需要** TTL 清理。文件被删除后对应条目由下一次索引重写自然修剪（见 ⑤）。

索引条目的 TS 接口（正条目与 `IdentityHeaderRecon` 字段一一对应，`session-reconstructor.ts:490-505`）：

```ts
/** sessions-index.json 顶层 */
interface SessionsIndexFile {
  version: 1;                                // 版本不识别 → 整体丢弃（见 ③）
  pid: number;                               // 写入进程，仅诊断
  /** key = jsonl 文件 basename（不含路径；索引天然属于这一个 sessionsDir） */
  entries: Record<string, SessionsIndexEntry | SessionsIndexNegativeEntry>;
}

/** 正条目：identity 探测结果 + 锚定戳 */
interface SessionsIndexEntry {
  /** 锚定戳 = 探测时的 jsonl stat。命中 ⇒ identity 仍有效（append 必变 size） */
  mtimeMs: number;
  size: number;
  id: string;
  agent: string;
  mode: "sync" | "background";
  task: string;
  slug: string;
  startedAt: number;
  rootSessionId: string | undefined;
  parentRecordId: string | undefined;
  depth: number;
  forkDepth: number | undefined;
  chatMode: boolean | undefined;
  model: string;                             // 尾部探测时为 ""——与内存缓存行为一致
  thinkingLevel: string | undefined;
}

/** 负条目：该戳下确认无 identity（异构/损坏文件） */
interface SessionsIndexNegativeEntry {
  negative: true;
  mtimeMs: number;
  size: number;
}
```

设计取舍：

- **key 用 basename 不用绝对路径**：索引只属于单个 sessionsDir；绝对路径会因 agentDir 迁移（xyz-agent dev/prod 数据目录不同）整体失效。
- **sidecar 戳不入索引**：sidecar 是活态数据（finalize/cancel/心跳随时写），每次扫描重 stat 是既有语义且只有几十 ms；索引只管「几乎不变的 identity」。
- **`model`/`thinkingLevel` 原样存探测结果**：尾部探测拿不到途经的 model_change，返回空串——这正是今天 L1 缓存的值，详情场景由 `getFullRecord` 全量重建补齐，行为不变。

#### 3.2.2 读路径：冷扫描新流程

**结论：索引是 L1 的 identity 种子——首次 `reconstructAll` 惰性加载一次，之后 `scanFile` 的「探测」步骤变成「查索引」，其余流程（4 次 stat、sidecar 矩阵、修剪、L0）一字不动。**

```
进程启动
  └─ 首次 reconstructAll（dirStamp === null）
       ├─ 读 sessions-index.json（1 次 readFileSync + JSON.parse；失败→空索引）
       ├─ readdir + 修剪消失文件          ← 不变（record-store.ts:439-455）
       └─ 逐文件 scanFile：
            ├─ 4 次 statSync              ← 不变（record-store.ts:476-483）
            ├─ 索引查 basename：
            │    戳匹配 → 用索引 identity 构造 light（零内容读取）
            │    miss/不匹配 → head→tail→anywhere 探测（不变）→ 更新内存条目 + 标记 dirty
            ├─ sidecar payload 按需读取    ← 不变（存在的 .cancelled/.alive 才读）
            └─ buildRecord 状态矩阵        ← 不变
       └─ 扫描结束：dirty 且过节流窗 → 异步落盘索引（见 ⑤）
```

冷扫描成本变为：7k stat（几十 ms）+ 350KB 索引读 + 解析（~10ms）+ 少量 sidecar 小文件读。**186MB 的内容读取对未变化文件归零。**

#### 3.2.3 六个关键点的逐项决策

**① 索引失效粒度：per-entry 锚定戳，最细粒度。**
锚定戳 = 探测时刻 jsonl 的 `{mtimeMs, size}`（与 L1 的 Stamp 同构，`record-store.ts:91-95`）。`scanFile` 的判定：stat 当前 jsonl → 戳相等 → identity 直接复用；不等（append 过、续聊补写了 identity、文件被重写）→ 重探测该文件并更新条目。负条目同理：戳变了就重试探测（与现有负缓存语义一致，`record-store.ts:509-511`）。单文件失效不波及邻居。已知局限与 L0 同族：mtime 粒度粗糙的文件系统（NFS/2s FAT）可能漏判，APFS 微秒级可靠——代码已有同款声明（`record-store.ts:417-419`），不新增风险面。

**② 多进程并发写：无锁 + tmp(pid)+fsync+rename 原子写 + last-writer-wins 快照。**
- 原子写复刻 `ManifestStore.writeManifest` 的既有模式：`sessions-index.json.tmp.<pid>` → 写 + fsync → rename → fsync 目录（`extensions/subagent-workflow/src/execution/manifest-store.ts:97-140`，pid 后缀防两进程写同一 tmp，见 `:99`）。Windows 下 rename 覆盖语义与 manifest 完全同假设（该模式已在生产运行）。
- **不做跨进程 merge，写入内容 = 本进程本轮扫描的完整快照**（本进程 readdir 见到的所有文件的最新探测结果）。理由：读侧逐条戳校验使得「丢失更新」的代价仅仅是下次冷启动对个别文件多一次探测（均摊 ~1.5ms/文件），而 merge 会把「本轮没见到的文件」（可能是新建，也可能是已删除）永久留在索引里，需要额外修剪逻辑。快照式自清洁：GC 删掉的文件的条目，在下一次任何进程的重写中自然消失。
- **正确性不依赖写入协议**：这是本方案的核心安全性质。并发写最坏情况是 rename 竞争（读到旧版或新版，都是完整 JSON）；陈旧条目在读侧被戳校验拦下重探测。索引只能造成多余探测，**永远不会造成错误结果**——因此无需文件锁、无需 CAS、无需写入协商。
- 已知边界：多个 pi 进程**同时**冷启动（如 xyz-agent 一次开多个面板）时，第一代进程仍各自全量探测（索引尚不存在），并发收益从第二代开始。可接受——session-pool 进程是长驻的，2.7s 只付一次。

**③ 损坏/版本容错：读侧永不抛，任何异常 = 空索引 = 今天的全量行为。**
- 顶层 `version: 1`；不识别的版本 → 整体丢弃（升级/回滚场景）。读侧校验链：JSON.parse 失败 → 空；顶层不是预期结构 → 空；单条目字段类型不符（校验规则镜像 `isIdentityData`，`session-reconstructor.ts:244-254`：id/agent/mode/task/startedAt 类型 + mode 枚举）→ 丢弃该条目（该文件回退探测）。
- 版本升级（未来 v2）：v1 读者遇 v2 文件丢弃重扫后**重写为 v1** 会引发 v1/v2 互相覆盖振荡——实现时约定「读到更高版本只忽略不重写」（低于自身的才重写）。当前只有 v1，此条落为实现注意事项。
- 残留 `.tmp.<pid>`（写进程崩溃）：读侧按 listAllSync 的同款 `.tmp.` 过滤忽略（`manifest-store.ts:173`）；下次写入失败时的 best-effort 清理复刻 `writeManifest` 的 renamed 标志模式（`manifest-store.ts:128-139`）。不做 recoverTmpFiles 式恢复——索引是缓存，丢了就重算，没有恢复价值。
- 回滚兼容：装过带索引的版本再回退到旧版——旧代码不认识 `sessions-index.json`，不读不写；GC 不删它（§3.2.1 佐证 3）；无害残留，再升级时旧索引仍可用。

**④ 与现有缓存体系的关系：索引是 L1 identity 部分的持久化种子，不是独立层。**
分层后：

| 层 | 形态 | 生命周期 | 职责边界 |
|---|---|---|---|
| L-1 `sessions-index.json`（新增） | 磁盘，单一 JSON | 跨进程/跨重启 | **只持久化 identity 探测结果（正 + 负）+ 锚定戳** |
| L0 dirStamp | 内存 | 进程内 | 目录级变化检测（不变） |
| L1 fileCache | 内存 | 进程内 | identity + sidecar 矩阵 + full 懒加载 + 负缓存（加载后由 L-1 灌入种子，运行期 L0/L1 语义一字不动） |
| L2 idToFile | 内存 | 进程内 | id → file（随 L1 维护） |

运行期索引不再被读（内存 L1 已接管）；它只在冷启动被读一次、在 dirty 扫描后被写。`dispose()`/`revive()` 不与索引交互（dispose 只清内存，落盘由扫描路径驱动）。附带收益：索引加载后 L2 即热，`findLightById`（`record-store.ts:542-546`）在进程重启后无需先全扫就能 O(1) 命中——其单文件 stat 校验照常兜底陈旧条目。

**⑤ 写入时机：首轮扫描后 fire-and-forget 异步写；后续按 60s 最小间隔节流。**
- 首轮完整扫描结束即写（若本轮发生过 ≥1 次真实探测，即 dirty）：短命进程（pi CLI 一次性调用）也要能留下探测成果，否则节流可能让索引永远不落盘。
- 之后每次 dirty 扫描想写时检查距上次落盘 ≥60s（内存时间戳）。写放大评估：全量快照 350KB × 每分钟至多 1 次 × 仅在有新探测的扫描后——实际场景（目录内只有少量新文件）远低于上限。
- 异步（`fs.promises`，与 writeManifest 同）且 best-effort：写失败记 debug 日志不重试、不抛、不影响扫描结果。
- `dirty` 的判定天然存在：本轮 `scanFile` 走了探测分支（索引 miss 或戳不匹配）即为 dirty，纯命中则不写。

**⑥ 索引体积：1744 条 × ~200B ≈ 350KB，读入 ~10ms，三倍增长仍在 50ms 内——不需要分片/压缩/截断。**
体积变量主要在 `task`（任务描述文本）。即便未来涨到 5k 条 ≈ 1MB，单次 readFileSync + JSON.parse 仍在 50ms 量级，比 2.7s 低两个数量级。当前不做截断（task 是 light 列表的显示字段，截断会改变行为，违反目标 2）；若未来膨胀到影响启动，截断点在这一层，不动其他层。

---

## 4. 验收

### 4.1 性能验收：真实目录冷扫描 2.7s → ≤300ms

**结论：在真实 sessions 目录的副本上，用「新进程首次 collectRecords」的墙钟时间对比无索引/有索引两种模式，取 5 轮中位数；同时断言输出等价。**

可复现测量方法（bench 脚本随实现交付，放 `extensions/subagent-workflow/bench/cold-scan.bench.ts`，`tsx` 直接跑）：

```bash
# 0. 复制真实目录（1744 文件 / 586MB；不污染原目录）
ENC=$(ls ~/.pi/agent/subagents | head -1)   # 任取一个真实 <enc> 段
mkdir -p /tmp/bench-enc && cp -R ~/.pi/agent/subagents/$ENC /tmp/bench-enc/

# 1. 基线（无索引）：删掉索引文件，新进程跑首次 collectRecords 并计时
rm -f /tmp/bench-enc/$ENC/sessions-index.json
tsx bench/cold-scan.bench.ts /tmp/bench-enc/$ENC/sessions --rounds 5
#    每轮：new RecordStore(dir) → collectRecords(2000, "all") 计时 → dispose
#    预期（基线）：中位数 ~2.7s（与 2026-08 实测一致）

# 2. 冷启动（索引命中）：上一轮扫描已落盘索引，重跑同一命令
tsx bench/cold-scan.bench.ts /tmp/bench-enc/$ENC/sessions --rounds 5
#    判定：中位数 ≤ 300ms（预期 100-200ms：7k stat + 350KB 索引解析 + sidecar 小文件）
```

脚本内置断言（不满足即 exit 非 0）：

- 两模式输出的 `(id, agent, task, rootSessionId, status)` 列表**完全一致**（正确性等价，目标 2）；
- 索引命中模式下，对 chmod 000 的 jsonl 仍能返回全部记录（证明零内容读取，技术同现有 A1 用例 `extensions/subagent-workflow/src/__tests__/record-store-cache.test.ts:94-106`）；
- 索引文件出现在 `<enc>/sessions-index.json`（兄弟位置），sessionsDir 内 readdir 无新增文件。

### 4.2 多进程并发验收

**结论：并发场景的正确性标准是「无异常 + 最终索引是完整 JSON + 输出与单进程一致」，不要求写入不竞争。**

用脚本在同一目录上并发起 3 个 RecordStore 实例（模拟 xyz-agent session-pool 的 3 个 pi 进程），各自循环 20 次 `collectRecords`，其间外部随机 append/touch 文件制造变化：

```bash
tsx bench/concurrent-scan.bench.ts /tmp/bench-enc/$ENC/sessions --workers 3 --iters 20
```

判定（脚本断言，exit 0 为过）：

1. 3 个实例全程无未捕获异常；
2. 结束后 `sessions-index.json` 是合法 JSON（`JSON.parse` 成功且 `version` 字段存在）——原子写不被竞争破坏；
3. 目录内无残留 `.tmp.` 文件（或仅存在于写入失败注入的负向用例中）；
4. 每个实例每轮输出与「单进程全量探测」的 ground truth id 集一致（戳校验兜住了陈旧索引）。

### 4.3 单测清单（新增 `src/__tests__/record-store-index.test.ts`）

| 用例 | 断言要点 |
|---|---|
| C1 索引命中零探测 | 建索引后 chmod 000 jsonl，新 RecordStore 的首次 collectRecords 仍返回全部记录（镜像 A1 手法） |
| C2 戳不匹配单文件重探测 | append 一个文件 → 只有该文件重探测（identity 更新），其余零读取；索引条目更新 |
| C3 索引损坏回退 | 手写非法 JSON 索引 → 全量探测不崩、结果正确、索引被重写为合法内容 |
| C4 版本不识别 | `version: 999` → 整体丢弃 → 全量探测 → 重写为 v1 |
| C5 负条目命中 | 无 identity 的 junk 文件不因重启重读（复用 B5 的 junk 构造，`record-store-cache.test.ts:244-249`） |
| C6 索引位置 | 索引落在 `dirname(sessionsDir)`，sessionsDir 的 readdir 不含它；L0 快路径不被索引写入击穿（写索引后同进程再扫，dir mtime 未变 → 快路径生效） |
| C7 双实例顺序共享 | 实例 A 扫描落盘后，实例 B（新对象模拟新进程）首次扫描零探测 |
| C8 落盘完整性 | 写后无 `.tmp.` 残留；产物可被下一次加载完整消费 |

现有 `record-store-cache.test.ts` 的 A1-A4/B1-B5/D1-D2 全部必须保持绿（零行为回归的目标 2）。

### 4.4 已知接受的残留成本

- stat 校验（7k syscall，几十 ms）保留——它是变化检测的正确性机制，不属于「重复探测不变量」。
- 首代并发冷启动仍各自全量探测（§3.2.3-② 边界）。
- 多进程下索引写入采用 last-writer-wins，个别文件的探测成果可能被后写者的快照覆盖丢失 → 下次冷启动重探测一次。每次损失 ≤1.5ms/文件。

---

## 5. 下一层拆分

**结论：实现分 4 个 task，新代码集中在独立模块 `sessions-index.ts`，RecordStore 只动两个接入点；每个 task 有独立可验收的检查点。**

| # | Task | 内容 | 验收 |
|---|---|---|---|
| 1 | 索引模块 | 新建 `extensions/subagent-workflow/src/execution/sessions-index.ts`：`loadIndex(encDir)`（读 + version/条目校验，永不抛）、`saveIndex(encDir, entries)`（tmp(pid)+fsync+rename+dir fsync，复刻 writeManifest 模式）、条目类型与校验函数（镜像 `isIdentityData`） | 单测：损坏/版本/条目校验/无 tmp 残留（C3/C4/C8 的模块级部分） |
| 2 | RecordStore 接入 | 两处：① `scanFile` 探测分支前查索引（戳匹配 → 用索引 identity；miss → 探测后写回内存条目并标 dirty）；② `reconstructAll` 首扫（dirStamp 为 null 时）惰性 loadIndex + 扫描结束后按 §3.2.3-⑤ 的节流规则异步 saveIndex。索引路径 `path.dirname(this.sessionsDir)` 推导 | `npx vitest run src/__tests__/record-store-index.test.ts` 全绿 + 既有 `record-store-cache.test.ts` 全绿 |
| 3 | bench 脚本 | `bench/cold-scan.bench.ts` 与 `bench/concurrent-scan.bench.ts`（§4.1/§4.2 的可复现命令） | 在真实目录副本上跑通，cold 报告落 `.xyz-harness/2026-08-15-subagent-workflow-perf/`（数字回填本文档 §4.1） |
| 4 | 回归与文档 | `pnpm extensions:typecheck` + `pnpm extensions:lint` + 全量 `pnpm extensions:test`；README 性能段落补一句索引机制 | 三命令 exit 0 |

实现顺序 1 → 2 → 3 → 4（1 无依赖可先行；2 依赖 1；3 依赖 2；4 收口）。实现期的两个注意事项：读侧「高于自身的版本只忽略不重写」（§3.2.3-③）；索引条目的 `model` 空串是尾部探测的合法结果，不要在加载侧当损坏丢弃。
