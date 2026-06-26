/**
 * runtime interfaces 桩（git-service.ts / git-message-handler.ts 引用 ISessionService）。
 * 仅暴露 NewTaskFlow 链路用到的成员（getSummary → 取 cwd）。完整接口在 src-electron/runtime/src/interfaces.ts（未改动）。
 */
import type { SessionSummary } from '@xyz-agent/shared'

export interface ISessionService {
  create(cwd?: string, label?: string): Promise<SessionSummary>
  /** 取 session 摘要（含 cwd）。不存在 → undefined。GitService.getCwd 据此解析工作目录。 */
  getSummary(sessionId: string): SessionSummary | undefined
}
