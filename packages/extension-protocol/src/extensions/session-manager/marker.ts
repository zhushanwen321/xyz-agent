/**
 * session-manager 请求的 title marker。runtime event-adapter 和 handler
 * 检测此 marker 区分 session-manager 请求与普通 select。
 *
 * NUL 前缀确保不会与 extension 正常的 select title 冲突。
 * 与 ASK_USER_MARKER / GUI_WIDGET_MARKER 同理。
 */
export const SESSION_MANAGER_MARKER = '\x00XYZ_SESSION_MANAGER'
