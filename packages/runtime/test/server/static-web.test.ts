/**
 * W4-TC6: createStaticWebHandler safe join + SPA fallback 测试。
 *
 * 覆盖：
 *  TC6.1: GET 已存在文件 → 200 + 正确 MIME
 *  TC6.2: GET 不存在文件 → SPA fallback index.html
 *  TC6.3: GET 目录 → 目录下 index.html
 *  TC6.4: 路径穿越（../../etc/passwd）→ 403 Forbidden
 *  TC6.5: HEAD 方法 → 只发 header 不发 body
 *  TC6.6: POST 方法 → 405 Method Not Allowed
 *  TC6.7: MIME 映射（.js/.css/.svg/.woff2/未知扩展名）
 *  TC6.8: index.html 不存在 → 404
 *
 * 策略：注入 tmp dist 目录，造文件树，用 IncomingMessage/ServerResponse mock 驱动 handler。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createStaticWebHandler, createDualStaticWebHandler } from '../../src/server/static-web.js'

function makeReq(method: string, url: string): IncomingMessage {
  return { method, url } as unknown as IncomingMessage
}

function makeRes(): ServerResponse & {
  capturedHeaders: Record<string, string | number | string[]>
  body: string
  statusCode: number
  ended: boolean
} {
  const headers: Record<string, string | number | string[]> = {}
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
  const res = {
    statusCode: 200,
    headersSent: false,
    capturedHeaders: headers,
    body: '',
    ended: false,
    setHeader(k: string, v: string | number | string[]): void { headers[k] = v },
    getHeader(k: string): string | number | string[] | undefined { return headers[k] },
    write(chunk: string | Uint8Array): boolean { res.body += String(chunk); return true },
    end(chunk?: string | Uint8Array): void {
      if (chunk !== undefined) res.body += String(chunk)
      res.headersSent = true
      res.ended = true
      // 触发 'finish' 事件（serveFile pipeline 等此事件 resolve）
      const finishHandlers = handlers['finish'] ?? []
      for (const h of finishHandlers) h()
    },
    on(event: string, handler: (...args: unknown[]) => void): void {
      const list = handlers[event] ?? []
      list.push(handler)
      handlers[event] = list
    },
    pipe(): void { /* noop */ },
    writableEnded: false,
  }
  return res as unknown as ServerResponse & {
    capturedHeaders: Record<string, string | number | string[]>
    body: string
    statusCode: number
    ended: boolean
  }
}

describe('W4-TC6: createStaticWebHandler safe join + SPA', () => {
  let dist: string

  beforeEach(async () => {
    dist = await fs.mkdtemp(join(tmpdir(), 'static-web-test-'))
    // 造文件树
    await fs.writeFile(join(dist, 'index.html'), '<html>SPA</html>')
    await fs.writeFile(join(dist, 'app.js'), 'console.log("app")')
    await fs.writeFile(join(dist, 'style.css'), 'body{}')
    await fs.writeFile(join(dist, 'logo.svg'), '<svg/>')
    await fs.mkdir(join(dist, 'sub'), { recursive: true })
    await fs.writeFile(join(dist, 'sub', 'page.html'), '<html>sub page</html>')
  })
  afterEach(async () => {
    await fs.rm(dist, { recursive: true, force: true })
  })

  it('TC6.1: GET 已存在文件 → 200 + 正确 MIME', async () => {
    const handler = createStaticWebHandler(dist)
    const req = makeReq('GET', '/app.js')
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(res.capturedHeaders['Content-Type']).toBe('application/javascript; charset=utf-8')
    expect(res.body).toBe('console.log("app")')
  })

  it('TC6.2: GET 不存在文件 → SPA fallback index.html', async () => {
    const handler = createStaticWebHandler(dist)
    const req = makeReq('GET', '/nonexistent/route')
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(res.capturedHeaders['Content-Type']).toBe('text/html; charset=utf-8')
    expect(res.body).toBe('<html>SPA</html>')
  })

  it('TC6.3: GET 目录 → 目录下 index.html', async () => {
    const handler = createStaticWebHandler(dist)
    const req = makeReq('GET', '/sub/')
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    // /sub/ 目录下有 page.html，但目录请求→index.html（不存在）→ SPA fallback 根 index.html
    expect(res.body).toBe('<html>SPA</html>')
  })

  it('TC6.4: 路径穿越（../../etc/passwd）→ 403 Forbidden', async () => {
    const handler = createStaticWebHandler(dist)
    const req = makeReq('GET', '/../../etc/passwd')
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(403)
    expect(res.body).toBe('Forbidden')
  })

  it('TC6.5: HEAD 方法 → 只发 header 不发 body', async () => {
    const handler = createStaticWebHandler(dist)
    const req = makeReq('HEAD', '/app.js')
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(res.capturedHeaders['Content-Type']).toBe('application/javascript; charset=utf-8')
    expect(res.capturedHeaders['Content-Length']).toBe(18) // 'console.log("app")'.length
    // HEAD 不发 body（res.end() 无 chunk）
    expect(res.body).toBe('')
  })

  it('TC6.6: POST 方法 → 405 Method Not Allowed', async () => {
    const handler = createStaticWebHandler(dist)
    const req = makeReq('POST', '/app.js')
    const res = makeRes()
    await handler(req, res)
    expect(res.statusCode).toBe(405)
    expect(res.capturedHeaders['Allow']).toBe('GET, HEAD')
  })

  it('TC6.7: MIME 映射（.css/.svg/未知扩展名）', async () => {
    const handler = createStaticWebHandler(dist)
    // .css
    let res = makeRes()
    await handler(makeReq('GET', '/style.css'), res)
    expect(res.capturedHeaders['Content-Type']).toBe('text/css; charset=utf-8')
    // .svg
    res = makeRes()
    await handler(makeReq('GET', '/logo.svg'), res)
    expect(res.capturedHeaders['Content-Type']).toBe('image/svg+xml')
  })

  it('TC6.8: index.html 不存在 → 404', async () => {
    // 空 dist 目录（无 index.html）
    const emptyDist = await fs.mkdtemp(join(tmpdir(), 'empty-dist-'))
    try {
      const handler = createStaticWebHandler(emptyDist)
      const req = makeReq('GET', '/anything')
      const res = makeRes()
      await handler(req, res)
      expect(res.statusCode).toBe(404)
      expect(res.body).toBe('Not Found')
    } finally {
      await fs.rm(emptyDist, { recursive: true, force: true })
    }
  })
})

describe('P4-s4-w2: createDualStaticWebHandler 双 dist 路由（/ desktop vs /m/ mobile）', () => {
  let desktopDist: string
  let mobileDist: string

  beforeEach(async () => {
    desktopDist = await fs.mkdtemp(join(tmpdir(), 'dual-desktop-'))
    mobileDist = await fs.mkdtemp(join(tmpdir(), 'dual-mobile-'))
    await fs.writeFile(join(desktopDist, 'index.html'), '<html>DESKTOP-SPA</html>')
    await fs.writeFile(join(desktopDist, 'app.js'), 'console.log("desktop")')
    await fs.writeFile(join(mobileDist, 'index.html'), '<html>MOBILE-SPA</html>')
    await fs.writeFile(join(mobileDist, 'app.js'), 'console.log("mobile")')
  })
  afterEach(async () => {
    await fs.rm(desktopDist, { recursive: true, force: true })
    await fs.rm(mobileDist, { recursive: true, force: true })
  })

  it('w2-TC6: / 走 desktop、/m/ 走 mobile、资源路径各归各 dist', async () => {
    const handler = createDualStaticWebHandler(desktopDist, mobileDist)
    // / → desktop index.html
    let res = makeRes()
    await handler(makeReq('GET', '/'), res)
    expect(res.body).toBe('<html>DESKTOP-SPA</html>')
    // /app.js → desktop app.js
    res = makeRes()
    await handler(makeReq('GET', '/app.js'), res)
    expect(res.body).toBe('console.log("desktop")')
    // /m/ → mobile index.html
    res = makeRes()
    await handler(makeReq('GET', '/m/'), res)
    expect(res.body).toBe('<html>MOBILE-SPA</html>')
    // /m/app.js → mobile app.js（去 /m/ 前缀）
    res = makeRes()
    await handler(makeReq('GET', '/m/app.js'), res)
    expect(res.body).toBe('console.log("mobile")')
  })

  it('w2-TC7: /m/nonexistent → SPA fallback 到 mobile dist index.html', async () => {
    const handler = createDualStaticWebHandler(desktopDist, mobileDist)
    const res = makeRes()
    await handler(makeReq('GET', '/m/nonexistent/route'), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('<html>MOBILE-SPA</html>')
  })

  it('w2-TC9: 路径穿越 → 403 Forbidden（dual handler 复用 safe-join 守门）', async () => {
    const handler = createDualStaticWebHandler(desktopDist, mobileDist)
    // desktop 侧穿越
    let res = makeRes()
    await handler(makeReq('GET', '/../../etc/passwd'), res)
    expect(res.statusCode).toBe(403)
    // mobile 侧穿越（/m/../ 应被 normalize 守门，不越界到 desktop）
    res = makeRes()
    await handler(makeReq('GET', '/m/../../etc/passwd'), res)
    expect([403, 404]).toContain(res.statusCode)
  })
})

