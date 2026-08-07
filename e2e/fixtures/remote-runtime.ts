/**
 * remote-runtime fixture —— 远程 E2E 的 runtime 进程 harness（spec remote-use G1/B3/G2）。
 *
 * 设计依据：
 *  - 范式参照 tools/verify-mobile-web.cjs（最完整的 spawn runtime 范式）：spawn node server.cjs
 *    + 等 `[runtime] ready` + 轮询 /health，stop 时 kill + 清临时 token/dataDir。
 *  - B3（隔离 dataDir + 动态端口 + 独立 token）：每次 startRemoteRuntime 生成
 *    随机 token 写 0o600 临时文件 + 探测高位端口 + 临时 dataDir，杜绝跨用例/跨 dev 串扰。
 *  - G3（独立 token）：32 字节 base64url，与 dev runtime（3310）完全隔离。
 *  - runtime 依赖 pi 二进制（spec remote-use）：优先透传 process.env.XYZ_PI_BIN；
 *    否则探测 resources/pi/pi-<plat>-<arch>（与 process-manager 同源），最后 fallback 'pi'（PATH）。
 *
 * 单 dist 模式（--serve-web 仅 mobile dist）：reviewer 明确桌面端走 Electron 不经 serve-web，
 * 故只 serve mobile-renderer/dist（移动端浏览器经 http://host:port/#token=... 直达）。
 *
 * 用法：
 *   const rt = await startRemoteRuntime()
 *   try { /* 用 rt.wsUrl / rt.httpUrl 连接 *\/ }
 *   finally { await rt.stop() }
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer as createHttpServer, get as httpGetRaw } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, unlinkSync, copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = pathResolveFrom(import.meta.url, ['..', '..'])
const RUNTIME_SERVER_CJS = join(REPO_ROOT, 'packages', 'runtime', 'dist', 'server.cjs')
const MOBILE_DIST = join(REPO_ROOT, 'packages', 'mobile-renderer', 'dist')

/**
 * runtime 启动时探测端口的起点。
 * 选 13800：避开 dev（3210/3310）、E2E vite（1420/1421）、electron 远程调试（9222）等已知占用端口段，
 * 给递增探测留出充裕空间（13800..13899）。
 */
const PORT_PROBE_START = 13800
/** 端口探测上限（PORT_PROBE_START + 100，足够并发用例各取一端口）。 */
const PORT_PROBE_MAX = PORT_PROBE_START + 100
/** 等 `[runtime] ready` stdout 的超时（pi fetch + spawn 在冷启可能较慢）。 */
const READY_TIMEOUT_MS = 60_000
/** 轮询 /health 的总 deadline。 */
const HEALTH_DEADLINE_MS = 15_000
/** 轮询 /health 的间隔。 */
const HEALTH_POLL_INTERVAL_MS = 200

/** startRemoteRuntime 返回值：供桌面/移动 fixture 连接 + stop 清理。 */
export interface RemoteRuntimeInfo {
  /** runtime HTTP 端口（WS 与 HTTP 同端口，server 复用）。 */
  port: number
  /** 鉴权 token（注入 localStorage / hash 直达用）。 */
  token: string
  /** WS 连接地址（桌面 renderer remote 模式 + WS 协议测试用）。 */
  wsUrl: string
  /** HTTP 根地址（移动端浏览器导航 base，拼 /#token=<token> 直达）。 */
  httpUrl: string
  /** 停止 runtime + 清理临时资源（幂等，不抛）。 */
  stop: () => Promise<void>
  /**
   * 重启 runtime 进程（kill 当前 + 用相同 port+token+dataDir 重新 spawn），用于断线重连 spec TC3。
   *
   * 设计：
   *  - 不改 port/token/dataDir——重连后客户端用原 url+token 重新握手，runtime 新 bootId 触发 client seqReset。
   *  - 不清 dataDir（保留 session 历史）——TC3 验证 reload 后全量状态恢复需要历史持久化。
   *  - 返回新 bootId（server.cjs 启动时生成，每次 spawn 不同）供 spec 断言「bootId 变化」。
   *
   * @throws 若 runtime 已 stop（重启已终态的 runtime 无意义）
   */
  restart: () => Promise<void>
}

export interface StartRemoteRuntimeOptions {
  /** 覆盖探测起点端口（默认 13800，并发隔离用）。 */
  startPort?: number
  /**
   * 预置模型配置：将指定目录下的 pi/agent/{models.json,settings.json} 复制到临时 dataDir，
   * 让 session.create 通过 getDefaultModel() 校验（新 dataDir 无模型配置会 MODEL_NOT_CONFIGURED）。
   *
   * 传 true = 自动探测 dev dataDir（~/.xyz-agent-dev 或 ~/.xyz-agent）；
   * 传字符串 = 显式源目录路径（其下应含 pi/agent/{models.json,settings.json}）。
   * 默认 undefined = 不预置（仅连接类冒烟可用，session.create 会失败）。
   */
  seedModelConfig?: boolean | string
  /**
   * 注入 runtime spawn 进程的额外环境变量（覆盖 process.env 同名键）。
   *
   * 用途：spec 需要调短 lease TTL（XYZ_AGENT_LEASE_TTL_MS）以测 TTL 过期释放、
   * 或调其他 runtime 可调参数时透传。env 优先级高于 process.env 默认值。
   *
   * 注意：XYZ_AGENT_DATA_DIR / XYZ_PI_BIN 由本 fixture 内部设置（隔离 dataDir + 探测 pi 二进制），
   * 此处传入的同名键会被内部值覆盖（fixture 内部赋值在后，见 startRemoteRuntime env 构造）。
   */
  env?: NodeJS.ProcessEnv
}

/**
 * 解析 fixture 文件相对 repo root 的绝对路径（避免硬编码绝对路径，跨机器可移植）。
 */
function pathResolveFrom(metaUrl: string, up: string[]): string {
  const here = fileURLToPath(new URL('.', metaUrl))
  // up 形如 ['..','..']，逐级 resolve 到 repo root
  return up.reduce((acc, seg) => join(acc, seg), here)
}

/**
 * 探测可用 TCP 端口（从 startPort 递增找空端口）。
 *
 * 为什么不用 0（系统分配）：spec B3 要求「动态端口」但需可控起点以便并发隔离 + 日志可读；
 * 用递增探测可避开 3210/3310/1420/1421/9222 等已知占用端口段（PORT_PROBE_START=13800 已避开）。
 *
 * 实现用一次性 HTTP server 探测 listen 是否成功（与 verify-mobile-web.cjs isPortFree 同范式），
 * 探测后立即 close（端口在 listen→close 后由 OS TIME_WAIT 管理，spawn 的 runtime 立即 listen 复用）。
 */
export async function pickFreePort(startPort: number = PORT_PROBE_START): Promise<number> {
  for (let p = startPort; p < PORT_PROBE_MAX; p++) {
    if (await isPortFree(p)) return p
  }
  throw new Error(`No free port in range ${startPort}..${PORT_PROBE_MAX - 1} (all occupied)`)
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const checker = createHttpServer(() => {})
    checker.once('error', () => resolve(false))
    checker.once('listening', () => {
      checker.close(() => resolve(true))
    })
    checker.listen(port, '127.0.0.1')
  })
}

/**
 * 探测 pi 二进制路径（透传给 runtime 的 XYZ_PI_BIN env）。
 *
 * 查找顺序与 process-manager.findPiExecutable 对齐（确保 fixture 用的二进制与 runtime 期望一致）：
 *  1. process.env.XYZ_PI_BIN（最高优先级，调用方覆盖）
 *  2. apps/electron/resources/pi/pi-<plat>-<arch>（prepare-pi-resources.sh 产物，dev 主路径）
 *  3. 'pi'（PATH 兜底，process-manager 的 fallback 也会 which pi）
 *
 * 返回 undefined 时让 runtime 自行探测（process-manager 有 dataDir slot + pi-fetch 兜底）。
 */
function findPiBinary(): string | undefined {
  // 1. 调用方显式覆盖
  if (process.env.XYZ_PI_BIN && existsSync(process.env.XYZ_PI_BIN)) {
    return process.env.XYZ_PI_BIN
  }
  // 2. dev resources（pi-mono release 解压展平后的二进制）
  const platform = process.platform
  const arch = process.arch
  const binaryName = platform === 'win32' ? `pi-windows-${arch}.exe` : `pi-${platform}-${arch}`
  const devPi = join(REPO_ROOT, 'apps', 'electron', 'resources', 'pi', binaryName)
  if (existsSync(devPi)) return devPi
  // 3. PATH 兜底（process-manager 会 which pi；这里不预先 which，直接透传 'pi' 让 runtime 解析）
  return 'pi'
}

/**
 * 预置 pi 模型配置到目标 dataDir（session.create 校验 getDefaultModel() 必需）。
 *
 * 源目录探测顺序（explicit > dev > user）：
 *  1. 调用方显式传入的 sourceDir
 *  2. process.env.XYZ_AGENT_DATA_DIR（test 自带隔离 dataDir）
 *  3. ~/.xyz-agent-dev（dev 主路径，pnpm dev 默认）
 *  4. ~/.xyz-agent（用户安装路径）
 *
 * 复制 pi/agent/{models.json,settings.json}（secrets 经 pi 运行时读取，不在 models.json，
 * apiKey 在 models.json providers 内已含；若源用 secrets 文件则 pi 进程读源 secrets 路径不变，
 * 但本 fixture 不复制 secrets —— apiKey 已在 models.json 内，足够 session.create + 单次对话）。
 *
 * @param targetDataDir 临时 dataDir（runtime XYZ_AGENT_DATA_DIR）
 * @param sourceDir 可选源 dataDir（其下应含 pi/agent/{models.json,settings.json}）
 */
function seedPiModelConfig(targetDataDir: string, sourceDir?: string): void {
  const candidates: string[] = []
  if (sourceDir) candidates.push(sourceDir)
  if (process.env.XYZ_AGENT_DATA_DIR) candidates.push(process.env.XYZ_AGENT_DATA_DIR)
  candidates.push(join(homedir(), '.xyz-agent-dev'))
  candidates.push(join(homedir(), '.xyz-agent'))

  let resolvedSource: string | null = null
  for (const c of candidates) {
    if (existsSync(join(c, 'pi', 'agent', 'settings.json')) && existsSync(join(c, 'pi', 'agent', 'models.json'))) {
      resolvedSource = c
      break
    }
  }
  if (!resolvedSource) {
    // 无可用源配置 → 不阻断（session.create 会以 MODEL_NOT_CONFIGURED 失败，spec 可据此 skip）
    return
  }
  const srcAgentDir = join(resolvedSource, 'pi', 'agent')
  const dstAgentDir = join(targetDataDir, 'pi', 'agent')
  mkdirSync(dstAgentDir, { recursive: true })
  try {
    copyFileSync(join(srcAgentDir, 'settings.json'), join(dstAgentDir, 'settings.json'))
  } catch {
    // best-effort
  }
  try {
    copyFileSync(join(srcAgentDir, 'models.json'), join(dstAgentDir, 'models.json'))
  } catch {
    // best-effort
  }
}

/**
 * 启动远程 runtime 进程（隔离 dataDir + 动态端口 + 独立 token）。
 *
 * 流程（对齐 verify-mobile-web.cjs startRuntime）：
 *  1. 生成随机 token → 写 0o600 临时文件（base64url 32 字节，与 runtime --token-file 协议一致）
 *  2. 探测高位端口（pickFreePort）
 *  3. mkdtemp 临时 dataDir（XYZ_AGENT_DATA_DIR，隔离 pi 进程数据 + 避免污染 dev ~/.xyz-agent-dev）
 *  4. spawn node server.cjs --port --host --token-file --serve-web <mobileDist>
 *     env 注入 XYZ_AGENT_DATA_DIR + XYZ_PI_BIN（pi 二进制可控）
 *  5. 等 stdout 含 `[runtime] ready`
 *  6. 轮询 GET /health 直到 200
 *
 * @returns RemoteRuntimeInfo（含 stop 清理闭包）
 * @throws 若 server.cjs 不存在 / 启动超时 / ready 后 /health 不就绪
 */
export async function startRemoteRuntime(
  opts: StartRemoteRuntimeOptions = {},
): Promise<RemoteRuntimeInfo> {
  if (!existsSync(RUNTIME_SERVER_CJS)) {
    throw new Error(
      `runtime server.cjs not found at ${RUNTIME_SERVER_CJS}. ` +
        'Run `pnpm --filter @xyz-agent/runtime build` first.',
    )
  }
  if (!existsSync(join(MOBILE_DIST, 'index.html'))) {
    throw new Error(
      `mobile-renderer dist not found at ${MOBILE_DIST}. ` +
        'Run `pnpm --filter @xyz-agent/mobile-renderer build` first.',
    )
  }

  // ── 1. 随机 token + 0o600 临时文件 ──────────────────────────────
  const token = randomBytes(32).toString('base64url')
  const tokenFile = join(tmpdir(), `xyz-e2e-remote-token-${process.pid}-${randomBytes(4).toString('hex')}`)
  writeFileSync(tokenFile, token, { mode: 0o600 })
  try {
    chmodSync(tokenFile, 0o600)
  } catch {
    // 非 POSIX FS（Windows 某些配置）不阻断——writeFileSync mode 已尽力设置
  }

  // ── 2. 探测端口 ─────────────────────────────────────────────────
  const port = await pickFreePort(opts.startPort ?? PORT_PROBE_START)

  // ── 3. 临时 dataDir（隔离 pi 进程 + 不污染 dev）──────────────────
  const tmpDataDir = mkdtempSync(join(tmpdir(), 'xyz-e2e-remote-'))

  // ── 3.1 预置模型配置（可选）：seedModelConfig=true/string 时复制源 pi/agent 配置。
  // 必要：session.create 校验 getDefaultModel()，新 dataDir 无配置 → MODEL_NOT_CONFIGURED。
  if (opts.seedModelConfig) {
    seedPiModelConfig(tmpDataDir, opts.seedModelConfig === true ? undefined : opts.seedModelConfig)
  }

  // ── 4-6. spawn runtime + 等 ready + 等 health（提取到 spawnRuntimeOnce）──
  const piBin = findPiBinary()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // 调用方传入的额外 env（如 XYZ_AGENT_LEASE_TTL_MS）：先于内部键铺底，
    // 内部键（XYZ_AGENT_DATA_DIR / XYZ_PI_BIN）在后赋值会覆盖同名调用方值（隔离优先级最高）。
    ...(opts.env ?? {}),
    // 隔离数据目录（B3）：pi 进程的 sessions/agent 数据落此临时目录
    XYZ_AGENT_DATA_DIR: tmpDataDir,
  }
  // XYZ_PI_BIN 可控（spec remote-use）：透传探测到的 pi 二进制路径
  if (piBin) env.XYZ_PI_BIN = piBin

  let childProc = await spawnRuntimeOnce(port, tokenFile, env)

  const wsUrl = `ws://127.0.0.1:${port}`
  const httpUrl = `http://127.0.0.1:${port}`

  let stopped = false

  /**
   * restart：kill 当前 runtime 进程 + 用相同 port+token+dataDir 重新 spawn（断线重连 spec TC3 用）。
   *
   * 时序：SIGKILL 当前进程（无优雅等待，模拟 runtime 崩溃）→ 短暂等端口释放 → spawnRuntimeOnce 重启
   * → 新进程 ready + health。新进程新 bootId（server.cjs 启动时生成）。
   */
  const restart = async (): Promise<void> => {
    if (stopped) {
      throw new Error('cannot restart a stopped runtime')
    }
    // kill 当前进程（SIGKILL 模拟崩溃，确保旧 WS 连接断开 + 新 bootId）
    try {
      if (!childProc.killed) childProc.kill('SIGKILL')
    } catch {
      // 进程可能已退出，忽略
    }
    // 等端口释放（旧进程 TIME_WAIT；轮询 isPortFree）
    const portFreeDeadline = Date.now() + 5_000
    while (Date.now() < portFreeDeadline) {
      if (await isPortFree(port)) break
      await sleep(100)
    }
    // 重新 spawn（同 port+token+dataDir）
    childProc = await spawnRuntimeOnce(port, tokenFile, env)
  }

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    // kill spawn 进程（SIGTERM 让 runtime 优雅关 pi 子进程）
    try {
      if (!childProc.killed) childProc.kill('SIGTERM')
    } catch {
      // 进程可能已退出，忽略
    }
    // 清临时 token 文件
    try {
      unlinkSync(tokenFile)
    } catch {
      // 文件不存在 / 不可写 → 静默
    }
    // 清临时 dataDir（递归）
    try {
      rmSync(tmpDataDir, { recursive: true, force: true })
    } catch {
      // best-effort：tmpdir 跨进程清理不阻断测试
    }
  }

  return { port, token, wsUrl, httpUrl, stop, restart }
}

/**
 * 单次 spawn runtime 进程 + 等 ready + 等 health（startRemoteRuntime 与 restart 复用）。
 *
 * 提取公共流程（原 startRemoteRuntime 主体步骤 4-6）：
 *  1. spawn node server.cjs --port --host --token-file --serve-web
 *  2. 等 stdout `[runtime] ready`
 *  3. 轮询 /health 直到 200
 *
 * @param port 监听端口（startRemoteRuntime 探测 / restart 复用原值）
 * @param tokenFile 鉴权 token 文件路径（startRemoteRuntime 生成 / restart 复用原文件）
 * @param env spawn 环境变量（含 XYZ_AGENT_DATA_DIR + XYZ_PI_BIN）
 * @returns spawn 的 ChildProcess（已 ready + health 通过，调用方持有供 stop/restart kill）
 * @throws 若 ready 超时 / spawn 失败 / health 不就绪
 */
async function spawnRuntimeOnce(
  port: number,
  tokenFile: string,
  env: NodeJS.ProcessEnv,
): Promise<import('node:child_process').ChildProcess> {
  const childProc = spawn(
    'node',
    [
      RUNTIME_SERVER_CJS,
      '--port', String(port),
      '--host', '127.0.0.1',
      '--token-file', tokenFile,
      // 单 dist 模式：仅 serve mobile（桌面 Electron 不走 serve-web）
      '--serve-web', MOBILE_DIST,
    ],
    {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  // ── 等 `[runtime] ready`（stdout 匹配）──────────────────────
  let stdoutBuf = ''
  let resolvedReady = false

  await new Promise<void>((resolve, reject) => {
    const readyTimer = setTimeout(() => {
      reject(new Error(`runtime not ready within ${READY_TIMEOUT_MS}ms (stdout tail: ${stdoutBuf.slice(-1500)})`))
    }, READY_TIMEOUT_MS)

    childProc.stdout.on('data', (d: Buffer) => {
      stdoutBuf += d.toString()
      if (!resolvedReady && stdoutBuf.includes('[runtime] ready')) {
        resolvedReady = true
        clearTimeout(readyTimer)
        resolve()
      }
    })
    childProc.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      if (/\[runtime\]|error|ERR/i.test(s)) {
        process.stderr.write('[runtime:stderr] ' + s)
      }
    })
    childProc.on('error', (e) => {
      if (!resolvedReady) {
        clearTimeout(readyTimer)
        reject(new Error(`runtime spawn failed: ${e.message}`))
      }
    })
    childProc.on('exit', (code, signal) => {
      if (!resolvedReady) {
        clearTimeout(readyTimer)
        reject(
          new Error(
            `runtime exited before ready (exit=${code} signal=${signal}, stdout tail: ${stdoutBuf.slice(-1500)})`,
          ),
        )
      }
    })
  })

  // ── 轮询 /health 直到 200 ────────────────────────────────────
  await waitForHealth(port, HEALTH_DEADLINE_MS)

  return childProc
}

/**
 * 轮询 GET /health 直到返回 200（runtime HTTP 接口就绪）。
 *
 * ready stdout 后仍需轮询：runtime 的 HTTP server 在 ready 后才 listen，
 * 且 pi 进程 spawn 可能短暂阻塞事件循环（first session.create 触发）。
 */
async function waitForHealth(port: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const res = await httpGetJson(`http://127.0.0.1:${port}/health`)
      if (res.status === 200) return
    } catch {
      // server 尚未 listen 或连接拒绝 → 继续轮询
    }
    await sleep(HEALTH_POLL_INTERVAL_MS)
  }
  throw new Error(`/health not ready within ${deadlineMs}ms on port ${port}`)
}

/** 轻量 HTTP GET（不引外部依赖，返回 status + body）。 */
function httpGetJson(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpGetRaw(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        body += c
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('HTTP GET timeout')))
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
