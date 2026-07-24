/**
 * Browser drawer IPC handler。
 *
 * 对应 Browser Drawer Wave 1：注册 browser:create / navigate / hide / show / destroy
 * 五个 IPC channel，转发给 BrowserViewManager。
 *
 * [HISTORICAL] 不变量：
 * - IPC 参数用对象封装（AGENTS 关键规则 #1：emit/handle 单 payload 对象，禁止多 arg）。
 *   create / navigate 用 { sessionId, windowId } / { sessionId, url }，
 *   hide / show / destroy 用 sessionId（单值 channel，sender 不变）。
 * - handler 不做业务逻辑，仅转发；生命周期与错误处理在 BrowserViewManager 内。
 * - navigate 的 loadURL reject 会经 ipcMain.handle 自然变成 invoke rejection，
 *   renderer 侧 catch（W2 接）。
 *
 * 依赖方向：browser-handlers → electron(ipcMain) + interfaces(BrowserViewManager type-only)
 */
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { BrowserViewManager } from '../browser/browser-view-manager.js'

/**
 * 注册 browser drawer IPC handler。
 *
 * @param manager BrowserViewManager 实例（由 main.ts 构造注入）
 * @param _getMainWindow 主窗口取值器（W1 未用，W2 发事件给 renderer 时需要，预留参数避免后续改签名）
 */
export function registerBrowserHandlers(
  manager: BrowserViewManager,
  _getMainWindow: () => BrowserWindow | null,
): void {
  // 创建 view（attach 到 window，初始隐藏）
  ipcMain.handle('browser:create', (_event, { sessionId, windowId }: { sessionId: string; windowId: string }) => {
    manager.create(sessionId, windowId)
  })

  // 导航（loadURL 失败时 invoke reject）
  ipcMain.handle('browser:navigate', async (_event, { sessionId, url }: { sessionId: string; url: string }) => {
    await manager.navigate(sessionId, url)
  })

  // 隐藏（keep-alive，不销毁）
  ipcMain.handle('browser:hide', (_event, sessionId: string) => {
    manager.hide(sessionId)
  })

  // 显示（恢复最近 rect）
  ipcMain.handle('browser:show', (_event, sessionId: string) => {
    manager.show(sessionId)
  })

  // 切换可见 view（Wave 4 per-session 隔离）：隐藏当前可见的其他 session view，显示 target session view。
  // 场景：renderer watch(focusedSessionId) → 切 session 时调，确保屏幕只显示新 session 的 view。
  ipcMain.handle('browser:focus', (_event, sessionId: string) => {
    manager.focus(sessionId)
  })

  // 销毁（removeChildView + webContents.destroy）
  ipcMain.handle('browser:destroy', (_event, sessionId: string) => {
    manager.destroy(sessionId)
  })

  // 设置 view 位置/尺寸（renderer 推送，CSS px = DIP，不乘 dpr）。
  // 单对象 payload（AGENTS 规则 #1）：{ sessionId, rect }。
  ipcMain.handle(
    'browser:set-rect',
    (_event, { sessionId, rect }: { sessionId: string; rect: { x: number; y: number; width: number; height: number } }) => {
      manager.setRect(sessionId, rect)
    },
  )
}
