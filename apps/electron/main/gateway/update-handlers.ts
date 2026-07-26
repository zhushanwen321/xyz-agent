/**
 * 自动升级 IPC handler。
 *
 * 对应 slice auto-update-and-install：注册两类 channel：
 *   - 'update:check'：检测最新版（w2，委托 IReleaseChecker.checkForLatestRelease）
 *   - 'update:perform'：执行升级（w3，委托 IUpdateOrchestrator.performUpdate +
 *     推 update:progress / update:error 事件 + 收到 triggerRestart 后调 app.quit）
 *
 * [HISTORICAL] 不变量：
 * - 单 payload 对象规则：emit('update:perform', { release })，禁止多 arg
 * - update:perform 内 onProgress 转发为 'update:progress' 事件（win.isDestroyed 守卫）
 * - 错误转发为 'update:error' 事件（区分 UpdateError.stage / UpdateUnsupportedError.errorCode）
 * - orchestrator 是纯逻辑（不调 app.quit）；quit 由本 handler 在 triggerRestart=true 后调
 * - quit 用 setTimeout(500) 延迟：给前端一点时间显示「重启中」状态
 * - releaseChecker / updateOrchestrator 未注入时降级（check 返回 null / perform 抛错）
 *
 * 依赖方向：update-handlers → electron(app/ipcMain) + interfaces + update/types
 */
import { app, ipcMain } from 'electron'
import type { LatestReleaseInfo } from '@xyz-agent/shared'
import type { IpcHandlerDeps } from '../interfaces.js'
import { UpdateError, UpdateUnsupportedError } from '../update/types.js'
import { validateRelease } from '../update/validate-release.js'

/**
 * 注册自动升级 IPC handler（update:check + update:perform）。
 *
 * @param deps 注入依赖（releaseChecker / updateOrchestrator / getMainWindow）
 */
export function registerUpdateHandlers(deps: IpcHandlerDeps): void {
  // ── update:check（w2：检测最新版）──────────────────────────────
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

  // ── update:perform（w3：执行升级）──────────────────────────────
  ipcMain.handle('update:perform', async (_event, payload: { release: LatestReleaseInfo }) => {
    if (!deps.updateOrchestrator) {
      throw new Error('updateOrchestrator not configured')
    }
    try {
      // [SECURITY] 校验 renderer payload：防 SSRF（downloadUrl 白名单 GitHub 域名）+
      // 路径遍历（name 严格字符集）+ shell 注入（name/version/sha256 严格格式）。
      // 必须在 performUpdate 前执行——orchestrator 内部会把 name 拼进下载路径、
      // 可能 spawn bash 脚本，未校验的输入可触发任意代码执行。
      validateRelease(payload.release)
      const result = await deps.updateOrchestrator.performUpdate(payload.release, {
        onProgress: (stage, percent) => {
          const win = deps.getMainWindow()
          if (win && !win.isDestroyed()) {
            win.webContents.send('update:progress', { stage, percent })
          }
        },
      })
      if (result.triggerRestart) {
        // 延迟 500ms 给前端时间显示「重启中」，再 quit
        setTimeout(() => app.quit(), 500)
      }
      return result
    } catch (err) {
      // 错误转 update:error 事件（区分 stage / errorCode）
      const win = deps.getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('update:error', {
          stage: err instanceof UpdateError ? err.stage : 'replacing',
          message: err instanceof Error ? err.message : String(err),
          errorCode: err instanceof UpdateUnsupportedError ? err.errorCode : undefined,
        })
      }
      // 透传给 invoke 的 reject（前端 catch）
      throw err
    }
  })
}
