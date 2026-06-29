/**
 * useSideDrawer —— SideDrawer 打开/钉住/tab 状态控制（issues.md #9 / code-architecture §4.10 §6.3 点5）。
 *
 * 架构解耦：SideDrawer 的 open/dock/tab 控制逻辑下沉为此 composable，
 * 调用方（PanelContainer / Turn.vue / PanelHeader）仅共享同一状态实例，
 * 不直接持有 tab/dock 状态（避免随 widget 增多退化为上帝对象）。
 *
 * 单实例（Q2=A 单例：composable 模块单例，同 useNewTaskFlow）：SideDrawer 提升到 PanelContainer
 * （workspace-body）层，workspace 范围单实例，跟随 active panel（方向 = host 在左→贴右，host 在右→贴左）。
 * 状态在模块级，所有调用方共享；Turn.vue 点 slash chip 可控制同一 drawer。
 *
 * tab 集合：Terminal / Browser / Git / Doc。Git tab 承载 cwd 的全量 git 状态（GitPanel.vue）。
 * Doc tab 承载 slash 命令/skill 详细文档（CommandDocPanel.vue，selectedCommandName 指定展示哪个命令）。
 *
 * 依赖方向：无（纯 UI 状态 ref，不触碰 stores/api）。widget 订阅（#11）在 SideDrawer.vue
 * 内按 sessionId 独立接入；git 数据由 PanelContainer 经 GIT_STATUS_KEY provide，GitPanel inject——
 * 均不经此 composable，保持状态控制与数据订阅职责分离。
 */
import { ref } from 'vue'

export type SideDrawerTab = 'terminal' | 'browser' | 'git' | 'doc'

/** drawer open 的可选参数：打开时指定要展示的 slash 命令名（Doc tab 用） */
export interface OpenDrawerOptions {
  /** Doc tab 当前展示的命令名（如 '/commit'），CommandDocPanel 据此 + commandStore/skills 解析文档 */
  commandName?: string
}

// ── 模块级单实例状态（Q2=A：composable 模块单例，跨 useSideDrawer() 调用共享）──
/** 抽屉是否展开 */
const isOpen = ref(false)
/** 当前激活 tab（默认 terminal；PanelHeader git 按钮触发 open('git')，§4.10 F10） */
const activeTab = ref<SideDrawerTab>('terminal')
/** 钉住态：固定不被外部交互自动关闭（panel/spec.md 开/关/钉住三态） */
const docked = ref(false)
/** Doc tab 当前展示的命令名（点击用户气泡 slash chip 时设置） */
const selectedCommandName = ref<string | null>(null)

/**
 * 重置 SideDrawer 单实例状态（测试隔离用）。
 * 单实例状态跨 useSideDrawer() 调用共享，测试需在 beforeEach 重置避免串扰。
 */
export function resetSideDrawer(): void {
  isOpen.value = false
  activeTab.value = 'terminal'
  docked.value = false
  selectedCommandName.value = null
}

export function useSideDrawer() {
  /** 打开抽屉，可指定初始 tab + Doc tab 的选中命令 */
  function open(tab?: SideDrawerTab, opts?: OpenDrawerOptions): void {
    if (tab) activeTab.value = tab
    if (opts?.commandName !== undefined) selectedCommandName.value = opts.commandName
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

  return {
    isOpen,
    activeTab,
    docked,
    selectedCommandName,
    open,
    close,
    toggle,
    setTab,
    toggleDock,
  }
}
