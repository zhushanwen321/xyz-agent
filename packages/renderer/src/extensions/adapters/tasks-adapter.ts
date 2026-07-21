/**
 * tasks adapter —— goal/todo extension 的 UI 事件分流到 tasks store。
 *
 * 把原本散在 SideDrawer 的 goal/todo 特判收敛到此处：
 * - extension:widget widgetKey='goal' → tasksStore.mergeGoalWidget（解析实时 status/token%/time%）
 * - extension:widget widgetKey='todo' → no-op（权威数据是 tool result 的 details.todos，含 isVerification）
 * - extension:widgetGui widgetKey='goal'/'todo' → no-op（结构化快照走 tool result 的 details.__gui__，
 *   widgetGui 通路当前 extension 不推，但若未来推送也归 tasks 管不进通用管线）
 * - extension:status statusKey='goal'/'todo' → no-op（TasksPanel 已展示更完整信息，footer 不重复）
 *
 * 副作用：模块 import 时自注册进 ExtensionRegistry。消费侧（SideDrawer）import 本模块即生效。
 *
 * 依赖方向：extensions/registry（注册）+ stores/tasks（数据写入）。不依赖任何 UI 组件。
 */
import { registerKnownExtension } from '../registry'
import { useTasksStore } from '@/stores/tasks'

/** goal/todo extension 认领的 widgetKey / statusKey（与 extension 源码 setWidget/setStatus 参数一致） */
const TASKS_WIDGET_KEYS = ['goal', 'todo'] as const
const TASKS_STATUS_KEYS = ['goal', 'todo'] as const

/**
 * 注册 goal/todo adapter。幂等（Registry 内部去重）。
 *
 * 放在函数里而非模块顶层直接调，是为了测试可控（测试可选择注册时机 + __resetExtensionRegistry 隔离）。
 * 生产环境由本模块末尾的副作用调用触发。
 */
export function registerTasksAdapter(): void {
  registerKnownExtension({
    widgetKeys: TASKS_WIDGET_KEYS,
    statusKeys: TASKS_STATUS_KEYS,

    onWidget(sessionId, widgetKey, lines) {
      // goal widget：解析 ANSI 实时字段 merge 进 goal 快照（status/tokenPct/timePct）
      if (widgetKey.toLowerCase() === 'goal') {
        useTasksStore().mergeGoalWidget(sessionId, lines)
      }
      // todo widget：no-op。权威数据是 tool result 的 details.todos（含准确 status + isVerification），
      // widget 与 tool result 同步推送，解析 widget 冗余且更弱（无 isVerification）。
    },

    // widgetGui：goal/todo 的结构化快照走 tool result（details.__gui__），不经 widgetGui 通路。
    // 留空 no-op，防止未来 extension 改推 widgetGui 时落到通用 terminal 渲染。
    onWidgetGui() {
      /* no-op */
    },

    // status：goal/todo 的状态摘要（turn/token/time）在 TasksPanel 有更完整展示，footer 不重复。
    // 注册即吞掉（onStatus 存在 → routeStatus 返回 true → 不进通用 status footer）。
    onStatus() {
      /* no-op */
    },
  })
}

// ── 生产环境副作用注册（import 本模块即生效）──────────────────────────
registerTasksAdapter()
