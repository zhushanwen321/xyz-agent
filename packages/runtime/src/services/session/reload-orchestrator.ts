/**
 * ReloadOrchestrator（W5）—— skill 变更触发的 session reload 编排。
 *
 * [定位] service 层单例。skill 文件变动（SkillRegistry 监听）后，对受影响的 session
 * 触发 pi reload（重扫 skill + 重建 runtime），无需重启进程。
 *
 * [编排策略]
 *   - idle session（!isGenerating 且进程存活）→ 立即 promptReload（发 `/__xyz_reload__`）
 *   - running session → 设 pendingReload flag，等该 session 的 message.complete
 *     （agent_end，生成完成）后再 promptReload，清 flag
 *   - best-effort：promptReload 抛错只记日志 + 清 flag，不重试、不阻塞（reload 失败
 *     下次 skill 变更仍可重试，因 flag 已清）
 *
 * [解耦] 不直接依赖 SkillRegistry / SessionService 具体类型，只依赖注入的窄接口
 * （isSessionIdle / promptReload / hasSession）。组合根 index.ts 绑定：
 *   - skillRegistry.onChange → orchestrator.onSkillChange
 *   - message.complete 广播包装 → orchestrator.onMessageComplete
 *
 * [内部命令] `/__xyz_reload__` 由 builtin extension（xyz-agent-extension.js）注册，
 * handler 调 pi ctx.reload()。前端 W4 已过滤 `/__` 前缀命令不显示给用户。
 */
/** Orchestrator 依赖的 SessionService 窄接口（组合根注入完整实现）。 */
export interface ReloadSessionService {
  /** session 是否处于可 reload 的空闲态（!isGenerating 且进程存活）。允许返回 Promise。 */
  isSessionIdle(sessionId: string): boolean | Promise<boolean>
  /** 向 session 发 `/__xyz_reload__` 触发 pi reload。失败抛错由 orchestrator 降级处理。 */
  promptReload(sessionId: string): Promise<void>
  /** session 是否仍存活（进程未退出 / 未被 delete）。缺省时视为存活（不做删除检测）。 */
  hasSession?(sessionId: string): boolean
}

export interface ReloadOrchestratorOptions {
  sessionService: ReloadSessionService
}

export class ReloadOrchestrator {
  /** 待 reload 的 sessionId 集合（running session 在 message.complete 后消费）。 */
  private readonly pendingReload = new Set<string>()

  constructor(private readonly options: ReloadOrchestratorOptions) {}

  /**
   * SkillRegistry 变动回调。遍历受影响 session：
   *   - idle → 立即 promptReload（best-effort，失败清 flag 不重试）
   *   - running → 入 pendingReload 队，等 onMessageComplete 消费（已有 flag 跳过，不重复入队）
   */
  async onSkillChange(affectedSessionIds: string[]): Promise<void> {
    await Promise.allSettled(affectedSessionIds.map((sid) => this.handleSkillChangeForSession(sid)))
  }

  /**
   * message.complete 事件回调。若该 session 在 pendingReload 队中，
   * 说明 skill 变更发生在它 running 期间，现在生成完成，发 reload 清 flag。
   */
  async onMessageComplete(sessionId: string): Promise<void> {
    if (!this.pendingReload.has(sessionId)) return
    this.pendingReload.delete(sessionId)
    await this.doReload(sessionId)
  }

  /** 单个 session 的 skill 变更处理。 */
  private async handleSkillChangeForSession(sessionId: string): Promise<void> {
    // 排队期 session 被删除（deleteSession）→ 跳过
    if (this.options.sessionService.hasSession && !this.options.sessionService.hasSession(sessionId)) {
      this.pendingReload.delete(sessionId)
      return
    }
    const idle = await this.options.sessionService.isSessionIdle(sessionId)
    if (idle) {
      // idle：已无 flag（否则 isGenerating 还 true），直接 reload
      await this.doReload(sessionId)
    } else {
      // running：设 flag，等 message.complete
      this.pendingReload.add(sessionId)
    }
  }

  /**
   * 实际发 reload。best-effort：抛错只记日志 + 清 flag（防残留阻塞下次变更）。
   * 不重试（reload 失败多为 pi 进程异常，重试只会再抛）。
   */
  private async doReload(sessionId: string): Promise<void> {
    try {
      await this.options.sessionService.promptReload(sessionId)
    } catch (e) {
      console.error(`[reload-orchestrator] promptReload failed: sessionId=${sessionId}`, e)
      // 清 flag：下次 skill 变更可重新触发（U13 断言）
      this.pendingReload.delete(sessionId)
    }
  }
}
