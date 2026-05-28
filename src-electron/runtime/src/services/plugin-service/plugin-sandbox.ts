/**
 * Worker Sandbox: require 拦截和进程环境保护
 *
 * 在 sandbox 模式的 Worker 中拦截 require 调用，阻止访问
 * 危险的 Node.js 内置模块（fs、child_process 等），
 * 同时允许安全模块（path、url、util 等）通过。
 *
 * 同时替换 process.env 为空 Proxy，防止环境变量泄露。
 */

/** 被阻止的 Node.js 内置模块列表 */
export const BLOCKED_BUILTINS: readonly string[] = [
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
]

/**
 * 创建 require 拦截函数。
 *
 * 拦截规则：
 * - 相对路径 (./ ../): 检查解析后的绝对路径是否在 pluginDir 内
 * - npm 包名: 检查是否在 BLOCKED_BUILTINS 列表中
 * - 不满足条件: throw Error(code: 'PERMISSION_DENIED')
 *
 * @param pluginDir 插件根目录，用于相对路径边界检查
 * @returns 拦截函数，返回允许的模块标识符或抛出 PERMISSION_DENIED
 */
export function createRequireInterceptor(pluginDir: string): (request: string, resolvedPath?: string) => string {
  const normalizedPluginDir = pluginDir.endsWith('/') ? pluginDir : pluginDir + '/'

  return (request: string, resolvedPath?: string): string => {
    // 相对路径：检查是否在 pluginDir 内
    if (request.startsWith('./') || request.startsWith('../')) {
      if (resolvedPath) {
        const normalizedResolved = resolvedPath.startsWith('/') ? resolvedPath : ''
        if (!normalizedResolved.startsWith(normalizedPluginDir)) {
          const err = new Error(`Sandbox: require('${request}') resolves outside plugin directory`)
          ;(err as unknown as Record<string, unknown>).code = 'PERMISSION_DENIED'
          throw err
        }
      }
      return resolvedPath ?? request
    }

    // npm 包名 / 内置模块：检查 blocklist
    if (BLOCKED_BUILTINS.includes(request)) {
      const err = new Error(`Sandbox: require('${request}') is blocked`)
      ;(err as unknown as Record<string, unknown>).code = 'PERMISSION_DENIED'
      throw err
    }

    return request
  }
}

/**
 * 替换 process.env 为空 Proxy，防止插件读取宿主环境变量。
 * 所有 get 返回 undefined，所有 set 静默失败。
 */
export function createEnvProxy(): NodeJS.ProcessEnv {
  return new Proxy({} as NodeJS.ProcessEnv, {
    get: () => undefined,
    set: () => true,
    has: () => false,
    deleteProperty: () => true,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  })
}
