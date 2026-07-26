/**
 * IPC handler 注册入口。
 *
 * 对应 spec §4.2 M4「OS Gateway」Facade：编排特权 + 桥接 + browser 三类 handler 的注册。
 * 把原来一个函数 8+ handler 的内联实现拆为 privileged / bridge / browser 三个模块。
 *
 * 依赖方向：ipc-handlers → interfaces + privileged-handlers + bridge-handlers + browser-handlers
 */
import type { IpcHandlerDeps } from '../interfaces.js'
import { registerPrivilegedHandlers } from './privileged-handlers.js'
import { registerBridgeHandlers } from './bridge-handlers.js'
import { registerBrowserHandlers } from './browser-handlers.js'
import { registerUpdateHandlers } from './update-handlers.js'

/**
 * 注册所有 IPC handlers（特权 + 桥接 + browser drawer + 自动升级检测）。
 *
 * @param deps 注入依赖（实现由 main.ts 构造 MainContext 后提供）
 */
export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  registerPrivilegedHandlers(deps)
  registerBridgeHandlers(deps)
  registerBrowserHandlers(deps.browserViewManager, deps.getMainWindow)
  registerUpdateHandlers(deps)
}
