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
import type { SessionGroup, SessionSummary, SessionViewSnapshot } from '@xyz-agent/shared'

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
   * 扁平索引（groups.flatMap 展平），供 active/applySnapshot 等按 id 查找。
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

  /**
   * 应用 owner 快照——session store 数据写入口（W13 收敛为唯一入口：原标签更新 /
   * 模型状态局部更新 / 整表载入三个写入口全部删除，D7：renderer 零派生）。
   *
   * 两种快照粒度，均以 runtime owner 实例为权威：
   * - 整表：config.sessions 广播 / session.list RPC 的全量分组投影，直接替换 groups 真源
   *   （整表语义，含分组增删与重排——单条快照无法表达）；
   * - 单 session：session.renamed / state_changed 广播 + 乐观更新本地入参，按 D1b 整字段
   * 覆盖合并进既有条目（未知 id 静默跳过）。
   *
   * 乐观更新形态：本地入参只带乐观字段（如 rename 先显示 { label }），权威确认经 runtime
   * 广播回流（config.sessions 整表 / state_changed 单条），同一入口重复写入幂等。
   *
   * [W15 挂点] 磁盘占位值守卫（扫描来源快照的 modelId:''/tokenCount:0 占位值不覆盖
   * 实例/广播真值）将接入 mergeViewSnapshot 合并策略——本 wave 仅收口挂点，守卫实现 W15 交付。
   */
  function applySnapshot(id: string, snapshot: SessionViewSnapshot): void
  function applySnapshot(listSnapshot: { groups: SessionGroup[] }): void
  function applySnapshot(
    idOrList: string | { groups: SessionGroup[] },
    snapshot?: SessionViewSnapshot,
  ): void {
    if (typeof idOrList !== 'string') {
      groups.value = idOrList.groups
      return
    }
    const target = list.value.find((s) => s.id === idOrList)
    if (!target) return
    mergeViewSnapshot(target, snapshot)
  }

  /**
   * D1b 合并：view 快照字段整字段覆盖到 SessionSummary 条目——显式提供的字段（值 !==
   * undefined）直接覆盖，含显式空值（owner 声明空即空，''/0 与真值一视同仁）；undefined =
   * 快照未涉及，保留现值。SessionViewSnapshot 的 view-ready 字段中 session store 只托管
   * 列表展示字段（label/status/modelId/thinkingLevel/tokenCount）；usagePercent/
   * pendingMessageCount/commands 等归各自消费 store（W15+ 收敛对象），不在本 store 落盘。
   *
   * [W15 挂点] 磁盘占位值守卫的唯一接入位置：守卫就位后，扫描来源快照的占位空值
   * （modelId:''/tokenCount:0）在此跳过覆盖，不侵蚀实例/广播真值（#2 空串覆盖事故防线）。
   */
  function mergeViewSnapshot(target: SessionSummary, snapshot: SessionViewSnapshot | undefined): void {
    if (!snapshot) return
    if (snapshot.label !== undefined) target.label = snapshot.label
    if (snapshot.status !== undefined) target.status = snapshot.status
    if (snapshot.modelId !== undefined) target.modelId = snapshot.modelId
    if (snapshot.thinkingLevel !== undefined) target.thinkingLevel = snapshot.thinkingLevel
    if (snapshot.tokenCount !== undefined) target.tokenCount = snapshot.tokenCount
  }

  /** 更新 session 归属 project（乐观更新，setProject RPC 后调用；广播全量覆盖幂等）。 */
  function updateProjectId(id: string, projectId: string): void {
    const target = list.value.find((s) => s.id === id)
    if (target) target.projectId = projectId || undefined
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

  return { groups, list, activeId, active, listLoadError, applySnapshot, setListLoadError, appendSession, updateProjectId, removeFromList, markDead, revive, getActiveId, setActiveId, getList }
}
