/**
 * IPC handler 注册入口。
 *
 * 对应 spec §4.2 M4「OS Gateway」Facade：编排特权 + 桥接两类 handler 的注册。
 * 把原来一个函数 8+ handler 的内联实现拆为 privileged / bridge 两个模块。
 *
 * 依赖方向：ipc-handlers → interfaces + privileged-handlers + bridge-handlers
 */
import type { IpcHandlerDeps } from '../interfaces.js'
import { registerPrivilegedHandlers } from './privileged-handlers.js'
import { registerBridgeHandlers } from './bridge-handlers.js'

/**
 * 注册所有 IPC handlers（特权 + 桥接）。
 *
 * @param deps 注入依赖（实现由 main.ts 构造 MainContext 后提供）
 */
export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  void deps
  void registerPrivilegedHandlers; void registerBridgeHandlers
  throw new Error('not implemented: registerIpcHandlers')
}
