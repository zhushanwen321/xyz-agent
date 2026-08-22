/**
 * @zhushanwen/pi-session-manager — Session manager extension.
 *
 * 提供 agent-managed session 的 6 个管理工具：
 * - create_managed_session: 创建新 session
 * - send_to_session: 向 session 发送消息
 * - get_session_history: 获取 session 历史
 * - get_session_status: 获取 session 状态
 * - list_managed_sessions: 列出 managed sessions
 * - abort_session: 中止 session
 *
 * 依赖 runtime 侧 SessionManagerHandler 处理实际逻辑。
 */

// Extension 入口（pi extension API）
export default {
  name: 'session-manager',
  description: 'Agent-managed session management tools',
}
