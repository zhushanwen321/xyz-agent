/**
 * session-service.ts 改接点骨架（code-wiring-cheatsheet §C）。
 *
 * 真实文件 src-electron/runtime/src/services/session/session-service.ts 改动：
 * - 构造加末尾参数 workspaceService: WorkspaceService
 * - 内部 new SessionLifecycle(...) / new MessageDispatcher(...) 转注入 workspaceService
 *
 * architecture §2：WorkspaceService 与 SessionService 平级非嵌套，无环。
 */
import type { WorkspaceService } from '../services/workspace/workspace-service.js'
import type { SessionLifecycle } from './session-lifecycle.wiring.js'
import type { MessageDispatcher } from './message-dispatcher.wiring.js'

/** SessionService 构造既有依赖（骨架简化，真实 9 个参数）。 */
interface SessionServiceDeps {
  workspaceService: WorkspaceService
}

export class SessionService {
  private readonly lifecycle: SessionLifecycle
  private readonly dispatcher: MessageDispatcher

  constructor(deps: SessionServiceDeps) {
    // 既有：new SessionLifecycle(this, pm, configStore, sessionStore, ...)
    // 改后：末尾加 deps.workspaceService（构造注入 lifecycle + dispatcher）
    this.lifecycle = { record: async () => { throw new Error('stub') } } as unknown as SessionLifecycle
    this.dispatcher = { sendPrompt: async () => ({ blocked: false }) } as unknown as MessageDispatcher
    void deps.workspaceService // 真实：转注入 lifecycle/dispatcher 构造
  }
}
