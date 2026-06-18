/**
 * 安全环境变量构建（最小权限原则）。
 *
 * [HISTORICAL] 不变量（CLAUDE.md 规则：路径/ENV 白名单动态化）：
 * - ENV_WHITELIST 基于 shared 的 ENV_WHITELIST_PREFIXES，main 进程额外允许 ELECTRON_ 前缀
 * - runtime-manager.ts 和 rpc-client.ts 各有一份白名单，rpc-client 必须是 runtime-manager 的子集
 * - Pre-commit check_env_whitelist_sync.py 会 diff 两份白名单
 *
 * 依赖方向：safe-env → shared（type-only + 运行时常量）
 */
import { ENV_WHITELIST_PREFIXES } from '@xyz-agent/shared'

/**
 * 子进程允许继承的环境变量前缀白名单。
 * 在 shared 白名单基础上扩展 ELECTRON_（main 进程专属）。
 */
export const ENV_WHITELIST: readonly string[] = [...ENV_WHITELIST_PREFIXES, 'ELECTRON_']

/**
 * 构建最小权限环境变量：只继承白名单前缀匹配的 + 额外指定的变量。
 *
 * @param extras 额外注入的变量（undefined 值会被跳过）
 * @returns 精简后的 env 对象
 */
export function buildSafeEnv(extras: Record<string, string | undefined>): Record<string, string> {
  void extras
  throw new Error('not implemented: buildSafeEnv')
}
