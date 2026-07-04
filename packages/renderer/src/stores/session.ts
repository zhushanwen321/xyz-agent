/**
 * Session store —— session 列表。
 *
 * 依赖方向：无（stores 间禁止互相 import；跨 store 协调由 composables/features 做）。
 *
 * 注：session 的派生 5 态（D6 derivedStatus）不在此 store，由 useSidebar 派生
 * （它需同时读 chat store 的消息分区 + 全局 isStreaming，跨 store 协调属 composable 职责）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

export const useSessionStore = defineStore('session', () => {
  /**
   * 分组视图（按 cwd，对齐后端 SessionGroup[]，D7）。
   * 由 useSidebar.loadSessions 从 sessionApi.list() 填入；SessionList 按此渲染组标题 + 组内项。
   */
  const groups = ref<SessionGroup[]>([])

  /**
   * 扁平索引（groups.flatMap 展平），供 active/updateLabel/updateSessionState 等按 id 查找。
   * 派生自 groups：单一真源（groups）→ 扁平视图（list），避免两处分别维护导致漂移。
   */
  const list = computed<SessionSummary[]>(() =>
    groups.value.flatMap((g) => g.sessions),
  )

  const activeId = ref<string | null>(null)

  const active = computed<SessionSummary | null>(
    () => list.value.find((s) => s.id === activeId.value) ?? null,
  )

  /** 更新 session label（乐观更新，rename 后调用） */
  function updateLabel(id: string, label: string): void {
    const target = list.value.find((s) => s.id === id)
    if (target) target.label = label
  }

  /**
   * 更新 session 的模型/思考等级状态（session.state_changed 广播驱动）。
   * 局部更新，非全量 setGroups —— 模型切换后 runtime 推送新 modelId/thinkingLevel，
   * 前端据此同步 Composer 工具条，不触发整表覆盖（避免磁盘 session 的 '' modelId 覆盖真值）。
   * patch 中 undefined 字段跳过（不更新）。
   */
  function updateSessionState(id: string, patch: { modelId?: string; thinkingLevel?: string }): void {
    const target = list.value.find((s) => s.id === id)
    if (!target) return
    if (patch.modelId !== undefined) target.modelId = patch.modelId
    if (patch.thinkingLevel !== undefined) target.thinkingLevel = patch.thinkingLevel
  }

  /**
   * 从分组移除 session；移空组时连同组移除（不留空组标题）。
   * 若移除的是 active，回退到列表首项。
   */
  function removeFromList(id: string): void {
    groups.value = groups.value
      .map((g) => ({ ...g, sessions: g.sessions.filter((s) => s.id !== id) }))
      .filter((g) => g.sessions.length > 0)
    if (activeId.value === id) {
      activeId.value = list.value[0]?.id ?? null
    }
  }

  /** 载入分组列表（useSidebar.loadSessions 调用，单一写入入口） */
  function setGroups(next: SessionGroup[]): void {
    groups.value = next
  }

  /** 追加单个新建 session（按 cwd 归组：命中已有组则入尾，否则新建组在末尾） */
  function appendSession(s: SessionSummary): void {
    const group = groups.value.find((g) => g.cwd === s.cwd)
    if (group) {
      group.sessions.push(s)
    } else {
      groups.value = [...groups.value, { cwd: s.cwd, sessions: [s] }]
    }
  }

  return { groups, list, activeId, active, setGroups, appendSession, updateLabel, updateSessionState, removeFromList }
})
