/**
 * Project store —— v6 D14 Project 一级导航的状态层。
 *
 * 职责：Project CRUD + activeProjectId 切换 + renderer localStorage 持久化。
 *
 * 本次范围（UI + store 阶段）：
 *  - 持久化用 localStorage（renderer 侧轻量持久化，数据不跨设备）。
 *  - session 按 activeProject.workspaces 过滤分组尚未接入（当前 session 仍按 cwd 分组）。
 *
 * Followup（完整阶段）：
 *  - 持久化迁移到 runtime RPC（~/.xyz-agent/projects.json，跨设备/跨实例一致）。
 *  - sessionStore 接入 activeProject.workspaces 做分组过滤。
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
 *  默认 project name 留空，由 ProjectSwitcher 渲染时 fallback 到 i18n defaultName。 */
function loadFromStorage(): ProjectStoreState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ProjectStoreState
      if (Array.isArray(parsed.projects) && parsed.projects.length > 0) {
        return parsed
      }
    }
  } catch (e) {
    // 损坏 JSON 忽略，回退默认（warn 便于排查，不影响功能）
    console.warn('[project-store] failed to parse projects from localStorage, falling back to default', e)
  }
  return {
    projects: [{ id: DEFAULT_PROJECT_ID, name: '', workspaces: [] }],
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
    if (projects.value.some((p) => p.id === id)) {
      activeProjectId.value = id
    }
  }

  /** 新建 project：生成 id、push、设为活跃。返回新 id；空名不创建。 */
  function addProject(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) return activeProjectId.value
    const id = `proj-${Date.now()}`
    projects.value.push({ id, name: trimmed, workspaces: [] })
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

  return { projects, activeProjectId, activeProject, setActiveProject, addProject, removeProject }
})
