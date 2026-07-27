/**
 * FileEndpoint —— wave2 远程化：HTTP /file 端点 + signUrl HMAC 签名。
 *
 * 背景：远程模式（浏览器经网络连 runtime）不能直接读本地文件，原 renderer 的
 * local-file:// 协议失效。本模块提供两条互补链路：
 *
 * 1. signUrl(path) RPC（file-message-handler 经 fileEndpoint 调用）：
 *    给定文件绝对路径 → 解析 realpath → HMAC-SHA256 签名 → 返回
 *    `/file?path=<realpath>&exp=<unixSec>&sig=<hex>` URL + expiresAt(ms)。
 *    签名消息 = `${realpath}\n${expSec}`，token 来自 TokenManager（与 WS 认证同源）。
 *    开放模式（auth disabled）禁止签名——远程模式不应在开放模式部署。
 *
 * 2. handle(req, res)：GET /file?path=&exp=&sig= 端点。
 *    严格按顺序校验：缺参 400 → 开放模式非 loopback 绑定 403 → realpath 失败 404 →
 *    认证模式 sig 校验 403 → 过期 410 → 白名单外 403 → 非 regular 文件 404 →
 *    扩展名非图片 403 → 200 流式（createReadStream error 监听 → 500/destroy）。
 *    开放模式跳过 sig 校验，但仅 loopback 绑定放行（物理隔离）；非 loopback 拒绝
 *    （强制远程暴露必须配 token），不再依赖未强制的 loopback 假设。
 *
 * 安全设计：
 * - 签名/校验都用 realpath（symlink 在签名时即解析，防止 symlink 重指攻击重放旧签名）。
 * - timingSafeEqual 常量时间比对（与 token.ts verify 同模式），前置长度检查防抛错。
 * - 白名单 isAllowed 用 isUnderOrEqual（词法判定，realpath 结果 vs [dataDir / 活跃 session cwd / projectRoots / tmpdir]）。
 * - 扩展名白名单（仅图片）：替代 local-file:// 的 renderer 图片预览用途，最小暴露面。
 *
 * 不含：业务路由（connection-manager 在 pathname === '/file' 时转交）、token 生成/校验
 * （TokenManager）、session 管理（SessionService 只读 getActiveSummaries 取 cwd）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { createReadStream, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, extname } from 'node:path'
import { getDataDir } from '@xyz-agent/shared/paths'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TokenManager } from './token.js'
import { isUnderOrEqual } from '../utils/path-utils.js'

/**
 * FileEndpoint 对 session 的窄依赖视图：仅需活跃 session 的 cwd（作白名单前缀）。
 * 不直接依赖 ISessionService（getActiveSummaries 未纳入该接口），用结构化窄接口避免扩大共享契约。
 * SessionService 具体类已有 getActiveSummaries(): SessionSummary[]，结构兼容此接口。
 */
export interface FileEndpointSessionView {
  getActiveSummaries(): Array<{ cwd: string }>
}

/** 签名 URL 有效期：5 分钟（与 renderer 图片预览会话时长匹配）。 */
const SIGN_URL_TTL_SEC = 300
/** unix 秒与 ms 的转换因子（协议 expiresAt 用 ms，签名 exp 用 sec）。 */
const MS_PER_SEC = 1000
// HTTP 状态码常量（与 connection-manager.ts 的 HTTP_OK/HTTP_NOT_FOUND 同约定，命名避免 magic number）
const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const HTTP_INTERNAL_ERROR = 500
const HTTP_GONE = 410
/** 扩展名白名单（仅图片）——替代 local-file:// 的图片预览用途，最小暴露面。 */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
])
const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

export interface FileEndpointOptions {
  /** token 管理器（与 WS 认证同源）。开放模式时 sig 校验跳过、signUrl 抛错。 */
  tokenManager: TokenManager
  /** session 服务：取活跃 session cwd 作为白名单前缀（无 session 时仅靠其余前缀）。 */
  sessionService: FileEndpointSessionView
  /**
   * 监听 host：'127.0.0.1' / 'localhost' / '::1'（loopback）或 '0.0.0.0'（暴露）。
   * 开放模式（auth disabled）下由 handle 的 loopback 守卫消费：非 loopback 绑定 + 开放模式
   * = 配置错误，拒绝 /file 防止未授权访问（强制远程暴露必须配 token）。
   */
  bindHost: string
}

export interface SignUrlResult {
  url: string
  /** 过期时间戳，单位 ms（与协议 ServerMessageMap['file.signUrl:result'] 注释对齐）。 */
  expiresAt: number
}

export interface FileEndpoint {
  /** 为文件路径签发临时可访问 URL。realpath 失败（文件不存在）抛错 → handler 转 file_failed。 */
  signUrl(path: string): Promise<SignUrlResult>
  /** 处理 GET /file?path=&exp=&sig= 请求，按校验顺序返回相应状态码或流式文件。 */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

/**
 * 构造 FileEndpoint。无状态（每次 handle/signUrl 读 tokenManager/sessionService 当前态），
 * 故可单例复用，由 server.ts 装配后注入 connection-manager（HTTP 路由）+ file-message-handler（RPC）。
 */
export function createFileEndpoint(opts: FileEndpointOptions): FileEndpoint {
  const { tokenManager, sessionService, bindHost } = opts

  /** 解析 env XYZ_AGENT_PROJECT_ROOTS（逗号分隔）为前缀数组；未配置返回空。 */
  function parseProjectRoots(): string[] {
    const raw = process.env.XYZ_AGENT_PROJECT_ROOTS
    if (!raw) return []
    return raw.split(',').map(s => s.trim()).filter(Boolean)
  }

  /**
   * 允许访问的前缀列表（resolve + realpath 后，不带 sep——isUnderOrEqual 内部 resolve 处理）。
   * = [dataDir, 活跃 session cwd*, projectRoots*, tmpdir]。
   * 动态读取（不缓存）：session cwd / env 可能运行期变化，每次 handle 重算。
   *
   * 关键：前缀须 realpath 后再与文件 realpath 比较，否则 macOS 的 /var → /private/var symlink
   * 会让 tmpdir() 返回 /var/folders/... 而文件 realpath 是 /private/var/folders/... → 词法不匹配。
   * 前缀 realpath 失败（目录不存在）→ 跳过该前缀（不影响其余判定）。
   */
  function allowedPrefixes(): string[] {
    const prefixes: string[] = [
      getDataDir(),
      ...sessionService.getActiveSummaries().map(s => s.cwd),
      ...parseProjectRoots(),
      tmpdir(),
    ]
    const resolved: string[] = []
    for (const p of prefixes) {
      try {
        resolved.push(realpathSync(resolve(p)))
      // eslint-disable-next-line taste/no-silent-catch -- 前缀目录不存在/不可访问 → 跳过该前缀，不阻断其余前缀判定
      } catch {
        // 前缀目录不存在 / 不可访问 → 跳过（不阻断其余前缀判定）
      }
    }
    return resolved
  }

  /** 判定 absPath（已是 realpath）是否落在任一允许前缀下或等于某前缀。 */
  function isAllowed(absPath: string): boolean {
    const realResolved = resolve(absPath)
    return allowedPrefixes().some(prefix => isUnderOrEqual(prefix, realResolved))
  }

  /**
   * HMAC-SHA256 签名（与 token.ts load 同步签名风格）。
   * @param realPath 已 realpath 的绝对路径（签名消息的一部分）
   * @param expSec 过期时间戳（unix 秒）
   * @returns hex 编码签名
   */
  function signHmac(realPath: string, expSec: number): string {
    const loaded = tokenManager.load()
    if (!loaded.enabled) throw new Error('auth disabled')
    const hmac = createHmac('sha256', loaded.token)
    hmac.update(`${realPath}\n${expSec}`)
    return hmac.digest('hex')
  }

  /**
   * 常量时间签名校验（防时序侧信道）。
   * timingSafeEqual 要求两 Buffer 等长，前置 length 检查（与 token.ts verify 同模式）。
   */
  function verifySig(realPath: string, expSec: number, candidate: string): boolean {
    const expected = signHmac(realPath, expSec)
    const a = Buffer.from(candidate)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  return {
    async signUrl(path: string): Promise<SignUrlResult> {
      const loaded = tokenManager.load()
      if (!loaded.enabled) throw new Error('forbidden: auth disabled')
      // realpath：解析 symlink 后签名。文件不存在 / ELOOP / EACCES → 抛错（handler 转 file_failed）。
      const real = await realpath(path)
      const expSec = Math.floor(Date.now() / MS_PER_SEC) + SIGN_URL_TTL_SEC
      const sig = signHmac(real, expSec)
      const url = `/file?path=${encodeURIComponent(real)}&exp=${expSec}&sig=${sig}`
      // expiresAt 单位 ms（协议 ServerMessageMap['file.signUrl:result'] 注释）。
      return { url, expiresAt: expSec * MS_PER_SEC }
    },

    async handle(req, res) {
      // 1. 解析 query
      const url = new URL(req.url ?? '', 'http://localhost')
      const pathParam = url.searchParams.get('path')
      const expParam = url.searchParams.get('exp')
      const sigParam = url.searchParams.get('sig')
      if (!pathParam || !expParam) {
        res.writeHead(HTTP_BAD_REQUEST, { 'Content-Type': 'text/plain' })
        res.end('missing path or exp')
        return
      }
      const expSec = parseInt(expParam, 10)
      if (!Number.isFinite(expSec)) {
        res.writeHead(HTTP_BAD_REQUEST, { 'Content-Type': 'text/plain' })
        res.end('invalid exp')
        return
      }

      // 2. 开放模式（auth disabled）loopback 守卫：必须先于 realpath / sig 校验。
      //    原隐含假设「开放模式仅靠 loopback 物理隔离」，但 loopback 此前从未在代码强制——
      //    当部署用 XYZ_AGENT_HOST=0.0.0.0 + 未配 token 时，网络任意方可无 sig 读取白名单内图片。
      //    故：开放模式 + 非 loopback 绑定 = 配置错误，直接 403（强制远程暴露必须配 token）。
      //    认证模式不受影响（后续 sig 校验仍做）。
      const loaded = tokenManager.load()
      if (!loaded.enabled) {
        const isLoopback = bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1'
        if (!isLoopback) {
          res.writeHead(HTTP_FORBIDDEN, { 'Content-Type': 'text/plain' })
          res.end('open mode requires loopback bind')
          return
        }
      }

      // 3. realpath（失败 404：文件不存在 / 不可访问）
      let real: string
      try {
        real = await realpath(pathParam)
      } catch {
        res.writeHead(HTTP_NOT_FOUND, { 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }

      // 4. 认证模式 sig 校验（开放模式在步骤 2 已通过 loopback 守卫，此处跳过）
      if (loaded.enabled) {
        if (!sigParam || !verifySig(real, expSec, sigParam)) {
          res.writeHead(HTTP_FORBIDDEN, { 'Content-Type': 'text/plain' })
          res.end('forbidden')
          return
        }
      }

      // 4. 过期（expSec 是秒，与 Date.now()/MS_PER_SEC 比较）
      if (expSec < Math.floor(Date.now() / MS_PER_SEC)) {
        res.writeHead(HTTP_GONE, { 'Content-Type': 'text/plain' })
        res.end('expired')
        return
      }

      // 5. 白名单（403：即使签名合法也必须在允许前缀下——双保险）
      if (!isAllowed(real)) {
        res.writeHead(HTTP_FORBIDDEN, { 'Content-Type': 'text/plain' })
        res.end('forbidden')
        return
      }

      // 6. stat 校验为 regular 文件（目录/设备文件/符号链接目标非文件 → 404）
      let st
      try {
        st = await stat(real)
      } catch {
        res.writeHead(HTTP_NOT_FOUND, { 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }
      if (!st.isFile()) {
        res.writeHead(HTTP_NOT_FOUND, { 'Content-Type': 'text/plain' })
        res.end('not a file')
        return
      }

      // 7. 扩展名白名单（仅图片）
      const ext = extname(real).slice(1).toLowerCase()
      const mime = MIME_MAP[ext]
      if (!IMAGE_EXTENSIONS.has(ext) || !mime) {
        res.writeHead(HTTP_FORBIDDEN, { 'Content-Type': 'text/plain' })
        res.end('forbidden')
        return
      }

      // 8. 200 + 流式。createReadStream 监听 error：处理 stat→open 之间文件被截断/删除
      //    （TOCTOU）或 IO 错误；headers 未发则 500，已发则 res.destroy 终止（防 uncaught throw）。
      //    注：Content-Length 已据 stat 写入，流中途错误会导致 body 与长度不符——destroy 让
      //    客户端收截断响应，比无监听（流静默失败）更安全可观测。
      res.writeHead(HTTP_OK, { 'Content-Type': mime, 'Content-Length': st.size })
      const stream = createReadStream(real)
      stream.on('error', (err: NodeJS.ErrnoException) => {
        console.error('[runtime] /file stream error:', err)
        if (!res.headersSent) {
          res.writeHead(HTTP_INTERNAL_ERROR, { 'Content-Type': 'text/plain' })
          res.end('stream error')
        } else {
          res.destroy(err)
        }
      })
      stream.pipe(res)
    },
  }
}
