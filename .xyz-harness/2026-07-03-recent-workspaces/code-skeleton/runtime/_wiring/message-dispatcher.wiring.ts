/**
 * message-dispatcher.ts 改接点骨架（code-wiring-cheatsheet §D）。
 *
 * 真实文件 src-electron/runtime/src/services/session/message-dispatcher.ts 改动：
 * - 构造加 workspaceService 参数
 * - sendPrompt() line 83（activeSession.lastActiveAt = Date.now() 同处）加 workspaceService.record
 *
 * 下面是改动方法的 Level 1 接线 stub（验证签名 + 接线，不展开 hook/ensureActive/prompt 实现）。
 */
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

/** MessageDispatcher 既有依赖（骨架简化）。 */
interface MessageDispatcherDeps {
  workspaceService: WorkspaceService
}

interface ActiveSessionView {
  cwd: string
  lastActiveAt: number
  isGenerating: boolean
}

export class MessageDispatcher {
  constructor(private readonly deps: MessageDispatcherDeps) {}

  /**
   * sendPrompt — 写入时机 B（message-dispatcher.ts:58 private async sendPrompt，line 83 同处）。
   *
   * 接线（既有不变部分省略，仅标 record 调用点）：
   * - runBeforeSendHook（既有，blocked 则 return 不 record）
   * - ensureActive（既有，失败则 throw 不 record）
   * - activeSession.lastActiveAt = Date.now()（既有 line 83）
   * - 同处加 workspaceService.record(activeSession.cwd)（新增）
   * - client.prompt（既有）
   *
   * 异常路径：
   * - E2-1 hook blocked → 不 record
   * - E2-2 ensureActive 失败 → throw 不 record
   * - E2-3 activeSession 不存在 → 跳过 record，不阻断 prompt
   * - E2-4 高频发消息 → WriteBackCache 500ms debounce 合并（AC-3.2）
   */
  async sendPrompt(_sessionId: string, _hookContent: string, _buildPrompt: () => string): Promise<{ blocked: boolean }> {
    // 既有 hook + ensureActive 逻辑（骨架叶子不展开）：
    // if ((await this.runBeforeSendHook(...)).blocked) return { blocked: true }
    // const client = await this.svc.ensureActive(sessionId)
    const activeSession = await this.ensureActiveStub()
    if (activeSession) {
      activeSession.lastActiveAt = Date.now() // 既有 line 83
      // ── 写入时机 B：record activeSession.cwd（line 83 同处）──
      this.deps.workspaceService.record(activeSession.cwd)
      activeSession.isGenerating = true
    }
    // 既有 client.prompt 逻辑（骨架叶子不展开）：
    // await client.prompt(buildPrompt())
    await this.promptStub()
    return { blocked: false }
  }

  /** ensureActive 既有逻辑的叶子占位（骨架不展开）。 */
  private async ensureActiveStub(): Promise<ActiveSessionView | undefined> {
    throw new Error('Not implemented: ensureActive 既有逻辑，见 message-dispatcher.ts')
  }

  /** client.prompt 既有逻辑的叶子占位（骨架不展开）。 */
  private async promptStub(): Promise<void> {
    throw new Error('Not implemented: client.prompt 既有逻辑，见 message-dispatcher.ts')
  }
}
