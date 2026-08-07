/**
 * Runtime 全局常量（wave1 起）。
 *
 * 集中放置跨模块共享的运行时配置常量，便于测试 import 与未来扩展。
 * env 读取在此处一次性求值（模块加载时），下游消费稳定快照。
 */

/**
 * 单 runtime 进程允许同时存在的 session 数量上限（W1-T6）。
 * 达上限时 session.create 抛 SESSION_LIMIT_REACHED，前端引导用户关闭旧 session。
 * 默认 10；经 env XYZ_AGENT_MAX_SESSIONS 覆盖（须为正整数，否则回退默认）。
 */
export const MAX_SESSIONS: number = (() => {
  const DEFAULT_MAX_SESSIONS = 10
  const raw = process.env.XYZ_AGENT_MAX_SESSIONS
  if (!raw) return DEFAULT_MAX_SESSIONS
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_SESSIONS
})()
