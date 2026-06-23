# Spec · settings · settings-shell

> L1 Region · SettingsView。全屏覆盖（含 sidebar 柱），退出恢复。取向 = **配置/表单交互**，区别于 Overview 的鸟瞰/监控。
> 本 spec 定义所有 settings 页面共享的「公共特质」；各菜单 per-menu draft（`draft-provider.html` 等）照此执行。

## 1. 定位与边界

- 形态：居中 **modal + 模糊背景**（backdrop blur），浮于 workspace 之上。比 Overview 的全屏覆盖更轻——settings 是「临时调一下」的配置动作，不该霸占整个工作区。
- 入口：⌘,（macOS 习惯）/ workspace 顶栏齿轮。关闭：Esc / 点背景 / 点 ✕。关闭后恢复原 workspace 状态（不记忆滚动位置之外的中间态）。
- 与 Overview 分工：Overview = 全屏鸟瞰（数据呈现）；Settings = 居中 modal（表单交互）。两者形态 + 取向都不同。

## 2. 页面骨架（所有菜单共用）

```
.modal-head :  设置 + 内置搜索(⌘K) + 保存状态 pill  |  ✕
.modal-body :  .ov-nav(左 ~190px)  +  .ov-detail(右 scroll)
.ov-detail  :  page-header(菜单名 + 一句定位)  →  n 个 Setting Card 分组
```
modal 宽 ~900px / 高 ~540px，居中；背景 backdrop `blur(10px)` + 半透聚层。控件区滚动在 `.ov-detail`。

## 3. 三种布局模式（公共特质的核心）

| 模式 | 形态 | 用于 | 80% 场景 |
|---|---|---|---|
| **A · Setting Row** | 标签左 + 控件右 + 下方帮助文字 | 单值配置（开关/下拉/分段/输入） | 原子 |
| **B · Setting Card** | Card 包多个语义相关的 Setting Row | 分组（一卡多开关，如 System 页的「外观偏好」） | 复用 Card 原语 |
| **C · Entity List** | 每行一实体 + 来源/版本 pill + 状态点 + 启用开关 + 展开配置（Skill/Agent 用**只读子集**：去启用开关和展开配置，加来源 badge 链·最优先标生效，见 ADR-0020） | Provider/Extension（完整）/ Skill/Agent（只读子集） | 列表型 |

每页只是这三种的不同组合。控件原语全部从 `design-system.md` 派生（Toggle/Input/Select/Segmented/Pill/Status Dot），禁止各稿自造。

## 4. 5 菜单差异速览

| 菜单 | 主用模式 | 特异点（骨架预留口子） |
|---|---|---|
| Provider | C 列表 + A 行 | API key 加密显隐、连接测试按钮、模型下拉 |
| Skill | 层 A 加载路径 + C 只读列表 | 强制目录（`~/.xyz-agent`/`.xyz-agent`·不可关）置顶 + 可选目录（`~/.pi`/`~/.claude`/`~/.agents`/`.agents`·可勾选可拖排序）；实体只读预览，来源 badge 多源·最优先标生效；pi-install（来源 A）只读 pill（ADR-0020）|
| **Agent** | 层 A 加载路径 + C 只读列表 | 与 Skill **同构**（同一套 layerA + badge 语义）；差异：agent `.md` pi 原生不扫，全靠 `agentDirs` discovery 注入（可选目录都可勾选，无「强制/原生」区分）；无 pi-install 概念（ADR-0020）|
| Extension | C 列表 + A 行 | MCP 连接状态点、工具列表展开 |
| System | A 行 + B 卡 | 语言/外观模式/配色主题（真身另含聊天显示，★draft 移除）；draft 默认 cold-blue；快捷键/关于待裁决（见 handoff-system §11） |

## 5. 公共横切（所有页面都有）

- **内置搜索**：跨菜单搜设置项 → 下拉匹配列表（带菜单 tag）→ 点选切到该菜单并高亮行。⌘K 唤起。
- **自动保存**：debounce 800ms；右上角状态 pill（`已保存` / `保存中…`）。无显式 Save 按钮。
- **关闭恢复**：Esc / 点背景 / 点 ✕ → 关闭 modal，workspace 原状态不变。

## 6. 验收（P0）

- [ ] modal 形态正确（居中 + backdrop blur，关闭恢复）
- [ ] 三种模式可复用，5 菜单只是组合差异
- [ ] 导航 ↔ 详情联动（切菜单换面板）
- [ ] 内置搜索跨菜单工作 + 自动保存状态可见
- [ ] 与 Overview 区分明确（Overview 全屏鸟瞰 / Settings 居中 modal）
- [ ] 冷蓝 token 一致，禁左竖条强调

## 7. 交付节奏

- 本回合：`draft-settings-shell.html`（modal 骨架 + 三模式 + 公共横切，Provider 为落地页演示，其余 4 菜单给 header + 样例行）+ 本 spec + **5 菜单 handoff**。
- **5 菜单 handoff 已出**：`handoff-provider.md` / `handoff-skill.md` / `handoff-agent.md` / `handoff-extension.md` / `handoff-system.md`（字段与交互源自 `~/Code/xyz-agent-workspace/main` 现有实现）。
- 后续 per-menu draft（按优先级）：**Agent / Skill**（同构，层 A 加载路径 + 只读预览，见 ADR-0020）→ Provider → Extension → System。
- 本稿文件名 `draft-settings-shell.html` 取代 handoff 占位名 `draft-settings-view.html`（后者按菜单拆分后不再单出）。
- **per-menu draft 命名**（2026-06-19 勘误）：约定 `draft-{menu}.html`（provider/extension/system 无前缀）；agent/skill 历史遗留带 `settings-` 前缀（`draft-settings-agent.html` / `draft-settings-skill.html`），引用照此，不强行重命名（避免断 handoff 真身引用）。

## 8. 决策记录

- **Plugins 归属 → 保留独立菜单**（2026-06-19 决策）：现有实现（`main/.../settings/PluginsPane.vue` + `PluginSettingsForm.vue`）有独立 Plugins 菜单 + 每插件独立配置表单。本次 5 菜单方案（Provider/Skill/Agent/Extension/System）不含 Plugins——**保留 Plugins 作为第 6 菜单，不折叠进 Extension/Skill**。理由：Plugins 的 per-item config 与 Extension 的「远程安装 + 启用」职责不同，折叠需给 `ExtensionInfo` 加 `configSchema`，耦合过重。Plugins 菜单由用户单独实现，不在本次 settings draft 队列内（见 `draft-extension.html §5`）。
