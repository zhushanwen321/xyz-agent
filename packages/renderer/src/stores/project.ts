/**
 * Project store —— v6 D14 Project 一级导航的状态层（2026-08-04 语义修正）。
 *
 * 职责：Project CRUD + activeProjectId 切换 + renderer localStorage 持久化。
 *
 * 关系模型（SSOT 见 shared/project.ts）：Project 直接关联 Session（session.projectId，
 * 创建时归属，runtime sidecar 持久化）。本 store 只管 project 列表本身，**不持有**
 * session 归属（无 workspaces 字段——cwd 只是前端展示聚合，不是模型层级）。
 *
 * Followup：
 *  - 持久化迁移到 runtime RPC（~/.xyz-agent/projects.json，跨设备/跨实例一致）。
 *
 * 历史：早期实现有 Project.workspaces[]（目录集合）+ addWorkspace/removeWorkspace，
 * 2026-08-04 按用户语义修正删除（workspace 是展示概念，不该进模型）。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { Project, ProjectStoreState } from '@xyz-agent/shared'

export const STORAGE_KEY = 'xyz-agent:projects'
export const DEFAULT_PROJECT_ID = 'proj-default'

/** 同毫秒内多次 addProject 的 id 去重（模块级自增，避免 Date.now() 碰撞）。 */
let projectSeq = 0

/** 从 localStorage 读初始态；损坏/空时回退单个默认 project（保证 UI 永远有项可显）。
 *  默认 project name 留空，由 ProjectSwitcher 渲染时 fallback 到 i18n defaultName。 */
function loadFromStorage(): ProjectStoreState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ProjectStoreState
      if (Array.isArray(parsed.projects) && parsed.projects.length > 0) {
        // 兼容旧持久化数据：Project.lastUsedAt 是后加字段，旧数据无该 key → 补 0（视为未用过）。
        // 旧数据可能含 workspaces 字段（2026-08-04 前模型）→ 剥掉（模型已无此字段）。
        return {
          projects: parsed.projects.map((p) => {
            const { workspaces: _legacy, ...rest } = p as Project & { workspaces?: unknown[] }
            return { ...rest, lastUsedAt: rest.lastUsedAt ?? 0 }
          }),
          activeProjectId: parsed.activeProjectId,
        }
      }
    }
  } catch (e) {
    // 损坏 JSON 忽略，回退默认（warn 便于排查，不影响功能）
    console.warn('[project-store] failed to parse projects from localStorage, falling back to default', e)
  }
  return {
    projects: [{ id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 }],
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

  /** 默认 project 判定（name 空 = 未命名默认 project）。默认项目是未归类 session 的兑底聚合。 */
  const isDefaultProject = computed(() => !activeProject.value.name)

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
    projectSeq += 1
    const id = `proj-${Date.now()}-${projectSeq}`
    projects.value.push({ id, name: trimmed, lastUsedAt: Date.now() })
    activeProjectId.value = id
    return id
  }

  /** 删除 project：移除；若删的是活跃则切到第一个；保底不删最后一个（UI 永远有项可显）。
   *  删除不影响已归属该 project 的 session（归属在 session sidecar，project 删除后这些
   *  session 在展示层落入默认项目聚合——projectId 匹配不到任何命名 project）。 */
  function removeProject(id: string): void {
    if (projects.value.length <= 1) return
    const idx = projects.value.findIndex((p) => p.id === id)
    if (idx === -1) return
    projects.value.splice(idx, 1)
    if (activeProjectId.value === id) {
      activeProjectId.value = projects.value[0]?.id ?? ''
    }
  }

  return { projects, activeProjectId, activeProject, isDefaultProject, recentProjects, setActiveProject, addProject, removeProject }
})
