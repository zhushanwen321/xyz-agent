/**
 * useComposerInjection —— Composer 侧消费 drawer 注入请求（target 路由 + file chip 注入）。
 *
 * ## 职责
 * watch composerInjectionStore.pendingInjection：
 * 1. target='new'（仅 session composer 触发）→ 调 useNewTaskFlow.startFlow(cwd) 进 landing
 *    → store.routeToLanding()（把 target 改 current + sessionId=null）→ 本实例不注入
 *    （landing composer 接手阶段二）
 * 2. target='current' → 按目标侧判定匹配 → insertFileChip → clearInjection
 *
 * ## 目标侧匹配（FR-2.1）
 * landing composer 的 sessionId 可能为 null（W3 移除公共 session 后，Landing.vue 的 composerSid
 * 无公共 session fallback，真 landing 态为 null），不能用 sessionId=null 匹配 landing。改用 **variant** 判定：
 * - variant='landing'：消费 target=current 且 sessionId=null 的请求（routeToLanding 改写后）
 * - variant='panel'：消费 target=current 且 sessionId===当前 session 的请求
 * target=new 的原始请求（未 routeToLanding 前）只被 session composer 触发 startFlow，
 * 不被任何 composer 直接消费（避免 session composer 误注）。
 *
 * ## target='new' 两阶段时序
 * 阶段一（session composer）：watch 收到 target=new → startFlow → routeToLanding
 *   （store 把 target 改 current + sessionId=null）→ 本实例 variant=panel 且 sessionId≠null → 不匹配 → 不注入
 * 阶段二（landing composer 挂载）：onMounted 补检查遗留请求（此时 target=current，
 *   sessionId=null）→ variant=landing 匹配 → insertFileChip → clearInjection
 *
 * routeToLanding 重置 ts 是关键：让已挂载的 landing composer watch 也能被触发。
 * onMounted 补检查覆盖「landing composer 挂载早于 routeToLanding」，watch 覆盖「晚于」。
 *
 * ## 为什么单独抽 composable（不混进 useCommandPopoverTrigger）
 * useCommandPopoverTrigger 专管 slash/file 命令浮层触发态机（已稳定，不改动）。
 * drawer 注入语义不同（跨组件树 store 通道 + target 路由），混进去会让它从「命令浮层触发」
 * 膨胀成「命令浮层 + 通用注入」双职责。独立 composable 隔离编排。
 */
import { onMounted, watch, type Ref } from 'vue'
import { useComposerInjectionStore } from '@/stores/composer-injection'
import { useSessionStore } from '@/stores/session'
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import type ComposerInput from '@/components/panel/ComposerInput.vue'

export function useComposerInjection(
  inputRef: Ref<InstanceType<typeof ComposerInput> | null>,
  sessionId: Ref<string | null>,
  variant: Ref<'panel' | 'landing'>,
): void {
  const store = useComposerInjectionStore()
  const sessionStore = useSessionStore()
  const flow = useNewTaskFlow()

  /** 取注入用 cwd：target=new 时 startFlow 预设。用当前 session 的 cwd，无则 undefined。 */
  function resolveCwdForNewSession(): string | undefined {
    if (!sessionId.value) return undefined
    return sessionStore.list.find((s) => s.id === sessionId.value)?.cwd ?? undefined
  }

  /**
   * 执行 file chip 注入。
   * lineRange 从 lineStart/lineEnd 组装（两者都有才传，否则 undefined 即 path-only）。
   */
  function applyInjection(req: {
    path: string
    lineStart?: number
    lineEnd?: number
  }): void {
    const input = inputRef.value
    if (!input) return
    input.focus()
    const lineRange =
      req.lineStart !== undefined && req.lineEnd !== undefined
        ? ([req.lineStart, req.lineEnd] as [number, number])
        : undefined
    input.insertFileChip(req.path, lineRange)
  }

  /**
   * 消费注入请求（target 路由 + 匹配 + 注入）。抽出供 watch 和 onMounted 复用。
   * 返回 true 表示已消费（注入或路由），false 表示不匹配（留给其他 composer）。
   */
  async function consume(req: NonNullable<typeof store.pendingInjection>): Promise<boolean> {
    if (req.target === 'new') {
      if (variant.value === 'landing') {
        // landing composer 已挂载（用户已在 landing 态）→ 直接消费，不需 startFlow。
        // 覆盖「landing composer 先于注入请求存在」的时序（用户停在 landing，从 drawer 注入新对话）。
        applyInjection(req)
        store.clearInjection()
        return true
      }
      // 阶段一：session composer 触发 startFlow + routeToLanding（store 把 target 改 current）。
      // 仅当前 session 是活跃 session 时才 startFlow——避免 dual 挂载（landing+panel）时
      // 多个 panel composer 都触发 startFlow 误拆活跃 session（review M2）。
      // landing composer 若也挂载会直接消费 target=new（上方分支），但 routeToLanding 改写后
      // 它看到 target=current；panel 这里只做路由触发，不注入。
      if (sessionId.value !== sessionStore.active?.id) return false
      const cwd = resolveCwdForNewSession()
      try {
        await flow.startFlow(cwd)
      } catch {
        // startFlow 失败（如 landing 已占用 / 创建 session 失败）：清空占位请求，
        // 否则 pendingInjection 残留永久占槽位，后续注入被误判为「阶段二遗留」误消费（W8）。
        // 仅当本次请求未被新请求覆盖时才清（覆盖时新请求自己管生命周期）。
        if (store.pendingInjection === req) store.clearInjection()
        return true
      }
      // 竞态防护：await 期间若 pendingInjection 被新请求覆盖（用户连续点注入），
      // 不再 routeToLanding（新请求会自己走 watch 流程）。引用相等 = 未被覆盖。
      if (store.pendingInjection !== req) return true
      store.routeToLanding()
      return true
    }
    // target='current'：按 variant + sessionId 匹配
    // landing composer：消费 sessionId=null 的请求（routeToLanding 改写后，阶段二）
    if (variant.value === 'landing') {
      if (req.sessionId !== null) return false
      applyInjection(req)
      store.clearInjection()
      return true
    }
    // panel composer：消费 sessionId 匹配当前 session 的请求
    if (req.sessionId !== sessionId.value) return false
    applyInjection(req)
    store.clearInjection()
    return true
  }

  watch(
    () => store.pendingInjection,
    (req) => {
      if (!req) return
      // consume 内部应自处理错误；此处 catch 兜底防 watch 回调 reject 漏成 unhandled rejection。
      void consume(req).catch(() => {
        /* consume 内部应自处理错误 */
      })
    },
  )

  /**
   * 挂载时检查遗留注入请求（target='new' 阶段二 + 组件重建的遗留 target=current）。
   *
   * landing composer 挂载时，遗留请求的 target 可能已被 routeToLanding 改成 current
   * （阶段一已完成）。组件重建（panel 切换）时，target=current 的遗留请求若匹配也补消费。
   */
  onMounted(() => {
    const req = store.pendingInjection
    if (!req) return
    // 仅消费 target=current 的遗留请求（target=new 的阶段一由 session composer 触发，
    // landing composer 首次挂载若看到原始 target=new 说明阶段一未执行，不在此触发 startFlow）
    if (req.target !== 'current') return
    consume(req).catch(() => {
      /* consume 内部应自处理错误，此处兜底防 unhandled rejection */
    })
  })
}
