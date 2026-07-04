# Wave W16 (B-OVS) · Overview/Overlays/Settings 多余/遗留审查

> **审查员**：W16 (B-OVS) 执行员（自底向上 · 独立多余视角）
> **审查范围**：Overview.vue / SessionCard.vue / SearchModal.vue / SettingsModal.vue
> **审查日期**：2026-06-21
> **设计来源**：overview/spec.md + overlays/spec.md + settings/spec.md
> **前序 wave**：W15 (Overlays)、W17 (Overview)、W18 (Settings 骨架)、W19 (Settings 菜单)
> **W01 全局根因**：RC-03（dropdown-menu 零引用）——本 wave 做第四次最终验证

---

## 零、前置结论：这些组件非常干净

4 个文件共 ~16.4KB 源代码，逐行审查后结论：**无未使用 import、无废弃代码、无死分支、无 shadcn 模板残留、无旧设计（Warm & Soft）残留。** 代码质量高于预期——骨架阶段能做到这个清洁度说明前期 wave 的规范约束生效了。

"多余"视角的发现集中在三类：
1. **零消费者孤儿组件**（SearchModal/SettingsModal 存在但无人挂载——W15/W18 已记入口缺失，此处从"多余"视角确认）
2. **休眠代码路径**（SessionCard 指标区——W17 已从消费者角度记了漏传 props，此处从生产者角度确认渲染分支休眠）
3. **RC-03 最终确认**（dropdown-menu 14 组件四次验证零引用）

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| OV-SC-EXTRA-01 | L3 | Overview.SessionCard | `hasMetrics` + 指标渲染分支休眠 | 🆕 | overview/spec.md §Session 卡片信息结构（指标区要求 addCount/delCount） | SessionCard.vue:43-48, 90 | 孤立 |
| OL-SM-EXTRA-01 | L1 | Overlays.SearchModal | 零消费者孤儿组件 | 🆕 | overlays/spec.md §归属与边界（Overlay 级独立组件） | SearchModal.vue（全文 3074B，零 import 引用） | 孤立 |
| ST-SM-EXTRA-01 | L1 | Settings.SettingsModal | 零消费者孤儿组件 | 🆕 | settings/spec.md §1（居中 modal + 模糊背景） | SettingsModal.vue（全文 4351B，零 import 引用） | 孤立 |
| ST-SM-EXTRA-02 | L3 | Settings.SettingsModal | `currentMenu` fallback `?? menus[0]` 不可达 | 🆕 | — | SettingsModal.vue:90 | 孤立 |
| ST-SM-EXTRA-03 | L2 | Settings.Plugins | Plugins 独立组件不存在 | 🆕 | settings/spec.md §决策记录（Plugins 第 6 菜单） | 全 renderer 目录无 *Plugin* 文件 | 孤立 |

**判定分布**：🆕 5（均为"多余"视角独有发现，不重复 W15/W17/W18/W19 的 ⚠/❌）

---

## 二、Plugins 独立组件确认专节（W19 提示）

### 搜索范围
```
find .../renderer/src/ -name "*Plugin*" -o -name "*plugin*"
```

### 结果：**零命中**

**全 renderer 源码树中不存在任何 Plugin 相关组件**。W19 推测的 `PluginsPane.vue` 和 `PluginSettingsForm.vue` 在 renderer 层不存在。

### 三重确认
1. 文件名搜索（`-name "*Plugin*"`）：零结果
2. 目录清单（`ls components/`）：overlays / overview / panel / settings / shell / sidebar / ui / workspace — 无 plugins 目录
3. 内容 grep（`grep -rn "plugin\|Plugin" components/settings/`）：零匹配

### 结论
Plugins 菜单**完全未实现**（不是"实现了但未接入导航"）。W19 ST-L3-06 "Plugins 独立菜单遗漏"的根因更精确：不是导航集成遗漏，而是**整个 Plugins UI 层从未在 renderer 中创建过**。修复需要从零构建 PluginsPane → 接入 SettingsModal nav 的第 6 插槽。

---

## 三、RC-03 第四次验证（dropdown-menu 零引用）

### 验证命令
```bash
grep -rn "from.*dropdown-menu\|from.*DropdownMenu\|import.*DropdownMenu" \
  src-electron/renderer/src/ --include="*.vue" --include="*.ts" \
  | grep -v "ui/dropdown-menu/"
```
**结果：零匹配**（exit code 1 = no matches found）

### 逐目录确认

| 目录 | 是否引用 dropdown-menu |
|------|----------------------|
| `components/overview/` | ❌ 不引用 |
| `components/overlays/` | ❌ 不引用 |
| `components/settings/` | ❌ 不引用 |
| `components/sidebar/` | ❌ 不引用（W02 已确认） |
| `components/panel/` | ❌ 不引用（W07 已确认） |
| `components/shell/` | ❌ 不引用 |
| `components/workspace/` | ❌ 不引用 |

**RC-03 结论**：四次验证（W02 → W07 → W16）一致确认——`ui/dropdown-menu/` 下 14 个组件在 renderer 全量代码中**零外部引用**。仅内部互引用（如 `DropdownMenuContent` import `DropdownMenuPortal` from reka-ui）。属于 shadcn 模板残留，可安全删除。

---

## 四、条目详情卡

### OV-SC-EXTRA-01 · SessionCard 指标渲染分支休眠

- **层级位置**：L3 · Overview.SessionCard · 指标区
- **设计要求**：overview/spec.md §Session 卡片信息结构 — 指标区包含"改动文件数 / 消息回合数 / 运行时长"
- **实现现状**：SessionCard 正确定义了 `addCount`/`delCount`/`turnCount` props（SessionCard.vue:74-84），指标区模板（:43-48）用 `v-if="hasMetrics"` 条件渲染 `FilePen` 图标 + `+N` `−M` 文本。但 Overview.vue 调用 SessionCard 时**从未传入 `addCount` 或 `delCount`**（Overview.vue:36-42），导致 `hasMetrics`（SessionCard.vue:90）**始终为 `false`**。
- **判定**：🆕 多余（休眠代码路径）
- **差异描述**：`hasMetrics` computed、`FilePen` 图标 import、指标区 `<span>` 共 ~8 行模板 + ~3 行逻辑 = **~11 行代码在当前运行时永远不可达**。代码本身正确——只要 Overview.vue 传入 `addCount` > 0 即刻激活——但当前处于休眠状态。
- **设计证据**：overview/spec.md — 指标区明确包含 `+N −M` 改动行数。draft-overview.html §2 — `<span class="add">+168</span><span class="del">-31</span>`
- **实现证据**：
  ```html
  <!-- SessionCard.vue:43-48 休眠分支 -->
  <span v-if="hasMetrics" class="flex items-center gap-1">
    <FilePen class="size-[11px]" />
    <span class="text-success">{{ addCount }}</span>
    <span v-if="delCount" class="text-danger">−{{ delCount }}</span>
  </span>
  ```
  ```html
  <!-- Overview.vue:36-42 未传 addCount/delCount -->
  <SessionCard
    :session="s"
    :active="s.id === session.activeId"
    :status="statusOf(s.id)"
    :summary="digestOf(s.id).summary"
    :turn-count="digestOf(s.id).turnCount"
    @open="onOpen"
  />
  ```
- **初步根因**：孤立 — `digestOf()` 的 `sessionDigest` composable 未计算 `addCount`/`delCount`（可能数据源未就绪 or 未被实现）。W17 OV-L3-02 已从消费者侧记录了 props 漏传，本条目从生产者侧确认渲染分支休眠。
- **修复性质**：短期方案 — 在 `sessionDigest` composable 中增加 `addCount`/`delCount` 派生字段（可先 mock 为 `Math.floor(Math.random()*500)`），Overview.vue 调用处加 `:add-count` `:del-count`。指标区即刻激活。长期方案需要 runtime 提供 file-changes 数据。

---

### OL-SM-EXTRA-01 · SearchModal 零消费者孤儿组件

- **层级位置**：L1 · Overlays.SearchModal · 组件存在性
- **设计要求**：overlays/spec.md §归属与边界 — Search Modal 是 L0 Overlay 级独立组件，通过 ⌘K 或 Sidebar「搜索」nav 项触发
- **实现现状**：SearchModal.vue（3074B，74 行）是一个完整可编译的骨架组件——Dialog 遮罩 + 居中浮层 + 搜索输入框 + 空态。但**全 renderer 源码中没有任何文件 import 或挂载它**。
- **判定**：🆕 多余（零消费者孤儿）
- **差异描述**：组件实现了 v1 骨架的全部功能（modal 形态 + 焦点输入 + 空态），但由于触发入口（⌘K / Sidebar nav）全部 DEFERRED（G-022），组件处于"编译通过但运行时永不渲染"的孤儿状态。W15 OL-L2-01 已从"入口缺失"角度记录 ❌，本条目从"存在但无人用"角度确认 🆕。
- **设计证据**：overlays/spec.md §背景："Search Modal 是 L0 Shell 的 Overlay 级组件——⌘K 触发、模糊遮罩 + 居中浮层"
- **实现证据**：
  ```bash
  # 全量搜索 SearchModal 的 import 引用
  $ grep -rn "from.*overlays/SearchModal\|import.*SearchModal" renderer/src/
  # → exit code 1（零匹配）
  ```
  仅 SearchModal.vue 自身内部无 self-import。唯一的"关联"是 W15 报告中的文档引用。
- **初步根因**：孤立 — 骨架阶段的功能边界划定。SearchModal 是 v1 骨架 batch（FG6）的产物，等待 G-022 联调阶段接入触发入口。与 RC-01/RC-02/RC-03 无直接关联。
- **修复性质**：长期方案 — G-022 联调阶段：在 Shell/MainPanel 层挂载 SearchModal（v-model:open）+ 注册 ⌘K 全局快捷键 + Sidebar 增加「搜索」nav 项。注意与 Settings 内置搜索 ⌘K 的快捷键冲突协调（Settings 打开时 ⌘K 临时重定向）。

---

### ST-SM-EXTRA-01 · SettingsModal 零消费者孤儿组件

- **层级位置**：L1 · Settings.SettingsModal · 组件存在性
- **设计要求**：settings/spec.md §1 — Settings modal 通过 ⌘, 或 workspace 顶栏齿轮触发
- **实现现状**：SettingsModal.vue（4351B，93 行）是一个完整可编译的骨架组件——Dialog 遮罩 + 左 nav（5 菜单）+ 右 detail（page-header + 空壳）。但**全 renderer 源码中没有任何文件 import 或挂载它**。
- **判定**：🆕 多余（零消费者孤儿）
- **差异描述**：同 SearchModal——组件实现了 v1 骨架的全部功能（modal 形态 + 导航联动 + 选中态 inset ring），但触发入口（⌘, / 齿轮）全部 DEFERRED（G-021）。W18 已从"入口缺失"角度记录，本条目从"存在但无人用"角度确认。
- **设计证据**：settings/spec.md §1："入口：⌘,（macOS 习惯）/ workspace 顶栏齿轮"
- **实现证据**：
  ```bash
  $ grep -rn "from.*settings/SettingsModal\|import.*SettingsModal" renderer/src/
  # → exit code 1（零匹配）
  ```
- **初步根因**：孤立 — 骨架阶段功能边界划定。SettingsModal 是 v1 骨架 batch（FG6）的产物，等待 G-021 联调阶段接入触发入口。5 菜单内容 DEFERRED 因 RC-01（settingsStore 不存在），但骨架本身不需要 store。
- **修复性质**：长期方案 — G-021 联调阶段接入触发入口。由于 SettingsModal 不依赖 store（骨架级导航联动只用本地 `ref`），接入触发入口后即可看到交互骨架——菜单切换 + page-header 联动即刻可用，仅内容区为空壳。

---

### ST-SM-EXTRA-02 · `currentMenu` fallback 不可达

- **层级位置**：L3 · Settings.SettingsModal · 防御性代码
- **设计要求**：无对应设计（纯实现细节）
- **实现现状**：
  ```ts
  // SettingsModal.vue:88-90
  const activeMenu = ref<(typeof menus)[number]['id']>('provider')
  const currentMenu = computed(() => menus.find((m) => m.id === activeMenu.value) ?? menus[0])
  ```
  `activeMenu` 初始值 `'provider'`（menus[0]），仅通过 nav `@click="activeMenu = item.id"` 修改，而 `item.id` 来自同一个 `menus` 数组（类型已被 `as const` 收窄为 `'provider' | 'skill' | 'agent' | 'extension' | 'system'`）。`activeMenu.value` 不可能取到这 5 个 ID 之外的值，因此 `?? menus[0]` fallback **在当前代码路径中永远不可达**。
- **判定**：🆕 多余（不可达防御代码）
- **差异描述**：3 个字符的 fallback（`?? menus[0]`）不会造成任何运行时问题——它是防御性编程的标准写法（防止未来有人改 `menus` 数组后忘记更新初始值）。但严格从"多余"视角，它是不可达代码。
- **设计证据**：无（实现细节）
- **实现证据**：SettingsModal.vue:88-90 — 类型系统已保证 `activeMenu.value` in `menus[].id` 联合类型，`menus.find()` 永不会返回 `undefined`。
- **初步根因**：孤立 — 防御性编程习惯。不算问题。
- **修复性质**：保留 — 防御性代码成本极低（3 字符），删除反而增加未来改 `menus` 数组时的出错风险。标记为"已知不可达，保留作防御"，不要求修改。

---

### ST-SM-EXTRA-03 · Plugins 独立组件不存在

- **层级位置**：L2 · Settings.Plugins · 组件存在性
- **设计要求**：settings/spec.md §决策记录 — "Plugins 归属 → 保留独立菜单（2026-06-19 决策）"，Plugins 有独立的 `PluginsPane.vue` + `PluginSettingsForm.vue`
- **实现现状**：全 renderer 目录零 Plugin 文件。W19 ST-L3-06 原判断为"Plugins 菜单遗漏（导航集成问题）"，本 wave 确认根因更深——**Plugins UI 组件在 renderer 中根本不存在**。
- **判定**：🆕 多余（无对应实现 + 导航缺失 = 双重缺失）
- **差异描述**：
  1. W19 层面：SettingsModal `menus` 数组缺第 6 项 `plugins`（导航集成遗漏）
  2. 本 wave 新发现：即使导航有第 6 项，也没有对应的 PluginsPane/PluginSettingsForm 组件可渲染
  3. 两层都缺——不是"实现了但没接入"，而是"完全没开始"
- **设计证据**：settings/spec.md §决策记录："Plugins 归属 → 保留独立菜单...Plugins 菜单由用户单独实现，不在本次 settings draft 队列内"；draft-extension.html §5："Plugins 菜单作为第 6 项独立保留"
- **实现证据**：
  ```bash
  $ find renderer/src/ -name "*Plugin*" -o -name "*plugin*"
  # → 零结果
  ```
  `components/` 目录清单中无 plugins 子目录。
- **初步根因**：孤立 — Plugins 菜单 spec 明确标记为"用户单独实现，不在本次 settings draft 队列内"。这是有意的延期（非遗漏），但需在后续阶段新建整个 Plugins UI。
- **修复性质**：长期方案 — 需要：
  1. 新建 `components/settings/PluginsPane.vue`（per-plugin 配置表单 + 启用/禁用）
  2. SettingsModal.vue `menus` 数组增加第 6 项 `{ id: 'plugins', label: 'Plugins', icon: Puzzle, desc: '...' }`
  3. 左 nav 支持 6 项（当前 `w-[200px]` 5 项刚好，6 项可能需要 `overflow-y-auto` 或紧凑排列）

---

## 五、RC-03 第四次验证结论

| 验证轮次 | Wave | 范围 | 结论 |
|---------|------|------|------|
| 第一次 | W02 | 全局 | 14 组件零外部引用 |
| 第二次 | W07 | Sidebar/Panel | 确认不引用 |
| 第三次 | — | （隐含于 W01 根因清单） | 记录为 RC-03 |
| **第四次** | **W16** | **Overview/Overlays/Settings** | **确认不引用** |

**最终结论**：RC-03 四次验证结论一致且稳固——`ui/dropdown-menu/` 下 14 个组件（DropdownMenu.vue / DropdownMenuTrigger.vue / DropdownMenuContent.vue / DropdownMenuItem.vue / DropdownMenuCheckboxItem.vue / DropdownMenuRadioGroup.vue / DropdownMenuRadioItem.vue / DropdownMenuLabel.vue / DropdownMenuSeparator.vue / DropdownMenuGroup.vue / DropdownMenuShortcut.vue / DropdownMenuSub.vue / DropdownMenuSubTrigger.vue / DropdownMenuSubContent.vue + index.ts）在 renderer 全量代码中零外部引用。仅内部互引用。属于 shadcn 模板初始化时批量生成但从未被使用的残留。可安全删除。

---

## 六、Wave 小结

### 审查统计

| 指标 | 数值 |
|------|------|
| 审查文件数 | 4 |
| 源代码总大小 | ~16.4KB |
| 🆕 多余条目数 | 5 |
| ⚠/❌ 重复前序 wave | 0（全部为"多余"视角独有发现） |
| 新独立问题数 | 3（OV-SC-EXTRA-01 / ST-SM-EXTRA-02 / ST-SM-EXTRA-03） |
| 孤儿组件数 | 2（SearchModal + SettingsModal，W15/W18 已记入口缺失，此处从"零消费者"确认） |

### 多余代码量估算

| 条目 | 行数 | 性质 |
|------|------|------|
| SessionCard 指标区休眠分支 | ~11 行 | 休眠代码（数据就绪后激活） |
| SearchModal 孤儿组件 | ~74 行 | 骨架孤儿（G-022 联调后接入） |
| SettingsModal 孤儿组件 | ~93 行 | 骨架孤儿（G-021 联调后接入） |
| `currentMenu ?? menus[0]` fallback | 3 字符 | 防御代码（保留） |
| dropdown-menu 14 组件（RC-03） | ~500 行 | shadcn 残留（可安全删除） |

**注意**：孤儿组件的 ~167 行代码不是"应该删除"——它们是 v1 骨架 batch 的正确产物，等待联调阶段接入触发入口。区分"暂时孤儿"（SearchModal/SettingsModal）和"真多余"（dropdown-menu 残留）。

### 根因关联

| 根因 | 关联条目 | 状态 |
|------|---------|------|
| **RC-03** | 第四次验证：零引用结论稳固 | 本 wave 最终确认 |
| **RC-01** | ST-SM-EXTRA-01 不受影响（骨架不需要 store） | 排除 |
| **RC-01** | ST-SM-EXTRA-03 不受影响（Plugins 有独立 store） | 排除 |

### 与前序 wave 的关系

| 前序 wave | 重叠条目 | 本 wave 增量 |
|-----------|---------|-------------|
| W15 (Overlays) | OL-L2-01（入口 DEFERRED）→ OL-SM-EXTRA-01（零消费者确认） | 从"入口缺失"到"组件孤儿"的视角转换 |
| W17 (Overview) | OV-L3-02（addCount/delCount 漏传）→ OV-SC-EXTRA-01（休眠分支确认） | 从消费者侧到生产者侧的视角转换 |
| W18 (Settings 骨架) | ST-L2-01/02（骨架形态）→ ST-SM-EXTRA-01（零消费者确认） | 同上 |
| W19 (Settings 菜单) | ST-L3-06（Plugins 菜单遗漏）→ ST-SM-EXTRA-03（Plugins 组件不存在） | 从导航遗漏到组件缺失的根因深化 |

### 总体评价

这 4 个文件的代码质量高于 v3 重构的平均水平。无未使用 import、无废弃代码、无死分支、无旧设计残留。所有"多余"发现均为骨架阶段的架构性临时状态（孤儿组件、休眠分支），非代码质量问题。**唯一可立即清理的真多余是 RC-03 的 dropdown-menu 14 组件**。

---

## 附录 A · `void emit`/`void props` 模式记录

4 个文件中有 2 个使用了 `void` 抑制模式：

| 文件 | 行号 | 模式 | 原因 |
|------|------|------|------|
| SearchModal.vue | 74 | `void emit` | `emit` 在 template 中使用但 TS 不识别 |
| SettingsModal.vue | 93 | `void props` | `props` 在 template 中使用但 TS 不识别 |

这是代码库级别的 Vue SFC 类型检查变通方案（另 2 个使用此模式的文件：SessionList.vue:57 `void props`、Composer.vue:158 `void props`）。4 个文件共 4 处。**不计为"多余"**——是必要的 linter 抑制，删除会导致 type-check 报错。

## 附录 B · 硬编码颜色记录

SessionCard.vue `@keyframes pulse-accent`（:118）和 `pulse-warn`（:123）使用了硬编码 `rgba(79, 142, 247, 0.5)` 和 `rgba(245, 165, 36, 0.5)`，而同一文件的注释（:98）声明"色值走 CSS 变量（design-tokens SSOT），不硬编码"。自相矛盾但不构成功能问题——CSS keyframes 中使用 CSS 变量的 `box-shadow` 动画兼容性有限（Safari < 16 不完全支持），硬编码是务实的工程折衷。**不计为"多余"**。
