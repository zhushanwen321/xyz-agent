/**
 * Commands API 模块
 *
 * 提供命令注册的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerCommandRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.commands.register / plugin.commands.unregister 两个 RPC 方法。
 *   register 把 CommandRegistration 存入 registry（commandId→registration），
 *   并调用 broadcastRegistered 下行广播 plugin:commandRegistered。
 *
 * Worker 侧：createCommandsApi() 返回代理对象，提供 register/unregister。
 *   handler 驻留 Worker 本地（TC1 VSCode 模式）：register 只经 RPC 传命令元数据，
 *   执行时主线程经 plugin.commands.invoke 通知回调 Worker 本地 handler。
 *   Worker 监听 invoke 通知，dispatchHandler 命中本地 handler，结果经
 *   plugin.commands.invoke.result RPC 回传主线程（hook-api 同款模式）。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import type { Disposable } from '../plugin-types.js'
import { registerHandler, dispatchHandler } from '../handler-registry.js'
import { toErrorMessage } from '../../../utils/errors.js'

/** 命令声明元数据（与 Phase2AgentAPI['commands'].register 参数对齐，IF1） */
export interface CommandDescriptor {
  id: string
  title?: string
  category?: string
  keybinding?: string
  when?: string
}

/**
 * 运行时命令注册表条目（DM1）。
 * handlerRef 语义：handlerId 是 Worker 本地 handler 引用（invoke 回调用），
 * pluginId 定位 Worker，与 s2 IF6 CommandRecord.handlerRef 对齐（仅契约对齐，不依赖 s2 代码）。
 */
export interface CommandRegistration {
  commandId: string
  pluginId: string
  handlerId: string
  title?: string
  category?: string
  keybinding?: string
  when?: string
  registeredAt: number
}

/** 命令注册服务依赖（主线程侧） */
export interface CommandService {
  /** 命令注册表，key 为 commandId */
  registry: Map<string, CommandRegistration>
  /** register 后下行广播 plugin:commandRegistered（payload 为 CommandRegistration） */
  broadcastRegistered: (reg: CommandRegistration) => void
}

/**
 * 在 PluginRpcServer 上注册命令相关的 RPC handler。
 *
 * 注册的方法：
 * - `plugin.commands.register` — 注册命令（命令元数据 + handlerId 引用）
 * - `plugin.commands.unregister` — 注销命令（幂等：不存在时 no-op，ES1）
 */
export function registerCommandRpcHandlers(
  rpcServer: PluginRpcServer,
  service: CommandService,
): void {
  rpcServer.registerMethod('plugin.commands.register', async (params) => {
    const pluginId = params.pluginId as string
    const command = params.command as CommandDescriptor
    const handlerId = params.handlerId as string

    const registration: CommandRegistration = {
      commandId: command.id,
      pluginId,
      handlerId,
      title: command.title,
      category: command.category,
      keybinding: command.keybinding,
      when: command.when,
      registeredAt: Date.now(),
    }

    service.registry.set(registration.commandId, registration)
    service.broadcastRegistered(registration)

    return { registered: true }
  })

  rpcServer.registerMethod('plugin.commands.unregister', async (params) => {
    const commandId = params.commandId as string

    // ES1: 幂等 no-op——不存在的 commandId 直接 delete 返回 false，无副作用
    service.registry.delete(commandId)

    return { unregistered: true }
  })
}

/** Worker 本地存储的命令 handler 包装 */
interface StoredCommand {
  commandId: string
  handler: (args?: unknown) => unknown | Promise<unknown>
}

let commandCounter = 0

/**
 * 创建 Worker 侧 Commands API 代理对象。
 *
 * register() 会：
 * 1. 生成唯一 handlerId（`cmd_${pluginId}_${递增}`，hook-api 同款计数模式）
 * 2. 保存 handler 到 Worker 本地 map（handlerId → { commandId, handler }）
 * 3. 发 RPC plugin.commands.register 到主线程（只传元数据 + handlerId）
 * 4. 返回 Disposable（dispose 时发 RPC 注销并清理本地 map）
 *
 * 同时注册 `plugin.commands.invoke` 通知处理器（TC1 handler 驻留 Worker）：
 * - 收到通知后 dispatchHandler 从本地 map 查找 handler
 * - 调用 handler(args)
 * - 结果通过 `plugin.commands.invoke.result` RPC 返回主线程（hook-api 同款）
 */
export function createCommandsApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  register(
    command: CommandDescriptor,
    handler: (args?: unknown) => unknown | Promise<unknown>,
  ): Promise<Disposable>
  unregister(commandId: string): Promise<void>
} {
  // handlerId → StoredCommand（dispatchHandler 按 handlerId 查 map）
  const handlers = new Map<string, StoredCommand>()

  // 注册 invoke 通知处理器（主线程回调 Worker 中的 command handler）
  rpcClient.onNotification('plugin.commands.invoke', (params: unknown) => {
    const p = params as { handlerId: string; args?: unknown }
    dispatchHandler(handlers, p, stored => {
      Promise.resolve(stored.handler(p.args))
        .then((result) => {
          rpcClient
            .request('plugin.commands.invoke.result', {
              handlerId: p.handlerId,
              result,
            })
            .catch((e: unknown) => {
              console.error('[commands-api] invoke result delivery failed:', toErrorMessage(e))
            })
        })
        .catch((e: unknown) => {
          console.error('[commands-api] command handler error:', toErrorMessage(e))
        })
    })
  })

  return {
    register: async (command, handler) => {
      const handlerId = `cmd_${pluginId}_${++commandCounter}`

      await rpcClient.request('plugin.commands.register', {
        pluginId,
        command,
        handlerId,
      })

      return registerHandler(handlers, handlerId, { commandId: command.id, handler }, () => {
        rpcClient
          .request('plugin.commands.unregister', { pluginId, commandId: command.id })
          .catch((e: unknown) => {
            console.error('[commands-api] command unregister failed:', toErrorMessage(e))
          })
      })
    },

    unregister: async (commandId) => {
      // 从本地 map 移除该 commandId 的 handler（幂等）
      for (const [handlerId, stored] of handlers) {
        if (stored.commandId === commandId) {
          handlers.delete(handlerId)
          break
        }
      }
      await rpcClient.request('plugin.commands.unregister', { pluginId, commandId })
    },
  }
}
