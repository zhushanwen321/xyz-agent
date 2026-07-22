# v3 · UI 设计区

xyz-agent 前端设计的正式 SSOT。v3 重构于 2026-06 完成（W01–W20 视觉验收全部 PASS，ADR-0018 确立冷蓝暗色方向）。按"设计单元（文件夹）"组织，方法 `recursive-skeleton`（L0→L4 递归骨架）。

## 全局基础件（在 docs/page-design/ 根，非本目录）

| 文件 | 位置 | 层级 | 说明 |
|---|---|---|---|
| `PRODUCT.md` | **项目根** | 产品 | 定位 + 品牌人格 |
| `design-tokens.md` | `docs/page-design/` | 原子 | 值 SSOT（色/字/距/影/动效） |
| `design-system.md` | `docs/page-design/` | 原语 | 组件原语层（tokens 之上如何用） |

## 目录结构（L0→L4 递归骨架）

```
v3/
├── README.md                          本文件
├── ui-skeleton.md                     L0-L4 总纲 SSOT
├── architecture-and-terminology.html  术语+架构综合指南（命名唯一来源）
├── skeleton-chain.html                L0→L4 骨架链路可视化（导航图）
├── (ADR 已归位到 ../../architecture/adr/0018-0022，本目录不再保留)
│
├── shell/                  [L0 Shell · 完成]
│   ├── spec.md
│   ├── draft-skeleton.html             全屏空壳
│   └── draft-overlay-states.html       非全屏/全屏两态 + 跨平台
│
├── sidebar/                [L1 Region · spec + 容器稿已立]
│   ├── spec.md             ✅ 多视图容器规范（四态 A-D，搜索 modal 已剥离归 Overlay）
│   ├── draft-five-states.html          ✅ 容器多态（会话列表/文件视图/收起/空）
│   ├── draft-session-item.html         ✅ 会话项 5 态 + 激活 + 右键 + 子会话
│   └── draft-file-view.html            ✅ 文件树 + git 4 标注 + 树内过滤
│
├── workspace/              [L1 Region · 拓扑已定]
│   ├── spec.md             双 Panel 主从模式
│   └── draft-dual-panel.html
│
├── panel/                  [L2 Module · ★★★核心 · spec + 4 draft 已立]
│   ├── spec.md             ✅ 单/双模式收口 + 5 zone
│   ├── draft-message-stream.html       ✅ 消息流交互原型 + 7类块规则（原 types 已并入 §4 附录）
│   ├── draft-composer-states.html      ✅ Composer 6 态
│   ├── draft-companion-zones.html      ✅ progress-zone + git-zone 上下区
│   └── draft-detail-pane.html          ✅ diff/subagent/tasktree 详情（单双模式差异）
│
├── overlays/               [L1 · 全局浮层 · search-modal + spec 已立]
│   ├── spec.md             ✅ Overlay 容器规范（与 File View 过滤严格区分）
│   └── draft-search-modal.html         ✅ ⌘K 搜索浮层（已从 sidebar 移出）
│
├── overview/               [L1 · 独立 Region · 鸟瞰统筹]
│   ├── spec.md             ✅ 独立 Region + 与 Session List 分工 + 入口落点（sidebar 按钮·ADR-0022）
│   ├── draft-entry.html             ✅ 入口+覆盖（sidebar 触发·覆盖 workspace）★新
│   └── draft-overview.html             ✅ 卡片网格 + 筛选 + 后台 agent 聚合
│
├── settings/               [L1 · 完成 · spec + 6 draft + 5 handoff]
│   ├── spec.md             ✅ settings-shell modal 骨架 + 三模式 + 公共横切（ADR-0020 依赖）
│   ├── draft-settings-shell.html      ✅ modal 骨架 + 三模式演示
│   ├── draft-provider.html            ✅ Provider 菜单
│   ├── draft-extension.html           ✅ Extension 菜单
│   ├── draft-system.html              ✅ System 菜单（两块，对齐真身）
│   ├── draft-settings-agent.html      ✅ Agent 菜单（命名遗留，见 settings/spec.md §7）
│   ├── draft-settings-skill.html      ✅ Skill 菜单（命名遗留，见 settings/spec.md §7）
│   └── handoff-{provider,skill,agent,extension,system}.md  ✅ 5 菜单 handoff（★单元内放置，见 handoffs/README 特例）
│
├── flow-2-code-review/     [L3/L4 跨区联动 · 完成] spec.md + draft-cases.html（含变更集卡 5 态）
├── flow-3-subagent/        ✅ 护城河：多 agent 编排 + 进度聚合 + steer（spec + draft 已立）
│
├── fast-fork/              [L2 跨区联动 · 痛点1 spec + draft 已立，待实现]
│   ├── spec.md             ✅ 快速分叉设计 SSOT（Fork-to-Ask + 后台分支管理）
│   └── draft-fast-fork.html ✅ 终态交互 demo（composer fork 模式 + 分支小列表 + streaming 态 fork）
│
├── fast-merge/             [L2 跨区联动 + Extension · 痛点2 spec 已立，待实现（依赖痛点1 基础层）]
│   └── spec.md             ✅ 多分支差异聚合设计 SSOT（B+C+F 三件套 + structured-output + 贴 composer）
│
├── fast-handoff/           [L2 跨区联动 + Extension · 痛点3 spec 已立，待实现（与痛点2 共享三件套架构）]
│   └── spec.md             ✅ 一键交接到新 session 设计 SSOT（三件套 + structured-output + 新建空白 session）
│
├── research/               [调研依据 · 非设计稿]
│   └── pi-steer-followup-capability.md   pi composer steer/followup 队列源码调研（panel/composer draft 依据）
│
└── handoffs/               [交接文档层 · 已立]
    README.md + handoff-<单元>-<稿>.md。settings 的 5 份 handoff 因单元强耦保留在 settings/（特例，见 handoffs/README.md）
```

## 最细粒度叶子清单

**draft = 最细粒度单元**：一个可独立评审的设计决策 + 它的全部状态。当前 **22 个 draft 叶子全部落地**（shell 2 / sidebar 3 / workspace 1 / panel 5 / overlays 1 / overview 2 / settings 6 / flow-2 1 / flow-3 1）。

每个 draft 必须满足（recursive-skeleton 密度要求）：① 明确目的（画什么决策）② 完整状态清单 ③ 联动说明 ④ 标注空缺。只放标题的空文件是反模式。

## 命名规范

1. **一个设计单元 = 一个文件夹**（spec.md + n 个 draft）。只有 draft 没 spec = 缺口，立即可见。
2. **文字规范 `spec.md`**，每单元唯一。**可视化稿 `draft-<状态>.html`**，可多份。
3. **ADR `adr-NNNN-<主题>.md`** 平铺根；基础件语义名放 `docs/page-design/` 根。
4. **文件名英文 kebab**，中文进 `<title>` 与正文。
5. **术语以 `architecture-and-terminology.html §1` 为唯一来源**，新稿禁止用废弃词。

## 术语统一映射（旧 → 规范，待批量执行）

历史 md/draft 仍含废弃词。**清理计划（2026-06-19 登记）**：不在散点修，等下一个 draft 定稿窗口批量 sed 替换 + 全文 grep 校验。当前状态：
- 映射表 SSOT 已立（`architecture-and-terminology.html §1`）。
- `ui-skeleton.md` 正文仍满篇旧词（ChatView/进程面板/会话列表视图），§5 进程面板优先级已标「v1 删除」，其余旧词待批量替换。
- 命名不一致（`draft-settings-agent/skill` 带前缀 vs `draft-provider/extension/system` 不带）见 `settings/spec.md §7` 勘误——**永缓**（不强行重命名避免断引用），除非未来统一重构。

废弃词映射：

| 废弃 | 规范 |
|---|---|
| 左 aside / aside-region / 左侧边栏 / 边栏 | 侧栏 Sidebar |
| 会话列表视图 / session panel（列表义） | 会话列表 Session List |
| 会话条目 / session panel（歧义源头） | 会话项 Session Item |
| 文件浏览区 / file-tree panel | 文件视图 File View |
| 搜索 modal / 搜索框 | 搜索浮层 Search Modal（归 Overlay，移出 Sidebar） |
| main-panel / main / 主面板 | 工作区 Workspace |
| 双 panel（作容器名） | 面板 Panel（双 Panel） |
| OverviewView / Mission Control | 概览 Overview（等价别名，按语境选用） |

## 已知问题

- **sidebar/spec.md 已补齐**：原“缺口暂缓”决定已撤销——`sidebar/spec.md` 已立（多视图容器规范，四态 A-D，搜索 modal 归属裁决）。
- **ui-skeleton.md ChatView vs Panel 冲突**：已在 `panel/spec.md` 收口（单 Panel = 默认态 / 双 Panel = split 派生；Panel 内固定 5 zone；Side Drawer、Process Panel、Search Modal 移出 Panel 归 Overlay/Workspace 级）。ui-skeleton.md 正文仍用 `ChatView` 旧名，术语替换待首个 draft 定稿后批量执行。
- **Process Panel v1 已删除**（2026-06-19 决策，见 `panel/spec.md` line 59/100）：单 Session 进度走 composer 上方 `progress-zone`；多 SubAgent 编排呈现推迟到 Flow-3。ui-skeleton.md §5 的「进程面板 ★★最高优先级待深化」为**历史遗留**，不再有效（待术语批量替换时同步清理）。
- **settings 已完成**（2026-06-19）：原「待评估，暂不深化」状态已撤销——spec + 6 draft + 5 per-menu handoff 全部落地，System 菜单对齐真身实现（两块，移除聊天显示）。旧 `handoffs/handoff-settings-view.md`（空白占位 + 全屏覆盖形态，均已被 settings/spec.md 居中 modal 决策取代）已删除。
- **默认主题方向已裁决**（ADR-0021-B，2026-06-20）：**暗色冷蓝为真默认**，真身代码跟随设计主张。真身 `settingsStore` 初值待迁移（light/neutral → dark/cold-blue），draft 已用 cold-blue 演示无需改。见 `adr/0021-default-theme-direction.md`。
- **sidebar 搜索 modal 已移出**：原五态稿中的搜索 modal 已按术语归 Overlay，落地为 `overlays/draft-search-modal.html`。sidebar/spec.md 同步声明仅保留触发入口。
- **正文死链**：指向真实仓库 `refactor-architecture-design/` 目标路径，sandbox 内失效，并入后生效，无需 sandbox 内修。
- **Overview 入口落点已裁决**（ADR-0022，2026-06-20）：入口 = sidebar「Overview」按钮，激活后覆盖 workspace（main）区，sidebar 持久。旧 demo `draft-layout-position.html`（顶栏 view-tab 方案）与项目根同名孤儿已删，由 `draft-entry.html` 取代。原 `overview/spec.md` vs `ui-skeleton.md` vs `workspace/spec.md` 三方冲突已收口。

## plugin-source/ 说明

`plugin-source/handoff-settings-system-mqkxcggz/` 是 Open Design「handoff → skill」**导出快照**（`open-design.json` 标 `od.kind: skill`），内容是**旧版 System（三块：语言外观/聊天显示/配色主题）**。与 `settings/handoff-system.md`（新版两块，draft 移除聊天显示）**冲突**。

- **作为导出产物归档**，非设计源；以 `settings/handoff-system.md` 为准。
- 若需基于最新 handoff 重新导出 skill，删除本目录后重跑导出。

## 历史归位记录（2026-06-20 已执行）

v3 设计稿 + 基础件已从 sandbox 归位到真实仓库：
- `adr-*.md` → `docs/architecture/adr/0018-0022`（重编号接续项目既有 0001-0017，全量更新交叉引用）
- `design-tokens.md` / `design-system.md` → `docs/page-design/`（根）
- 设计稿（spec.md + draft HTML）→ `docs/page-design/v3/`（本目录）
- `PRODUCT.md` 品牌章节 → 项目根 `PRODUCT.md`（已重写为冷蓝暗色人格）
- `CONTEXT.md` 术语 → `docs/architecture/context.md`（新增 v3 UI 结构术语章节）
- `terminology.md` R4/R5 → 标注过时（v3 推翻）

归位排除了 Open Design 元数据（`*.artifact.json`）和导出快照（`plugin-source/`）。
