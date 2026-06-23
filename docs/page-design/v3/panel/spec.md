# Panel · 工作面板（设计单元 spec）

> 层级 **L1** · Workspace 子区 · 承载一个 Session 的完整工作载体
> 配套 draft（待做）：`draft-composer-states` / `draft-companion-zones` / `draft-detail-pane`（message-stream 规则与交互已统一并入 `draft-message-stream` §4 附录）
> 上游规范：`../architecture-and-terminology.html` §1 术语表、`../workspace/spec.md`（已定主从 / 内嵌 zone）、`../ui-skeleton.md`（L0-L4 总纲）

## 本 spec 要收口的冲突

两份上游文档对同一块主区给了两套结构，必须统一：

| 维度 | `ui-skeleton.md`（旧） | `workspace/spec.md`（新） | 本 spec 裁决 |
|---|---|---|---|
| 区域名 | `ChatView`（L1） | `Workspace` 内的 `Panel` | **Workspace = 容器，Panel = 工作载体**（术语表 §1 已定）。`ChatView` 废弃，待统一 |
| 模式 | 单主区（隐含单 Panel） | 双 Panel 主从 | **单 Panel 是默认态；开第二个 session 才 split 成双**（见下状态机） |
| 进度区 | 独立子区「进程面板」 | `progress-zone` 内嵌 composer 上方 | **内嵌方案胜出**（workspace spec 已论证废弃浮层） |
| 右抽屉 | Panel 内第四子区 | Side Drawer 浮层覆盖对侧 | **Side Drawer 归 Panel 联动**（数据强耦合），固定挂触发 Panel，不跨 Panel 覆盖 |

> 注：`ui-skeleton.md` 正文仍用 `ChatView`，术语替换待首个 draft 定稿后批量执行（见 README 映射表）。本 spec 之后所有 Panel 相关稿件统一用规范术语。

## 核心裁决 · Panel 内部结构（5 个固定 zone）

无论单 / 双，一个 Panel 内部由固定 5 个 zone 自上而下排列：

```
┌─ Panel ────────────────────────────────┐
│ ① panel-header      per-session 元信息    │
│ ② message-stream    消息流 + 回合折叠        │ ← draft-message-stream
│ ③ progress-zone     单 Session 进度          │ ← draft-companion-zones
│ ④ composer          输入区+工具区 / steer     │ ← draft-composer-states
│ ⑤ git-zone          暂存 / 提交 / Diff 入口   │ ← draft-companion-zones
└──────────────────────────────────────────┘
```

**panel-header 含 split + 新建会话两按钮**（同槽位互斥）— 单 Panel 时显「分屏」（开第二 session），双 Panel 时分屏隐藏、改显「新建会话」（替换待机侧为新 session 并聚焦）。不允许多于 2 个 panel。无工作区级横跨 header（每 panel 只有一个 header，所有操作落 per-session header）。

**message-stream · 回合折叠机制**（核心呈现规则）：

AI 一次「工作回合」= 从开始工作到停止（自然完成 / 被 stop）。回合默认折叠，只显示：
1. **Summary**（stop 前总结）— Agent 行为契约：每轮停止前必须输出结构化总结（做了什么 + 改了哪些文件 + 下一步）。
2. **File Changes**（文件变更清单）— 本回合改动的文件（新增/修改/删除 + 行数）。

其余内容（reasoning / tool calls / 中间 assistant 文字）折叠为一条：

> 已工作 3m 24s · 5 reasoning · 12 tool（Pill 计数，点击展开完整时序）

展开后按真实时序还原所有块；单个长块（如 reasoning）可独立再折叠。

**composer · 输入区 + 工具区视觉一体**：

- 上：多行输入区
- 下：工具条（`+ 添加内容` · 上下文状态 · 模型 · thinking-level · 发送）—— 与输入区视觉一体（同一卡片底，无强分隔线）
- **steer / followup 提交态**：消息已提交未进入对话流时，composer 顶部显 pending 气泡（steer = AI 工作中排队引导，不打断；followup = AI 完成后开新一轮）。进入 message-stream 后气泡消失。

**Side Drawer（归 Panel 联动，header 多 tab 通用容器）**：抽屉 = 一个 header 多 tab 容器，tab 承载不同实体（文件×N / 终端 / 子Agent / 浏览器…），**而非单实体的视图切换**。**Diff/预览 下沉为文件 tab 内部 view-toggle**（detail-pane 范式为准）。类型枚举 Diff（审批）/ Browser / Terminal / ChangeSet Detail / SubAgent Detail 是 tab 内容分类，不是独立浮层。与 Panel 数据强耦合，从触发它的 Panel 内浮起，**固定挂该 Panel，不跨 Panel 覆盖对侧**（跨 Panel 行为 v1 不做）。

**被移出 Panel 的组件**（归 Overlay 级）：

- **Search Modal (⌘K)** — 全局 Overlay。
- ~~**Process Panel**（SubAgent 编排树）~~ — **v1 删除**。单 Session 进度走 `progress-zone`；多 SubAgent 编排呈现推迟到 Flow-3（subagent）阶段，v1 不做独立编排面板。

## 单 / 双 Panel 状态机

```
            开第二个 session
  单 Panel ──────────────────→ 双 Panel（主从）
  (撑满 Workspace)                │  active / standby
        ↑                         │
        └── 关闭至单 session ──────┘
```

- **默认 = 单 Panel**：Panel-1 撑满整个 Workspace，无 Panel-2。这是 90% 日常态。
- **双 Panel = 主从而非对等**：同一时刻只有一个 active panel 真干活，另一个 standby / 参考。active panel 的对话区永不被压缩遮挡（workspace/spec.md 已定）。
- **双模式差异**（仅这 3 点变化，其余 zone 行为同单 Panel）：

| 行为 | 单 Panel | 双 Panel |
|---|---|---|
| 激活标识 | 无（唯一 panel） | 四层叠加 ring / bg / opacity（workspace spec 已定） |
| Side Drawer 方向 | 从右滑出 | active-1 从右覆盖 panel-2；active-2 从左覆盖 panel-1 |
| 非 active 对话区 | — | opacity 0.5，hover 回升 0.78 |

## draft 骨架（本单元 4 个叶子，骨架先立）

| draft | 目的 | 覆盖状态 | 空缺 / 未决 | 联动出口 |
|---|---|---|---|---|
| `draft-message-stream` | 消息流块类型 + 回合折叠 + 交互态 | 7 类块（user / output-text / reasoning / tool / file-changes / steer·followup / system）；回合默认折叠（显收尾 output + file-changes）；靠右气泡 / 已工作按钮 / 流式 / 失败红框 | 收尾 output 契约归 runtime（恒存在） | file-changes→Side Drawer Diff；subagent→Side Drawer Detail（非 Process Panel） |
| `draft-composer-states` | composer 状态 + 输入/工具区一体 | 空 / 输入中 / @浮层 / 附件 / 发送中 / 停止 / **steer / followup（pending）** | @浮层上下文项、工具区（+添加/上下文/模型/thinking-level/发送）布局 | steer·followup→message-stream pending 气泡；发送→message-stream 追加 |
| `draft-companion-zones` | progress-zone + git-zone 全状态（合并：都内嵌 composer 上下，强耦合） | progress: 待办 / 进行 / 完成 / 阻塞；git: 干净 / 已暂存 / 有 diff / 冲突 | 进度条粒度、git 冲突态视觉 | progress→Process Panel 展开；git Diff→Side Drawer |
| `draft-detail-pane` | **Side Drawer header 多 tab 范式范本**（抽屉通用结构） | 文件×N tab（内含 Diff/预览 view-toggle）+ 子Agent tab；空态；反向联动 | Tab 切换动效 | 反向联动 message-stream 高亮源块；范式已被 workspace/draft-dual-panel 的 diff-drawer 复用（审批型：文件×N + 终端 + 底部审批栏） |

## 继承的已定决策（不重复论证，引自 workspace/spec.md）

- 主从而非对等（双 panel 同时活跃时附属信息覆盖对侧是已知限制）
- 进度区 = composer 上下内嵌 zone（废弃浮层 card 方案）
- 四层激活标识（inset ring / bg / opacity，中缝不打架）
- diff 抽屉仍是浮层（内嵌化需单独设计，v1 不做）

## 已决项（本轮收口）

1. ~~全局工作区操作的家~~ — **已定**：split + 新建会话均归 panel-header（同槽位互斥：单 panel 显 split、双 panel 显新建会话）。无工作区级横跨 header。
2. ~~Process Panel~~ — **v1 删除**。多 SubAgent 编排呈现推迟到 Flow-3（subagent）阶段。
3. ~~Side Drawer 归属~~ — **已定归 Panel 联动**，固定挂触发 Panel，不跨 Panel 覆盖。

## 未决项（仍开放）

1. ~~**Side Drawer 浮起形态**~~ — **已定**（detail-pane handoff 裁决）：workspace-body 级 absolute；单 session 收窄并排（不盖对话区）/ 双 session 覆盖对侧（已知限制）。宽度半宽，diff 横向偏挤后续可考虑全工作区覆盖。
2. **Summary 契约落点** — Agent 停止前必输出总结，是 PRODUCT 行为契约还是 Panel 渲染约定？需在 PRODUCT.md 落契。
3. **折叠态记忆** — 用户展开某回合后刷新是否保持？需 localStorage 策略。
