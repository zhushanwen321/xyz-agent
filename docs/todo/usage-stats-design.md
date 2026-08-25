# 用量统计页 · 技术设计

> 层声明：本文是**技术方案层**设计（上一层：`docs/page-design/usage-dashboard.md` UI 设计提案；下一层：可实现的 Wave 代码任务）。执行完成后本文归档（稳定结论沉淀 ADR / design-tokens，本文删除）。
> 数据源事实与 UI 方案在前序文档已定稿，本文不重复论证，只解决「怎么实现」。

## 1. 背景目标

**一句话结论**：在 Settings 内新增「用量」页，从 session JSONL 离线聚合出分 provider / model / 日期 / 项目的用量数据，前端以 6 主题自适应的图表台账呈现。

**SCQA**

- S（情境）：xyz-agent 每条 assistant 消息的 token 用量与费用已随 session JSONL 落盘（`entry.message.usage`）。
- C（冲突）：这些数据从未被聚合展示，用户（跨 5+ provider 的重度多模型用户）无法回答「我这个月 token 花了多少、花在哪个模型/项目上」。
- Q（问题）：如何在不改 pi 的前提下，把这些存量数据变成可信、美观、主题自适应的用量视图？
- A（答案）：runtime 侧新增惰性扫描聚合服务 + 一个 WS RPC，renderer 侧按已验证的 demo（`docs/page-design/usage-dashboard.html`）实现 Settings 内嵌页。

**系统背景**（面向不熟悉内部的开发者）：xyz-agent 是 Electron 桌面应用，三层结构——Electron 主进程（窗口）/ Runtime（Node WebSocket 服务，pi 子进程宿主）/ Renderer（Vue 3）。Settings 是 renderer 内全屏 overlay（左 nav + 右 content，`SettingsModal.vue` v-if 链切换页面，无 vue-router）。session 数据文件在 `~/.xyz-agent/pi/sessions/`（实测平铺结构，非 cwd-slug 子目录；当前 15 个 `.jsonl` / 16MB，与全局 pi CLI 目录 `~/.pi/agent/sessions/` 完全隔离）。

**设计目标**（从使用者体验倒推）

| # | 目标 | 来源 |
|---|------|------|
| G1 | 用户打开页面 2 秒内看到全量聚合数字，且数字可被独立手算复核 | 「可信」 |
| G2 | provider / model / 日期 / 项目 四维可查、可联动过滤 | 需求原话 |
| G3 | 6 套主题（玄/黛蓝/暖墨/皓/青墨/朱印）下图表色自动跟随，无写死色值 | 用户明确要求 |
| G4 | 空数据、订阅制 cost=0、扫描部分失败等边界不出现误导性展示 | 水墨克制哲学 |

**In scope**：`~/.xyz-agent/pi/sessions/` 目录聚合；Settings 内嵌页；6 主题适配。
**Out of scope**（明确不做，防止 scope 蔓延）：全局 pi CLI 目录（`~/.pi/agent/sessions/`，4603 文件 / 2.6G，需 Worker + offset 增读体系，二期另设计）；费用重算（ccusage `--mode calculate` 式，透传 pi 落盘值即可）；预算告警 / 导出 / 5h 计费窗口（demo 文档 §六 二期候选）；pi 侧任何改动。

## 2. 现状与问题分析

**首句结论**：数据在磁盘上是完整的，缺口在「无聚合层、无传输层、无展示层」三处；且实时链路（event-adapter）故意只透传 3 个字段，不可复用。

### 2.1 数据源现状（已用真实文件验证，非推断）

每条 `type: "message"` 且 `role: "assistant"` 的 entry：

```jsonc
// ~/.xyz-agent/pi/sessions/<slug>/<ts>_<uuid>.jsonl 第 N 行（真实数据摘录）
{
  "type": "message",
  "timestamp": "2026-08-23T05:13:44.530Z",       // UTC ISO，逐条都有
  "message": {
    "provider": "kimi-coding",                      // provider 维度
    "model": "k3-256k",                             // model 维度
    "usage": {
      "input": 27985, "output": 70,
      "cacheRead": 512, "cacheWrite": 0, "reasoning": 8,
      "totalTokens": 28567,
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 }  // USD；订阅制恒 0
    }
  }
}
```

三个关键事实（已用真实文件验证，非推断；审查轮 2026-08-25 复核修正）：

1. **非 assistant entry 的 usage 计入规则必须带守卫**：compaction entry 带 usage（**在 entry 顶层，非 `message.` 下**）但**无 provider/model 字段**；branch_summary 实测 12/12 **不带 usage**。pi 官方聚合（`getUsageCostBreakdown`，锚点：@earendil-works/pi-coding-agent@0.84.1 `dist/core/usage-totals.js:22-33`，升级 pi 须重核）的三分类才是权威口径：① assistant message ② `role==='toolResult' && message.usage`（本机 0 条，但 subagent 场景是 pi 明确支持的形态）③ `{compaction, branch_summary} && entry.usage`——后两类归入 `"Tools/summaries"` 虚拟桶，且都带 usage 存在性守卫。另：model key 用 `responseModel ?? model`（实测 65% 消息两者大小写不同，如 `GLM-5.3` vs `glm-5.3`）。
2. **量级与文件形态**：15 个 `.jsonl` / 16MB，全量逐行解析毫秒级；文件 append-only；但首行不保证是 session entry（3/15 旧文件首行为 `session_info`，session 在第 2 行）；且存在 `.tmp-migrate-*.jsonl` 归一化崩溃残留（内容为合法 session 拷贝，必重复计入，须排除）。
3. **session 归属项目**：文件内 session entry 带 `cwd`。注意：现有 `scanPiSessions()` 的 `parseSessionHeader` 只读首行，首行非 session 即丢弃文件（3/15 被丢）——**用量统计不可复用它做文件发现**（与 G1 全量矛盾），见 §3.3 D8。

**审查轮事实修正记录**（2026-08-25 对抗式审查）：branch_summary 不带 usage（原断言「已验证」不实，仅 compaction 属实）；首行 session entry 不保证（3/15 旧文件首行为 session_info）；目录实测平铺 15 文件/16MB；assistant 消息 65% 存在 responseModel/model 大小写差异。详见审查报告与本文各修正点。

### 2.2 缺口与根因

| 层 | 现状 | 根因 |
|----|------|------|
| 聚合 | 仓库内无任何 usage 聚合逻辑（explorer 全仓 grep 确认） | 从未有人需要 |
| 传输 | event-adapter L326 只透传 `{inputTokens, outputTokens, totalTokens}` 给 context bar | 该链路语义是「当前 session 上下文水位」，非历史统计；cacheRead/cacheWrite/cost 根本不过 runtime→renderer 这条线 |
| 展示 | 无页面 | —— |
| 类型 | `packages/shared/src/pi-entry.ts` 中 `usage?: unknown` | 从未消费 |

**现状物理数据流**（数字怎么到达用户眼前）：

```
pi 子进程 → (WebSocket 事件) → EventAdapter → [仅 3 字段] → renderer context bar（当前 session 水位）
                                                                    ↑ 历史用量在这条线上不存在

磁盘 ~/.xyz-agent/pi/sessions/*.jsonl（完整数据，含 cost/cache）
  └─ 目前只有 SessionScanner 为「session 列表」读它 → 与用量无关
```

根因一句话：**用量数据唯一的完整载体是磁盘 JSONL，任何方案都必须从文件读起**；实时事件链路既不够用也不该复用（语义不同）。

## 3. 解决方案

### 3.1 终态（使用者视角）

成功路径：用户点 Settings → 用量（nav 第 12 项）。页面 2 秒内呈现（首扫）摘要台账行（总 Token / 费用 / 消息数 / 活跃天 / 缓存命中率 / 峰值日）、每日消耗堆叠柱（hover 出 ↑输入/←命中/↓输出）、16 周热力日历、模型谱 / 项目谱 / 缓存构成、明细台账。图例点 provider 开关过滤、模型行点击单看、范围 7/30/90/全部、指标 Token⇄费用。右上角「数据截至 HH:MM」标注。

失败/边界路径（每条带恢复指引）：

- 无任何 session（全新安装）→ 空态：「还没有会话记录。开始一次对话后，这里会出现你的用量台账。」（引导而非报错；恢复动作 = 正常使用产品）
- cost 全 0（纯订阅制用户）→ 费用列/指标降级为 dim 色 + `—`，不显示 `$0.00` 误导
- 个别行解析失败 → 跳过并在页脚 footnote 显示「跳过 N 行无法解析的记录」；恢复动作 = 无需用户处理（损坏行本就不可归因），透明披露即可
- WS 请求失败 → 页面错误态 + 「重试」按钮（点击重新 `usage.getStats`）

### 3.2 方案对比

**决策 A：聚合架构**（怎么把文件变成聚合数据）

| 方案 | 长期架构合理性 | 短期成本 | 风险 | 结论 |
|------|---------------|----------|------|------|
| A1 惰性全扫 + 内存缓存（mtime 索引） | 数据量增长后可平滑升级为 offset 增读（append-only 性质保证）；无持久化状态 = 无缓存失效难题 | 低（一个 service 类 + 单测） | 数据量大后单次全扫变慢（二期全局目录才触发） | **推荐** |
| A2 预聚合持久化缓存（usage-cache.json） | 引入「缓存 vs 源」一致性问题（文件被删/改/时间回拨）；18 文件规模下收益为零 | 中（缓存 schema + 失效逻辑 + 迁移） | 缓存漂移是统计页最伤信任的 bug | 否。若用 A2，§2.1 的手算复核场景（S1）将依赖缓存正确性而非源数据，验证面翻倍 |
| A3 pi extension 实时累计（hook 逐条上报） | 数据实时性最好；但统计页不需要实时（打开时扫即可），且引入 extension 生命周期/版本耦合 | 高（新 extension + 与 runtime 双写口径） | 与 20 个现有 extension 的职责边界冲突；「不改 pi 侧」红线边缘 | 否 |

A1 细节：`Map<filePath, mtime>` 缓存；getStats 时枚举文件，mtime 全等 → 直接返回缓存行集；有变化 → 仅重读变化文件（append-only 下全文件重读毫秒级，行级 offset 缓存 YAGNI）。

**决策 B：聚合执行位置**

- B1 runtime 主进程（推荐）：基建（`getSessionsDir()`）在 runtime、数据在 Node 侧、传输的是聚合后的 KB 级行集而非 MB 级原始数据。16MB 同步解析在 Node 事件循环上是毫秒级，不值得 Worker。
- B2 renderer 直接读文件：Electron 下 renderer 无文件系统权限（preload 白名单），需打洞，违反现有隔离架构。否。

**决策 C：RPC 返回粒度**

- C1 细粒度行集 `UsageRow[]`（day × provider × model × project 一行），前端聚合（推荐）：返回体几十 KB；前端切片逻辑在 demo 中已实现验证（`aggregate()`）；换视图/过滤器零往返。
- C2 runtime 预聚合多视图（byDay/byModel/byProject 各一套）：协议僵硬——demo 迭代中「缓存构成」「项目×provider 堆叠」都是后加的视图，C2 下每次改视图都要动 runtime+协议。否。

### 3.3 关键决策与权衡

- **D1 非主模型 usage 归属**：独立虚拟桶 `provider: 'compaction'`，计入条件对齐 pi `getUsageCostBreakdown` 三分类（见 §2.1 事实 1）：assistant 消息 / toolResult-with-usage / {compaction, branch_summary}-with-usage，**均带 usage 存在性守卫**（branch_summary 实测不带 usage，无守卫直接产出 NaN 行）。桶内 `messages` 语义 = 事件数（压缩/摘要次数），明细表分组名「压缩 / 摘要」。被否：跟随 session 主模型（compaction 可能跨模型执行，猜测归属 = 编造数据）。
- **D2 cost 透传不重算**：直接累加 pi 落盘的 `cost.total`（当时的费率快照）。被否：按当前 models.json 费率重算历史（ccusage `--mode calculate`）——历史费用本就取决于当时费率，重算反而失真，且引入费率表依赖。
- **D3 图表手写 SVG，不引图表库**：demo 已验证手写 SVG 可覆盖全部 7 个视图；6 主题机制依赖 CSS 变量（`style="fill:var(--chart-p1)"`），图表库的主题要 JS 层重配且增加打包体积/CSP 面。被否：ECharts/Chart.js。
- **D4 挂 Settings nav 而非独立视图**：与 Provider/Skill 等平级，符合「统计是配置域信息」的心智；独立视图需动 AppShell 路由，改动面大。demo 即此形态。
- **D5 图表派生 token 登记 SSOT**：`--chart-ink / --chart-p1..p5 / --heat-0..5 / --cache-*` 登记进 `v6-tokens.css` + `style.css`（6 主题块），机制已在 demo 验证（青墨 C=0.023 H=196°、朱印 C=0.053 H=31°）。**阻塞项**：5 处 dim/mid 对比度修正提案（demo 文档 §四表）需产品拍板后一并落地，否则新页面直接复刻不达标值。
- **D6 日期聚合时区**：`entry.timestamp` 是 UTC，聚合按**本机时区**取 date（runtime 与用户同机，「今天」以用户感知为准）。实现用 `Intl.DateTimeFormat` 本地化取 YYYY-MM-DD，禁止 `toISOString().slice(0,10)`（UTC 切日会让晚 8 点后的用量算到「明天」，G1 手算复核必炸）。验收 S1 的手算脚本同样用本地时区切日。
- **D7 活跃 session 口径**：以文件为准（pi 首次 flush 前文件可能不存在，[HISTORICAL] 禁止触碰 session 文件）。进行中 turn 的用量在下一次 flush 后进入统计；页面「数据截至」标注为最后扫描时间，不追求与 context bar 实时一致。
- **D8 扫描器自建文件发现，不复用 scanPiSessions**：`scanPiSessions()` 的 `parseSessionHeader` 只读首行、首行非 session entry 即丢弃文件（实测丢 3/15），且无目录参数（受 XYZ_AGENT_DATA_DIR 控制）、其目录缓存有 1s TTL——与 G1 全量 + S6 测试参数化双双冲突。自建：构造函数接受 `sessionsDir`（缺省 `getSessionsDir()`），readdir + stat 自取 (mtimeMs, size)，文件过滤复刻 `isScannableSessionFile` 规则（排除 `.tmp-migrate-*.jsonl` 残留——内容为合法 session 完整拷贝，不排则重复计入）；cwd 提取为「逐行读至首个 type=session entry（容错 session_info 首行的旧文件）」。
- **D9 缓存分片与双键**：per-file 分片缓存 `Map<filePath, {mtimeMs, size, rows, skippedLines, cwd}>`，失效比对 `(mtimeMs, size)` 双键（同 ms 内并发 append mtime 不变但 size 变——本仓 `CachedSessionMeta` 的 [HISTORICAL] 教训 INVAR-cache-2，只存 mtime 会命中 stale 行集）；增量重扫 = 丢变化/删除文件的分片、重读拼接；skippedLines 按分片存、getStats 求和（避免全量累计被未变文件旧值污染）。
- **D10 model 维度取 `responseModel ?? model`**：对齐 pi 口径（实际响应模型优先）。实测 65% 消息 `responseModel` 与 `model` 大小写不同（router 场景），不合并则模型谱出现 `GLM-5.3` / `glm-5.3` 双条目。

### 3.4 接口规格

**共享类型**（新增 `packages/shared/src/usage-stats.ts`，同步 index.ts 导出）：

```ts
export interface UsageMetrics {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  costUSD: number;        // pi cost.total 逐条累加（D2 透传不重算）
  messages: number;       // assistant 消息条数；compaction 桶 = 压缩/摘要事件数（D1）
}
export interface UsageRow extends UsageMetrics {
  date: string;           // 'YYYY-MM-DD' 本机时区（D6）
  provider: string;       // compaction/summaries 归 'compaction' 虚拟桶（D1）
  model: string;          // responseModel ?? model（D10）；compaction 桶固定 'compaction'
  project: string;        // session entry cwd 的 basename；无 cwd → '(unknown)'
}
export interface UsageStatsResult {
  rows: UsageRow[];
  scannedAt: number;      // epoch ms，页面「数据截至」
  sessionCount: number;   // 参与聚合的 session 文件数
  skippedLines: number;   // 解析失败行数（footnote 披露；分片求和，D9）
}
```

行集规模上界估算：120 天 × 有数 组合（≤5 provider × ≤2 model × ≤6 project 实际去重后同日同组合合并）≈ 数百行，≈ 几十 KB。

**WS RPC**（新增 `usage-message-handler.ts`，按现有 handler 模式挂 `server.ts` 中央分发表）：

```
请求: { type: 'usage.getStats', id, payload: {} }
应答: { type: 'usage.getStats:result', id, payload: UsageStatsResult }   // 命名对齐现有 <request>:result 惯例（quota.fetch:result / worktree.list:result）
错误: sendError('usage_scan_failed', message, id, { hint })      // hint 指向恢复动作
```

**协议登记（硬前置，漏则编译不过）**：`packages/shared/src/protocol.ts` 四处——ClientMessageType 联合（~L109）+ ClientMessageMap payload（~L507）+ ServerMessageType（L647）+ ServerMessageMap（L1379）+ ReplyPayloadMap（~L1520）。`reply<T>` 与 renderer `command<K>` 均按这些类型表校验。

无请求参数（C1：前端拿全量行集自行切片；range/metric 过滤是纯前端状态）。

**扫描服务**（新增 `packages/runtime/src/services/usage/usage-stats-service.ts`，分片缓存见 D9）：

```ts
interface FileShard {
  mtimeMs: number; size: number;
  rows: UsageRow[];        // 该文件全部 usage 行（含 date/provider/model/project 维）
  skippedLines: number;   // 分片存，getStats 求和
  cwd: string | null;     // 首个 type=session entry 提取（容错 session_info 首行）
}
export class UsageStatsService {
  constructor(sessionsDir: string = getSessionsDir())   // S6 测试注入空目录（D8）
  private shards = new Map<string, FileShard>();        // filePath → 分片

  async getStats(): Promise<UsageStatsResult>           // readdir+stat 比对 (mtimeMs,size) 双键 → 变化/新增重读、删除丢分片 → 拼装
  private async scanFile(filePath: string, stat: Stats): Promise<FileShard>   // readline 流式
}
```

实现要点（计入规则对齐 pi 三分类，见 §2.1 事实 1 / D1）：① `type==='message' && message.role==='assistant' && message.usage` 计入主桶（model 取 `responseModel ?? model`）；② `type==='message' && message.role==='toolResult' && message.usage` 与 ③ `type in {compaction, branch_summary} && entry.usage`（**usage 在 entry 顶层**）计入 compaction 虚拟桶；其余 continue。文件过滤复刻 `isScannableSessionFile`（排除 `.tmp-migrate-*.jsonl`）。

**renderer 侧**：`api/domains/usage.ts`（按 domains 现有模式）；`UsagePage.vue` 单页组件 + 七个子组件（Ledger / DailyChart / HeatCalendar / ModelRank / ProjectRank / CacheMix / DetailTable，DOM/CSS 从 demo 移植 TS 化）；状态用页面局部 `ref`（不进 Pinia——Settings 有 Pinia 先例（quota/preset）但均为跨组件共享场景，本页无共享方，与多数 Settings 页一致；若 Header 将来要用量徽标再升级）。SettingsModal 内容列 `--content-max-w: 720px` 对本页局部 class 放宽（1064px，不动全局 token）。

**物理数据流图**（终态）：

```
磁盘 ~/.xyz-agent/pi/sessions/*.jsonl（排除 .tmp-migrate-*）
  │ ①usage.getStats（打开页面时）
  ▼
UsageStatsService（runtime，构造时注入 sessionsDir）
  │ readdir+stat 比对 (mtimeMs,size) 双键 → 未变文件用分片缓存；变化/新增流式重读；删除丢分片
  │ 计入（pi 三分类，均带 usage 守卫）：assistant / toolResult-with-usage / {compaction,branch_summary}-with-usage
  │ 拼装：UsageRow[]（day×provider×model×project，model=responseModel??model）
  ▼ ctx.reply('usage.getStats:result', {rows...})   ← 几十 KB
renderer api/domains/usage.ts → UsagePage 局部状态
  │ aggregate() 前端切片（demo 同构逻辑）
  ▼
七组件渲染（SVG style="fill:var(--chart-p*)" → 6 主题自动跟随）
```

## 4. 验收（真实场景）

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|------|------|---------|----------|
| S1 | 数字可信 | 用真实 `~/.xyz-agent/pi/sessions/`：python 手算最近 1 个自然日全部 assistant 消息的 totalTokens 之和（**独立于被测代码；切日用本地时区**，与 D6 同口径防时区错挑窗口），对照页面切「7 天」后 hover 该日 tooltip 的当日 Token | 两数一致；「消息数」与手数条数一致 | G1 |
| S2 | 四维联动 | 图例关掉 kimi-coding → 总量/图表/明细表同步变化；模型谱点 k3-256k 单看 → 全页只剩该模型 + 清除 chip 恢复 | 各视图数字互洽（总量 = 各 provider 分组和，含「压缩/摘要」桶；桶内 messages 为事件数口径，D1） | G2 |
| S3 | 主题跟随 | app 内切 6 套主题，逐主题打开用量页 | 堆叠柱/热力/图例色全部跟随（app 内实测，非 demo）；无写死色值（grep 新组件无 `#[0-9a-f]{3,6}` 硬编码，pre-commit taste-lint 辅助） | G3 |
| S4 | 增量正确 | 在某 session 发一条消息得到回复 → 回到用量页重新打开 | (mtimeMs,size) 双键失效触发该文件重扫，消息数 +N、token 增加且增量 ≈ 该条 usage（文件已 flush 场景；另在单测中模拟同 ms size 变场景） | G1/G2 |
| S5 | 订阅制降级 | 真实数据（kimi/zai/xiaomi cost=0）切「费用」指标 | 费用列显示 dim 色 `—` 而非 `$0.00`；总费用仅累加非零 provider | G4 |
| S6 | 空态 | 构造 `new UsageStatsService(tmpEmptyDir)` 单测级验证 + handler 集成验证空 payload | 出现引导空态文案，无报错、无 0 数字表格；目录含一个 `.tmp-migrate-*.jsonl` 时仍为空（D8 排除生效） | G4 |

S6 属边界场景，走构造目录（构造函数 `sessionsDir` 注入，D8）；S1-S5 全部使用真实数据/真实 app。

## 5. 下一层拆分（Wave）

| Wave | 内容 | 文件改动地图 | justification | 验收对应 |
|------|------|--------------|---------------|----------|
| W1 | shared 类型 + 扫描聚合服务（含单测） | 新 `packages/shared/src/usage-stats.ts`；新 `packages/runtime/src/services/usage/usage-stats-service.ts` + `.test.ts`（vitest，真实 fixture 文件 + tmp-migrate 排除用例 + 双键失效用例） | 数据层先行可独立手算复核；扫描器自建文件发现（D8），不复用 scanPiSessions | S1 的数据半边 |
| W2 | RPC 通道 + 页面骨架挂载 | 改 `packages/shared/src/protocol.ts`（**四处登记，硬前置**：ClientMessageType / ClientMessageMap / ServerMessageType+ServerMessageMap / ReplyPayloadMap）；新 `packages/runtime/src/transport/usage-message-handler.ts`；改 `server.ts`（分发表）；新 `api/domains/usage.ts`；新 `components/settings/usage/UsagePage.vue`（**占位**，W3 填充）；改 `SettingsModal.vue`（menus 第 12 项 + v-if 分支）；改 zh-CN/en-US i18n | 通道通 + 空页可见，尽早真机走通物理数据流；reply type 用 `usage.getStats:result` 对齐现有惯例 | S4 的传输半边 |
| W3 | UsagePage 七组件 + 交互 | 填充 `components/settings/usage/` 七子组件（demo 移植 TS 化，开发期间先用内联 token） | demo 已验证 DOM/交互/聚合逻辑，移植非新造 | S1/S2/S5 |
| W4 | 主题派生 token 登记 SSOT | 改 `packages/renderer/src/style.css` + `docs/page-design/v6-tokens.css`（`--chart-ink` 系列 + 6 主题块）+ dim/mid 对比度修正（**依赖产品拍板，独立 commit**） | 与 W2/W3 文件不相交可并行；W4 落地后 W3 删内联 token 换全局变量（不阻塞开发，只阻塞该独立 commit） | S3 |
| W5 | 边界 + testid + 收尾 | 空态/数据截至/skippedLines footnote（改 UsagePage）；testid 命名按 testing 惯例；更新 feature-map | 边界集中一批，避免 W3 期间分心 | S6 |

依赖：W1 → W2 → W3 → W5 主线；W4 与 W2/W3 并行（文件不相交）。

**审查轮已代答的检查点**（2026-08-25 对抗式审查核实，原「待验证」全部关闭）：
- ~~scanSessionMeta 是否返回 mtime/size~~：返回（`ScannedSessionMeta.lastModified/size`），但 scanPiSessions 有首行丢弃 + 1s TTL 目录缓存问题，已改自建发现（D8）
- ~~Settings 子页面是否有 Pinia 先例~~：有（`stores/quota.ts` / `stores/preset.ts`，因跨组件共享）。UsagePage 仍用页面局部 ref：无跨组件共享方，与多数 Settings 页一致；若后续 Header 需要用量徽标再升级 Pinia
- ~~S6 参数化路径~~：构造函数 `sessionsDir` 注入（D8）
- ~~content-max-w 放宽机制~~：SettingsModal L94 以 `max-w-[var(--content-max-w)]` 消费，UsagePage 局部 class 覆盖可行
- **仍开放**：dim/mid 对比度 5 处修正的产品裁决（W4 commit 前唯一外部依赖）

## 附：与前序文档的关系

- UI 设计、竞品调研、6 主题派生机制、对比度审计数据：`docs/page-design/usage-dashboard.md`（§四含 6 主题色度实测值）
- 交互 demo（自包含 HTML）：`docs/page-design/usage-dashboard.html`
- 本文只新增：聚合架构决策、接口协议、错误规格、Wave 拆分、验收场景
