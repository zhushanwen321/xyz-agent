/**
 * drawer widget 缓冲容器 —— @xyz-agent/core 平台无关内核（headless）的 drawer 域缓冲归位。
 *
 * 迁移自 renderer composables/features/useDrawerWidgetBuffers.ts 的「状态容器」部分（W2，
 * drawer 域向 core 归位第二步；W1 已迁移控制态/协同层）。订阅编排（useSessionEvents.onMessage
 * 接 extension:widget/widgetGui/status 事件）**不迁**——留 renderer 壳层（D3），壳层持有
 * 事件订阅 + 调本模块 update 方法喂数据。core 零事件总线/ServerMessage 类型依赖。
 *
 * 范式（ADR-0049 W4：Map 分区派，[HISTORICAL]）：
 * - 本模块为工厂形态（createDrawerBuffers），每次调用建独立的 useSessionScopedState 分区实例
 *   （与 renderer 现状一致——SideDrawer 组件内调用，分区 per-instance；Slice IF3 契约）。
 *   对比 control.ts 的模块级单例：control 是全局单例（Q2=A 裁决），widget 缓冲是组件实例级。
 * - update 方法统一 updateFor(targetSid) 显式 sid 分区（M1 竞态修复：WS handler 捕获订阅时
 *   sid，退订窗口内旧 sid 迟到消息只写旧分区，不污染新分区）。
 * - init 工厂必须返回 reactive 容器（[HISTORICAL] 响应式契约：plain object mutate 不触发
 *   下游 computed 重算——drawer 打不开事故同源教训）。
 *
 * 依赖方向（C3）：vue（ref/computed/reactive）+ core/foundation/use-session-scoped-state
 * + @xyz-agent/extension-protocol（GuiComponent 仅类型 import）。零 DOM 类型。
 */
import { computed, reactive } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import { useSessionScopedState } from '../../foundation/use-session-scoped-state'
import type { SideDrawerTab } from './types'

/** widget 缓冲行数上限（NFR Issue #11 性能：前端最多保留 1000 行，超出截断保留尾部最新） */
export const WIDGET_MAX_LINES = 1000

/**
 * widgetKey → tab 路由启发式（NFR Prototype 1 枚举对齐前的过渡方案）。
 * runtime 推送的 widgetKey 为 extension 自定义字符串，归一化后匹配常见关键词。
 * 未命中 → null（调用方走 fallback：unknownWidget 默认显 terminal）。
 */
export function mapWidgetKeyToTab(key: string): SideDrawerTab | null {
  const k = key.toLowerCase()
  if (k.includes('terminal') || k.includes('shell') || k.includes('console') || k.includes('bash')) {
    return 'terminal'
  }
  if (k.includes('browser') || k === 'web' || k.startsWith('webview') || k.includes('preview')) {
    return 'browser'
  }
  return null
}

/** 保留最新尾部 WIDGET_MAX_LINES 行（前端缓冲上限，截断保留尾部最新） */
export function truncateLines(lines: string[]): string[] {
  if (lines.length <= WIDGET_MAX_LINES) return lines
  return lines.slice(lines.length - WIDGET_MAX_LINES)
}

/** per-session widget/status 缓冲结构（ADR-0049 W4：Map 分区派，DM2） */
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

/** 容器视图：active tab 的结构化 GUI 组件 + 文本行 + 元信息 + status footer 条目 */
export interface DrawerBuffersView {
  /** active tab 的结构化 GUI 组件（extension:widgetGui），优先于文本 lines 渲染 */
  activeGuiComponent: ComputedRef<GuiComponent | undefined>
  /** active tab 的文本行（terminal/browser/unknownWidget，按优先级） */
  activeLines: ComputedRef<string[]>
  /** active 文本行的元信息（是否 unknownWidget + 其 key） */
  activeLinesMeta: ComputedRef<{ unknown: boolean; key: string }>
  /** status footer 条目（statusKey 维度聚合） */
  statusEntries: ComputedRef<Array<{ statusKey: string; text: string; textRaw?: string }>>
}

/** 容器写入面：壳层订阅事件后调 update 方法喂数据（显式 sid 分区，M1 竞态） */
export interface DrawerBuffersUpdater {
  /** extension:widget：按 widgetKey 路由到 terminal/browser tab，未匹配走 fallback。lines 截断保留尾部 */
  updateWidget(sid: string, key: string, lines: string[]): void
  /**
   * extension:widgetGui：结构化 GUI 组件，按 widgetKey 路由到 tab（未匹配归 terminal），覆盖纯文本 lines。
   * gui === null 表示清除（guiSetWidget(key, undefined) → event-adapter 发 gui:null）：
   * 删 guiWidgetsByTab 条目 + 清对应 tab 的纯文本 lines。
   */
  updateWidgetGui(sid: string, key: string, gui: GuiComponent | null): void
  /** extension:status：statusKey 维度聚合，同 key 覆盖（透传 textRaw 供 AnsiText 着色） */
  updateStatus(sid: string, statusKey: string, text: string, textRaw?: string): void
}

export type DrawerBuffersContainer = DrawerBuffersView & DrawerBuffersUpdater

/**
 * 创建 drawer widget/status 缓冲容器（工厂，per-instance 分区）。
 *
 * @param sessionIdRef session id 的 ref（壳层 useSessionEvents 按 sessionId 订阅 + 切换重订；
 *        本容器按此分区——切 sid 切分区，切回原 sid 自动恢复缓冲 AC-4）
 * @param activeTabRef active tab 的 ref（决定 activeGuiComponent / activeLines 取哪个 tab 的数据）
 */
export function createDrawerBuffers(
  sessionIdRef: Ref<string | null>,
  activeTabRef: Ref<SideDrawerTab>,
): DrawerBuffersContainer {
  const drawerState = useSessionScopedState(
    sessionIdRef,
    () =>
      reactive<DrawerBuffers>({
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

  const statusEntries = computed(() =>
    Array.from(drawerState.current.value.statusMap.entries()).map(([statusKey, v]) => ({
      statusKey,
      text: v.text,
      textRaw: v.textRaw,
    })),
  )

  /** extension:widget 写入：截断 + 路由（terminal/browser/unknown 三写点） */
  function updateWidget(sid: string, key: string, lines: string[]): void {
    const truncated = truncateLines(lines)
    const tab = mapWidgetKeyToTab(key)
    drawerState.updateFor(sid, (buf) => {
      if (tab === 'terminal') buf.terminalLines = truncated
      else if (tab === 'browser') buf.browserLines = truncated
      else buf.unknownWidget = { key, lines: truncated }
    })
  }

  /**
   * extension:widgetGui 写入：路由到 tab（未匹配归 terminal）+ 覆盖纯文本 lines。
   * gui === null 清除语义：删结构化组件 + 清对应 tab 纯文本 lines（guiSetWidget(key, undefined)）。
   *
   * 注：buf.guiWidgetsByTab / buf.statusMap 是 reactive Map——Vue 3 reactive 对 Map 有
   * collection handlers，.set()/.delete() 本身触发依赖了该 Map 的下游 computed 重算，
   * 无需重新赋值 Map 字段（旧 ref<Map> 实现才需要 reassign）。
   */
  function updateWidgetGui(sid: string, key: string, gui: GuiComponent | null): void {
    const tab = mapWidgetKeyToTab(key) ?? 'terminal'
    drawerState.updateFor(sid, (buf) => {
      if (gui === null) {
        buf.guiWidgetsByTab.delete(tab)
        if (tab === 'terminal') buf.terminalLines = []
        else if (tab === 'browser') buf.browserLines = []
        return
      }
      buf.guiWidgetsByTab.set(tab, gui)
    })
  }

  /** extension:status 写入：statusKey 维度聚合，同 key 覆盖（透传 textRaw 供 AnsiText 着色） */
  function updateStatus(sid: string, statusKey: string, text: string, textRaw?: string): void {
    drawerState.updateFor(sid, (buf) => {
      buf.statusMap.set(statusKey, { text, textRaw })
    })
  }

  return { activeGuiComponent, activeLines, activeLinesMeta, statusEntries, updateWidget, updateWidgetGui, updateStatus }
}
