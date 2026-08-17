/**
 * subagent 虚拟 session id 判断（w6 从 renderer stores/subagent.ts 抽出）。
 *
 * isSubagentVirtualId 判断 session id 是否为 subagent 虚拟 id（格式 'subagent:<mainSid>:<subId>'）。
 * 纯函数，供 TurnSummary 等组件决定是否隐藏 fork/handoff 按钮（subagent session 不支持 fork/handoff）。
 */

/** subagent 虚拟 session id 前缀（与 renderer stores/subagent.ts SUBAGENT_PREFIX 同源） */
const SUBAGENT_PREFIX = 'subagent:'

export function isSubagentVirtualId(sessionId: string): boolean {
  if (!sessionId.startsWith(SUBAGENT_PREFIX)) return false
  const rest = sessionId.slice(SUBAGENT_PREFIX.length)
  const sepIdx = rest.indexOf(':')
  if (sepIdx <= 0) return false
  return sepIdx < rest.length - 1
}
