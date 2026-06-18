/**
 * IPC handler 注册入口。
 *
 * 对应 spec §4.2 M4「OS Gateway」Facade：编排特权 + 桥接两类 handler 的注册。
 * 把原来一个函数 8+ handler 的内联实现拆为 privileged / bridge 两个模块。
 *
 * 依赖方向：ipc-handlers → interfaces + privileged-handlers + bridge-handlers + electron(ipcMain)
 */
import { ipcMain } from 'electron'
import type { IpcHandlerDeps } from '../interfaces.js'
// TODO(B类): 完整实现需 import 并调用以下两个注册器：
//   import { registerPrivilegedHandlers } from './privileged-handlers.js'
//   import { registerBridgeHandlers } from './bridge-handlers.js'

/**
 * 注册所有 IPC handlers（特权 + 桥接）。
 *
 * @param deps 注入依赖（实现由 main.ts 构造 MainContext 后提供）
 */
export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  // ⚠️ 最小可运行实现：当前只注册挂载阶段的卡死型 handler。
  // renderer useConnection.init() 会 await get-runtime-port / get-runtime-port-offset，
  // 若无 handler 则 Promise 永久 pending → UI 白屏。这两个必须先注册。
  // 其余 handler（特权 / 桥接）待 B 类填充 privileged-handlers / bridge-handlers 后接入。

  ipcMain.handle('get-runtime-port', () => deps.runtime.port)
  ipcMain.handle('get-runtime-port-offset', () => deps.runtime.portOffset)

  // 最小可运行补充：get-windows 在 renderer 挂载阶段被 windowStore 触发
  // （App.vue onListUpdated → refreshFromIPC）。虽被 .catch 吞掉不阻塞，
  // 但会刷错误日志，故一并注册。完整 window 系列 handler 待 B 类 bridge-handlers。
  ipcMain.handle('get-windows', () => deps.windowManager.getAll())

  // TODO(B类): 接入完整 handler 注册
  // registerPrivilegedHandlers(deps)
  // registerBridgeHandlers(deps)
}
