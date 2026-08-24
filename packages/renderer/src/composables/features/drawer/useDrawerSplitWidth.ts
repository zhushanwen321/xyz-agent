/**
 * useDrawerSplitWidth —— main/drawer 动态拆分宽度控制（feat-chat-flow-width）。
 *
 * 背景：PanelContainer 原用 reka-ui Splitter 布局，两点能力缺口（替换原因）：
 * ① 单 panel 时 Splitter 强制 flexGrow:1（computePanelFlexBoxStyle），无法实现
 *    「无 drawer 对话流限宽 3/4」；
 * ② SplitterPanel 挂载/卸载瞬时重算 layout，无过渡参与，无法做开合宽度动画。
 * 故 PanelContainer 换手写 flex 布局，本 composable 承载其宽度模型：
 *
 * - 无 drawer：main 占 MAIN_STANDALONE_PCT%（右侧留白，避免内容列 720px 居中时两侧空白失衡）；
 * - 有 drawer：drawer 占 drawerPct%（默认 50），main 占剩侧（模板侧 calc(100% - drawerPct% - 1px)）；
 * - 开合时双侧 width transition（--duration-slow，与 DrawerPanel aside 淡入同时长）；
 * - 拖动（pointer capture 跟手，拖动期间 transition:none）/ 键盘微调调整 drawerPct，
 *   clamp [DRAWER_MIN_PCT, DRAWER_MAX_PCT]，localStorage 持久化；
 * - BrowserPane rect 同步：拖动/键盘直发 + 开合动画期间 rAF 循环逐帧派发
 *   xyz:splitter-layout（原 Splitter @layout 的替代路径；BrowserPane 侧 33ms 节流）。
 *
 * 单实例：PanelContainer 单实例挂载，本 composable 随其 setup/卸载（rAF 循环经
 * onScopeDispose 清理），无多实例注册问题。
 */
import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'

/** drawer 宽度持久化 key（与 reka-ui autoSaveId 旧数据格式不兼容，换 key 避免读到旧 layout 数组） */
const DRAWER_WIDTH_KEY = 'xyz-agent:drawer-width'
/** drawer 宽度百分比约束（对齐原 SplitterPanel min-size=20 / max-size=60） */
const DRAWER_MIN_PCT = 20
const DRAWER_MAX_PCT = 60
const DRAWER_DEFAULT_PCT = 50
/** 键盘微调步长（%，ArrowLeft 变窄 / ArrowRight 变宽），对齐原 Splitter 键盘交互 */
const KEYBOARD_STEP_PCT = 2
/** 开合动画期间 rAF 逐帧派发的覆盖时长（--duration-slow 320ms + 缓冲） */
const ANIM_NOTIFY_MS = 400
/** 小数 → 百分比换算因子（no-magic-numbers） */
const PCT_SCALE = 100

/** 无 drawer 时 main 区域占比（用户预期：无 drawer 3/4，有 drawer 动画到 1/2） */
export const MAIN_STANDALONE_PCT = 75

function clampDrawerPct(v: number): number {
  return Math.min(DRAWER_MAX_PCT, Math.max(DRAWER_MIN_PCT, v))
}

/** 恢复持久化的 drawer 宽度（非法/缺失回退默认 50） */
function loadDrawerPct(): number {
  const raw = localStorage.getItem(DRAWER_WIDTH_KEY)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? clampDrawerPct(n) : DRAWER_DEFAULT_PCT
}

/** 通知 BrowserPane 重算 viewport rect（BrowserPane 侧有 33ms 节流，高频派发无性能问题） */
function notifyLayout(): void {
  window.dispatchEvent(new CustomEvent('xyz:splitter-layout'))
}

/**
 * @param splitAreaEl main/drawer/handle 的共同容器（拖动换算基准 rect）
 * @param drawerOpen drawer 开合态（core drawer 域的 computed）
 */
export function useDrawerSplitWidth(splitAreaEl: Ref<HTMLElement | null>, drawerOpen: Ref<boolean>) {
  const isDragging = ref(false)
  const drawerPct = ref<number>(loadDrawerPct())

  /** main/drawer 双侧过渡类：拖动期间移除 transition 保证跟手，其余时间 width 过渡 */
  const splitTransitionClass = computed(() =>
    isDragging.value
      ? ''
      : 'transition-[width] duration-[var(--duration-slow)] ease-[var(--ease)]',
  )

  function persistDrawerPct(): void {
    localStorage.setItem(DRAWER_WIDTH_KEY, String(drawerPct.value))
  }

  /**
   * 开合动画期间逐帧派发 layout 事件（BrowserPane 的 WebContentsView setBounds 需要跟随
   * width 过渡逐帧同步）。rAF 循环覆盖 ANIM_NOTIFY_MS 后自停；reduced-motion 下 transition
   * 瞬时完成，多派发的事件被 BrowserPane 节流吸收，无害。
   */
  let layoutNotifyRafId: number | null = null
  watch(drawerOpen, () => {
    if (layoutNotifyRafId !== null) cancelAnimationFrame(layoutNotifyRafId)
    const start = performance.now()
    const tick = () => {
      notifyLayout()
      if (performance.now() - start < ANIM_NOTIFY_MS) {
        layoutNotifyRafId = requestAnimationFrame(tick)
      } else {
        layoutNotifyRafId = null
      }
    }
    layoutNotifyRafId = requestAnimationFrame(tick)
  })
  onScopeDispose(() => {
    if (layoutNotifyRafId !== null) cancelAnimationFrame(layoutNotifyRafId)
  })

  /**
   * handle 拖动（pointer capture：move/up 事件路由到 handle，拖出元素外仍跟手）。
   * pointerdown 不 preventDefault：保留后续 focus 行为（键盘可达性），选中防御靠 select-none。
   * jsdom 兼容：setPointerCapture/hasPointerCapture 可选调用（测试环境无 Pointer Capture API）。
   */
  function onHandlePointerDown(e: PointerEvent): void {
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture?.(e.pointerId)
    isDragging.value = true
    notifyLayout()
  }

  /** 拖动中：drawer 宽 = 容器右缘到指针的水平占比（handle 在 drawer 左缘，1px 误差可忽略） */
  function onHandlePointerMove(e: PointerEvent): void {
    const el = splitAreaEl.value
    if (!el || !isDragging.value) return
    const rect = el.getBoundingClientRect()
    if (rect.width === 0) return
    drawerPct.value = clampDrawerPct(((rect.right - e.clientX) / rect.width) * PCT_SCALE)
    notifyLayout()
  }

  /** 拖动结束（pointerup/cancel）：释放 capture + 持久化宽度 */
  function onHandlePointerUp(e: PointerEvent): void {
    const target = e.currentTarget as HTMLElement
    if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId)
    if (!isDragging.value) return
    isDragging.value = false
    persistDrawerPct()
  }

  /** 键盘微调（separator 可达性，对齐原 Splitter 键盘交互） */
  function onHandleKeydown(e: KeyboardEvent): void {
    let delta = 0
    if (e.key === 'ArrowLeft') delta = -KEYBOARD_STEP_PCT
    else if (e.key === 'ArrowRight') delta = KEYBOARD_STEP_PCT
    else return
    e.preventDefault()
    drawerPct.value = clampDrawerPct(drawerPct.value + delta)
    notifyLayout()
    persistDrawerPct()
  }

  return {
    drawerPct,
    isDragging,
    splitTransitionClass,
    onHandlePointerDown,
    onHandlePointerMove,
    onHandlePointerUp,
    onHandleKeydown,
  }
}
