/**
 * Project / Workspace 数据模型（v6 D14：Project 一级导航）。
 *
 * 三层结构：Project → Workspace → Session。
 *  - Project：用户的逻辑分组（如「多仓重构」「xyz-agent-dev」），可跨多个 repo workspace。
 *  - Workspace：目录实体（bare repo 下的 main checkout 或 worktree 分支目录）。
 *  - Session：现有 session 模型（当前按 cwd 分组），未来按 workspace.id 关联。
 *
 * 本次（UI + store 阶段）实现 ProjectSwitcher UI + project store（CRUD + renderer localStorage 持久化）。
 * Session 按 activeProject.workspaces 过滤分组（cwd 精确匹配）：默认 project（name 空）显示全部，
 * 命名 project 只显示其 workspaces 对应 cwd 的 session；新建 session 成功后自动归因 cwd 到
 * activeProject（create 成功即 addWorkspace）。
 *
 * 数据流（当前）：projectStore（localStorage）↔ ProjectSwitcher UI + SessionList 过滤 + 自动归因
 * 数据流（完整，followup）：runtime（~/.xyz-agent/projects.json）↔ projectStore ↔ ProjectSwitcher；
 *   workspace 管理 UI（手动添加/移除目录）
 */

/** 目录实体：bare repo 下的 main checkout 或 worktree 分支目录 */
export interface Workspace {
  id: string
  /**
   * 目录绝对路径（与 session.cwd 关联的唯一键）。
   * 自动归因（create 成功后）只填 cwd + dir；repo/branch/isMain 留给未来
   * workspace 管理 UI 经 workspace.detect 填充。
   */
  cwd: string
  /** 目录显示名，如 main/、feat-optimize-ui/（cwd basename） */
  dir: string
  /** 所属 repo 根名，如 xyz-agent-workspace */
  repo: string
  /** true = 主 checkout，false = worktree */
  isMain: boolean
  /** worktree 的分支名（isMain=false 时有值） */
  branch?: string
}

/** 用户逻辑分组：跨多个 repo workspace 的 session 集合 */
export interface Project {
  id: string
  name: string
  /** 该 project 下的 workspace 实例（按显示顺序） */
  workspaces: Workspace[]
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
