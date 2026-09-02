/**
 * transport 域错误构造工厂（renderer-deepening D10①）。
 *
 * `code: 'disconnected'` 是调用方识别「传输断开类失败」的字符串契约——
 * 识别方靠 `error.code === 'disconnected'` 区分可重试的传输失败与业务错误，
 * 任何一处手写字面量拼错即静默失配（编译器无信号）。此前 4 处
 * （api/request.ts send-fail、use-connection.ts stateWatch 两分支 + queue-drop）
 * 各自 Object.assign 手写，靠注释互相对齐——收编为单点后新增构造只能走本工厂。
 */
export interface TransportUnavailableError extends Error {
  code: 'disconnected'
}

/**
 * 构造传输不可用错误（code='disconnected' 字面量唯一出处）。
 *
 * @param message 展示文案（调用方决定来源：i18n key 经 ports.t 解析，或固定英文）
 */
export function transportUnavailableError(message: string): TransportUnavailableError {
  const error = new Error(message) as TransportUnavailableError
  error.code = 'disconnected'
  return error
}
