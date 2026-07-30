# 视觉现代化设计规范 · 柔和现代（2026-07）

> 日期：2026-07-30
> 状态：提案（待评审 → 分波实施）
> 关联 demo：[`../ui-style-mixer-2026-07-30.html`](../ui-style-mixer-2026-07-30.html)（分区风格组合器）
> 依据：竞品 UI 调研（Codex / Claude / OpenCode / Trae Work / WorkBuddy）+ xyz-agent 现状截图对比分析
> 选定方案：**组合① 柔和现代**（侧栏·纯净层级 + 对话流·居中降噪 + Drawer·纯净 + 设置·modal 改良）；组合② 紧凑专业作为可选密度档预留

---

## 1. 背景与目标

### 1.1 问题诊断（竞品分析结论）

xyz-agent 的设计系统工程化程度不弱于竞品（token SSOT、10 主题预设、20 波视觉验收），但观感「不够现代、不够简洁」。根因不是色相，而是五个「克制」缺失：

| # | 杠杆 | 现状 | 竞品标杆 |
|---|------|------|----------|
| 1 | 圆角尺度 | `--radius-sm: 3px` 为默认档，方、硬、工程面板感 | Codex/Claude/Linear 默认 8–16px |
| 2 | 分隔方式 | 静态信息容器普遍 `border + bg` 双重分隔，满屏 hairline | 背景明度层级分隔，边框只留可交互容器 |
| 3 | 灰度分布 | 大面积 `--neutral-dim`（绝对路径/参数/时间戳），整屏中等灰 | 正文亮、meta 少而淡 |
| 4 | 列宽留白 | 对话流无 `max-width`，宽屏一行 2000+px | 内容列 640–760px 居中 |
| 5 | 彩色克制 | 大绿勾/警示三角/紫思考/蓝选中高密度共存 | 彩色只给真正需要注意的对象 |

### 1.2 目标

在**不改色相体系**（冷蓝暗色 `--bg #1a1b1f` / `--accent #4f8ef7` 及全部现有 token 值域）的前提下，通过圆角、分隔策略、灰度、列宽、彩色密度五项调整，使整体观感达到 Codex/Claude 级别的「现代简洁」，同时**完整保留** xyz 的差异化优势：turn meta pills、结构化 trace 流、变更集卡片、侧栏四 tab。

### 1.3 非目标（明确不做）

- ❌ 不换底色/主色色相，不重做亮色主题校准
- ❌ 不做「结论优先」对话流塌缩（mixer `st-v3`，过程透明度下降，作为长期方向另行评估）
- ❌ 不做设置全页化（mixer `set-v3`，改动面大，作为后续独立提案）
- ❌ 不动 shell 拓扑（traffic light 安全区、float-panel 体系，见 `v3/shell/spec.md`）
- ❌ 不动任何功能逻辑/事件流/WS 协议（纯表现层改造）

---

## 2. 关联 HTML 与方案映射

demo 文件：`docs/page-design/ui-style-mixer-2026-07-30.html`。每个区域可独立切换变体，本规范选定项如下：

| 区域 | demo 变体 | 名称 | 本规范章节 |
|------|-----------|------|-----------|
| 侧栏 | `sb-v2` | 纯净层级 | §5.1 |
| 对话流 | `st-v2` | 居中降噪 | §5.2 |
| 右侧 Drawer | `dr-v2` | 纯净 | §5.3 |
| 设置页 | `set-v2` | modal 改良 | §5.4 |

**验收用 hash 直达**：

| 用途 | URL hash |
|------|----------|
| 目标态·主界面 | `#sb2-st2-dr2` |
| 目标态·设置页 | `#viewsettings-set2` |
| 现状对照·主界面 | `#sb1-st1-dr1` |
| 现状对照·设置页 | `#viewsettings-set1` |
| 密度档（组合②，预留） | `#sb3-st4-dr2` |

视觉验收以 demo 目标态为基准（per AGENTS.md 视觉验收惯例，逐波截图对照）。

---

## 3. 总体风格定义

**一句话**：冷蓝暗色不变，「层级代替边框、圆角升档、正文提亮、内容收窄、彩色退场」。

五条设计原则（后续所有组件改造的裁决依据）：

1. **层级代替边框**：静态信息容器（bash 块、变更集、设置卡片、chip）只用一个表面色（`--surface`/`--bg-input`），不叠加 1px 边框。现有层级间距（2026-07-12 校准，相邻 ≥Δ5）已保证肉眼可辨，边框是冗余的双重分隔。边框仅保留给：**浮起可交互容器**（popover、dialog、composer）和 **focus 态**。
2. **圆角升档**：默认档 3px → 6–8px；卡片 8–10px；浮层/composer 12px；徽章/状态标签全部胶囊（999px）。
3. **正文提亮、meta 减量**：`--neutral-dim` 提亮一档；工具行参数从「全绝对路径」改为「文件名加亮 + 灰色限定词」，全路径收到 hover tooltip。
4. **内容列收窄**：对话流内容列 `max-width: 720px` 居中；行长恒定 60–90 字符，宽屏两侧留白。
5. **彩色降噪**：状态指示极小化（15px 图标 → 6–7px 圆点）；`exit≠0` 不再用警示色，中性化表达；状态色只保留给：真正失败的块（danger）、待审/进行中等需要行动的状态（accent/info）。

---

## 4. Token 变更（`design-tokens.md` + `style.css` + `tailwind.config.ts`）

### 4.1 圆角（修订）

| Token | 现值 | 改为 | 影响面 |
|-------|------|------|--------|
| `--radius-sm` | `3px` | `6px` | kbd、tag、小按钮、chip —— 全局默认档升档 |
| `--radius` | `8px` | 不变 | 按钮/卡片默认 |
| `--radius-lg` | `12px` | 不变 | 面板/弹层/composer |

`tailwind.config.ts borderRadius.sm` 同步 `3px → 6px`。

> ⚠️ `--radius-sm` 是全库默认档，改动后需全量视觉走查 `rounded-sm` 消费点（约 60+ 处，集中在 sidebar/settings/message-stream）。3px 不再作为任何组件的默认值；确需更小的场景（如 1px 行内标记）用任意值，不回退 token。

### 4.2 文字灰度（修订一档）

| Token | 现值 | 改为 | 理由 |
|-------|------|------|------|
| `--neutral-dim` | `#6b7280` | `#7d8494` | 提亮一档（对比度只升不降，WCAG AA 仍满足），配合「使用面积减少」消除灰蒙蒙感 |

`--neutral-fg` / `--neutral-mid` / `--neutral-faint` / `--neutral-ico*` 不变。

### 4.3 diff 着色（柔化）

| Token（tailwind 派生） | 现值 | 改为 |
|------------------------|------|------|
| `diff-add-bg` / `diff-del-bg` | color-mix 18% | color-mix **12%** |
| `diff-add-strong` / `diff-del-strong` | color-mix 45% | 不变（字符级精度层保留辨识度） |

现状 18% 行背景在长 diff 下视觉噪声大；12% 与状态色 soft 基准（12%）对齐。对应 mixer `dr-v2` 的柔化效果。

### 4.4 组件尺寸（新增一行）

| Token | 值 | 用途 |
|-------|-----|------|
| `--content-max-w` | `720px` | 对话流内容列宽（MessageStream 内层容器、非 landing 态 Composer 对齐同列） |

沿用「组件尺寸」节既有模式（`--bash-output-max-height` / `--composer-btn-size` 同级）。

### 4.5 不新增色彩 token

本次所有效果用现有 token 组合达成（`--surface`/`--surface-2`/`--bg-input`/`--accent-soft`/`--accent-ring` + 状态色 soft）。侧栏选中态的左缘指示条直接用 `--accent`，状态圆点用 `--success`（90% opacity），不引入新色。

---

## 5. design-system.md 变更 + 组件改造清单

### 5.0 design-system.md 条文修订

| 章节 | 现状条文 | 改为 |
|------|----------|------|
| §2 卡片族·Card | 背景 `--surface` + 边框 `--border` | **默认无边框**，仅 `--surface` 层级；边框仅浮起可交互容器使用。新增「双重分隔反模式」条文：静态信息容器禁止 border+bg 叠加 |
| §2 卡片族·Card-Inline | `--surface` + `--border` + `--radius` | `--surface`（或 `--bg-input` 凹陷语义）+ 无边框 + `--radius` |
| §2 卡片族·Card-Active | 整圈 `inset 0 0 0 1px accent-ring` | 拆两种场景：**列表项激活**（侧栏 SessionItem 等）= `--surface` 底 + 左缘 2px `--accent` 指示条；**面板激活**（Panel active 等）= 维持 inset ring 不变 |
| §5 标签族 | Pill 圆角 999（条文已有，代码未落实） | 强制落地：turn meta pill、变更集 badge、状态标签全部 999 胶囊；`rounded-sm` 矩形标签仅保留 kbd/键帽场景 |
| §6 图标系统 | 状态图标用状态色填充 | 增补：工具失败（exit≠0）**不属于**状态色使用场景——中性图标 + mono `exit N` 小标签表达；danger 仅用于 agent 报错块/操作失败通知 |
| 新增 §11 分隔策略 | — | 层级 > 留白 > hairline > 边框的优先级序；每类容器只允许一种主分隔手段 |
| 新增 §12 内容列宽 | — | 对话流内容列 `--content-max-w` 居中；user bubble 右对齐 76% 不变；drawer/设置内容列可另行定义 |

### 5.1 侧栏（mixer `sb-v2` 纯净层级）

| 组件/文件 | 现状 | 改为 |
|-----------|------|------|
| `sidebar/SegmentedTab.vue` | 每 tab 独立边框盒（`border border-border`，active `border-border-strong bg-accent-soft`），3px 圆角 | 分段控件：外层容器 `bg-bg-input rounded-lg p-[3px]`，内项无边框，active `bg-bg-elevated text-neutral-fg`，6px 圆角 |
| `sidebar/SessionItem.vue` | 状态图标 15px+ 饱和绿 CheckCircle2（满屏大绿勾）；选中态整圈 accent ring | 状态 → 7px 圆点（done=success 90% / running=accent 脉冲 / waiting=warn / error=danger）；选中态 → `bg-surface` + 左缘 2px accent 条（§5.0 Card-Active 新范式） |
| `sidebar/Sidebar.vue` kbd | `border border-border-strong bg-surface rounded-sm` | 去 border，仅 `bg-surface` + 6px 圆角（kbd 保留小圆角矩形语义） |
| `sidebar/Sidebar.vue` 容器 | 右缘 `border-r border-border` | 去边框，侧栏底色微沉（`#191a1e`，即 `--bg` 降 ~2% 的派生，可用 `color-mix(in oklch, var(--bg) 97%, black)`，**不新增 token**，tailwind 注册为 `bg-sunken`） |
| `sidebar/SessionList.vue` / `ForkGroup.vue` / `SubagentList.vue` | 操作按钮（rename/delete 等）带 `border border-border-strong` 方盒 | 去 border，ghost 语义（透明底 + hover `bg-surface-hover`），与 design-system §3 Ghost 对齐 |

### 5.2 对话流（mixer `st-v2` 居中降噪）

| 组件/文件 | 现状 | 改为 |
|-----------|------|------|
| `panel/MessageStream.vue:16` | `px-5 pt-5` 全宽铺排，无列宽约束 | 内层包一列容器 `mx-auto max-w-[var(--content-max-w)]`（虚拟滚动 virtua 的 item 渲染在列容器内；滚动条仍贴右缘） |
| `panel/Composer.vue`（非 landing） | 全宽 + `border-strong` 常驻边框 | 与内容列同宽居中（`max-w-[var(--content-max-w)]`）；常驻态去边框仅 `bg-bg-input` + 1px `shadow-1` 描边，focus 态 `--accent-ring` |
| `panel/message-stream/Block.vue:143` bash 容器 | `border border-neutral-faint rounded-sm bg-surface-2`，cmd/out 间 `border-b` | 去 border：`bg-bg-input rounded-lg`，cmd/out 分隔改 `bg` 明度差（out 区叠 `rgba(255,255,255,.02)`） |
| `panel/message-stream/Block.vue` 工具行参数 | 全量绝对路径（`/Users/.../file`），`--neutral-dim` | **文件名加亮（`--neutral-mid`）+ 灰色限定词**（所在目录 basename 或动作摘要），全路径移 hover `title`；截断逻辑从「尾部截断」改「目录段省略」（`…/chat_project/AGENTS.md` → `AGENTS.md · chat_project`） |
| `panel/message-stream/block-icon.ts` + `Block.vue` failed 分支 | `status==='error'` → AlertTriangle + `--warn` 色（探测性命令满屏黄三角） | 删 failed 图标的 warn 着色：图标统一 `--neutral-ico`，exit≠0 在行尾加 mono `exit N` 小标签（`bg-surface` + `--neutral-dim`）；AlertTriangle + danger 仅保留给 agent 级 error 块 |
| `panel/message-stream/TurnMeta.vue` pills | `bg-surface-2` + 3px 矩形 | `bg-surface` + 999 胶囊（§5.0 §5 落地） |
| `panel/message-stream/ChangeSetCard.vue:10` | `rounded-md border border-border bg-bg` 双重分隔 + 矩形计数/徽章 | 去 border：`bg-surface` + 10px 圆角；「待审查」badge → 胶囊 `--accent-soft`；计数纯文字 `--neutral-dim` |
| `panel/message-stream/UserBubble.vue` | 现状已接近目标（76% 右对齐） | 仅圆角核对（保持 14px/4px 不对称气泡），不改结构 |
| `panel/PanelHeader.vue` chips | `border border-border rounded-sm bg-surface-2` | 去 border：`bg-surface` + 6px 圆角 |

### 5.3 右侧 Drawer（mixer `dr-v2` 纯净）

| 组件/文件 | 现状 | 改为 |
|-----------|------|------|
| `panel/SideDrawer.vue` 容器 | 左缘 `border-l` 分隔（贴右展开） | 去边框，改投影分隔（`box-shadow: -12px 0 24px rgba(0,0,0,.25)`），底色 `--bg` 微沉（同 §5.1 `bg-sunken`） |
| `panel/DetailPane.vue` header「预览/变更」切换 | 边框盒 tab（与 SegmentedTab 旧范式同族） | 分段控件（同 §5.1 新范式，复用 SegmentedTab 组件） |
| `panel/detail-renderers/DiffView.vue` | 行背景 18% 饱和；canvas 无圆角贴边 | 行背景 12%（§4.3 token 变更自动生效）；diff 画布 `bg-bg-input rounded-lg` + 上下 8px 内距，hunk header 去 `bg-surface-2` 仅 `--neutral-dim` 文字 |

### 5.4 设置页（mixer `set-v2` modal 改良）

| 组件/文件 | 现状 | 改为 |
|-----------|------|------|
| `settings/SettingsModal.vue` | modal 边框 + nav `border-r`；nav 选中态 `box-shadow inset accent ring` | modal 去边框仅 `shadow-2` + `0 0 0 1px rgba(255,255,255,.07)`；nav 选中态 `bg-surface`（与侧栏新范式一致）；nav 底色 `bg-sunken` |
| `settings/*Page.vue` 分组卡片（SystemPage/ProviderPage 等 10 页） | `rounded-md border border-border bg-bg` 双重分隔 | 去 border：`bg` 提升为 `color-mix` 派生面（≈ `#22242c`，注册 `bg-card`，不新增语义 token）+ 10px 圆角；行分隔 hairline 降为 `rgba(255,255,255,.04)` |
| `settings/SystemPage.vue` 设置行 | 仅 label，无描述 | **每行增加 12px `--neutral-dim` 描述文字**（label 下），i18n 新增 `*.desc` keys（中英双语）——先行试点「语言与外观/提示音」两节，其余页面后续波次补 |
| `settings/SystemPage.vue:78/83/119` | **i18n key 外露 bug**（`settings.system.soundTitle/successSound/errorSound`，locale 只有 `completionSound`） | P0 修复：zh-CN/en-US 补齐三 key（提示音/成功提示音/失败提示音 + 英文对应） |
| settings 内 Select/Toggle（xyz-ui） | select 带 border + 3px | select 去 border 仅 `bg-bg-input` + 8px 圆角；toggle 现状已是胶囊，仅核对色值 |

---

## 6. 密度档（组合② 紧凑专业，预留不实施）

mixer `#sb3-st4-dr2` 演示了同套现代化手段 + 高密度 scale（12–12.5px 正文、860px 列、6px 圆角）的效果。落地建议：本次只做舒适档（§4/§5 全部值）；密度档作为后续「外观 → 密度：舒适/紧凑」设置项另立提案，届时把 §4 的变更值抽成 `data-density` 作用域下的第二组 scale（圆角/字号/列宽三变量），不动结构。**本次代码改造时不得写死 720px/8px 等值在组件里**——必须走 token/utility，为密度档留切换口。

---

## 7. 实施波次与验收

| 波次 | 内容 | 验收 |
|------|------|------|
| W1 | §4 token 变更（style.css + tailwind.config.ts + design-tokens.md/design-system.md 文档同步）+ AGENTS.md 规范 #10（`rounded-sm(3px) 默认` 条文）同步修订 | 全量 `rounded-sm` 消费点视觉走查；`npm run lint` + vue_rules_checker 绿 |
| W2 | §5.2 对话流（MessageStream 列容器 + Block/bash/路径/exit + TurnMeta/ChangeSetCard + Composer/PanelHeader chips） | 对照 mixer `#sb1-st2-dr0` 截图验收；首屏冒烟模板（test-strategy.md）更新列宽断言 |
| W3 | §5.1 侧栏（SegmentedTab/SessionItem/Sidebar/各 List） | 对照 `#sb2-st1-dr0`；SessionItem 选中态四态（done/running/waiting/error）走查 |
| W4 | §5.3 Drawer（DetailPane/DiffView） | 对照 `#dr2`；diff 双主题（暗/亮）走查 |
| W5 | §5.4 设置（SettingsModal + 10 页卡片 + 描述文字试点 + i18n P0） | 对照 `#viewsettings-set2`；**i18n key 外露消失**为硬性验收项 |
| W6 | 全量视觉验收波（按 AGENTS.md 20 波惯例追加 1 波） | 三 hash 对照 + 亮色主题回归 |

每波独立 commit、独立视觉验收（per AGENTS.md「打包相关改动逐个 commit」同精神）；token 层（W1）必须先于组件层合入，组件层各波互不依赖可并行。

---

## 8. 文档同步清单（改造落地时必须一并更新）

- `docs/page-design/design-tokens.md`：§4 全部变更 + 变更日志行（沿用文件内既有日期标注格式）
- `docs/page-design/design-system.md`：§5.0 条文修订 + 新增 §11/§12
- `AGENTS.md`：前端编码规范 #10（圆角规则 `rounded-sm(3px) 默认` → 新值）、#12 等受影响条文
- `docs/standards.md`：圆角/边框相关条目
- 本文件归档后，mixer demo（`ui-style-mixer-2026-07-30.html`）保留作为验收基准，不删除
