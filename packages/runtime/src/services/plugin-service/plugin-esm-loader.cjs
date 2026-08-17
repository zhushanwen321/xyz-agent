/**
 * ESM loader（sandbox 子进程专用）——封堵 ESM import 绕过通道
 *
 * Worker 版 CJS 拦截（Module._resolveFilename monkey-patch）对 ESM import 无效，
 * 本 loader 经 execArgv --import 注入子进程，resolve hook 拦截：
 * 1. 内置模块黑名单：node:<name> 前缀 + 裸名（ESM 中 'fs' 等裸内置名）
 * 2. 路径边界：插件代码（pluginDir 内）发起的相对/绝对 import，resolve 后必须在 pluginDir 内
 *
 * 只拦插件代码（parentURL 在 pluginDir 内）的 import；bootstrap/loader 自身放行。
 *
 * 契约（CT3/CT4/CT5）：
 * - self-register：module.exports 先赋值 hooks，再 register 自身（避免 evaluating 中提取空 exports）
 * - env XYZ_PLUGIN_SANDBOX_DIR：插件根目录绝对路径；缺失 → initialize throw（fail-closed）
 *
 * 注意：本文件是 .cjs（--import 注入目标必须独立可执行），无法 require TS 源，
 * BLOCKED_BUILTINS 内联复制自 plugin-sandbox.ts —— 修改黑名单必须同步两处（已注释标记）。
 */

'use strict'

const { register } = require('node:module')
const { pathToFileURL, fileURLToPath } = require('node:url')
const path = require('node:path')
const { realpathSync } = require('node:fs')

/** 同步 plugin-sandbox.ts 的 BLOCKED_BUILTINS（ESM loader 无法 require TS 源，必须内联） */
const BLOCKED_BUILTINS = [
  'fs',
  'fs/promises',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'http',
  'https',
  'net',
  'os',
  'readline',
  'tls',
  'v8',
  'vm',
  'worker_threads',
  // module：node:module 暴露 createRequire，可构造绕过 sandbox 拦截的 require（M6a-01）
  'module',
]

let sandboxDir = ''

/** 对齐 plugin-sandbox errorWithCode 语义：错误对象带 code 字段 */
function sandboxError(message) {
  const err = new Error(message)
  err.code = 'PERMISSION_DENIED'
  return err
}

function isInsideSandbox(fileUrl) {
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('file://')) return false
  const filePath = fileURLToPath(fileUrl)
  const dir = sandboxDir.endsWith(path.sep) ? sandboxDir : sandboxDir + path.sep
  return filePath.startsWith(dir)
}

/** loader 初始化：读 env，缺失 fail-closed（子进程启动即失败，显式暴露 wiring 配置问题） */
function initialize() {
  sandboxDir = process.env.XYZ_PLUGIN_SANDBOX_DIR || ''
  if (!sandboxDir) {
    throw new Error('XYZ_PLUGIN_SANDBOX_DIR is required for sandbox ESM loader (wiring bug: sandbox process without sandbox dir)')
  }
  // 规范化真实路径：macOS /var → /private/var（tmp 目录 symlink），
  // Node 的 file URL 一律用 realpath 后的路径，不规范化则 startsWith 永远失配
  sandboxDir = realpathSync(sandboxDir)
}

/**
 * resolve hook：拦截插件代码的越界 import。
 * 非插件代码（parentURL 不在 pluginDir 内，如 bootstrap/loader 自身）一律放行。
 */
async function resolve(specifier, context, nextResolve) {
  // 只拦插件代码（pluginDir 内模块）发起的 import
  if (!isInsideSandbox(context.parentURL)) {
    return nextResolve(specifier, context)
  }

  // 路径类 import（./ ../ / 绝对路径 / file:）：先解析再查边界
  if (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    specifier.startsWith('file:')
  ) {
    const resolved = await nextResolve(specifier, context)
    if (!isInsideSandbox(resolved.url)) {
      throw sandboxError(`Sandbox: import('${specifier}') resolves outside plugin directory`)
    }
    return resolved
  }

  // node: 前缀或裸内置名 → 黑名单检查
  const bareName = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  if (BLOCKED_BUILTINS.includes(bareName)) {
    throw sandboxError(`Sandbox: import('${specifier}') is blocked`)
  }

  // 非 node: 的带 scheme specifier（data:/blob:/http: 等）一律拒绝（MF-1 沙箱逃逸）：
  // 这类 URL 不经 pluginDir 边界校验，其内部 import 的 parentURL 非沙箱 file://，
  // 会短路整个 hook 绕过黑名单（如 data: 模块内 import 'node:fs' 直读任意文件）。
  // node:/file: 已在上文分流；npm 裸名（无 scheme，如 ajv/croner）继续放行。
  // 仅拦「插件代码直接 import」，不影响 npm dep 内部的 data:/blob:（其 parentURL 在 node_modules，走 bypass）。
  if (!specifier.startsWith('node:') && /^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
    throw sandboxError(`Sandbox: import('${specifier}') uses blocked scheme`)
  }

  // 裸名（npm 包名，非黑名单）放行
  return nextResolve(specifier, context)
}

// hooks 先赋值再 self-register（register 从本模块 exports 提取 hooks，
// 顺序反了会在 evaluating 中拿到空 exports）
module.exports = { initialize, resolve }

register(pathToFileURL(__filename).href)
