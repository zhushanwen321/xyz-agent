/**
 * composer-injection store —— drawer 选区/文件引用注入 composer 的「一次性消息通道」。
 *
 * ## 背景
 * drawer 内容组件（DetailPane/DiffView/GitPanel）与 Composer 跨组件树，拿不到
 * ComposerInput 的 inputRef。注入必须走 store 一次性消息通道（项目已验证的跨树注入
 * 范式：commandStore.pendingSlash → useCommandPopoverTrigger watch 消费）。
 *
 * 本 store 与 commandStore.pendingSlash 平行：pendingSlash 专管 slash chip（SearchModal），
 * pendingInjection 管 file chip（drawer 选区/文件引用）。职责隔离，不混入 commandStore。
 *
 * ## 设计（一次性消息通道，同 pendingSlash 模式）
 * 写入方（DetailPane/DiffView/GitPanel）→ requestInjection(payload)
 * 消费方（Composer 经 useComposerInjection）→ watch pendingInjection → 按 target/sessionId
 * 过滤 → insertFileChip → clearInjection。null 表示无待消费请求。
 *
 * ## target 路由（FR-2.1）
 * - `current`：注入到 sessionId 匹配的当前 session composer
 * - `new`：先触发 useNewTaskFlow.startFlow 进 landing，再注入到 landing composer。
 *   landing composer 的 sessionId 可能为 null（W3 移除公共 session 后），
 *   故 target=new 的匹配不依赖 sessionId=null，改用 Composer variant=landing 判定
 *   （见 useComposerInjection）。store 只做传输 + routeToLanding 改写。
 *
 * ## payload schema（FR-2/FR-8）
 * 不含 text 字段（注入内容仅 file chip，不注入选中文本——outOfScope）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 注入目标 */
export type InjectionTarget = 'current' | 'new'

/**
 * 一次性注入请求 payload（消费侧读）。
 * 不含 text 字段：注入内容仅 file chip（path + 行范围），不注入选中文本（FR-8）。
 */
export interface PendingInjection {
  target: InjectionTarget
  path: string
  lineStart?: number
  lineEnd?: number
  /** 过滤用 sessionId：current 时具体 id，new 时强制 null（落地 landing composer） */
  sessionId: string | null
  /** 时间戳：同内容重复注入靠 ts 变化触发 watch 引用变化 */
  ts: number
}

/** 写入侧 payload（不含 ts/sessionId 归一化，内部补） */
export interface InjectionRequest {
  target: InjectionTarget
  path: string
  lineStart?: number
  lineEnd?: number
  /** current 时传具体 sessionId；new 时忽略（强制 null） */
  sessionId?: string | null
}

export const useComposerInjectionStore = defineStore('composer-injection', () => {
  /** 一次性注入请求槽位。null 表示无待消费请求。 */
  const pendingInjection = ref<PendingInjection | null>(null)

  /**
   * 写入注入请求（幂等覆盖：连续调用以最后一次为准）。
   * ts 内部补；target=new 时 sessionId 强制 null（新对话落地 landing composer）。
   */
  function requestInjection(payload: InjectionRequest): void {
    const sessionId = payload.target === 'new' ? null : (payload.sessionId ?? null)
    pendingInjection.value = { ...payload, sessionId, ts: Date.now() }
  }

  /** 消费清除（Composer 消费后立即调用，防重复注入 + 防 watch 残留触发） */
  function clearInjection(): void {
    pendingInjection.value = null
  }

  /**
   * target=new 路由落地：把 target 从 new 改 current，重置 ts 触发 watch。
   *
   * 阶段一（session composer 触发 startFlow 后）调用：标记「已路由到 landing」，
   * landing composer（variant=landing）的 useComposerInjection 看到 target=current
   * + sessionId=null（landing 命中）后注入。
   *
   * 重置 ts：让已挂载的 landing composer 的 watch 也能被触发。onMounted 补检查覆盖
   * 「挂载早于 routeToLanding」时序，watch 覆盖「晚于」时序，互补。
   */
  function routeToLanding(): void {
    const current = pendingInjection.value
    if (!current) return
    pendingInjection.value = { ...current, target: 'current', sessionId: null, ts: Date.now() }
  }

  return { pendingInjection, requestInjection, clearInjection, routeToLanding }
})
