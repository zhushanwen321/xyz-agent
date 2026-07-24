/**
 * useSideDrawer —— SideDrawer 打开/钉住/tab 状态控制（per-session 分区，ADR-0040）。
 *
 * 架构演进（ADR-0040）：isOpen/activeTab/docked 从全局模块级单例 ref 改为 per-session
 * Map 分区（useSessionScopedState），分区键 focusedSessionId（panel store 派生：
 * active panel 绑定的 sessionId）。
 *
 * 动机：原全局单例与 SideDrawer 物理跟随 active panel 的语义割裂，导致：
 *  1. 跨 session 干扰——后台 session 的 todo/goal 事件无 sid 守卫强行弹 drawer
 *  2. 切回不恢复——drawer 开关态不随 session 记忆，切回是上个 session 残留
 *
 * 现状（per-session）：
 *  - 切 session 切分区，切回恢复该 session 的完整 drawer 形态（isOpen/activeTab/docked）
 *  - 事件驱动打开（openTasksDrawerOnFirstData）加 sid 守卫：sid !== focusedSessionId 时
 *    只置 pendingOpen[sid]=true，不直接 open；selectSession 切回时 consumePendingOpen 消费
 *  - 手动 open（任意 tab）即清当前 session 的 pendingOpen（用户已注意，不再打扰）
 *  - tasks tab 强制 docked 副作用收进分区内，不污染其他 session
 *
 * 不分区的状态：selectedCommandName / detailFilePath 是打开时的瞬时参数（消费后清空），
 * 不构成 session 级持久状态；Doc/Detail tab 内容已 per-session（SideDrawer.vue 内）。
 *
 * 单实例（Q2=A 单例）：SideDrawer 提升到 PanelContainer（workspace-body）层，单实例跟随
 * active panel。双 panel standby 无独立 drawer 状态——切到 standby（变 active）时其 session
 * 分区状态自然显示（drawer 物理只有一份）。
 *
 * 依赖方向：panel store（读 focusedSessionId 作分区键）。不触碰 session store / api。
 * widget 订阅在 SideDrawer.vue 内按 sessionId 独立接入；git 数据由 PanelContainer provide。
 */
import { ref, computed } from 'vue'
import { useSessionScopedState, registerSessionCleanup } from '@/composables/useSessionScopedState'
import { usePanelStore } from '@/stores/panel'

export type SideDrawerTab = 'terminal' | 'browser' | 'git' | 'doc' | 'detail' | 'tasks'

/** drawer open 的可选参数：打开时指定要展示的 slash 命令名（Doc tab）/ 文件路径（Detail tab） */
export interface OpenDrawerOptions {
  /** Doc tab 当前展示的命令名（如 '/commit'），CommandDocPanel 据此 + commandStore/skills 解析文档 */
  commandName?: string
  /** Detail tab 打开后立即展示的文件路径（变更集卡点击文件行时传入，强制 diff 模式） */
  filePath?: string
}

/** per-session 控制态（ADR-0040 Map 分区） */
interface DrawerControlState {
  isOpen: boolean
  activeTab: SideDrawerTab
  docked: boolean
}

/** 新 session 的默认控制态 */
function createDefaultControlState(): DrawerControlState {
  return { isOpen: false, activeTab: 'terminal', docked: false }
}

// ── per-session 分区状态（useSessionScopedState）──
// 分区键 focusedSessionId 来自 panel store（active panel 的 sessionId），与 SideDrawer
// 物理挂载归属一致。lazy 调 usePanelStore()（computed 首次求值时 pinia 已 active，
// 避免模块加载期 pinia 未初始化）。init 返回 reactive 容器（响应式契约：update mutate 时下游 computed 失效）。
const focusedSessionId = computed<string | null>(() => usePanelStore().focusedSessionId)

const controlState = useSessionScopedState<DrawerControlState>(
  focusedSessionId,
  createDefaultControlState,
)

// ── pendingOpen：事件驱动打开的 sid 守卫标记（独立 Map，不复用 per-session isOpen）──
// 语义：某 session 有「未展示给用户的 tasks 到达事件」。sid !== focusedSessionId 时事件
// 不直接 open，只置此标记；selectSession 切回时 consumePendingOpen 消费（open tasks + 清标记）。
// 用户手动 open（任意 tab）即清当前 session 标记（FR-9：已注意，不再打扰）。
const pendingOpenMap = new Map<string, boolean>()

/** 置某 session 的 pendingOpen 标记（openTasksDrawerOnFirstData 调，sid 守卫不通过时） */
export function setPendingOpenForSid(sid: string): void {
  pendingOpenMap.set(sid, true)
}

/** 查询某 session 的 pendingOpen 标记（测试 / 调试用） */
export function getPendingOpenForSid(sid: string): boolean {
  return pendingOpenMap.get(sid) ?? false
}

/** 清某 session 的 pendingOpen 标记 */
function clearPendingOpenForSid(sid: string): void {
  pendingOpenMap.delete(sid)
}

/**
 * 消费某 session 的 pendingOpen：为 true 则 open('tasks') 并清标记。
 * 挂在 useSidebar.selectSession 内部（与 commands/context 兜底拉取同位置），
 * 不挂独立 watch(focusedSessionId)——避免撞 Runtime broadcast 时序竞争。
 */
export function consumePendingOpen(sid: string): void {
  if (!pendingOpenMap.get(sid)) return
  clearPendingOpenForSid(sid)
  // 切到该 session 时，focusedSessionId 已是该 sid，open 操作作用于当前分区
  openInternal('tasks')
}

// session 销毁时清理 pendingOpen（controlState 分区由 useSessionScopedState 自动注册）
registerSessionCleanup((sid) => {
  pendingOpenMap.delete(sid)
})

// ── 不分区的瞬时参数（模块级单例，消费后清空）──
/** Doc tab 当前展示的命令名（点击用户气泡 slash chip 时设置） */
const selectedCommandName = ref<string | null>(null)
/**
 * Detail tab 打开时立即展示的文件路径（点击即看 diff）。
 * 由变更集卡等非文件树入口设置；useDetailPane watch 它并强制 diff 模式。
 * 用完即清空（消费后置 null），避免残留导致下次打开 detail tab 被旧值劫持。
 */
const detailFilePath = ref<string | null>(null)

/**
 * 重置 SideDrawer 状态（测试隔离用）。
 * 清所有 per-session 分区 + pendingOpen + 瞬时参数。
 * 注：per-session 分区清理通过重建 controlState（新 useSessionScopedState 实例）实现，
 * 生产代码不应调用。
 */
export function resetSideDrawer(): void {
  // 清所有 per-session 分区 + pendingOpen + 瞬时参数（测试隔离用）。
  // controlState._clearAllForTest 是 useSessionScopedState 的测试钩子（清内部 Map），
  // 生产代码不调用 resetSideDrawer。
  controlState._clearAllForTest?.()
  pendingOpenMap.clear()
  selectedCommandName.value = null
  detailFilePath.value = null
}

/** 内部 open：操作当前 focusedSessionId 分区。tasks tab 强制 docked（仅当前分区） */
function openInternal(tab?: SideDrawerTab, opts?: OpenDrawerOptions): void {
  const cur = controlState.current.value
  if (tab) {
    cur.activeTab = tab
    if (tab === 'tasks') cur.docked = true
  }
  if (opts?.commandName !== undefined) selectedCommandName.value = opts.commandName
  if (opts?.filePath !== undefined) detailFilePath.value = opts.filePath
  cur.isOpen = true
}

export function useSideDrawer() {
  /** 打开抽屉，可指定初始 tab + Doc tab 的选中命令 / Detail tab 的文件路径 */
  function open(tab?: SideDrawerTab, opts?: OpenDrawerOptions): void {
    // FR-9：手动 open（任意 tab）即清当前 session 的 pendingOpen（用户已注意，不再打扰）
    const sid = focusedSessionId.value
    if (sid) clearPendingOpenForSid(sid)
    openInternal(tab, opts)
  }

  /** 关闭抽屉（钉住态亦可手动关闭） */
  function close(): void {
    controlState.current.value.isOpen = false
  }

  /** 切换开关；从关到开可指定 tab */
  function toggle(tab?: SideDrawerTab): void {
    if (controlState.current.value.isOpen) close()
    else open(tab)
  }

  /** 切换 tab（抽屉关闭时仅改 activeTab，不自动打开）。tasks tab 自动 docked（仅当前分区） */
  function setTab(tab: SideDrawerTab): void {
    controlState.current.value.activeTab = tab
    if (tab === 'tasks') controlState.current.value.docked = true
  }

  /** 切换钉住态（仅当前分区） */
  function toggleDock(): void {
    controlState.current.value.docked = !controlState.current.value.docked
  }

  return {
    // 控制态：computed 读当前分区字段（切 session 切分区，响应式自动跟随）
    isOpen: computed(() => controlState.current.value.isOpen),
    activeTab: computed(() => controlState.current.value.activeTab),
    docked: computed(() => controlState.current.value.docked),
    // 瞬时参数（不分区的模块级单例）
    selectedCommandName,
    detailFilePath,
    open,
    close,
    toggle,
    setTab,
    toggleDock,
  }
}
