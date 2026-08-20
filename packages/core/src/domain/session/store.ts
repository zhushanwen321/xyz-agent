/**
 * Session store —— session 列表（core 域迁移版）。
 *
 * 来源：packages/renderer/src/stores/session.ts（pinia setup store）原样迁移为纯 factory。
 * 迁移约束（IF1）：不依赖 pinia；状态/操作函数语义逐条等价；消费方自行 .value（无 pinia unwrap）。
 * renderer 旧 store 保留，待消费方迁移（strangler 逐域绞杀 §11.2）完成后删除。
 *
 * 依赖方向：无（domain 间禁止互相 import；跨域协调由上层编排）。
 *
 * 注：session 的派生 5 态（D6 derivedStatus）不在此 store，由 useSidebar 派生
 * （它需同时读 chat store 的消息分区 + 全局 isStreaming，跨 store 协调属 composable 职责）。
 */
import { computed, ref } from 'vue'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

/**
 * 创建 session 列表 store（纯 factory，无 pinia 依赖）。
 *
 * 返回形状与原 pinia setup store 一致（ref/computed 原样返回）：
 * 消费方迁移时 storeToRefs 语义由显式 .value 取代。
 */
export function createSessionStore() {
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

  /**
   * 当前导航/启动语义的 session ID。不驱动 UI 高亮——UI 高亮由
   * useSidebar.focusedSessionId（panel store activePanelId → sessionId 派生）负责。
   * activeId 仅用于：removeFromList 删 active 回退判断、deleteSession 回退、
   * useNewTaskFlow landing/预建写入、AppShell 导航栈回溯。
   */
  const activeId = ref<string | null>(null)

  /**
   * 列表加载错误（S5：loadSessions 失败时设错误消息，SessionList 据此显示「加载失败，点击重试」）。
   * null = 无错误（未加载或加载成功）；非空字符串 = 加载失败的错误消息。
   */
  const listLoadError = ref<string | null>(null)

  const active = computed<SessionSummary | null>(
    () => list.value.find((s) => s.id === activeId.value) ?? null,
  )

  /** 更新 session label（乐观更新，rename 后调用） */
  function updateLabel(id: string, label: string): void {
    const target = list.value.find((s) => s.id === id)
    if (target) target.label = label
  }

  /** 更新 session 归属 project（乐观更新，setProject RPC 后调用；广播全量覆盖幂等）。 */
  function updateProjectId(id: string, projectId: string): void {
    const target = list.value.find((s) => s.id === id)
    if (target) target.projectId = projectId || undefined
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

  /**
   * 标记 session 为 dead 态（进程已退出）。
   * dead session 在侧栏置灰，panel 显示「进程已退出」占位，点击不触发 restore。
   */
  function markDead(id: string): void {
    const target = list.value.find((s) => s.id === id)
    if (target) target.status = 'dead'
  }

  /** 重置 session 为 idle（重开进程后调） */
  function revive(id: string): void {
    const target = list.value.find((s) => s.id === id)
    if (target && target.status === 'dead') target.status = 'idle'
  }

  /**
   * 载入分组列表（useSidebar.loadSessions 调用，单一写入入口）。
   *
   * [HISTORICAL] dead 态穿越刷新：runtime 在 pi 死亡时先广播 session.exited（markDead
   * 置 dead），同一回调末尾紧接全量广播 config.sessions（磁盘 outcome：done/stopped 等），
   * 两者数十 ms 内先后到达。dead 是运行时进程态（比磁盘 outcome 新），全量覆盖会把 dead
   * 冲回终态 → panel 的 dead 占位 UI 与「重新打开」入口永不渲染（dead 恒不可达）。
   * 故已 dead 的 session 在新列表中 status 非 dead 时保留 dead，仅显式 revive
   * （restoreSession 成功后）清除。新列表中不存在的 session 不保留（首 turn 无文件死亡的
   * 终结语义：随列表消失）。
   */
  function setGroups(next: SessionGroup[]): void {
    const deadIds = new Set(
      groups.value
        .flatMap((g) => g.sessions)
        .filter((s) => s.status === 'dead')
        .map((s) => s.id),
    )
    if (deadIds.size === 0) {
      groups.value = next
      return
    }
    groups.value = next.map((g) => ({
      ...g,
      sessions: g.sessions.map((s) =>
        deadIds.has(s.id) && s.status !== 'dead' ? { ...s, status: 'dead' } : s,
      ),
    }))
  }

  /** 设置列表加载错误消息（loadSessions 失败时调，null 清空） */
  function setListLoadError(msg: string | null): void {
    listLoadError.value = msg
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

  // ── 方法访问层（ADR-0059 决策 2）──
  // createUseSession 经这些 getter/action 访问响应式字段，不直访内部 ref（store 封装原则）。
  // 方法内部在 setup 闭包里 .value 访问自己的 ref——pinia setup store 会 unwrap 对外暴露的
  // ref/computed（外部拿到值非 ref），但方法闭包持原始 ref，.value 在 pinia/raw 双模式下都正常。
  // 故 createUseSession 经 cast 接缝注入 pinia store 后，方法访问仍正确工作。
  function getActiveId(): string | null {
    return activeId.value
  }
  function setActiveId(id: string | null): void {
    activeId.value = id
  }
  function getList(): SessionSummary[] {
    return list.value
  }

  return { groups, list, activeId, active, listLoadError, setGroups, setListLoadError, appendSession, updateLabel, updateProjectId, updateSessionState, removeFromList, markDead, revive, getActiveId, setActiveId, getList }
}
