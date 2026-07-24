/**
 * TerminalService 实现 —— drawer 集成终端的 PTY 生命周期管理（Phase 2）。
 *
 * 🔒 三层架构：services/terminal/terminal-service.ts 实现 ports/terminal-service.ts。
 *
 * 职责：
 * 1. per-session PTY 映射（ptyMap: Map<sessionId, IPty>）
 * 2. spawn：node-pty spawn shell → onData 广播 terminal.data → onExit 广播 terminal.exit + 清理 → 广播 terminal.alive
 * 3. write/resize/kill/attach：转发到对应 PTY（无 PTY 时 no-op）
 * 4. destroyPty：session 销毁时 kill + 清理
 *
 * shell 解析（Phase 6 前）：
 *   configService?.getTerminalShell?.()（Phase 6 注入，当前不存在此方法）
 *   → fallback process.env.SHELL → '/bin/bash'（win: 'powershell.exe'）
 * Phase 6 接入 configService 后，spawn 读 config 的 shell/shellArgs。
 *
 * 错误模式：扁平 `Object.assign(new Error(msg), { code })`（仿 worktree-service），
 * code 为 TerminalErrorCode。write/resize/kill/attach 对不存在 sid 是 no-op（不抛错）。
 *
 * 日志：直接用 console.*（initLogger 已 patch 全局，tee 到文件，见架构约定 #4）。
 */
import * as pty from 'node-pty'
import type { ServerMessage } from '@xyz-agent/shared'
import type { ITerminalService } from '../ports/terminal-service.js'

/** TerminalService 依赖。 */
export interface TerminalServiceDeps {
  /** 广播 ServerMessage 给所有连接（PTY 输出/退出/就绪信号）。由 server.broadcast 提供。 */
  broadcast: (msg: ServerMessage) => void
}

/** terminal 业务错误工厂（扁平模式，仿 worktreeError）。 */
function terminalError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** 生成唯一广播消息 id（高频 terminal.data 需单调递增，避免同毫秒碰撞）。 */
let pushCounter = 0
function nextPushId(): string {
  pushCounter += 1
  return `terminal_push_${Date.now()}_${pushCounter}`
}

export class TerminalService implements ITerminalService {
  private readonly ptyMap = new Map<string, pty.IPty>()

  constructor(private deps: TerminalServiceDeps) {}

  async spawn(sid: string, cwd: string | undefined, cols: number, rows: number): Promise<void> {
    // 幂等：已有 PTY 则 no-op（防 TerminalView 重挂载重复 spawn）
    if (this.ptyMap.has(sid)) {
      console.log(`[terminal] spawn no-op (already alive): sid=${sid}`)
      return
    }

    const { shell, shellArgs } = this.resolveShell()
    const spawnCwd = cwd ?? process.cwd()
    console.log(`[terminal] spawn: sid=${sid} shell=${shell} cwd=${spawnCwd} cols=${cols} rows=${rows}`)

    let proc: pty.IPty
    try {
      proc = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: spawnCwd,
        env: this.buildEnv(),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[terminal] spawn failed: sid=${sid} shell=${shell}`, e)
      throw terminalError('spawn_failed', `Failed to spawn terminal: ${msg}`)
    }

    this.ptyMap.set(sid, proc)

    // PTY 输出 → 广播 terminal.data（高频流）
    proc.onData((data) => {
      this.deps.broadcast({
        type: 'terminal.data',
        id: nextPushId(),
        payload: { sessionId: sid, data },
      })
    })

    // PTY 退出 → 广播 terminal.exit + 清理 ptyMap
    proc.onExit(({ exitCode }) => {
      console.log(`[terminal] exit: sid=${sid} exitCode=${exitCode}`)
      this.ptyMap.delete(sid)
      this.deps.broadcast({
        type: 'terminal.exit',
        id: nextPushId(),
        payload: { sessionId: sid, exitCode },
      })
    })

    // 就绪信号（renderer flush 写队列——联动 2 异步写时序）
    this.deps.broadcast({
      type: 'terminal.alive',
      id: nextPushId(),
      payload: { sessionId: sid },
    })
  }

  write(sid: string, data: string): void {
    const proc = this.ptyMap.get(sid)
    if (!proc) return // no-op：PTY 未就绪或已退出（竞态安全）
    try {
      proc.write(data)
    } catch (e) {
      // best-effort：进程已退出/管道关闭时 write 失败属预期竞态，onExit 回调会清理，不传播给调用方
      console.error(`[terminal] write failed: sid=${sid}`, e)
    }
  }

  resize(sid: string, cols: number, rows: number): void {
    const proc = this.ptyMap.get(sid)
    if (!proc) return
    try {
      proc.resize(cols, rows)
    } catch (e) {
      // best-effort：进程已退出时 resize 抛错属预期竞态，下次 spawn 会重建，不传播
      console.error(`[terminal] resize failed: sid=${sid}`, e)
    }
  }

  kill(sid: string): void {
    const proc = this.ptyMap.get(sid)
    if (!proc) return
    try {
      proc.kill()
    } catch (e) {
      // best-effort：重复 kill 或进程已退出时抛错，onExit 回调幂等清理 ptyMap + 广播 terminal.exit
      console.error(`[terminal] kill failed: sid=${sid}`, e)
    }
    // onExit 回调会清理 ptyMap + 广播 terminal.exit
  }

  attach(_sid: string): void {
    // 预留：流量控制（高频 terminal.data 拥塞时仅推活跃 sid）。当前 no-op。
  }

  destroyPty(sid: string): void {
    const proc = this.ptyMap.get(sid)
    if (!proc) return
    console.log(`[terminal] destroyPty (session delete): sid=${sid}`)
    try {
      proc.kill()
    } catch (e) {
      // best-effort：进程已退出时 kill 抛错，紧接的 ptyMap.delete 会兜底清理，不阻塞 session 销毁
      console.error(`[terminal] destroyPty kill failed: sid=${sid}`, e)
    }
    this.ptyMap.delete(sid)
    // session 销毁不广播 terminal.exit（前端已在 session.deleted 清理分区）
  }

  /**
   * 解析 shell（Phase 6 前用环境变量 fallback）。
   * Phase 6 注入 configService 后，优先读 config.getTerminalShell()。
   */
  private resolveShell(): { shell: string; shellArgs: string[] } {
    // Phase 6 TODO: const cfg = this.configService?.getTerminalConfig?.(); if (cfg?.shell) return { shell: cfg.shell, shellArgs: cfg.shellArgs }
    if (process.platform === 'win32') {
      return { shell: 'powershell.exe', shellArgs: [] }
    }
    const shell = process.env.SHELL || '/bin/bash'
    // 登录 shell 加 -l（加载 ~/.zshrc / ~/.bash_profile，让别名/PATH 生效）
    const shellArgs = ['-l']
    return { shell, shellArgs }
  }

  /** 构造子进程 env（继承当前 env，确保 PATH 等可用）。 */
  private buildEnv(): Record<string, string> {
    // node-pty env 需 string→string（不能 undefined）。过滤掉 undefined 值。
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }
    // TERM 让终端应用（vim/htop）正确渲染
    env.TERM = env.TERM || 'xterm-256color'
    return env
  }
}
