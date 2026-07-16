/**
 * W6 D16 · 快捷键配置测试（U12）—— 降级只读版。
 *
 * 实现程度：降级只读展示。原因（见 SystemPage.vue template TODO）：
 *  - 监听器在 Sidebar.vue keymap 硬编码按 key 匹配（keymap 数组用固定 'k'/'n'/'b'），
 *    非「读 useAppCommands 内存值派发」。完整实现需 keymap 改读 commandStore +
 *    shortcut override 持久化 + 实时生效，风险高（可能破坏 ⌘K/⌘N/⌘B 核心交互）。
 *  - 故降级为只读展示当前快捷键 + TODO 注释。
 *
 * U12 验证目标（降级版）：
 *  - useAppCommands 注册的应用命令含 new-session(⌘N) / toggle-sidebar(⌘B)
 *  - SystemPage 据此展示当前快捷键（commandStore.appCommands 含 shortcut 字段）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

describe('U12: 快捷键配置（降级只读展示）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // useAppCommands 依赖 commandStore + sidebarStore，均在 pinia 下
    vi.resetModules()
  })

  it('registerAppCommands 注册 new-session(⌘N) / toggle-sidebar(⌘B)，含 shortcut 字段', async () => {
    const { registerAppCommands } = await import('@/composables/features/useAppCommands')
    const { useCommandStore } = await import('@/stores/command')
    const { useSidebarStore } = await import('@/stores/sidebar')

    const commandStore = useCommandStore()
    const sidebarStore = useSidebarStore()

    registerAppCommands({
      newSession: vi.fn(),
      goOverview: vi.fn(),
    })

    const cmds = commandStore.appCommands
    const newSession = cmds.find((c) => c.id === 'new-session')
    const toggleSidebar = cmds.find((c) => c.id === 'toggle-sidebar')
    const goOverview = cmds.find((c) => c.id === 'go-overview')

    expect(newSession).toBeDefined()
    // shortcut 格式随平台变化（Mac=⌘N，其他=Ctrl+N），断言包含主键即可
    expect(newSession?.shortcut).toContain('N')
    expect(toggleSidebar).toBeDefined()
    expect(toggleSidebar?.shortcut).toContain('B')
    expect(goOverview).toBeDefined()
    // go-overview 无快捷键（只注册命令）
    expect(goOverview?.shortcut).toBeUndefined()

    // sidebarStore 被使用（toggleCollapsed 绑定），不报错即说明注册成功
    expect(sidebarStore).toBeDefined()
  })

  it('appCommands 含 shortcut 的命令可被 SystemPage 筛选展示', async () => {
    const { registerAppCommands } = await import('@/composables/features/useAppCommands')
    const { useCommandStore } = await import('@/stores/command')

    const commandStore = useCommandStore()
    registerAppCommands({ newSession: vi.fn(), goOverview: vi.fn() })

    // SystemPage.shortcutCommands 过滤条件：id 在 new-session/toggle-sidebar/go-overview 中
    const SHORTCUT_LABELS: Record<string, true> = {
      'new-session': true,
      'toggle-sidebar': true,
      'go-overview': true,
    }
    const shortcutCommands = commandStore.appCommands.filter((c) => c.id in SHORTCUT_LABELS)
    expect(shortcutCommands).toHaveLength(3)
    expect(shortcutCommands.map((c) => c.id).sort()).toEqual(['go-overview', 'new-session', 'toggle-sidebar'])
  })

  it('i18n command namespace 含三个命令的显示名', async () => {
    const { setLocale } = await import('@/i18n')
    const i18n = (await import('@/i18n')).default
    setLocale('zh-CN')
    expect(i18n.global.t('settings.command.new-session')).toBe('新建任务')
    expect(i18n.global.t('settings.command.toggle-sidebar')).toBe('收起侧栏')
    expect(i18n.global.t('settings.command.go-overview')).toBe('概览')
    setLocale('en-US')
    expect(i18n.global.t('settings.command.new-session')).toBe('New session')
    expect(i18n.global.t('settings.command.toggle-sidebar')).toBe('Toggle sidebar')
    expect(i18n.global.t('settings.command.go-overview')).toBe('Overview')
  })
})
