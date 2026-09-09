# 长跑稳定性根治细分调研：按架构分层的优化项清单

> **一句话结论**：本文是 [long-run-stability-architecture.md](long-run-stability-architecture.md) 阶段一（根治）的细分调研——按四层架构（pi-extension / runtime 数据 / renderer / 进程足迹）逐层给出「现状证据（本会话第一手核实）→ 根因 → 优化方案（标注长期/短期）→ 验证方式」。最重要的新发现是进程足迹层：**实测 TaiJi 33 进程 3080MB，其中约 10 个 pi 进程（各 80-141MB）因无空闲回收机制而常驻**——30 天维度下这是比任何单条数据路径都大的内存足迹项，且修复它所需的 lazy-restore 基础设施已经全部存在。

## 0. 总原则与优先级

**根治 > 取证 > 自愈**（用户裁决，2026-09-09）。自愈是兜底；兜底先于正常路径修复落地，会把「频繁崩溃」变成「频繁静默恢复」，掩盖真实问题。本文全部优化项都属于「让崩溃不发生 / 让资源有界」的根治侧，对应架构文档的阶段一（E2 + E6）。

每层的调研方法：现状引用代码事实（标注文件:行号，本会话已第一手核实的不复查）、用真实数据量化、方案区分长期（协议/结构性）与短期（护栏）、验证写真实操作。

**层声明**：本文是调研文档，产出 = 优化项清单与依据；每个优化项落地前仍需走各自的 tech-design 流程（子系统设计），本文不替代。

## 1. pi-extension 层：崩溃源根治

**本章结论**：该层崩溃的唯一机制是「extension 未捕获的异步异常 = pi 进程死亡 = session 死亡」；优化 = 守卫原语 + 21 包普查 + 门禁探针三件套，把自有扩展的该类别崩溃结构性归零。

### 1.1 现状与根因（已实锤）

- **进程同命运**：extension 代码跑在 pi 进程内（pi 上游进程模型，项目铁律不可改）。9/3 真实崩溃（`pi-crash-2026-09-03-835c6577-*.log`）：smart-context 的 `compact_context` 在 fire-and-forget 异步回调里调用注册时捕获的 `pi` ctx（`extensions/universal/smart-context/src/tool.ts:183-191` 的 onComplete/onError），用户切走 session 后 ctx 失效，pi 的 `assertActive` 同步抛错，异步回调无人 catch，进程 exit 1。
- **GUI 放大了触发面**：CLI 用户几乎不触发 session replacement/reload；GUI 的每次切 session、新建、重载都在制造 stale ctx 窗口。
- **同构风险面**：21 个自有 extension 里所有「异步上下文中调用 `pi.*` / `ctx.*`」的代码点都是同类风险——定时器回调、事件监听、Promise then、pi 生命周期回调（onComplete/onError）。

### 1.2 优化方案

**O1-1 ext-guards 新增两类守卫原语（长期方案）**

- `guardAsync(fn)`：包一切 extension 异步回调——catch 所有异常 → extension-logger 落盘（阶段二后追加台账上报），**绝不向上抛进 pi 进程空间**。语义参照既有 `oncePerProcess` 的「守卫不吞语义、调用方决定继续」纪律：守卫只保证「异常不出回调」，业务降级文案仍由扩展自己写。
- `staleSafeCall(fn)`：包 `pi.sendUserMessage` 等 ctx 方法调用——识别 stale ctx 错误签名（"extension ctx is stale"）降级为 warn 日志，非 stale 错误原样上抛（不掩盖新问题）。
- 落点：`extensions/shared/ext-guards`（该包定位就是「pi 运行环境隐式坑守卫集中一处」，包注释自证）。

**O1-2 21 包普查 + lint 固化（长期方案）**

- 普查方法：对 `extensions/` 全包 grep 三类模式——①异步回调体内的 `pi\.` / `ctx\.` 调用（`.then(`、`setTimeout`、`setInterval`、事件监听、`onComplete`/`onError` 参数内）；②裸 Promise 不带 catch；③跨 factory 调用的闭包捕获。产出清单逐包接入 O1-1 原语。
- 固化：taste-lint 新增规则（如 `no-unguarded-async-pi-call`），extensions 三连（typecheck/lint/test）把「新增未守卫的异步 pi 调用」变成 CI 拦截项——普查是一次性的，lint 是防回归的。

**O1-3 pi 版本门禁探针（长期方案）**

- stale ctx 错误消息串（"This extension ctx is stale after session replacement or reload"）纳入 `scripts/check-pi-semantics.mjs` 探针族——pi 升级若改变该文案，`staleSafeCall` 的识别会静默失效，门禁在升级 PR 拦截（受 C-proc-08 版本门禁既有机制托管）。

### 1.3 验证（真实场景，非单测）

按项目铁律「extension 改动优先在本地 pi CLI 实测」：`pi --mode rpc --session-dir <tmpdir> --extension <本地包路径>` + stdin JSONL——①触发 `compact_context` 后立即 `switch_session`，改造前进程 exit 1（复现 9/3），改造后进程存活 + 日志出现 stale 降级 warn；②任选 3 个其它包的异步回调注入 throw，验证 guardAsync 落盘不逃逸。

### 1.4 残余风险（诚实声明）

第三方扩展不受我们守卫覆盖——该项由架构文档阶段三的 respawn 兜底（已降级为最低优先级），台账计数（阶段二）先行观测其真实频率再决定是否立沙箱项。

## 2. runtime 数据与内存层：OOM 路径根修

**本章结论**：runtime 侧共五条无界数据路径（A-E），其中 A（活跃 session 全量历史）与 B（全量读 fallback）是 9/9 renderer OOM 的直接机制链；全部根修方向是「按预算读取/驻留/下发」，pi RPC 无倒序分页是唯一外部约束（中间传输成本为已接受代价）。

### 2.1 全链路内存放大机制（为什么要修）

一个 198MB 的 session（本机实测存在）在「切回该活跃 session」时的全链路：

```
pi 内存 entry 树（常驻，~198MB 级）
  → getEntries RPC：JSON 序列化全量 → runtime parse 出 entries 数组（对象图膨胀 2-4x）
  → rebuildHistoryFromEntries 重建 Message[]（再一份）+ HistoryRebuildCache 缓存全量（再一份，LRU=8 可再 ×8 个 session）
  → WS 帧 JSON.stringify 全量（~200MB 字符串）→ renderer JSON.parse（UTF-16 ~2x + 对象图）
  → messages ref（一份）+ entryStates reducer 累积态（含未截断 tool output/images，再一份）
```

叠加峰值 GB 级，两个进程（runtime + renderer）同时承压——9/9 的 renderer SIGTRAP（V8 malloc 失败立即 crash）与 runtime 侧内存尖峰都由此来。已第一手核实关键代码点：`history-rebuild-cache.ts:219-252`（分支 3 `client.getEntries()` 不截断、`truncated:false`、注释自证「get_entries 不截断」；缓存 set 全量 messages）。

### 2.2 优化项

**O2-A session.history 分页预算协议（长期方案，最大单项）**

- 协议：`session.history` 响应按「turn 数 + 字节数」双预算截断（如默认 20 turn 且 ≤2MB），`truncated:true` + 翻页游标；「加载更多」从「全量再拉一遍」（`getFullHistory`，`history-rebuild-cache.ts:328-334` → `getHistoryFromFilePath` 全文件读）改为游标翻页。
- 活跃路径同样受限：getEntries 拿到全量 entries 后在 runtime 侧截窗口——**诚实声明外部约束**：pi 的 `get_entries(since)` 只有正向增量游标、无 tail/range 参数（不可改 pi），所以「pi→runtime 的全量传输」中间成本无法消除，能消除的是：全量驻留（缓存只留窗口）、全量下发（帧只含窗口）、renderer 全量 parse。中间峰值用「restore 后首屏走文件尾读（快照已有 20 turn 尾读原语）+ 后台增量 reconcile 收敛」缓解，具体取舍留给子系统设计。
- 缓存改制：HistoryRebuildCache 从「全量 messages ×8 session」改为「窗口 messages ×8」；since 增量游标语义不变（leafId 照常推进）。

**O2-B 全量读 fallback 的逆序分块化（长期方案）**

- 现状（第一手核实，`session-history.ts:150-186` + `tailReadHistory`）：尾读窗口 = max(256KB, maxTurns×32KB)（20 turn ≈ 640KB）；**窗口内 user turn 数不足 maxTurns 即 fallback 全量 `readFile` + `parseJsonl`**——198MB 文件（大 tool result 使单 turn 远超 32KB）几乎必触发：runtime 全量读 + 全量 parse + 全量对象图，只为取最后 20 turn。
- 根修：扩展 `readTailBytes` 原语为**逆序分块扫描**——从文件尾按块（如 1MB）向前读，凑满 maxTurns 个 turn 边界或达字节上限（如 16MB）即停；全量读只保留给「文件本身 ≤ 上限」的小文件路径。
- 同型修复两处：①`findLastEntryField` 的 fallback `readFileSync` 全量（`session-file-utils.ts:522-530`）——**每次 pi 进程退出**时 `extractSessionOutcome` 触发，198MB 文件意味着「崩溃收尾本身制造内存尖峰 + 同步 IO 阻塞事件循环数秒」（有被 30s×3 liveness 探针误判半死的风险）；②`readSessionJsonlText`（`session-store.ts:92-99`，trace 视图降级路径）。
- 短期护栏（先行）：三处 fallback 入口加 `statSync` 大小预检——超限（如 64MB）时记 warn + 走降级（尾读/跳过），不做全量读。

**O2-C tee 日志轮转（短期方案，独立可先行）**

- 现状：pi stdout tee 到 `pi-<date>-<sessionId>.jsonl`，单文件无上限（本机实测 198MB）；既有 `cleanExpiredLogs` 只按 7 天保留期删除，窗口内无界。
- 修复：按大小轮转、分段文件名保持 `pi-` 前缀（兼容既有清理白名单）、保留末 N 段（tee 的价值是「pi 卡死时的决定性证据」，现场在尾部）。此项推翻 `logger.ts` 的既有「不轮转」裁决，实施时同 commit 登记推翻（架构文档 D6③ 已声明）。

**O2-D 内存水位打点（短期方案，先行嵌入）**

- 每 5 分钟一行 `process.memoryUsage()` 到 runtime 主日志（继承轮转与保留期）。这是验证 O2-A/B/C 有效性的最低观测面，从架构文档的 E1 提前到阶段一；不需要完整台账基建。

### 2.3 验证

构造 ≥50MB 真实大 session（复制本机已有的 198MB 文件改名注入 session 目录）：①切回该（离线）session——改造前 runtime 日志出现全量读 warn + 内存水位尖峰，改造后水位平稳、UI 20 turn 秒开；②「加载更多」翻页不再触发全量帧（WS 帧大小可从 runtime 日志/水位旁证）；③水位曲线在反复切入/加载更多操作后回落（无单调爬升）。

## 3. renderer 层：驻留有界化

**本章结论**：renderer 的根修点是三个「只增不减」——entryStates 全量累积、toolResult images 不截断、截断白名单覆盖面；渲染性能项（markdown 增量）是体验问题不是崩溃源，降级为 P2。

**O3-A entryStates 累积态截断（长期方案）**

- 现状（第一手核实，`packages/core/src/domain/chat/store.ts:348, 798-799`）：`applyEntry` 把每条 entry 全量喂进 per-session reducer 累积态，含**未截断的 tool output 全文与 base64 图片**（`truncate-tool-output.ts` 注释明言「reducer 侧不截断，保留全量」）；直到 LRU 驱逐（容量 8 + 豁免集）或 dispose 才清。
- 修复：入累积态前过与 messages 同款的截断（复用 `truncateToolOutputBatch`）；前提是核实全部消费方（W22 对账基线、hydrate 重放、虚拟分区投影）不依赖全文——若对账只比形状/ID，截断安全；依赖全文的消费点单独豁免。此项需在子系统设计里逐消费点列表（接管既有流程的副作用逐段归属）。

**O3-B toolResult images 落盘引用化（长期方案）**

- 现状：`normalizePiToolResult` 提取 `images[]` 进消息（`apply-entry-utils.ts:89-93`），全链路（事件帧 → messages ref → entryStates）不截断；用户贴图已有磁盘通路（`shared/src/segments.ts`，不进内存）——toolResult 图片复用该模式：runtime 落盘 + 消息只带引用，renderer 按需加载。

**O3-C 截断策略反转：白名单 → 豁免名单（长期方案）**

- 现状（第一手核实，`truncate-tool-output.ts:32-37`）：`TRUNCATE_TOOLS = {read, bash, cat, grep, glob, list}` 六个 + MCP 末段匹配；write/edit 刻意不截，**其它任何工具名（含 MCP 末段不匹配者）的 output 都不截**。
- 修复：反转为「默认截断 + 豁免名单」（write/edit/结构化 `details.__gui__` 豁免）——与「pi 适配层不信任外部格式」既有原则同构：新工具/MCP 工具的大输出默认有界。需过一轮 GUI 显示回归（豁免名单遗漏会显示截断标记，属可发现的失败形态）。

**O3-D WS 入站大小守卫（短期护栏）**

- `ws-client.ts:224` 对 `event.data` 直接 `JSON.parse` 无大小检查；加阈值守卫（如 8MB，配合 O2-A 后正常帧都小），超限丢弃 + 错误上报。上游 `MAX_WS_PAYLOAD_BYTES` 16MB 只管 client→server 方向（`constants.ts:124` 校准注释只算了贴图上行），server→client 不设防是缺口。

**P2（非崩溃源，登记不展开）**：streaming 超长消息的 markdown 每帧全文行扫描 + 前缀整体拷贝（`markdown.ts:856-892, 1063`，MB 级消息 O(n²) CPU）——归 `taiji-renderer-optimize` skill 领地；LRU 豁免卡死面已被既有 streaming idle 30min 收口定时器覆盖（`store.ts:83`，豁免条件依赖待核实项在子系统设计确认）。

### 3.1 验证

真实大 session 下：①切 session 后 renderer 内存（`performance.memory` / Activity Monitor）不随切入次数单调爬升；②带大 toolResult 图片的会话往返切换，内存回落；③豁免名单反转后全类型工具消息显示正常（含截断标记的显示形态）。

## 4. 进程足迹层：空闲回收缺失（本次调研最大新发现）

**本章结论**：pi 进程一旦 attach 就常驻到 session 删除或 runtime 重启——process-manager 无 idle 概念（grep 全文件无 idle 回收逻辑，`destroySession/safeDestroy` 只在 create/restore/fork/delete 生命周期路径调用）。30 天使用几十个 session 后，pi 进程群是数 GB 级的系统内存常驻项，是 9/9 系统级 swap 耗尽（案例三）的重要背景构成。

### 4.1 实测证据（2026-09-09 晚快照）

- TaiJi 全家 **33 进程、总 RSS 3080MB**：renderer 432MB、main 139MB、**约 10 个 `pi --mode rpc` 进程各 80-141MB（合计约 850MB+）**、其余为 helper/worker。
- 同机还有 dev 实例（fix-composer-model-chaos worktree）并行运行——dev/prod 并行是常态使用模式，系统内存是共享池。
- 本机另一背景：20 天 uptime、swap 11GB/12GB、物理空闲 ~170MB——**app 自身足迹每多 1GB，都直接推高整机 OOM 概率**。

### 4.2 优化项

**O4-A 空闲 pi 进程回收（长期方案，需独立技术设计）**

- 机制：超过空闲阈值（如 2 小时）且无进行中工作的 session（无 streaming、无 pending、无 subagent relay 活跃、无 compact）→ 优雅终止 pi（SIGTERM 等 flush）→ session 标记 detached。用户切回时走**既有** `ensureActive → restoreSession` 惰性恢复（`session-service.ts:567-586`）——lazy-restore 基础设施天然支持，这正是当初选 lazy 架构的隐形红利。
- 权衡（设计时定量）：切回延迟 1-3s（restore + switchSession 附着）vs 常驻 85MB/session；回收策略要防抖（频繁切换的热 session 不该被回收——空闲阈值按 recency 分级，如 30min 内活跃过的不回收）。
- 与架构文档的关系：这是 G3（资源有界）在进程维度的对应物，数据路径（§2/§3）管内存维度，O4-A 管进程维度；两者合起来才是完整的足迹治理。
- 诚实声明：本项改变「session 常驻」为「按需复活」，与用户对「后台 session 持续工作」的预期有交互（后台 subagent 工作流跑数小时的场景必须豁免）——豁免判定（relay 活跃、hidden 公共 session、后台任务注册表）是设计核心，不是简单定时器。

**O4-B dev/prod 并行治理（运营项 + 短期护栏）**

- 运营：不用时关闭 dev 实例（每实例自带 runtime + renderer + pi 群）。
- 护栏（短期）：dev 实例曾出现操作 prod 路径的 warning（provider-store migration 对 `~/.xyz-agent` 路径的 rename 尝试，9/5 日志实锤）——dev 启动时对 `getDataDir()` 指向 prod 目录的情形 fail-fast 或显著警告，防止 dev 数据写穿隔离（架构文档 V7 已有对应验收判据）。

## 5. 优化项总表（落地顺序建议）

| # | 层 | 优化项 | 性质 | 依赖 | 消灭的故障 | 建议批次 |
|---|---|---|---|---|---|---|
| O2-C | runtime | tee 日志轮转 | 短期 | 无 | 磁盘无界 + 取证断裂 | 批次 1（独立可先行） |
| O2-D | runtime | 内存水位打点 | 短期 | 无 | 观测盲区（后续项的验证依赖） | 批次 1 |
| O2-B' | runtime | 全量读 fallback statSync 预检护栏 | 短期 | 无 | 崩溃收尾变内存尖峰的恶性循环 | 批次 1 |
| O1-1/2/3 | extension | 守卫原语 + 21 包普查 + 门禁探针 | 长期 | 无 | pi 进程崩溃的最大已实锤源（9/3） | 批次 2（根治核心） |
| O3-D | renderer | WS 入站大小守卫 | 短期 | 无 | 异常帧打爆 renderer | 批次 2 |
| O2-B | runtime | fallback 逆序分块化 | 长期 | 无 | 大文件全量读内存尖峰 | 批次 3 |
| O2-A | runtime | history 分页预算协议 | 长期 | 无 | 9/9 OOM 直接机制链 | 批次 3（最大单项） |
| O3-A/B/C | renderer | entryStates 截断 / images 落盘 / 截断反转 | 长期 | 无 | renderer 驻留无界 | 批次 3 |
| O4-A | 进程 | 空闲 pi 回收 | 长期（独立设计） | 无 | 30 天进程足迹只增不减 | 批次 4（独立 tech-design） |
| O4-B | 进程 | dev/prod 隔离护栏 | 短期 | 无 | dev 写穿隔离 | 批次 1 |
| — | renderer | markdown 增量扫描 | 长期（体验） | 无 | CPU 热点（非崩溃源） | 择机（taiji-renderer-optimize） |

批次逻辑：批次 1 = 零风险护栏 + 观测（为后面所有项提供验证手段）；批次 2 = 崩溃源根治（extension 三件套是最高性价比——直接消灭已实锤的进程崩溃类别）；批次 3 = 内存路径协议化（三个大项可并行）；批次 4 = 进程维度（独立设计，交互面最广）。

## 6. 与架构文档的衔接

- 本文 = 架构文档 §5 阶段一（E2 + E6）的细分展开：O1-* 对应 E2（extension 遏制），O2-*/O3-* 对应 E6（资源治理），O4-A 是 E6 在进程维度的自然延伸（架构文档未单列，建议实施时并入 E6 范围登记）。
- 阶段二（取证 E1/E7）与阶段三（自愈 E3/E4/E5）不受本文影响；水位打点（O2-D）即架构文档 E1 中提前到阶段一的那部分。
- 每个批次落地前走 tech-design 流程出子系统设计（本文是调研依据，不是实施 SSOT）；批次 1 的三个短期项足够小，可直接按修复流程实施 + 增量测试。

## 附：本会话第一手核实清单（可信度声明）

| 事实 | 位置 | 核实方式 |
|---|---|---|
| 活跃 session getHistory 全量不截断、缓存持全量 | `history-rebuild-cache.ts:219-252` | 直接读码（含注释自证） |
| 尾读窗口 640KB + turn 不足 fallback 全量读 | `session-history.ts:150-186, 222-262` | 直接读码 |
| TRUNCATE_TOOLS 六工具白名单 + 4KB | `truncate-tool-output.ts:32-37` | 直接读码 |
| entryStates 全量累积 + LRU 豁免集 | `store.ts:348, 465-530, 798-799` | 直接读码 |
| 无空闲 pi 回收 | `process-manager.ts` 全文件 grep idle 零命中；destroy 仅生命周期路径 | grep + 调用面枚举 |
| TaiJi 33 进程 3080MB、~10 pi 进程 850MB+ 常驻 | `ps aux` 实测快照（2026-09-09 晚） | 系统实测 |
| 198MB 单 tee 文件、7 天保留期窗口内无界 | `ls -la` + `logger.ts` cleanExpiredLogs 逻辑 | 系统实测 + 读码 |
| findLastEntryField 同步全量 fallback 在 pi 退出路径触发 | `session-file-utils.ts:522-530` + session-service 调用点 | 子代理读码（架构文档审查已交叉核实） |
