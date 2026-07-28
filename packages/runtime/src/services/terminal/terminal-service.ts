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
 * shell 解析（Phase 6）：
 *   config.terminal.json 的 shell 字段（deps.configService 注入）→ fallback 登录 shell
 *   （macOS: dscl 读 UserShell；Linux: $SHELL）→ '/bin/bash'（win: 'powershell.exe'）。
 *   仅对新 spawn 的 PTY 生效。
 *
 * 错误模式：扁平 `Object.assign(new Error(msg), { code })`（仿 worktree-service），
 * code 为 TerminalErrorCode。write/resize/kill/attach 对不存在 sid 是 no-op（不抛错）。
 *
 * 日志：直接用 console.*（initLogger 已 patch 全局，tee 到文件，见架构约定 #4）。
 */
import { execFileSync } from 'node:child_process'
import type { ServerMessage } from '@xyz-agent/shared'
import type { ITerminalService } from '../ports/terminal-service.js'
import { TERMINAL_UNAVAILABLE } from '../../utils/errors.js'
import { SessionBuffer } from '../../transport/session-buffer.js'

// ── P2-s3 terminal scrollback 容量常量（spec §五） ────────────────────────────
// 复用 P2-s1 的 SessionBuffer 类（双限 ring buffer），但在 terminal-service 内持
// 独立 Map 实例（与 broker.sessionBuffers 物理隔离，见 D6）。终端 chunk 平均字节
// 远大于 chat event，故字节上限 256KB（远小于 broker 的 8MB）；条数固定 1000 不开
// 放 env（防误调造成无限增长）。
const DEFAULT_SCROLLBACK_MAX_COUNT = 1000
// eslint-disable-next-line no-magic-numbers -- 256KB = 256 * 1024，spec §五默认
const DEFAULT_SCROLLBACK_MAX_BYTES = 256 * 1024

// node-pty 是 native 模块，@xyz-agent/runtime 单独 npm 全局安装时若宿主机缺
// build-essential，加载会抛 MODULE_NOT_FOUND。此处用「懒加载动态 import + 哨兵」
// 而非顶层静态 import：模块加载不崩，terminal.* RPC 在首次 spawn 时检测到 pty=null
// 抛 terminal_unavailable，其余 runtime 功能（file/session/...）不受影响。
//
// 为什么懒加载而非模块加载时 require？
//   1. tsup 产物是 CJS（format: cjs），esbuild 拒绝顶层 await（CJS 不支持）；
//   2. vitest 的 vi.mock/vi.doMock 不拦截 require()（仅拦截 ESM import），用 require
//      会让测试无法模拟 node-pty 缺失；动态 import() 同时被 tsup 保留（external）和
//      vitest 拦截，是唯一两环境都 OK 的加载方式。
//   3. validate-runtime-bundle.sh 禁用 ESM 元信息 API（运行时不可用），故不能走
//      createRequire 路线（需 ESM 模块 URL）。
//
// ptyLoadAttempted 用于同步方法（write/resize/kill/destroyPty）的守卫：
// 若 spawn 已尝试加载且失败，ptyMap 必为空，这些方法抛 terminal_unavailable；
// 若从未 spawn 过（懒加载未触发），保持原 no-op 契约（防竞态）。
let pty: typeof import('node-pty') | null = null
let ptyLoadAttempted = false

/**
 * 懒加载 node-pty（首次 spawn 调用）。结果缓存到模块级 `pty`，后续调用幂等。
 * 失败（native 模块缺失/编译失败）置 `pty=null`，不抛——由调用方守卫决定降级行为。
 */
async function loadPty(): Promise<typeof import('node-pty') | null> {
  if (ptyLoadAttempted) return pty
  ptyLoadAttempted = true
  try {
    pty = await import('node-pty')
  } catch {
    pty = null
  }
  return pty
}

/** TerminalService 依赖。 */
export interface TerminalServiceDeps {
  /** 广播 ServerMessage 给所有连接（PTY 输出/退出/就绪信号）。由 server.broadcast 提供。 */
  broadcast: (msg: ServerMessage) => void
  /**
   * Phase 6：terminal 配置（shell/shellArgs 偏好）。可选——Phase 6 前的测试构造时不传，
   * resolveShell 走环境变量 fallback。生产路径由 index.ts 注入（configService 同源）。
   */
  configService?: { getTerminalConfig(): { config: { shell: string; shellArgs: string[] }; corrupted: boolean } }
}

/** terminal 业务错误工厂（扁平模式，仿 worktreeError）。 */
function terminalError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** 把 Error 序列化为 plain object，避免 logger 的 JSON.stringify 把 Error 实例变成 {}。
 *  Error 的 message/stack 在原型链上（非 own-enumerable），JSON.stringify 丢掉它们，
 *  导致 catch 块直接打印错误实例时日志只剩 {}，看不出真实错误。 */
function serializeError(e: unknown): { message: string; stack?: string; code?: unknown } | { value: string } {
  if (e instanceof Error) {
    return {
      message: e.message,
      stack: e.stack,
      ...('code' in e ? { code: (e as Error & { code: unknown }).code } : {}),
    }
  }
  return { value: String(e) }
}

/** 生成唯一广播消息 id（高频 terminal.data 需单调递增，避免同毫秒碰撞）。 */
let pushCounter = 0
function nextPushId(): string {
  pushCounter += 1
  return `terminal_push_${Date.now()}_${pushCounter}`
}

export class TerminalService implements ITerminalService {
  private readonly ptyMap = new Map<string, import('node-pty').IPty>()

  /**
   * P2-s3：per-session terminal scrollback ring buffer 池（spec §五）。
   *
   * 与 broker.sessionBuffers 物理隔离（D6）——两个独立 Map 实例 + 独立容量参数：
   * - broker 桶：8MB，为带 seq 的 chat event 回放设计；terminal.data 被 D3 排除规则
   *   挡在 broker 桶外（message-broker.ts broadcast 中 msg.type !== 'terminal.data'）。
   * - 本桶：256KB（默认），为无 seq 的终端 scrollback 回灌设计；不维护 evictedWatermark，
   *   不参与 seq 回放体系（D2：回灌消息不带 seq、不入 broker 桶）。
   *
   * 复用 SessionBuffer 类（双限 LRU 驱逐已验证），onEvict 传 no-op（terminal scrollback
   * 无 watermark 概念，驱逐只需删数据，不需推进全局 watermark）。
   *
   * 桶数受 XYZ_AGENT_MAX_SESSIONS 上限保护——kill/destroyPty 调 clearScrollback 清桶。
   */
  private readonly scrollbacks = new Map<string, SessionBuffer>()

  /**
   * scrollback 字节上限（构造期一次性解析 env，与 broker.maxBytesPerSession 同模式）。
   * env XYZ_AGENT_TERMINAL_SCROLLBACK_BYTES 覆盖默认 256KB。
   */
  private readonly scrollbackMaxBytes = Number(process.env.XYZ_AGENT_TERMINAL_SCROLLBACK_BYTES ?? DEFAULT_SCROLLBACK_MAX_BYTES)

  constructor(private deps: TerminalServiceDeps) {}

  async spawn(sid: string, cwd: string | undefined, cols: number, rows: number): Promise<void> {
    // 幂等：已有 PTY 则 no-op（防 TerminalView 重挂载重复 spawn）
    if (this.ptyMap.has(sid)) {
      console.log(`[terminal] spawn no-op (already alive): sid=${sid}`)
      return
    }

    // node-pty 缺失守卫：npm 全局安装无 build-essential 时加载失败，terminal 功能禁用。
    // 抛 terminal_unavailable（错误码常量见 utils/errors.ts），不崩溃整个 runtime。
    const ptyImpl = await loadPty()
    if (!ptyImpl) {
      throw terminalError(TERMINAL_UNAVAILABLE, 'node-pty not installed, terminal features disabled')
    }

    const { shell, shellArgs } = this.resolveShell()
    const spawnCwd = cwd ?? process.cwd()
    console.log(`[terminal] spawn: sid=${sid} shell=${shell} cwd=${spawnCwd} cols=${cols} rows=${rows}`)

    let proc: import('node-pty').IPty
    try {
      proc = ptyImpl.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: spawnCwd,
        env: this.buildEnv(),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[terminal] spawn failed: sid=${sid} shell=${shell}`, serializeError(e))
      throw terminalError('spawn_failed', `Failed to spawn terminal: ${msg}`)
    }

    this.ptyMap.set(sid, proc)

    // PTY 输出 → 广播 terminal.data（高频流）+ 追加到 scrollback buffer（P2-s3）
    proc.onData((data) => {
      const msg: ServerMessage = {
        type: 'terminal.data',
        id: nextPushId(),
        payload: { sessionId: sid, data },
      }
      // 先广播保证实时性（broadcast 内部 stringify 打全局 seq）
      this.deps.broadcast(msg)
      // 再追加到 scrollback（D2：存不带 seq 的副本，回灌零再序列化）。
      // 独立 stringify 一次（broadcast 不返回序列化产物，terminal-service 拿不到）；
      // append 失败（理论不抛，JSON.stringify 扁平消息无环形引用风险）best-effort 不影响已广播。
      try {
        this.getOrCreateScrollback(sid).append(0, JSON.stringify(msg))
      // eslint-disable-next-line taste/no-silent-catch -- scrollback 是 best-effort 历史缓存，失败不能影响实时 PTY 输出链路
      } catch (e) {
        console.error(`[terminal] scrollback append failed: sid=${sid}`, serializeError(e))
      }
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
    // node-pty 加载失败守卫（spawn 已尝试且 pty=null 时 ptyMap 必空，抛错而非静默 no-op）。
    // 未尝试加载时保持 no-op 契约（防 spawn 尚未就绪的竞态）。
    if (ptyLoadAttempted && !pty) {
      throw terminalError(TERMINAL_UNAVAILABLE, 'node-pty not installed, terminal features disabled')
    }
    const proc = this.ptyMap.get(sid)
    if (!proc) return // no-op：PTY 未就绪或已退出（竞态安全）
    try {
      proc.write(data)
    } catch (e) {
      // best-effort：进程已退出/管道关闭时 write 失败属预期竞态，onExit 回调会清理，不传播给调用方
      console.error(`[terminal] write failed: sid=${sid}`, serializeError(e))
    }
  }

  resize(sid: string, cols: number, rows: number): void {
    if (ptyLoadAttempted && !pty) {
      throw terminalError(TERMINAL_UNAVAILABLE, 'node-pty not installed, terminal features disabled')
    }
    const proc = this.ptyMap.get(sid)
    if (!proc) return
    try {
      proc.resize(cols, rows)
    } catch (e) {
      // best-effort：进程已退出时 resize 抛错属预期竞态，下次 spawn 会重建，不传播
      console.error(`[terminal] resize failed: sid=${sid}`, serializeError(e))
    }
  }

  kill(sid: string): void {
    if (ptyLoadAttempted && !pty) {
      throw terminalError(TERMINAL_UNAVAILABLE, 'node-pty not installed, terminal features disabled')
    }
    const proc = this.ptyMap.get(sid)
    if (!proc) return
    try {
      proc.kill()
    } catch (e) {
      // best-effort：重复 kill 或进程已退出时抛错，onExit 回调幂等清理 ptyMap + 广播 terminal.exit
      console.error(`[terminal] kill failed: sid=${sid}`, serializeError(e))
    }
    // P2-s3：kill 清除 scrollback（D4：用户主动 kill 视为放弃该 session 历史）。
    // 注意 onExit 回调不调 clearScrollback（PTY 自然退出时保留 exit 前输出供重新 attach）。
    this.clearScrollback(sid)
    // onExit 回调会清理 ptyMap + 广播 terminal.exit
  }

  attach(_sid: string): void {
    // 预留：流量控制（高频 terminal.data 拥塞时仅推活跃 sid）。当前 no-op。
  }

  destroyPty(sid: string): void {
    // 无 node-pty 缺失守卫：destroyPty 被 sessionService.setOnSessionDelete 回调调用
    // （index.ts:343-346 removeSessionEntry → onSessionDelete → destroyPty），路径无 try/catch。
    // 抛错会中断 session 删除/进程退出清理（session 文件终态缺失、前端收不到 session.exited）。
    // 即便 ptyLoadAttempted=true 且 pty=null（node-pty 缺失），ptyMap 必空 → 下行 if (!proc) return 自然兜底，
    // 保持 ports 契约「sid 无 PTY 时 no-op」。
    const proc = this.ptyMap.get(sid)
    if (!proc) return
    console.log(`[terminal] destroyPty (session delete): sid=${sid}`)
    try {
      proc.kill()
    } catch (e) {
      // best-effort：进程已退出时 kill 抛错，紧接的 ptyMap.delete 会兜底清理，不阻塞 session 销毁
      console.error(`[terminal] destroyPty kill failed: sid=${sid}`, serializeError(e))
    }
    this.ptyMap.delete(sid)
    // P2-s3：session 销毁清除 scrollback（D4：session 已删，buffer 不该残留）。
    this.clearScrollback(sid)
    // session 销毁不广播 terminal.exit（前端已在 session.deleted 清理分区）
  }

  // ── P2-s3 terminal scrollback（spec §五） ──────────────────────────────────

  /**
   * 惰性取/建该 session 的 scrollback buffer（spec §五 IF3）。
   *
   * 首次 PTY onData 才建桶（session 无 PTY 输出不占内存）。onEvict 传 no-op：
   * terminal scrollback 不维护 evictedWatermark（与 broker 不同——broker 用 onEvict
   * 推进全局 watermark 做 seq 回放判定；scrollback 无 seq、不参与 seq 回放体系，D2）。
   * 条数上限固定 DEFAULT_SCROLLBACK_MAX_COUNT，字节上限用构造期解析的 scrollbackMaxBytes。
   */
  private getOrCreateScrollback(sid: string): SessionBuffer {
    let buf = this.scrollbacks.get(sid)
    if (!buf) {
      // onEvict no-op：scrollback 驱逐只需删数据，不需回调通知（无 watermark 概念）。
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- SessionBuffer 构造要求 onEvict 回调，scrollback 无需动作
      buf = new SessionBuffer(DEFAULT_SCROLLBACK_MAX_COUNT, this.scrollbackMaxBytes, () => {})
      this.scrollbacks.set(sid, buf)
    }
    return buf
  }

  /**
   * 清除该 session 的 scrollback buffer（spec §五 IF3）。
   * kill（用户主动 kill）和 destroyPty（session 销毁）调用；PTY onExit 不调用（D4）。
   * 桶不存在时 Map.delete 是 no-op，不抛异常。
   */
  private clearScrollback(sid: string): void {
    this.scrollbacks.delete(sid)
  }

  /**
   * 返回该 session scrollback buffer 当前条数（只读测试钩子，spec §五 W1CT1）。
   * 桶不存在返回 0。只暴露 size 不暴露内部 SessionBuffer 实例，避免测试耦合实现细节。
   */
  getScrollbackSize(sid: string): number {
    return this.scrollbacks.get(sid)?.size ?? 0
  }

  /**
   * 解析 shell：优先 config.terminal.json 的 shell 字段，其次用户真实登录 shell，最后平台默认。
   * 登录 shell（非 config 路径）加 -l（加载 ~/.zshrc / ~/.bash_profile，让别名/PATH 生效）。
   *
   * [HISTORICAL] 不信 $SHELL 环境变量：Electron 从 GUI（Dock/Finder）启动时，process.env.SHELL
   * 继承自 launchd，是 macOS 历史默认的 /bin/bash，不反映用户 chsh 后的登录 shell。导致用户
   * 明明 chsh 成了 zsh，drawer 终端仍启动 bash 3.2，触发 bash 4+ 脚本（如 sdkman）报
   * bad substitution。macOS 正确做法是用 dscl 读 /Users/$USER 的 UserShell 记录。
   */
  private resolveShell(): { shell: string; shellArgs: string[] } {
    // Phase 6：读 terminal config（config 缺失或读取失败时 fallback 登录 shell）。
    // configService 可选——测试构造时不传，走 fallback。
    try {
      const cfg = this.deps.configService?.getTerminalConfig()
      if (cfg && cfg.config.shell.trim() !== '') {
        // config 提供 shell（用户显式设置）+ shellArgs（用户指定参数，原样透传不加 -l）
        return { shell: cfg.config.shell, shellArgs: cfg.config.shellArgs }
      }
    } catch (e) {
      // best-effort：config 读取失败（文件损坏/IO 错误）降级到登录 shell——不阻塞 PTY 启动
      console.warn('[terminal] read terminal config failed, falling back to login shell', e)
    }
    if (process.platform === 'win32') {
      return { shell: 'powershell.exe', shellArgs: [] }
    }
    // macOS：用 dscl 读真实登录 shell（不信 GUI 继承的 $SHELL，见方法注释 [HISTORICAL]）
    if (process.platform === 'darwin') {
      const loginShell = readDarwinLoginShell()
      if (loginShell) {
        return { shell: loginShell, shellArgs: ['-l'] }
      }
    }
    // Linux / dscl 失败：fallback $SHELL
    const shell = process.env.SHELL
    if (shell && shell.trim() !== '') {
      return { shell, shellArgs: ['-l'] }
    }
    return { shell: '/bin/bash', shellArgs: ['-l'] }
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

/**
 * 读取 macOS 当前用户的真实登录 shell（chsh 后的设置）。
 * 用 dscl 查 UserShell 记录，而非信 GUI 应用继承的 $SHELL（launchd 历史默认 /bin/bash）。
 * 失败（dscl 不存在/非 macOS/记录缺失）返回空串，由调用方走 $SHELL fallback。
 */
function readDarwinLoginShell(): string {
  try {
    const out = execFileSync('dscl', ['.', '-read', `/Users/${process.env.USER}`, 'UserShell'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
    // 输出形如 "UserShell: /bin/zsh"
    const match = out.match(/UserShell:\s*(\S+)/)
    const shell = match?.[1]?.trim() ?? ''
    return shell
  } catch {
    return ''
  }
}
