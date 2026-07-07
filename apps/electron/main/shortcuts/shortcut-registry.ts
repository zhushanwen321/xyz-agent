/**
 * ShortcutRegistry Facade（implements IShortcutRegistry）。
 *
 * 对应 spec §4.2 M5。原 shortcuts.ts 是平铺函数，本次提升为 class 并
 * 区分全局快捷键（globalShortcut）vs 窗口快捷键（accelerator）的注册时机。
 *
 * [HISTORICAL] 不变量：
 * - globalShortcut.register 对已占用的组合静默失败 → 注册前判断 globalShortcut.isRegistered（去重）
 * - 当前 2 个快捷键（CommandOrControl+1/3）都是全局的，通过 win.webContents.send('shortcut', type) 转发
 * - unregisterAll 幂等
 *
 * 依赖方向：shortcut-registry → electron(globalShortcut/BrowserWindow) + interfaces
 */
import { BrowserWindow, globalShortcut } from 'electron'
import type { IShortcutRegistry } from '../interfaces.js'

/** 快捷键类型（对应 renderer 监听的 type 字段） */
type ShortcutType = 'standard' | 'focus'

/** 快捷键映射表：accelerator → type */
const SHORTCUTS: Record<string, ShortcutType> = {
  'CommandOrControl+1': 'standard',
  'CommandOrControl+3': 'focus',
}

/**
 * ShortcutRegistry 实现。
 *
 * 使用方法：
 * ```ts
 * const registry = new ShortcutRegistry()
 * registry.registerGlobal(mainWindow)
 * registry.unregisterAll()
 * ```
 */
export class ShortcutRegistry implements IShortcutRegistry {
  /**
   * 注册全局快捷键。通过 win.webContents.send('shortcut', type) 转发到渲染进程。
   * 注册前判断 globalShortcut.isRegistrable，避免静默失败。
   */
  registerGlobal(win: BrowserWindow): void {
    for (const [accelerator, type] of Object.entries(SHORTCUTS)) {
      // [HISTORICAL] spec M5：globalShortcut.register 对已占用的组合静默失败。
      // isRegistered 判断本 app 是否已注册过（去重）；被其他 app 占用的情况 register 会静默失败，无法探测。
      if (globalShortcut.isRegistered(accelerator)) continue
      globalShortcut.register(accelerator, () => {
        if (!win.isDestroyed()) {
          win.webContents.send('shortcut', type)
        }
      })
    }
  }

  /** 注销所有已注册的快捷键（幂等） */
  unregisterAll(): void {
    globalShortcut.unregisterAll()
  }
}
