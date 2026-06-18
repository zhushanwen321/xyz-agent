/**
 * Gateway 输入校验（纯函数）。
 *
 * 对应 spec §4.2 M4「特权 handler 每个单独做输入校验」。
 * 把校验逻辑抽成纯函数，handler 调用后决定放行/拒绝。
 *
 * [HISTORICAL] 不变量：
 * - openExternal 必须校验 http/https 协议（防 file:// / javascript: 等危险协议）
 * - 路径类校验用 path.resolve 规范化 + 前缀匹配（防 ../ 穿越）
 *
 * 这是纯函数文件——签名即设计，不深化骨架。
 *
 * 依赖方向：无下游（纯函数）
 */

/**
 * 校验 URL 是否允许 openExternal。
 * 只允许 http/https 协议。
 *
 * @param url 待校验 URL
 * @returns true=安全可打开 / false=危险协议
 */
export function isValidExternalUrl(url: string): boolean {
  void url
  throw new Error('not implemented: isValidExternalUrl')
}

/**
 * 校验路径是否在允许的前缀目录内（防目录穿越）。
 * 用于 local-file:// 协议 handler。
 *
 * @param filePath 待校验路径
 * @param allowedPrefixes 允许的根目录列表
 * @returns true=在白名单内 / false=越界
 */
export function isPathInAllowedPrefixes(filePath: string, allowedPrefixes: readonly string[]): boolean {
  void filePath; void allowedPrefixes
  throw new Error('not implemented: isPathInAllowedPrefixes')
}
