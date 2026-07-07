/**
 * Hook 执行管道（HookPipeline）
 *
 * 从 PluginService 抽出的正交职责：hook 排序 / 串行执行 / 5s 超时 / block 语义 /
 * content transform。
 *
 * 设计要点（ADR-0012 契约不变）：
 * - 持有 hookRegistry 引用（与 rpc-setup 注册侧、本类消费侧共享同一 Map 实例，
 *   保证注册与执行看到同一份状态）。
 * - 持有 host / rpcServer 引用用于实际派发到 Worker。
 * - 行为与原 PluginService.executeHooks 完全一致：按 priority 升序串行执行，
 *   proceed === false 终止链路（block），modifiedData 透传（transform），
 *   每个 handler 超时 5s、超时/异常视为放行，Worker crashed 跳过该 handler。
 */

import type { HookEntry, HookContext, HookResult } from './plugin-types.js'
import type { PluginHost } from './plugin-host.js'
import type { PluginRpcServer } from './plugin-rpc-server.js'
import { toErrorMessage } from '../../utils/errors.js'

/** 每个 hook handler 的执行超时（ms） */
const HOOK_HANDLER_TIMEOUT_MS = 5_000

/** HookPipeline 所需的派发依赖（最小接口，便于单测 mock） */
export interface HookPipelineDeps {
  /** 共享的 hook 注册表（注册侧与本类消费侧同一实例） */
  hookRegistry: Map<string, HookEntry[]>
  /** Worker host，用于查询插件所在 Worker handle */
  host: PluginHost
  /** RPC server，用于向 Worker 派发 hook 调用 */
  rpcServer: PluginRpcServer
}

export class HookPipeline {
  private readonly hookRegistry: Map<string, HookEntry[]>
  private readonly host: PluginHost
  private readonly rpcServer: PluginRpcServer

  constructor(deps: HookPipelineDeps) {
    this.hookRegistry = deps.hookRegistry
    this.host = deps.host
    this.rpcServer = deps.rpcServer
  }

  /** 暴露共享注册表引用（rpc-setup 注册侧、uninstallPlugin 清理侧使用） */
  get registry(): Map<string, HookEntry[]> {
    return this.hookRegistry
  }

  /**
   * 执行指定 hookType 的钩子管道。
   *
   * 从 hookRegistry 获取 handlers，按 priority 升序排序后串行执行。
   * 支持 block（proceed === false 终止链路）和 content transform（modifiedData 传递）。
   * 每个 handler 超时 5s，超时/异常视为放行。Worker crashed → skip 该 handler。
   *
   * @param hookType - hook 类型（如 'onBeforeSendMessage'）
   * @param context - Hook 执行上下文（会被 transform 修改）
   * @returns HookResult
   */
  async execute(hookType: string, context: HookContext): Promise<HookResult> {
    const entries = this.hookRegistry.get(hookType)
    if (!entries || entries.length === 0) return { blocked: false }

    // 按 priority 排序：built-in (0) → trusted (100) → sandbox (200)
    const sorted = [...entries].sort((a, b) => a.priority - b.priority)

    // 串行执行：await 每个 handler，支持 transform 和 block
    for (const entry of sorted) {
      const handle = this.host.getWorkerHandle(entry.pluginId)
      if (!handle) continue // Worker crashed → skip

      try {
        const result = await this.rpcServer.invoke(
          handle.workerId,
          'plugin.hooks.invoke',
          {
            handlerId: entry.handlerId,
            hookType,
            context,
          },
          HOOK_HANDLER_TIMEOUT_MS, // 每个 handler 超时
        ) as Record<string, unknown>

        // 检查是否被阻止
        if (result && typeof result === 'object' && 'proceed' in result && result.proceed === false) {
          return {
            blocked: true,
            reason: (result.reason as string) ?? `Blocked by plugin ${entry.pluginId}`,
            blockedBy: entry.pluginId,
          }
        }

        // 检查是否需要转换内容
        if (result && typeof result === 'object' && 'modifiedData' in result && result.modifiedData !== undefined) {
          context = {
            ...context,
            data: result.modifiedData,
          }
        }
      // eslint-disable-next-line taste/no-silent-catch -- hook: timeout/error means proceed, non-blocking by design
      } catch (err: unknown) {
        // 超时或错误 → 视为放行（不阻止链路）
        console.warn(
          `[plugin-service] hook handler ${entry.handlerId} failed/timed out:`,
          toErrorMessage(err),
        )
      }
    }

    return { blocked: false }
  }
}
