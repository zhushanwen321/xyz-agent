# Wave W19 (A-ST-M) · Settings 5 菜单内容审查结果

> 审查日期：2026-06-21
> 层级范围：L3 · Settings 菜单内容级
> 锚点数：6
> 设计来源：`settings/spec.md` + 5 per-menu draft html + `adr-0003-resource-loading-strategy.md`
> 实现源：`src-electron/renderer/src/components/settings/SettingsModal.vue`
> 前序 wave：W18（骨架，L2）

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| ST-L3-01 | L3 | Settings.Provider | API key 加密显隐 + 连接测试 + 模型下拉 | ❌ | draft-provider.html | SettingsModal.vue:44-49（空壳占位） | 根因关联→RC-01 |
| ST-L3-02 | L3 | Settings.Extension | MCP 连接状态点 + 工具列表展开 | ❌ | draft-extension.html | SettingsModal.vue:44-49（空壳占位） | 根因关联→RC-01 |
| ST-L3-03 | L3 | Settings.System | 语言/外观模式/配色主题（两块，draft 移除聊天显示） | ❌ | draft-system.html | SettingsModal.vue:44-49（空壳占位） | 根因关联→RC-01, RC-02 |
| ST-L3-04 | L3 | Settings.Agent | 层 A 加载路径 + 只读列表 + badge 多源·最优先标生效 | ❌ | draft-settings-agent.html + ADR-0003 | SettingsModal.vue:44-49（空壳占位） | 根因关联→RC-01 |
| ST-L3-05 | L3 | Settings.Skill | 层 A 加载路径 + 只读列表 + pi-install 只读 pill | ❌ | draft-settings-skill.html + ADR-0003 | SettingsModal.vue:44-49（空壳占位） | 根因关联→RC-01 |
| ST-L3-06 | L3 | Settings.Plugins | Plugins 独立菜单（第 6 菜单，不折叠进 Extension/Skill） | ❌ | settings/spec.md §决策记录 | SettingsModal.vue:60-66（menus 仅 5 项，无 Plugins） | 孤立 |

**判定分布**：✅ 0 / ⚠ 0 / ❌ 6 / 🆕 0

---

## 二、★5 菜单实现存在性确认（三层分析法）

SettingsModal.vue 的右详情区对所有 5 菜单使用**同一套空壳占位**（`:44-49`）：

```html
<div class="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
  <p class="text-[13px] text-muted">配置项待联调阶段实现</p>
  <p class="font-mono text-[11px] text-subtle">
    {{ currentMenu.id }} · 三模式（G3-002 DEFERRED）
  </p>
</div>
```

菜单切换时仅 `currentMenu.id` 文本变化，无任何条件渲染、无任何 menu-specific 分支。三层逐菜单分析：

| 菜单 | 骨架结构 | 表单控件 | 数据绑定 | 总判定 |
|------|---------|---------|---------|--------|
| **Provider** | ❌ 无 Entity List 骨架，无 provider entity 行 | ❌ 无 password + 眼睛切换，无连接测试按钮，无模型下拉/表格/thinking 分段 | ❌ 无 ProviderInfo/ModelInfo 数据读写 | **全空壳** |
| **Extension** | ❌ 无 Entity List 骨架，无安装区三 tab | ❌ 无连接状态点，无启用开关，无工具列表，无卸载按钮 | ❌ 无 ExtensionInfo 数据读写，无 WS 事件连线 | **全空壳** |
| **System** | ❌ 无 Setting Card 骨架，无三块分组 | ❌ 无语言 select，无外观模式 select，无配色 swatch 网格 | ❌ 无 locale/theme/themePreset 读写 | **全空壳** |
| **Agent** | ❌ 无层 A details 折叠，无 entity 行 | ❌ 无目录勾选/拖动排序，无来源 tab，无搜索，无 badge 链 | ❌ 无 agentDirs 读写，无 AgentRegistry 扫描结果 | **全空壳** |
| **Skill** | ❌ 无层 A details 折叠，无 entity 行 | ❌ 无目录勾选/拖动排序，无来源 tab（含 pi-install），无搜索 | ❌ 无 skillDirs 读写，无 enabledSkills 只读 | **全空壳** |

**结论**：5 菜单内容**完全未实现**。骨架、控件、数据绑定三层均缺失。SettingsModal 的右详情区是**单一空壳占位**，菜单切换仅改变 `currentMenu.id` 占位文本。

---

## 三、★RC-01 关联明细表（每菜单因果链）

| 菜单 ID | RC-01 因果链 |
|---------|-------------|
| **ST-L3-01 Provider** | `settingsStore` 不存在 → ProviderInfo[].apiKey/ModelInfo[].thinkingLevelMap 等字段无数据源 → 无法渲染 Entity List 行、无法实现 toggle/连接测试/模型 thinking 分段 → 全部 DEFERRED。注意：Provider 的字段是 settings 中最复杂的——`ProviderInfo` 含 `apiKey`、`status`（connected/not_configured/error）、`isDefault`，`ModelInfo` 含 `thinkingLevelMap`（Record<string, string|null>，需三档映射 + 就地编辑），这些全部依赖 store 读写。 |
| **ST-L3-02 Extension** | `settingsStore` 不存在 → ExtensionInfo 列表（name/version/enabled/source/tools）无数据源 → 无法渲染 Entity List（状态点/开关/卸载）、无法实现安装工作流三 tab（npm/local/git）→ 全部 DEFERRED。Extension 额外依赖 WS 事件（`extension.list`/`toggle`/`uninstall`/`install` 等），但 WS 事件的目标路由即 store 更新——store 不存在，WS 推送无处落。 |
| **ST-L3-03 System** | `settingsStore` 不存在 → `locale`/`theme`(ThemeMode)/`themePreset`(ThemePreset) 三字段无读写目标 → 无法实现语言 select、外观模式 select、配色 swatch 网格。**额外关联 RC-02**：即使先做纯 UI，`style.css` 无 `[data-theme]` / `[data-palette]` 选择器，切主题/配色无法生效。 |
| **ST-L3-04 Agent** | `settingsStore` 不存在 → `agentDirs` 数组（discovery.json）无读写目标 → 层 A 加载路径（强制目录只读置顶 + 可选目录勾选/拖动排序）无数据源。Agent 实体列表（只读预览扫到的 subagent）依赖 AgentRegistry 主进程扫描，但 AgentRegistry 的发现源即 discovery.json——store 不存在则配置枚举管丢失。 |
| **ST-L3-05 Skill** | `settingsStore` 不存在 → `skillDirs` 数组（discovery.json）无读写目标 → 层 A 加载路径同构 Agent。pi-install 实体（来源 A，`settings.json` enabledSkills）需独立读取 `settings.json`，但 store 是这些数据的统一入口——store 不存在，pi-install 只读 pill 无数据源。 |
| **ST-L3-06 Plugins** | 此菜单不与 RC-01 直接关联（Plugins 有独立的 `PluginsPane.vue` + `PluginSettingsForm.vue`，可能已有独立实现）。但 Settings 导航硬编码 5 菜单，未预留第 6 插槽。 |

**总结**：5 菜单全部 DEFERRED 的根本原因是同一个——**settingsStore 不存在**。三模式（ST-L2-03 W18 已记录）是公共特质层，5 菜单是内容层，两层都依赖 store。store 不存在的连锁效应：无数据源 → 无表单值 → 无自动保存 → 无内置搜索索引 → 5 菜单只能是空壳。

---

## 四、条目详情卡

### ST-L3-01 · Provider 页面：API key 加密显隐 + 连接测试 + 模型下拉

- **层级位置**：L3 · Settings.Provider · 菜单内容
- **设计要求**：Entity List（模式 C）列出所有已配置供应商，每行一 entity（状态点 + 名称 + 来源 pill + 启用开关 + 展开凭据与模型表格）。展开后两个 `.e-zone` 分区：凭据与连接（API key password + 👁 显隐切换 + 连接测试按钮 + inline result 行）+ 模型表格（模型名左对齐 / reasoning / 上下文 / thinking 三档 pill 就地切分段 / 默认模型按钮）。嵌套编辑 Modal 含字段校验、Ollama 免 key 例外、自动发现 5 态状态机、删除确认。默认 Provider 入口在 entity head 右侧（全局互斥 accent pill）。默认模型入口在表格最右列（全局互斥 info pill，颜色+位置双重区分）（draft-provider.html §1-§8）
- **实现现状**：右详情区全部为同一空壳占位，无任何 Provider 特定 UI（SettingsModal.vue:44-49）
- **判定**：❌ 缺失
- **差异描述**：Provider 是 5 菜单中设计最复杂的——包含 2 个全局互斥操作（默认供应商/默认模型）、2 条独立 inline result 行（连接测试/自动发现）、1 个嵌套编辑 Modal、thinking 三档就地编辑、以及 API key 加密显隐。当前实现为零，无任何 Provider 特定代码路径
- **设计证据**：draft-provider.html — §2 Entity Row 解剖（4 种状态点 green/idle/red + 3 种行变体）、§3 连接测试 4 态状态机、§4 自动发现 5 态状态机、§5 thinkingLevelMap 三档色编 + 模型表格 5 列结构、§6 API Key 显隐（password + 眼睛 toggle）+ 字段校验 + Ollama 例外
- **实现证据**：`SettingsModal.vue:44-49` — 占位文案 "配置项待联调阶段实现" + "三模式（G3-002 DEFERRED）"；全文件无 `provider`/`apiKey`/`thinkingLevel`/`entity`/`connection test` 等关键词或组件引用
- **初步根因**：`根因关联→RC-01` — ProviderInfo/ModelInfo 的完整字段树（apiKey/status/thinkingLevelMap/cost 等）全部需要从 settingsStore 读写。store 不存在 → 所有 entity/row/modal/状态机无数据源。Provider 是 5 菜单中 store 依赖最深的——2 个全局互斥操作需要 store 级别的 `setDefault()`/`setDefaultModel()` 方法，thinking 就地编辑需要 store 的 `editThinkInline()`/`pickThink()`
- **修复性质**：长期方案 — 按 draft-provider.html 完整实现（Entity List + 嵌套 Modal + 2 个状态机 + thinking 三档）。需 RC-01 先解决。ProviderInfo/ModelInfo 类型在 `shared/src/provider.ts` 已定义，可作为 store schema 基

### ST-L3-02 · Extension 页面：MCP 连接状态点 + 工具列表展开

- **层级位置**：L3 · Settings.Extension · 菜单内容
- **设计要求**：Entity List（模式 C）列出已安装扩展 + 安装工作流（三 tab npm/local/git → 发现候选多选 → 安装）。每行 entity：启用开关 + 状态点（MCP 连接：ok/warn/err/idle）+ 名称 + 版本 pill + 来源 pill（built-in/user-installed）+ 工具计数 + 卸载按钮（仅 user-installed）+ 展开 MetaGrid。三种行变体：built-in（不可关不可卸）、user-installed 已连接（可关可卸）、user-installed 断开（重连入口）。安装工作流 6 态（idle → discovering → selecting → installing → error + 60s 超时）。卸载确认 Dialog（draft-extension.html §0-§5）
- **实现现状**：右详情区全部为同一空壳占位，无任何 Extension 特定 UI（SettingsModal.vue:44-49）
- **判定**：❌ 缺失
- **差异描述**：Extension 是唯一含安装工作流的菜单——区别于 Skill 的纯本地扫描，Extension 走 npm/local/git 三种远程安装源 + 后端发现 + 60s 超时。当前实现为零
- **设计证据**：draft-extension.html — §1 安装工作流 6 态状态机、§2 Entity List 三种行变体（built-in / user 已连接 / user 断开）、§3 卸载确认 Dialog、§4 ExtensionInfo 字段表 + 11 个 WS 事件清单、§5 Plugins 独立菜单决策
- **实现证据**：`SettingsModal.vue:44-49` — 占位文案；全文件无 `extension`/`mcp`/`built-in`/`npm`/`install`/`uninstall` 等关键词
- **初步根因**：`根因关联→RC-01` — ExtensionInfo 列表（name/version/enabled/source/tools）来自 store，安装工作流状态（discovering/selecting/installing）需 store 管理，WS 事件（`extension.list`/`toggle`/`uninstall` 等）推送的目标即 store 更新。store 不存在 → 全链断
- **修复性质**：长期方案 — 按 draft-extension.html 完整实现（Entity List + 安装工作流 6 态 + 卸载 Dialog）。需 RC-01 先解决。注意 Extension WS 事件 11 个的处理链路需与 runtime PluginService 对齐

### ST-L3-03 · System 页面：语言/外观模式/配色主题（两块，draft 移除聊天显示）

- **层级位置**：L3 · Settings.System · 菜单内容
- **设计要求**：模式 B Setting Card（两块分组）+ 模式 A Setting Row。卡 1「语言与外观」：语言 select（zh-CN/en-US 母语显示）+ 外观模式 select（light/dark/system，经 `data-theme` 属性驱动）。卡 2「配色主题」：Muted 5 + Colorful 6 共 11 个 swatch，选中态 `accent ring + accent-light 底`，`data-palette` 属性驱动。"聊天显示"整块已移除（4 字段不展示）。快捷键只读列表先行。（draft-system.html §2-§4）
- **实现现状**：右详情区全部为同一空壳占位，无任何 System 特定 UI（SettingsModal.vue:44-49）
- **判定**：❌ 缺失
- **差异描述**：System 是 5 菜单中最轻量的（纯枚举 + 开关，无实体列表），但当前同样为零实现。特别检查：render 的 Settings 导航无 Plugins 菜单，System 在菜单数组第 5 位
- **设计证据**：draft-system.html — §2 产品形态（两块 Card：语言与外观 + 配色主题 + 第三 Card 快捷键只读列表）、§4 移除聊天显示的决议、§1 属性驱动主题切换机制（`data-theme` + `data-palette`，非 JS 逐变量赋值）
- **实现证据**：`SettingsModal.vue:44-49` — 占位文案；`SettingsModal.vue:60-66` — menus 数组包含 `{ id: 'system', ... }` 但内容空壳
- **初步根因**：`根因关联→RC-01` + **`根因关联→RC-02`**。RC-01：locale/theme/themePreset 三字段依赖 store 读写。RC-02：即使先做纯 UI（select + swatch 网格），`style.css` 无 `[data-theme]` / `[data-palette]` 属性选择器，切主题/配色无法生效——外观模式 select 和配色 swatch 点击后 `document.documentElement` 上的属性写入生效了，但 CSS 不响应
- **修复性质**：长期方案 — RC-01 + RC-02 双修。store 提供 locale/theme/themePreset 字段 + `applyTheme()`/`setThemePreset()` 方法；CSS 补 `[data-theme]` / `[data-palette]` 选择器。注意 draft-system 的默认 palette 是 cold-blue（品牌主色），而真身代码默认 neutral——实现时需决策默认值

### ST-L3-04 · Agent 页面：层 A 加载路径 + 只读列表 + badge 多源·最优先标生效

- **层级位置**：L3 · Settings.Agent · 菜单内容
- **设计要求**：唯一配置面——层 A `<details>` 折叠：强制目录（`~/.xyz-agent/agents` 全局 + `.xyz-agent/agents` 项目，只读置顶不可关不可拖）+ 可选目录（`~/.pi` · `~/.claude` · `~/.agents` · `.agents`，可勾选可拖排序，写 `agentDirs`）。层 B Entity List 只读预览扫到的 subagent（搜索 + 来源 tab + badge 链，同名多来源第一个标"生效"）。（draft-settings-agent.html §01 + ADR-0003 §1.1 §5）
- **实现现状**：右详情区全部为同一空壳占位，无任何 Agent 特定 UI（SettingsModal.vue:44-49）
- **判定**：❌ 缺失
- **差异描述**：Agent 与 Skill 同构，但差异在于：Agent 无"强制/原生"目录区分（ADR-0003 §1.1 统一模型，两者都是"强制 = xyz-agent 目录 / 可选 = 外部目录"），Agent 无 pi-install 概念。当前实现无法验证是否正确处理此差异（无任何实现）
- **设计证据**：draft-settings-agent.html + ADR-0003 §1.1 统一优先级模型（强制项目 > 强制全局 > 可选拖动）、§5 配置粒度（只到目录级，无文件级开关）、Agent 与 Skill 同构但 Agent 无 pi-install、agent `.md` 仅 AgentRegistry 扫描
- **实现证据**：`SettingsModal.vue:44-49` — 占位文案；全文件无 `agent`/`agentDirs`/`subagent`/`discovery`/`layerA` 等关键词
- **初步根因**：`根因关联→RC-01` — `agentDirs` 数组（discovery.json 的核心字段）需要 store 读写。AgentRegistry 的扫描结果也需要 store 层缓存（实体列表的数据源）。注意 Agent 与 Skill 的 layerA 组件可共享（同构），但数据管道不同（`agentDirs` vs `skillDirs`）
- **修复性质**：长期方案 — 按 draft-settings-agent.html + ADR-0003 完整实现。可考虑与 Skill 共享 layerA 组件（目录勾选/拖动排序），区分 `agentDirs`/`skillDirs` 数据管道的 prop 差异。注意 AgentRegistry 单例约束（`ui_limit`：切项目需重开会话）

### ST-L3-05 · Skill 页面：层 A 加载路径 + 只读列表 + pi-install 只读 pill

- **层级位置**：L3 · Settings.Skill · 菜单内容
- **设计要求**：与 Agent 同构——层 A 加载路径（强制 2 + 可选 4）+ 层 B 只读 Entity List。差异：Skill 有 pi-install 来源 A（`settings.json` enabledSkills，只读，开关锁死，不进 discovery.json），来源 badge 多一个 `pi-install` tab，用 `--pi` token（紫色）。Skill 无"强制/原生"目录区分，ADR-0003 §1.1 已统一为强制=xyz-agent、可选=外部。（draft-settings-skill.html §01 + ADR-0003 §5）
- **实现现状**：右详情区全部为同一空壳占位，无任何 Skill 特定 UI（SettingsModal.vue:44-49）
- **判定**：❌ 缺失
- **差异描述**：Skill 与 Agent 的差异——pi-install（来源 A，只读，"用 pi 自己的 /skills 管理"）——在 draft 中有完整的视觉定义（紫色 `--pi` token，`pill piinstall` class，来源 tab 中的 "pi-install 只读" 按钮，info 行中的锁图标 + `source = A` 标记）。当前实现无法验证是否正确处理此差异（无任何实现）
- **设计证据**：draft-settings-skill.html — pi-install entity 只读（无开关）、`pill piinstall` 紫色 badge、来源 tab 含 `ro`（readonly）tab + `--pi` token、`la-row info pi` 行标来源 A + `settings.json enabledSkills`；ADR-0003 §5 — pi-install 不进 discovery.json、开关键死、改它用 pi 的 `/skills`
- **实现证据**：`SettingsModal.vue:44-49` — 占位文案；全文件无 `skill`/`skillDirs`/`pi-install`/`enabledSkills` 等关键词
- **初步根因**：`根因关联→RC-01` — `skillDirs` 数组（discovery.json）+ `enabledSkills`（settings.json，pi-install 来源 A）都需要 store 管理。注意 `enabledSkills` 是独立数据源（pi 的 settings.json），与 `skillDirs` 数据管道不同——store 需同时管理两条路径
- **修复性质**：长期方案 — 按 draft-settings-skill.html + ADR-0003 完整实现。Skill layerA 可与 Agent 共享组件，差异：
  - 数据管道：`skillDirs` vs `agentDirs`
  - pi-install 额外行（来源 A，只读，不进 discovery.json）
  - 来源 tab 多一个 `pi-install` 只读 tab
  - Skill 改动即时生效（不需重开会话），区别于 Agent 的 `ui_limit`

### ST-L3-06 · Plugins 独立菜单（第 6 菜单，不折叠进 Extension/Skill）

- **层级位置**：L3 · Settings.Plugins · 菜单入口
- **设计要求**：Plugins 保留独立菜单（第 6 菜单），不折叠进 Extension 或 Skill。理由：Plugins 有独立的 per-item 配置表单（`PluginSettingsForm.vue`），与 Extension 的"远程安装 + 启用"职责不同。折叠需给 `ExtensionInfo` 加 `configSchema`，过度耦合。（settings/spec.md §决策记录 + draft-extension.html §5）
- **实现现状**：SettingsModal.vue 的 `menus` 数组硬编码 5 项（provider/skill/agent/extension/system），无 Plugins 入口（SettingsModal.vue:60-66）
- **判定**：❌ 缺失
- **差异描述**：Settings 导航仅 5 个菜单，未预留第 6 个 Plugins 插槽。spec 已决策保留 Plugins 独立菜单——但 v1 的 SettingsModal 未实现此决策。现有 Plugins 实现（`PluginsPane.vue` + `PluginSettingsForm.vue`）可能在其他位置独立存在，但**没有集成到 Settings Modal 的导航中**
- **设计证据**：settings/spec.md §决策记录："Plugins 归属 → 保留独立菜单（2026-06-19 决策）"；draft-extension.html §5："Plugins 菜单作为第 6 项独立保留，本次不在 settings draft 队列内（用户单独实现）"
- **实现证据**：`SettingsModal.vue:60-66` — `menus` 数组 5 项，无 `plugins` 项；`SettingsModal.vue:25` — 左 nav `w-[200px]`，5 个 Button 刚好够，无滚动/溢出处理以支持第 6 项
- **初步根因**：孤立 — 这是一个架构集成遗漏，与 RC-01 无关。Plugins 已有独立实现（`PluginsPane.vue`），但未被 Settings Modal 的导航系统纳入。需要：(1) menus 数组增加第 6 项，(2) 左 nav 需支持 6 项溢出（滚动或紧凑排列），(3) Plugins 菜单内容需对接现有 PluginsPane 或新建 settings 内嵌版本
- **修复性质**：长期方案 — 在 Settings Modal 导航中增加 Plugins 入口（第 6 菜单）。由于 Plugins 已有独立实现，可先做桥接（点击 Plugins 菜单时加载现有 PluginsPane），后续决定是否需要独立的 settings Plugins draft。注意 Navigation 宽度 `w-[200px]` 在 5 项时刚好，6 项可能需滚动

---

## 五、Wave 小结

- **审查条目数**：6（✅ 0 / ⚠ 0 / ❌ 6 / 🆕 0）
- **全部 ❌ 数**：6（全部 DEFERRED）
- **根因关联数**：5 × RC-01（ST-L3-01 至 ST-L3-05，全部 DEFERRED 因 store 不存在）+ 1 条额外关联 RC-02（System 主题切换需 CSS 属性选择器）
- **孤立问题数**：1（ST-L3-06 Plugins 独立菜单 — 导航遗漏，与 RC-01 无关）
- **新独立问题数**：1（ST-L3-06，与 W18 骨架发现不重复）

**总体评价**：5 菜单内容**完全未实现**。SettingsModal 当前是纯骨架——左导航正确（5 菜单 + inset accent ring 选中态）、右详情全空壳。菜单切换仅改变占位文本中的 `currentMenu.id`。这不是"实现不完整"，而是"实现未开始"——没有任何 menu-specific 的 `v-if`/`component`/条件渲染分支。

**RC-01 是 5 菜单唯一的阻塞根因**：settingsStore 不存在 → 所有菜单的表单数据源（ProviderInfo/ModelInfo、ExtensionInfo、locale/theme/themePreset、agentDirs/skillDirs/enabledSkills）全部缺席 → 三模式组件（Setting Row/Card/Entity List）即使先行实现为纯布局，也无法实例化出有意义的表单内容。

**设计与实现的差距量级**：

| 菜单 | 设计 spec 复杂度 | draft html 行数 | 需要的数据模型字段数 |
|------|-----------------|-----------------|---------------------|
| Provider | 最高（Entity List + Modal + 2 状态机 + thinking 三档） | ~887 行 | ProviderInfo(6)+ModelInfo(5)≈11 |
| Extension | 高（Entity List + 6 态状态机 + Dialog） | ~730 行 | ExtensionInfo(8)≈8 |
| System | 低（Card + Row，纯枚举） | ~780 行 | 3（locale/theme/themePreset） |
| Agent | 中（Layer A + Entity List 只读） | ~730 行 | agentDirs[] + AgentRegistry 结果 |
| Skill | 中（同 Agent + pi-install 只读） | ~720 行 | skillDirs[] + enabledSkills[] |

**跨 wave 依赖提示**：
- **RC-01 是所有 W19 条目的阻塞根因**，与 W18 的 ST-L2-03/04/05 共享同一根因
- **RC-02 独占影响 System 菜单**（ST-L3-03）— 即使 store 就绪，CSS 缺 `[data-theme]` / `[data-palette]` 选择器也会导致主题切换无声
- **Plugins 独立菜单**（ST-L3-06）是架构集成遗漏，需在 Settings Modal 导航集成现有 PluginsPane
- **W02 的 dropdown-menu 零引用问题**（RC-03）可能与 Provider 的模型下拉、System 的语言/外观 select 相关——建议统一使用 setting select（draft 中全是原生 select + 自定义样式），不依赖 dropdown-menu
- **Agent/Skill 同构**：实现时 layerA 组件可共享（目录/拖动排序），差异点仅数据管道（`agentDirs` vs `skillDirs`）+ Skill 的 pi-install 额外行 + Agent 的 `ui_limit`
