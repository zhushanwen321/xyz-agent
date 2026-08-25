# 用量统计页 · 设计方案

> 状态：设计提案（2026-08-24）。交互 demo：[usage-dashboard.html](./usage-dashboard.html)（浏览器直接打开，自包含无依赖，数据为确定性模拟）。
> 需求：查看 xyz-agent 整体用量，支持分 provider / 分 model / 分日期、按日期聚合。

## 一、数据源结论（已验证）

| 事实 | 依据 |
|------|------|
| 每条 assistant 消息自带完整用量 | session JSONL 的 `message` entry：`entry.message.{provider, model, usage, cost}`，`usage = {input, output, cacheRead, cacheWrite, cacheWrite1h, reasoning, totalTokens, cost{…USD}}` |
| 离线聚合可行，无需运行 pi 进程 | 已用真实 session 文件验证字段存在；pi 自带 `getUsageCostBreakdown` 可参考聚合语义 |
| cost 单位为 USD，订阅制 provider 恒为 0 | 真实数据：opencode-go/deepseek 有非零 cost，kimi/zai/xiaomi 为 0 |
| **token 是普适主指标，cost 只能条件展示** | 上一条推论：以费用为中心的界面（ccusage 式）对订阅制用户大面积显示 $0.00 |
| cacheRead 通常占 70-90% | coding agent 上下文复用特征；缓存命中率应成为一等公民指标 |
| session entry 带 `cwd` | 白送「按项目」聚合维度，竞品中 Cline（workspace 过滤）已验证价值 |
| 统计范围 | `~/.xyz-agent/pi/sessions/*.jsonl`（当前 18 个 / 8.8MB，全量扫描秒级）；全局 pi 目录（4603 个 / 2.6G）需增量缓存，建议二期 |
| 实时链路字段不全 | runtime event-adapter 只透传 input/output/totalTokens；cacheRead/cacheWrite/cost 仅在 JSONL 落盘数据中，聚合必须走「读文件」路线 |

聚合口径：assistant 消息 usage 逐条累加；compaction / branch_summary entry 的 usage 也计入（与 pi `getUsageCostBreakdown` 一致）。

## 二、竞品调研归纳

| 工具 | 形态 | 可借鉴 | 缺陷（我们要避免） |
|------|------|--------|--------|
| Claude Code + ccusage | CLI 表格；daily/monthly/session/blocks 四级聚合 | 多级平铺聚合切换；`--breakdown` 按模型拆分；费用精确到分 | 纯 CLI 无可视化 |
| Cline | 任务列表 + 展开明细 | ↑↓→← 箭头语义区分 token 流向；渐进式披露；mostExpensive 排序 | 无聚合视图、无趋势 |
| GitHub Copilot | credits 额度 + 预算告警 | 75%/90%/100% 阈值告警思想 | 用量不透明、无模型拆分 |
| Cursor | 请求池额度 | 额度抽象简单 | 个人用量展示不透明 |
| Vercel Analytics | 趋势图 + 排名 Panels | 「趋势 + 排名列表」布局模式；时间范围切换 | - |

## 三、方案对比

### 方案 A：单页纵向叙事「墨层台账」（推荐，demo 即此方案）

页面自上而下一屏多段，全部数据仪器围绕同一组过滤器联动：

1. **摘要台账行**：一行内联数字（总 Token / 费用 / 消息数 / 活跃天 / 缓存命中率 / 峰值日），竖 hairline 分隔。拒绝 SaaS 大数字卡片阵。
2. **每日消耗**：按 provider 堆叠的日柱状图（墨层堆叠，灰阶来自 tokens 阶梯），hover tooltip 含 ↑输入/←命中/↓输出明细，峰值日自动标注。
3. **节奏热力日历**：近 16 周 GitHub 式网格，墨色五档深浅 = 当日消耗。长周期「按日期聚合」的一眼视图。
4. **模型谱**：排名条形列表（mono 数字 + 占比），点击行单看该模型（全页联动过滤）。
5. **项目谱**：按 cwd 聚合，微型堆叠条展示 provider 构成（视觉呼应主图）。
6. **缓存构成**：Top 模型的 命中/新输入/输出 百分比构成条，coding agent 独有的健康度视角。
7. **明细台账**：按 provider 分组的可折叠表格，Cline 箭头列头（↑ 输入 / ← 缓存读 / → 缓存写 / ↓ 输出）。

交互模型：图例 chip 点击开关 provider（≥1 保护）；模型行点击单看（chip 显示、一键清除）；指标切换 Token ⇄ 费用；范围切换 7/30/90/全部。热力日历固定 16 周独立于范围（长记忆视图）。

- 优点：符合太极「默认极简，渐进展开」；信息密度高但视觉克制；实现为 Settings 内一个页面，改动面小。
- 缺点：单页滚动较长（分节 hairline 节奏缓解）。

### 方案 B：三分屏驾驶舱

左：日历/日期列表；中：主图；右：模型/provider 面板。点击跨面板联动过滤。

- 优点：空间利用率高，探索感强。
- 缺点：更接近传统 dashboard cockpit，与太极克制气质冲突；实现重（三栏布局 + 全联动状态机）；窄窗口塌缩复杂。**不推荐做 Settings 内页**，若未来做独立「Overview 全局鸟瞰」（P4）可重评估。

### 方案 C：命令面板 + 迷你浮层

`/usage` 命令唤起小浮层显示本 session/今日/本月三行摘要，深页可选。

- 优点：最轻。
- 缺点：不满足「漂亮美观 dashboard」诉求。可作为 A 的未来补充（快捷入口），不作为本体。

## 四、主题自适应（派生 token 化，6 套全覆盖）

demo 支持 app 全部 6 套主题（暗色族：玄/黛蓝/暖墨；亮色族：皓/青墨/朱印），右上角 seg 切换，即时生效无需重渲染。机制：

1. **主题块拆分**：`[data-theme]`（族）+ `[data-theme-preset]`（族内 preset）两级，真值逐字对齐 `packages/renderer/src/style.css`（黛蓝/暖墨中性谱自带色相；青墨/朱印共用宣纸阶梯、只换 accent）。共用层（字体/圆角/动效）留 `:root`。
2. **图表色零手写，全部从「图表墨」`--chart-ink` 派生**：provider 序列 `--chart-p1..p5`、热力墨阶 `--heat-0..5`、缓存三色 `--cache-hit/in/out` 均 `color-mix(in oklch, var(--chart-ink) X%, var(--bg))`；交互层（hover/底槽/描边）从 neutral 谱派生保持中性。
3. **--chart-ink 三层语义**：中性主题（玄/黛蓝/暖墨/皓）= `var(--neutral-fg)`，黛蓝/暖墨中性谱自带色相故派生自动带相（实测 bar 色度：玄 C=0.005 < 暖墨 C=0.006 < 黛蓝 C=0.0085）；彩色 preset（青墨/朱印）中性谱与皓相同，另掺 `color-mix(accent 45%, neutral-fg)` 使图表可感知换色（实测：青墨 C=0.023 H=195.6°花青、朱印 C=0.053 H=30.9°朱砂）而不淹没中性阶梯——邁循 app「大面积中性 + 小面积 accent」哲学，只染图表墨不染背景。
4. **明度方向自动反转**（暗：墨越亮越浓，bar L≈0.85；亮：墨越深越浓，bar L≈0.34-0.43）。
5. **SVG 零重渲染跟随**：SVG presentation attribute 不支持 `var()`，柱体/网格/轴文字一律 `style="fill:var(--chart-p1)"`，切主题只改 dataset 两属性，全部图表即时重算。

全部 6 主题通过自动化对比度（AA）+ 截断审计；跨主题数据一致（19,068,662 tokens / 105 柱）。亮色族及暗色 preset 的中性谱对比度修正提案（均待回写 SSOT）：

| token | SSOT 现值 | 对应背景 | demo 提案 | 对应比 |
|-------|-----------|-----------|-----------|--------|
| 玄 `--neutral-dim` | `#74747a` | 玄 bg（3.99:1） | `#85858c` | ≈5.1:1 |
| 黛蓝 `--neutral-dim` | `#74767f` | 黛蓝 bg（≈3.99:1） | `#85888f` | ≈5.1:1（保蓝相） |
| 暖墨 `--neutral-dim` | `#79756f` | 暖墨 bg（≈3.9:1） | `#8a857e` | ≈5.0:1（保暖相） |
| 皓 `--neutral-mid` | `#706e6a` | 宣纸（4.26:1） | `#5d5b56` | ≈5.6:1 |
| 皓 `--neutral-dim` | `#9d9b96` | 宣纸（2.35:1） | `#64625c` | ≈4.8:1 |

## 五、demo 验证记录（2026-08-24）

- 程序化审计通过：无文字截断、无横向溢出、表格列右对齐一致、图表柱体无越界。
- 交互验证通过：图例开关（kimi-coding off → 总量 19M→12M 正确联动）、指标/范围切换、模型单看（chip + 全页过滤 + 一键清除）、表格分组折叠。
- 双主题验证通过（2026-08-25 补）：玄/皓切换即时生效（CSS 变量重算，无重渲染）；亮色下堆叠柱/热力/图例/缓存条/nav active 全部正确跟随且墨阶方向反转；双主题对比度审计 + 截断审计全过；暗色回归一致（数据 19M/105 柱不变）。
- 6 套主题验证通过（2026-08-25 二补）：玄/黛蓝/暖墨/皓/青墨/朱印逐一验证 —— 变量生效、bar/heat5 实际渲染色带对应色相（黛蓝蓝相、暖墨暖相、青墨花青 H≈196°、朱印朱砂 H≈31°）、6 主题对比度+截断审计全过、跨主题数据一致；截图存档 /tmp/usage-theme-{xuan,dailan,nuanmo,hao,qingmo,zhuyin}.png。
- 人工视觉复核：本会话无可用的视觉引擎（MiniMax/zai key 均未配置），未做截图人眼复核；建议打开 demo 人工过目一遍。
- 已知未解之谜：Chrome 冷启动首次读取到与后续不同的聚合值（76/8.6M vs 140/19M），重载后确定性稳定（连续两次 100% 一致），未能复现，疑冷启动时序假象。

## 六、落地实现映射（若进入开发）

| 层 | 改动 | 说明 |
|----|------|------|
| runtime | 新增 `UsageStatsService` | 扫描 `~/.xyz-agent/pi/sessions/*.jsonl`（复用 `session-file-utils.scanPiSessions`），流式解析 assistant entry，聚合为 byDay / byProviderModel / byProject；聚合结果持久化到 `~/.xyz-agent/usage-cache.json`（按文件 mtime 增量），首扫后台执行 |
| transport | WS RPC `usage.getStats(range)` | 入参 `{rangeDays, metric}`，出参聚合结构（shared 类型） |
| shared | `UsageStats` 类型 | demo 内聚合结构与之一一对应 |
| renderer | SettingsModal nav 增「用量」+ `UsagePage.vue` | demo 的 DOM/CSS 结构即组件拆分蓝图（Ledger / DailyChart / HeatCalendar / ModelRank / ProjectRank / CacheMix / DetailTable 七块）；图表用手写 SVG（与 demo 同构，不引图表库） |
| 布局注意 | 用量页内容列需突破 `--content-max-w: 720px` | demo 用 max-width 1064px；图表型页面 720 过窄，需在 SettingsModal 对该页放宽 |
| 主题适配 | 图表派生 token（`--chart-ink` + `--chart-p1..p5` / `--heat-0..5` / `--cache-*` 等 color-mix 派生色）登记进 v6-tokens.css + design-tokens.md | 零手写色值，6 套主题全自适应（暗族中性谱自动带相、亮族 preset 掺 accent 45%）；中性谱对比度修正提案（§四表）需同步裁决 |
| 边界 | 空态（无 session）→ 引导空态；活跃 session 未 flush → 标注「数据截至」；cost 全 0 → 费用列整体降级为 dim | |

二期候选：全局 pi 目录（~/.pi/agent/sessions）聚合（增量缓存）；预算阈值告警（Copilot 式 75/90/100%）；CSV/JSON 导出；5 小时计费窗口视图（ccusage 式，仅对支持该计费模式的 provider 显示）。
