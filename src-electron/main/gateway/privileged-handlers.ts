/**
 * 特权 IPC handler（需 OS 能力）。
 *
 * 对应 spec §4.2 M4「特权 handler」：pickDirectory / openExternal / openSettingsWindow。
 * 每个单独做输入校验（委托 input-validators）。
 *
 * [HISTORICAL] 不变量：
 * - openSettingsWindow 单例：已有未销毁实例则 focus，不重复创建
 * - openExternal 校验 http/https（isValidExternalUrl）
 * - pickDirectory 用 BrowserWindow.getFocusedWindow()（无聚焦窗口返回 canceled）
 *
 * 依赖方向：privileged-handlers → electron(dialog/shell/BrowserWindow) + input-validators + interfaces
 */
import { BrowserWindow, dialog, shell, app } from 'electron'
import path from 'node:path'
import type { IpcHandlerDeps } from '../interfaces.js'
import { isValidExternalUrl } from './input-validators.js'

/** openSettingsWindow 返回类型 */
export interface OpenSettingsWindowResult {
  type: 'focused-existing' | 'created-new'
}

/**
 * 注册特权 IPC handler（open-settings-window / open-external / pick-directory）。
 *
 * @param deps 注入的依赖（getMainWindow/getSettingsWindow/setSettingsWindow/isDev/createWindow）
 */
export function registerPrivilegedHandlers(deps: IpcHandlerDeps): void {
  void deps
  void BrowserWindow; void dialog; void shell; void app; void path
  void isValidExternalUrl
  throw new Error('not implemented: registerPrivilegedHandlers')
}
