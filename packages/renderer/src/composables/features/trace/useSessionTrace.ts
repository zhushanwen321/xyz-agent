/**
 * useSessionTrace —— per-session trace 台账 store（trace-ui A41，ADR-0049 Map 分区派）。
 *
 * 职责（design D4 渲染侧 + D5c）：
 * - 数据分区：header/entries/malformed/sessionEnd/leafId/source 按 sessionId 分区
 *   （useSessionScopedState，单例——trace 数据物理只有一份，跨视图/跨组件共享，
 *   「对话 | Trace」切换不重建、切回状态保留）。
 * - 加载：ensureTraceLoaded(sid) 幂等发起 session.getTraceEntries RPC（idle/error 才发）。
 * - 增量：session.traceEntryAppended server-push 按 payload.sessionId 写对应分区
 *   （events.on(sid) 捕获订阅时 sid + handler 内按 payload.sessionId 双保险——ADR-0049
 *   checklist「WS handler 用 updateFor(capturedSid)」）；entry.id 去重追加（protocol 约定）。
 * - 视图状态：view（对话/Trace）、过滤（contextOnly/activeGroups/searchText）、selectedKey
 *   同分区存储（单 panel 下 pane 跟随 session，D5c per-pane 语义由分区承载）。
 * - drawer 联动（A44）：selectTraceEntry 写 selectedKey 且 drawer 未开时自动 openDrawerTab
 *   （单向 main→drawer；SideDrawerTab 体系不变，inspector 是临时页不占 tab 位——设计 D5b）。
 *
 * 订阅生命周期：loadTrace 时 ensureIncrementSubscription（Set 去重防重复注册，规则 2）；
 * 不随 TraceView 卸载退订（切回对话视图增量继续收集，切回 Trace 不丢数据）；
 * 分区 cleanup 由 useSidebar.deleteSession 经 triggerSessionCleanups 统一编排（ADR-0049）。
 */
import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { registerSessionCleanup } from '@xyz-agent/core/foundation/use-session-scoped-state'
import { openDrawerTab, getDrawerControlState } from '@xyz-agent/core/domain/drawer'
import type { ServerMessage, SessionTraceMalformedLine } from '@xyz-agent/shared'
import type {
  TraceKindGroup,
  TraceSessionEndMeta,
  TraceSessionHeader,
} from '@xyz-agent/core/domain/session-trace'
import { session as sessionApi } from '@/api'
import * as events from '@/api/events'

/** 主区视图态（SegmentedTab「对话 | Trace」，D5a；默认对话）。 */
export type TraceMainView = 'chat' | 'trace'

/** 单个 session 的 trace 分区状态（数据 + 视图态，reactive 容器——ADR-0049 响应式契约）。 */
export interface TraceSessionPartition {
  /** 加载态：idle 未加载 / loading / ready / error。 */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 数据通路（ready 时有值）：rpc 活跃 / file 非活跃或降级 / empty 未落盘。 */
  source: 'rpc' | 'file' | 'empty' | null
  header?: TraceSessionHeader
  entries: unknown[]
  malformed: SessionTraceMalformedLine[]
  sessionEnd?: TraceSessionEndMeta
  /** 当前叶子 entry id（增量去重 + core 边界计算输入）。 */
  leafId: string | null
  /** 加载失败信息（error 态展示；文案 i18n 在组件层，此处存 code/message 数据）。 */
  errorCode: string | null
  errorMessage: string | null
  // ── 视图状态（per-session 分区；D5c）──
  view: TraceMainView
  contextOnly: boolean
  activeGroups: TraceKindGroup[]
  searchText: string
  /** 选中行 key（drawer inspector 联动；null = 未选中，inspector 隐藏复原前 tab）。 */
  selectedKey: string | null
}

function createDefaultPartition(): TraceSessionPartition {
  // [HISTORICAL] reactive 容器（ADR-0049 响应式契约）：plain object 的 mutate 不触发下游 computed。
  return {
    status: 'idle',
    source: null,
    entries: [],
    malformed: [],
    leafId: null,
    errorCode: null,
    errorMessage: null,
    view: 'chat',
    contextOnly: false,
    activeGroups: [],
    searchText: '',
    selectedKey: null,
  }
}

// ── 模块级单例（trace 数据物理只有一份；分区键 = panel store focusedSessionId 惰性绑定）──
// boundSid 必须 ref 包装（core/domain/drawer/control.ts 同款注释）：普通 let 的重新赋值不触发
// sidRef computed 失效（let 变量读取无响应式依赖），重绑后分区键会永远指向旧 ref。
// 显式注解类型：Vue 3.5 的 ref<T> 条件类型在 T 本身是 Ref 时会退化，注解强制 Ref 包装。
const boundSid: Ref<Ref<string | null> | null> = ref(null)
const sidRef = computed<string | null>(() => boundSid.value?.value ?? null)

/**
 * 绑定分区键（幂等）。App 启动（或测试 setup）调一次：
 * bindTraceSessionId(computed(() => usePanelStore().focusedSessionId))。
 * 写操作全部带显式 sid（updateFor 捕获语义），current 只作展示读取。
 */
export function bindTraceSessionId(bound: Ref<string | null>): void {
  boundSid.value = bound
}

const partitions = useSessionScopedState<TraceSessionPartition>(sidRef, createDefaultPartition)

/** 已建立增量订阅的 sid 集（防重复注册，规则 2）。 */
const subscribedSids = new Set<string>()

/** 增量订阅 handler：按 payload.sessionId 写分区（updateFor 捕获语义，防切 session 竞态）。 */
function onTraceMessage(msg: ServerMessage): void {
  if (msg.type !== 'session.traceEntryAppended') return
  // ServerMessage 是泛型接口（默认 T 时 payload 是宽联合，type narrow 不窄化）——按具体 T 收窄
  const { sessionId, entries, leafId } = (msg as ServerMessage<'session.traceEntryAppended'>).payload
  if (!sessionId || !Array.isArray(entries)) return
  applyTraceAppend(sessionId, { entries, leafId })
}

function ensureIncrementSubscription(sid: string): void {
  if (subscribedSids.has(sid)) return
  subscribedSids.add(sid)
  events.on(sid, onTraceMessage)
}

/** 增量合并：entry.id 去重追加 + leafId 滚动更新（protocol「消费端按 entry.id 去重追加」）。 */
function applyTraceAppend(
  sid: string,
  payload: { entries: unknown[]; leafId?: string | null },
): void {
  let needsReload = false
  partitions.updateFor(sid, (s) => {
    if (s.status !== 'ready') return // 未加载过的分区不增量（打开时走全量）
    if (s.source === 'empty') {
      // 未落盘 → 有增量说明数据出现：回 idle 由外部触发全量重拉（§3.1 失败路径「落盘后自动加载」）
      s.status = 'idle'
      needsReload = true
      return
    }
    const seen = new Set(
      s.entries
        .map((e) => (e as { id?: unknown } | null)?.id)
        .filter((id): id is string => typeof id === 'string'),
    )
    for (const entry of payload.entries) {
      const id = (entry as { id?: unknown } | null)?.id
      if (typeof id === 'string' && seen.has(id)) continue
      s.entries.push(entry)
      if (typeof id === 'string') seen.add(id)
    }
    if (payload.leafId !== undefined) s.leafId = payload.leafId
  })
  if (needsReload) void loadTrace(sid)
}

/** 全量加载（幂等由调用方 ensureTraceLoaded 控制；error 态可强制重试）。 */
async function loadTrace(sid: string): Promise<void> {
  ensureIncrementSubscription(sid)
  partitions.updateFor(sid, (s) => {
    s.status = 'loading'
    s.errorCode = null
    s.errorMessage = null
  })
  try {
    const snap = await sessionApi.getTraceEntries(sid)
    partitions.updateFor(sid, (s) => {
      // 加载期间被 cleanup（session 删除）/ 已被重试覆盖：丢弃过期回包
      if (s.status !== 'loading') return
      s.source = snap.source
      s.header = snap.header as TraceSessionHeader | undefined
      s.entries = [...snap.entries]
      s.malformed = [...snap.malformed]
      s.sessionEnd = snap.sessionEnd as TraceSessionEndMeta | undefined
      s.leafId = snap.leafId ?? null
      s.status = 'ready'
    })
  } catch (e) {
    const err = e as Error & { code?: string }
    partitions.updateFor(sid, (s) => {
      if (s.status !== 'loading') return
      s.status = 'error'
      s.errorCode = err.code ?? 'trace_fetch_failed'
      s.errorMessage = err.message ?? String(e)
    })
  }
}

/** 幂等加载入口（TraceView 挂载 / 切到 trace 视图时调）。 */
export function ensureTraceLoaded(sid: string): void {
  let shouldLoad = false
  partitions.updateFor(sid, (s) => {
    shouldLoad = s.status === 'idle' || s.status === 'error'
  })
  if (shouldLoad) void loadTrace(sid)
}

/** 强制重拉（error 态重试按钮 / empty 态手动刷新）。 */
export function retryTraceLoad(sid: string): void {
  void loadTrace(sid)
}

/** 选中行（A44 drawer 联动）：写 selectedKey + drawer 未开时自动打开（保持当前 tab，D5b 临时页）。 */
export function selectTraceEntry(sid: string, key: string): void {
  partitions.updateFor(sid, (s) => {
    s.selectedKey = key
  })
  const drawer = getDrawerControlState()
  if (!drawer.isOpen) openDrawerTab()
}

/** 清除选中（inspector「← 返回」）：复原 drawer 前 tab 内容（activeTab 未被改过，自动复原）。 */
export function clearTraceSelection(sid: string): void {
  partitions.updateFor(sid, (s) => {
    s.selectedKey = null
  })
}

/** 切换主区视图（SegmentedTab「对话 | Trace」，A42）。 */
export function setTraceView(sid: string, view: TraceMainView): void {
  partitions.updateFor(sid, (s) => {
    s.view = view
  })
}

/** 更新过滤态（kind chips / 搜索 / context toggle；A23 core 过滤态的 UI 输入侧）。 */
export function setTraceFilter(
  sid: string,
  patch: Partial<Pick<TraceSessionPartition, 'contextOnly' | 'activeGroups' | 'searchText'>>,
): void {
  partitions.updateFor(sid, (s) => {
    if (patch.contextOnly !== undefined) s.contextOnly = patch.contextOnly
    if (patch.activeGroups !== undefined) s.activeGroups = [...patch.activeGroups]
    if (patch.searchText !== undefined) s.searchText = patch.searchText
  })
}

// 分区销毁：session 删除时 useSidebar.deleteSession → triggerSessionCleanups 统一调到这里。
registerSessionCleanup((sid) => {
  subscribedSids.delete(sid)
})

/**
 * trace store 访问器（组件消费入口）。
 *
 * partition 是当前分区键（focusedSessionId）的 computed——Panel/PanelHeader/TraceView/
 * TraceInspector 均挂在 panel 上下文（props.sessionId == focusedSessionId，单 panel 恒真）。
 * 写操作一律带显式 sid（updateFor 捕获语义），不依赖 current 实时值。
 */
export function useSessionTrace(): {
  partition: ComputedRef<TraceSessionPartition>
  ensureLoaded: typeof ensureTraceLoaded
  retry: typeof retryTraceLoad
  select: typeof selectTraceEntry
  clearSelection: typeof clearTraceSelection
  setView: typeof setTraceView
  setFilter: typeof setTraceFilter
} {
  return {
    partition: partitions.current,
    ensureLoaded: ensureTraceLoaded,
    retry: retryTraceLoad,
    select: selectTraceEntry,
    clearSelection: clearTraceSelection,
    setView: setTraceView,
    setFilter: setTraceFilter,
  }
}

/** 测试隔离：清空所有分区 + 退订 + 解绑分区键。生产代码禁止调用。 */
export function _resetTraceStoreForTest(): void {
  for (const sid of [...subscribedSids]) {
    events.off(sid, onTraceMessage)
  }
  subscribedSids.clear()
  partitions._clearAllForTest()
  boundSid.value = null
}

// 产品接线（模块加载即绑，useSideDrawer 同款范式）：分区键 = panel store focusedSessionId。
// 惰性 computed：首次求值时 pinia 已 active（模块加载期不求值）。
// [HISTORICAL] boundSid 仅供测试重绑（_resetTraceStoreForTest 置 null 后测试 setup 重新 bind）。
import { usePanelStore } from '@/stores/panel'
bindTraceSessionId(computed<string | null>(() => usePanelStore().focusedSessionId))
