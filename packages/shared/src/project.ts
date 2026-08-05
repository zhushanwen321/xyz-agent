/**
 * Project / Workspace 数据模型（v6 D14：Project 一级导航）。
 *
 * 三层结构：Project → Workspace → Session。
 *  - Project：用户的逻辑分组（如「多仓重构」「xyz-agent-dev」），可跨多个 repo workspace。
 *  - Workspace：目录实体（bare repo 下的 main checkout 或 worktree 分支目录）。
 *  - Session：现有 session 模型（当前按 cwd 分组），未来按 workspace.id 关联。
 *
 * 本次（UI + store 阶段）实现 ProjectSwitcher UI + project store（CRUD + renderer localStorage 持久化）。
 * Session 按 activeProject.workspaces 过滤分组的改造（替代当前按 cwd 分组）作为 followup，
 * 见 ProjectSwitcher.vue 内 TODO。
 *
 * 数据流（当前）：projectStore（localStorage）↔ ProjectSwitcher UI
 * 数据流（完整，followup）：runtime（~/.xyz-agent/projects.json）↔ projectStore ↔ ProjectSwitcher；
 *   sessionStore 按 activeProject.workspaces 过滤分组
 */

/** 目录实体：bare repo 下的 main checkout 或 worktree 分支目录 */
export interface Workspace {
  id: string
  /** 目录显示名，如 main/、feat-optimize-ui/ */
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
}

/** project store 持久化结构（localStorage / 未来 runtime projects.json） */
export interface ProjectStoreState {
  projects: Project[]
  activeProjectId: string
}
