# v6 设计稿复审报告 · 第二轮（修复后核验）2026-07-31

> 审查对象：v6 全套设计稿（v6-design.md + 18 spec HTML + 3 demo + SSOT 链文档），在 [`v6-fix-plan.md`](./v6-fix-plan.md)（rev3，62 任务）声称执行完毕后的状态。
> 基线：[`visual-modernization-2026-07.md`](./visual-modernization-2026-07.md)（最初设计意图，mixer 组合①）+ [`v6-design.md`](./v6-design.md)（回写 D1-D11 + R1-R26 后的最终 SSOT）+ [`v6-review-2026-07-31.md`](./v6-review-2026-07-31.md)（第一轮审查，349 条断言）。
> 方法：6 路并行审查（Settings / 对话流 / Shell+demo / 侧栏+Drawer / Overlays+Plugin+Tokens / SSOT+横切），逐条核验 fix-plan 任务执行证据（文件:行号），子报告全文见附录。
> 与第一轮的关系：第一轮回答「设计稿哪里错」，本轮回答「修复是否真的修对了」。

---

## 一、总体判断

**修复确实执行了，执行率约九成。** 五原则（层级代替边框 / 圆角升档 3→6px / 正文提亮 #7d8494 / 内容收窄 720px / 彩色降噪）和 D1-D11 裁决在 SSOT 与各 spec 中基本落地；第一轮 349 条断言的大部分已消除，base.css 抽取（D5）根治了对话流四文件漂移，选中态二分（D8）、tasks 移除（D3）在 spec 层统一。

**但修复留下三类后遗症：**

1. **少数大方向在执行层再次分裂**——上轮要消灭的「SSOT 与 spec 互相否定」，在 drawer 投影、UserBubble 列宽、ChangeSetCard badge 等 6 个点上以新形式重现（见 §二）。
2. **大量「修了一半」**——CSS 改了、anno/注释/spec-desc 没跟，至少 12 处。anno 是实施者的直接依据，比 CSS 错误更危险（见 §三-A）。
3. **验收 SSOT 候选 `v6-demo.html` 反而是全场最落后的文件**——drawer 旧模型、tasks tab 残留、选中态旧值、默认态组件口径与单页 spec 分叉（见 §二-1/3 与 §四）。

**当前主要风险不是方向跑偏，而是「三个真值源（design / spec / demo）在若干具体点上各说各话」。** v6-demo 作为验收基准却展示被 D2/R14 推翻的方案，截图验收一定会走岔。

---

## 二、大方向不一致（6 项）

### 1. D2 drawer 一体化三方分裂（最严重）

| 真值源 | 位置 | 现状 |
|--------|------|------|
| design（SSOT） | v6-design.md:202、:130、:43 | 保留弱投影 0.16 + 共享 surface 浮起 ✓ |
| shell spec | v6-spec-shell.html:1237、:1326 | §7 做成「无投影无 border、同色无需分隔」，**推翻 R14**；token :47 已弱化到 0.16 却无消费者 |
| v6-demo（验收 SSOT 候选） | v6-demo.html:88、:412 | **仍是 D2 前旧模型**：`bg-sunken` + 0.25 强投影独立浮层 |

另：`shell:479/541/588` 三处 drawer 演示区整底 `surface-2`，与「与 main 同 surface」（drawer spec:197 正确）字面矛盾。

**裁决需求**：投影口径二选一——补回 0.16 弱投影（推荐，同色一体下防震动感），或正式改 design 裁决为「同色无投影」。

### 2. R10「整 turn 居中」被 container spec 反向写成「UserBubble 不进 720 列」

`v6-spec-container.html:191/194/205` 三处明示气泡不进列，`base.css:304` `.ub-wrap` 无列约束。与 design 决策 #11（v6-design.md:49「整 turn 居中 720px，UserBubble 在列内右浮」）和 v6-demo:307/838 实际画法**双向冲突**。照 spec 实施就会做错。

### 3. D3 tasks 移除在 v6-demo 未跟进

`v6-demo.html:699/899/941-954` 完整保留 tasks tab + goal-card/todo 内容；demo drawer 仅 4 tab，与 drawer spec 的 7 tab 口径（terminal/browser/git/doc/detail+subagent+workflow）不符。

### 4. 侧栏第 5 tab（plugin）未落地

design §4.2 标题写明「5 tab，第 5 tab 为 plugin」（v6-design.md:184 + 决策 #15 :33），但 `v6-spec-sidebar.html` 全文 4 tab、grep plugin 零命中（spec-desc :604 仍「icon-only 4 tab」）。fix-plan L3.12 漏列此缺口。

### 5. ChangeSetCard 状态 badge 三方分叉，未裁决回写

| 真值源 | 位置 | 方案 |
|--------|------|------|
| design | v6-design.md:175 | 状态 badge 降灰阶，「待审查」胶囊 accent-soft |
| base.css | base.css:284-290 | 5 态彩色（accent/info/warn/success soft）+ rounded-sm，注释「与代码 ChangeSetCard.vue:22 一致」 |
| v6-demo | v6-demo.html:384 | 单胶囊 accent-soft |

fix-plan L3.8 选了代码现状版做权威但未回写 design §4.1，属未登记不一致。**需裁决后三处统一。**

### 6. 设置内容区底色两稿矛盾，必有一错

`v6-spec-settings-shell.html:196` `.fs-content = surface` → bg-card(#22242c) 卡片比父级**更暗**（下沉非浮起，与 :298 注释「明度差表达边界」方向相反）；`v6-demo.html:589` 内容区 = `--bg`（卡片浮起 ✓）。建议对齐 demo 改 `--bg`。

---

## 三、细节不一致（按模式归类）

### A. 「修了一半」综合症（本轮修复新引入的最高频问题模式，≥12 处）

CSS 已改，anno/注释/spec-desc 未跟，anno 与 CSS 直接打架：

| 位置 | 残留内容 | 实际 CSS |
|------|---------|---------|
| v6-spec-drawer.html:2523、:2420 | wf-call 选中态 anno「bg-accent-soft · agent 名 text-accent」 | :615 已改 bg-surface（R15） |
| v6-spec-drawer.html:1072 | anno「SegmentedTab p-[2px]」 | :275/:291 已 p-3px（R20） |
| v6-spec-sidebar.html:1039 | anno「pill 圆角 3px」 | :295 已 6px（R22） |
| v6-spec-settings-shell.html:833 | spec-desc「radius-8」 | :296 已 10px，§4 标题 :832 也是 10px |
| v6-spec-settings-shell.html:755、:821 | 「nav 占左 200px」两处 | :194 实际 w-220 |
| v6-spec-settings-extension.html:196、:874、:1437 | 三处宣称 scope pill「中性 + inset border」 | :197-203 已去 border；另 :1348/:1356/:1395 残留无意义 `box-shadow:none` |
| base.css:225 | 注释「send-slot 同档 16px」（谎称） | :412 实际 svg 15px（L3.7 要求→16px 未执行） |
| base.css:212 | 注释「13px 对齐 §5.3 scale」（13 不在 {10,12,14,16} 中） | ph-status 13px |
| v6-spec-container.html:392、:459（+骨架 :53） | 瞬时浮层注释称 `border-border/50` | :54/:59/:63/:86 实为 `neutral-faint 50%`（强度差数倍） |
| v6-spec-input.html:61 | qb 分隔线 CSS=`border-strong 50%`、注释称「border-border/50」、desc :221=`border-border/50` | 三处值互不符 |
| v6-design.md:244 | §4.5 行标题仍「ProviderEditModal → 嵌入式面板」 | 内容已是手风琴（R4），决策 #14 已改 |

### B. 明确漏改的修复任务

1. **R11 block icon 14px 只改了 design**：base.css:245 `.tk-ico` / :258 `.tool-ico` / :312 `.bob-ico` + blocks:154 `.sa-ico` / :166 `.wf-ico` 全部仍 13px，anno blocks:288/:439/:714/:895 亦写 13px。
2. **D7 文档 chrome 恰恰漏在新建的共享文件**：base.css:179 `.state-tag` 仍 `text-transform: uppercase`——对话流四稿全部继承。plugin:377 `.ansi-table th`、:561 `.cap-api-table th` 同漏。
3. **CommandPopover 选中态**：base.css:445/455 `.cmd-row-slash.sel`/`.cmd-row-file.sel` 仍 accent-soft+accent，与 plugin spec:405（bg-surface+蓝字，注释明引 §3.2）同组件两说法；v6-demo:621 `.cmd-item.active`、:636 `.ask-opt.sel` 同病（违 R6/R7）。
4. **accent-soft 选中态残留**：plugin:1418/:1479（C2 ask-user 选中项）、max-demo:175 `.companion`（surface-hover + accent-ring 边 + 8px，未对齐 overlays 范式）、max-demo:181/:201 `.copt.sel`/`.cp-row.sel`。
5. **provider:659-660** `.j-decision`/`.j-success` warn/success 10% 染底卡片未改中性（L4.2 自查补项遗漏）。
6. **字面全大写文本**：`text-transform` 删了但文本硬编码大写——blocks:258/270「THINK」、input:558/561「ZHIPU」「ANTHROPIC」、drawer:1995/:2044/:2152「BLOCKED/ACTIVE/VERIFY」。normal-case 修复形同虚设。
7. **内联渐变残留**：input:513 quota 明细行 `linear-gradient(accent→accent-hover)`（L3.10 只改了 .cap-bar 类）；tokens:343 radius-demo 渐变样块。

### C. SSOT 自身漏洞

1. **v6-design.md 双 `## 9.` 标题编号 bug 未修**（:441 验收基准 / :463 文档同步清单，第一轮点名项）+ §5.4→5.6 跳号（:274/:278，缺 §5.5）。
2. **两处 spec 单点声明未回写 design**：toast z-9999 例外（overlays:516 已本地登记，design §5.2 :268 无）；gprog-fill 55%（plugin:324 注释谎称「design §2.3 登记」，实际 :79-84 无）。
3. **drawer spec 称 browser 多 tab「已授权 D4」**（:1497/:863/:1302 三处）vs design §4.3 :219 仍「browser | 单实例（暂）」——改了 spec 未回写 design。
4. **README.md:56** 死链已删的 v6-spec-settings.html；**:67** 称 base.css「规划中，尚未创建」（实际 22:50 已建）。
5. **v6-summary.md 大面积滞后**：:241 称 README「未提及 v6」（已更新）；:276 仍列已删文件；:231 文件计数错；§5 行数列过时（content 标 1,081 实 634、container 标 1,269 实 873、blocks 标 1,569 实 1,173、input 标 1,161 实 759）；:321 笔误「0.24px」。
6. **design-tokens.md:79** 仍 `--radius-sm: 3px`、无 #7d8494/content-max-w、无 v6 注记（fix-plan 有意 deferred 留实施期，但过渡期与 README「唯一值源」并行存在 3px↔6px 矛盾，建议至少加一行 v6 预告注记）。

### D. 死 token / 死代码

- `--neutral-dim-old` 五文件零消费残留（shell:34 / provider:36 / resources:26 / system-prompt:25 / extension:34；base.css:33 仅存留作 swatch 对照，建议加「禁止消费」注释）
- `--composer-btn-size` 四文件残留（provider:99 / resources:46 / system-prompt:45 / extension:97；settings-shell 已删，其余未跟进）
- `v6-spec-shell.html:48-49` `--shadow-glow`、`--composer-btn-size` 零消费未删
- `v6-spec-sidebar.html:205-209` `.sb-overview` 五行死 CSS（渲染已标移除，代码未清）

### E. 裁决空白（需拍板或登记例外）

| 项 | 冲突 | 建议 |
|----|------|------|
| 状态点尺寸 | rp-badge 6px（resources:291）/ fg-dot 5px（sidebar:285）/ seg-badge 6px（sidebar:224）/ au-tab-dot 4px（overlays:284）vs §3.3「统一 7px 无例外」 | design §3.3 补例外清单（badge 内联标记 ≠ 状态点），或统一升 7px |
| drawer 内嵌 toggle 圆角 | .dp-toggle/.l2-view 外层 8px（drawer:275/:291）vs R13「SegmentedTab 统一 12px」 | 升 12px 或登记「drawer 内嵌 8px」例外 |
| plugin 第 5 tab 文字色 | .plugin-primary.active `color: accent`（plugin:449）vs §3.1 text-neutral-fg | 建议保留 accent 作 plugin 身份色，design §3.7 登记例外 |
| mandatory scope pill | accent-soft 整底（extension:202）vs R17「彩色降为极小圆点」 | 系统强制确属需注意对象，建议 design §3.3 登记例外 |
| loader stroke | tokens 稿 anno「1.7 保留」vs design §4.1「统一 1.75」 | design 补「loader 1.7 例外」或改 1.75 |
| nav count 选中态 | settings-shell:258 `.ni-count` 选中变 accent-soft+accent vs design §4.5「count 中性圆点」 | 改中性或登记例外 |

### F. 其他零星

- drawer:1667-1687 badge 范式 demo 的 standalone span 不在 `.gp-file` 作用域内，neutral-dim/U-danger 规则不命中，演示所见非所得
- drawer:1862-1864「现」态对比 span 用 var(--radius-sm)（现已 6px）却标注「圆角 3px」，旧态演示数值失真
- drawer:185 state-tag 76px vs sidebar:165 84px（E.9 统一未做）
- exit 标签档值不统一：base.css:264 surface-2 vs v6-demo:374 bg-elevated
- resources:172 `.ui-input.dense` padding 4px 10px vs provider:234 dense 继承 0 12px，两文件不一
- drawer-tabs-demo:23 `--shadow-drawer` 仍 0.25、:53 drawer 仍 bg-bg、:125/:129 正文仍「6 个一级 tab」（SUPERSEDED 横幅可兜底，但数值同步做了一半）
- tokens:471 层级连线用 accent-ring 色（文档 chrome 唯一彩色线，建议 border-strong）
- plugin:1981「M10 已闭环」与「5 个完整闭环」计数表面矛盾（注解措辞需澄清）
- shell:530 `.dd-toggle.active` 常驻 accent-soft（持续态指示不应占用瞬时高亮）
- settings-system-prompt:132 `.sp-subtitle` 仍 neutral-dim（design §4.5 要求描述 neutral-mid）

---

## 四、分页面改进意见（按优先级）

### P0 — v6-demo.html（验收 SSOT，必须先修）

demo 默认态已修正为组合①（a+semantic+legacy :666），但以下内容使它**不配做验收基准**：

1. drawer 重做 D2 新模型（并入 main 同体 bg-surface + 0.16 弱投影，去 bg-sunken + 0.25）
2. 删 tasks tab，至少以占位补齐 browser/doc/subagent/workflow，与 7 tab 口径一致
3. `.cmd-item.active` / `.ask-opt.sel` 改 §3.2（bg-surface+蓝字）
4. settings 容器去 border+radius（全屏无框对齐 .fso），内容区加 max-w-720 左对齐列
5. 默认 semantic 态三处彩色降噪违规：wf done 进度条 success→neutral-dim（:504）、GoalCard complete badge 降中性（:544）、git M badge warn→info 蓝（:469）
6. 组件口径追平 spec：block icon 换 Brain/SquareTerminal 新体系（:846/:860）、bash 容器 8px→12px（:352）、文件树缩进 16px→10px 步进（决策 #12）、:970-977 区域
7. tm-pill/exit-tag/change-set 的 bg-elevated（:324/:374/:378）与 base.css 的 surface-2（R23）统一一档——**需先裁决面上面升档用哪一档，再回写 design §4.1**

### P1 — 方向性收敛 4 件

1. **shell §7 投影口径**：二选一（补回 0.16 / 正式改裁决），drawer 演示区底色改 body=surface + header=surface-2（修 :479/:541/:588）
2. **container UserBubble**：§1 演示改气泡在 720 列内右浮（.ub-wrap 加列约束），同步改 :191/:194/:205 三处文案
3. **设置内容区底色**：建议对齐 demo 改 `--bg`（bg-card 卡片才能浮起）；若坚持 surface 则 bg-card 需换更亮档，并在 design §4.5 登记
4. **ChangeSetCard badge**：裁决「5 态彩色贴代码」还是「design 降灰阶+胶囊」，回写 design + base.css + demo 三处

### P1 — base.css 大扫除（一行修四稿的杠杆点）

- state-tag 去 uppercase（:179）
- CommandPopover sel 改 §3.2 bg-surface+蓝字（:445/:455），与 plugin spec:405 对齐
- block icon 13→14px 五处（:245/:258/:312 + blocks:154/:166），anno 同步
- send-slot svg 15→16px（:412），修 :225/:212 两条失实注释
- 「THINK」等字面大写文案正常化

### P2 — anno 对账（建议机械执行）

全库 grep anno/spec-desc 中的数值类声明（px / opacity / 色名 / 圆角档）与 CSS 逐条对账——「CSS 已改 anno 未跟」至少 12 处（§三-A 表），这是 anno 作为实施依据的可信度问题。

### P2 — 文档群刷新

- v6-summary.md：状态行/行数列全量刷新、删已删文件条目、修 :321 笔误、与 README 明确谁是索引 SSOT
- README.md：:56 死链、:67 base.css 状态
- v6-design.md：双 `## 9.` 编号、§5.5 跳号、toast/gprog-fill 两处例外登记、§3.7「is-current popover 项」豁免补定义句
- 死 token/死代码清理（§三-D）
- design-tokens.md 加 v6 预告注记（或提前反写）

### P2 — 其余各 spec 单点

- **settings-shell**：sticky page-head 常驻 border-b（:279/:287）与 design §3.4「header 去 border-b 改 bg 浮起」不一致，建议 bg-elevated 或 0.04 hairline；`.settings-modal` 类名名实不符（全屏非 modal）建议改 `.fso`；左对齐理由文案（:821「与对话流 assistant 列对齐」）不成立，建议改写或删除
- **settings-provider**：j-decision/j-success 去染底；`.input-seg button` 10px 偏小建议 11px；`.ml-row` :424/:447 重复定义建议注释互指；`.detail-edit` border-top 0.08 建议统一 0.04
- **settings-resources**：rp-badge 彩点语义补 anno 映射表；`.rp-badge.faded` opacity .6 与 disabled 0.5 标准统一或注释理由
- **settings-system-prompt**：sp-subtitle 升 neutral-mid；:547/:807 mono 快照块范式建议在 design 登记为设置页调试态通用模式；`.sp-label` 11px dim 建议 12px mid
- **settings-extension**：mandatory pill accent 例外登记；anno :1523 补「extension scope 与目录 scope 是正交两维」
- **v6-spec-blocks.html**：`.gt-goal-card.warning` warn 6% 整底染色（:111）建议降为小圆点/文字；§9 GoalCard 演示文案改正常大小写；`.ts-verify` 9px 升 10px 入 scale
- **v6-spec-content.html**：质量最高，仅 §12 head 范式注释（:224-227）与 base.css:350 实际值对齐一次
- **v6-spec-input.html**：:513 内联渐变清除（quota 行复用 .cap-bar 类）；:61 qb 分隔线按 `color-mix(--border 50%)` 对齐；:211 anno ⚠ 改 SVG/纯文字
- **v6-spec-sidebar.html**：补 plugin 第 5 tab（§2 加 Puzzle icon 或头部声明「见 plugin spec」）；删 .sb-overview 死 CSS；状态点口径统一（§三-E）；kbd 保留 border 补 anno 登记；`.fg-item.fresh` inset ring 可考虑去掉只留 accent-soft 淡出
- **v6-spec-drawer.html**：anno 残留集中清扫（:2523/:2420/:1072）；badge demo standalone span 补色；§9 章节标题改「tasks tab 移除决策（视觉参照存档）」；state-tag 76→84px
- **v6-drawer-tabs-demo.html**：`--shadow-drawer` 同步 0.16、drawer 底色改 surface；「6 个一级 tab」表述改 7 tab 口径；`.seg`/`.crumb-view` 8px→12px；`.crumb-file` 11.5px 入 scale
- **v6-spec-shell.html**：删 :48-49 死 token；`.dd-toggle.active` accent-soft→bg-elevated；§7 补 drawer↔main Splitter hover 态视觉落点
- **v6-spec-overlays.html**：§1 z-index 三处（:453/:482/:508）SideDrawer 从 overlay 档摘除；:1156「border+投影双表达」注明浮起可交互容器豁免；au-tab-dot 4px 补 anno 说明；Toast 例外回写 design §5.2
- **v6-spec-plugin-rendering.html**：C2 选中项改 bg-surface+蓝字；两处 th 去 uppercase；gprog-fill 55% 二选一（design 登记/改注释）；plugin 身份色例外登记
- **v6-plugin-max-demo.html**：companion/copt.sel/cp-row.sel 同步 plugin spec 范式；.schema-tag 3px/.section-desc code 4px 升 6px 或免责声明点名；M15 dialog 标题整行 danger 改中性（仅 icon 留 danger）；:418 ⚠ 改 SVG；:223 sb-dot 6px
- **v6-spec-tokens.html**：:471 层级连线改 border-strong；§6 z 表补 toast 9999 例外行；loader 1.7/1.75 灰区收敛；建议头注声明「token 块以本文件为 SSOT，其余 18 份为拷贝」（当前靠人肉对齐，下次改值必再漂移）

---

## 五、待裁决清单（第二轮）

| # | 裁决点 | 两个选项 | 建议 |
|---|--------|---------|------|
| N1 | drawer 投影 | 补回 0.16 弱投影 / 正式改裁决为同色无投影 | 补回 0.16（R14 原意） |
| N2 | 面上面升档用哪档 | surface-2（R23，base.css 现状）/ bg-elevated（demo 现状） | 统一一档后回写 design §4.1 |
| N3 | ChangeSetCard badge | 5 态彩色贴代码 / 降灰阶+单胶囊 | 降灰阶+胶囊（彩色降噪方向） |
| N4 | 设置内容区底色 | surface（卡片下沉）/ --bg（卡片浮起） | --bg |
| N5 | plugin 第 5 tab 文字色 | accent 身份色例外 / neutral-fg 守 §3.1 | accent + 登记例外 |
| N6 | 状态点尺寸例外 | 登记 badge 内联标记豁免清单 / 全部升 7px | 登记豁免清单 |
| N7 | UserBubble 列宽（若对 R10 有疑义） | 列内右浮（design+demo）/ 贴 panel 右缘（container spec 现状） | 列内右浮（维持 R10） |

---

## 附录：6 份子报告全文

> 以下为 6 路审查 agent 的原始报告（含逐任务执行核验表 A、大方向一致性 B、细节问题 C、分页面意见 D）。行号以 2026-07-31 23:19 文件状态为准。


---

### 子报告 1 · Settings 组

核验完毕，以下为复审报告。

## A. 修复任务执行核验

### L3.1 — v6-spec-settings-shell.html（结构性重写，D1）
- 全屏覆盖 `.fso` fixed inset-0 / z-modal / bg-bg 纯不透明 → done — `v6-spec-settings-shell.html:187-190`，anno :623-629 与 spec-desc :537 同步
- nav w-220 bg-sunken 无 border-r → done — :194（`width:220px; background:var(--bg-sunken)`），:624 anno 同步
- nav 选中态 bg-surface+text-accent 无 ring → done — :247 `.nav-item.active{background:var(--surface);color:var(--accent)}`
- 内容列 margin:0 + max-w-720 → done — :270 `.content-col-inner{max-width:var(--content-max-w);margin:0}`
- 分组卡片 10px → **partial** — CSS :296 已 10px、§4 标题 :832 写 10px，但 spec-desc :833 仍写 `radius-8`（残留旧值）
- hairline 0.04 → done — :313
- ConfirmDialog demo 12px → done — :1372 `border-radius:var(--radius-lg)`（=12px，:83）
- .ui-input 13px / padding 0 12px / checkbox .checked → done — :373、:451
- 死 token --shadow-glow / --composer-btn-size 删除 → done（零命中）；但 `--neutral-dim-old` :34 残留且零消费
- .btn svg 16px 规则 → done — :340
- nav icon 17→16px → done — :252 `.ni-ico{width:16px}`
- 死链 7 项标「待补 spec」→ done — :652 登记 + :660/:665/:679/:683/:687/:691/:695 title
- §9 i18n P0 五 key 验收区块 → done — :1453-1540（soundTitle/successSound/errorSound/soundDefault/soundPreview 五 anno 齐全）
- inline error token 化 → done — :1348 `background:var(--danger-soft);border:1px solid var(--border)`
- `.fs-trap-ring` 删除 → done（全文零命中）
- SelectTrigger 目标态（R3/D10）→ done — :389-392 `border:none;background:var(--bg-input)`，:387-388 注释引 D10
- Switch thumb 0 2px 6px → done — :436
- §6 行级 focus 裁决（R25）→ done — :1306 anno「focus = inset 0 0 0 1px var(--accent-ring)」
- 新增残留：§3 spec-desc :755 与 anno :821 仍写「nav 占左 **200px**」（实际 w-220，旧值未清）

### L3.2 — 旧 v6-spec-settings.html 删除 → done（ls 确认文件不存在）

### L3.3 — v6-spec-settings-provider.html
- .eg 10px → done — :352；hairline 0.04 → done — :376/:424/:447
- .ui-input 13px/0 12px/`.ui-input.dense` → done — :223-234（--text-base=13px :79）；checkbox .checked → done — :282
- .input-seg 去 border/容器 12px/p-3/active bg-elevated → done — :414-420
- Switch thumb 0 2px 6px → done — :261；ConfirmDialog 12px → done — :591
- provider-card 去 border 改 bg-card → done — :290-291；.preview-item 同 → done — :603
- R16 嵌套收敛 3 层（ml-advanced/compat/quota-win 保留 surface-2）→ done — :466-473/:481/:516
- SelectTrigger 目标态 → done — :236-239（border:none + bg-input）
- ProviderEdit 展开就地编辑（R4）→ done — §2 :885-888、doc-sub :680、目标态声明 :689
- pill 全 999 → done — :311/:325/:340/:492/:607/:611
- 行级 focus inset 单环（R25）→ done — :308/:329/:338/:370/:399/:463/:512
- inline error 中性 border+danger-soft → done — :317
- max-height 600px 标注 → done — :470-472（注释说明 transition 上限）
- content-max-w 定义不消费 → spec 侧 done（:98-101 注释声明）；**design §4.5 补注「provider 放弃 720 列宽」未做 → partial**（v6-design.md §4.5 全文无此注）
- L4.2 自查补 `.j-decision`/`.j-success` 染底中性化 → **not-done** — :659-660 仍 `color-mix(warn/success 10%, bg-card)` 染底

### L3.4 — v6-spec-settings-resources.html
- 组头 .lp-group-head hairline 0.08→0.04 → done — :212
- .ui-input 14→13px / padding 0 12px → done — :156-162
- .rp-tabs 容器 12px/p-3/active bg-elevated → done — :263/:271
- scope pill 去 inset border → done — :216-221（无 box-shadow）
- R17 来源 badge 中性底+彩色小点 → done — :285-298（bg surface-2 + ::before 彩点）
- .rp-desc 11→12px → done — :283（text-sm=12px）

### L3.5 — v6-spec-settings-system-prompt.html
- .sp-subtitle/.sp-hint 11→12px → done — :132/:147（分组卡 10px :123、hairline 0.04 :134 原本已合规）

### L3.6 — v6-spec-settings-extension.html
- 组头 .group-head hairline 0.08→0.04 → done — :189
- .seg-tabs 容器 12px/内项 6px/p-3/active bg-elevated → done — :481-492
- scope pill 去 inset border → **partial** — CSS :197-203 已无 inset border，但 CSS 注释 :196、anno :874/:1437 仍写「中性 + inset border」；:1348/:1356/:1395 残留无意义的内联 `box-shadow:none`
- .ver → 999 胶囊 → done — :330；.ext-desc 12px → done — :345

## B. 大方向一致性（对比最初设计意图）

五原则在 Settings 组全部落地：层级代替边框（卡片 bg-card 无 border、nav 无 border-r 靠明度差、provider-card/eg 去双重分隔）；圆角升档（卡 10px、seg 12px、pill 全 999、radius-sm 6px）；正文提亮（--neutral-dim 五文件均 #7d8494，desc 用 neutral-mid 过 AA）；内容收窄（720px mx-0 左对齐 + design §4.5 互相一致，上轮互否已消除）；彩色降噪（R17 badge 中性底+小点、count 中性圆点、inline error danger-soft 化）。D1 全屏化、R4 手风琴、D10 SelectTrigger 目标态、R25 inset 单环、R16 三层收敛、i18n P0 五 key、D7 chrome（五文件 uppercase/彩条注释零命中）均符合裁决，无未登记的方向性偏离。

## C. 细节不一致/新引入问题

1. **P1 矛盾** `v6-spec-settings-shell.html:833` — §4 spec-desc 写「bg-card + `radius-8` + p-10」，与同节标题 :832「10px」、CSS :296 `border-radius:10px`、design §4.5「10px 圆角」矛盾；实现者照 desc 会做 8px。
2. **P1 矛盾** `v6-spec-settings-extension.html:196,874,1437` — CSS 注释与两处 anno 仍声明 user/global scope pill「中性 + inset border」，但 CSS :197-203/:460 与资源页范式 :221 均已去 inset border（L3.6 裁决）；anno 与 CSS 直接打架。另 :1348/:1356/:1395 残留内联 `box-shadow:none`（基类已无 shadow，属修复后 vestige）。
3. **P1 未执行** `v6-spec-settings-provider.html:659-660` — fix-plan L4.2 明确要求 `.j-decision`/`.j-success` 染底卡片改中性底（D7 chrome），实际仍 warn/success 10% 染底（:2051/:2063/:2084/:2096/:2123 渲染中大量使用）。
4. **P2 残留旧值** `v6-spec-settings-shell.html:755,821` — 「nav 占左 200px」两处，实际 w-220（L3.1 已改 nav 宽度但理由文案未同步）。
5. **P2 矛盾（轻）** `v6-design.md:244` — §4.5 行标题仍「ProviderEditModal → 嵌入式面板」，内容已是「手风琴展开编辑区」（R4 改了内容没改行标题）；§1.3 决策 #14 :52 已是手风琴，仅此行标题残留。
6. **P2 未执行** — fix-plan L3.3 末条要求 design §4.5 补注「provider 页放弃 720 列宽（密集表单）」，v6-design.md §4.5 无此注（provider spec :98-101 已自我声明，仅 SSOT 侧缺登记）。
7. **P2 死 token** — `--neutral-dim-old`（shell:34/provider:36/resources:26/system-prompt:25/extension:34）与 `--composer-btn-size`（provider:99/resources:46/system-prompt:45/extension:97）全部零消费残留（shell 已删 composer-btn-size，其余四文件未跟进；L3.1 只点名 shell）。
8. **P2 跨文件不一致** `v6-spec-settings-resources.html:172` — `.ui-input.dense{padding:4px 10px}`，provider :234 dense 继承 `0 12px`，两文件 dense 内距不一。
9. **P2 存疑** `v6-spec-settings-resources.html:291` — rp-badge 小点 6px，与 design §3.3「统一 7px，无 8/9/6px 例外」字面冲突（来源标 dot 是否属「会话/任务状态点」范畴裁决未覆盖，建议 design 登记豁免或升 7px）。
10. **P2 观察** `v6-spec-settings-system-prompt.html:132` — `.sp-subtitle` 12px 已修但仍 `neutral-dim`；design §4.5 要求描述文字 neutral-mid（dim 仅装饰位），bg-card 上 dim 对比度边缘。
11. **P2 观察** `v6-spec-settings-shell.html:258` — `.nav-item.active .ni-count` 变 accent-soft+accent（持久态蓝染），与 design §4.5「count badge 去彩色改中性圆点」字面有偏差；anno :743 已自我说明但未在 design 登记。

## D. 分页面改进意见

**settings-shell**
- 修 C-1/C-4 文案残留（radius-8、200px），此类 anno 是实施者的直接依据，比 CSS 更危险。
- §3 sticky page-head 常驻 `border-b var(--border)`（:279/:287）与 design §3.4「header 去 border-b 改 bg 浮起」方向不一致；建议改 bg-elevated 浮起或降为 0.04 hairline，并在 design §4.5 登记选择。
- 左对齐理由（:821「与对话流 assistant 列对齐」）其实不成立——对话流是居中列，settings 是左对齐列；建议理由改写为「表单阅读动线左起」或删除该句。
- nav count 选中态蓝染（C-11）要么改中性，要么在 design §4.5 登记例外。

**settings-provider**
- 执行 C-3（j-decision/j-success 中性化），这是 fix-plan 明确点名的 chrome 项。
- `.input-seg button` 字号 text-2xs 10px（:417）在密集表单里偏小，与 seg 内项通常 11-12px 不符，建议升 11px。
- `.ml-row` 在 :424 与 :447 重复定义两份（列表态/展开态），注意后续改动需双处同步，建议注释互指或合并。
- 展开编辑区 `.detail-edit` 用 `border-top var(--border)` 0.08（:347），比组内 hairline 0.04 重，建议统一 0.04。

**settings-resources**
- rp-badge 彩点语义（accent=pi/effective、warn=claude、success=agents、info=piinstall）建议在 anno 列一张映射表，目前只有 CSS 可读。
- `.rp-badge.faded{opacity:.6}`（:298）与 disabled 标准 0.5 不一致，建议统一或注释理由。
- 清理死 token（C-7）+ dense 内距对齐 provider（C-8）。

**settings-system-prompt**
- sp-subtitle 升 neutral-mid（C-10），与 shell sr-desc 对齐。
- :547/:807 内联 mono 快照块（bg-input+pre-wrap）是好的「状态可解释性」设计，建议把这种「保存快照/状态机快照」范式在 shell §9 或 design 登记为设置页调试态通用模式。
- `.sp-label` 11px dim（:151）作表单 label 偏弱，建议 12px mid（与 shell fr-label 12px fg 对齐）。

**settings-extension**
- 清 C-2 三处 anno/注释残留 + box-shadow:none vestige。
- mandatory scope pill 用 accent-soft 整底（:202），与 R17「彩色降为极小圆点」口径有张力（系统强制确是需行动/注意对象，可保留），建议在 design §3.3 彩色边界登记「mandatory 锁标 = accent 例外」。
- §9 扫描目录与 §2/§3 复用 .group-head 范式做得好；建议 anno :1523 补一句「extension 的 scope（mandatory/user）与目录 scope（project/global）是正交两维」，防止读者混淆两组 pill。

---

### 子报告 2 · 对话流组

核验完毕，输出报告。

## A. 修复任务执行核验

### L2.1 — 抽取 v6-spec-base.css
- 四文件 `<link>` 引入 base.css → done（container/blocks/content/input 各 `:7`）
- 四文件删重复共享 CSS，仅留独有样式 → done（抽查 `.tm-badge`/`.md-codeblock`/`.comp-box-v6`/`.pop-v6`/`.cs-*` 定义仅在 base.css 出现；四文件 `<style>` 均为独有类；blocks:24-30 的 `.cs-count` 是注释声明的「补强」增量，非重复定义）
- 7 处漂移统一 → done（QueueBubble 内嵌、ChangeSet 5 态、md-codeblock head `base.css:349-355`、md 表格方案A `base.css:362`、RetryIndicator 删、CommandPopover 单行 `base.css:440-452`、pulse-accent 2s `base.css:486-489`）
- 死 CSS 清理 → done（`.sa-task-preview`/`.sa-bgstatus`/`.wf-action`/`.wf-runid`/`.retry-v6`/`.qb-v6` 五文件零命中，仅 input:19/48/66 注释说明已删；`.tool-copy` 删，留 `.blk-copy` blocks:37-48）
- 偏离计划文本一处：`.qb-inline` 未迁入 base.css，留在 input（base.css:375 注释声明「input 独有留 input」）——功能等价，可接受
- token 块正确 → done（radius-sm 6px `:80`、content-max-w 720 `:95`、neutral-dim #7d8494 `:32`、accent-ring 0.30、无 radius-sm-old）

### L3.7 — v6-spec-container.html
- TurnMeta hr 删除 → done（sticky 演示注释 `:53` 区域「已裁决：删 hr」+ anno `:71`；全文无 tm-hr/`<hr>`）
- PanelHeader status icon running 中性 → done（base.css:214 `.s-running → neutral-ico`，desc :474、render :500、anno :531 同步）
- TurnRail R5+D11 → done（active 改 §3.2 `:122-124` 去 ring；`.rail-vp` accent 6px 短粗线 `:113` 非 border-l；h-340 删、1/5/20 变体示意 `:820`、anno「自适应」`:725/:731`）
- 瞬时浮层 anno/CSS 统一（①-12）→ **partial**（anno :392/:459 与骨架注释 :53 均称 `border-border/50`，实际 CSS :54/:59/:63/:86 用 `color-mix(--neutral-faint 50%)`——值与宣称不符，失配换了种形式残留，见 C-4）
- `.ub-v6.editing` 22% 魔数 → token → done（base.css:306 → `--accent-ring`）
- `.tm-badge` surface-2 保留（R23）→ done（base.css:238，999 胶囊 + surface-2）
- exit 标签面上面 → done（`.tool-exit` surface-2，base.css:264，与 tm-badge 同档）
- `:1004` 过时引用「subagent bg 状态行」→ done（零命中）
- popover 圆角 12 / z-modal → done（base.css:423 radius-lg + 注释 R18/R19；全文无 z-[1100]）
- R26 点名 → **partial**（`.ph-btn` 26×22 `:223`、`.ph-status` 13px `:212` 已标注；**`.send-slot svg` 仍 15px 未升 16px** base.css:412，且 :225 注释谎称「send-slot 同档 16px」，见 C-2）

### L3.8 — v6-spec-blocks.html
- ChangeSetCard badge（rounded-sm 5 态 info 蓝）入 base.css → done（base.css:283-300，`.cs-fbadge.M` info `:299` 对齐 R2）
- md-codeblock head / md 表格以 base.css 为准 → done（本地已删旧版）
- 复制按钮双轨并一 → done（`.tool-copy` 删，注释 blocks:36 声明）
- §12 goal/todo（D3）→ done（`:1068-1072` 登记 HIDDEN_TOOL_NAMES 移除；`.gt-goal-card` 去 border bg-surface `:110`）
- `.bob-out` 引用 token → done（base.css:322 `--bash-output-max-height`）
- uppercase → normal-case（tk-label/sa-prefix/wf-prefix/gui-card-hd/todo）→ done（产品 UI 零 `text-transform:uppercase`）
- `.tool-bash-box` bg-input 无 border → done（base.css:268 注释对齐）
- `.gui-card-box` 去彩色 border → done（blocks:101-105）
- `.bn-card` border 保留（R8）→ done（blocks:57-60；design §4.1 已登记例外 v6-design.md:182 ✓）
- loader stroke 1.7→1.75 → done（全文 1.7" 零命中，多处 1.75）
- `.bn-fullcontent` 120→200px → done（blocks:73 + anno :829 一致）
- thinking expanded body neutral-mid（R9）→ done（`:236/:239/:278/:291`，dim 措辞已清）
- ANSI ✓/⚠ 终端输出保留 → done（blocks:1054 豁免合理）
- **R11 block icon 14px 未落地** → **not-done**（design §4.1 已改「14px 统一」v6-design.md:172，但 base.css:245/258/312 + blocks:154/166 全为 13px，anno :288/:439/:714/:895 亦写 13px，见 C-1）

### L3.9 — v6-spec-content.html
- 删旧 ChangeSetCard badge/QueueBubble/md/pulse，以 base.css 为真值 → done（本地无残留）
- `.mm-dialog` 70%→92vh → done（content:45 注释统一）
- `:999` 动画表 QueueBubble/UserBubble pulse 引用 → done（零命中）
- loader 1.75 → done
- `.cap-bar` 渐变→纯色 → done（base.css:468 accent 纯色）
- `:982` 断裂注释 → done（现 content:224-227 为完整多行注释，全文件 comment 开合平衡）

### L3.10 — v6-spec-input.html
- QueueBubble 内嵌 → done（`.qb-inline` input:61，desc :221 对齐「无底无边无脉冲」）
- qb 分隔线 anno/CSS 统一 → **partial**（CSS :61 用 `border-strong 50%`，注释自称「统一 border-border/50」，desc :221 也写 `border-border/50`——三者值不符，见 C-5）
- CommandPopover 单行 → done（base.css:440-452 middot 单行）
- RetryIndicator 删 + 「7 区→6 区」→ done（input:66 移除注释；:311/:322/:733 均 6 区）
- composer focus 3px 外环（R1）→ done（base.css:380 `0 0 0 3px var(--accent-ring)`）
- `.pop-v6` shadow-2/12px/z-modal → done（base.css:423 + desc input:489）
- `.pop-head` token + normal-case → done（base.css:424）
- `.has-input` → surface-hover token → done（base.css:379）
- model-group / cap-stat .lbl normal-case → done（base.css:464/:473）
- `.cap-bar` 渐变→纯色 → **partial**（类已纯色 base.css:468，但 input:513 quota 明细行内联 `linear-gradient(accent,accent-hover)` 残留，见 C-6）
- `.qb-more` padding 魔数 → done（input:64 25px 带推导注释）
- `:665` ⚡⏰ / `:593` ✗ → done（零命中）
- ⚠ emoji 残留：input:211 anno、blocks:236 spec-desc（文档 chrome，见 C-7）

## B. 大方向一致性（对比最初设计意图）

符合项：五原则整体保持——①层级代替边框（tool-bash-box/gui-card/gt-goal 去 border，BgNotifyCard border 为例外且 design §4.1:182 已登记）；②圆角升档（radius-sm=6px、radius-sm-old 删除、pill 999、popover 12px）；③正文提亮（dim #7d8494、thinking preview/expanded 均 neutral-mid 过 AA）；④彩色降噪（PanelHeader icon 灰阶化、exit N 中性标签、failed 不切 icon、git M=info 蓝小 badge）。R1 3px 外环、R9 mid、R23 surface-2 胶囊、D3 §12 登记、D11 TurnRail 变体示意均与 v6-design 最终裁决一致。

不一致项（均详述于 C）：R10「整 turn 居中、气泡列内右浮」在 container spec 中被反向写成「不进 720 列」；R11 的 14px 只改了 design 没改 spec；ChangeSetCard/goal/gui 卡片的「面上面」在 demo 已修（bg-elevated）而 spec base.css 未修；ChangeSetCard 状态 badge 三方（design 降灰阶+胶囊 / base.css 5 态彩色 rounded-sm / demo 单胶囊 accent-soft）分叉。

## C. 细节不一致/新引入问题

- **C-1 [P1] block icon 13px vs SSOT 14px**：base.css:245 `.tk-ico`、:258 `.tool-ico`、:312 `.bob-ico`、v6-spec-blocks.html:154 `.sa-ico`、:166 `.wf-ico` 全部 `width: 13px`；anno blocks:288「Brain 13px」、:439「SquareTerminal icon 13px」、:714/:895 同。而 v6-design.md:172 写明「size：block header 14px 统一」（R11 裁决 13→14 只回写了 design，spec 未跟）。
- **C-2 [P1] send-slot svg 15px + 注释自相矛盾**：base.css:412 `.send-slot svg { width: 15px }`，同文件 :225 注释却写「操作图标档 16px（对齐 §5.3 scale，send-slot 同档）」。L3.7 任务「send-slot svg 15→16px」未执行，注释还制造了假一致。
- **C-3 [P1] UserBubble「不进 720 列」违反 R10/design #11**：container:191 注释、:194 演示文案「不进入 assistant 居中列」、:205 anno「不进 720 列」，且 base.css:304 `.ub-wrap` 无列宽约束（气泡贴 panel 右缘而非列右缘）。v6-design.md:49 决策 #11 是「整 turn 居中 720px，UserBubble 在列内右浮」，v6-demo.html:307/.msg-col + :838 实现也是气泡在 720 列内。spec 与 SSOT+demo 双向冲突。
- **C-4 [P1] 瞬时浮层值与宣称不符**：container:53 骨架注释、:392/:459 anno 均声明 `border border-border/50`，实际 CSS :54/:59/:63/:86 为 `color-mix(in oklch, var(--neutral-faint) 50%, transparent)`（neutral-faint 50% 远强于 border 0.08 的 50%）。①-12 失配以「注释统一、值另改」的形式残留。
- **C-5 [P2] qb-inline 分隔线三处值不符**：input:61 CSS=`border-strong 50%`（≈0.075）、同行注释称「统一 border-border/50」、desc :221 写 `border-b border-border/50`（=0.04）。
- **C-6 [P2] cap-bar 内联渐变残留**：base.css:468 类已改纯色，input:513 ContextCapacity 明细行仍 `background:linear-gradient(to right,var(--accent),var(--accent-hover))`。
- **C-7 [P2] 文档 chrome 漏扫**：base.css:177-181 `.state-tag` 仍 `text-transform:uppercase; letter-spacing:.05em`——L4 验收「全 spec grep uppercase 零命中」在 base.css 失守（四文件 chrome 收进 base.css 后漏改）；另有 ⚠ 文本符号残留 blocks:236、input:211（blocks:1054 终端输出属豁免）。
- **C-8 [P1] 对话流卡片「面上面」未解**：base.css:172 `.panel-stage`=surface 模拟主面板，而 :278 `.cs-v6`=bg-surface、blocks:110 `.gt-goal-card`=bg-surface、blocks:101 `.gui-card-box`=bg-surface——卡片在 surface 主面板上边界不可见；:283 `.cs-count`、:290 `.cs-status.superseded` 更是 bg-surface 压在 bg-surface 卡片上。fix-plan L5.4 验收项「主面板 surface 上的 pill/exit/ChangeSetCard 升一档」只做了 pill/exit；v6-demo.html:376-377 已改 bg-elevated，spec 与 demo 分叉（注：v6-design.md:175 自身也写 ChangeSetCard=bg-surface，是 SSOT 盲区，非 spec 单方面错）。
- **C-9 [P1] ChangeSetCard 状态 badge 三方分叉**：base.css:284-290 为 5 态彩色（accent/info/warn/success soft）+ rounded-sm，注释理由「与代码 ChangeSetCard.vue:22 一致」；v6-design.md:175 要求「状态 badge 降灰阶…『待审查』badge 胶囊 accent-soft」；v6-demo.html:384 为单胶囊 accent-soft。fix-plan L3.8 选代码现状版做权威但未回写 design §4.1，属未登记不一致。
- **C-10 [P2] ph-status 13px 注释误引 §5.3**：base.css:212 注释「13px 对齐 §5.3 scale」，但 §5.3 header 档是 14px，注释引用错误（任务允许「标注或对齐」，但标注内容本身失真）。

## D. 分页面改进意见

**v6-spec-base.css**
- 把 C-1/C-2/C-10 三个尺寸（tk/tool/bob/sa/wf-ico→14、send-slot svg→16、ph-status 注释改 14 或如实标注例外）一次修齐，让「注释即真值」成立。
- `.cs-count`/`.cs-status.superseded` 升 surface-2 或直接读 `.cs-v6` 升 bg-elevated，消除同面叠同面（C-8）。
- `--neutral-dim-old`（:33）仅存是为了对照 swatch，建议加一行注释说明「仅文档对比用，产品 CSS 禁止消费」，防误用。

**v6-spec-container.html**
- §1 的 UserBubble 演示改成气泡在 720 列内右浮（`.ub-wrap` 套进 `.ms-assistant-col` 语义或给 `.ub-wrap` 同列约束），同步改 :191/:194/:205 三处文案（C-3）。
- 瞬时浮层 CSS 值与 anno 二选一对齐：要么真用 `color-mix(--border 50%)`，要么 anno 改述 neutral-faint/50（C-4）。
- §1.5 收尾「[欠考虑] 瞬时浮层堆叠顺序」:211 已标 z-index=10 演示值，可顺手补一句「z 归 --z-popover 档」收口。

**v6-spec-blocks.html**
- 状态 badge 裁决需回写：选定「5 态彩色 rounded-sm（贴代码）」还是「design 降灰阶+胶囊」后同步 base.css 与 v6-design.md:175、v6-demo:384 三处（C-9）。
- `.gt-goal-card.warning` 的 warn 6% 整底染色（blocks:111）与 §3.3「GoalCard 降中性」方向有张力，建议降为小圆点/文字表达 blocked。
- §5/§6 的 13px icon anno（:288/:439/:555/:714/:895）随 C-1 统一改 14px。

**v6-spec-content.html**
- 本页修复质量最高，无阻断项。建议 §12 head 范式注释（:224-227）里「border-b border-border/50」与 base.css:350 实际的 `neutral-faint 50%` 对齐一次，避免 container 同类失配（C-4）在 content 复现。
- ts-ghost 三按钮方案 A 已落地，可在 anno 补一句 hover 显隐的触发容器（`.ts-summary:hover`），方便实施时对位。

**v6-spec-input.html**
- 清掉 :513 内联渐变（C-6），quota 明细行复用 `.cap-bar` 类。
- :61 qb 分隔线按 C-5 对齐（建议真用 `color-mix(--border 50%)`，与 desc 一致且更弱更融入 bg-input）。
- :211 anno 的 ⚠ 与 :163 state-tag「copy✓」文本符号建议改 SVG/纯文字，与 D7 口径齐平。

---

### 子报告 3 · Shell + 综合 demo 组

核验完成，所有证据已收集。以下为复审报告。

## A. 修复任务执行核验

### L3.11 — v6-spec-shell.html

- §7 drawer 一体化重做（`.wf-drawer-inline`/`.dd-drawer` 删 border-l、两个 header 删 border-b 改 bg-surface-2）→ **done**（shell:477-488、516-520、539-552 全文无 border-left/border-bottom）——但重做方向走样，见 C-1/C-4
- §1 `:680` drawer 表述与 §7 统一 → **done**（:674「与 main 共享同一 surface 浮起体…详见 §7」、:759 anno 一致）
- 删方案 E（折叠态 traffic-light 位移）→ **done**（全文无「方案 E」；§5 :1053/:1115/:1129 改为「traffic-light 恒定 left:16px（mac OS 无法位移）」）
- 方案 A/G 保留 → **done**（§3 :901-956 手绘 SVG 对比 + :952-954 anno）
- anno/CSS 失配三处 → **done**（nav-btn 圆角 anno :1039「rounded (=var(--radius-sm)=6px)」对齐 CSS :193；splitter transition anno :1225「200ms」对齐 CSS :442；§1 anno :758「rounded (=var(--radius)=8px)」对齐 CSS :153）
- splitter hover 改 accent → **done**（:445 `.ssd-handle.hover::before { background: var(--accent); }`）
- `.btn` SSOT 保留 + 补 `.btn svg` → **done**（:614-636，:623 `.btn svg { width:16px; height:16px; }`）
- 验收（§7 无 border-l/border-b、§1§7 一致、方案 E 删）→ **done**（grep 零残留）

### L3.19 — v6-demo.html

- 默认态改 `semantic`+`legacy` → **done**（:666 `<body data-select="a" data-color="semantic" data-density="legacy">`；控制台 on 态 :707/:717/:726 同步）
- CSS 语法错误 `padding: var(--space-3); var(--space-4);` → **done**（grep 零命中）
- 删 Overview 视图 + 侧栏入口 → **done**（:1017 注释标记移除；view-seg/seg-tabs 均无 overview）
- settings 改全屏覆盖 → **partial**（:576-580 注释声称 D1 全屏，但保留 `border: 1px solid var(--border)` + `border-radius`，见 C-6）
- traffic-light top 18→26px → **done**（:168）
- app-shell gap 8→12px、radius 12→10px → **done**（:154-155）
- main-panel 补 border+shadow → **done**（:271-272 `border` + `shadow-1, shadow-2`）
- seg-tabs 容器 8→12px → **done**（:205-206，p-3px 同步）
- terminal #000 → bg-input → **done**（:559）
- brand-logo/avatar 渐变→纯色 → **done**（:174/:263 `background: var(--accent)`）
- list-group-head/cmd-group-head 去 uppercase → **done**（:223-228/:618 无 text-transform）
- todo-verify 8→9px 去 bg → **done**（:556）
- settings-card 12→10px、settings-nav 200→220px → **done**（:594/:581）
- drawer-head border-b → bg-surface-2 浮起 → **done**（:415-417）
- panel-header 补 bg-elevated → **done**（:278）
- drawer-tab.on accent-soft → bg-elevated → **done**（:425）
- ask-opt:hover rgba → surface-hover token → **done**（:635）
- pill-ico 11→12px → **done**（:327）
- btn-primary/btn-ghost 对齐 .btn SSOT（注明）→ **done**（:179-181 注释声明 = .btn dense 别名）
- 面上面三处 bg-surface → bg-elevated → **done**（tm-pill :324 / exit-tag :374 / change-set :378）——但 tm-pill 与 design R23 的 surface-2 口径不一致，见 C-9
- 验收「首屏 == 目标态」→ **partial**（默认态已修正，但 drawer 旧模型、tasks tab、cmd/ask 选中态仍旧值，见 C-2/C-3/C-5）

### 范围内跨文件裁决抽查

- R12 SearchModal=modal(1000) → **done**（tokens:1026/:1035）——但 SideDrawer 仍挂 overlay 档，见 C-10
- R18 popover 并入 modal 档 → **done**（input:489/:742「z-modal(1000)」；container 全文无 z-[1100] 残留）
- R19 popover 圆角 12px → **done**（input:489「rounded-lg(12px)」；container rail-panel :116 `radius-lg`）
- R20 TogglePad p-3px → **done**（drawer:275/:291 `padding: 3px`；`.dt-btn.diff.on` :294 已统一 bg-elevated）

## B. 大方向一致性（对比最初设计意图）

**符合项**：三层明度（stage #131316 → 画布 --bg → surface 浮起）在 shell §1/§2 与 demo stage 均正确落地；shell 拓扑/traffic-light 安全区（52px、{x:16,y:26}、三平台、全屏两态）未动且方案 E 正确删除；折叠态 chrome 迁 PanelHeader（pl-88、!gap-0）完整；圆角升档（6/8/12/999）、neutral-dim #7d8494、diff 12%、内容列 720 居中、面上面升档在 demo 全部落实；demo 默认态已组合①目标态（a+semantic+legacy），重新具备验收 SSOT 资格。

**不一致项**：D2+R14「一体化 + 保留弱投影 .15-.18」在执行层分裂成三套说法——design §4.3/§3.4 保留弱投影 .16、shell §7 做成「无投影靠 surface-2 内分隔」、demo 干脆留在 D2 前旧模型（独立浮层 + 0.25 强投影）。这是本轮修复最大的方向性裂缝（详见 C-1/C-2/C-4）。D3 tasks 移除在 demo 未跟进（C-3）。

## C. 细节不一致/新引入问题

- **P0** 无（无阻断渲染/阅读的错误）。
- **P1** shell:1237 + :1326 — §7 新模型「无投影无 border 分隔…同色无需投影」直接推翻 v6-design.md:202「保留弱投影 `-12px 0 24px rgba(0,0,0,0.16)` 做视觉分隔」与 :130「靠弱投影 0.16 + 同色体分隔」。R14 的裁决是「弱化 .25→.15-.18 但保留」，shell 改成「全删」。修复制造了新一轮「§7 推翻 design」——上轮要消除的正是这类矛盾。token :47 已弱化到 0.16 却无新态消费（仅旧态对比 :570 使用），更坐实改了一半。
- **P1** v6-demo.html:88 + :412-413 — demo drawer 仍是 D2 前旧模型：`--shadow-drawer: ...rgba(0,0,0,0.25)`（未弱化）+ `.drawer { background: var(--bg-sunken); box-shadow: var(--shadow-drawer); }` 独立浮层，非同体生长。L3.13 只清了 drawer spec 的 8 处残留，demo 漏网。验收 SSOT 候选与 shell §7/drawer spec 三方矛盾。
- **P1** v6-demo.html:699/:899/:941-954 — tasks drawer tab 完整保留（控制台按钮 + drawer tab icon + goal-card/todo 内容），违 D3（tasks 移除回归对话流）。且 drawer 仅 4 tab，缺 drawer spec 的 browser/doc/subagent/workflow（7 tab 口径）。
- **P2** shell:479/:541/:588 — 三处 drawer 演示区整体 `background: var(--surface-2)`，与同文件 anno :1323「drawer 底色 var(--surface) 与 main 同色一体」、spec-desc :1237「底色同为 --surface」、design §4.3 矛盾。正确画法应 body=surface、仅 header=surface-2（design §3.4）。
- **P2** v6-demo.html:621 + :636 — `.cmd-item.active { background: var(--accent-soft); }`（违 R6/D8：SearchModal 列表项选中 = bg-surface+蓝字，overlays spec 已改）+ `.ask-opt.sel { background: var(--accent-soft); }`（违 R7：au-opt 列表项型 = §3.2）。
- **P2** v6-demo.html:577-580/:589 — settings-modal 保留 border+radius（D1 全屏覆盖 = fixed inset-0 无 border/radius，settings-shell L3.1 已删）；`.settings-content` 无 max-w-720 左对齐内容列（design §4.5）。
- **P2** v6-demo.html:504/:544/:469 — 默认 semantic 态下三处违彩色降噪裁决：wf done 进度条 `background: var(--success)`（design §4.2：done 改 neutral-dim）；GoalCard complete badge success-soft（design §3.3：降中性）；git M badge `color: var(--warn)`（R2：M = info 蓝）。
- **P2** v6-spec-shell.html:48-49 — 死 token `--shadow-glow`、`--composer-btn-size` 定义零消费未删；settings-shell（L3.1）已删同名死 token，跨文件不一致。
- **P2** v6-demo.html:324/:378 vs v6-design.md:166/:175 — demo tm-pill/change-set 用 bg-elevated（按 L3.19 指令），但 design §4.1 仍是「TurnMeta pill = surface-2（R23）」「ChangeSetCard = bg-surface」。fix-plan 内部（R23 vs L3.19）口径未收敛，design 未回写面上面升档，SSOT 缝隙。
- **P2** v6-spec-tokens.html:1025/:1034 — z 映射仍列「SideDrawer 抽屉 = overlay(20)」，L1.6 明确「D2 后 SideDrawer 与 main 同体，z 归 sticky 或不单列」。
- **P2** v6-demo.html:846/:860/:352/:970-977 — 对话流细节未追平 spec：block icon 仍是旧灯泡/扳手（design §4.1 已定 Brain/SquareTerminal/SquareFunction 新体系）；`.block-bash` radius 8px（基线 §5.2 = rounded-lg 12px）；tree-row 缩进 16px 步进（决策 #12 = 10px）。

## D. 分页面改进意见

**v6-spec-shell.html**：
1. §7 投影口径必须二选一收敛：建议按 R14 补回 drawer 左缘 0.16 弱投影（同色一体下肉眼几乎不可见但能防震动感），或正式改 design 裁决为「同色无投影」——不能再让 SSOT 与 shell 各说各话。
2. drawer 演示区（§1 :479/§7 :541/:588）底色改 body=surface + header=surface-2，与 anno 和 design §3.4 对齐；当前整区 surface-2 等于偷偷引入了「第三层半」。
3. `.dd-toggle.active`（:530）常驻 accent-soft 建议改 bg-elevated——它是持续态指示不是瞬时高亮，按 §3.7 不应占用 accent-soft。
4. 删 `--shadow-glow`/`--composer-btn-size`（:48-49），与 settings-shell 保持同一份 token 面。
5. §7 交互演示可叠加 drawer↔main 间的透明 Splitter hover 态（§6 只演示了侧栏场景），一体化模型下「可拖拽调宽」是 design 已登记的交互，spec 目前无视觉落点。

**v6-demo.html**：
1. drawer 容器按 D2 重做：并入 main-panel 同体（bg-surface、去独立 shadow、从右缘生长），或至少弱化 shadow 到 0.16 + 改 bg-surface 过渡——现状让它不配做验收 SSOT。
2. 删 tasks tab，至少以占位形式补齐 browser/doc/subagent/workflow，使 drawer tab 集与 drawer spec 7 tab 口径一致。
3. `.cmd-item.active`/`.ask-opt.sel` 改 §3.2（bg-surface + 蓝字），与 overlays spec 同步。
4. settings 视图去 border/radius、内容区加 max-w-720 左对齐列，追平 settings-shell 的 D1 全屏范式。
5. 对话流 block icon 换 v6 新图标组（Brain/SquareTerminal）、bash 容器升 rounded-lg、文件树缩进补齐 10px 步进——demo 作为「综合验收面」，与单页 spec 的组件级口径差越多，验收时越容易产生假分歧。

---

### 子报告 4 · 侧栏 + Drawer 组

## A. 修复任务执行核验

### L3.12 — v6-spec-sidebar.html
- SegmentedTab `.seg` 12px + p-3px 保留 → done（`:212` `border-radius: var(--radius-lg); padding: 3px`）
- SessionItem/FileTree 选中态保留 → done（`:230` `.si.act { background: var(--surface) }` 注释「无 ring 无左条」、`:242` 蓝字、`:1160` 文件树同范式）
- R21 `.sa-dot`/`.wf-dot` 8→7px → done（`:356`/`:376` 均 `width: 7px`）
- R22 `.tr-git`/`.fg-pill`/`.tr-dirbadge` 升 6px + 删 `--radius-sm-old` → done（`:337`/`:295`/`:344` 均 `var(--radius-sm)`，`:80` `--radius-sm: 6px`，`--radius-sm-old` 全文零残留）
- Overview 入口处理 → partial（渲染已标「已移除 §4.4 DEPRECATED」+ 删除线 `:533`，anno `:594` 同步；但 `.sb-overview` CSS 定义 `:205-209` 五行死代码残留未删）
- `.sb-navitem kbd` border → done（按 fix-plan「可保留」选项保留 `:203` border-strong；未加登记 anno）
- `.fg-item.fresh` 瞬时高亮保留 → done（`:283` accent-soft + inset ring）
- `.wfd-cdot`/`.si-dot` 7px ✓ → done（`:414`/`:233`）
- `.sb-logo color:#fff` 注释说明 → done（`:191` 注释保留）
- anno「subagent 状态点」8→7px → done（`:1367`「7px · done=success…」）

### L3.13 — v6-spec-drawer.html
- D2+R14 shadow 残留全清 → done（token 弱化 `:91` `rgba(0,0,0,0.16)`；`.sd-drawer` 改 `background: var(--surface)` `:197`；doc-sub `:678`、spec-desc `:709`、compare-tag `:711-712`、分隔对比块重做 `:771-800`、anno `:803-805`；`.dd-drawer` 类已消除；验收 grep `0.25`/`bg-bg drawer`/`border-l drawer` 零残留，剩余 border-l 仅在旧态对比 demo `:234`/`:780`）
- D3 tasks tab 移除 → done（doc-sub/spec-desc/注释/anno 全部「7 个」`:678`/`:709`/`:726`/`:806`；§1 mock 7 icon 无 tasks `:727-748`；矩阵 7 行 + tasks 划线「v6 已移除」`:846-899`；§9 移除声明 `:1951-1966`）
- browser 二级 tab anno 对齐 → done（anno `:1497`「多页面 tab（已授权 plugin/view 体系，D4）」，矩阵 `:863`、spec-desc `:1302` 三处一致）
- GitPanel badge 降中性 → done（CSS `:429-430` `color: var(--neutral-dim)` 仅 `.U` danger；§7 渲染 `:1550-1553`；badge 范式 demo `:1662-1691`）
- DetailPane toggle R20 → partial（CSS p-3px `:275`/`:291`、`.dt-btn.diff.on` bg-elevated `:294` 均已改；但 anno `:1072` 仍写「p-[2px]」未同步）
- SubagentTab user 气泡 76%/surface-hover → done（`:570`）
- `.cd-meta` mt 统一 → done（`:504` `margin-top: 16px`，对齐 spec-desc `:1798`「mt-4 (16px)」）
- DiffView anno/CSS 统一 → done（行号 40px/neutral-dim 双侧一致 `:306`/`:1177`；字体 12px/1.5 双侧一致 `:303`(`--text-sm: 12px` `:75`)/`:1180`）
- disabled opacity 0.5 → done（CSS `:336`/`:376`/`:472`/`:476`/`:645`；anno `:1290`/`:1493`）
- 二级 tab 字号 11px → done（`:256` `var(--text-xs)`=11px；anno `:1074`）
- §3 变体区 inline bg-input → done（§3 区间 `:969-1082` 无 inline bg-input；残留 hits `:1574+` 是 GitPanel chip 演示，合法）
- `.cd-source` 去 border → done（`:490` 无 border + 注释「去 border」）
- Splitter 真透明 → done（`:175-178` `::before` 默认 `width: 0; background: transparent`）
- `.wf-call.selected` R15 → partial（CSS `:615` bg-surface + `:623` 蓝字已改；但 §11 anno `:2523` 仍「bg-accent-soft · agent 名 text-accent」、mock 注释 `:2420` 仍「高亮 accent-soft」未同步）
- `.l1-icon.on` bg-elevated → done（`:209`）
- 1:1 宽度比 anno → done（`:166`/`:709`/`:721`/`:816`）
- sd-unread 角标保留 → done（`:221`/`:749-751`）
- hover 底色统一 surface-hover → done（`.gp-file:hover` `:428`、`.wf-call:hover` `:614`）
- GitPanel MVP anno「已授权」→ done（`:1546`、`:1785-1788` 四条均标「已授权（决策 #16）」）
- 形态 B anno 标「阶段 B」→ done（`:961`/`:1068`/`:1287`）
- state-tag 宽度统一 84px → **not-done**（drawer `:185` 仍 `width: 76px`，sidebar `:165` 已 84px）
- `.b-l2` border-bottom 删 → done（`:253` 仅 bg-surface-2）；`.sa-readonly-hint` border-top 删 → done（`:578`）
- `.gc-resume` `color: var(--bg)` → done（`:526`）
- emoji ⚠ → SVG → done（`:1962` TriangleAlert SVG）；border-left 说明框 → bg-soft 整块 → done（`:1961` warn-soft 块 + icon）
- uppercase 清理 → partial（`text-transform` 全文零残留；但演示文案硬编码全大写「BLOCKED/ACTIVE/VERIFY」`:1995`/`:2044`/`:2152`，渲染结果仍全大写，与 anno `:2167`「normal-case，产品 UI」名实不符）
- R26 补点名：`.wf-status` 7px done（`:617`）；`.b-l2-tab.on` bg-elevated done（`:260`）；`.cd-inline-code` 6px done（`:500`）；`.tt-close` 3px 例外保留 done（`:264`）；`.gp-po-item.is-current` accent-soft 保留 done（`:456`）

### L3.14 — v6-drawer-tabs-demo.html
- SUPERSEDED 横幅 → done（`:120-123`，且明示「『你倾向哪种』仅作历史参照」化解 `:129` 误导）
- 二级 tab 字号 11px → done（`:82`）；`.seg`/`.crumb-view` p-3px → done（`:34`/`:99`）；`.b-l2` surface-2 去 border-bottom → done（`:81`）；`.tt-close` 3px 保留 → done（`:73`/`:86`）；`.note` 去 border-left → done（`:29` surface-2 整块）

## B. 大方向一致性（对比最初设计意图）

五原则全部落地：层级代替边框（drawer border-l/border-b/border-top 全清、Splitter 真透明、各 panel header 改 bg-surface-2 浮起）；圆角升档（`--radius-sm: 6px` 双文件统一、tt-close 3px 例外按裁决保留）；选中态二分（tab 型 bg-elevated / 列表项型 bg-surface+蓝字 / accent-soft 仅剩瞬时高亮：`:283` fresh、`:456` is-current、`:608` running ring）；彩色降噪（7px 圆点、GitPanel badge 中性化、进度条 done 降 dim）。已登记的有意偏离均正确执行：侧栏与画布同色（`:26` `--bg-sunken: var(--bg)`，未做 mixer 的 #191a1e）、D2 一体化弱投影 0.16、D3 tasks 移除四种说法已统一。design §4.3 回写核验通过：sd-unread + 1:1 已登记（`v6-design.md:229`）、决策 #16 GitPanel 授权在案（`v6-design.md:34`）。

**不一致项**：侧栏第 5 tab plugin 未落地——v6-design §4.2 标题「5 tab + 容器，第 5 tab 为 plugin」（`v6-design.md:184`）+ 结构决策 #15（`:53`），但 sidebar spec 全文 grep「plugin/插件」零命中，spec-desc `:604` 仍写「icon-only **4** tab 等宽均分（sessions/files/subagents/workflows）」。属未登记缺口（fix-plan L3.12 未列入，可能寄望 L3.16 plugin spec，但 sidebar 自身 SSOT 未同步）。

## C. 细节不一致/新引入问题

- **P1** `v6-spec-drawer.html:2523` + `:2420` — R15 修了一半：anno 仍写「选中态： bg-accent-soft · agent 名 text-accent」、mock 注释「高亮 accent-soft」，与 CSS `:615` `.wf-call.selected { background: var(--surface) }` 直接矛盾（accent-soft 按 R24 只留瞬时高亮）。
- **P1** `v6-spec-drawer.html:1072` — R20 修了一半：anno 写「SegmentedTab：bg-bg-input **p-[2px]**」，与 CSS `:291`/`:275` `padding: 3px` 矛盾。
- **P1** `v6-spec-sidebar.html:1039` — R22 修了一半：anno 写「pill 圆角： **3px**」，与 `.fg-pill` CSS `:295` `border-radius: var(--radius-sm)`(=6px) 矛盾。
- **P1** 跨文件 `v6-spec-drawer.html:1497`/`:863` vs `v6-design.md:219` — drawer spec 三处统一为「browser 多页面 tab（已授权 D4）」，但 design §4.3 二级 tab 策略表仍是「browser | 单实例（暂）| 否 | 否」。fix-plan 改了 spec 未回写 design。
- **P2** `v6-spec-drawer.html:185` — E.9 未执行：state-tag 仍 76px，sidebar `:165` 已 84px，两 spec 文档 chrome 不统一。
- **P2** `v6-spec-drawer.html:1995`/`:2044`/`:2152` — uppercase 只清了 CSS `text-transform`，演示文案仍硬编码全大写（BLOCKED/ACTIVE/PAUSED/COMPLETE/VERIFY），渲染视觉与「normal-case」裁决不符；且 `.ts-verify` `:546` 仍 9px，与 badge 10px scale（sidebar fg-pill 已 9→10 入 scale）不一致。
- **P2** `v6-spec-sidebar.html:285`/`:224` — `.fg-dot` 5px、`.seg-badge` 6px running 圆点，与 §3.3「统一 7px，无 8/9/6px 例外」字面冲突（E.8 只豁免了未读指示 `.si-unread` 6px/`.fg-dot.unread-ring` 5px，未豁免分支状态点与 tab running badge）。fix-plan 未列入，属裁决空白。
- **P2** `v6-spec-drawer.html:1667-1687` — badge 范式 demo 的 standalone span 不在 `.gp-file` 作用域内，`:429-430` 的 neutral-dim/U-danger 规则不命中，demo 实际渲染为继承色 neutral-fg（U 也不红），与自身 anno「M: neutral-dim / U: danger」不符。
- **P2** `v6-spec-drawer.html:291`/`:275` — `.dp-toggle`/`.l2-view` 外层 `border-radius: var(--radius)`(8px)，与 R13「SegmentedTab 圆角统一 12px」及 sidebar `.seg` 的 `radius-lg` 不一致（R13 只点了 plugin spec，drawer 这两处 SegmentedTab 族组件成漏网）。
- **P2** `v6-spec-drawer.html:14` — 头注释仍写「§1-§9 全写实（…TasksPanel）」，§9 实为移除声明 + 迁移前参照，非全写实；`:1948` 节注释同。
- **P2** `v6-spec-drawer.html:1862-1864` — 「现」态对比 span 用 `var(--radius-sm)`（现已 6px）却标注「圆角 3px」，旧态演示数值失真（token 升档的连带效应，旧态 demo 应用裸值 3px）。
- **P2** `v6-spec-sidebar.html:205-209` — `.sb-overview` CSS 死代码残留（渲染已标移除）。
- **P2** `v6-drawer-tabs-demo.html:23`/`:53` — demo 自身 `--shadow-drawer` 仍 0.25、`.drawer` 仍 `background: var(--bg)`（旧 D2 模型）；`:125`/`:129` 正文仍「6 个一级 tab」含 tasks；`:98` crumb-file 11.5px。横幅已声明「数值以 spec 为准」可兜底，但既然做了数值同步（11px/p-3px），这几处漏改显得不一致。

## D. 分页面改进意见

**v6-spec-sidebar.html**
1. 补 plugin 第 5 tab：要么在 §2 SegmentedTab 加第 5 icon（Puzzle）+ spec-desc 改「5 tab」，要么在文档头部显式声明「plugin tab 渲染见 v6-spec-plugin-rendering.html，本稿从略」——当前 4 tab 与 design §4.2 标题直接打架。
2. 删除 `.sb-overview` 死 CSS（`:205-209`），「标已移除」与「代码清除」二选一做干净。
3. 统一状态点口径：把 `.fg-dot` 5px → 7px、`.seg-badge` 6px → 明确登记为「badge 非状态点」豁免，或在 design §3.3 补一行例外清单，消除字面冲突。
4. kbd 保留 border-strong 建议在 §1 anno-grid 补一条登记（fix-plan 允许保留但要求「或登记」），并注明与 baseline §5.1「去 border」的偏离理由。
5. `.fg-item.fresh` 的 inset ring + accent-soft 与 impeccable「禁彩色侧边条/ring 克制」张力较大，可考虑降为王炸后 3.2s 淡出的纯 bg-accent-soft（去 ring），目前 anno `:1042` 已有淡出说明，-ring 更彻底。

**v6-spec-drawer.html**
1. 集中清扫 anno 残留：`:2523`/`:2420`（accent-soft）、`:1072`（p-[2px]）三处是「CSS 已改 anno 未跟」的同型 bug，建议全文件 grep 一遍 anno 中的数值类声明（px/opacity/色名）与 CSS 对账。
2. §9 GoalCard 演示文案改正常大小写（Blocked/Active/Verify），`.ts-verify` 升 10px 入 scale；§9 已是「迁移前参照」，更应克制彩色，或干脆只留迁移声明 + 链接 blocks §12，删掉整段旧渲染。
3. badge 范式 demo（`:1667+`）给 standalone span 补 `color: var(--neutral-dim)`（U 补 danger），让演示所见即所得。
4. `.dp-toggle`/`.l2-view` 外层圆角升 `radius-lg`（12px）对齐 R13，或在 R13 裁决里补「drawer 内嵌 toggle 用 8px」的例外登记。
5. state-tag 76px → 84px 与 sidebar 对齐（一行改动，E.9 原判）。

**v6-drawer-tabs-demo.html**
1. `--shadow-drawer` 同步 0.16、`.drawer` 底色改 `var(--surface)`——横幅声明「数值以 spec 为准」不如直接改对，避免读者截图误用。
2. 正文「6 个一级 tab」「terminal/git/doc/tasks」等过时表述加删除线或改写为 7 tab 口径，与横幅的 SUPERSEDED 语义一致。
3. `.seg`/`.crumb-view` 外层圆角 8px → 12px（既然 p 值都同步了，圆角一并同步 R13）。
4. `.crumb-file` 11.5px 入 scale（11 或 12），消除最后一个半像素值。

---

### 子报告 5 · Overlays + Plugin + Tokens 组

核验完成，输出复审报告。

## A. 修复任务执行核验

### L3.15 — v6-spec-overlays.html
- SearchModal sel 对齐 §3.2（R6）→ **done**。`v6-spec-overlays.html:241-244` hover=`surface-hover`、sel=`background:var(--surface)`+`.sm-i-title{color:var(--accent)}`，sel/hover 已异色，键盘导航可见。
- au-tab 改中性浮起（R7）→ **done**。`:283` `.au-tab.active { background: var(--bg-elevated); color: var(--neutral-fg) }`；`:301-302` `.au-opt.sel` = bg-surface+蓝字（列表项型 §3.2）。tab 型/列表项型二分正确落地。
- ConfirmDialog loading 按钮 → **done**。`:951-953`、`:985` inline 改 `opacity:0.5;pointer-events:none` + `.btn-spin` spinner（SSOT disabled 态）。
- `.sm-i-title` 13.5→14px → **done**。`:248` `font-size: 14px`。
- `.sd-drawer` 演示格 border → **done**（保留，fix 允许「可保留」）。`:404`，且 shadow 值已同步弱投影 `.16`（`:1163`），与 D2/R14 一致。
- Toast z-9999 → **done（spec 侧）**。`:516` anno 显式登记「Toast 例外，z-9999 固定值保留」。注：fix 原文是「design §5.2 补登记或并入」，design §5.2（v6-design.md:268）未提 toast——见 C-6。
- mermaid SVG hex → **done**。`:1034` 注释「占位 mermaid 流程图（纯示意）」，hex 仅存在示意 SVG 内（`:1037-1048`）。

### L3.16 — v6-spec-plugin-rendering.html
- §2 desc M8 陈旧 → **done**。`:777`「main-panel 内 composer 下方，不跨全宽」；`:741` anno「M8 位置变更」同步。
- dc-btn primary 未定义 → **done**。`:1391` 改 `dc-btn default`（`:399` 定义存在）。
- §9.4 闭环计数统一 5 → **done**。`:1969`「完整闭环（5 挂载点）」、`:1972`/`:1995`「M15 已降级，不计入」。
- R13 SegmentedTab 8→12px → **done**。`:218` `.seg-tab` radius-lg + 注释「外层圆角 12px（R13）」；`:351` `.gtabbar` radius-lg；anno `:1307`「rounded-lg(12px)（R13）」。
- plugin 第 5 tab active → **done（bg）/ partial（文字色）**。`:449` bg 改 bg-elevated，但 `color: var(--accent)` 保留（§3.1 要求 text-neutral-fg）——见 C-7。
- C1/C2 companion 容器 → **done**。`:1385-1386` 替换为 overlays 范式（bg-input/无边/12px）。但内部选中项未同步——见 C-1。
- drawer tab active → **done**。`:239-240` bg-surface→bg-elevated + neutral-fg。
- CommandPopover 选中 → **done**。`:404-406` accent-soft→bg-surface+蓝字/icon。
- gtab-dot 6→7px（R21）→ **done**。`:355` `width: 7px`。
- gprog-fill 55% → **partial**。`:324` 注释声称「design §2.3 登记」，但 v6-design.md §2.3（:79-84）无 55% 登记——见 C-4。
- list-tree 缩进 → **done**。`:1234` 显式登记「list-tree 独立组件，保留 16px 不对齐」。
- note-box 3px 彩条 → **done**。`:469-470` bg-soft 整块 + head icon。
- as-statusbar accent border → **done**。`:530-531` 去 border + 注释「D2 后底栏在 main 内」。
- cb-wrap border → **done**。`:545-546` 去 border + 注释。
- indet `!important` → **done**。`:332` 正常值 + 注释「去 !important」。
- R26 补点名（.cb/.count）→ **done**。`:535` `.cb` 注释「R26 标注：代码展示专用」；`:223` `.count` 注释「R26：9px 徽章专用小字…有意为之」。
- uppercase 文档 chrome → **not-done（2 处残留）**。`:377` `.ansi-table th`、`:561` `.cap-api-table th` 仍 `text-transform: uppercase; letter-spacing: .05em`——见 C-3。
- §9 架构路线标注（D4）→ **done**。`:1994`「阶段归属（D4）：…阶段 B 衔接（design L1.3 已登记）」；§9.5 对照表存在（`:1999-2027`）；design 决策 #15 已登记（v6-design.md:33）。

### L3.17 — v6-plugin-max-demo.html
- 文档头注明缩放 mockup → **done**。`:418`「不承载组件级 CSS 范式…以 v6-spec-*.html 为准」。
- sb-avatar 渐变→纯色 → **done**。`:146` `background: var(--accent)`。
- M15 dialog → **done**。`:806-815` 中性 dialog-card + TriangleAlert SVG，无 emoji。
- loop-card/降级框/必修缺陷框 3px 彩条 → **done**。`:389-394`、`:801-805`、`:1176-1178` 全部 bg-soft 整块 + icon。
- drawer-tab active 文字色 → **done**。`:209-210` bg-elevated + neutral-fg + 注释「与 plugin spec 统一」。
- M6 灰化标未来 → **done**。`:701` 注释、`:937`「△ 未来」、`:1034`「其余 14 个挂载点 external 全部可用」口径一致。
- 闭环计数 → **done**。`:1143-1146`「完整闭环（5 挂载点）」5 pill，M15 不含。
- M8 注释陈旧 → **done**。`:214-215`「main-panel 局部底栏（不跨全宽；M8 局部）」。
- M8 item 字体 → **done**。`:217` `font-size: 11px; font-family: var(--font-sans)`。
- .mtag 硬编码 → **done**。`:85-89` 全 token（`color: var(--bg)` 等）+ 注释「v6 去硬编码 hex」。
- ss-switch 36×20 → **done**。`:329-330`。
- gprog-track 5→6px → **done**。`:263`。
- composer-bar border → **done**。`:183` `border: 1px solid transparent`。
- msg-user → **done**。`:171-172` surface-hover/14-4px 不对称/76%。
- dc-btn primary → **done**。`:636`/`:815` `dc-btn default`。
- ob-count rgba → **partial**。`:306-307` rgba 保留但加「badge 专用豁免」注释（fix 原文是「→ token」，实际走了标注路线）——见 C-8。
- appshell border → **done**。`:101-102` 豁免注释。
- cb-wrap border → **done**。`:363` 无 border。
- uppercase → **done**。全文 `text-transform` 零命中。
- ANSI ⚠ → **done**。`:713` 终端输出保留。
- **C1/C2 companion max-demo 同改 → not-done**。`:175` `.companion` 仍 `surface-hover + border: 1px solid var(--accent-ring) + radius 8px`——见 C-2。

### L2.2 + L3.18 — v6-spec-tokens.html
- 骨架 1320/820/860 → **done**。`:125`（1320）/`:153`（820）/`:219`（860）。
- §8 规则 4 neutral-mid → **done**。`:1116`「标注用 mono 字体 + neutral-mid 色」。
- z-index R12 → **done**。`:101` `--z-modal: 1000`；`:1026`/`:1035`「modal（SearchModal / FullSettings / ConfirmDialog）」。
- 文件头「同一套 token」措辞 → **done**。`:14` 改「核心 token 与 v6-demo.html 一致；本文档含完整 token 集…」。
- 图标 scale header 14px（R11）→ **done**。`:1077`「header · 14px · 面板 header」。
- accent-ring 0.30 → **done**。`:45` `rgba(79,142,247,0.30)`；summary 已改（`v6-summary.md:99` 0.30 + 注释；`:135` R12 SearchModal=modal ✓）。
- 三层明度 token 与 design #10 → **done**。`:25` `--bg-sunken: var(--bg)`、`:26` `--bg-card: #22242c`、`:114/:434` stage `#131316`，与 v6-design.md:43 一致。

## B. 大方向一致性（对比最初设计意图）

五原则在我范围 4 个文件中落地良好：

- **层级代替边框**：overlays 输入区去 border-b（`:227`）、plugin 7 原语 gcard 去 border 靠 bg 层级（`:283-288`「去 border，靠 bg 层级」）、cb-wrap/as-statusbar 去 border——符合基线 §3 原则 1。
- **圆角升档**：浮层 12px（cd-dialog `:357` radius-lg、seg-tab radius-lg）、选项 6px（au-tab/au-opt radius-sm）——符合原则 2。
- **彩色降噪**：R6/R7 去 accent-soft 蓝染选中态、plugin tab-bar 旧态标注「违规」（`:358-361`）、gcard 去 border-danger 彩色整圈——符合原则 5 与 design §3.7。
- **z-index 语义化**：tokens/overlays 一致落到 4 档 + toast 例外，SearchModal=modal 1000 与 design §5.2 一致。
- **plugin D4 授权链**：design #15 ↔ spec §9.4/§9.5 ↔ max-demo 闭环计数三处口径一致（5 闭环 + M15 降级 + M6 未来），无互相否定。

不一致项（均非方向性冲突，属局部残留/新引入矛盾）：选中态范式在 plugin spec C2 与 max-demo companion/copt/cp-row 三处仍有 accent-soft 残留（见 C-1/C-2/C-9），与「accent-soft 仅留瞬时高亮」（design §3.7:150）相抵——基线选定的是「彩色退场」，常驻选中态用蓝染底正是 v6 要消灭的形态，建议补齐。

## C. 细节不一致/新引入问题

- **C-1（P1）** `v6-spec-plugin-rendering.html:1418`、`:1479` — C2 ask-user 选中项仍 `background:var(--accent-soft);color:var(--accent)`。spec 同节 anno（`:1399`）声称「对齐 overlays 稿 AskUserOverlay」，但 overlays 的 au-opt.sel 已是 bg-surface+蓝字（overlays:301-302），违反 design §3.7 列表项型规则。证据：`<div style="…background:var(--accent-soft);color:var(--accent);…">production（选中）</div>`。
- **C-2（P1）** `v6-plugin-max-demo.html:175` — fix-plan L3.17 未列出但 L3.16 明确「max-demo :172 同改」的 `.companion` 未改：`background: var(--surface-hover); border-radius: var(--radius); border: 1px solid var(--accent-ring)`（8px + accent-ring 边 + surface-hover），与 overlays au-overlay 范式（bg-input/无边/12px）不符。accent-ring 边条也是彩色描边，违原则 1/5。
- **C-3（P2）** `v6-spec-plugin-rendering.html:377`、`:561` — 两个表头 th 仍 `text-transform: uppercase; letter-spacing: .05em`。L4.2 明确点名 plugin 表头需 normal-case（D7），overlays z-table th（overlays:206）已改、此文件漏改。同文件 :1090/1097 等 chrome 标签已改 `text-transform:none`，属改了一半。
- **C-4（P2）** `v6-spec-plugin-rendering.html:324` — 注释「fill 柔化 55%…design §2.3 登记」为虚假声明：v6-design.md §2.3（:79-84）只有 diff 12%，无 progress 55% 登记。要么补登记 design，要么改注释措辞。
- **C-5（P2）** `v6-spec-overlays.html:453`/`:482`/`:508` — §1 z-index 仍把 SideDrawer 列在 `--z-overlay:20`（「AskUserOverlay · SideDrawer」），与 v6-design.md:268 终版「SideDrawer 与 main 同体不单列 z」（D2 后修订）冲突。fix-plan L1.6 已注明此点，overlays 未跟进。
- **C-6（P2，跨文件提示）** Toast z-9999 例外：overlays:516 anno 有登记，但 fix-plan 原文目标是「design §5.2 补登记」，v6-design.md:268 未提 toast。SSOT 缺登记，spec 单点声明。
- **C-7（P2）** `v6-spec-plugin-rendering.html:449` — `.plugin-primary.active` bg 已改 bg-elevated，但文字色仍 `color: var(--accent)`（§3.1 是 text-neutral-fg）。若为 plugin 身份色的有意偏离，建议在 design §3.7 登记例外，否则与「tab 型统一中性浮起」表述矛盾。
- **C-8（P2）** `v6-plugin-max-demo.html:306-307` — `.ob-count` rgba 未改 token，以「badge 专用豁免」注释收场。fix-plan 原文为「→ token」，实际走了豁免路线，可接受但计划文本与实际结果不符。
- **C-9（P2）** `v6-plugin-max-demo.html:181`、`:201` — `.copt.sel`（ask-user 选项）与 `.cp-row.sel`（CommandPopover 项）仍 accent-soft+蓝字。fix-plan 未显式点名 max-demo 这两类，但 plugin spec 同组件已修（spec:301/404），demo 免责声明（:418）只豁免缩放尺寸不豁免范式，形成同组件两稿范式分叉。
- **C-10（P2，提示）** `v6-plugin-max-demo.html:223` `.sb-item .sb-dot` 6px（R21 全 spec 7px）。demo 免责声明可覆盖，仅提示 L5.2 验收扫描时会命中。

## D. 分页面改进意见

**v6-spec-overlays.html**
1. 按 C-5 把 §1 z-index 三处（:453/:482/:508）的 SideDrawer 从 overlay 档摘除，改注「与 main 同体，z 归文档流」，与 design §5.2 对齐。
2. `:1156`「modal 组合」演示格写「border + 投影双表达浮起」，与原则 1「每类容器只允许一种主分隔手段」张力较大；建议注明「border 仅浮起可交互容器豁免（原则 1 条文）」，避免读者误抄到静态容器。
3. au-tab-dot（`:284` 4px 绿点）与全局 7px 状态点不同档——它表示「该 tab 有待答问题」，语义合理但建议在 anno 注明「4px 是 tab 内联标记非状态点」，防 L5.2 扫描误报。
4. Toast 例外建议回写 design §5.2（C-6），让 SSOT 与 spec 单点声明闭环。

**v6-spec-plugin-rendering.html**
1. 清掉 C-1/C-3 三处残留：C2 选中项改 bg-surface+蓝字；两个 th 去 uppercase（含 letter-spacing，参考 overlays:206 的 th 样式）。
2. C-4 二选一：design §2.3 补一行 progress fill 55% 登记，或把 :324 注释改为「本稿独立柔化档，待 design 登记」。
3. plugin-primary 文字色（C-7）建议保留 accent（plugin 身份色有辨识度价值），但在 design §3.7 补「plugin 第 5 tab 身份色例外」一句，消除规则与实现的灰区。
4. §9.4 `:1981` 注解说「M10 已闭环」与「5 个完整闭环」计数表面矛盾（5 不含 M10），建议把注解改写为「M10 走 session.commands 双轨已通，但不计入本文 5 个 pi-extension 闭环」以免读者困惑。

**v6-plugin-max-demo.html**
1. 按 C-2/C-9 把 `.companion`/`.copt.sel`/`.cp-row.sel` 同步到 plugin spec 已修范式（bg-input 无边 12px / bg-surface+蓝字），免责声明不覆盖范式分叉。
2. `.schema-tag`（`:340` 附近 `border-radius: 3px`）与 `.section-desc code`（4px）是 R22 已消灭的 3/4px 档位；虽属缩放 demo，建议顺手升 6px 或在免责声明里点名「圆角档位亦缩放」，避免验收扫描命中。
3. M15 dialog 的 `dc-title` 整行 danger 色（`:808`）+ danger icon，彩色密度偏高；建议标题文字改 neutral-fg、仅 icon 保留 danger（对齐 overlays ConfirmDialog 的 size-4 icon + 中性标题范式）。

**v6-spec-tokens.html**
1. `:471` `border-left: 1px dashed var(--accent-ring)` 的层级连线用 accent-ring 色，是文档 chrome 里唯一的彩色线；建议改 `var(--border-strong)` 保持 chrome 中性（D7 精神）。
2. §6 z-index 表建议补一行 toast 9999 固定值例外（与 overlays:510/:516 对齐），tokens 稿作为 token SSOT 不含该例外会造成两稿信息差。
3. §7 图标 scale 的 anno「双环 loader SVG 1.7 保留」与 design §4.1「stroke-width 统一 1.75」表述有张力，建议在 design 侧补「loader 1.7 例外」或此处改 1.75，消除 SSOT 间灰区。

---

### 子报告 6 · SSOT + 横切验收组

核验完成，证据充分。输出复审报告。

## A. 修复任务执行核验

**L1.1 Drawer 一体化（D2+R14）**
- design §4.3 弱投影 0.16 + 共享 surface → done（v6-design.md:202「保留弱投影 shadow: -12px 0 24px rgba(0,0,0,0.16)」）
- 决策 #10 表「main+drawer 共享 surface 浮起」→ done（v6-design.md:43）
- §3.4 补弱投影分隔 → done（v6-design.md:130）
- shadow token 0.25 残留清理 → **partial**：design.md/drawer spec:91/shell spec:47 已 0.16，但 **v6-demo.html:88 仍 0.25**、v6-drawer-tabs-demo.html:23 仍 0.25

**L1.2 tasks tab 移除（D3）** → done。标题 7 tab（:198）、组件表/策略表无 tasks 行（:202-223）、决策声明（:227）、C4「git·doc 无二级」（:431）

**L1.3 plugin/GitPanel 授权（D4）** → done。决策 #15（:33）、#16（:34）、§1.3 第 5 tab 注（:53）、§4.3 sd-unread+1:1+形态 B 阶段 B 衔接（:229）、§4.2 标题 5 tab（:184）

**L1.4 设置页条款（D1+R3+R4）** → done。§4.5 标题去重、desc 改 neutral-mid（:243）、SelectTrigger 按 D10 终裁「spec 画目标态」（:246）、ProviderEdit 手风琴（:52/:244）、内容列左对齐（:241）

**L1.5 次级裁决回写** → done。R11 14px（:172）、R2 M=info 蓝（:41）、R5 TurnRail（:181）、R8 BgNotifyCard（:182）、R9 expanded neutral-mid（:167）、R23 pill surface-2（:166）、R10 整 turn 居中（:49）、R13 12px（:103）、R1 3px 外环（:179）、7 tab 措辞（:202）

**L1.6 横切条款** → partial。§3.6 chrome（:143）、§3.5 popover 12px+tt-close 例外（:137/140）、§3.3 7px（:119）、§3.7 D8（:147）、§3.8 R25（:152）、§3.1 标题删 SearchModal（:100）均 done；**toast z-9999 例外未登记进 §5.2**（:268 无 toast，overlays:516 仅本地登记）

**L1.7 README** → partial。v6 章节/索引/SSOT 链/分区标注 done（:5/:31-103）；但 :56 仍列已删的 `v6-spec-settings.html`（死链）、:67 称 base.css「规划中，尚未创建」（实际 22:50 已创建）

**L1.8 design-system** → done。头注（:3）、Card 去 border（:28）、Button SSOT（:43）、选中态（:53）、分隔策略（:55）

**L4.1 chrome 范式** → done（design §3.6，:142-144）

**L4.2 各文件 chrome 清理** → **partial（主目标未命中共享文件）**
- state-tag uppercase：sidebar:164/drawer:184/provider:169 已清 ✓；**v6-spec-base.css:179 `.state-tag` 仍 `text-transform: uppercase`**（影响对话流四稿）
- 表头 th：**v6-spec-plugin-rendering.html:377（.ansi-table th）、:561（.cap-api-table th）仍 uppercase**
- anno 彩条→bg-soft ✓（plugin:469、max-demo:387-391、drawer:1975 区域已改）
- **provider:659-660 `.j-decision`/`.j-success` warn/success 染底卡片未改**（L4.2 自查补项遗漏）

**L5.1 summary 修正** → partial。accent-ring 0.30(:99)、SearchModal=modal(:135)、composer 3px 外环（:168)、icon 14px(:220)、M=info 蓝（:34)、R4 手风琴（:45)、R10 整 turn(:42)、D2(:36/:212)、7 tab(:319)、文件名（:263) 均 done；但多处状态行滞后（见 C-8/9）

**L5.2 跨文件一致性** → partial。token 关键值/骨架 1320·820·860/状态点 7px/圆角档位 抽查全过；**CommandPopover 选中态跨文件矛盾**（base.css:445 accent-soft vs plugin:405 bg-surface）；exit 标签档值不统一（base.css:264 surface-2 vs v6-demo:374 bg-elevated）；state-tag 宽 76(base.css:178/drawer:185) vs 84(sidebar:165) 未统一

**L5.3 impeccable 扫描** → partial。>1px 彩色侧边条零命中 ✓（仅 base.css:370 blockquote 中性条，design 明示豁免）；硬编码色均有豁免注释 ✓；chrome uppercase 残留（见 L4.2）；产品 UI 的 CSS text-transform 已清但**渲染文本仍字面全 caps**（blocks:258/270「THINK」、input:558/561「ZHIPU」「ANTHROPIC」）；emoji 残留 max-demo:418「⚠」、blocks:236「⚠」；渐变残留 input:513（内联 quota 条）、tokens:343（radius-demo 样块）

**L5.4 面上面** → done。tm-badge surface-2（base.css:238）、demo tm-pill/exit-tag/change-set bg-elevated（v6-demo:324/374/378），升一档可见性方案已落实

**L5.5 visual-modernization 同步** → done。头注（:3）+ 5 处「v6 修订」注（:37/:137/:150/:175/:181）；基线未提及 tasks/TurnRail，无需补注

## B. 大方向一致性（对比最初设计意图）

五原则落地到位：层级代替边框（bg-card 层级 + hairline 0.04 + drawer 去 border-l）、圆角升档（6/10/12/999，tt-close 3px 例外已登记）、正文提亮（#7d8494 + R9 neutral-mid）、内容收窄（720px token 贯穿对话流与设置）、彩色降噪（7px 圆点统一、M=info 蓝、中性 badge、装饰渐变清除）。D1-D11 全部在 SSOT 正确回写；基线中的「v6 修订」标注均为有意偏离，不算不一致。

唯一方向性不一致：**验收 SSOT v6-demo.html 的 drawer 仍是 D2 之前的旧模型**——`:412` `.drawer { background: var(--bg-sunken) }`（=画布 --bg，非 surface）+ `:88` shadow 0.25 强投影。design §9 以 demo 目标态为视觉验收 SSOT，而它展示的恰是被 D2/R14 推翻的方案，截图验收会走岔。

## C. 细节不一致/新引入问题

1. **P0**｜v6-demo.html:88,412｜验收 SSOT drawer 旧模型（bg-sunken+0.25 强投影），与 D2/R14 直接冲突；L3.19 任务清单未覆盖此项（计划盲区）
2. **P1**｜v6-design.md:441,463｜两个 `## 9.` 标题（验收基准/文档同步清单）编号 bug **未修**（审查点名项）；另 §5 跳号 5.4→5.6（:274/:278，缺 §5.5）
3. **P1**｜v6-spec-base.css:179｜`.state-tag` 仍 `text-transform: uppercase`——D7 横切主目标恰恰漏在新建的共享文件里，container/blocks/content/input 四稿全部继承
4. **P1**｜v6-spec-base.css:445,455｜`.cmd-row-slash.sel`/`.cmd-row-file.sel` 用 accent-soft+accent，违 §3.7「CommandPopover 项=列表项型 §3.2」；且与 plugin spec 自家引用范式 `v6-spec-plugin-rendering.html:405`（bg-surface+蓝字，注释明引 §3.2）同组件两说法
5. **P1**｜v6-spec-settings-shell.html:196 vs v6-demo.html:589｜设置内容区底色矛盾：shell spec `.fs-content` = surface，使 bg-card(#22242c) 卡片比父级**暗**（下沉非浮起，与 :298 注释「明度差表达边界」方向相反）；demo 内容区 = --bg（卡片浮起 ✓）。两稿必有一错
6. **P2**｜v6-spec-shell.html:479,541｜§7 drawer 演示 `.wf-drawer-inline`/`.dd-drawer` 用 surface-2，与 :476 注释「同 surface」及 D2「同色体」字面冲突（drawer spec:197 用 surface 是对的）
7. **P2**｜v6-spec-plugin-rendering.html:377,561｜两处文档表头 th 仍 uppercase（D7 残留）
8. **P2**｜v6-spec-settings-provider.html:659-660｜`.j-decision`/`.j-success` warn/success 染底卡片未改中性（L4.2 自查补项遗漏）
9. **P2**｜v6-summary.md｜多处滞后：:241 称 README「未提及 v6」（已更新）；:276 仍列已删的 v6-spec-settings.html；:231「1 MD + 19 HTML」计数错（实 18 HTML+2 MD）；§5 行数列大面积过时（content 标 1,081 实 634、container 标 1,269 实 873、blocks 标 1,569 实 1,173、input 标 1,161 实 759）；:321 笔误「0.24px」
10. **P2**｜README.md:56,67｜死链 v6-spec-settings.html；base.css 状态「尚未创建」滞后
11. **P2**｜v6-spec-base.css:412 vs :225｜send-slot svg 仍 15px（L3.7 要求→16px），且 :225 注释谎称「send-slot 同档 16px」；:212 注释「13px 对齐 §5.3 scale」但 13∉{10,12,14,16}，注释本身失实
12. **P2**｜v6-design.md｜toast z-9999 例外、plugin gprog-fill 55% 两处「建议登记」均未登记（:268、:79-84 无；overlays:516/plugin:326 已本地处理）
13. **P2**｜v6-spec-input.html:513｜模型 popover 内联 quota 条仍 `linear-gradient(accent→accent-hover)`（L3.10 只改了 .cap-bar 类，漏此内联实例）；v6-spec-tokens.html:343 radius-demo 渐变样块
14. **P2**｜v6-spec-blocks.html:258,270「THINK」/v6-spec-input.html:558,561「ZHIPU」「ANTHROPIC」｜text-transform 已删但文本字面全 caps，视觉上 normal-case 修复未生效（blocks:236、max-demo:418 的 ⚠ 同类小残留）
15. **P2**｜state-tag 宽度 76(base.css:178/v6-spec-drawer.html:185) vs 84(v6-spec-sidebar.html:165)｜E.9 统一未做；exit 标签 surface-2(base.css:264) vs bg-elevated(v6-demo:374) 档值不统一
16. **P2**｜design-tokens.md:79｜仍 `--radius-sm: 3px`、无 7d8494/content-max-w、无 v6 注记。fix-plan 未将其列入（留实施期 C1 反写），属有意 deferred，但过渡期内与 README:92「唯一值源」并行存在 3px↔6px 矛盾，建议至少加一行 v6 预告注记

## D. 分页面改进意见

**v6-design.md**：① 修双 `## 9.` + 补 §5.5 跳号；② §5.2 补 toast 例外登记（一行即可，与 overlays:516 对齐）；③ §2.3 补 gprog-fill 55% 登记或改 12%；④ §3.7 的「is-current popover 项」豁免建议补定义句（当前 pop-item.sel/model 选中靠它兜底，边界靠猜）。

**v6-summary.md**：① 全文状态行刷新（README/tokens/system/文件计数/行数列）；② 删 v6-spec-settings.html 条目；③ :321「0.24px」笔误；④ 自我标注「临时整理文档」与 README 互为索引，建议明确谁是索引 SSOT 避免双源漂移。

**base.css + 对话流四稿**：① state-tag 去 uppercase（一行修四稿）；② CommandPopover sel 改 §3.2 bg-surface+蓝字，与 plugin spec 对齐；③ send-slot svg 15→16px 并修 :225/:212 失实注释；④ blocks「THINK」改「Think」、input 供应商名大小写混合化，否则 normal-case 修复形同虚设；⑤ .pop-item.sel 与 .cmd-row.sel 两套选中语义建议在注释中点明「is-current vs 键盘选中」差异。

**v6-spec-shell.html**：① §7 演示 drawer 底色 surface-2→surface（或注释说明「演示为可辨性提亮一档」）；② 与 settings-shell 的 .btn SSOT 注释互相引用一次即可，避免两处维护。

**v6-spec-settings-shell.html**：① 裁决 `.fs-content` 底色——若坚持 surface，则 bg-card 卡片需换成更亮档（surface-2），否则方向倒挂；建议对齐 demo 改 --bg；② `.settings-modal` 类名已名实不符（全屏非 modal），建议改 `.fso` 同款命名。

**v6-demo.html（验收 SSOT，最优先）**：① drawer 改 D2 新模型（bg-surface + shadow 0.16）；② settings 容器去 border+radius（全屏无框，对齐 .fso）；③ :1129 文案残留「overview 卡片」顺手清理；④ tm-pill(bg-elevated) 与 base.css tm-badge(surface-2) 统一一档。

**v6-spec-drawer.html**：① state-tag 宽与 sidebar 统一（84px）；② §9 TasksPanel 章节标题可改为「§9 tasks tab 移除决策（视觉参照存档）」，现标题（:1948）仍像活跃章节。

**settings provider/resources**：① provider:659-660 j-decision/j-success 去染底；② provider-card 圆角 var(--radius)=8px，与「分组卡片 10px」条款不齐（.eg 已 10px），建议统一；③ resources skeleton shimmer 渐变建议加豁免注释。

**plugin 两稿**：① plugin:377/561 th 去 uppercase；② max-demo:418 ⚠ 改 TriangleAlert SVG；③ drawer-tabs-demo:23 的 0.25 token 虽有 SUPERSEDED 横幅兜底，建议顺手改 0.16 防抄错。

**tokens 稿**：① :343 radius-demo 渐变样块改纯色；② tokens 与各 spec 的 token 块建议在头注声明「以本文件为 SSOT，其余为拷贝」，当前 19 份 token 块靠 L5.2 人肉对齐，下次改值必再漂移。
