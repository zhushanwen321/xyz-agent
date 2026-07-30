# UI 骨架总纲（Single Source of Truth）

> 方法论：recursive-skeleton。先立骨架（结构+职责+联动），再逐层 deepening。
> 所有后续 case HTML（flow-2-cases / flow-3-cases / 各模块设计页）都是这棵树的叶子。
> 决策依据：ADR-0018（冷蓝暗色）、ADR-0019（核心 user flow）、design-tokens.md。
>
> **⚠ 已知失同步（2026-06-19 登记）**：本文件 §3/§5 的「进程面板 Process Panel（★★最高优先级）」已被 `panel/spec.md` 决策推翻——**Process Panel v1 删除**，单 Session 进度走 composer 上方 `progress-zone`，多 SubAgent 编排推迟到 Flow-3（`flow-3-subagent/`）。本文件正文未清理，保留作历史记录，术语批量替换时一并处理（见 `v3/README.md` 术语映射表）。

## 1. 五层递归骨架

| 层 | 单位 | 回答的问题 | 交付物 |
|----|------|-----------|--------|
| **L0 Shell** | 窗口分区 | 整个窗口怎么切？哪些是持久区？ | 全屏骨架 HTML（空壳） |
| **L1 Region** | 功能区域 | 每个分区里有哪些并列区域？职责边界？ | 区域骨架（ASCII + 职责） |
| **L2 Module** | 模块 | 每个区域里有哪些模块？模块的输入/输出/状态？ | 模块设计页 |
| **L3 State** | 组件状态 | 每个模块的 case（default/hover/loading/empty/error…） | case HTML（flow-2-cases 已做一部分） |
| **L4 Linkage** | 联动 | 哪些模块和哪些模块联动？数据怎么流？ | 联动矩阵 + 时序图 |

**Deepening 规则**（P3）：挑「模块数最多 + 决策负载最高」的区域先深化。当前是 **Chat 主区**（消息流/composer/抽屉/进程面板四子区，模块最多）和 **Overview**（多 session，之前完全空白）。

## 2. 全局 Shell（L0）— 三种 view

应用有 3 个顶层 view，共用 Sidebar 容器，main 切换：

```
┌─────────────────────────────────────────────────────────────────┐
│ Sidebar 容器  │  main float-panel（flex-1，随 view 切换）       │
│ （透明融合）   │                                                 │
│  ┌──────────┐  │  ┌───────────────────────────────────────────┐ │
│  │ Logo     │  │  │ view = chat    → 主区（双Panel + 进程面板）│ │
│  │ 新建/搜索 │  │  │ view = overview→ 主区 Overview（多 session）   │ │
│  │[会话|文件]│  │  │ view = settings→ 主区 Settings             │ │
│  │ ↑tab切换 │  │  └───────────────────────────────────────────┘ │
│  │ 设置/用户 │  │                                                 │
│  └──────────┘  │                                                 │
└─────────────────────────────────────────────────────────────────┘

> Sidebar 是**容器**（非单列表）：顶部 Logo + 主操作 → segmented tab（会话 | 文件）互斥切换 → 子视图列表 → 底部设置/用户。搜索浮层（⌘K）属 Overlay 层，不在此容器内（见 overlays/）。完整容器四态见 `sidebar/draft-five-states.html`，规范见 `sidebar/spec.md`。
```

## 3. 区域-模块树（L0 → L2）

```
App Shell (L0)
├── Sidebar 容器（持久，所有 view 共用；完整四态见 sidebar/draft-five-states.html，规范见 sidebar/spec.md）
│   ├── Brand Logo
│   ├── 主操作区（新建任务 / 搜索 / 技能）
│   ├── segmented tab（会话 | 文件）★容器核心，互斥子视图切换
│   ├── 会话视图（项目分组 + 会话项 + 状态点 + 分支 pill）— tab=会话
│   ├── 文件视图（文件树 + 改动状态）— tab=文件
│   ├── 项目区（当前项目 + 切换）
│   └── 底部（模型设置入口 + 用户头像）
│
├── main: 主区 Workspace (L1) ★日常主路径，Flow 2+3 主场
│   ├── Chat Header（会话标题 + 模型 + 操作：分支/历史/导出/更多）
│   ├── 消息流区 (L2 模块)
│   │   ├── UserMessage（纯文本 + @-mention chip + 附件）
│   │   ├── AssistantMessage（Markdown 渲染 + 流式光标）
│   │   ├── ReasoningBlock（thinking 折叠 + 计时）
│   │   ├── ToolCallCard（读/写/搜索/命令，折叠+展开）
│   │   ├── ChangeSetCard ★（变更集聚合，5 状态机）
│   │   ├── ConfirmRequest（请求回应 tab，Flow 3 核心）
│   │   ├── SubAgentNode（TaskTree 节点，Flow 3 核心）
│   │   └── SystemNotice（错误/断网/完成提示）
│   ├── Composer 区 (L2 模块)
│   │   ├── 输入框（多行 + 自动高 + shift+enter）
│   │   ├── @-mention 浮层（文件/技能/agent 引用）
│   │   ├── 附件按钮（图片/文件拖拽）
│   │   ├── 模型切换 + 上下文指示
│   │   └── 发送/停止/中断
│   ├── 右抽屉区 (L2 模块) ★与消息流联动
│   │   ├── Diff Tab（文件 diff + Accept/Reject + 计数）
│   │   ├── Browser Tab（agent 浏览器预览）
│   │   ├── Terminal Tab（agent 终端输出）
│   │   ├── ChangeSet Detail（点变更集卡 → 展开详情）
│   │   └── SubAgent Detail（点 TaskTree 节点 → 展开子树）
│   └── 进程面板 (L2 模块) ★Flow 3 核心
│       ├── mini chip（收起态：并行/链式 + 进度）
│       └── 展开态（TaskTree 树形 + 节点状态 + steer/终止）
│
├── main: 主区 Overview (L1) ★之前完全空白
│   ├── 概览卡（今日任务数 / Token 消耗 / 活跃 agent）
│   ├── Session 网格（卡片视图 + 状态 + 最后消息 + 角标）
│   ├── Background Agent 区（后台任务 + 通知开关）
│   └── 活动时间线
│
└── main: 主区 Settings (L1) ★demo 已有，待评估
    ├── 模型配置（provider/key/参数）
    ├── 外观（主题/字体/密度）
    ├── 快捷键
    ├── MCP / 技能管理
    └── 关于
```

## 4. 模块联动矩阵（L4）— 谁和谁联动

| 触发模块 | 动作 | 联动模块 | 反应 |
|---------|------|---------|------|
| ChangeSetCard | 点击 | 右抽屉 Diff Tab | 抽屉打开 → 显示该变更集的文件 diff |
| ChangeSetCard | Accept All | Composer | 启用「继续对话」+ 上下文标记已落地 |
| ToolCallCard(写文件) | 出现 | ChangeSetCard | 变更集卡进入 accumulating 态 |
| ChangeSetCard | accumulating→ready | Chat Header | 角标显示「N 文件待审」 |
| SubAgentNode | 点击 | 右抽屉 SubAgent Detail | 抽屉显示该子树详情 |
| SubAgentNode | 请求确认 | ConfirmRequest + 进程面板 | 消息流插入 ConfirmRequest，面板该节点变 pending |
| ConfirmRequest | 用户回复 | SubAgentNode + 进程面板 | 节点恢复 running，面板进度更新 |
| 进程面板 mini chip | 展开 | 进程面板展开态 | 原位展开 TaskTree（不跳页） |
| 消息流 滚动 | 到底 | Chat Header | 「新消息」回跳按钮 |
| Session 列表 | 切换会话 | 整个主区 | 消息流/composer/抽屉全部重置 |
| 右抽屉 Diff Tab | Accept 文件 | ChangeSetCard | 该文件标已审，计数 -1 |

## 5. 已有 case 归属 + 待 deepening

| 已做（flow-2-cases.html） | 归属模块 | 状态 |
|--------------------------|---------|------|
| S1-S6 屏幕序列 | 主区整体时序 | ✅ Flow 2 |
| 变更集卡 5 状态 | ChangeSetCard | ✅ |
| 消息操作菜单 | UserMessage/AssistantMessage | ✅ |
| 7 边缘状态 | ChangeSetCard + Diff | ✅ |

| 待 deepening | 归属模块 | 优先级 |
|-------------|---------|--------|
| L0 Shell 空壳（本文件配套） | App Shell | ★本轮 |
| Composer 全 case（空/输入中/@浮层/附件/发送中/停止） | Composer | 高 |
| 右抽屉 4 tab 全 case（diff/browser/terminal/empty） | 右抽屉 | 高 |
| ~~进程面板（mini chip / 展开 / 并行 / 链式 / 请求回应 / steer / 终止 / 10+节点折叠）~~ | ~~进程面板~~ | ~~★★最高~~ → **v1 已删除**（见 panel/spec.md line 59/100；进度走 composer 上方 progress-zone，多 SubAgent 编排推迟 Flow-3） |
| ~~SubAgentNode + TaskTree 生长状态机~~ | ~~进程面板~~ | ~~★★最高~~ → **并入 Flow-3 subagent**（见 flow-3-subagent/spec.md + draft-cases.html） |
| Overview 全部模块 | 主区 Overview | 中（Flow 5） |
| Sidebar 全 case（会话状态点/分支 pill/搜索/项目切换） | Sidebar 容器 | 中 |
| Chat Header 全 case | Chat Header | 低 |

## Deepening 顺序建议

```
本轮:  L0 Shell 空壳（你正在看配套 HTML）
↓
推荐下一步: 进程面板 + TaskTree（Flow 3 核心，护城河，空白最多）
↓
        Composer + 右抽屉（日常主路径补全）
↓
        Overview + Sidebar（Flow 1/5 入口级）
```

每个 deepening 都产出「文字编织 md + 局部 case HTML」双件，跟 flow-2 的模式一致。
