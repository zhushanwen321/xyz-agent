/**
 * 自动升级检测 IPC handler。
 *
 * 对应 slice auto-update-and-install：注册 'update:check' channel，
 * 委托给 IReleaseChecker.checkForLatestRelease（透传 app.getVersion() + force）。
 *
 * [HISTORICAL] 不变量：
 * - 单 payload 对象规则：emit('update:check', { force })，禁止多 arg
 * - releaseChecker 未注入时返回 null（开发/测试降级）
 * - checkForLatestRelease 内部已 catch 所有失败返回 null，此处仅兜底防止
 *   IpcMainInvokeEvent 层面意外 reject 拖垮 renderer
 *
 * 依赖方向：update-handlers → electron(app/ipcMain) + interfaces
 */
import { app, ipcMain } from 'electron'
import type { IpcHandlerDeps } from '../interfaces.js'

/**
 * 注册自动升级检测 IPC handler。
 *
 * @param deps 注入依赖（用 releaseChecker）
 */
export function registerUpdateHandlers(deps: IpcHandlerDeps): void {
  ipcMain.handle('update:check', async (_event, payload?: { force?: boolean }) => {
    if (!deps.releaseChecker) return null
    try {
      return await deps.releaseChecker.checkForLatestRelease(app.getVersion(), {
        force: payload?.force,
      })
    } catch (err) {
      // 兜底：理论上 checkForLatestRelease 自身已 catch，此处防止意外 reject
      console.error('[update:check] failed:', err)
      return null
    }
  })
}
