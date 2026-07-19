/**
 * useResizeReport —— Turn 高度测量上报基建（W2 effects 层）。
 *
 * 在 useVirtualTurnList（W1）与 Turn 组件（W4）之间搭桥：父组件 MessageStream
 * （W3）provide 一个 registry，Turn 组件 inject 后用 ResizeObserver 测自身高度，
 * 实测值经 registry.reportHeight 上报给虚拟滚动算法（替换估算值，校正窗口/offsets）。
 *
 * ── provide/inject registry（SR7/D9）─────────────────────────────
 * 父组件调 `provideTurnResizeRegistry({ reportHeight })` 在自身作用域 provide 一个
 * registry 实例；Turn 组件 setup 内调 `useResizeReport(rootEl, keyGetter)` inject 它。
 * 用 InjectionKey（Symbol）保证类型安全，避免字符串 key 漂移。
 *
 * ── 优雅降级 ────────────────────────────────────────────────────
 * Turn 在非虚拟列表环境（无父组件 provide）使用时，inject 拿到 undefined → 整个
 * composable no-op（不创建 RO、不上报），避免污染全局或抛错。这让 Turn 组件本身
 * 不需要感知「自己是否在虚拟列表内」，调用方装配时决定是否启用测量。
 *
 * ── RO 防死循环（SR8）──────────────────────────────────────────
 * ResizeObserver 的 contentRect.height 是亚像素浮点（如 123.4 → 123.6），若每次微
 * 变都上报，会触发 reportHeight → heights 更新 → 触发窗口重算 → 可能再触发布局
 * → RO 再次回调……死循环。两道防线：
 *   1. ε 阈值：|newH - oldH| < 1px 忽略（亚像素抖动 + 自身布局回流的小波动）
 *   2. 同帧合并：RO 一次回调可能带多个 entry（理论上 observe 单元素只会有一个，
 *      但防御性处理），取最后一个 entry 的高度作该帧结果
 *
 * ── RO disconnect（SR9）────────────────────────────────────────
 * onScopeDispose 调 RO.disconnect()：防泄漏（卸载后 RO 仍持 el 引用）+ 防卸载后
 * 上报命中失效键（虚拟列表已 resetSession 清空 heights，老 key 上报会造成脏数据）。
 */
import {
  getCurrentScope,
  inject,
  onScopeDispose,
  provide,
  watch,
  type InjectionKey,
  type Ref,
} from 'vue'

/** registry 形状：由虚拟列表消费方（useVirtualTurnList 的调用者）提供 */
export interface TurnResizeRegistry {
  /** 上报某 turn 的实测高度（key=turn 首消息 id，h=px 高度） */
  reportHeight: (key: string, h: number) => void
  /** 注销某 turn（卸载时清理；当前仅语义占位，虚拟列表用 resetSession 批量清） */
  unregister?: (key: string) => void
}

/** provideTurnResizeRegistry 入参：消费方提供的上报回调 */
export interface ProvideTurnResizeRegistryOptions {
  reportHeight: (key: string, h: number) => void
  unregister?: (key: string) => void
}

/**
 * provide/inject key（Symbol + InjectionKey 类型安全）。
 * 从独立 .ts 文件导出（非 <script setup> 内 export，SFC 编译器禁止）。
 */
export const TURN_RESIZE_REGISTRY_KEY: InjectionKey<TurnResizeRegistry> = Symbol('turn-resize-registry')

/**
 * 父组件（MessageStream）侧：在当前组件作用域 provide 一个 registry，供子树 Turn 注入。
 *
 * @example
 * ```ts
 * // MessageStream.vue setup
 * const registry = provideTurnResizeRegistry({
 *   reportHeight: (key, h) => virtualList.reportHeight(key, h),
 * })
 * ```
 * @returns 创建的 registry 实例（供父组件自己持有引用，如 session 切换时 notify）
 */
export function provideTurnResizeRegistry(options: ProvideTurnResizeRegistryOptions): TurnResizeRegistry {
  const registry: TurnResizeRegistry = {
    reportHeight: options.reportHeight,
    ...(options.unregister !== undefined ? { unregister: options.unregister } : {}),
  }
  provide(TURN_RESIZE_REGISTRY_KEY, registry)
  return registry
}

/** ε 阈值：高度变化小于此值（px）视为亚像素抖动，不上报（SR8） */
const HEIGHT_EPSILON = 1

/**
 * Turn 组件侧：测量自身 rootEl 高度并上报给虚拟列表。
 *
 * @param rootEl Turn 根元素 ref（template ref，可能初始为 null，元素挂载后赋值）
 * @param keyGetter turn 首消息 id getter（返回 string，作为 heights Map 的键）
 *
 * 内部行为：
 * 1. inject registry；拿不到（非虚拟列表环境）→ 立即返回 no-op（优雅降级）
 * 2. watch rootEl：元素绑定时 new ResizeObserver + observe；解绑时 disconnect
 * 3. RO 回调：ε 阈值过滤 + 同帧多 entry 合并取最后，调 registry.reportHeight(key, h)
 * 4. onScopeDispose：RO.disconnect() + registry.unregister(key)（SR9）
 *
 * @example
 * ```ts
 * // Turn.vue setup
 * const rootEl = ref<HTMLElement | null>(null)
 * useResizeReport(rootEl, () => props.turn.user?.id ?? props.turn.assistants[0]?.id ?? '')
 * ```
 */
export function useResizeReport(
  rootEl: Ref<HTMLElement | null>,
  keyGetter: () => string,
): void {
  const registry = inject(TURN_RESIZE_REGISTRY_KEY, null)

  // 优雅降级：非虚拟列表环境（无父组件 provide）→ no-op，不报错（约束：禁止污染全局）
  if (!registry) return

  // 不支持 ResizeObserver 的环境（如旧 Node 测试环境未 stub）→ no-op，避免构造时抛错
  if (typeof ResizeObserver === 'undefined') return

  let ro: ResizeObserver | null = null
  /** 上次上报的高度：ε 阈值比较基准。null 表示尚未上报过（首测必报） */
  let lastReportedHeight: number | null = null

  watch(
    rootEl,
    (el, _oldEl, onCleanup) => {
      if (!el) return

      ro = new ResizeObserver((entries: ResizeObserverEntry[]) => {
        // SR8 同帧合并：RO 可能一次回调多 entry，取最后一个的高度上报。
        // 单元素 observe 理论上只有 1 个 entry，但防御性取末项避免多 entry 逐个上报。
        const last = entries[entries.length - 1]
        if (!last) return

        // 测量取 border-box（含 padding + border），不是 contentRect（content-box，不含 padding/border）。
        // 虚拟滚动 offset = 累加各 turn 高度，若上报 contentRect 则底部 padding（如 Turn rootEl 的
        // pb-5 间距、SystemNotice 的 padding）被漏算 → 下一个 turn 的 top 算少 → 贴在上一个 turn
        // 末尾（如 ChangeSetCard 下沿贴下一个 user 气泡）。borderBoxSize 是数组（[0].blockSize
        // = 垂直尺寸）；不支持的旧环境 fallback 到 target.getBoundingClientRect().height
        // （同样含 padding + border，等价 border-box，绝不退到 contentRect）。
        let newH: number
        const bb = last.borderBoxSize
        if (bb && bb.length > 0) {
          newH = bb[0].blockSize
        } else {
          newH = (last.target as HTMLElement).getBoundingClientRect().height
        }

        // SR8 ε 阈值：亚像素抖动（< 1px）忽略，防 report→重排→再回调死循环。
        // 首次测量（lastReportedHeight === null）必报，让估算值尽快被实测替换。
        if (lastReportedHeight !== null && Math.abs(newH - lastReportedHeight) < HEIGHT_EPSILON) {
          return
        }

        lastReportedHeight = newH
        const key = keyGetter()
        if (key) registry.reportHeight(key, newH)
      })

      ro.observe(el)

      // watch 清理：rootEl 解绑（如 v-if 切换）时 disconnect 旧 RO。
      // 与 onScopeDispose 双保险——onScopeDispose 处理组件卸载，onCleanup 处理元素替换。
      onCleanup(() => {
        ro?.disconnect()
        ro = null
        // 元素替换时重置基准，让新元素首次测量必报（不沿用旧元素高度）
        lastReportedHeight = null
      })
    },
    { immediate: true },
  )

  // SR9 disconnect：仅在 effect scope 内注册卸载回调（组件 setup 或 effectScope.run）。
  // 无 active scope（如纯顶层调用，不应发生）跳过——避免 onScopeDispose 报错。
  if (getCurrentScope()) {
    onScopeDispose(() => {
      ro?.disconnect()
      ro = null
      const key = keyGetter()
      if (key) registry.unregister?.(key)
    })
  }
}
