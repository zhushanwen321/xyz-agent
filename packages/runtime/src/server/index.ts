#!/usr/bin/env node
/**
 * xyz-agent-runtime — server CLI 入口（wave4 远程化 P0）。
 *
 * 让 runtime 可经独立 CLI bin 启动，无需 Electron supervisor。首启流程：
 *  1. 解析 args（--host/--port/--token-file/--print-qr/--serve-web/--reset-token/--show-token/...）
 *  2. token：首启（token 文件不存在）自动生成 + persist（0600）；--reset-token 重生成
 *  3. pi-fetch：findPiExecutable 返 'pi' 兜底时，下载 pi 二进制到 <dataDir>/pi/，置 XYZ_PI_BIN
 *  4. 探测可达 URL（PUBLIC_URL > Tailscale > LAN > localhost）
 *  5. printStartup 输出引导（token 经 process.stdout.write，不经 console patch 落盘）
 *  6. 调 main({host, port, tokenFile, serveWeb}) 启动 runtime（复用 wave1 组合根）
 *
 * 安全：本文件**禁止** console.* 输出 token（initLogger patch 会落盘）。token 相关输出
 * 全经 printStartup（内部 process.stdout.write）。错误信息经 process.stderr.write。
 *
 * 与 runtime index.ts 的 parseArgs 隔离：本文件自建解析，不污染 runtime CLI 语义。
 * runtime index.ts 的 main() 接受编程式 opts，本 CLI 解析后注入。
 */
import { main } from '../index.js'
import { createTokenManager, ensureToken } from '../transport/token.js'
import { findPiExecutable } from '../infra/pi/process-manager.js'
import { detectUrls } from './detect-url.js'
import { printStartup } from './bootstrap.js'
import { fetchPiBinary } from './pi-fetch.js'
import { getDataDir } from '@xyz-agent/shared/paths'
import { getAppVersion } from '../services/plugin-service/plugin-version-checker.js'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpathSync } from 'node:fs'

const execFileAsync = promisify(execFile)

interface ServerArgs {
  host: string
  port: number
  tokenFile?: string
  printQr: boolean
  qrMode: 'browser' | 'deep-link'
  printAllUrls: boolean
  serveWeb?: string
  resetToken: boolean
  showToken: boolean
  version: boolean
  help: boolean
}

const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_PORT = 3210

/**
 * 自建 args 解析（不污染 runtime index.ts parseArgs）。
 * 支持 --flag、--flag value、--flag=value 三形式。未知 flag 忽略（不报错，宽松解析）。
 * 导出供测试直接调用（不经 process.argv）。
 */
export function parseServerArgs(argv: string[]): ServerArgs {
  const args: ServerArgs = {
    host: process.env.XYZ_AGENT_HOST ?? DEFAULT_HOST,
    port: parseInt(process.env.XYZ_AGENT_PORT ?? String(DEFAULT_PORT), 10) || DEFAULT_PORT,
    // 与 --host/--port 同策略：XYZ_AGENT_TOKEN_FILE env 作默认，--token-file 参数覆盖 env。
    // <dataDir>/token 默认由 run() 兜（parseServerArgs 不接 dataDir）。
    // env 显式设为空字符串（如 `XYZ_AGENT_TOKEN_FILE= xyz-agent-runtime`）时归一化为
    // undefined：空值合并（??）只对 null/undefined 合并，'' 会让 createTokenManager
    // 尝试写空路径。用 `|| undefined` 把空串当未设置处理，由 run() 兜默认 <dataDir>/token。
    tokenFile: process.env.XYZ_AGENT_TOKEN_FILE || undefined,
    printQr: false,
    qrMode: 'browser',
    printAllUrls: false,
    resetToken: false,
    showToken: false,
    version: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string | undefined => {
      const v = argv[i + 1]
      if (v !== undefined && !v.startsWith('--')) {
        i++
        return v
      }
      return undefined
    }

    if (a === '--help' || a === '-h') {
      args.help = true
    } else if (a === '--version' || a === '-v') {
      args.version = true
    } else if (a === '--host') {
      const v = next()
      if (v) args.host = v
    } else if (a.startsWith('--host=')) {
      args.host = a.slice('--host='.length)
    } else if (a === '--port') {
      const v = next()
      if (v) args.port = parseInt(v, 10) || args.port
    } else if (a.startsWith('--port=')) {
      args.port = parseInt(a.slice('--port='.length), 10) || args.port
    } else if (a === '--token-file') {
      const v = next()
      if (v) args.tokenFile = v
    } else if (a.startsWith('--token-file=')) {
      args.tokenFile = a.slice('--token-file='.length)
    } else if (a === '--print-qr') {
      args.printQr = true
    } else if (a === '--qr') {
      const v = next()
      if (v === 'deep-link') args.qrMode = 'deep-link'
    } else if (a.startsWith('--qr=')) {
      const v = a.slice('--qr='.length)
      if (v === 'deep-link') args.qrMode = 'deep-link'
    } else if (a === '--print-all-urls') {
      args.printAllUrls = true
    } else if (a === '--serve-web') {
      const v = next()
      if (v) args.serveWeb = v
    } else if (a.startsWith('--serve-web=')) {
      args.serveWeb = a.slice('--serve-web='.length)
    } else if (a === '--reset-token') {
      args.resetToken = true
    } else if (a === '--show-token') {
      args.showToken = true
    }
    // 未知 flag 静默忽略（宽松解析）
  }

  return args
}

/** 导出供测试调用。 */
export function printHelp(): void {
  process.stdout.write(`xyz-agent-runtime — start xyz-agent server (standalone, no Electron)

Usage: xyz-agent-runtime [options]

Server options:
  --host <host>             Bind host (default: 0.0.0.0; XYZ_AGENT_HOST)
  --port <port>             Bind port (default: 3210; XYZ_AGENT_PORT)
  --token-file <path>       Token file path (default: <dataDir>/token)
  --serve-web <dist>        Serve static web assets from <dist> (SPA + WS same port)

Output options:
  --print-qr                Print QR code for connection URL
  --qr <browser|deep-link>  QR content mode (default: browser)
  --print-all-urls          Print all detected URLs (default: best one only)

Token management:
  --reset-token             Regenerate token and exit
  --show-token              Print current token and exit

Other:
  --version, -v             Print version and exit
  --help, -h                Show this help

Environment:
  XYZ_AGENT_HOST            Bind host (overridden by --host)
  XYZ_AGENT_PORT            Bind port (overridden by --port)
  XYZ_AGENT_PUBLIC_URL      Public URL for reverse-proxy deployments
  XYZ_AGENT_DATA_DIR        Data directory (default: ~/.xyz-agent)
  XYZ_PI_BIN                Path to existing pi executable (skip pi-fetch)
`)
}

/**
 * 探测 pi 版本（execFile <path> --version）。失败返回 undefined（不阻塞启动）。
 */
async function getPiVersion(piPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(piPath, ['--version'], {
      timeout: 5_000,
      encoding: 'utf-8',
    })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * 主流程：解析 args → 命令分发 → 启动 runtime。
 * 导出供测试驱动（测试 mock 依赖后直接调 run，不经 process.argv/exit）。
 */
export async function run(): Promise<void> {
  // eslint-disable-next-line no-magic-numbers -- argv[0]=node、argv[1]=script 路径，slice(2) 跳过
  const args = parseServerArgs(process.argv.slice(2))

  if (args.help) {
    printHelp()
    process.exit(0)
  }
  if (args.version) {
    // version 是非敏感信息，可经 stdout 输出（不经 console，避免依赖 initLogger patch 状态）
    process.stdout.write(`xyz-agent-runtime v${getAppVersion()}\n`)
    process.exit(0)
  }

  const dataDir = getDataDir()
  const tokenFile = args.tokenFile ?? join(dataDir, 'token')
  const tm = createTokenManager({ tokenFile })

  // ── token 管理子命令（--reset-token / --show-token 早退）──────────
  if (args.resetToken) {
    const newToken = tm.generate()
    tm.persist(newToken)
    // 新 token 经 process.stdout.write（不经 console patch）
    process.stdout.write(`token regenerated: ${tokenFile} (mode 0600)\n`)
    process.stdout.write(`new token: ${newToken}\n`)
    process.exit(0)
  }
  if (args.showToken) {
    const loaded = tm.load()
    if (loaded.enabled) {
      process.stdout.write(loaded.token + '\n')
    } else {
      process.stdout.write('open mode (no token file)\n')
    }
    process.exit(0)
  }

  // ── 首启 token 生成（spec D1：server CLI 默认启用认证）─────────────
  // 与 runtime main() 共用 ensureToken（token.ts），保证两条启动路径首启行为一致。
  const token = ensureToken(tm)

  // ── pi-fetch（findPiExecutable 返 'pi' 兜底时下载）────────────────
  // projectRoot 推导：dataDir 的上级不是可靠的 projectRoot，但 findPiExecutable 主要查
  // XYZ_PI_BIN / dataDir slot / PATH，projectRoot 仅用于 dev resources/pi 兜底（CLI 模式无）。
  // 传 dataDir 上级作为 best-effort，命中 dataDir slot（<dataDir>/pi/<binary>）即足够。
  let piPath: string | undefined
  let piVersion: string | undefined
  try {
    const found = findPiExecutable(resolve(dataDir, '..'))
    if (found === 'pi') {
      // 兜底：PATH 无 pi → 自动下载到 <dataDir>/pi/
      piPath = await fetchPiBinary(dataDir)
      // 置 XYZ_PI_BIN，使 main() 内 ProcessManager 复用同一二进制（避免重复探测）
      process.env.XYZ_PI_BIN = piPath
    } else {
      piPath = found
    }
    if (piPath) {
      piVersion = await getPiVersion(piPath)
    }
  } catch (e) {
    // pi 设置失败不阻塞 server 启动（session.create 时会再报清晰错误）
    process.stderr.write(`[server] pi setup failed: ${e instanceof Error ? e.message : String(e)}\n`)
  }

  // ── 探测可达 URL ──────────────────────────────────────────────────
  const detectedUrls = await detectUrls(args.port)

  // ── 打印引导（token 经 process.stdout.write，不落盘日志）──────────
  printStartup({
    detectedUrls,
    token,
    tokenFile,
    serverVersion: getAppVersion(),
    piVersion,
    piPath,
    printQr: args.printQr,
    qrMode: args.qrMode,
    printAllUrls: args.printAllUrls,
    listenHost: args.host,
    listenPort: args.port,
  })

  // ── 启动 runtime（复用 wave1 组合根 main）─────────────────────────
  await main({ host: args.host, port: args.port, tokenFile, serveWeb: args.serveWeb })
}

/**
 * 判断 scriptPath 是否是 server CLI 入口（wave5 提取的纯函数，可单测）。
 *
 * 输入应是 realpathSync 解析 symlink 后的真实路径（npm bin 场景 argv[1] 是 symlink 名，
 * 不含 'server'，需上层先 realpathSync 再传入）。本函数仅做字符串匹配，不做 IO。
 *
 * 判据：精准匹配打包产物 server.cjs 或源 src/server/index.ts。
 * 不用旧模糊正则 /server(\.cjs|\.js|\/index\.ts)?$/（会误匹配 my-server/foo.ts 等）。
 * 正则用 [\\/] 兼容 windows 反斜杠。
 *
 * @internal 导出仅为单测，外部不应直接调用。
 */
export function _isServerMainEntry(scriptPath: string): boolean {
  if (!scriptPath) return false
  return /[\\/]server\.cjs$/.test(scriptPath) || /[\\/]src[\\/]server[\\/]index\.ts$/.test(scriptPath)
}

/**
 * 自动执行入口：仅当本模块被直接作为 CLI 入口运行时触发（非被 import）。
 *
 * 判据：process.argv[1]（脚本路径）经 realpathSync 解析 symlink 后，是 server.cjs（打包产物）
 * 或 src/server/index.ts（源码）。这避免被测试 import 时副作用执行 run()（测试显式调 run() 驱动）。
 *
 * 为什么需要 realpathSync：npm i -g 后 bin/xyz-agent-runtime 是 symlink → dist/server.cjs，
 * Node 加载时 argv[1] 是 symlink 名（不含 'server'），不解析会漏判 → run() 不执行 → 静默退出。
 * realpathSync 失败（argv[1] 是非文件路径如 tsx watch）回退到原字符串匹配。
 *
 * 判据选择约束（wave4 总结）：
 *  - 禁用 ESM module-self-ref（tsup CJS bundle 把它替换为空对象）
 *  - 禁用 require.main（tsup ESM 产物无 require）
 *  - 禁用 globalThis.__dirname（CJS 中 __dirname 是模块局部变量不在 globalThis 上）
 * argv[1] + realpathSync 是最 portable 的判据。
 */
const isMainEntry = (() => {
  const argv1 = process.argv[1] ?? ''
  if (!argv1) return false
  try {
    return _isServerMainEntry(realpathSync(argv1))
  } catch {
    // realpathSync 失败（文件不存在 / 非文件路径如 tsx watch）回退到原字符串匹配
    return _isServerMainEntry(argv1)
  }
})()

if (isMainEntry) {
  run().catch((e) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
    process.exit(1)
  })
}
