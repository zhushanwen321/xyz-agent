# v6 视觉稿全量修复计划（2026-07-31，rev2 含自查修订）

> **本文档取代** [`v6-review-action-plan.md`](./v6-review-action-plan.md)（那份按视图分阶段，导致同一文件反复改；本份按根源分层 + 文件集中修一次）
> 输入：[`v6-review-2026-07-31.md`](./v6-review-2026-07-31.md) 五路审查报告（676 行）
> 核实：349 条断言全量核实 → 336 完全属实（96.3%）/ 7 部分成立（行号瑕疵）/ 6 错误
> 自查：5 路并行核查计划覆盖性 → 发现 4 阻断缺口 + 若干遗漏，已全部补入本 rev2
> 范围：**全部 349 条断言**，无遗漏。每条断言都归入某个修复单元
> 方法论：先裁决 → 改 SSOT → 建共享基建 → 按文件集中修一次 → 文档 chrome 横切贯穿 → 验收

---

## 0. 已确定的裁决（用户已拍板）

**首轮四项 + 三项额外（D1-D7）**：

| # | 裁决点 | 决定 | 影响层 |
|---|--------|------|--------|
| D1 | 设置形态 | **全屏覆盖** | 重写 settings shell spec；删旧 settings.html |
| D2 | Drawer 模型 | **一体化生长 + 保留弱投影**（R14 细化） | **反向修订 v6-design** §4.3+§4.1+#10；shell §7 重做；drawer spec 8 处 shadow 残留全清；**drawer 与 main 同 surface 色，但保留弱投影 .15-.18 做视觉分隔**（非完全无投影）|
| D3 | tasks tab | **移除（回归对话流）** | **反向修订 v6-design** §4.3（标题 6→7、删 TasksPanel 行、删「变 8 个」措辞）；drawer spec 同步；blocks §12 登记 |
| D4 | plugin 范围 | **补登记架构授权** | v6-design §1 补决策 #15；plugin spec 保留标注阶段 |
| D5 | 对话流共享 CSS | **抽取 v6-spec-base.css** | 根治四文件复制漂移 |
| D6 | 次级裁决方式 | **本计划给推荐，用户批量确认** | §1 R1-R26 表 |
| D7 | 文档 chrome | **不豁免** impeccable | Layer 4 横切贯穿所有 spec |

**自查后新增四项（D8-D11，用户已拍板）**：

| # | 裁决点 | 决定 | 影响层 |
|---|--------|------|--------|
| D8 | 选中态范式冲突 | **按组件类型二分** | tab 型=§3.1 bg-elevated / 列表项型=§3.2 bg-surface+蓝字；删 design §3.1 标题里的 SearchModal；补统一判定规则 |
| D9 | SSOT 链文档 | **全部同步更新** | 新增 L1.7（README）+ L1.8（design-system.md）+ L5.5（visual-modernization）|
| D10 | SelectTrigger（R3） | **spec 画目标态（无 border+bg-input），不改 .vue 源码** | spec 对齐 design §4.5 现有决策；真实组件改造留实施阶段；design 不动 |
| D11 | TurnRail 动态高度 | **拆 spec 层 + 组件层** | spec 删 h-340 固定值+画变体示意+anno 注明自适应；design §4.1 登记「高度=turn 数×行高，renderer 实现」|

---

## 1. 次级裁决推荐清单（请审计划时批量确认）

审查标"待人工确认"的次级决策，本计划给出推荐方案 + 依据。**标 ✏️ 的为推荐值**，你审计划时可逐条调整。

| # | 裁决点 | 审查呈现 | ✏️ 推荐 | 依据 |
|---|--------|---------|---------|------|
| R1 | composer focus 环 | input spec 3px 外环 vs summary「inset 单环」 | **3px 外环** | 对齐真实代码（input:262 + style.css），inset 单环会与 Input 冲突；summary 错，改 summary |
| R2 | git M badge 色 | design #8「M 黄」vs spec/代码 info 蓝 | **info 蓝** | 真实代码 `ChangeSetCard.vue:120` 用 info；spec 已对齐代码；改 design #8 条文 |
| R3 | SelectTrigger | design §4.5「去 border 改 bg-input」vs spec「复刻 xyz-ui 现状」 | **spec 画目标态（无 border+bg-input），不改 .vue 源码**（D10） | spec 是规格说明，记录目标态；design §4.5 不动（保留去 border 作为目标）；真实组件改造留实施阶段 |
| R4 | ProviderEdit 结构 | design #14「嵌入式面板+返回」vs provider「展开就地编辑」 | **展开就地编辑** | provider spec 更新（18:31 晚于 design）；手风琴展开更适合密集表单；改 design #14 + summary |
| R5 | TurnRail 去留 | §3.5 既有组件，active 违 §3.2，2px border-l 踩禁令 | **保留但修范式，动态高度拆两层**（D11） | active 改 §3.2 范式；viewport indicator 去 border-l-2 改 accent 短粗线；spec 层删 h-340 固定值+画 1/5/20 turn 变体示意+anno「自适应」；design §4.1 登记「高度=turn 数×行高，renderer 实现」|
| R6 | SearchModal 选中态 | sel 与 hover 同色，键盘导航不可见 | **对齐 §3.2**（bg-surface+蓝字） | sel/hover 同色是功能性缺陷；键盘导航必须可见选中项 |
| R7 | AskUserOverlay 选中态 | au-tab/au-opt 用 accent-soft vs §3.1 去蓝染 | **改中性浮起**（bg-elevated） | 与 §3.1 统一；companion-band 范式已定，不应两套 |
| R8 | BgNotifyCard border | border+bg 卡片，原则 #1 边缘案例 | **保留 border**（登记例外） | 系统级通知需与普通消息块视觉区分；在 design §4.1 登记例外 |
| R9 | thinking expanded body 用 dim | #7d8494 on surface ≈4.3:1 不过 AA | **改 neutral-mid** | 长正文必须过 AA；dim 仅留装饰位 |
| R10 | 列宽 #11 措辞 | design「仅 assistant 居中」vs mixer/demo「整 turn 居中」 | **整 turn 居中、气泡列内右浮** | 实现都是后者；改 design #11 措辞对齐实现 |
| R11 | block icon 尺寸 | design §4.1「13px」vs §5.3「14px」 | **14px** | §5.3 scale 更系统；改 §4.1 的 13→14 |
| R12 | z-index 映射 | tokens 稿 SearchModal=modal(1000) vs summary=overlay(20) | **SearchModal=modal(1000)** | 全屏覆盖语义；改 summary §3.3 |
| R13 | SegmentedTab 圆角 | plugin 8px vs sidebar 12px vs §3.1「rounded-lg」 | **12px**（radius-lg） | §3.1 措辞 rounded-lg=12px 明确；改 plugin spec 8→12 |
| R14 | drawer 投影强度 | design `-12px .25` vs 审查建议 `.15-.18` | **保留弱投影 .15-.18**（D2 细化） | D2 一体化（drawer 与 main 同 surface 色）+ 保留弱投影做视觉分隔（非完全无投影）；弱化原 .25 到 .15-.18 |
| R15 | drawer tab active 范式 | drawer l1/l2 tab、wf-call.selected 用 accent-soft | **统一中性浮起**（bg-elevated） | §3.1 范式方向；accent-soft 只留瞬时高亮（fresh/is-current） |
| R16 | provider 4 层嵌套 | surface→provider-card→eg→ml-advanced(surface-2) 明度 zigzag | **收敛到 3 层** | 决策 #10「不嵌套第四层」；ml-advanced 改 bg-card 与 eg 同层 |
| R17 | resources 来源 badge 5 色 | claude=warn/agents=success 等 5 soft 色 | **中性底 + 彩色小点** | 决策 #8「极小圆点或单字」口径 |
| R18 | popover z-[1100] | 超 --z-modal:1000 上限 | **并入 modal 档**（z-modal 1000） | 不新增第五档；popover 与 modal 同级 |
| R19 | popover 圆角 | spec 8px vs design §3.5「12px」 | **12px** | §3.5 明确浮层 12px |
| R20 | TogglePad p-2px | drawer DetailPane toggle vs §3.1 p-3px | **3px** | §3.1 明确覆盖 DetailPane |
| R21 | 7px 圆点 | sa-dot/wf-dot 8px、wf-status 9px | **统一 7px** | §3.3 统一标准 |
| R22 | 圆角升档例外 | tr-git 3px、fg-pill/tr-dirbadge radius-sm-old、tt-close 3px、**cd-inline-code 4px**（自查补） | **tr-git/fg-pill/tr-dirbadge/cd-inline-code 升 6px；tt-close 保留 3px 例外**（图标按钮锐利感） | 决策原则 2；删 --radius-sm-old |
| R23 | TurnMeta pill bg（自查补，②-5 收口） | 四文件 `.tm-badge` 用 surface-2 vs design「bg-surface」 | **保留 surface-2，main-panel 上升一档 bg-elevated**（解决"面上面"） | surface-2 比 surface 浮起一档，解决主面板 surface 上不可见；回写 design §4.1「TurnMeta pill = surface-2」 |
| R24 | 选中态二分规则（D8 落地） | design §3.1 标题把 SearchModal 列为 SegmentedTab 复用者，与 R6 矛盾；三套范式混用 | **按组件类型二分 + 删 §3.1 标题 SearchModal** | tab 型（SegmentedTab/drawer l1-l2 tab/AskUserOverlay au-tab）= §3.1 bg-elevated；列表项型（SessionItem/FileTree/SearchModal sm-item/AskUserOverlay au-opt/wf-call/CommandPopover 项）= §3.2 bg-surface+蓝字；accent-soft 只留瞬时高亮（fresh/is-current popover） |
| R25 | 行级 focus 裁决（自查补，跨 L3.1/L3.3） | provider 非 Button 单环 vs shell nav 三段式 | **inset 单环（与 Input 一致）** | 链接/行级可点元素 focus = `inset 0 0 0 1px var(--accent-ring)`；补进 design §3.x + shell §6 |
| R26 | 文件级补点名（自查补，防漏改） | wf-status/b-l2-tab.on/ph-btn/ph-status/send-slot/cb/count 等 | **并入对应 L3 文件清单显式点名**（见各 L3 单元增补条） | 依赖 R 全局 + L5.2 验收兜底有漏改风险，文件级清单必须显式列出 |

---

## 2. 修复架构（分层 + 文件集中修一次）

```
Layer 0  裁决（§1，已定 D1-D11 + R1-R26 待批量确认）
   ↓
Layer 1  SSOT 修订（v6-design.md + README + design-system.md，裁决回写）
   ↓
Layer 2  共享基建（v6-spec-base.css + v6-spec-tokens.html + v6-design.md 横切条款）
   ↓
Layer 2  共享基建（v6-spec-base.css + v6-spec-tokens.html + v6-design.md 横切条款）
   ↓
Layer 3  各文件集中修一次（10 个 spec + 2 demo + summary）
   ↓
Layer 4  文档 chrome 横切清理（所有 spec 的 state-tag/彩条/uppercase）
   ↓
Layer 5  验收（跨文件一致性扫描 + impeccable 扫描）
```

**关键原则**：
- 每个文件**只在 Layer 3 改一次**（chrome 清理在 Layer 4 跨文件扫一遍补漏，不单独进 Layer 3）
- Layer 1 SSOT 先行，所有 spec 修订以更新后的 design 为基准
- Layer 2 共享基建（base CSS + tokens 稿骨架）是对话流漂移 + 文档 chrome 的根治基础

---

## Layer 1 · SSOT 修订（v6-design.md）

> 目标：让 v6-design.md 反映 D1-D4 + R1-R22 的全部裁决，消除"SSOT 与 spec 互相否定"根因。
> 性质：纯文档修订。**所有后续 Layer 以此版 design 为基准**。
> 依赖：Layer 0 裁决全部确认。

### L1.1 — Drawer 一体化（D2 + R14 弱投影细化）
- [ ] §4.3 SideDrawer 容器行：改「drawer 与 main 共享同一 surface 浮起体（底色同为 --surface），从 main 右缘生长挤占 main 宽度；**保留弱投影 .15-.18 做视觉分隔**（R14，弱化自原 -12px .25）；去 border-l 硬分隔」
- [ ] §4.1 决策 #10 表：drawer 从「画布色 --bg」改「与 main 同体 --surface」；三层明度改「stage 深底 → 画布 --bg → **main+drawer 共享 surface 浮起**」
- [ ] §3.4 分隔策略：补「drawer 与 main 间靠弱投影 .15-.18 + SplitterResizeHandle 透明化分隔（非 border）；内部 header 用 bg-surface-2 浮起分层」
- [ ] §4.3 SplitterResizeHandle 行保留「透明化 hover/drag 显 accent」
- [ ] §4.3 shadow-drawer token：值从 `-12px 0 24px rgba(0,0,0,0.25)` 弱化到 `rgba(0,0,0,0.15)` ~ `0.18`（保留 token，改值）
- [ ] 验收：全文 grep `-12px 0 24px rgba\(0,0,0,0\.25\)|bg-sunken.*drawer`，确认旧强投影 + 画布色无残留（弱投影 .15-.18 允许保留）

### L1.2 — tasks tab 移除声明（D3）
- [ ] §4.3 标题「（6 tab）」改「（7 tab）」（terminal/browser/git/doc/detail + subagent + workflow）
- [ ] §4.3 组件表删 TasksPanel/GoalCard 行
- [ ] §4.3 二级 tab 策略表：删 tasks 行
- [ ] §4.3 补决策声明：「tasks tab 移除，goal/todo 走 gui-protocol 统一渲染回归对话流；移除 HIDDEN_TOOL_NAMES 对 todo/goal_control 特判（迁移影响见 blocks spec §12）」
- [ ] §4.3 C4 实施波次：「git·doc·tasks 无二级」改「git·doc 无二级」
- [ ] §5.3 / §4.3 `:200`（非 :404）二级 tab 表 tasks 行删除
- [ ] 验收：全文 tasks/TasksPanel/GoalCard 引用与「7 tab」一致

### L1.3 — plugin 架构授权 + GitPanel 功能授权（D4 + §7 GitPanel 决策）
- [ ] §1.1 决策表新增 #15：「plugin 渲染体系扩展授权——M1 侧栏第 5 tab / M8 main-panel 底栏 + StatusBarController / M11 companion-band 统一交互出口 / M15 降级仅致命错误 / C1-C3 companion/overlay 窗口化 / §9 ExtensionHost 层 + commands.register/views.update API 缺口，属 renderer-target-architecture 路线，与 v6 视觉层并列推进」
- [ ] **§1.1 决策表新增 #16（§7 GitPanel 决策）**：「GitPanel 三功能 MVP 授权——per-file stage/unstage toggle / BranchSelectPopover 分支切换 / CreateBranchModal 新建分支 / commit 快捷键 Cmd+Enter，零后端改动的纯前端能力，属 v6 范围」
- [ ] §1.3 结构决策补注：「sidebar 第 5 tab（plugin）授权新增，突破决策 #2 的 4 tab 拓扑——仅 plugin tab 例外」
- [ ] **§4.3 补 sd-unread 角标 + 主面板:drawer 宽度比声明（§7 决策）**：「sd-unread 未读角标保留（accent pill + 计数）；主面板:drawer 默认宽度比 1:1，可拖拽调整（D2 一体化后 drawer 挤占 main）」
- [ ] §4.2 侧栏标题改「（5 tab + 容器，第 5 tab 为 plugin）」
- [ ] **§4.3 形态 B 数据模型重构登记为阶段 B 衔接点（§7 决策）**：「detail 多文件 tab / terminal 多实例 涉及 useDetailPane 单值→map、单 PTY→多 PTY 重构，属阶段 B renderer 局部重构，v6 spec 仅保留视觉态，实现依赖阶段 B」
- [ ] 验收：plugin spec §9 + drawer spec 形态 B 标注「属架构路线，阶段 B 衔接点」；GitPanel 三功能 anno 标「已授权（决策 #16）」

### L1.4 — 设置页条款同步（D1 + R3 + R4）
- [ ] §4.5 标题去重（`:210` 与 `:212` 重复，删其一）
- [ ] §4.5 desc 文字色：`--neutral-dim` → `--neutral-mid`（R9 同源，消除与 §5.1 矛盾）
- [ ] §4.5 SelectTrigger：改「保持 xyz-ui 现状（bg-surface-2 + border），v6 不改组件本身」（R3）
- [ ] §4.5 ProviderEdit：#14「嵌入式面板+返回」改「展开就地编辑（手风琴）」（R4）
- [ ] §4.5 内容列：「左对齐（mx-0）」保留（D1 全屏后左对齐正确）
- [ ] 验收：§4.5 全文与 D1 全屏决策 + R3/R4 一致

### L1.5 — 次级裁决回写（R1/R2/R5/R8/R9/R10/R11/R13 + 自查补）
- [ ] §4.1 Block icon「13px」→「14px」（R11，对齐 §5.3）
- [ ] §4.1 决策 #8 git M badge：条文补注「M 色对齐代码 info 蓝（非 warn 黄）」（R2）
- [ ] §4.1 TurnRail：补登记「保留，active 用 §3.2 范式，viewport indicator 用 accent 短粗线（非 border-l-2）；高度=turn 数×行高，renderer 实现，spec 画变体示意」（R5 + D11）
- [ ] §4.1 BgNotifyCard：补登记「系统级通知例外，保留 border」（R8）
- [ ] §4.1 thinking expanded body：补「用 neutral-mid（过 AA）」（R9）
- [ ] §4.1 TurnMeta pill：补「bg-surface-2（主面板 surface 上浮起一档）」（R23）
- [ ] §1.3 决策 #11：「仅 assistant 居中」改「整 turn 居中、UserBubble 列内右浮」（R10）
- [ ] §3.1 SegmentedTab：补注「外层圆角 rounded-lg = 12px（非 8px）」（R13）
- [ ] composer focus：§4.1 补注「composer-box focus = 3px 外环（对齐代码），非 inset 单环」（R1，summary 反向改）
- [ ] **§4.3 tab 计数措辞（自查补，B-1.4）**：`:179`「从 6 个变 8 个」→「7 个一级 tab（terminal/browser/git/doc/detail/subagent/workflow）」；删「v6 新增 2 个一级 tab」措辞
- [ ] 验收：design 全文无 13/14、M 黄、仅 assistant 居中、inset 单环、「变 8 个」等将被推翻的旧措辞

### L1.6 — 横切条款补充（含 D8 选中态规则 + R25 行级 focus）
- [ ] §5.2 z-index：补映射「SearchModal/FullSettings = modal(1000)，AskUserOverlay/SideDrawer = overlay(20)」（R12）—— 注意 D2 后 SideDrawer 与 main 同体，z 归 sticky 或不单列
- [ ] 新增 §3.6「文档 chrome 规范」：spec 文档自身的 state-tag/anno 彩条/表头 uppercase **同样遵守 impeccable 禁令**，用 normal-case + 中性色标签（D7）
- [ ] §3.5 圆角：补「popover 12px（非 8px）」（R19）
- [ ] §3.3 状态点：补「统一 7px，无 8/9px 例外」（R21）
- [ ] §3.5 删 `--radius-sm-old` 概念（R22：tr-git/fg-pill/tr-dirbadge/cd-inline-code 升 6px；**tt-close 保留 3px 例外**）
- [ ] **§3.1 标题删 SearchModal（D8/R24）**：「SegmentedTab 新范式（侧栏/DetailPane/SearchModal/SearchModal 复用）」→ 删 SearchModal（sm-item 是列表项非 tab，归 §3.2）
- [ ] **新增 §3.7「选中态判定规则」（D8/R24）**：
  - tab 型（SegmentedTab / drawer l1-l2 tab / AskUserOverlay au-tab / plugin seg-tab）= §3.1 `bg-bg-elevated text-neutral-fg`
  - 列表项型（SessionItem / FileTree / SearchModal sm-item / AskUserOverlay au-opt / wf-call / CommandPopover 项）= §3.2 `bg-surface + text-accent`
  - accent-soft 仅留瞬时高亮（fresh / is-current popover 项）
- [ ] **新增 §3.8「行级 focus 裁决」（R25）**：链接/行级可点元素 focus = `inset 0 0 0 1px var(--accent-ring)`（与 Input 一致），补进 shell §6

### L1.7 — README.md 同步（D9，自查补 B-3.4）
- [ ] 加 v6 章节：v6 是当前进行中的全面重设计，ADR-0018 的 v3 冷蓝暗色为色彩基底但范式已演进
- [ ] 目录索引补 v6-design.md / v6-spec-*.html / v6-fix-plan.md / v6-spec-base.css（L2.1 新建）
- [ ] SSOT 链澄清：design-tokens.md（v3 原子）← v6-design.md（v6 范式 SSOT）← v6-spec-*.html（v6 视觉稿）
- [ ] 标注 archive/ 为 pre-v3 历史稿，v3/ 为 v3 正式稿（已被 v6 追认/修订）
- [ ] 验收：README 从 v6 视角可找到全部 v6 文档

### L1.8 — design-system.md 同步（D9，自查补 B-3.3）
- [ ] Card 族：补 v6「去 border 改 bg-card 层级」（消除 v3 的 border 语义）
- [ ] Button：补 v6 `.btn` SSOT（4 variant × 5 size + focus 双环裁决，对齐 settings-shell §6.1）
- [ ] 选中态原语：补 §3.1 SegmentedTab 新范式 + §3.2 列表项选中范式（引用 v6-design §3.7 判定规则）
- [ ] 分隔策略：补「层级代替边框」（v6-design §3.4）
- [ ] 文件头标注「v6 同步：2026-07-31，原语以 v6-design.md §3 为准」
- [ ] 验收：design-system 原语与 v6-design §3 一致

---

## Layer 2 · 共享基建

> 目标：建立对话流四文件的共享 CSS + tokens 稿骨架，根治复制漂移；文档 chrome 统一范式。
> 依赖：Layer 1。

### L2.1 — 抽取 v6-spec-base.css（D5，根治对话流漂移）
- [ ] 新建 `docs/page-design/v6-spec-base.css`，含四文件共享的 ~450 行产品 CSS（token 块 + 通用工具类 + 对话流公共组件类）
- [ ] 确定权威版本：以 content/blocks 较新版为基线，合并 input 的 QueueBubble 内嵌化、CommandPopover 单行
- [ ] 四文件（container/blocks/content/input）`<link rel="stylesheet" href="v6-spec-base.css">` 引入，删除各自的重复 CSS 块
- [ ] 各文件只保留**该文件独有**的 section 样式（如 container 的 TurnRail、blocks 的 subagent/workflow、input 的 Composer）
- [ ] 消除 7 处漂移（统一为一版）：QueueBubble 内嵌 / ChangeSetCard badge（rounded-sm 5 态，R2 info 蓝）/ md-codeblock head（h-7+surface-2/50+radius-lg）/ md 表格（方案 A）/ RetryIndicator（删）/ CommandPopover（单行）/ pulse-accent（2s box-shadow）
- [ ] 清死 CSS：subagent/workflow `.sa-task-preview`/`.sa-bgstatus`/`.wf-action`/`.wf-runid`、旧 `.retry-v6`、旧 `.qb-v6`、blocks 两套复制按钮并一
- [ ] 验收：四文件 grep 漂移点零命中；base.css 只有一份真值

### L2.2 — v6-spec-tokens.html 修正
- [ ] 骨架对齐 summary §5.2 基准：`.page` 1280→1320、`.doc-sub` 760→820、`.spec-desc` 820→860
- [ ] §8 规则 4：`neutral-dim` → `neutral-mid`（与实现一致）
- [ ] z-index 映射按 R12 修正（SearchModal=modal 1000）
- [ ] 文件头「与 demo 同一套 token」声明：要么补齐 demo 缺失 token，要么改措辞「核心 token 子集一致」
- [ ] 图标 scale header 统一 14px（R11）
- [ ] 验收：tokens 稿骨架与 shell 稿（1320/820/860）一致

### L2.3 — v6-design.md 横切条款已并入 Layer 1
（不单独修，L1.6 已覆盖）

---

## Layer 3 · 各文件集中修一次

> 原则：每个文件在此层**只改一次**，把该文件所有 349 条断言相关的修正集中做完。
> 文件内修复顺序：先结构（覆盖层/模型/tab 计数）→ 再 CSS 值对齐 → 再 anno/CSS 失配 → 最后死 CSS 清理。
> **文档 chrome（state-tag/彩条/uppercase）不在本层逐文件改**，统一在 Layer 4 扫一遍（D7）。
> 依赖：Layer 1（SSOT）+ Layer 2（base.css/tokens）。

### L3.1 — v6-spec-settings-shell.html（结构性重写，D1）
> 断言来源：子报告 4 全部 P0 + 部分 P1。自称 SSOT 却整体回退 modal 范式。

- [ ] **§1 覆盖层重写为全屏**：`.fs-scrim`/`.fs-modal` 删遮罩/blur/max-width-900/border/radius-12，改 `.fso`（参考旧 settings.html `:112-117`）`fixed inset-0 bg-bg z-modal` 纯不透明全屏；anno `:631` + spec-desc `:546` 同步
- [ ] **§2 nav**：`w-200 bg-surface border-r` → `w-220 bg-sunken` 无 border-r（搬旧 :118-120）
- [ ] **nav 选中态**：`surface-hover+neutral-fg+inset ring` → `bg-surface+text-accent` 无 ring（搬旧 :161）
- [ ] **内容列** `:276` `margin: 0 auto` → `margin: 0`（与 anno「mx-0 左对齐」一致）
- [ ] 分组卡片圆角 `:302` 8px → 10px
- [ ] hairline `:319` 0.08 → 0.04
- [ ] ConfirmDialog demo `:1379` 8px → 12px
- [ ] `.ui-input` `:378` 字号已 13px ✓，padding 已 0 12px ✓；checkbox 态类 `.on` → `.checked`（统一）
- [ ] **死 token** `:94 --shadow-glow`、`:98 --composer-btn-size` 删除（零消费）
- [ ] **补 `.btn svg 16px` 规则**（summary:148 声称有，shell 缺，其余 4 spec 都有）
- [ ] **nav icon** `:258` 17px → 16px（§5.3 scale）
- [ ] **死链修复 + i18n P0 承载（自查补 B-3.1/P2-4）**：nav `:668-705` 的 7 个死链（skill/agent/terminal/preset/worktree/update/system）—— 链接保留并标「待补 spec」；同时在 **shell §9 新增 i18n P0 五 key 验收区块**（soundTitle/successSound/errorSound/soundDefault/soundPreview），承载 i18n 修复验收（审查 §5-5 的轻量方案，不新建 SystemPage spec）
- [ ] inline error `:1355` `rgba(239,68,68,0.3)` → token（danger-soft 或 color-mix）
- [ ] `.fs-trap-ring` `:227` 常驻 accent ring → 删除（仅 focus 显）
- [ ] **SelectTrigger（R3/D10）**：`.ui-select` `:399-406` 画目标态 `bg-bg-input + 无 border`（对齐 design §4.5，不改 .vue 源码）
- [ ] Switch thumb shadow `:446` `0 2px 6px` 保留（作为统一值，provider :260 改此值）
- [ ] **shell §6 新增「行级 focus 裁决」（R25/L1.6 承接）**：链接/行级可点元素 = `inset 0 0 0 1px var(--accent-ring)`，供 provider L3.3 引用
- [ ] 验收：全文 grep `scrim|blur|900px|inset.*ring.*nav|200px.*nav` 零残留

### L3.2 — v6-spec-settings.html（旧文件，删除）
- [ ] 结构正确性（全屏/nav 220/选中态）已在 L3.1 吸收进新 shell
- [ ] **物理删除**该文件（控件范式过时：自定义 .sel-trigger/.cb/.sw、focus 3px 外发光 :238 非 inset 单环）—— 按审查建议不留归档
- [ ] 验收：文件不存在；新 shell 已含其正确的结构条款

### L3.3 — v6-spec-settings-provider.html
> 断言来源：子报告 4 provider 部分。

- [ ] 分组卡片 `.eg` `:351` 8px → 10px
- [ ] hairline `:375/.eg-hair`、`:423/.ml-row`、`:446/.ml-row` 0.08 → 0.04
- [ ] `.ui-input` `:225` 12px → 13px；padding `8px 12px` → `0 12px`；dense 类名 `.ui-input-dense` → `.ui-input.dense`
- [ ] checkbox 态类 `.on` → `.checked`
- [ ] SegmentedTab `.input-seg` `:413-419`：去 1px border、容器 8→12px、p-2→3px
- [ ] Switch thumb shadow `:260` `0 1px 2px` → `0 2px 6px`（统一 shell）
- [ ] ConfirmDialog `:588` 已 12px ✓
- [ ] **provider-card** `:289-291` `bg --bg + border` → 去 border 改 bg-card（消除双重分隔 + 凹陷方向错误）
- [ ] `.preview-item` `:600` 同改
- [ ] **嵌套收敛（R16，自查补防扁平）**：`.ml-advanced-inner`/`.compat-inline`/`.quota-win`（:470/478/513 surface-2）保留 surface-2 浮起一档（比 bg-card 亮、方向正确，维持 ≤3 层明度递进），**不全改 bg-card 避免三层同色扁平**；provider-card（:289）改 bg-card 去 border 消除凹陷
- [ ] **SelectTrigger（R3/D10）**：`.ui-select` `:235-241` 画目标态 `bg-bg-input + 无 border`（对齐 design §4.5，不改 .vue 源码）
- [ ] ProviderEdit 展开编辑保留（R4），design 已追认
- [ ] pill 纪律（§7 用户裁决：全 999 无例外）：`.pill-default`/`.default-mark`/`.thinking-pill`/`.cv`/`.pi-proto`/`.pi-conflict-badge`（radius-sm）→ 全部 999px 胶囊（§3.5，不保留状态语义例外）
- [ ] `.row-name` 等非 Button 可点元素 focus（:307/328/337/369/398/462/509 单环）→ 改 `inset 0 0 0 1px var(--accent-ring)`（R25 行级 focus 范式，shell §6 已定义）
- [ ] inline error `:316` `border: var(--danger)`（全强度红框）→ 中性 border + danger-soft 底（与 shell :1355 统一）
- [ ] `max-height: 600px` `:469` → 标注或引用 token
- [ ] ProviderEdit 内容列宽：确认不消费 `--content-max-w`（:99 定义不用），design §4.5 补注「provider 页放弃 720 列宽（密集表单）」
- [ ] 验收：圆角/hairline/input 字号 padding/dense 类名 与 shell 统一

### L3.4 — v6-spec-settings-resources.html
- [ ] 分组卡片 `:195` 10px ✓
- [ ] hairline：`.lp-row` `:225` 0.04 ✓；**组头** `.lp-group-head` `:212` 0.08 → 0.04（消除行/组头不一致）；anno `:578`「0.04」与 CSS 对齐
- [ ] `.ui-input` `:162` 14px → 13px；padding 已 8px 12px → 0 12px；dense `.ui-input.dense` ✓
- [ ] checkbox `.checked` ✓
- [ ] SegmentedTab `.rp-tabs` `:263-271`：容器 6→12px、p-2→3px、active surface-hover → bg-elevated
- [ ] scope pill `:221` `bg-surface + inset 1px border` → 去 inset border
- [ ] **来源 badge 5 色（R17）**：`.rp-badge` `:286` 5 种 soft 色 → 中性底 + 彩色小点
- [ ] desc 字号 `.rp-desc` `:283` 11px → 12px
- [ ] 验收：hairline/input/seg/badge 对齐

### L3.5 — v6-spec-settings-system-prompt.html
- [ ] 分组卡片 `:123` 10px ✓
- [ ] hairline `:134` 0.04 ✓
- [ ] desc 字号 `.sp-subtitle`/`.sp-hint` `:132/147` 11px → 12px
- [ ] 验收：desc 字号 12px

### L3.6 — v6-spec-settings-extension.html
- [ ] 分组卡片 `:184` 10px ✓
- [ ] hairline：`.scan-row` `:498` 0.04 ✓；**组头** `.group-head` `:190` 0.08 → 0.04
- [ ] `.ui-input` `:248` 13px ✓；padding `0 12px` ✓；dense `.ui-input.dense` ✓
- [ ] checkbox `.checked` ✓
- [ ] SegmentedTab `.seg-tabs` `:482-493`：容器 8→12px；内项 `.seg-tab` `:488` 5px → `var(--radius-sm)` 6px；p-3px ✓；active bg-elevated ✓
- [ ] scope pill `:204/461` `bg-surface + inset border` → 去 inset border
- [ ] desc `.ext-desc` `:346` 12px ✓
- [ ] `.ver` `:331` radius-sm → 999px 胶囊
- [ ] 验收：hairline/seg/scope pill 对齐

### L3.7 — v6-spec-container.html（对话流容器，依赖 L2.1 base.css）
> 断言来源：子报告 2 container 部分。

- [ ] 引入 v6-spec-base.css，删除与本文件重复的共享 CSS（QueueBubble 旧 .qb-v6 / RetryIndicator .retry-v6 / ChangeSetCard badge 旧 999px 版 / subagent·workflow 死 CSS / CommandPopover 旧版 / pulse-accent 旧 1.8s）
- [ ] **TurnMeta hr**（R 裁决：删）：§3 `:967/970`「决策待定」→「已删」；sticky 演示 `:1100-1108` 删 hr+border-bottom；§1 anno `:627` 已「删 hr」保持
- [ ] **PanelHeader status icon**（R 裁决：running 改中性）：CSS `:135-139` 删 `.s-running=accent`，running 改 `--neutral-ico`；desc `:898`「其余中性」与 CSS 对齐；render `:910/924/933` 同步（仅 done/error/warning 保留语义色）
- [ ] **TurnRail**（R5 + D11 保留修范式）：`.rail-node.active` `:548` `bg-accent-soft + ring-inset` → §3.2（bg-surface+蓝字 无 ring）；`.rail-vp` `:539` `border-l-2 border-accent` → accent 短粗线（非 border-l）；**spec 层**删 `h-340px :536/1244` 固定值，画 1/5/20 turn 变体示意 + anno「高度随 turn 数自适应，无固定上限」
- [ ] **瞬时浮层 anno/CSS（①-12）**：anno `:481/816/883`「border-border/50」vs CSS `:482/487/514` `border-strong` → 统一（建议 `border-border/50`，与 design §1.5 骨架一致）
- [ ] `.ub-v6.editing` `:216` `color-mix 22%` 魔数 → token
- [ ] `.tm-badge` `:160` surface-2 **保留**（R23：主面板 surface 上浮起一档，解决面上面；design §4.1 回写「TurnMeta pill = surface-2」）
- [ ] **"面上面"修复**：exit 标签 在 main-panel（surface）上 → 升一档 bg-elevated（TurnMeta pill 已是 surface-2，exit 标签同步）
- [ ] `:1004` 动画表「subagent bg 状态行（§10）」过时引用删除
- [ ] popover 圆角 `:319` 8→12px（R19）；z-[1100] → z-modal 1000（R18）
- [ ] **文件级补点名（R26）**：`.ph-btn` `:145` 26×22px / `.ph-status` `:134` 13px → 标注或对齐 §5.3 scale；send-slot svg `:147` 15px → 16px（操作图标档）
- [ ] 验收：hr/status icon/TurnRail/瞬时浮层/面上面 全部对齐裁决

### L3.8 — v6-spec-blocks.html（对话流 blocks）
- [ ] 引入 v6-spec-base.css，删重复 CSS
- [ ] **ChangeSetCard badge** `:194-199`（rounded-sm 5 态 info 蓝）作为 base.css 权威版（R2）
- [ ] **md-codeblock head** `:547-548`（旧版 radius 8 + 实色 surface-2）→ base.css 新版（h-7 + surface-2/50 + radius-lg）
- [ ] **md 表格** `:556-558`（旧网格线）→ 方案 A（base.css）
- [ ] **复制按钮双轨**：`.tool-copy` `:373-376`（absolute 旧版）删除，保留 `.blk-copy-row`/`.blk-copy` `:384-395`
- [ ] **§12 goal/todo**（D3 落地）：`.gt-goal-card` `:471-473` 去 border+bg 改 bg-surface（对齐 design §4.3）；确认 design L1.2 已声明移除 tasks
- [ ] `.bob-out` `:358` max-h 240px → 引用 `--bash-output-max-height` token
- [ ] `.tk-label`/`.sa-prefix`/`.wf-prefix`/`.gui-card-hd`/todo 标题 uppercase → normal-case（产品 UI，非 chrome）
- [ ] `.tool-bash-box` `:397-399`（border+bg-surface-2 双分隔）→ bg-input 无 border（向 BashOutputBlock 扁平风，建议提 design）
- [ ] `.gui-card-box` `:462-466`（彩色整圈 border）→ 去 border 改 bg-soft 整块
- [ ] `.bn-card` `:418-421` border 保留（R8 系统级通知例外，design 已登记）
- [ ] loader svg `:1073/1254` stroke-width 1.7 → 1.75
- [ ] **`.bn-fullcontent`（自查补 ①-10）**：`:434` `max-height:120px` vs anno `:1225`「max-h-[200px]」→ 统一 200px
- [ ] **thinking expanded body（自查补 R9 落地）**：`:632` spec-desc / `:635` cp 标签 / `:674` 内联 style / `:687` anno 由 neutral-dim 改 neutral-mid，删「非 mid / 与 preview 刻意色差」措辞，对齐 R9
- [ ] `:1004` 过时引用同 container
- [ ] ANSI demo `:1449-1450` ✓/⚠ 属终端输出保留
- [ ] **注**：`:982` 断裂注释残文本是 content 文件缺陷（blocks 无此问题），见 L3.9
- [ ] 验收：blocks 全部对齐 base.css + design

### L3.9 — v6-spec-content.html（对话流内容）
- [ ] 引入 v6-spec-base.css，删重复 CSS
- [ ] **ChangeSetCard badge** `:193-196`（999px 3 态旧版）→ 删，用 base.css 版
- [ ] **QueueBubble** `:214-242`（旧 .qb-v6 带边框 + box-shadow pulse 2s）→ 删，用 base.css 内嵌版
- [ ] **md-codeblock head** `:435/440`（新版）作为 base.css 权威版
- [ ] **md 表格** `:453-459`（方案 A）作为 base.css 权威版
- [ ] **pulse-accent** `:986/997-999`（2s box-shadow）作为 base.css 权威版
- [ ] `.mm-dialog` `:486` `max-height:70%` vs anno `:820`「92vh」→ 统一（建议 92vh）
- [ ] `:999` 动画表「QueueBubble/UserBubble 为 pulse 消费方」删除（QueueBubble 已去脉冲，UserBubble 同）
- [ ] loader svg `:992` stroke-width 1.7 → 1.75
- [ ] `.cap-bar` `:358/915` accent 渐变 → 纯色（去装饰渐变）
- [ ] **`:982` 断裂注释残文本（仅 content，自查修正归属）**：`:982` 只有结尾 `==== -->` 缺开头 `<!--`，补全；blocks 无此缺陷
- [ ] 验收：content 对齐 base.css，动画表无过时引用

### L3.10 — v6-spec-input.html（对话流输入）
- [ ] 引入 v6-spec-base.css，删重复 CSS
- [ ] **QueueBubble 内嵌** `:251-254,623`（新版）作为 base.css 权威版；desc `:623`「border-border/40」vs CSS `:251`「neutral-faint 60%」→ 统一（建议 border-border/50）
- [ ] **CommandPopover** `:334-353`（单行加粗+middot）作为 base.css 权威版
- [ ] **RetryIndicator** `:259` 已删 ✓；收尾 anno `:1135`「7 区」→「6 区」（与 §9 desc `:713` 一致）
- [ ] **composer focus（R1）**：`.comp-box-v6.focus` `:262` 3px 外环保留（对齐代码）；summary 反向改（L5.1）
- [ ] `.pop-v6` `:319` shadow `0 8px 30px .5` → `--shadow-2`；圆角 8→12px（R19）；z-[1100] → z-modal（R18）
- [ ] `.pop-head` `:320` bg `rgba(255,255,255,.015)` → token；uppercase → normal-case
- [ ] `.comp-box-v6.has-input` `:261` `rgba(255,255,255,0.04)` → bg-surface-hover token
- [ ] `.model-group` `:354/960-963` uppercase → normal-case
- [ ] `.cap-stat .lbl` `:363` uppercase → normal-case
- [ ] `.cap-bar` 渐变 → 纯色
- [ ] `.qb-more` `:254` padding-left 21px → 标准间距
- [ ] `:665` 说明文字 ⚡⏰ emoji → SVG 或文字描述
- [ ] `:593` ✗ → SVG
- [ ] 验收：input 全部对齐 base.css + R1

### L3.11 — v6-spec-shell.html（结构性 + §7 重做，D2）
> 断言来源：子报告 1 shell 部分。

- [ ] **§7 drawer 一体化（D2）按 §3.4 重做**：
  - `.wf-drawer-inline` `:480` border-left 删除
  - header `:488` border-bottom 删除 → bg-surface-2 浮起
  - `.dd-drawer` `:545` border-left 删除
  - `.dd-main-header` `:522` border-bottom 删除
  - drawer 底色 `:1332` `var(--surface)` ✓（与 main 同体，符合 D2）
- [ ] **§1 `:680` drawer 表述与 §7 统一**：改「drawer 与 main 共享 surface 浮起体」（消除同文件两种模型）
- [ ] **删方案 E**（折叠态 traffic-light 16→24px，`:854/1060/1105/1138`）：mac OS 红黄绿无法随折叠移动，技术不可行（AGENTS.md #11）
- [ ] 方案 A/G：保留，design §1.3 补声明（L1 已含或补）
- [ ] **anno/CSS 失配**：nav-btn 圆角 anno `:1046` 8px → 与 CSS `:193` 6px 统一（改 anno）；splitter transition anno `:1234` 150ms → 与 CSS `:442` 200ms 统一（改 anno）；§1 anno `:764`「rounded-lg」→ CSS `:153` 8px 统一（改 anno 为 rounded 或 CSS 升 12px，建议改 anno）
- [ ] splitter hover `:445` `border-strong` vs design「hover 显 accent」→ hover 改 accent（对齐 design）
- [ ] `.btn` `:621-642` SSOT ✓ 保留；确认补 `.btn svg`（与 L3.1 一致）
- [ ] 验收：§7 全文无 border-l/border-b；§1 与 §7 drawer 一致；方案 E 删除

### L3.12 — v6-spec-sidebar.html
> 断言来源：子报告 3 sidebar 部分。

- [ ] SegmentedTab `.seg` `:213` 12px + p-3px ✓ 保留（作为 §3.1 正统实现）
- [ ] SessionItem/FileTree 选中态 ✓ 保留
- [ ] **状态点统一 7px（R21）**：`.sa-dot` `:357` 8→7px；`.wf-dot` `:377` 8→7px
- [ ] **圆角升档（R22）**：`.tr-git` `:338` 3→6px；`.fg-pill` `:296`/`.tr-dirbadge` `:345` `--radius-sm-old` → `--radius-sm`（6px）；删 `--radius-sm-old` token
- [ ] **Overview 入口（D3 关联）**：`:501/533-536` `.sb-overview` 按 §4.4 DEPRECATED 删除或标「已移除」
- [ ] `.sb-navitem kbd` `:204` border-strong → 轻 border（kbd 惯例，可保留或登记）
- [ ] `.fg-item.fresh` `:284` `accent-soft + inset ring` → 瞬时高亮保留（R15 允许）
- [ ] `.wfd-cdot` `:415` 7px ✓
- [ ] `.si-dot` `:234` 7px ✓
- [ ] `.sb-logo color:#fff` `:192` → text-white 或 var（注释已说明，可保留）
- [ ] anno `:1367`「subagent 状态点 8px」→ 7px
- [ ] 验收：状态点 7px、圆角 6px、Overview 清除

### L3.13 — v6-spec-drawer.html（结构性 + 内部一致，D2 + D3）
> 断言来源：子报告 3 drawer 部分。tasks tab 四处矛盾 + browser 二级 tab 打架。
> **最大缺口（自查补 B-1.2）**：D2 一体化后，drawer spec 有 8 处 shadow-drawer / bg-bg 旧模型残留未处理，必须先清。

- [ ] **drawer 一体化 shadow 残留处理（D2 + R14 弱投影，阻断性）**：
  - `:92` `--shadow-drawer` token 定义 → **值弱化** `-12px 0 24px rgba(0,0,0,0.25)` → `rgba(0,0,0,0.16)`（保留 token，R14 弱投影）
  - `:196-199` `.sd-drawer { background: var(--bg); box-shadow: var(--shadow-drawer) }` → `background: var(--surface)`（与 main 同体），box-shadow 保留（用弱化后的 token），改注释「与 main 共享 surface + 弱投影分隔」
  - `:684` doc-sub「容器（bg-bg 画布色 + shadow-drawer 投影分隔）」→ 「D2 一体化，与 main 共享 surface，弱投影 .16 分隔」
  - `:715` spec-desc「底色用 bg-bg...去硬 border-l 改 shadow-drawer 投影分隔」→ 改为 D2 一体化 + 弱投影表述
  - `:717-718` compare-tag「现 border-l 硬分隔 / v6 shadow-drawer 投影分隔」→ 改为「v6 与 main 同体 surface + 弱投影 .16」
  - `:780-825`「分隔策略对比」演示块 → 重做（展示弱投影 .16 vs 旧强投影 .25 的对比，或改为 D2 一体化说明）
  - `:814` anno「shadow-drawer: -12px 0 24px」→ 弱化为「shadow-drawer: -12px 0 24px rgba(0,0,0,0.16)」
  - `.dd-drawer` `:545` border-left、`.b-l2` `:254` border-bottom、`.sa-readonly-hint` `:584` border-top 一并删（border 分隔全部去除，靠弱投影 + 同色体）
  - 验收：drawer spec 全文 grep `-12px 0 24px rgba\(0,0,0,0\.25\)|bg-bg.*drawer|border-l.*drawer` 零残留（弱投影 .15-.18 允许保留）
- [ ] **tasks tab（D3 移除，消除四处矛盾）**：
  - `:684` doc-sub「5 个一级 tab」→「7 个」（terminal/browser/git/doc/detail/subagent/workflow）
  - `:732` 注释「6 个」→「7 个」
  - `:755-757` §1 mock 删 tasks icon
  - `:815` anno「icon-only 8 个…tasks」→「7 个」（删 tasks）
  - `:906-907` §2 矩阵 tasks 划线行保持（标「已移除」）
  - `:1995` §9 mock tasks icon（on 态）删除
  - `:1965-1966` §9 移除声明保持
  - `:2187-2190` anno 保持
- [ ] **browser 二级 tab（消除 render vs anno 打架）**：anno `:1509`「二级 tab：无（单实例）」是离群点 → 改为「多页面 tab（已授权 plugin/view 体系，D4）」与矩阵 `:871-876` + mock `:1340-1347` 对齐
- [ ] **GitPanel badge（①-5）**：CSS `:431-434`（M=warn/A=success/D=danger/R=accent 彩色）→ `text-neutral-dim` 仅 U 保留 danger（对齐 spec-desc `:1519`/change-point `:1525`/anno `:1790`）；§7 目标态渲染 `:1563-1566` 同步改中性 class
- [ ] **DetailPane toggle（R20）**：`.dp-toggle`/`.l2-view` `:276/292` p-2px → 3px；`.dt-btn.diff.on` `:294-295` accent-soft → bg-elevated（与 `.dt-btn.on` 统一）
- [ ] **SubagentTab user 气泡（①-8）**：`.sa-user` `:576` max-w 80%→76%、bg-elevated→surface-hover（对齐 §4.1）
- [ ] **元信息 mt（①-9）**：`.cd-meta` `:510` mt-6（24px）vs spec-desc `:1811`「mt-4」→ 统一（改 spec-desc 为 mt-6，或 CSS 改 16px，建议 CSS 改 mt-4=16px 对齐 design :186）
- [ ] **DiffView anno/CSS（①-10）**：anno `:1187` 行号「40px/neutral-dim/60」→ 与 CSS `:307`「36px/neutral-faint」统一；anno `:1190`「12px/1.5」→ 与 CSS `:304`「11px/1.6」统一（建议改 CSS 升 12px/1.5）
- [ ] **disabled opacity（①-11）**：anno `:1301/1505`「opacity-30」→ 0.5（与 CSS `:337/377` + SSOT 一致）
- [ ] **二级 tab 字号（①-12）**：`.b-l2-tab` `:257` 11px、anno `:1084` 11.5px、demo 11.5px → 统一 11px（改 anno + demo）
- [ ] **§3 变体区偷换底色（①-13）**：`:1044/1052/1060` inline bg-input → 删 inline，用 class surface-2
- [ ] **CommandDocPanel source border（①-14）**：`.cd-source` `:496` border-strong → 去 border（spec-desc `:1811`「纯色文字」与 border 自相矛盾）
- [ ] **Splitter CSS（①-3）**：默认态 `:176-181` 显 border 竖线 → 真透明（删 `::before` border），hover/drag 显 accent
- [ ] **wf-call.selected（①-4）**：`:621/629` accent-soft → bg-surface+蓝字（§3.2，R15）
- [ ] **一级 icon tab（①-19）**：`.l1-icon.on` `:210` accent-soft → bg-elevated（R15）
- [ ] **1:1 宽度比（①-15，§7 决策：保留回写）**：`:715/727/825` 改 anno 表述「主面板:drawer 默认 1:1，可拖拽（D2 一体化后 drawer 挤占 main）」；design L1.3 已回写 §4.3
- [ ] **sd-unread 角标（①-16，§7 决策：保留回写）**：`:222-227/758-760` 保留；design L1.3 已回写 §4.3 声明
- [ ] **hover 底色统一（E.5）**：`.gp-file:hover` `:429`/`.wf-call:hover` `:620` surface-2 → surface-hover（与 .ts-item/.dp-btn 一致）
- [ ] **GitPanel MVP（§7 决策：已授权 #16）**：per-file stage / BranchSelect / CreateBranch（`:438-468/1558-1566/1723-1751/1771-1775`）anno 改标「已授权（v6-design 决策 #16）」；commit 快捷键 Cmd+Enter `:1569/1801` 同
- [ ] **形态 B 数据模型（§7 决策：阶段 B 衔接）**：`:970/1298` 多文件 tab / 多终端实例的 anno 标「视觉态，实现依赖阶段 B（useDetailPane 单值→map、单 PTY→多 PTY）」
- [ ] **state-tag 宽度（E.9）**：`:186` 76px → 与 sidebar `:166` 84px 统一（改一处，建议 84px）
- [ ] **未读指示（E.8）**：保留两种（sidebar 状态点 / drawer pill），语义不同可接受；或 design 登记
- [ ] `.b-l2` `:254` border-bottom 删除（D2 一体化 + §3.4，bg-surface-2 浮起即可）
- [ ] `.sa-readonly-hint` `:584` border-top 删除
- [ ] `.gc-resume` `:532` `color:#1a1b1f` → var(--bg)
- [ ] emoji `:1976` ⚠ → TriangleAlert SVG
- [ ] border-left 3px 说明框 `:1975` → bg-soft 整块 + icon
- [ ] uppercase `.gc-badge`/`.ts-verify`/`.gp-po-head` → normal-case（产品 UI）
- [ ] **文件级补点名（R26，自查补）**：
  - `.wf-status` `:623` 9px → 7px（R21）
  - `.b-l2-tab.on` `:261` 二级 tab active accent-soft → bg-elevated（R15/D8，tab 型）
  - `.cd-inline-code` `:506` 4px → 6px（R22）
  - `.tt-close` `:265` **保留 3px 例外**（R22 用户裁决：图标按钮锐利感，不升 6px）
  - `.gp-po-item.is-current` `:462` accent-soft 保留（瞬时高亮，R24 允许）
- [ ] 验收：tasks 计数 7 一致；browser 三处对齐；badge/toggle/splitter/wf-call 全部对齐；**shadow-drawer 残留零**

### L3.14 — v6-drawer-tabs-demo.html
- [ ] 头部加 **SUPERSEDED 横幅**「形态 B 已选定，本文档为探索稿，数值以 v6-spec-drawer.html 为准」（demo:291 还在问「你倾向哪种」误导）
- [ ] 二级 tab 字号 demo `:82` 11.5 → 11px（与 spec 统一）
- [ ] SegmentedTab `.seg`/`.crumb-view` `:34/99` p-2px → 3px（与 §3.1 统一）
- [ ] `.b-l2` demo `:81` bg surface + border-bottom → 与 spec 统一
- [ ] `.tt-close` demo `:73/86` **保留 3px 例外**（R22 用户裁决）
- [ ] `.note` `:29` border-left 2px → bg-soft 整块（D7 文档 chrome 也改）
- [ ] 验收：SUPERSEDED 横幅存在；数值不与 spec 冲突

### L3.15 — v6-spec-overlays.html（质量最高，小修）
> 断言来源：子报告 5 overlays 部分。

- [ ] **SearchModal sel（R6/D8）**：`.sm-item.sel` `:243` surface-hover → bg-surface+蓝字（列表项型 §3.2，与 hover `:242` 区分）；anno `:711`「§3.2 范式」名副其实
- [ ] **AskUserOverlay 选中（R7/D8 按类型二分）**：`.au-tab.active` `:282`（tab 型）→ bg-elevated（§3.1）；`.au-opt.sel` `:299`（列表项型）→ bg-surface+蓝字（§3.2）
- [ ] **ConfirmDialog loading 按钮（①-7）**：`:946/985` inline `surface-2+faint` → opacity 0.5 + spinner（SSOT disabled 态）
- [ ] `.sm-i-title` `:247` 13.5px → 13 或 14px
- [ ] `.sd-drawer` `:400` shadow 演示格 border —— 教学示意格，可保留或注明「示意」
- [ ] Toast z-9999 `:506/512` —— design §5.2 补登记 toast 例外（L1.6）或并入 z-modal
- [ ] mermaid SVG hex `:1034-1078` 示意图可豁免（注明）
- [ ] 验收：sel/au-tab/au-opt/loading 全部对齐裁决

### L3.16 — v6-spec-plugin-rendering.html（结构性 + 范围标注，D4）
> 断言来源：子报告 5 plugin 部分。

- [ ] **§2 desc M8 陈旧（①-11）**：`:770`「AppShell 底部跨全宽」→「main-panel 局部底栏」（与 A4 `:927-1013` 决策一致）
- [ ] **.dc-btn primary 未定义（① 表）**：`:1384` `dc-btn primary` → `dc-btn default`（`:395-399` 定义的）；max-demo `:801` 同改
- [ ] **§9.4 闭环计数（①-12）**：`:1962` 标题 6 / `:1964` 列 5 / `:1987` 6 含 M15 → 统一为 5 个完整闭环（M4/M5/M7/M8/M11），M15 已降级不计；标题改「5」
- [ ] **SegmentedTab 圆角（R13）**：`.seg-tab`/`.gtabbar` `:218/351` 8→12px；anno `:1300`「rounded-lg(8px)」→「rounded-lg(12px)」
- [ ] **plugin 第 5 tab active（①-5/D8）**：`.plugin-primary.active` `:447` accent-soft → bg-elevated（tab 型 §3.1，R15）
- [ ] **C1/C2 companion（①-6）**：`:1375/1404`（surface-hover+accent-ring 边+8px）→ 替换为 overlays 真实范式（bg-input/无边/12px）；max-demo `:172` 同
- [ ] **drawer tab active（D8 按类型二分）**：`:239` 是 tab 型但现用 `bg-surface` → 改 bg-elevated（§3.1，与 R15 一致）；max-demo `:210` 同改（文字色 neutral-fg 保留）
- [ ] **CommandPopover 选中（表/D8）**：`:404` accent-soft+accent → bg-surface+蓝字（列表项型 §3.2）
- [ ] **tab-bar 状态点（①-8）**：`.gtab-dot` `:355` 6px → 7px（R21）
- [ ] **progress fill（②-7）**：`.gprog-fill` `:326-330` color-mix 55% → design §2.3 补登记或改 12%（建议登记，插件进度条不同语义）
- [ ] **list-tree 缩进（②-7）**：`:1203/1208/1213`（16px）vs 决策#12（10px）→ 对齐 10px（或登记「list-tree 与 file-tree 不同组件」）
- [ ] **note-box 3px 彩条（④-2）**：`:466-467/567` → bg-soft 整块 + icon
- [ ] **.as-statusbar accent 40% border（④-4）**：`:527/948` → 去 border（D2 后底栏在 main 内）
- [ ] **.cb-wrap border（④-4）**：`:541` 包裹 bg-input 代码块 → 去 border
- [ ] **.gprog-fill.indet（④-7）**：`:332` `width:40%!important` → 正常值
- [ ] **文件级补点名（R26，自查补）**：`.cb` `:532` 11.5px、`.count` `:223` 9px → 标注或对齐 scale
- [ ] uppercase 文档 chrome `:174-176/184-185/474/1083/1458` → normal-case（D7）
- [ ] §9 标注「ExtensionHost/API 缺口属架构路线，阶段 B 衔接」（D4，design L1.3 已登记）
- [ ] 验收：M8 desc/dc-btn/闭环计数/seg 圆角/companion 全部对齐

### L3.17 — v6-plugin-max-demo.html（最大修正）
> 断言来源：子报告 5 max-demo 部分。

- [ ] **文档头注明**「缩放 mockup 不承载组件级 CSS 范式，组件值以 v6-spec-*.html 为准」（避免读者从这里抄错值）
- [ ] **sb-avatar 渐变（④-7）**：`:144` `linear-gradient(accent,reasoning)` → 纯色 bg-accent（§4.2）
- [ ] **M15 dialog（④-1/④-7）**：`:796` border danger + 无 icon + `:797` emoji ⚠ → 中性 border + TriangleAlert SVG（对齐 ConfirmDialog）
- [ ] **loop-card 3px 彩条（④-2）**：`:381-383` → bg-soft 整块
- [ ] **M15 降级框/必修缺陷框 3px（④-2）**：`:792/1160` → bg-soft 整块
- [ ] **drawer-tab active 文字色**：`:210` accent → neutral-fg（与 plugin spec 统一）
- [ ] **M6 全景点亮（建议）**：`:692` active plugin drawer tab —— 决策暂不开放 plugin tab，灰化或标「未来」；`:1019`「15/16」口径 →「14/16 + M6 未来」（与 :922/923「△ 未来」一致）
- [ ] **闭环计数（①-14）**：`:1130` 标题 6 / `:1134-1138` 5 pill → 标题改 5 或补 M15 pill（建议改 5，M15 降级）
- [ ] **M8 CSS 注释陈旧（自查补 1.13）**：`:215` 上方注释「全局底栏（跨全宽）」→「main-panel 局部底栏」（与 :663-678 实际渲染一致）
- [ ] **M8 item 字体（自查补，跨文件表）**：`:217` mono 10px → sans 11px（与 plugin spec `:265` 统一）
- [ ] **.mtag 硬编码色（④-5）**：`:85-87` `#06120a` 等 → token
- [ ] **.ss-switch（④-6）**：`:329` 30×17 → 36×20（SSOT）
- [ ] **.gprog-track（④-6）**：`:259` 5px → 6px（与 plugin spec :324 一致）
- [ ] **composer-bar border-strong（表）**：`:182` → transparent（与 input spec 统一）
- [ ] **msg-user（表）**：`:167` surface-2/6px对称/80% → surface-hover/14-4px不对称/76%（§4.1）
- [ ] **.dc-btn primary（① 表）**：`:801` → `dc-btn default`（与 plugin spec 一致）
- [ ] **.ob-count rgba（④-5）**：`:307` → token
- [ ] **.appshell border（④-4）**：`:103` → 保留（demo 容器边界，可豁免）或注明
- [ ] **.cb-wrap border（④-4）**：`:355` → 去 border
- [ ] uppercase `:141/294/334` → normal-case（D7）
- [ ] ANSI log ⚠ `:703` 终端输出保留
- [ ] 验收：avatar/M15/M6/闭环/switch/composer 全部对齐

### L3.18 — v6-spec-tokens.html（L2.2 已覆盖大部分）
- [ ] L2.2 的骨架/z-index/§8 规则/header icon 在此完成
- [ ] 补充：文件头「与 demo 同一套 token」措辞修正
- [ ] 验收：见 L2.2

---

## Layer 4 · 文档 chrome 横切清理（D7）

> 目标：所有 spec 文档自身的 state-tag/anno 彩条/表头 uppercase 全部改 normal-case + 中性色标签。
> 原则：spec 文档不豁免 impeccable 禁令（D7）。
> 方法：跨文件统一扫描，每个文件的 chrome 元素集中改。
> 依赖：Layer 3 各文件结构修完。

### L4.1 — 统一 chrome 范式（新建文档说明或 design §3.6）
- [ ] design §3.6 新增「文档 chrome 规范」（L1.6 已含）：state-tag/compare-tag/anno 彩条/表头 用 normal-case + 中性色 + 轻 border（非彩色侧边条）

### L4.2 — 各文件 chrome 清理（横切扫描）
对每个 spec 文件执行：
- [ ] `.state-tag` uppercase → normal-case（sidebar:167/drawer:186/overlays:170/plugin:176/shell:171/settings 系列）
- [ ] `.compare-tag`/`.sep-tag`/`.cc-label`/`.sc-title` uppercase → normal-case（shell/tokens/plugin）
- [ ] 表头 `th` uppercase → normal-case（drawer:241 matrix-table/overlays:207 z-table/plugin:185/resources:105,1218/system-prompt:108,356/extension:169,444/max-demo:334）
- [ ] anno 彩条注释框 `border-left:2-3px` warn/danger → bg-soft 整块 + icon（drawer:1975/demo:29/plugin:466/max-demo:381/792/1160）
- [ ] `.console label`/`.decision-group label`（demo:124/135）uppercase → normal-case
- [ ] **provider `.j-decision`/`.j-success` warn/success 染底卡片（自查补）**：`:656-657` → 中性底或去染底（D7 chrome）
- [ ] demo `:545/550` 等 archive mixer 的 emoji 不在范围（archive 不改）
- [ ] **边界澄清（自查补 B-4.3）**：产品 UI uppercase 已在各 L3 文件单元清理（如 blocks tk-label、input model-group）；本 Layer 4 只扫文档 chrome（state-tag/表头/anno 彩条/染底卡片）。执行时若同文件已在 L3 改过 uppercase，Layer 4 只补该文件未覆盖的 chrome 元素，避免重复改
- [ ] 验收：全 spec grep `text-transform:uppercase` 零命中（产品 UI + chrome 都无）；grep `border-left:\s*[2-9]px` 在注释框零命中

---

## Layer 5 · v6-summary.md 修正 + 整体验收

> 依赖：Layer 1-4 全部完成。

### L5.1 — v6-summary.md 修正
- [ ] `:99` `--accent-ring: 0.5` → `0.30`（与 tokens SSOT + style.css 一致）
- [ ] `:258` 文件名 `v6-spec-drawer-tabs-demo.html` → `v6-drawer-tabs-demo.html`（实际文件名）
- [ ] `:148` `.btn svg 16×16` → 确认 shell 已补该规则（L3.1），summary 保留
- [ ] drawer 模型表述（§6.3）：按 D2 一体化更新
- [ ] tasks tab（§6.3 drawer tab 计数）：按 D3 移除更新（6→7 tab，删 tasks）
- [ ] 设置形态（§6.4）：确认全屏表述正确
- [ ] plugin（§6.6）：按 D4 补架构授权说明
- [ ] z-index（§3.3）：SearchModal=modal 1000（R12）
- [ ] composer focus（§4.1）：inset 单环 → 3px 外环（R1）
- [ ] block icon（§4.1 引用 design §4.1）：13→14px
- [ ] git M badge：补注 info 蓝
- [ ] ProviderEdit：嵌入式面板 → 展开就地编辑（R4）
- [ ] 列宽（§6.1）：仅 assistant → 整 turn 居中（R10）
- [ ] 验收：summary 全文与 design L1 + 各 spec 一致

### L5.2 — 跨文件一致性扫描
- [ ] **token 值**：grep 关键值在所有 spec 一致（accent-ring 0.30 / radius-sm 6 / hairline 0.04 / card 10px / content-max-w 720 / --radius-sm-old 删除）
- [ ] **设计决策反查**：v6-design 每条决策在对应 spec 都有唯一一致说法
- [ ] **骨架尺寸**：所有 spec `.page` 1320 / `.doc-sub` 820 / `.spec-desc` 860
- [ ] **状态点**：全 spec 7px（无 8/9/6）
- [ ] **圆角**：默认 6px、卡片 10px、浮层/composer 12px、pill 999px、无 3px/5px/8px 例外（popover 12）
- [ ] **选中态**：产品内「被选中」统一 §3.1/§3.2（bg-elevated/bg-surface+蓝字），accent-soft 只留瞬时高亮
- [ ] **倒计数**：drawer tab 7、plugin 闭环 5、demo M6 标未来

### L5.3 — impeccable 扫描
- [ ] 产品 UI 无 uppercase tracking-wider
- [ ] 文档 chrome 无 uppercase（D7）
- [ ] 无 emoji（产品 UI + spec chrome，终端输出/示意 SVG 豁免）
- [ ] 无 >1px 彩色侧边条（产品 UI + spec chrome 注释框，拖拽临时态豁免）
- [ ] 无嵌套卡片（静态容器 bg+border 双重分隔）
- [ ] 无无意义渐变（logo/avatar/装饰）
- [ ] 无硬编码色（应用 token，stage #131316 / 模拟外部网页 豁免）

### L5.4 — 对比度 + "面上面" 验收
- [ ] 正文位置全部过 WCAG AA（thinking expanded body neutral-mid，R9）
- [ ] bg-card 上辅助文字用 neutral-mid（非 dim）
- [ ] 主面板 surface 上的 pill/exit 标签/ChangeSetCard 升一档（bg-elevated/surface-2），肉眼可见

### L5.5 — visual-modernization-2026-07.md 同步（D9，自查补 B-3.2）
- [ ] 文件头标注「v6 状态：已被 v6-design.md（2026-07-31）追认/修订，本文件为 v6 视觉输入保留追溯」
- [ ] drawer 描述：原「Drawer·纯净」等若与 D2 一体化冲突 → 补注「v6 修订为一体化生长，见 v6-design §4.3」
- [ ] tasks/TurnRail 相关：补注「v6 已移除 tasks tab（D3）/ TurnRail 保留修范式（R5）」
- [ ] 验收：基线 A 与 v6-design 无方向性矛盾（允许基线 A 作为历史提案保留旧描述，但必须有追认/修订指引）

---

## 3. 349 条断言归属索引

每条审查断言都归入某个修复单元（无遗漏）。映射表：

| 审查断言范围 | 数量 | 归属修复单元 |
|--------------|------|-------------|
| 子报告 1 Tokens/Shell/Demo | 53 | L2.2(tokens) + L3.11(shell) + **L3.19(v6-demo)** + L1 |
| 子报告 2 对话流 | 69 | L2.1(base.css) + L3.7-L3.10(四文件) + L1 |
| 子报告 3 侧栏/Drawer | 53 | L3.12(sidebar) + L3.13(drawer，含 shadow 残留阻断) + L3.14(demo) + L1 |
| 子报告 4 Settings | 132 | L3.1-L3.6(六文件) + L1（i18n 由 L3.1 shell §9 承载）|
| 子报告 5 Overlays/Plugin | 42 | L3.15(overlays) + L3.16(plugin) + L3.17(max-demo) + L1 |
| 横切（chrome/对比度/一致性/SSOT 链） | — | L4 + L5 + **L1.7(README) + L1.8(design-system) + L5.5(visual-modernization)** |

### L3.19 — v6-demo.html（综合 demo，验收 SSOT 候选）
> 断言来源：子报告 1 demo 部分。默认态非目标态 + 多处违反 design。

- [ ] **默认态（最关键）**：`:684` `data-color="calm" data-density="lean"` → `semantic` + `legacy`（决策 #8/#9 目标态）
- [ ] `:582` CSS 语法错误 `padding: var(--space-3); var(--space-4);` → `padding: var(--space-3) var(--space-4);`
- [ ] 删 Overview 视图 + 侧栏入口（`:702/771/1038-1054`，§4.4 DEPRECATED）
- [ ] settings 改全屏覆盖（`:595-598` modal → 全屏，D1）
- [ ] traffic-light top `:168` 18→26px
- [ ] app-shell gap `:154` 8→12px；radius `:155` 12→10px
- [ ] main-panel `:271-275` 补 border+shadow（或两文件统一去掉，建议补齐对齐 shell）
- [ ] seg-tabs 容器 `:207` 8→12px（§3.1）
- [ ] terminal `:560` #000 → bg-input
- [ ] brand-logo `:174` / avatar `:265` 渐变 → 纯色 bg-accent
- [ ] list-group-head `:229` / cmd-group-head `:636` uppercase → normal-case
- [ ] todo-verify `:557` 8px → 9px、去 bg
- [ ] settings-card `:612` radius-lg(12) → 10px；settings-nav `:599` 200→220px
- [ ] drawer-head `:417-418` border-b → bg-surface-2 浮起
- [ ] panel-header `:276-280` 补 bg-elevated
- [ ] drawer-tab.on `:426` accent-soft → bg-elevated（R15）
- [ ] ask-opt:hover `:653` rgba(255,255,255,0.04) → bg-surface-hover token
- [ ] pill-ico `:328` 11px → 12px（scale）
- [ ] btn-primary/btn-ghost `:179-194` 自写 → 改用 .btn SSOT（或注明 demo 用）
- [ ] **"面上面"**：tm-pill `:325` / exit-tag `:375` / change-set `:379` bg-surface → bg-elevated（main-panel 是 surface）
- [ ] 验收：demo 首屏 == design 目标态（semantic+legacy，全屏设置，无 Overview，traffic 26px）

---

## 4. 依赖图与执行顺序

```
Layer 0  裁决（D1-D11 已定；R1-R26 已给推荐，审计划批量确认）
   ↓
Layer 1  SSOT（v6-design.md L1.1-L1.6 串行同文件；L1.7 README + L1.8 design-system 可并行）
   ↓
Layer 2  共享基建（L2.1 base.css 阻塞对话流四文件；L2.2 tokens 稿）
   ↓                    ↓
Layer 3  各文件集中修一次（19 个单元，可并行不同文件）
   ├─ L3.1-L3.6  Settings 六文件（依赖 L1，可并行；L3.1 先因 L3.2 删旧文件）
   ├─ L3.7-L3.10 对话流四文件（依赖 L2.1 base.css）
   ├─ L3.11 shell + L3.19 demo（依赖 L1）
   ├─ L3.12 sidebar + L3.13 drawer + L3.14 drawer-demo（依赖 L1；L3.13 shadow 残留是 D2 阻断项）
   ├─ L3.15 overlays + L3.16 plugin + L3.17 max-demo（依赖 L1）
   └─ L3.18 tokens（依赖 L2.2）
   ↓
Layer 4  文档 chrome 横切（所有 spec，依赖 L3）
   ↓
Layer 5  summary 修正 + 验收（依赖 L1-L4）
```

**关键路径**：Layer 0 裁决 → L1 SSOT → L2.1 base.css → L3.7-3.10 对话流 → L4 chrome → L5 验收。

**并行机会**：
- Layer 3 不同文件可并行（Settings 组 / 对话流组 / shell+demo 组 / sidebar+drawer 组 / overlays+plugin 组，5 组并行）
- Layer 4 chrome 清理可与 Layer 3 同文件合并（若同文件已在 L3 修改，chrome 顺手改）

**subagent 派发建议**（≤5 并发）：
1. worker A：L3.1 settings-shell + L3.2 删旧 + L3.3 provider（Settings 结构组）
2. worker B：L3.7-3.10 对话流四文件（依赖 L2.1，可同一 worker 串行）
3. worker C：L3.11 shell + L3.19 demo
4. worker D：L3.12 sidebar + L3.13 drawer + L3.14 drawer-demo
5. worker E：L3.15 overlays + L3.16 plugin + L3.17 max-demo

L1 SSOT + L2 共享基建由主 agent 自己做（决策密集，不宜委托）。

---

## 5. 工作量估算

| Layer | 任务数 | 性质 | 估时 |
|-------|--------|------|------|
| 0 裁决 | 26 R 项 + 11 D 项 | 决策 | 用户审计划 |
| 1 SSOT | 8 | v6-design.md + README + design-system.md | 0.5 天 |
| 2 共享基建 | 3 | base.css 抽取 + tokens 修正 | 1.5 天（base.css 抽取是大头） |
| 3 各文件 | 19 | spec 修复（18 单元 + v6-demo） | 5 天（并行可压到 2.5 天） |
| 4 chrome 横切 | 2 | 跨文件扫描 | 0.5 天 |
| 5 验收 + visual-modernization | 5 | summary + 扫描 + 基线同步 | 0.5 天 |
| **合计** | **62** | | **8 天（并行 ~5 天）** |

---

## 6. 与旧 plan 的差异（为何重新设计）

| 维度 | 旧 plan（v6-review-action-plan） | 新 plan（本文件 rev2） |
|------|----------------------------------|------------------|
| 分层逻辑 | 按视图分阶段（Settings/对话流/Drawer...） | **按根源分层**（裁决→SSOT→基建→文件→chrome→验收） |
| 同文件改几次 | settings shell 在阶段 1+3 各改一次 | **每文件集中修一次**（Layer 3） |
| 漂移处理 | 抽 base CSS 列为子任务 | **Layer 2 独立基建层**，阻塞对话流 |
| 待确认项 | 列在"范围外" | **R1-R26 推荐方案**，审计划批量确认 |
| 文档 chrome | 提一句"建议严于律己" | **D7 独立 Layer 4**，横切贯穿 |
| 断言覆盖 | 按"改进意见"条目（~50 条） | **349 条全量归属索引**（§3）+ 自查补缺 |
| 依赖图 | 模糊 | **明确关键路径 + 5 组并行** |
| **自查修订（rev2）** | — | **补 4 阻断缺口**（drawer shadow 残留/tab 计数/选中态三范式/SSOT 链文档）+ **覆盖遗漏**（bn-fullcontent/thinking expanded/cd-inline-code/M8 字体/魔数等）+ **D8-D11 新裁决** + **R23-R26** |

---

## 7. 决策状态（rev3 全部已定）

**所有阻断项 + 独立决策项均已裁决**：

| 决策项 | 裁决 | 落地位置 |
|--------|------|---------|
| D1-D7 首轮 | 见 §0 | 各 L 单元 |
| D8-D11 自查补 | 见 §0 | L1.5/L1.6/L1.7/L1.8/L3.x |
| **GitPanel MVP 三功能** | **进 v6-design 决策表（补 #16）** | L1.3 补 #16；L3.13 anno 标「已授权」 |
| **sd-unread + 1:1 宽度比** | **保留并回写 design** | L1.1/L3.13 回写 §4.3 |
| **v6-demo 验收地位** | **保留作验收 SSOT**（配合 spec 群双保险） | L3.19 + L5.2/L5.3 验收 |
| **形态 B 数据模型重构** | **登记阶段 B 衔接点**（spec 仅保留视觉态） | L1.3 §9 标注 + L3.13 anno |

**剩余唯一待办**：**R1-R26 批量确认**（§1 表格）—— 标 ✏️ 的推荐值，审计划时调整。确认后即可进入 Layer 1 执行。
