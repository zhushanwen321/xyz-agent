/**
 * useDrawerWidgets —— SideDrawer 的 widget/status 缓冲 + extension 事件订阅编排。
 *
 * 从 SideDrawer.vue 抽出（行数限制 + 关注点分离）：把「通用 extension widget/status 渲染管线的
 * 状态与事件处理」收敛到本 composable，SideDrawer 组件只管布局 + tab 切换。
 *
 * 职责：
 * - 订阅 extension:widget / extension:widgetGui / extension:status（经 useSessionEvents，session 通道）
 * - 已知 extension（goal/todo 等）先过 ExtensionRegistry 分流，命中即消费不进通用管线
 * - 通用 widget 按 widgetKey 启发式路由到 terminal/browser tab，未匹配归 unknownWidget
 * - status 按 statusKey 聞合，供 footer 渲染
 * - 暴露 activeGuiComponent / activeLines / activeLinesMeta / statusEntries 供模板消费
 *
 * 依赖方向：useSessionEvents（订阅）+ ExtensionRegistry（分流）+ @xyz-agent/extension-protocol（类型）。
 * 不依赖任何 store。
 */
import { computed, ref, toValue, watch, type Ref } from 'vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import type { SideDrawerTab } from '@/composables/features/useSideDrawer'
import { useSessionEvents } from '@/composables/features/useSessionEvents'
// ExtensionRegistry 分流：goal/todo 等「已知 extension」的 widget/status 事件在进通用渲染管线前
// 被拦截到 tasks store。import 即触发 tasks-adapter 副作用注册（见 tasks-adapter.ts 末尾）。
import '@/extensions/adapters/tasks-adapter'
import * as ExtensionRegistry from '@/extensions/registry'

/** widget 文本行截断上限（防御超长输出撑爆 DOM） */
const WIDGET_MAX_LINES = 500

function truncateLines(lines: string[]): string[] {
  if (!Array.isArray(lines) || lines.length === 0) return []
  if (lines.length <= WIDGET_MAX_LINES) return lines
  return lines.slice(lines.length - WIDGET_MAX_LINES)
}

/** 按 widgetKey 启发式归一化到 terminal/browser tab，未匹配返回 null（由调用方决定兜底） */
function mapWidgetKeyToTab(key: string): SideDrawerTab | null {
  const k = key.toLowerCase()
  if (k.includes('terminal') || k.includes('shell') || k.includes('console') || k.includes('bash')) {
    return 'terminal'
  }
  if (k.includes('browser') || k === 'web' || k.startsWith('webview') || k.includes('preview')) {
    return 'browser'
  }
  return null
}

export interface DrawerWidgets {
  /** active tab 的结构化 GUI 组件（extension:widgetGui），优先于文本 lines 渲染 */
  activeGuiComponent: Ref<GuiComponent | undefined>
  /** active tab 的文本行（terminal/browser/unknownWidget，按优先级） */
  activeLines: Ref<string[]>
  /** active 文本行的元信息（是否 unknownWidget + 其 key） */
  activeLinesMeta: Ref<{ unknown: boolean; key: string }>
  /** status footer 条目（已排除被 ExtensionRegistry 吞掉的已知 extension status） */
  statusEntries: Ref<Array<{ statusKey: string; text: string; textRaw?: string }>>
}

/**
 * @param sessionIdRef session id 的 ref / getter（useSessionEvents 按 sessionId 订阅 + 切换重订）
 * @param activeTabRef active tab 的 ref / getter（决定 activeGuiComponent / activeLines 取哪个 tab 的数据）
 */
export function useDrawerWidgets(
  sessionIdRef: Ref<string | null>,
  activeTabRef: Ref<SideDrawerTab>,
): DrawerWidgets {
  const terminalLines = ref<string[]>([])
  const browserLines = ref<string[]>([])
  const unknownWidget = ref<{ key: string; lines: string[] } | null>(null)

  /** 按 tab 路由聚合：widgetKey 经 mapWidgetKeyToTab 归一化到 terminal/browser，未匹配归 terminal。 */
  const guiWidgetsByTab = ref<Map<SideDrawerTab, GuiComponent>>(new Map())

  const activeGuiComponent = computed<GuiComponent | undefined>(() =>
    guiWidgetsByTab.value.get(toValue(activeTabRef)),
  )

  const activeLines = computed<string[]>(() => {
    const tab = toValue(activeTabRef)
    if (tab === 'browser') return browserLines.value
    return terminalLines.value.length ? terminalLines.value : unknownWidget.value?.lines ?? []
  })

  const activeLinesMeta = computed(() => {
    if (terminalLines.value.length) return { unknown: false, key: '' }
    if (unknownWidget.value) return { unknown: true, key: unknownWidget.value.key }
    return { unknown: false, key: '' }
  })

  const statusMap = ref<Map<string, { text: string; textRaw?: string }>>(new Map())
  const statusEntries = computed(() =>
    Array.from(statusMap.value.entries()).map(([statusKey, v]) => ({
      statusKey,
      text: v.text,
      textRaw: v.textRaw,
    })),
  )

  const onMessage = useSessionEvents(sessionIdRef)

  // extension:widget：按 widgetKey 路由。已知 extension（goal/todo 等）先过 ExtensionRegistry 分流，
  // 命中即消费不进通用管线；未匹配走 terminal/browser 启发式，再不匹配归 unknownWidget。
  onMessage('extension:widget', (msg) => {
    const payload = msg.payload
    const lines = truncateLines(payload.lines)
    const widgetKey = payload.widgetKey
    const sid = toValue(sessionIdRef)
    if (sid && ExtensionRegistry.routeWidget(sid, widgetKey, lines)) return
    const tab = mapWidgetKeyToTab(widgetKey)
    if (tab === 'terminal') terminalLines.value = lines
    else if (tab === 'browser') browserLines.value = lines
    else unknownWidget.value = { key: widgetKey, lines }
  })

  // extension:widgetGui（spec §9.1）：结构化 GUI 组件，按 widgetKey 路由到 tab，覆盖纯文本 lines。
  // 已知 extension 先过 ExtensionRegistry 分流（goal/todo 当前不推 widgetGui，但留位防未来落到通用管线）。
  // gui === null 表示清除（guiSetWidget(key, undefined) → event-adapter 发 gui:null），
  // 删 guiWidgetsByTab 条目 + 清对应 tab 的纯文本 lines。
  // 未匹配 tab 的 widgetKey 归 terminal（与 extension:widget fallback 语义一致：unknownWidget 默认显 terminal）
  onMessage('extension:widgetGui', (msg) => {
    const payload = msg.payload
    const sid = toValue(sessionIdRef)
    if (
      sid &&
      ExtensionRegistry.routeWidgetGui(
        sid,
        payload.widgetKey,
        (payload.gui ?? null) as GuiComponent | null,
      )
    ) {
      return
    }
    const tab = mapWidgetKeyToTab(payload.widgetKey) ?? 'terminal'
    if (payload.gui === null) {
      // 清除：删结构化组件 + 纯文本 lines（guiSetWidget(key, undefined) 语义）
      guiWidgetsByTab.value.delete(tab)
      guiWidgetsByTab.value = new Map(guiWidgetsByTab.value)
      if (tab === 'terminal') terminalLines.value = []
      else if (tab === 'browser') browserLines.value = []
      return
    }
    guiWidgetsByTab.value.set(tab, payload.gui as GuiComponent)
    guiWidgetsByTab.value = new Map(guiWidgetsByTab.value)
  })

  // extension:status：statusKey 维度聚合。已知 extension（goal/todo）过 ExtensionRegistry 分流
  // （TasksPanel 已展示更完整信息，不重复进 footer）；未匹配的 statusKey 才进通用 footer。
  onMessage('extension:status', (msg) => {
    const payload = msg.payload
    const sid = toValue(sessionIdRef)
    if (
      sid &&
      ExtensionRegistry.routeStatus(sid, payload.statusKey, payload.text, payload.textRaw)
    ) {
      return
    }
    statusMap.value.set(payload.statusKey, { text: payload.text, textRaw: payload.textRaw })
    statusMap.value = new Map(statusMap.value)
  })

  // sessionId 变化时清空缓冲（useSessionEvents 已负责底层订阅重订，这里只复位组件缓冲状态，
  // 避免切 session 后上个 session 的 terminal/widget/status 残留）。
  watch(
    sessionIdRef,
    () => {
      terminalLines.value = []
      browserLines.value = []
      unknownWidget.value = null
      guiWidgetsByTab.value = new Map()
      statusMap.value = new Map()
    },
    { immediate: true },
  )

  return { activeGuiComponent, activeLines, activeLinesMeta, statusEntries }
}
