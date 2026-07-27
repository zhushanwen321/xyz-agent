/**
 * 静态 Web 资源 HTTP handler（wave4 远程化 server CLI）。
 *
 * 用途：server CLI 模式（xyz-agent-runtime --serve-web <dist>）下，runtime 内嵌 HTTP
 * 服务静态前端资源（apps/electron/dist/renderer 产物），使浏览器经 #token= 直连无需
 * 独立 nginx。WS 升级请求由 connection-manager 处理，本 handler 只服务 GET 静态文件。
 *
 * 安全设计：
 *  - safe join：resolve(dist, normalize(path))，结果不在 dist 下（isUnderOrEqual false）→ 403
 *  - 防 ../ 穿越 + 绝对路径注入
 *  - 仅 GET/HEAD 方法（其余 405）
 *  - 文件不存在 → SPA fallback index.html（前端路由由 vue-router 接管）
 *  - 流式输出（createReadStream，避免大文件全量读入内存）
 *  - MIME 按扩展名映射（含字体/图片），未知扩展名 fallback application/octet-stream
 */
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { resolve, normalize, extname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isUnderOrEqual } from '../utils/path-utils.js'

/** 扩展名 → MIME 映射（覆盖 SPA 前端常用资源类型）。 */
const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

const DEFAULT_MIME = 'application/octet-stream'
const INDEX_HTML = 'index.html'

// HTTP 状态码（命名避免 magic number，与 file-endpoint.ts 同约定）
const HTTP_OK = 200
const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const HTTP_METHOD_NOT_ALLOWED = 405

/** dist 目录绝对路径（构造时 resolve 一次，handler 内复用）。 */
export interface StaticWebHandler {
  (req: IncomingMessage, res: ServerResponse): Promise<void>
}

/**
 * 创建静态 Web handler。
 *
 * @param dist 静态资源根目录（绝对路径；相对路径以 process.cwd() 解析）
 * @returns async handler，注入 HTTP server 的 request 事件
 */
export function createStaticWebHandler(dist: string): StaticWebHandler {
  const distAbs = resolve(dist)
  const indexHtmlPath = join(distAbs, INDEX_HTML)

  return async function staticWebHandler(req, res): Promise<void> {
    // 仅 GET/HEAD（WS 升级请求不经此 handler，由 connection-manager 接管）
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = HTTP_METHOD_NOT_ALLOWED
      res.setHeader('Allow', 'GET, HEAD')
      res.end('Method Not Allowed')
      return
    }

    // 解析请求路径：取 url path 段，去 query string，防 %2e%2e 编码穿越（normalize 不解码）。
    // 去掉前导斜杠后再 join：resolve 会把绝对路径（以 / 开头）当作根，绕过 dist 基址。
    // 剥前导斜杠 + normalize 处理 .. 后，resolve(distAbs, relPath) 才正确落在 dist 下。
    const reqUrl = req.url ?? '/'
    const pathOnly = reqUrl.split('?')[0].split('#')[0]
    const stripped = pathOnly.replace(/^\/+/, '')
    const normalized = normalize(stripped)

    // safe join：解析后的绝对路径必须在 dist 下
    const target = resolve(distAbs, normalized)
    if (!isUnderOrEqual(distAbs, target)) {
      res.statusCode = HTTP_FORBIDDEN
      res.end('Forbidden')
      return
    }

    try {
      const stats = await stat(target)
      if (stats.isDirectory()) {
        // 目录请求 → index.html
        await serveFile(join(target, INDEX_HTML), req, res)
        return
      }
      await serveFile(target, req, res)
    } catch {
      // 文件/目录不存在 → SPA fallback index.html（vue-router 接管客户端路由）
      try {
        await serveFile(indexHtmlPath, req, res)
      } catch {
        // index.html 也不存在（dist 未构建/路径错）→ 404
        res.statusCode = HTTP_NOT_FOUND
        res.end('Not Found')
      }
    }
  }
}

/** 流式输出单个文件（按扩展名设 MIME + Content-Length）。HEAD 方法只发 header 不发 body。
 *  用 'data'/'end' 事件显式 write/end（非 pipe）——便于测试注入 mock res，且语义等价。 */
async function serveFile(
  filePath: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const stats = await stat(filePath)
  const mime = MIME_MAP[extname(filePath).toLowerCase()] ?? DEFAULT_MIME
  res.statusCode = HTTP_OK
  res.setHeader('Content-Type', mime)
  res.setHeader('Content-Length', stats.size)

  if (req.method === 'HEAD') {
    res.end()
    return
  }

  await new Promise<void>((resolveP, rejectP) => {
    const stream = createReadStream(filePath)
    let errored = false
    stream.on('data', (chunk: Buffer) => {
      // res.write 返回 false 表示背压（写入缓冲满），此处忽略背压（HTTP res 缓冲足够）
      res.write(chunk)
    })
    stream.on('end', () => {
      if (!errored) {
        res.end()
      }
    })
    stream.on('error', (err) => {
      errored = true
      // 流读中途出错（文件被删等）→ 500
      if (!res.headersSent) {
        res.statusCode = 500
        res.end('Internal Server Error')
      }
      rejectP(err)
    })
    res.on('error', rejectP)
    res.on('finish', resolveP)
  })
}
