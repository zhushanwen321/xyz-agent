/**
 * Project 数据模型（v6 D14：Project 一级导航，2026-08-04 语义修正）。
 *
 * ## 关系模型（重要，SSOT）
 *
 * ```
 * Project（用户逻辑分组，跨任意多个目录）
 *   └── 直接关联 Session（session.projectId，创建时归属）
 *
 * cwd（session 属性）→ 仅前端展示聚合（侧栏按目录分组），与 Project 无层级关系
 * ```
 *
 * - **Project**：用户管理的逻辑分组（如「多仓重构」「xyz-agent-dev」）。一个 project
 *   可以跨多个目录做事——用户为了这个 project 服务，可以在任何目录下开 session。
 * - **Session**：关联主体。session 创建时归属当前 activeProject（`session.projectId`），
 *   与 session 的 cwd 无关。projectId 为空（历史 session / 未归类）在展示层归入
 *   默认项目（proj-default 兜底聚合）。
 * - **cwd 不是层级**：侧栏 session 列表按 cwd 分组只是前端展示聚合（SessionGroup 机制），
 *   不存在 Workspace 实体。~~Project → Workspace → Session 三层结构~~ 已废弃（2026-08-04
 *   语义修正：workspace 是展示概念，不该进模型）。
 *
 * 持久化：project 列表存 renderer localStorage（未来迁移 runtime RPC projects.json）；
 * session 归属存 runtime sidecar `<sessionFile>.project.json`（磁盘权威，删除 session
 * 归属自动消失，fork 继承父归属）。
 *
 * 历史背景：早期实现把 Workspace 物化成 Project.workspaces[]（目录集合）并用 cwd 匹配
 * 过滤 session，后按用户语义修正为 session 直接关联。教训：展示聚合概念不要物化成模型。
 */
export interface Project {
  id: string
  name: string
  /** 最后活跃时间戳（ms）。0 = 未用过。
   *
   * setActiveProject(id) 切换 / addProject(name) 新建时更新为 Date.now()。
   * loadFromStorage 用 `p.lastUsedAt ?? 0` 兼容旧持久化数据（无该字段视为未用过）。
   * 用于 recentProjects 排序（降序，最新在前）。 */
  lastUsedAt: number
}

/** project store 持久化结构（localStorage / 未来 runtime projects.json） */
export interface ProjectStoreState {
  projects: Project[]
  activeProjectId: string
}
