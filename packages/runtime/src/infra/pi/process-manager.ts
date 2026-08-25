import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter as pathDelimiter, dirname, join } from 'node:path'
import { execSync } from 'node:child_process'
import { RpcClient, type RpcClientOptions } from './rpc-client.js'
import { getConfigDir } from './pi-paths.js'
import { assertPiSessionFile } from './session-attach-assert.js'
import type { IProcessManager } from '../../services/ports/pi-engine.js'
import { toErrorMessage } from '../../utils/errors.js'
import { isPackaged } from '../../utils/runtime-env.js'

// Find pi executable path (cross-platform). Search order:
// Packaged: Resources/pi/pi-<plat>-<arch>
// Dev: apps/electron/resources/pi/pi-<plat>-<arch> (prepare-pi-resources.sh 产物)
//   fallback: PATH (which/where pi) → nvm → common locations
function findPiExecutable(projectRoot: string): string {
  const platform = process.platform  // 'darwin' | 'win32' | 'linux'
  const arch = process.arch          // 'arm64' | 'x64'
  const binaryName = platform === 'win32'
    ? `pi-windows-${arch}.exe`
    : `pi-${platform}-${arch}`

  // Packaged mode: use bundled pi binary from resources
  if (isPackaged()) {
    // Runtime's cwd = process.resourcesPath (set by runtime-manager.ts)
    const bundledPi = join(process.cwd(), 'pi', binaryName)

    if (!existsSync(bundledPi)) {
      throw new Error(
        `Bundled pi binary not found at ${bundledPi}. `
        + `Expected binary: ${binaryName}. `
        + 'The application installation may be corrupted.',
      )
    }

    console.log(`[process-manager] using bundled pi: ${bundledPi}`)
    return bundledPi
  }

  // Development mode: 优先用 resources/pi 里 prepare 的二进制（与打包版本统一）。
  // projectRoot = apps/electron/（dev 模式 app.getAppPath()，runtime 的 cwd），resources/pi 在其下。
  const devPi = join(projectRoot, 'resources', 'pi', binaryName)
  if (existsSync(devPi)) {
    console.log(`[process-manager] using dev resources pi: ${devPi}`)
    return devPi
  }
  console.warn(`[process-manager] resources/pi/${binaryName} not found, falling back to system PATH`)

  // Development mode fallback: original discovery logic
  const isWindows = process.platform === 'win32'

  // 1. Try PATH
  try {
    const whichCmd = isWindows ? 'where pi' : 'which pi'
    const which = execSync(whichCmd, { encoding: 'utf-8' }).trim()
    // Windows 'where' may return multiple lines, take first
    const firstMatch = which.split('\n')[0].trim()
    if (firstMatch && existsSync(firstMatch)) return firstMatch
  } catch {
    // expected: pi not in PATH
    void 0
  }

  // 2. Try nvm managed node installations
  if (isWindows) {
    // nvm-windows stores versions in %APPDATA%\nvm
    const nvmDir = join(process.env.APPDATA ?? '', 'nvm')
    try {
      const versions = readdirSync(nvmDir)
      for (const ver of versions) {
        const piPath = join(nvmDir, ver, 'pi.cmd')
        if (existsSync(piPath)) return piPath
        const piExe = join(nvmDir, ver, 'pi.exe')
        if (existsSync(piExe)) return piExe
      }
    } catch {
      // expected: directory not found, skip
      void 0
    }
  } else {
    const nvmDir = join(homedir(), '.nvm', 'versions', 'node')
    try {
      const versions = readdirSync(nvmDir)
      for (const ver of versions) {
        const piPath = join(nvmDir, ver, 'bin', 'pi')
        if (existsSync(piPath)) return piPath
      }
    } catch {
      // expected: directory not found, skip
      void 0
    }
  }

  // 3. Common locations
  const commonPaths = isWindows
    ? [
      join(process.env.APPDATA ?? '', 'npm', 'pi.cmd'),
      join(process.env.APPDATA ?? '', 'npm', 'pi.exe'),
    ]
    : [
      '/usr/local/bin/pi',
      join(homedir(), 'bin', 'pi'),
    ]
  for (const p of commonPaths) {
    if (existsSync(p)) return p
  }

  // Fallback to bare 'pi' (will fail with clear error)
  return 'pi'
}

interface ManagedProcess {
  client: RpcClient
  cwd: string
  createdAt: number
}

/**
 * 短命 pi 附着就绪上限（W11）：spawn 冷启动中位数 ~500ms（P0.5 探针，瓶颈在 Node
 * 冷启动）+ switchSession RPC（<1ms），端到端预算 ~600ms；5s 上限覆盖慢机/首次冷缓存。
 */
const EPHEMERAL_READY_TIMEOUT_MS = 5_000

/**
 * 给 promise 套一层超时（短命 pi 就绪等待专用）。
 *
 * 超时后底层 promise 仍可能 pending（switchSession 自身 SLOW_TIMEOUT_MS 120s）——
 * withEphemeralPi 的 finally destroySession 会 kill 进程 → RpcClient.rejectAll 让其
 * settle，本包装的 then/catch 已就位，不产生 unhandled rejection。
 */
function raceReadyTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref()
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Manages pi subprocess lifecycles. Each session gets its own
 * isolated pi process spawned via `pi --mode rpc`.
 */
export class ProcessManager implements IProcessManager {
  private processes = new Map<string, ManagedProcess>()
  private clientToId = new Map<RpcClient, string>()
  private exitCallbacks = new Set<(sessionId: string, code: number | null, stderr: string) => void>()
  private piPath: string | null = null
  private piPathPromise: Promise<string> | null = null
  private piVersionCache: string | null = null

  constructor(private readonly projectRoot: string) {
    // 懒初始化：不在构造函数中执行同步 I/O，避免阻塞事件循环
    // piPath 在首次 createSession 时才解析
  }

  /** 获取或解析 pi 可执行文件路径（只执行一次） */
  private getPiPath(): Promise<string> {
    if (this.piPath) return Promise.resolve(this.piPath)
    if (this.piPathPromise) return this.piPathPromise
    this.piPathPromise = Promise.resolve().then(() => {
      const resolved = findPiExecutable(this.projectRoot)
      this.piPath = resolved
      if (resolved !== 'pi') {
        console.log(`[process-manager] using pi at: ${resolved}`)
      } else {
        console.warn('[process-manager] pi not found in common locations, relying on PATH')
      }
      return resolved
    })
    return this.piPathPromise
  }

  /** 探测 pi 版本（首次调用 execSync，后续读缓存）。失败返回 'unknown'。 */
  async getPiVersion(): Promise<string> {
    if (this.piVersionCache) return this.piVersionCache
    try {
      const piPath = await this.getPiPath()
      const cmd = piPath !== 'pi' ? `"${piPath}" --version` : 'pi --version'
      const version = execSync(cmd, { encoding: 'utf-8', timeout: 5_000 }).trim()
      this.piVersionCache = version || 'unknown'
    } catch (e) {
      console.warn('[process-manager] failed to detect pi version:', e)
      this.piVersionCache = 'unknown'
    }
    return this.piVersionCache
  }

  /**
   * Spawn a new pi subprocess for the given session.
   * If a process already exists for this sessionId it is killed first.
   */
  async createSession(sessionId: string, cwd: string, options?: RpcClientOptions): Promise<RpcClient> {
    if (this.processes.has(sessionId)) {
      await this.destroySession(sessionId)
    }

    const piPath = await this.getPiPath()

    // Inject discovered pi directory into PATH so spawn('pi', ...) resolves
    const piDir = piPath !== 'pi' ? join(piPath, '..') : undefined
    const pathEnv: Record<string, string> = {}
    if (piDir) {
      pathEnv.PATH = `${piDir}${pathDelimiter}${process.env.PATH ?? ''}`
    }

    // XYZ_AGENT_DATA_DIR 显式注入：pi 主会话进程内的 extension（subagent-workflow
    // engine 层 journal/隔离池）需要与 runtime 同源的 dataDir。dev 模式下 Electron
    // 已设置该 env、经 XYZ_ 白名单透传成立；prod 默认路径（~/.xyz-agent）下 runtime
    // 进程 env 没有该变量（shared getDataDir 缺省时不写 env），透传链断——故此处
    // 用 getConfigDir()（读同一 env + 同一缺省）显式补齐。放 spread 首位，
    // options?.env 仍可覆盖。
    const client = new RpcClient({ cwd, sessionId, ...options, env: { XYZ_AGENT_DATA_DIR: getConfigDir(), ...pathEnv, ...options?.env }, piCommand: piPath !== 'pi' ? piPath : undefined })
    try {
      await client.start()
    } catch (e) {
      const msg = toErrorMessage(e)
      // 刻意用字符串匹配（非 isEnoent）：这里要同时捕获 spawn ENOENT 与子进程 spawn
      // 失败两类错误（后者不一定是带 .code 的 errno），D20 的结构化 isEnoent 不适用。
      if (msg.includes('spawn') || msg.includes('ENOENT')) {
        if (isPackaged()) {
          throw new Error(
            `Failed to start bundled pi process. The application installation may be corrupted. `
            + `Attempted binary: ${piPath}. Original error: ${msg}`,
          )
        }
        throw new Error(
          `Failed to start pi process. Ensure pi is installed globally (npm i -g @earendil-works/pi-coding-agent). `
          + `Searched: PATH, ~/.nvm/versions/*/bin/pi, /usr/local/bin/pi. `
          + `Original error: ${msg}`,
        )
      }
      throw e
    }

    // Listen for unexpected exits to notify upper layer.
    // onExit 返回的 unsubscribe 刻意不持有：client 生命周期与 Map 条目一致，
    // intentional destroy 由下方 clientToId 无条目守卫覆盖，无需显式解绑。
    client.onExit((code, stderr) => {
      // 反查当前 id：闭包捕获的 sessionId 在 rekey 后过期（create 路径 tempId → piSessionId），
      // 用 has(capturedId) 守卫会在 rekey 后误判「已被清理」→ 死亡通知整条丢失（僵尸 session 根因）。
      // clientToId 与 processes 由 createSession/destroySession/rekey 成对维护，执行时反查天然同步。
      const currentId = this.clientToId.get(client)
      // clientToId 无条目 = 已被 destroySession 清理（intentional destroy），跳过通知
      if (currentId === undefined) return
      console.warn(`[process-manager] session ${currentId} process exited unexpectedly (code: ${code})`)
      this.processes.delete(currentId)
      this.clientToId.delete(client)
      // 命名消歧：this.exitCallbacks 是 ProcessManager 的 Set<(sessionId, code, stderr) => void>
      // （上层多播，process-manager.ts:123），与 RpcClient.exitCallbacks（Set<(code, stderr) => void>）
      // 是不同类、不同签名的同名字段
      for (const cb of this.exitCallbacks) {
        cb(currentId, code, stderr)
      }
    })

    this.processes.set(sessionId, {
      client,
      cwd,
      createdAt: Date.now(),
    })
    this.clientToId.set(client, sessionId)

    return client
  }

  /**
   * W11（数据源治理）：短命 pi 附着指定 session 文件执行一次性 RPC，用后即毁。
   *
   * 形态（探针场景 B 定型，逐次冷起——父文档 D2 裁决禁 warm pi）：复用 createSession
   * spawn `pi --mode rpc` → `switchSession(sessionFile)` 附着该文件（就绪上限 5s）→
   * fn(client) → destroySession。session JSONL 本体的唯一写方是 pi：fn 内的 RPC
   * （如 setSessionName）由 pi 自身 appendFileSync 落盘，xyz 不触碰文件。
   *
   * 附着经 switchSession RPC 而非 `pi --session <file>` CLI flag——RpcClient 的 spawn
   * 参数面（rpc-client.ts）不在本 wave 改动范围，switchSession 是既有附着原语
   * （restoreSession 同款）。spawn 时 pi 先建内存新 session（首条 assistant 前不落盘，
   * 规则 #6），switchSession 切走后即弃，sessions 目录零残留。
   *
   * 失败语义：spawn 失败 / 就绪超时 / fn 抛错一律 rethrow（进程在 finally 销毁），
   * 调用方（如 renameSession 非活跃分支）按既有失败路径报错、保留旧值可重试。
   *
   * @param sessionFile 目标 session JSONL 绝对路径（须已存在；不存在时 switchSession
   *                    由 pi 报错，走同一失败路径）
   * @param fn          就绪后在附着 client 上执行的一次性操作
   */
  async withEphemeralPi<T>(sessionFile: string, fn: (client: RpcClient) => Promise<T>): Promise<T> {
    // spawn cwd 只影响 pi 初始（弃用）session 的上下文，不影响 switchSession 后的目标
    // session；取 sessions 目录（文件所在处，扫描结果保证存在）——目标 session 自身
    // header 的 cwd 死路径场景由调用方处理（renameSession 非活跃分支附着前 F3 归一化
    // cwd fallback，p1p4-closure W1；restoreSession 同款），与本入口无关。目录竞态消失时
    // 兜底 homedir，让失败落在 switchSession（pi 报「文件不存在」）而非 spawn ENOENT。
    const spawnCwd = existsSync(dirname(sessionFile)) ? dirname(sessionFile) : homedir()
    const ephemeralId = `ephemeral-${Date.now()}-${crypto.randomUUID()}`
    const client = await this.createSession(ephemeralId, spawnCwd)
    try {
      await raceReadyTimeout(
        client.switchSession(sessionFile),
        EPHEMERAL_READY_TIMEOUT_MS,
        `Ephemeral pi attach timed out after ${EPHEMERAL_READY_TIMEOUT_MS}ms (sessionFile: ${sessionFile})`,
      )
      // W2（restore-fork-attach-fix F4）：附着必断言（I1）。withEphemeralPi 附着本就是
      // 真实文件、天然通过；接线它使「附着必断言」成为无例外结构（设计文档 D4），
      // 新附着调用点照抄即得守卫。
      await assertPiSessionFile(client, sessionFile, `withEphemeralPi(${sessionFile})`)
      return await fn(client)
    } finally {
      await this.destroySession(ephemeralId)
    }
  }

  /**
   * Kill the pi subprocess for a session.
   */
  async destroySession(sessionId: string): Promise<void> {
    const proc = this.processes.get(sessionId)
    if (!proc) return
    // Remove from maps first to prevent exitCallback from triggering,
    // but keep a reference so we can kill after removal.
    // kill() is guaranteed to resolve (SIGCONT → SIGTERM → 2s → SIGKILL).
    // 幂等：Map 无条目时（并发 deleteSession / 强杀分支已先行）静默跳过，不重复 kill。
    this.processes.delete(sessionId)
    this.clientToId.delete(proc.client)
    try {
      await proc.client.kill()
    // eslint-disable-next-line taste/no-silent-catch -- kill() has internal SIGTERM→SIGKILL fallback; orphan risk logged
    } catch (e) {
      console.warn(`[process-manager] [PROCESS-LEAK-RISK] kill failed for session ${sessionId}:`, toErrorMessage(e))
    }
  }

  /**
   * Get the RpcClient for a session (or undefined if not running).
   */
  getClient(sessionId: string): RpcClient | undefined {
    return this.processes.get(sessionId)?.client
  }

  /** Get session ID by client instance (O(1) reverse lookup). */
  getSessionIdByClient(client: RpcClient): string | undefined {
    return this.clientToId.get(client)
  }

  hasClient(sessionId: string): boolean {
    return this.processes.has(sessionId)
  }

  /**
   * Kill all managed subprocesses.
   */
  async destroyAll(): Promise<void> {
    const ids = Array.from(this.processes.keys())
    await Promise.allSettled(ids.map(id => this.destroySession(id)))
  }

  /** Check if the subprocess for a session is still running. */
  isAlive(sessionId: string): boolean {
    const proc = this.processes.get(sessionId)
    return !!proc && !proc.client.exited
  }

  /** Rekey a process entry after learning the real session ID. */
  rekey(oldId: string, newId: string): void {
    const entry = this.processes.get(oldId)
    if (!entry) return
    this.processes.delete(oldId)
    this.processes.set(newId, entry)
    this.clientToId.set(entry.client, newId)
  }

  /** Register a callback for when a session's process exits unexpectedly. Returns unsubscribe function. */
  onSessionExit(callback: (sessionId: string, code: number | null, stderr: string) => void): () => void {
    this.exitCallbacks.add(callback)
    return () => { this.exitCallbacks.delete(callback) }
  }

  /** Number of active processes. */
  get size(): number {
    return this.processes.size
  }
}
