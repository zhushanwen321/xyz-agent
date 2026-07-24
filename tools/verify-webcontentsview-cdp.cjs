#!/usr/bin/env node
/**
 * verify-webcontentsview-cdp.cjs — 验证 Electron WebContentsView 是否自动暴露为 CDP target。
 *
 * 关键假设（决定 drawer 集成 browser 功能的验收方案可行性）：
 *   Electron 42 里，用 WebContentsView 嵌入网页后，Playwright/CDP 连
 *   http://localhost:<port>/json/list 能否看到该 WebContentsView 对应的独立 target
 *   （带独立 webSocketDebuggerUrl），从而对它做 DOM 断言。
 *
 * 做法：
 *   1. 创建主 BrowserWindow，加载含「创建 view」按钮的最小 HTML
 *   2. 点击按钮 → 创建 WebContentsView → loadURL（默认加载本地 HTML 文件，
 *      因 example.com 在本机网络不可达；target 是否暴露与加载内容无关）
 *   3. Electron 以 --remote-debugging-port=9333 启动（避开 dev app 的 9222）
 *   4. 等 view webContents did-finish-load 后，fetch /json/list，打印全部 targets
 *   5. 观察：WebContentsView 是否作为独立 target 出现
 *
 * 用法：
 *   直接由 electron 二进制执行：
 *     <electron-bin> tools/verify-webcontentsview-cdp.cjs
 *   脚本自己 app.quit()，跑完即退出。
 *
 * 内容回退：example.com 不可达时自动改用本地 file:// HTML（仅验证 target 暴露）。
 *   设环境变量 WCV_URL=https://example.com 可强制远程 URL。
 */
'use strict'

const { app, BrowserWindow, WebContentsView } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')

const DEBUG_PORT = 9333
const TAG = '[WCV-CDP]'

function log(...args) {
  console.log(TAG, new Date().toISOString(), ...args)
}

// 写一个本地 HTML 给 WebContentsView 加载（example.com 网络不可达时的回退）
function writeLocalEmbedHtml() {
  const tmp = path.join(os.tmpdir(), `wcv-embed-${Date.now()}.html`)
  fs.writeFileSync(
    tmp,
    `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>WCV-EMBED</title></head>
<body>
  <h1 id="embed-title">EMBEDDED-VIA-WEBCONTENTSVIEW</h1>
  <p id="embed-marker">this is loaded inside a WebContentsView</p>
</body>
</html>`,
  )
  return tmp
}

// 取 CDP /json/list（用 node http，避免依赖 fetch 在 electron main 的差异）
function fetchTargetList(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/list', timeout: 5000 },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(new Error(`non-JSON from /json/list: ${data.slice(0, 200)}`))
          }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error('timeout fetching /json/list'))
    })
  })
}

function summarizeTargets(targets) {
  return targets.map((t) => ({
    id: t.id,
    type: t.type,
    title: t.title,
    url: t.url,
    attached: t.attached,
    webSocketDebuggerUrl: t.webSocketDebuggerUrl || null,
  }))
}

async function main() {
  // 检查 remote-debugging-port 是否生效（--remote-debugging-port 由命令行传入）
  log('argv =', process.argv.join(' '))
  log('app.isReady =', app.isReady())

  const embedUrl = process.env.WCV_URL
  let useLocal = false
  if (embedUrl && embedUrl.startsWith('http')) {
    log('using remote embed URL =', embedUrl)
  } else {
    useLocal = true
    log('example.com likely unreachable; using local file:// for WebContentsView content (target exposure is content-independent)')
  }

  // ── 主窗口 ──
  const win = new BrowserWindow({
    width: 600,
    height: 400,
    show: false, // headless-ish：不弹窗，避免干扰
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })

  // 主窗口最小 HTML（含按钮；脚本里直接同步创建 view，不走真实点击，简化）
  await win.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>MAIN-WIN</title></head>
<body><h1>main window</h1><button id="open">open view</button></body></html>`,
      ),
  )
  log('main window loaded, title =', win.getTitle())

  // ── 创建 WebContentsView ──
  log('creating WebContentsView ...')
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 600, height: 400 })

  // 显式确保开启调试（WebContentsView 通常默认随 main 走，这里不强制，先观察默认行为）
  // 如需强制，可设 view.webContents.debugger，但不 attach（attach 会占用 target）。

  // 加载内容
  let loadedUrl
  if (useLocal) {
    const htmlPath = writeLocalEmbedHtml()
    loadedUrl = 'file://' + htmlPath
    log('loading local embed file =', loadedUrl)
  } else {
    loadedUrl = embedUrl
  }

  // 等待 view webContents 加载完成（带超时）
  await new Promise((resolve) => {
    let done = false
    const finish = (how) => {
      if (done) return
      done = true
      log('view load event:', how)
      resolve()
    }
    view.webContents.once('did-finish-load', () => finish('did-finish-load'))
    view.webContents.once('did-fail-load', (_e, code, desc) =>
      finish('did-fail-load code=' + code + ' desc=' + desc),
    )
    // 加载超时兜底（远程 example.com 可能卡住）
    setTimeout(() => finish('load-timeout-3s'), 3000)

    try {
      view.webContents.loadURL(loadedUrl).catch((e) => finish('loadURL-rejected: ' + (e && e.message)))
    } catch (e) {
      finish('loadURL-threw: ' + (e && e.message))
    }
  })

  // 稍等一拍让 CDP target 注册（view webContents 完成后 Chromium 才会把它列进 /json/list）
  await new Promise((r) => setTimeout(r, 800))

  // ── 拉 /json/list ──
  let targets
  try {
    targets = await fetchTargetList(DEBUG_PORT)
  } catch (e) {
    log('ERROR fetching /json/list on port', DEBUG_PORT, ':', e.message)
    log('hint: ensure this script is run via the electron binary with --remote-debugging-port=' + DEBUG_PORT)
    return finish(1)
  }

  log('=== /json/list raw count =', targets.length, '===')
  console.log(JSON.stringify(targets, null, 2))

  const summary = summarizeTargets(targets)
  log('=== summarized targets ===')
  console.log(JSON.stringify(summary, null, 2))

  // ── 判定 WebContentsView 是否独立暴露 ──
  const viewCandidates = targets.filter((t) => {
    // 排除主窗口（title MAIN-WIN 或 data: URL）
    if (t.url && t.url.includes('MAIN-WIN')) return false
    if (t.url && t.url.startsWith('data:')) return false
    // 匹配我们的 embed（local file 或 example.com）
    if (useLocal && t.url && t.url.includes('wcv-embed-')) return true
    if (!useLocal && t.url && t.url.includes('example.com')) return true
    // 也认 title
    if (t.title === 'WCV-EMBED') return true
    return false
  })

  log('=== verdict ===')
  log('WebContentsView exposed as independent target:', viewCandidates.length > 0)
  if (viewCandidates.length > 0) {
    for (const t of viewCandidates) {
      log(
        'FOUND target: type=%s title=%j url=%j webSocketDebuggerUrl=%j',
        t.type,
        t.title,
        t.url,
        t.webSocketDebuggerUrl,
      )
    }
  } else {
    log('NO independent WebContentsView target found in /json/list.')
    log('All targets for reference:', JSON.stringify(summary))
  }

  finish(0)
}

function finish(code) {
  log('app.quit() (exit code', code + ')')
  // 稍延迟以让最后的日志刷出
  setTimeout(() => {
    app.exit(code)
  }, 200)
}

// Electron 安全启动
app.whenReady().then(main).catch((e) => {
  log('FATAL', e && e.stack ? e.stack : e)
  app.exit(2)
})

// 防止多实例/挂起
app.on('window-all-closed', () => {
  /* 不自动退出：main 里手动 app.exit */
})
