# Handoff · overview · overview

## 1. 路径
- 目录：`v3-demo/overview/`（★ 目录待建）
- 文件：`draft-overview.html`（★ 待做）
- 层级：L1 Region · Overview（多 session 鸟瞰大图，**独立 Region**）
- 上游：`ui-skeleton.md`（OverviewView 之前完全空白，模块最多）/ `architecture-and-terminology.html`（Overview = Mission Control）

## 2. 产物 HTML 规范
- standalone 单文件，内联 CSS，冷蓝 token
- session 卡片网格（每 session 一张卡），信息密集鸟瞰
- **定位**：统筹/监控用（适合 10+ session 或看后台 agent），区别于 Sidebar Session List 的导航/切换（适合 3-5 session 日常）

## 3. 要做的事情
- [ ] session 卡片：标题 / 状态 / 最后活动 / 后台 agent 进度
- [ ] 筛选（状态/项目）+ 排序（最近/活跃）
- [ ] 新建会话入口（卡片网格顶部）
- [ ] 卡片点击 → 切回 workspace 载入该 session
- [ ] **⚠️ 层级矛盾裁决**（上轮已定）：ui-skeleton 把 Overview 当 workspace 内 view，术语表当独立 Region —— 按**独立 Region** 定，入口可从 workspace 顶部/快捷键进（层级 vs 触发路径不矛盾）

## 4. 关联文档
- 上游：`ui-skeleton.md`（line 74 OverviewView + line 120 Flow 5）/ `architecture-and-terminology.html`（Overview 定义 + 独立 Region 裁决）
- 同层：`sidebar/draft-session-item`（卡片信息源同 Session Item，可复用组件）
- 下游：`workspace/spec.md`（点卡片 → 双 Panel 载入）

## 5. 关联 HTML
- 参考：`sidebar/draft-five-states.html`（Session List 紧凑态，Overview 是其鸟瞰放大版）
- 集成点：L1 Region，与 Sidebar/Workspace 并列；入口经 workspace 顶部或快捷键

## 6. 验收（P0）
- [ ] session 卡片信息齐全（标题/状态/活动/agent 进度）
- [ ] 筛选 + 排序可用
- [ ] 卡片点击切回 workspace
- [ ] 与 Session List 分工明确（鸟瞰 vs 导航），不重复
- [ ] 冷蓝 token 一致

## 7. Suggested skills
- `frontend-design`（卡片网格 + 筛选）
- `impeccable`（信息密度 review）
- 注：优先级低（入口级，等 panel 核心深化完再做）
