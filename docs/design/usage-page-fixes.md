# 用量统计页四类缺陷修复设计

**一句话结论**：筛选 badge 重叠与"chip 消失"是同一处图例数据源缺陷（从过滤后聚合取数 + `size="icon"` 固定宽）；compaction / rename-session 无模型归属是数据层缺失（生成侧知道模型但未落盘、usage 被中间层丢弃）——修复分三层：extension 落账（新增数据源）→ runtime 扫描（新增两类分类）→ renderer 聚合与布局（恒显图例 + 复合键 + metric 贯穿）。

> 层声明：本文是**技术方案设计**（当前层 = 缺陷修复方案，下一层 = 可实施的代码任务清单）。涉及数据流 / 错误处理 / 运行时行为断言，准则 5/6/7 全适用。

---

## §1 背景目标

**SCQA**：

- **S（情境）**：Settings → 用量页聚合全部 pi session 的 token/费用，供用户回答「钱和 token 花在哪了」。
- **C（冲突）**：现状四类缺陷让这个回答不可信也不可用——badge 互相叠印、关掉的 provider 从图例消失且无法单独恢复、compaction 用量只显示匿名桶、rename-session 的 LLM 消耗完全无账。
- **Q（问题）**：怎么让用量页的每一分消耗都可读、可归属、可恢复交互？
- **A（答案）**：图例改从「全量 provider 聚合」取数并恒显 + 修复固定宽；compaction/rename 在生成侧落盘模型归属（不编造），scanner 增设对应分类；聚合层改复合键并让 metric 贯穿排序。

### 系统是什么

用量页链路（渲染端视角）：

```
~/.xyz-agent/pi/sessions/*.jsonl        ← pi 落盘的 session 条目（append-only）
  ↓ UsageStatsService.getStats()        ← runtime 流式扫描，按 pi 三分类聚合出 UsageRow[]
  ↓ WS RPC usage.getStats               ← 单次拉取（renderer 挂载时）
  ↓ aggregate.ts                        ← renderer 前端聚合（日期/模型/provider/项目切片）
  ↓ 7 个子组件                          ← 台账行 / 每日图 / 热力日历 / 模型谱 / 项目谱 / 缓存构成 / 明细表
```

`UsageRow` 四维分组键：`date × provider × model × project`（`@xyz-agent/shared/usage-stats.ts`）。compaction 类用量按现行设计归虚拟桶 `provider: 'compaction'`。

### 问题定义（已与用户确认收敛）

用户报告四项，经代码与真实数据核实，映射为四个根本问题：

| # | 用户报告 | 真正的问题（根因层） |
|---|---|---|
| 1 | 筛选 badge 渲染重叠 | ①`Button size="icon"` 产出 `h-10 w-10` 固定 40px 方框，内容溢出叠印；②图例从**过滤后**聚合取数，关掉的 provider chip 直接消失（无法单独恢复），isolate 时其余 chips 全部消失 |
| 2 | compaction 展开是子"compaction"模型 | compaction entry **没有模型归属字段**（pi `appendCompaction` 落盘字段无 model；scanner ②③分类写死 `'compaction'`）——而 smart-context 生成时**知道**模型却没记录 |
| 3 | 无 rename-session 用量 | rename 的 LLM 调用走 `callLLM`（llm-shared），**usage 在该层被丢弃**；成功后也不写任何 session entry——数据从源头就不存在 |
| 4 | 其他逻辑问题 | 审查发现：跨 provider 同名模型合并错乱（P1）、metric 切换未贯穿项目谱/明细表排序（P2）、明细表展开态不随数据刷新（P2）、月份/周几硬编码中文（P3） |

### 设计目标（从使用者体验倒推）

- **G1 图例可读可交互**：chips 各自独立渲染、超长横向滚动；关掉的 provider 置灰保留、可单独恢复；isolate 单看时图例仍显示全部 provider。
- **G2 compaction 可归属**：明细表 compaction 组展开后显示实际执行摘要的 `provider/model` 行；存量无归属数据诚实显示，不编造。
- **G3 rename-session 有账**：rename 成功调用后，用量页出现 `rename-session` 组，展开可见所用模型与 token/费用；对话流不受污染。
- **G4 聚合正确性**：metric 切换（Token↔费用）贯穿全部排序/榜单（缓存构成模块除外——token 域固有）；跨 provider 同名模型不合并；英文界面无中文残留。

### Scope

**In**：上表 4 项全部（含 #4 的 P1/P2/P3）；smart-context / llm-shared / rename-session 三个 extension 包；runtime scanner；renderer 聚合与布局；shared 类型注释；`docs/todo/usage-stats-design.md` 同步回写。

**Out**（显式排除，登记为 follow-up）：

- permission classifier 的 LLM usage 落账（与 rename 同构，但每次权限判定都触发、量级大，需单独评估写入频度——本设计只把 `callLLM` 出参打开，不为其落账）。
- subagent 子 session 的 usage 入账（subagent-workflow 未在 toolResult 挂 usage，数据源为零，先打通数据源再谈统计）。
- pi 原生 compaction（非 smart-context 路径）的模型归属——pi 落盘无模型字段且不可改 pi 源码（项目 MANDATORY 约束）。
- 热力日历随 range 联动（独立于 range 是刻意设计，`aggregateHeatmap` 注释明示）。
- fork session 的用量跨副本重复计入（assistant 用量同样如此，pre-existing 聚合口径；如需去重属独立工作）。

---

## §2 现状与问题分析

**本章结论**：四个问题分别锚定在「图例数据源 + 组件尺寸」「entry 数据缺失」「usage 中间层丢弃」「聚合键与排序口径」，全部有代码/实测证据。

### 2.1 图例：chip 叠印与"消失"（G1）

**使用者看到的现状**：打开用量页，provider 图例 chips 文字互相叠印成一团（本机 3 个 provider：`zai-coding-cn`、`kimi-coding`、`compaction`）；点击一个 chip 关闭某 provider 后，**该 chip 从图例消失**，只能点「重置」整体恢复。

**证据 ①（叠印）**：`packages/renderer/src/components/ui/button/index.ts` 的 variants：

```ts
size: {
  "default": "h-9 px-4 py-2",
  "icon": "h-10 w-10",   // ← 固定 40×40
}
```

`UsagePage.vue` 图例 chip 用 `variant="ghost" size="icon"` + 自定义 `class="...px-2.5 py-1..."`。`cn()` 走 tailwind-merge：自定义 class 里没有 w-*/h-*，`w-10 h-10` 全部存活 → 每个 chip 是 40px 方框，内容（色点 + `zai-coding-cn` + `63.4%` ≈ 110px+）对称溢出，相邻叠印。同页「指标/范围切换」按钮同样用了 `size="icon"`（`h-6` 解掉了 `h-10`，`w-10` 残留，「30 天」≈42px 轻微溢出）。

**证据 ②（消失）**：`UsagePage.vue`：

```ts
const sortedProviders = computed<[string, AggMetrics][]>(() => {
  return Object.entries(agg.value.perProv).sort(...)   // ← agg 是过滤后的聚合
})
```

`aggregate()` 的 `aggregateDay` 跳过 `offProv` 的行 → `perProv` 只含启用 provider → **关掉的 provider 不在 `sortedProviders` 里，chip 消失**。模板中 `filter.offProv.has(pid) ? '...opacity-[0.38]' : '...'` 的置灰样式是**死代码**（该分支渲染时 chip 已不存在）。`__tests__/UsagePage.filters.test.ts:103` 反而把「chip 消失」断言成了预期行为。（现状快照：三者均已由本设计 §3.1 场景 A 修复——数据源改 `perProvFull`、置灰保留落地、该测试已重写为「置灰保留」断言）

isolate 同构：单看某模型时 `perProv` 只剩该模型所属 provider，其余 chips 全部消失。

### 2.2 compaction 无模型归属（G2）

**使用者看到的现状**：明细表「compaction」分组展开后，模型行显示 `compaction`——不知道是哪个模型烧的。

**证据**：runtime `usage-stats-service.ts` ②③ 分类（toolResult-with-usage / {compaction, branch_summary}-with-usage）一律 `makeRow(date, 'compaction', 'compaction', ...)`。本机实测（截至 R1 审查时点，append-only 自然增长）compaction entry 的落盘字段：

```json
{"type":"compaction","fromHook":true,
 "details":{"engine":"smart-context","mode":"cross-model","readFiles":[...],"modifiedFiles":[...]},
 "usage":{"input":...,"output":...,"cacheRead":...,"cacheWrite":...,"cost":{...}}}
```

无 model 字段——pi 的 `appendCompaction`（dist/core/session-manager.js:805）落盘字段固定为 `{type,id,parentId,timestamp,summary,firstKeptEntryId,tokensBefore,details,usage,fromHook}`。**关键事实**：`details` 由 hook 返回值原样透传（smart-context 控制），而 smart-context 生成时知道模型——same-model 用 `ctx.model`、cross-model 用 `resolveModel(ctx, config.compactModel)`（`extensions/universal/smart-context/src/compact-handler.ts`）——只是没记进 details。

现行设计 `docs/todo/usage-stats-design.md` D1 明确否决过「跟随 session 主模型（猜测归属 = 编造数据）」。本设计不改这条原则：**只记录权威事实（生成侧已知），不回溯猜测**。

### 2.3 rename-session 用量无账（G3）

**使用者看到的现状**：rename 每个新 session 首回合都会调一次 LLM 生成标题，但用量页完全看不到这笔消耗。

**证据（usage 全程被丢弃的链路）**：

```
rename-session/src/llm.ts callRenameLLM
  → extensions/shared/llm-shared/src/call.ts callLLM
      const resp = await completeSimple(...)
      return { ok: true, content: extractText(resp) }   // ← resp.usage 被丢弃，出参类型根本没有 usage
  → 成功后 index.ts 只 pi.setSessionName(title)          // ← 不写任何 session entry
```

数据从源头就不存在，任何统计层都无法补救。

### 2.4 聚合正确性缺口（G4）

- **P1 跨 provider 同名模型合并**：`aggregateDay` 以裸 model id 为 `perModel` key；`modelProviderMap`（UsagePage）first-seen 归属。若两个 provider 服务同名模型（models.json 可自由添加），用量合并成一条且全记到先见 provider 的组。
- **P2 metric 未贯穿**：`aggregateProjects` TOP8 与 `aggregateDetailGroups` 分组排序都按固定 `totalTokens`——切到「费用」视角，项目谱榜单与明细表组序仍是 Token 口径。
- **P2 展开态 stale**：`UsageDetailTable` 的 `expandedGroups` 只在挂载时从初始 groups 取前两组；数据刷新（重试/筛选变化）后新组全部收起、集合残留旧 pid。
- **P3 i18n 硬编码**：`UsageDailyChart` 月份标签 `` `${m+1}月` ``、`aggregate.ts` 的 `fmtWeekday`（'周一'…）硬编码中文；`UsageHeatCalendar` 反而用了 `t()`——不一致，英文界面混中文。（现状快照：`fmtWeekday` 已由本设计 D6 移除改为 `t()` 键）

### 2.5 物理数据流（现状 → 终态对照）

```
【现状】
smart-context 压缩 ──(details 不含 model)──▶ compaction entry ──▶ scanner ③ ──▶ provider='compaction', model='compaction'
rename LLM   ──(usage 在 callLLM 丢弃)──▶ 无任何落盘 ──▶ 不入账

【终态】
smart-context 压缩 ──(details.model="prov/id")──▶ compaction entry ──▶ scanner ③ 读 details.model ──▶ provider='compaction', model='prov/id'
rename LLM   ──(callLLM 透出 usage)──▶ appendEntry("rename-session",{model,usage})
                                    ──▶ custom entry ──▶ scanner ④ ──▶ provider='rename-session', model='prov/id'
两条链最终都汇入既有 UsageRow → aggregate → 7 组件，renderer 数据通道零结构变更。
```

---

## §3 解决方案

**本章结论**：图例恒显 + 单行滚动；compaction 归属走「生成侧落盘权威模型」；rename 落账走「custom entry + scanner 第④分类」；聚合层复合键 + metric 贯穿。

### 3.1 终态（使用者视角）

**场景 A（G1 图例）**：用户打开用量页：

- 图例 chips 一行排开、互不叠印；provider 多到超宽时整行出现**横向滚动条**，指标/范围切换固定在右侧不挤占。
- 点击 `zai-coding-cn` chip → chip **置灰（opacity 0.38）保留在原位**，图表/榜单即时剔除该 provider；再点一次恢复。
- 单看（isolate）某模型时，图例**仍显示全部 provider chips**，可继续开关其他 provider。
- 失败路径：无新增失败路径（纯前端状态）；点「重置」清除全部 offProv 与 isolate，恢复初始。

**场景 B（G2 compaction 归属）**：用户展开明细表 `compaction` 组：

```
▼ compaction                      2 模型   1.2M   $0.84   8.1%
    zai-coding-cn/glm-5.3-flash           0.9M   $0.61   6.0%
    compaction                            0.3M   $0.23   2.1%   ← 存量无归属（诚实显示）
```

- 新产生的压缩（升级后）显示实际执行模型的 `provider/model` 行。
- 存量数据（升级前落盘、无 details.model）保持 `compaction` 行——**不猜测归属**。
- 失败路径：`details.model` 字段非字符串/空 → 视同无归属，回退 `compaction` 行（守卫降级，不抛错）。

**场景 C（G3 rename 落账）**：用户开了个新 session，首回合完成后 rename 自动生成标题。回到用量页：

- 图例与明细表出现 `rename-session` 组（在全部 provider 里按用量排序插入）。
- 展开该组：显示 `xiaomi-token-plan-cn/mimo-v2.5` 等实际所用模型行，token/费用如实计入。
- **对话流里不出现任何多余消息**（custom entry 对 chat 渲染是 no-op）；关闭重开 session 对话流一致（live ≡ reload 不破坏）。
- 失败路径：rename LLM 调用失败（网络/凭据）→ 无 custom entry、标题保持原状、用量页无崩溃——rename 本就是 best-effort（现状语义不变）；`appendEntry` 本身抛错 → catch 记日志，不影响标题落库。

**场景 D（G4 正确性）**：用户把指标切到「费用」→ 项目谱 TOP8 与明细表分组顺序改按费用排序；英文界面下每日图的月份/周几为英文。

### 3.2 方案对比

**决策点一：图例数据源（chip 恒显怎么来）**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. `aggregate()` 增产 `perProvFull`（尊重 range、忽略 offProv/isolate），图例从它取数 | 数据源与视图职责清晰：图例=全量入口，图表=过滤结果；置灰样式从死代码变活 | 中：aggregate 加一个累加器 + UsagePage 改数据源 + 测试改写（filters.test 断言反转） | 图例 share 语义变为「range 内全量占比」（与图表过滤后数值不同）——需在终态明确此语义 | ✅ |
| B. 图例从 `data.rows` 直算（不经 aggregate） | 两处聚合逻辑并行，长期漂移 | 低 | share/排序与 aggregate 口径可能不一致 | ❌ |
| C. 维持消失行为，仅修叠印 | 零 | 最低 | 「关掉即消失、只能整体重置」不可恢复交互保留——G1 只完成一半 | ❌ |

若用 C：场景 A 中用户关掉 provider 后 chip 消失，无法单独恢复——与 G1「可恢复交互」直接冲突，故否。

**决策点二：compaction 模型归属**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. smart-context 把 `details.model="prov/id"` 落盘，scanner 读取；缺失回退 generic | 权威数据在生成点落盘，符合「计量事实随事件持久化」；对 pi 零侵入 | 中：smart-context 两处 mode 各加一字段 + scanner 一处读取 + 测试 | 存量数据无归属（见 §3.4 代价声明） | ✅ |
| B. scanner 按「nearest 前置 assistant 消息模型」回溯推断 | 零 extension 改动 | 低 | 违反现行设计 D1「猜测归属 = 编造数据」（cross-model 压缩用的不是会话模型，回溯必然错标） | ❌ |
| C. 归属直接并入真实 provider/model（compaction 组消失） | 单一归属维度，看似更简洁 | 低 | 丢失「压缩成本独立可见性」——用户明确要在 compaction 语境下看模型（场景 B），并入后无法回答「压缩一共花了多少」 | ❌ |

若用 B：存量 same-model entry 猜对、cross-model entry 全错标（本机截至 R1 审查时点 smart-context 8 条中 5 条 cross-model，append-only 数据自然增长）——编造数据，被现行设计文档显式否决过的路径。

**决策点三：rename-session 落账通道**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. rename 成功后 `pi.appendEntry("rename-session", {model, usage})` 写 custom entry，scanner 增第④分类 | 计量随 session 文件持久化，与 compaction entry 同范式（事件即账本）；删除 session 即清理，无独立生命周期 | 中：llm-shared 出参扩展 + rename 一处调用 + scanner 一类 + 测试 | custom entry 进 session 树——需验证 chat 渲染 no-op（探针 P3 ✅ 已核） | ✅ |
| B. 独立 sidecar JSONL（`<dataDir>/usage-ledger.jsonl`） | 引入第二数据源，scanner 双目录扫描、清理通道独立（session 删了账还在） | 中 | 数据源分裂 + 残留清理新负担；与「session 即账本」的既有 compaction 范式不一致 | ❌ |
| C. 只在内存/运行时计数，不落盘 | 最简单 | 低 | 重启即丢，无法回看历史——G3 不成立 | ❌ |

若用 B：用户删除 session 后 rename 账残留（量级 O(历史 session 数)），需要额外清理机制——为一个 200B/条 的记录引入独立生命周期管理，违反减法原则。

**决策点四：聚合键与排序口径（G4）**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. `perModel` 改复合键 `provider/model`，值结构 `{provider, model, u}`；`aggregateProjects`/`aggregateDetailGroups` 排序与切片改 `metricValue(·, filter.metric)` | 单一语义：一行 = 一个 provider×model 组合；metric 单一口径 | 中：aggregate 返回类型 + 3 个消费组件适配 + 测试 | 显式类型消费方（props/参数签名）编译期捕获；**但裸串比较/查表带编译器不捕获**（isolate 三处行过滤、modelProviderMap 建 key 与查表、detailGroups 的 modelProv 派生）——已清单化列入 §3.3 ⑤ 连带语义与 U2 人工核对项 | ✅ |
| B. 保持裸 id 键，仅文档标注限制 | 零 | 零 | 跨 provider 同名模型继续错合并——G4 的 P1 项不成立 | ❌ |

### 3.3 终态数据契约（接口先行）

**① smart-context compaction entry（extension 侧增量）**：

```jsonc
// details 增加一个字段（same-model 与 cross-model 两处生成点都写）
{ "engine": "smart-context", "mode": "cross-model",
  "model": "zai-coding-cn/glm-5.3-flash",   // ← 新增：`${model.provider}/${model.id}`
  "readFiles": [...], "modifiedFiles": [...] }
```

**② llm-shared `CallLLMResult`（additive）**：

```ts
export type CallLLMResult =
  | { ok: true; content: string; usage?: Usage }   // ← 新增可选字段，透传 completeSimple 的 resp.usage
  | { ok: false; error: string; stopReason?: "error" | "aborted" };
```

**③ rename-session custom entry（新增落盘）**：

```jsonc
// pi.appendEntry("rename-session", { model, usage }) 落盘形态（pi appendCustomEntry 语义）：
{ "type": "custom", "customType": "rename-session",
  "data": { "model": "xiaomi-token-plan-cn/mimo-v2.5",
            "usage": { "input": ..., "output": ..., "cacheRead": ..., "cacheWrite": ...,
                       "cost": { "total": ... } } },
  "id": "...", "parentId": "...", "timestamp": "ISO-8601" }
```

调用落点与时点：落点收敛为 `llm.ts` 的 `callRenameLLM` 内部（时点规格唯一成立处：`await callLLM` 返回 `ok:true && usage` 后**立即**、`cleanTitle` 之前——计量「LLM 调用事实」，与标题清洗成败解耦）。pi 句柄可达性：`appendEntry` 在 `ExtensionAPI` 上而 `callRenameLLM` 只持有 `ExtensionContext`——由 index.ts 调用处注入回调 `appendUsageEntry(model, usage)`（闭包捕获 `pi`），llm.ts 在上述时点调用，llm.ts 仍不依赖 pi 句柄。

**④ scanner 分类增补（runtime）**：

```
③ compaction/branch_summary 分类增强：
   model = typeof entry.details?.model === 'string' && entry.details.model !== ''
           ? entry.details.model : 'compaction'   // 权威归属优先，缺失诚实回退
④ type==='custom' && customType==='rename-session' && data.usage 为非 null 对象
   → makeRow(date, 'rename-session',
             typeof data.model === 'string' && data.model !== '' ? data.model : 'rename-session',  // 守卫与 ③ 对称
             cwd, data.usage)
   // 「usage 有效」= 非 null 对象；字段缺失由 extractMetrics 按 0 兜底，cost 缺失 → 费用视角 $0（诚实降级）
```

**⑤ renderer `aggregate()` 返回增型**：

```ts
interface AggregatedData {
  // ...
  perProvFull: Record<string, AggMetrics>   // ← 新增：尊重 range、忽略 offProv/isolate（图例专用）
}
// perModel 值结构：Record<string, AggMetrics> → Record<string, { provider: string; model: string; u: AggMetrics }>
//                  key = `${provider}/${model}`（复合键，决策点四 A）
```

**复合键的连带语义（人工核对带，编译器不捕获）**：

- `filter.isolate` 的键语义 = **复合键**：`UsageModelRank` 行点击 emit 的即 perModel key，`aggregateDay` / `aggregateHeatmap` / `aggregateProjects` 三处行过滤的裸比较 `row.model !== filter.isolate` 同步改为 `${row.provider}/${row.model} !== filter.isolate`，否则 isolate 激活即图表/热力图/项目谱全空。
- `modelProviderMap`（UsagePage）改以复合 key 建表/查表，**派生源必须与过滤无关**：由全量 `data.rows` 建复合键→provider 表——禁止从 `perModel`/`perProvFull` 等过滤后聚合派生。反例（R2 审查击穿）：`toggleProvider` 先 `offProv.add(pid)` 再查 `modelProviderMap[isolate] === pid` 做联动清守卫，computed 同步重算后被关 provider 的键已从过滤后聚合消失 → 查表 undefined → 守卫确定性失效 → isolate 存活且其 provider 已关 → 全部图表净空（验收 V12 守卫此组合）。`aggregateDetailGroups` 的 modelProv 派生同款（从全量 rows 建复合键表，查过滤后 perModel key）。
- **展示形态**：ModelRank / 明细表 / CacheMix 用值结构的 `provider` + `model` 分量渲染（provider 灰前缀 + 裸 model，与现状视觉一致），**不直接渲染复合键串**。归属行（compaction/rename 组）的 `UsageRow.model` 本身是 `prov/id` 复合串——归属语境下刻意（区分「哪个模型执行的压缩」），与主桶组的裸 id 形态并存属预期。isolate 单看提示 chip（UsagePage 直接渲染 `filter.isolate`）同用分量渲染（provider 灰前缀 + model），不显示裸复合键串。
- **isolate 比较与查表的穷举清单（裸串/键形态带，编译器不捕获）**：① `UsageModelRank` 模板内三处比较（高亮 `isolate === row.model` ×2 与去选 toggle 比较，UsageModelRank.vue:12/:21/:103）——比较须用**复合键行标识**（= perModel key），展示分量仅用于渲染；漏改则 isolate 高亮不亮、行点击无法去选（isolate 卡死到 × / provider 联动才解除），V1-V12 无覆盖。② `UsageModelRank` 的 `modelProviderMap` prop 查表（`props.modelProviderMap[model] ?? 'unknown'`）随值结构化**整条删除**（值自带 provider 分量，prop 与查表一并消失）——禁止保留查表依赖 `?? 'unknown'` 兜底：键形态错配会静默降级为 unknown 前缀 + 错色，不崩不报。③ isolate chip（上述展示条款）。
- **排序例外声明**：`aggregateCacheMix` 的 TOP-4 排序切片保持 `totalTokens`——缓存构成本质是 token 域概念（hit/newIn/out 均为 token 比例），不随 metric 切换口径；G4「metric 贯穿」的范围 = 图例 / 项目谱 / 明细表 / 模型谱，不含缓存构成。

**⑥ 图例行为规格（终态）**：

- chips 列表 = `perProvFull` 的 keys，按当前 metric 的用量降序；
- chip 置灰 ⇔ `offProv.has(pid)`；点击 toggle（「至少保留一个」守卫保留，改以 `perProvFull` 为基数）；toggle 若命中 isolate 所属 provider，**联动清除 isolate**（既有行为，规格锚定于此，见 ⑤ / V12）；
- chip 内占比 = 该 provider 全量 / `perProvFull` 总量（range 内，不随 offProv/isolate 变化）；
- chips 容器 `flex-nowrap overflow-x-auto`（单行横滚），指标/范围切换 `shrink-0` 固定右侧；
- 一切**含文本**按钮（chips、指标/范围切换、「重置」——「重置」实际是文本按钮，渲染 legendReset 文案）去掉 `size="icon"`，尺寸由自定义 class（`h-6 px-2.5`）自管；仅 isolate-clear（纯 × svg 图标）保留 `size="icon"` 并以自定义 `h-6 w-6` 显式自管尺寸——文本按钮套定宽 icon 尺寸会复现「固定宽叠印」同类 bug。

### 3.4 关键决策与权衡（四件套）

**D1：图例恒显数据源 = `perProvFull`（选定）**
- **采用**：`aggregate()` 内第二累加器，`sliceDates` 内跳过 offProv/isolate 检查只累计 `perProvFull`（`perProv` 原语义保留，见 §3.6）。
- **被否**：图例直算（口径分裂）；维持消失行为（不可恢复）。
- **证据**：`aggregate.ts` 已有同范式先例 `buildFullPerProv`（全量行集算色序，注释「过滤变化不重排」）；置灰样式现存于模板（死代码转正）。
- **效果**：G1 场景 A 的「置灰保留 + 单独恢复 + isolate 恒显」成立。

**D2：compaction 归属 = details.model 权威落盘（选定）**
- **采用**：smart-context 两处生成点写 `details.model = \`${model.provider}/${model.id}\``；scanner ③ 读它，缺失回退 `'compaction'`。
- **被否**：回溯推断（编造数据，cross-model 必错标——现行设计 D1 已否决）；并入真实 provider（丢失压缩独立可见性）。
- **证据**：本机实测 9 条 entry 的 details 原样落盘（engine/mode/readFiles 全在；9 为 D2 采证时点计数，§3.4 代价声明 1 与 §4 V5 的「10 条」为更晚 R1 审查时点——append-only 自然增长，10 条中带 details 比例与 9 条时点一致）；smart-context 生成侧持有 model 对象（compact-handler.ts 两个 generate 函数）。
- **效果**：G2 场景 B 成立；存量数据诚实降级（代价声明见下）。

**D3：rename 落账 = custom entry + scanner ④（选定）**
- **采用**：见 §3.3 ②③④。
- **被否**：sidecar 账本（数据源分裂 + 独立清理负担）；不落盘（重启即丢）。
- **证据**：pi ExtensionAPI `appendEntry`（types.d.ts:985「Append a custom entry … not sent to LLM」）；`appendCustomEntry` 带 timestamp（dist/core/session-manager.js:822）；renderer `apply-entry.ts:616` 对非 msg-id customType 走 `commitClientMsgIdEntry` no-op；extension-logger 已有 appendEntry 持久化先例。
- **效果**：G3 场景 C 成立；对话流零污染。

**D4：复合键 + metric 贯穿（选定）**
- **采用**：`perModel` 复合键（值带 provider/model 分量）；`aggregateProjects` / `aggregateDetailGroups` 的排序与切片全部换 `metricValue(·, filter.metric)`。
- **被否**：裸 id 键 + 文档标注（错合并保留）。
- **证据**：`aggregate.ts` 排序先例——`sortedProviders`（UsagePage）已按 metric 排，项目谱/明细表漏改属遗漏非设计。
- **风险边界（修正声明）**：显式类型消费方编译期捕获；**裸串比较/查表带编译器不捕获**（isolate 三处行过滤、modelProviderMap、modelProv 派生）——已清单化列入 §3.3 ⑤ 连带语义与 U2 人工核对项，实施时逐处过检（初稿「编译期全捕获，无静默风险」的声明不成立，撤回）。
- **效果**：G4 成立；D2/D3 新增的 compaction/rename 归属行天然获得唯一键。

**D5：`expandedGroups` 随 groups 重置（选定）**
- **采用**：`watch(() => props.groups, ...)` 重置为前两组展开（与挂载初始化同一逻辑提为函数复用）。
- **被否**：保持 stale（新组全收起，行为不可预期）。
- **证据**：现状挂载时一次初始化（UsageDetailTable.vue），重试/筛选后 groups 引用已变。
- **效果**：筛选变化后展开态可预期（默认前两组）。

**D6：i18n 收口（选定）**
- **采用**：DailyChart 月份后缀复用 HeatCalendar 的 `t('settings.usage.heatMonthSuffix')`；周几复用 `heatWeek*` keys（HeatCalendar 已有 zh + en 需实施期核对补齐，见探针 P8）。
- **被否**：保留硬编码（英文界面混中文）。
- **效果**：G4 英文界面无中文残留。

**代价声明（四要素量化）**：

1. **存量 compaction 无归属**（D2 的已接受代价）：量级 = 升级前全部 compaction entry（本机截至 R1 审查时点 smart-context 8 条 + 非 smart-context 2 条，append-only 自然增长）显示 generic 行、不可恢复（历史数据无模型信息，恢复通道不存在）；重审触发 = 用户明确要求历史归属时，再评估「按 same-model 语义推断 + 显式推断标记」方案；显式判定 = 可接受（新数据准确、旧数据诚实，优于编造）。
2. **rename entry 写入增量**（D3）：量级 = 每 session 恰 1 条 ≈ 200B（不重复保证 = `successCount===1` 门控：仅首个成功 turn 触发；`/auto-rename` 命令只切开关不触发 LLM；subagent session 被 `isSubagentSession` 排除）；恢复路径 = 删除 session 随文件清理，无需独立通道；重审触发 = 永不（量级恒为 O(session 数)）；显式判定 = 可接受。caveat：pi appendEntry 走 flush-debounce 落盘（pi-semantics PS-17），进程崩溃落在 flush 窗口内该条账丢失且跨重启不可恢复——账目为 best-effort，与 rename 本身的 best-effort 语义一致，可接受。
3. **图例 share 语义变化**（D1）：chip 占比从「过滤后占比」变为「range 内全量占比」——数值口径变化非缺陷（过滤后关闭者无行、分母失义），终态场景 A 已明示；重审触发 = 用户反馈图例占比与图表数值无法对账（对账类困惑）时，重新评估是否回显过滤后口径。

### 3.5 探针清单（运行时断言）

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P-details | compaction entry 的 details 原样落盘（smart-context 可携带 model） | 本机实测 9 条 entry，details.engine/mode/readFiles 全部原样在（D2 采证时点；与 §3.4 D2/§4 V5 的 10 条为不同时点，append-only 自然增长） | ✅ 已测 | — |
| P-appendEntry | `pi.appendEntry` 落盘 `{type:'custom',customType,data,timestamp}` 且可在 fire-and-forget then 链内调用 | 实施期本地 pi CLI：`pi --mode rpc --session-dir <tmp> --extension <rename-session>` 触发首回合 rename，检查 session JSONL | ✅ U5 实测（0.84.4 CLI，落盘形态逐字段一致，无需降级） | 失败 → 改为 `setSessionName` 同步前后即刻调用（同一 then 链更早位置），仍失败则该回合放弃计量（rename 主流程不受影响） |
| P-chat-noop | custom entry 不进对话流（live 与 reload 两路） | 实施期 dev app：触发 rename 后重开 session，断言无新消息 | ✅ U8 验收（V7：恰 2 条 message + 重开零残留） | 失败 → customType 改带 display:false 的 custom_message 形态（照 subagent-directive 先例） |
| P-size | `size="icon"` 产 `h-10 w-10`（叠印根因） | 已读 button/index.ts 源码确认 | ✅ 已核 | — |
| P-narrow | chips 单行滚动在窄窗（settings 弹窗最小宽）不挤压右侧切换、不溢出弹窗 | 实施期 Playwright 连 dev app 缩窗验证 | ✅ U8 验收（V1：761>452 横滚激活 + 右侧切换固定，无需降级） | 失败 → chips 容器加 `max-w-[...]` 上限 + `min-w-0`，极端窄时允许 chips 换行为两行 |
| P-usage-shape | completeSimple 的 resp.usage（含 usage.cost 形态）对 rename 所用各 provider 均有值 | 实施期 llm-shared 单测 + 本地 CLI 实测 | ✅ U4 单测 + U8 实测（cost.total=0 走诚实降级实例） | usage 整体缺失 → 跳过 appendEntry（存在性守卫）；仅 cost 缺失 → 照常落账，费用视角该模型显示 $0、token 照常（诚实降级，§3.6） |
| P-en-i18n | en locale 已有 heatMonthSuffix/heatWeek* keys（D6 复用前提） | 实施期 grep `locales/en-US/settings.ts` | ✅ U2（keys 双语齐备零改动）+ U8/V11 严格 SVG 探针复核 | 失败 → 补 en keys（纯文案） |

### 3.6 错误规格

| 边界/错误 | 行为 | 恢复指引 |
|---|---|---|
| `details.model` 非 string / 空串 | 视同无归属 → generic `compaction` 行 | 无需恢复（守卫降级） |
| custom entry 无 `data.usage`（或非对象） | 不计 row（usage 存在性守卫，同 ①②③ 范式） | 无需恢复 |
| custom entry `data.model` 缺失/非 string | 回退 generic `rename-session` 行（守卫与 ③ 对称） | 无需恢复 |
| usage 有值但 cost 缺失 | 照常落账；费用视角该模型 $0、token 正常 | 诚实降级（provider 不回 cost） |
| custom entry `timestamp` 非法 | `skippedLines++`（行级失败既有语义） | 页脚 skipped 计数可见 |
| `callLLM` 返回无 usage | 跳过 appendEntry，rename 正常完成 | 该次不可计量（P-usage-shape 降级） |
| `appendEntry` 抛错（session 已切换等） | 回调体内 catch + `logger.error`（catch 必须位于 `appendUsageEntry` 回调实现内部，不影响回调返回与后续 `cleanTitle`/`setSessionName`——「标题照常落库」仅在此归属下成立） | rename 本就 best-effort；日志 `XYZ_AGENT_DEBUG=1` 可查 |
| 图例全部 provider 被关（guard） | 「至少保留一个」守卫拦截**最后一个启用 provider** 的关闭（剩 1 个 enabled 时不可再关；基数改 `perProvFull`） | 点置灰 chip 恢复 |

**接管/替换检查**：本设计无接管既有流程——`callLLM` 出参是 additive（TS 结构类型，permission classifier 等既有调用方零影响）；rename 的 appendEntry 是纯新增副作用；scanner ④ 是新增分类不改 ①②③ 行为；`perProv` 原语义保留（图表继续用），新增 `perProvFull` 不替换任何消费方。

---

## §4 验收（真实场景，非单测）

**改动规模**：大（跨 extension ×3 / runtime / renderer 三层 + 数据契约新增），多场景验收。

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| V1 | 图例可读性 | `pnpm dev` 打开 Settings→用量（真实 `~/.xyz-agent` 数据） | chips 互不叠印、一行排开；窗口缩窄到弹窗最小宽时 chips 区横向滚动、右侧切换固定不被挤走 | G1 |
| V2 | 关闭/恢复交互 | 点击 `zai-coding-cn` chip → 观察图表与 chip；再点一次 | chip 置灰**保留原位**、图表剔除该 provider；再点恢复；「重置」清全部 | G1 |
| V3 | isolate 恒显 | 模型谱点某模型单看 | 图例仍显示全部 provider chips（含非当前模型所属） | G1 |
| V4 | compaction 归属（新数据） | 准备 `<tmp-root>`（`mktemp -d`）；本地 pi CLI（AGENTS MANDATORY 路径）：`pi --mode rpc --session-dir <tmp-root>/pi/sessions --model <m> --extension <smart-context>` 灌长对话触发压缩；**dev app 以 `XYZ_AGENT_DATA_DIR=<tmp-root>` 启动**（`getSessionsDir()` 派生自该 env → 用量页扫描的正是 CLI 产物，不触真实数据）；打开用量页 | compaction 组展开显示 `<provider>/<model>` 行，与 details.model 一致 | G2 |
| V5 | compaction 存量诚实（负面） | 用升级前的存量 session（本机现存量，R1 审查时点 10 条）重扫（dev app 真实数据目录，只读） | 无归属行保持 `compaction`，不出现编造的模型名 | G2 |
| V6 | rename 落账 | 本地 pi CLI 新 session 发一条 prompt 等 rename（同 V4 的 `<tmp-root>` 布局）；dev app 以 `XYZ_AGENT_DATA_DIR=<tmp-root>` 启动后打开用量页 | 出现 `rename-session` 组，展开为实际模型行，数值与 session JSONL 里 custom entry 的 usage 一致 | G3 |
| V7 | 对话流不变（邻居不变量） | V6 的 session 关闭重开，比对对话流 | 无 rename-session 相关消息/气泡；live 与 reload 一致 | G3 |
| V8 | rename 失败不落账（负面） | 将 rename-session 自身 model selector 指向无效模型（改其 config 的 model 字段——注意该 config 在系统 pi 目录 `~/.pi/agent/config/` 下、**不受 `<tmp-root>` 隔离，测试后须恢复**；**不可改 provider 级凭据**：主 turn 同败则 rename 根本不触发，场景空转假绿）；发一条 prompt 触发首 turn；以 `XYZ_AGENT_DATA_DIR=<tmp-root>` 启动 dev app 打开用量页 | 主 turn 有 assistant 回复（turn 成功）的前提下：无 custom entry、无标题、用量页无崩溃；测试后 rename config 已恢复（下一个新 session 标题正常生成） | G3 |
| V9 | metric 贯穿 | 切「费用」→ 看项目谱 TOP8 与明细表组序 | 排序按费用变化（与 Token 视角不同序，用真实数据可分辨） | G4 |
| V10 | 复合键 | 构造两个 provider 同名模型的历史 fixture（测试数据目录），重扫 | 模型谱出两行、各归各 provider 组，总量守恒 | G4 |
| V11 | i18n | 切英文界面看每日图 | 月份/周几为英文，无中文残留 | G4 |
| V12 | isolate × 关 provider 组合（负面） | 前置：从「重置」状态开始（清 offProv/isolate）且 ≥2 个启用 provider；模型谱单看模型 X（X 所属 provider P2 从模型谱行的 provider 灰前缀读出）→ 点击 P2 chip 关闭 | isolate 被联动守卫**自动清除**（非图表全空）；再点 P2 chip 恢复后图表回归 | G1 |

单元测试仅作回归辅助（filters.test 的「chip 消失」断言反转为「置灰保留」；scanner 测试补 ④ 分类与 details.model 守卫；smart-context/rename/llm-shared 各补单测），不计入验收。

依赖说明：V1-V3/V5/V9/V11/V12 走 dev app + 真实数据目录（只读扫描，无写风险）；V4/V6/V8 走本地 pi CLI + 临时 `<tmp-root>`，**dev app 以 `XYZ_AGENT_DATA_DIR=<tmp-root>` 启动使扫描侧与 CLI 产物同根**（AGENTS 规定的 extension 实测路径，同时不触真实数据目录）；V10 用 `mkdtempSync` 自建 fixture（测试数据纪律）。前提：dev app 的 userData（单实例锁）硬编码不随 `XYZ_AGENT_DATA_DIR` 变——执行前先退出已在运行的 dev 实例，否则新实例静默 quit。

---

## §5 下一层拆分

**实施路径**：extension 落账（数据源）→ runtime 扫描（通道）→ renderer（呈现）→ 端到端验收。依赖关系：U3→U6；U4→U5→U6；U6→V4/V6；U1、U2 独立可先行。

| 单元 | 内容 | 文件 | justification |
|---|---|---|---|
| U1 | 图例恒显 + 布局修复：`perProvFull` 累加器、chips 数据源/置灰/守卫基数切换、`flex-nowrap overflow-x-auto`、`size="icon"` 按 §3.3 ⑥ 规则清理（含文本按钮全去，仅 isolate-clear 保留并自管尺寸） | `aggregate.ts`、`UsagePage.vue`、`__tests__/UsagePage.filters.test.ts`（断言反转）、`UsagePage.test.ts` | G1 的全部呈现层；独立可验收（V1-V3/V12） |
| U2 | 聚合正确性：复合键值结构、metric 贯穿排序、expandedGroups watch、i18n 收口；**人工核对带（编译器不捕获，逐处过检）**：isolate 三处行过滤改复合键比较、modelProviderMap 派生源 = 全量 `data.rows`（禁止从过滤后 perModel/perProvFull 派生——toggleProvider 先 add 后查的时序会确定性丢失键，R2 反例）、toggleProvider 联动清 isolate 守卫在复合键下行为验证、detailGroups 的 modelProv 派生、组件展示用 provider/model 分量而非复合键串（含 isolate chip）、UsageModelRank 高亮/去选三处比较用复合键行标识（:12/:21/:103，展示分量仅渲染）、modelProviderMap prop 查表随值结构化删除（禁 unknown 兜底） | `aggregate.ts`、`UsageModelRank.vue`、`UsageCacheMix.vue`（适配值结构）、`UsageDetailTable.vue`、`UsageDailyChart.vue`、`UsagePage.vue`（isolate 接线）、`__tests__/aggregate.test.ts` 等 | G4 四项；裸串比较带已清单化，与 U1 同文件分批提交 |
| U3 | smart-context `details.model` 落盘（两处生成点）；连带：`docs/pi-semantics.json` 新增 probe 条目「appendCompaction 对 hook details 逐字透传落盘」（verifiedWith 0.84.4）+ 探针测试 `packages/runtime/src/infra/pi/__tests__/pi-semantics-compaction-details.test.ts`（既有 pi-semantics-* 范式；JSON 条目与测试同批交付，缺测试则版本门禁红）——pi 升级若丢弃/改名 details，归属静默降级的漂移由探针族拦截（C-proc-08 纪律） | `extensions/universal/smart-context/src/compact-handler.ts` + 测试、`docs/pi-semantics.json`、上述探针测试 | G2 数据源；先行否则 U6 无可扫数据；pi 升级耦合面登记是项目 MANDATORY 纪律的连带改动 |
| U4 | llm-shared `CallLLMResult.usage` 透出 | `extensions/shared/llm-shared/src/call.ts` + 测试 | G3 前置；additive 无既有调用方影响 |
| U5 | rename-session appendEntry（落点收敛 llm.ts；index.ts 注入 `appendUsageEntry` 回调捕获 pi 句柄） | `extensions/universal/rename-session/src/llm.ts` + `index.ts`（回调注入）+ 测试 | G3 落账点；含 P-appendEntry 探针 |
| U6 | scanner：③ 读 details.model、④ rename-session 分类；连带：`docs/pi-semantics.json` 新增 probe 条目「appendCustomEntry 落盘形态含 customType/data/timestamp」+ 扩展 `packages/runtime/src/infra/pi/__tests__/pi-semantics-session-entries.test.ts` 断言；服务头注更新（④ 为 xyz 自有口径，不再与 pi 三分类对齐） | `packages/runtime/src/services/usage/usage-stats-service.ts` + 测试、`docs/pi-semantics.json`、上述探针测试 | G2/G3 通道；依赖 U3/U5 的数据形态；升级门禁纳入新探针防漂移 |
| U7 | 类型注释与设计文档回写 | `packages/shared/src/usage-stats.ts`（注释）、`docs/todo/usage-stats-design.md`（D1 增补归属来源与 ④ 分类）、本文档 | C-proc-10 设计文档同步纪律（登记即债务修复即清账） |
| U8 | 端到端验收 | 按 §4 V1-V12 执行 | 验收独立成单元，防实施完跳过（含 V12 守卫组合场景） |

**待验证检查点**（设计阶段无法确定，诚实标注；实施后全部闭合）：P-appendEntry 的 fire-and-forget 时机（✅ U5 实测）、P-en-i18n 的 en keys 完备性（✅ U2 齐备）、P-narrow 的窄窗布局（✅ U8 横滚激活）。

---

## 附录：变更历史

- v1（2026-09-08）：初稿，四问题 → 三层修复方案。
- v2（2026-09-08）：R1 双审修复（主审 1MF+2S / 影响面审 2MF+5S 全修）——V4/V6/V8 补 `XYZ_AGENT_DATA_DIR` 桥接消除验收断链；复合键裸串比较带清单化并撤回「编译期全捕获」声明；U3/U6 增补 pi-semantics 探针登记（details 透传 / custom entry 落盘形态）；④ 守卫与回退字面量对称化；appendEntry 落点收敛 llm.ts + 回调注入 pi 句柄；代价声明修正机制归因（successCount 门控）并补 PS-17 flush 窗口 caveat、图例语义重审触发、cost 缺失 $0 诚实降级语义；时点数据漂移标注。
- v3（2026-09-08）：R2 双审修复（主审 0MF+5S / 影响面审 1MF+3S 全修）——modelProviderMap 派生源钉死为全量 rows（R2 反例：从过滤后聚合派生则 toggleProvider 先 add 后查确定性丢键、守卫失效、图表净空）并增 V12 组合场景；isolate chip 列为复合键第四消费点；cacheMix TOP-4 声明 token 域例外（G4 措辞同步）；「重置」事实修正为文本按钮（含文本按钮全去 size=icon）；V8 改打 rename-session 自身 model selector（防 provider 级断供空转假绿）；catch 归属钉死回调体内；U1↔⑥ 同步；probe 测试文件补入 U3/U6 交付列；dev 单实例锁前提补入依赖说明。
- v4（2026-09-08）：R3 双审修复（主审 0MF+4S / 影响面审 1MF+2S 全修）——U8 验收范围同步 V1-V12（V12 入端到端执行单元）；isolate 比较与查表穷举清单化（ModelRank 三处比较用复合键行标识 + modelProviderMap prop 查表随值结构化删除，禁 unknown 兜底）；V12 补前置状态（重置起步 + ≥2 启用 provider + P2 读出处）；V8 补主 turn 成功正向断言 + config 位于系统 pi 目录不受隔离/测试后恢复；⑥ 补 isolate 联动清除条目（V12 的规格锚点）；§3.6 守卫措辞修正（拦截最后一个启用 provider 的关闭，非「最后第二个」）。
- v5（2026-09-08）：实施完成回写（主 agent，C-proc-10）——§3.5 探针状态列 5 项 ⛔→✅（P-appendEntry/P-chat-noop/P-narrow/P-usage-shape/P-en-i18n，U4/U5/U8 实测闭合）、§5 待验证检查点同步闭合；无规格变更。同批：一致性审查（阶段 3）三区报告聚合——12+ reasonable 入 impl-plan 登记表、1 unreasonable（CacheMix :key 复合键化，定向修中）、4 doc_errors 本批修正（探针状态列 / PS-29 note 同步返回措辞 / todo 锚点标签与 D11 枚举；scanner 头注注释标签由 U6 接替实例同批修正）。
