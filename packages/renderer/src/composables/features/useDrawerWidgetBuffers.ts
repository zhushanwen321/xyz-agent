/**
 * useDrawerWidgetBuffers —— SideDrawer 的 widget/status 缓冲 + extension 事件订阅编排。
 *
 * 从 SideDrawer.vue `<script setup>` 抽出（行数限制 + 关注点分离）：
 * 把「通用 extension widget/status 渲染管线的状态与事件处理」收敛到本 composable，
 * SideDrawer 组件只管布局 + tab 切换。
 *
 * 范式（ADR-0036 W4：Map 分区派，[HISTORICAL]）：
 * - drawerState = useSessionScopedState(sessionIdRef, init)：init 返回 reactive 容器
 *   （不是 plain object），按 sessionId 分区，切 sid 切分区、切回恢复（AC-4）。
 * - onMessage handler 调 updateFor(sid, ...)（第二参数 sid 是订阅时捕获的消息所属 session），
 *   不用 update()——update 读实时 sessionIdRef.value，退订窗口内旧 sid 迟到消息会污染新 sid
 *   （M1 竞态修复的核心）。
 *
 * 注意：此前有过实例级 ref + watch 清空派的探索产物（ADR-0036 反模式，已删除）。
 * 本 composable 是 Map 分区派，不可退化回实例级范式。
 *
 * 依赖方向：useSessionEvents（订阅）+ useSessionScopedState（分区）+ @xyz-agent/extension-protocol（类型）。
 * 不依赖任何 store。
 */
import { computed, reactive, type Ref } from 'vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import type { SideDrawerTab } from '@/composables/features/useSideDrawer'
import { useSessionEvents } from '@/composables/features/useSessionEvents'
import { useSessionScopedState } from '@/composables/useSessionScopedState'

export interface DrawerWidgetBuffers {
  /** active tab 的结构化 GUI 组件（extension:widgetGui），优先于文本 lines 渲染 */
  activeGuiComponent: Ref<GuiComponent | undefined>
  /** active tab 的文本行（terminal/browser/unknownWidget，按优先级） */
  activeLines: Ref<string[]>
  /** active 文本行的元信息（是否 unknownWidget + 其 key） */
  activeLinesMeta: Ref<{ unknown: boolean; key: string }>
  /** status footer 条目（statusKey 维度聚合） */
  statusEntries: Ref<Array<{ statusKey: string; text: string; textRaw?: string }>>
}

/**
 * @param sessionIdRef session id 的 ref（useSessionEvents 按 sessionId 订阅 + 切换重订）
 * @param activeTabRef active tab 的 ref（决定 activeGuiComponent / activeLines 取哪个 tab 的数据）
 */
export function useDrawerWidgetBuffers(
  sessionIdRef: Ref<string | null>,
  activeTabRef: Ref<SideDrawerTab>,
): DrawerWidgetBuffers {
  /**
   * widget/status 缓冲的 per-session 状态结构（ADR-0036 W4：Map 分区派）。
   * 五个原组件级 ref/reactive（terminalLines/browserLines/unknownWidget/guiWidgetsByTab/statusMap）
   * 收进一个 reactive 对象，经 useSessionScopedState 按 sessionId 分区。
   *
   * reactive 容器必要性（W2 经验）：init 工厂必须返回 reactive 容器，模板里读 state.xxx +
   * handler 里 mutate state.xxx 才能被响应式追踪——plain object 的 mutate 不触发下游 computed。
   *
   * init 必须返回全新实例：每 sid 独立分区，切回恢复不残留旧 session 数据。
   */
  interface DrawerBuffers {
    /** widget 缓冲：按 tab 存最新 lines（runtime 每次推全量） */
    terminalLines: string[]
    browserLines: string[]
    /** 未匹配 tab 的 widgetKey fallback：存最后一个未知 widget 的 {key, lines}，默认路由到 terminal 显示 */
    unknownWidget: { key: string; lines: string[] } | null
    /**
     * 结构化 GUI widget 缓冲（extension:widgetGui，spec §9.1）。
     * 按 tab 路由聚合：widgetKey 经 mapWidgetKeyToTab 归一化到 terminal/browser，未匹配归 terminal。
     * 同 tab 的结构化组件覆盖纯文本 lines：activeGuiComponent 命中时优先用 GuiComponentRenderer 渲染，
     * 保留交互/着色能力；纯文本 lines 作兜底。
     */
    guiWidgetsByTab: Map<SideDrawerTab, GuiComponent>
    /** extension status 缓冲：statusKey → 最新 {text, textRaw}（runtime 推送全量替换，与 widget 同语义） */
    statusMap: Map<string, { text: string; textRaw?: string }>
  }

  const drawerState = useSessionScopedState(
    sessionIdRef,
    () => reactive<DrawerBuffers>({
      terminalLines: [],
      browserLines: [],
      unknownWidget: null,
      guiWidgetsByTab: new Map(),
      statusMap: new Map(),
    }),
  )

  /** 当前 active tab 的结构化组件（命中时优先于纯文本 lines 渲染） */
  const activeGuiComponent = computed<GuiComponent | undefined>(() =>
    drawerState.current.value.guiWidgetsByTab.get(activeTabRef.value),
  )

  const activeLines = computed<string[]>(() => {
    const buf = drawerState.current.value
    if (activeTabRef.value === 'browser') return buf.browserLines
    return buf.terminalLines.length ? buf.terminalLines : buf.unknownWidget?.lines ?? []
  })

  /** active 内容的元信息（用于 fallback 标记） */
  const activeLinesMeta = computed(() => {
    const buf = drawerState.current.value
    if (activeTabRef.value === 'browser') return { unknown: false, key: '' }
    if (buf.terminalLines.length) return { unknown: false, key: '' }
    if (buf.unknownWidget) return { unknown: true, key: buf.unknownWidget.key }
    return { unknown: false, key: '' }
  })

  /**
   * widgetKey → tab 路由启发式（NFR Prototype 1 枚举对齐前的过渡方案）。
   * runtime 推送的 widgetKey 为 extension 自定义字符串，归一化后匹配常见关键词。
   * 未命中 → null（调用方走 fallback）。
   */
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

  const statusEntries = computed(() =>
    Array.from(drawerState.current.value.statusMap.entries()).map(([statusKey, v]) => ({
      statusKey,
      text: v.text,
      textRaw: v.textRaw,
    })),
  )

  /** widget 缓冲行数上限（NFR Issue #11 性能：前端最多保留 1000 行，超出截断保留尾部最新） */
  const WIDGET_MAX_LINES = 1000

  /** 保留最新尾部 WIDGET_MAX_LINES 行（前端缓冲上限，截断保留尾部最新） */
  function truncateLines(lines: string[]): string[] {
    if (lines.length <= WIDGET_MAX_LINES) return lines
    return lines.slice(lines.length - WIDGET_MAX_LINES)
  }

  /**
   * widget/status 订阅编排（#11 W3a）：订阅时机、sessionId 切换重订、卸载退订归 useSessionEvents
   * （features 层，session 通道）。本 composable 只保留 widget 缓冲逻辑（tab 路由 + lines 截断 + status 聚合）。
   *
   * sessionId 切换无需手动清缓冲——drawerState 经 useSessionScopedState 分区，切 sid 切分区，
   * 切回原 sid 自动恢复缓冲（AC-4）。
   */
  const onMessage = useSessionEvents(sessionIdRef)
  // extension:widget：按 widgetKey 路由到 terminal/browser tab，未匹配走 fallback
  // handler 收到第二参数 sid（订阅时捕获的消息所属 session），调 updateFor(sid) 写入该 sid 分区——
  // 即使 watch flush:pre 异步退订窗口内有旧 sid 迟到消息，也只写旧 sid 分区，不污染新 sid（M1 竞态修复）
  onMessage('extension:widget', (msg, sid) => {
    const payload = msg.payload
    const lines = truncateLines(payload.lines)
    const tab = mapWidgetKeyToTab(payload.widgetKey)
    drawerState.updateFor(sid, (buf) => {
      if (tab === 'terminal') buf.terminalLines = lines
      else if (tab === 'browser') buf.browserLines = lines
      else buf.unknownWidget = { key: payload.widgetKey, lines }
    })
  })
  // extension:widgetGui（spec §9.1）：结构化 GUI 组件，按 widgetKey 路由到 tab，覆盖纯文本 lines。
  // gui === null 表示清除（guiSetWidget(key, undefined) → event-adapter 发 gui:null），
  // 删 guiWidgetsByTab 条目 + 清对应 tab 的纯文本 lines。
  // 未匹配 tab 的 widgetKey 归 terminal（与 extension:widget fallback 语义一致：unknownWidget 默认显 terminal）
  //
  // 注：drawerState 是 useSessionScopedState reactive 容器，buf.guiWidgetsByTab / buf.statusMap
  // 都是 reactive Map。Vue 3 reactive 对 Map 有 collection handlers——.set()/.delete() 本身就触发
  // 依赖了该 Map 的下游 computed 重算，**无需重新赋值 Map 字段**（旧 ref<Map> 实现才需要 reassign）。
  onMessage('extension:widgetGui', (msg, sid) => {
    const payload = msg.payload
    const tab = mapWidgetKeyToTab(payload.widgetKey) ?? 'terminal'
    drawerState.updateFor(sid, (buf) => {
      if (payload.gui === null) {
        // 清除：删结构化组件 + 纯文本 lines（guiSetWidget(key, undefined) 语义）
        buf.guiWidgetsByTab.delete(tab)
        if (tab === 'terminal') buf.terminalLines = []
        else if (tab === 'browser') buf.browserLines = []
        return
      }
      buf.guiWidgetsByTab.set(tab, payload.gui as GuiComponent)
    })
  })
  // extension:status：statusKey 维度聚合，同 key 覆盖（透传 textRaw 供 AnsiText 着色）
  onMessage('extension:status', (msg, sid) => {
    const payload = msg.payload
    drawerState.updateFor(sid, (buf) => {
      buf.statusMap.set(payload.statusKey, { text: payload.text, textRaw: payload.textRaw })
    })
  })

  return { activeGuiComponent, activeLines, activeLinesMeta, statusEntries }
}
