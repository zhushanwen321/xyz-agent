/**
 * session-lifecycle.ts 改接点骨架（code-wiring-cheatsheet §D）。
 *
 * 真实文件 src-electron/runtime/src/services/session/session-lifecycle.ts 改动：
 * - 构造加 workspaceService 参数
 * - create() 成功返回前调 this.workspaceService.record(sessionCwd)（写入时机 A，D-007 唯一挂点）
 *
 * 下面是改动方法的 Level 1 接线 stub（验证签名 + 接线，不展开 pi createSession 实现）。
 */
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

/** SessionLifecycle 既有依赖（骨架简化，真实见 session-lifecycle.ts）。 */
interface SessionLifecycleDeps {
  workspaceService: WorkspaceService
}

export class SessionLifecycle {
  constructor(private readonly deps: SessionLifecycleDeps) {}

  /**
   * create — 写入时机 A（D-007 唯一挂点）。
   *
   * 接线（既有不变部分省略，仅标 record 调用点）：
   * - sessionCwd = cwd ?? process.cwd()（既有 line 41）
   * - pi createSession + ensureSessionFile + toSummary（既有，不变）
   * - 成功返回前调 workspaceService.record(sessionCwd)（新增）
   *
   * 异常路径 E1-1：pi create 失败 → throw（不到 record，#2 不写入）。
   */
  async create(cwd?: string, _label?: string): Promise<{ id: string; cwd: string }> {
    const sessionCwd = cwd ?? process.cwd()
    // 既有 pi createSession 逻辑（骨架叶子不展开）：
    // const client = await this.pm.createSession(...)
    // const session = await this.svc.initializeManagedSession(...)
    // this.sessionStore.ensureSessionFile(...)
    const session = await this.piCreateSessionStub(sessionCwd)

    // ── 写入时机 A：record sessionCwd（D-007 唯一挂点）──
    this.deps.workspaceService.record(session.cwd)

    return session
  }

  /** pi createSession 既有逻辑的叶子占位（骨架不展开，实现期沿用既有）。 */
  private async piCreateSessionStub(_sessionCwd: string): Promise<{ id: string; cwd: string }> {
    throw new Error('Not implemented: pi createSession 既有逻辑，见 session-lifecycle.ts')
  }
}
