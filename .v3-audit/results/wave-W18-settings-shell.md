# Wave W18 (A-ST-S) · Settings Modal 骨架审查结果

> 审查日期：2026-06-21
> 层级范围：L2-L3 · Settings
> 锚点数：7
> 设计来源：`settings/spec.md` + `draft-settings-shell.html`
> 实现源：`src-electron/renderer/src/components/settings/SettingsModal.vue`

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| ST-L2-01 | L2 | Settings.SettingsModal | Modal 形态：居中 + backdrop blur(10px)，~900×540px | ⚠ | settings/spec.md §1 + §2 | SettingsModal.vue:14-18 | 孤立 |
| ST-L2-02 | L2 | Settings.SettingsModal | 结构：.modal-head → .modal-body（左nav ~190px + 右detail） | ⚠ | settings/spec.md §2 | SettingsModal.vue:19, 24-42 | 孤立 |
| ST-L2-03 | L2 | Settings.SettingsModal | 三布局模式：A Row / B Card / C Entity List | ❌ | settings/spec.md §3 | SettingsModal.vue:44-49 | 根因关联→RC-01 |
| ST-L2-04 | L2 | Settings.SettingsModal | 内置搜索：跨菜单搜 + 下拉匹配 + menu tag | ❌ | settings/spec.md §5 | SettingsModal.vue:20-23（sr-only） | 根因关联→RC-01 |
| ST-L2-05 | L2 | Settings.SettingsModal | 自动保存：debounce 800ms + 状态 pill | ❌ | settings/spec.md §5 | SettingsModal.vue:20（未出现） | 根因关联→RC-01 |
| ST-L2-06 | L2 | Settings.SettingsModal | 导航↔详情联动 | ✅ | settings/spec.md §6 | SettingsModal.vue:28-42, 66-71 | — |
| ST-L2-07 | L2 | Settings.SettingsModal | 与 Overview 区分（居中 modal vs 全屏鸟瞰） | ✅ | settings/spec.md §1 | SettingsModal.vue:1-8（注释）+ 14-18 | — |

**判定分布**：✅ 2 / ⚠ 2 / ❌ 3 / 🆕 0

---

## 二、条目详情卡

### ST-L2-01 · Modal 形态：居中 + backdrop blur(10px)，~900×540px

- **层级位置**：L2 · Settings.SettingsModal · 容器形态
- **设计要求**：居中 modal + 模糊背景（backdrop blur 10px），宽 ~900px / 高 ~540px；关闭恢复 workspace 原状态（settings/spec.md §1 §2）
- **实现现状**：使用 shadcn Dialog + DialogContent 实现 modal 效果（SettingsModal.vue:14-18）。`max-w-[900px]` 匹配 spec 宽度 ✅。但无显式高度（无 `h-[540px]`），依赖内容撑高。DialogOverlay 使用 shadcn 默认 `bg-black/80`（ui/dialog/DialogContent.vue:24），**无 `backdrop-filter: blur(10px)`**。居中由 shadcn 内置 `-translate-x-1/2 -translate-y-1/2` 保证 ✅。关闭恢复由 Radix Dialog 处理 ✅
- **判定**：⚠ 偏差
- **差异描述**：三个维度两好一差——宽度 900px 正确、居中正确，但 (1) 无显式高度 540px（当前靠内容撑高，实际渲染远不到 540），(2) 背景遮罩无 blur——spec 明确要求 "backdrop blur(10px) + 半透聚层"，当前实为纯黑半透 `bg-black/80`
- **设计证据**：> spec §1："形态：居中 **modal + 模糊背景**（backdrop blur），浮于 workspace 之上"；> spec §2："modal 宽 ~900px / 高 ~540px，居中；背景 backdrop `blur(10px)` + 半透聚层"
- **实现证据**：`SettingsModal.vue:16` — `class="flex max-w-[900px] ..."`（无高度）；`ui/dialog/DialogContent.vue:24` — `class="fixed inset-0 z-50 bg-black/80 ..."`（无 blur）
- **初步根因**：孤立。高度由 5 菜单实体内容撑开（DEFERRED），当前空壳自然矮——等实体填充后高度可达 540px；backdrop blur 是 shadcn 默认样式覆盖问题，非架构缺陷
- **修复性质**：短期方案 — 在 SettingsModal 的 DialogOverlay 上加 `backdrop-blur-md`（或调整 shadcn DialogOverlay 基类）；高度暂不设死，等实体内容填充后实测再定

---

### ST-L2-02 · 结构：.modal-head → .modal-body（左nav ~190px + 右detail）

- **层级位置**：L2 · Settings.SettingsModal · 页面结构
- **设计要求**：`.modal-head` 含"设置"标题 + 内置搜索(⌘K) + 保存状态 pill + ✕ 关闭 → `.modal-body` 含左 ov-nav（~190px）+ 右 ov-detail（scroll）（settings/spec.md §2）
- **实现现状**：无显式 `.modal-head` 结构——标题内容由 shadcn `DialogHeader`/`DialogTitle` 提供但设为 `sr-only`（SettingsModal.vue:20-23），保存 pill/搜索均未出现。关闭按钮 ✕ 来自 shadcn DialogContent 内置（DialogContent.vue:42-45），位于 `absolute right-4 top-4`。左导航用 `nav` 元素实现，宽度 `w-[200px]`（vs spec ~190px，基本吻合 ✅）。右详情含 `page-header`（标题 + 描述）✅ + 空壳占位（SettingsModal.vue:44-49）
- **判定**：⚠ 偏差
- **差异描述**：关键缺失——(1) 无 `.modal-head` 结构层，搜索框/保存 pill 槽位缺失（两者 DEFERRED）、关闭按钮未按 spec 归入 modal-head 而由 shadcn 浮层绝对定位提供（视觉位置偏离 spec "✕ 在 modal-head 右" 而非 Dialog 右上角）；(2) 左导航 200px vs 190px，差异可接受。优点——右 detail 的 page-header 结构正确，左 nav + 右 detail 的双栏布局正确
- **设计证据**：> spec §2："`.modal-head : 设置 + 内置搜索(⌘K) + 保存状态 pill | ✕`"；"`.modal-body : .ov-nav(左 ~190px) + .ov-detail(右 scroll)`"
- **实现证据**：`SettingsModal.vue:20-23` — DialogHeader sr-only（搜索/保存 pill 缺失）；`SettingsModal.vue:24, 33-49` — 左 nav w-[200px] + 右 detail（page-header + 空壳）；`ui/dialog/DialogContent.vue:42-45` — ✕ 按钮 absolute right-4 top-4（非 modal-head 内）
- **初步根因**：孤立。`.modal-head` 的三个子部件中搜索和保存 pill 均为 DEFERRED，仅余 ✕ 按钮——若单独建立 modal-head 只放一个 ✕ 反而浪费结构槽位，v1 委托 shadcn 是合理最短路径
- **修复性质**：长期方案 — 等搜索(G-021)/保存(RC-01 解除后)就绪时，统一建立 `.modal-head` 容器，将 ✕ 按钮从 shadcn 绝对定位迁入

---

### ST-L2-03 · 三布局模式：A Setting Row / B Setting Card / C Entity List

- **层级位置**：L2 · Settings.SettingsModal · 布局模式复用层
- **设计要求**：三套可复用布局模式——A Setting Row（标签左+控件右+帮助文字下，用于单值配置）、B Setting Card（Card 包多个语义相关 Row，用于分组）、C Entity List（每行一实体+来源/版本 pill+状态点+开关+展开配置，用于 Provider/Extension/Agent/Skill）。5 菜单页只是这三种的组合差异（settings/spec.md §3）
- **实现现状**：三模式均 DEFERRED。右详情区仅显示空壳文案 "配置项待联调阶段实现" 和 "三模式（G3-002 DEFERRED）"（SettingsModal.vue:44-49）。无任何 Setting Row/Card/Entity List 组件
- **判定**：❌ 缺失
- **差异描述**：这是 Settings 的核心公共特质层——所有 5 菜单页依赖这三种模式的复用。spec §3 将三模式定义为"公共特质的核心"，并说明 80% 场景用 A 模式。v1 完全未实现三模式的任何布局原语，导致 5 菜单只能空壳占位
- **设计证据**：> spec §3 — 完整的三模式表格（A/B/C 含形态、用于、80% 场景、控件原语派生要求）；> spec §3 末尾："控件原语全部从 `design-system.md` 派生（Toggle/Input/Select/Segmented/Pill/Status Dot），禁止各稿自造"
- **实现证据**：`SettingsModal.vue:46-49` — 占位文案 + "三模式（G3-002 DEFERRED）"
- **初步根因**：`根因关联→RC-01` — settingsStore 不存在。三模式的 A Row 和 B Card 均需读取 settingsStore 中的 theme/locale/配置字段才能渲染表单控件值。三模式组件本身（布局）可以先做，但它们的实例化内容必须绑定 store 数据源
- **修复性质**：长期方案 — 三模式组件可在 RC-01 解决前先行实现（作为无数据耦合的 prop-drive 纯布局组件），数据绑定在 RC-01 解决后接管。关联 W19（A-ST-W2，5 菜单详细内容）

---

### ST-L2-04 · 内置搜索：跨菜单搜设置项 → 下拉匹配 → 切菜单高亮

- **层级位置**：L2 · Settings.SettingsModal · 公共横切功能
- **设计要求**：⌘K 唤起内置搜索，跨菜单搜设置项 → 下拉匹配列表（带菜单 tag）→ 点选切到该菜单并高亮对应行（settings/spec.md §5）
- **实现现状**：DEFERRED。无明显搜索输入框（DialogHeader sr-only，SettingsModal.vue:20-23）。无下拉匹配列表。无菜单高亮联动
- **判定**：❌ 缺失
- **差异描述**：公共横切功能完全未实现。注意——Settings 内置搜索 ⌘K 与全局搜索 ⌘K（W15 SearchModal）是两套不同的搜索系统（前者搜当前 Settings 菜单内的设置项，后者全局搜项目资源），需避免快捷键冲突
- **设计证据**：> spec §5："内置搜索：跨菜单搜设置项 → 下拉匹配列表（带菜单 tag）→ 点选切到该菜单并高亮行。⌘K 唤起"
- **实现证据**：`SettingsModal.vue:20-23` — DialogHeader sr-only，无搜索输入；全文无搜索/过滤逻辑
- **初步根因**：`根因关联→RC-01` — 跨菜单搜索的索引数据（所有 5 菜单的设置项字段名/标签/所属菜单）均需从 settingsStore 的 schema/reactive state 派生。store 不存在，搜索无数据源。W15 SearchModal 的 ⌘K 快捷键与 Settings 内置搜索 ⌘K 存在冲突风险（两者都绑 ⌘K），需协调快捷键上下文
- **修复性质**：长期方案 — RC-01 解决后，从 settingsStore schema 生成搜索索引再实现搜索 UI。快捷键冲突协调：Settings 打开时 ⌘K 临时重定向到内置搜索，闭后恢复全局搜索

---

### ST-L2-05 · 自动保存：debounce 800ms + 状态 pill

- **层级位置**：L2 · Settings.SettingsModal · 公共横切功能
- **设计要求**：自动保存 debounce 800ms；右上角状态 pill（"已保存"/"保存中…"），无显式 Save 按钮（settings/spec.md §5）
- **实现现状**：DEFERRED。无状态 pill UI，无 debounce/保存逻辑，无任何数据读写管道
- **判定**：❌ 缺失
- **差异描述**：自动保存是 Settings 的数据写入机制——无此机制，所有表单控件的用户修改无法持久化。spec 明确禁止显式 Save 按钮，必须靠 debounce 自动保存
- **设计证据**：> spec §5："自动保存：debounce 800ms；右上角状态 pill（`已保存` / `保存中…`）。无显式 Save 按钮"
- **实现证据**：`SettingsModal.vue` 全文无 save/debounce/pill 相关代码或 UI
- **初步根因**：`根因关联→RC-01` — 这是 RC-01 的直接因果链：自动保存的目标是 settingsStore，store 不存在 → 保存逻辑无写入目标、状态 pill 无读取源
- **修复性质**：长期方案 — RC-01 解决后，通过 Pinia watch + debounce 实现。状态 pill 作为独立 Slot 组件挂在 SettingsModal 右上角

---

### ST-L2-06 · 导航↔详情联动（切菜单换面板）

- **层级位置**：L2 · Settings.SettingsModal · 骨架级交互
- **设计要求**：左侧 5 菜单导航与右侧详情面板联动，切菜单时右面板切换对应表单（settings/spec.md §6）
- **实现现状**：**已实现** ✅。5 菜单左导航用 `Button` 渲染（SettingsModal.vue:28-42），`@click="activeMenu = item.id"` 切换当前菜单。选中态使用 `inset accent ring`（`ring-1 ring-inset ring-accent`）+ `bg-surface-hover` ✅，非选中态 `text-muted`。右详情通过 `computed` 联动 `currentMenu.label` + `currentMenu.desc` 实时更新（SettingsModal.vue:33-42, 66-71）
- **判定**：✅ 一致
- **差异描述**：骨架级联动正确——切 Provider↔Skill↔Agent↔Extension↔System 时右 panel 的 page-header（标题 + 描述文字）跟随切换。选中态设计正确使用 inset accent ring 而非旧版左竖条（符合 spec 强调的 "禁左竖条"）
- **设计证据**：> spec §6："导航 ↔ 详情联动（切菜单换面板）"；> spec §2：".ov-detail : page-header(菜单名 + 一句定位)"
- **实现证据**：`SettingsModal.vue:28-42` — nav `@click="activeMenu = item.id"` + 选中态 ring-1 ring-inset ring-accent；`SettingsModal.vue:33-42` — 右 page-header `currentMenu.label` + `currentMenu.desc`
- **初步根因**：N/A（无问题）
- **修复性质**：N/A

---

### ST-L2-07 · 与 Overview 区分

- **层级位置**：L2 · Settings.SettingsModal · 架构边界
- **设计要求**：Settings 是居中 modal + backdrop blur（表单交互取向），Overview 是全屏鸟瞰（数据呈现取向）。两者形态和取向都不同（settings/spec.md §1）
- **实现现状**：**已正确区分** ✅。SettingsModal 使用 shadcn Dialog 实现居中 modal 浮层（非全屏覆盖），模板注释明确标注 "取向 = 配置/表单交互，区别于 Overview 的鸟瞰（spec §1）"（SettingsModal.vue:2-3）。无任何全屏覆盖逻辑或 Overview 风格的残留
- **判定**：✅ 一致
- **差异描述**：架构边界清晰——Settings 是 overlay 级 modal（不替换任何 Region），Overview 是独立 L1 Region（覆盖 main 区）。SettingsModal 完全满足此边界
- **设计证据**：> spec §1："与 Overview 分工：Overview = 全屏鸟瞰（数据呈现）；Settings = 居中 modal（表单交互）。两者形态 + 取向都不同"
- **实现证据**：`SettingsModal.vue:1-8` — 注释声明 modal 定位 + 取向区分；`SettingsModal.vue:14-18` — Dialog 居中浮层（非全屏）
- **初步根因**：N/A（无问题）
- **修复性质**：N/A

---

## 三、Wave 小结

- **审查条目数**：7（✅ 2 / ⚠ 2 / ❌ 3 / 🆕 0）
- **常规条目数**：3（ST-L2-01/02/03 — 形态/结构/三模式均为已知 v1 范围划定）
- **根因关联数**：3（ST-L2-03/04/05 均关联 RC-01；无 RC-02/RC-04 直接关联于当前骨架——System 菜单内容属 W19）
- **新独立问题数**：1（ST-L2-01 backdrop blur 缺失 — shadcn 默认叠加层样式与 spec 的 `blur(10px)` 不一致）
- **偏差条目数**：2（ST-L2-01 形态三缺一，ST-L2-02 .modal-head 缺失）

**总体评价**：SettingsModal v1 骨架做到了两件正确的事——(1) 导航↔详情联动骨架正确、选中态 inset accent ring 正确禁用左竖条；(2) 架构边界区分 Settings vs Overview 清晰。其余三个 DEFERRED 条目（三模式/搜索/自动保存）均牵连 RC-01（settingsStore 不存在），属 v1 范围内的合理预留。

**RC-01 关联明细**：

| 条目 | 关联方式 |
|------|---------|
| ST-L2-03 | 三模式的 A Row/B Card 表单值需要从 settingsStore 读取 + 写回，store 不存在导致模式实例化内容（theme/locale/data）全空 |
| ST-L2-04 | 内置搜索的索引需要从 settingsStore schema 派生所有菜单的设置项字段名/标签，store 不存在则无索引数据 |
| ST-L2-05 | 自动保存的目标就是 settingsStore，store 不存在 → 写操作无目标、状态 pill 无读取源 |

**跨 wave 依赖提示**：
- **W19 (A-ST-W2)** — 5 菜单详细内容，直接依赖本 wave 的三模式和 store 就绪。ST-L2-03 的三模式布局可在 RC-01 解决前先行实现为纯布局组件（无数据耦合），为 W19 铺路
- **W15 (A-OL-W1)** — Settings 内置搜索 ⌘K 与全局搜索 ⌘K 冲突需协调：建议 Settings 打开时 ⌘K 临时重定向到内置搜索，闭后恢复全局搜索
