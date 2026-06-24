/**
 * useSideDrawer —— SideDrawer 打开/钉住/tab 状态控制（issues.md #9 / code-architecture §4.10 §6.3 点5）。
 *
 * 架构解耦：SideDrawer 的 open/dock/tab 控制逻辑从 Panel.vue 下沉到此 composable，
 * Panel.vue 仅作 slot 容器（不直接持有 tab/dock 状态，避免随 widget 增多退化为上帝对象）。
 *
 * per-instance：每个 Panel 持有独立 drawer 状态（SideDrawer 与 Panel 数据强耦合，
 * 固定挂该 Panel，panel/spec.md）。在 Panel.vue setup 中调用。
 *
 * tab 集合：Terminal / Browser（§6.3 点2，不含 Diff——Diff 审批 Out-of-scope，见 spec FR-8）。
 * git-zone Diff 按钮触发 open()，默认 Terminal tab（§4.10 F10）。
 *
 * 依赖方向：无（纯 UI 状态 ref，不触碰 stores/api）。widget 订阅（#11）在 SideDrawer.vue
 * 内按 sessionId 独立接入，不经过此 composable——保持状态控制与数据订阅职责分离。
 */
import { ref } from 'vue'

export type SideDrawerTab = 'terminal' | 'browser'

export function useSideDrawer() {
  /** 抽屉是否展开 */
  const isOpen = ref(false)
  /** 当前激活 tab（默认 terminal；§4.10 F10 git-zone Diff 按钮触发后默认 Terminal） */
  const activeTab = ref<SideDrawerTab>('terminal')
  /** 钉住态：固定不被外部交互自动关闭（panel/spec.md 开/关/钉住三态） */
  const docked = ref(false)

  /** 打开抽屉，可指定初始 tab（未指定则沿用当前 activeTab） */
  function open(tab?: SideDrawerTab): void {
    if (tab) activeTab.value = tab
    isOpen.value = true
  }

  /** 关闭抽屉（钉住态亦可手动关闭） */
  function close(): void {
    isOpen.value = false
  }

  /** 切换开关；从关到开可指定 tab */
  function toggle(tab?: SideDrawerTab): void {
    if (isOpen.value) close()
    else open(tab)
  }

  /** 切换 tab（抽屉关闭时仅改 activeTab，不自动打开） */
  function setTab(tab: SideDrawerTab): void {
    activeTab.value = tab
  }

  /** 切换钉住态 */
  function toggleDock(): void {
    docked.value = !docked.value
  }

  return { isOpen, activeTab, docked, open, close, toggle, setTab, toggleDock }
}
