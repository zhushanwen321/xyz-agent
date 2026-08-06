/**
 * Project store —— v6 D14 Project 一级导航的状态层。
 *
 * 职责：Project CRUD + activeProjectId 切换 + workspace 归因（addWorkspace/removeWorkspace）
 *        + renderer localStorage 持久化。
 *
 * 本次范围（UI + store 阶段）：
 *  - 持久化用 localStorage（renderer 侧轻量持久化，数据不跨设备）。
 *  - session 按 activeProject.workspaces 过滤分组已接入（SessionList 消费 activeWorkspaceCwds）。
 *  - 自动归因：新建 session 成功后把 cwd 加入 activeProject（useNewTaskFlow 编排）。
 *
 * Followup（完整阶段）：
 *  - 持久化迁移到 runtime RPC（~/.xyz-agent/projects.json，跨设备/跨实例一致）。
 *  - workspace 管理 UI（手动添加/移除目录到 project；现有自动归因覆盖新建路径）。
 *  见 ProjectSwitcher.vue 内 TODO。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { Project, ProjectStoreState } from '@xyz-agent/shared'

const STORAGE_KEY = 'xyz-agent:projects'
const DEFAULT_PROJECT_ID = 'proj-default'

/** 从 localStorage 读初始态；损坏/空时回退单个默认 project（保证 UI 永远有项可显）。
 *  默认 project name 留空，由 ProjectSwitcher 渲染时 fallback 到 i18n defaultName。
 *  Workspace 兼容：旧持久化数据可能含无 cwd 的 workspace（模型升级前）→ 过滤掉（无关联键无效）。 */
function loadFromStorage(): ProjectStoreState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ProjectStoreState
      if (Array.isArray(parsed.projects) && parsed.projects.length > 0) {
        // 兼容旧持久化数据：Project.lastUsedAt 是后加字段，旧数据无该 key → 补 0（视为未用过）
        return {
          projects: parsed.projects.map((p) => ({ ...p, lastUsedAt: p.lastUsedAt ?? 0 })),
          activeProjectId: parsed.activeProjectId,
        }
      }
    }
  } catch (e) {
    // 损坏 JSON 忽略，回退默认（warn 便于排查，不影响功能）
    console.warn('[project-store] failed to parse projects from localStorage, falling back to default', e)
  }
  return {
    projects: [{ id: DEFAULT_PROJECT_ID, name: '', workspaces: [], lastUsedAt: 0 }],
    activeProjectId: DEFAULT_PROJECT_ID,
  }
}

export const useProjectStore = defineStore('project', () => {
  const init = loadFromStorage()
  const projects = ref<Project[]>(init.projects)
  const activeProjectId = ref<string>(init.activeProjectId)

  /** 当前活跃 project（id 失配时回退首个，保证非空） */
  const activeProject = computed<Project>(
    () => projects.value.find((p) => p.id === activeProjectId.value) ?? projects.value[0],
  )

  /**
   * 按「最近使用」排序的 project 列表（供 ProjectSwitcher 列表渲染）。
   *
   * 排序规则：
   *  1. activeProject 强制第一（用户当前/上次最后关注的项目，无论 lastUsedAt 值）；
   *  2. 其余按 lastUsedAt 降序（最新在前）；
   *  3. lastUsedAt 相同（如旧数据升级全 0）时保持原数组顺序（稳定兜底）。
   *
   * activeProject 永远第一的设计同时解决两件事：
   *  - 正常态：刚切换/新建的 project 既是 active 又是 lastUsedAt 最新，二者吻合；
   *  - 兜底态（旧数据全 0）：active 仍是上次最后用的，排第一符合直觉。
   */
  const recentProjects = computed<Project[]>(() => {
    const activeId = activeProjectId.value
    const active = projects.value.find((p) => p.id === activeId)
    const rest = projects.value.filter((p) => p.id !== activeId)
    // 稳定排序：用原 index 做 tiebreaker，保证 lastUsedAt 相同时不乱序
    const indexed = rest.map((p, i) => ({ p, i }))
    indexed.sort((a, b) => {
      const diff = b.p.lastUsedAt - a.p.lastUsedAt
      return diff !== 0 ? diff : a.i - b.i
    })
    const sortedRest = indexed.map((x) => x.p)
    return active ? [active, ...sortedRest] : sortedRest
  })

  /** localStorage 持久化（deep watch；写入失败如隐私模式/配额超限忽略） */
  watch(
    [projects, activeProjectId],
    () => {
      try {
        const state: ProjectStoreState = {
          projects: projects.value,
          activeProjectId: activeProjectId.value,
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      } catch (e) {
        // 配额超限 / 隐私模式忽略（project 数据非关键，丢失可重建）
        console.warn('[project-store] failed to persist projects to localStorage', e)
      }
    },
    { deep: true },
  )

  function setActiveProject(id: string): void {
    const target = projects.value.find((p) => p.id === id)
    if (target) {
      // 切换即「最近使用」：更新时间戳，驱动 recentProjects 排序 + 持久化（deep watch）
      target.lastUsedAt = Date.now()
      activeProjectId.value = id
    }
  }

  /** 新建 project：生成 id、push、设为活跃。返回新 id；空名不创建。 */
  function addProject(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) return activeProjectId.value
    const id = `proj-${Date.now()}`
    projects.value.push({ id, name: trimmed, workspaces: [], lastUsedAt: Date.now() })
    activeProjectId.value = id
    return id
  }

  /** 删除 project：移除；若删的是活跃则切到第一个；保底不删最后一个（UI 永远有项可显）。 */
  function removeProject(id: string): void {
    if (projects.value.length <= 1) return
    const idx = projects.value.findIndex((p) => p.id === id)
    if (idx === -1) return
    projects.value.splice(idx, 1)
    if (activeProjectId.value === id) {
      activeProjectId.value = projects.value[0]?.id ?? ''
    }
  }

  /**
   * 当前 activeProject 的 workspace cwd 集合（SessionList 过滤依据）。
   * 默认 project（name 空）返回空数组——但其过滤语义由消费方区分：
   * name 空 → 显示全部 session（未归类聚合）；命名 project → 只显示匹配 cwd 的 session。
   * 兼容旧数据：无 cwd 的 workspace 过滤掉（无关联键无效）。
   */
  const activeWorkspaceCwds = computed<string[]>(() =>
    activeProject.value.workspaces
      .map((w) => w.cwd)
      .filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0),
  )

  /** 默认 project 判定（name 空 = 未命名默认 project，语义为「未归类聚合」） */
  const isDefaultProject = computed(() => !activeProject.value.name)

  /**
   * 把目录归入 activeProject（自动归因入口：新建 session 成功后调用）。
   * 按 cwd dedup（同目录不重复添加）；只在命名 project 上生效（默认 project 显示全部，无需归因）。
   * @returns true = 新增归因；false = 已存在 / 默认 project / cwd 无效
   */
  function addWorkspace(cwd: string): boolean {
    const target = activeProject.value
    if (!cwd || !target.name) return false
    if (target.workspaces.some((w) => w.cwd === cwd)) return false
    target.workspaces.push({
      id: `ws-${Date.now()}-${target.workspaces.length}`,
      cwd,
      dir: cwd.split('/').filter(Boolean).pop() ?? cwd,
      repo: '',
      isMain: false,
    })
    return true
  }

  /** 从 activeProject 移除目录（手动管理 UI 预留；自动归因不触发移除）。 */
  function removeWorkspace(cwd: string): void {
    const target = activeProject.value
    const idx = target.workspaces.findIndex((w) => w.cwd === cwd)
    if (idx !== -1) target.workspaces.splice(idx, 1)
  }

  return {
    projects,
    activeProjectId,
    activeProject,
    recentProjects,
    activeWorkspaceCwds,
    isDefaultProject,
    addWorkspace,
    removeWorkspace,
    setActiveProject,
    addProject,
    removeProject,
  }
})
