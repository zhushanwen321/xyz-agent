/**
 * code-skeleton/runtime/services/file-error.ts — FileError 错误类型（⑤code-arch §3 F-2，#2）
 *
 * FileService 所有越界/权限/超时失败抛 FileError(code)。§6 来源 B NFR-AC-S2/S5 断言按 code 锚定。
 * 与现有 GitError（git-service.ts:29-36，readonly code: string）范式对称。
 */
export type FileErrorCode =
  | 'session_not_found'
  | 'permission_denied'
  | 'out_of_cwd' // NFR-AC-S2 越界统一守门
  | 'timeout' // AC-2.5 / K-2 fs-executor 超时
  | 'not_found'
  | 'read_failed'

export class FileError extends Error {
  constructor(readonly code: FileErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'FileError'
  }
}
