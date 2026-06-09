/**
 * NpmInstaller — 纯 Node.js npm 包安装器。
 *
 * 替代 `execFileSync('npm', ...)` 调用，解决打包后 Electron 应用中
 * npm CLI 不在 PATH 导致的 ENOENT 错误。
 *
 * 原理：npm registry API 获取元数据 + HTTP 下载 tarball + tar 解压 +
 * 递归依赖安装（flat node_modules 布局）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { createGunzip } from 'node:zlib'
import semver from 'semver'
import { extract as tarExtract } from 'tar'

// ── 常量 ──────────────────────────────────────────────────────

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_TIMEOUT = 60_000
const MAX_REDIRECTS = 5

// ── 类型 ──────────────────────────────────────────────────────

interface VersionManifest {
  version: string
  dist: { tarball: string; integrity?: string; shasum?: string }
  dependencies?: Record<string, string>
}

interface PackageMetadata {
  'dist-tags': Record<string, string>
  versions: Record<string, VersionManifest>
}

export interface NpmInstallOptions {
  timeout?: number
}

export class NpmInstallError extends Error {
  readonly code: 'not_found' | 'network' | 'extract'

  constructor(code: 'not_found' | 'network' | 'extract', message: string) {
    super(message)
    this.name = 'NpmInstallError'
    this.code = code
  }
}

// ── HTTP 工具 ─────────────────────────────────────────────────

function getRegistry(): string {
  return process.env.NPM_CONFIG_REGISTRY ?? DEFAULT_REGISTRY
}

function httpGet(url: string, timeout?: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const ms = timeout ?? DEFAULT_TIMEOUT

    const timer = setTimeout(() => {
      req.destroy(new Error(`Request timeout after ${ms}ms`))
    }, ms)

    const req = client.get(url, (res) => {
      clearTimeout(timer)
      resolve(res)
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** 跟随 HTTP 重定向（最多 MAX_REDIRECTS 次） */
async function followRedirects(
  res: http.IncomingMessage,
  timeout?: number,
  remaining = MAX_REDIRECTS,
): Promise<http.IncomingMessage> {
  const status = res.statusCode ?? 0
  if (status >= 301 && status <= 308 && status !== 304) {
    if (remaining <= 0) {
      throw new NpmInstallError('network', 'Too many redirects')
    }
    res.resume() // drain response body to avoid leak
    const location = res.headers.location
    if (!location) {
      throw new NpmInstallError('network', `Redirect ${status} with no Location header`)
    }
    const next = await httpGet(location, timeout)
    return followRedirects(next, timeout, remaining - 1)
  }
  return res
}

async function fetchJson<T>(url: string, timeout?: number): Promise<T> {
  const res = await httpGet(url, timeout)
  const final = await followRedirects(res, timeout)

  if (final.statusCode === 404) {
    throw new NpmInstallError('not_found', `Package not found (404)`)
  }
  if (final.statusCode !== 200) {
    throw new NpmInstallError('network', `HTTP ${final.statusCode}`)
  }

  return new Promise<T>((resolve, reject) => {
    let data = ''
    final.on('data', (chunk: Buffer) => { data += chunk.toString() })
    final.on('end', () => {
      try { resolve(JSON.parse(data)) }
      catch { reject(new NpmInstallError('network', 'Invalid JSON from registry')) }
    })
    final.on('error', reject)
  })
}

// ── 包解析 ────────────────────────────────────────────────────

function encodePackageName(name: string): string {
  return name.startsWith('@') ? name.replace('/', '%2F') : name
}

function parseSpec(spec: string): { name: string; range?: string } {
  if (spec.startsWith('@')) {
    const lastAt = spec.indexOf('@', 1)
    if (lastAt === -1) return { name: spec }
    return { name: spec.slice(0, lastAt), range: spec.slice(lastAt + 1) }
  }
  const atIdx = spec.indexOf('@')
  if (atIdx === -1) return { name: spec }
  return { name: spec.slice(0, atIdx), range: spec.slice(atIdx + 1) }
}

async function fetchMetadata(name: string, timeout?: number): Promise<PackageMetadata> {
  const registry = getRegistry()
  const url = `${registry}/${encodePackageName(name)}`
  return fetchJson<PackageMetadata>(url, timeout)
}

function resolveVersion(metadata: PackageMetadata, range?: string): string {
  // dist-tag（如 'latest'、'next'）
  if (range && metadata['dist-tags'][range]) {
    return metadata['dist-tags'][range]
  }
  // 无 range → latest
  if (!range) {
    return metadata['dist-tags'].latest
  }
  // 精确版本
  if (range in metadata.versions) {
    return range
  }
  // semver range → max satisfying
  const versions = Object.keys(metadata.versions)
  const match = semver.maxSatisfying(versions, range)
  if (match) return match

  // fallback 到 latest
  return metadata['dist-tags'].latest
}

// ── Tarball 下载 + 解压 ──────────────────────────────────────

async function downloadAndExtract(
  tarballUrl: string,
  targetDir: string,
  timeout?: number,
): Promise<void> {
  // 清理旧目录，避免残留文件
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true })
  }
  mkdirSync(targetDir, { recursive: true })

  const res = await httpGet(tarballUrl, timeout)
  const final = await followRedirects(res, timeout)

  if (final.statusCode !== 200) {
    throw new NpmInstallError('network', `Tarball download failed: HTTP ${final.statusCode}`)
  }

  return new Promise<void>((resolve, reject) => {
    const gunzip = createGunzip()
    const extract = tarExtract({ cwd: targetDir, strip: 1 })

    gunzip.on('error', (err) => {
      reject(new NpmInstallError('extract', `Gunzip failed: ${err.message}`))
    })
    extract.on('error', (err) => {
      reject(new NpmInstallError('extract', `Tar extract failed: ${err.message}`))
    })
    extract.on('finish', resolve)

    final.pipe(gunzip).pipe(extract as unknown as NodeJS.WritableStream)
  })
}

// ── 公开 API ──────────────────────────────────────────────────

/**
 * 安装 npm 包及其依赖到 node_modules 目录。
 * 使用 flat node_modules 布局（类似 npm v3+）。
 */
export async function installPackage(
  spec: string,
  nodeModulesDir: string,
  options?: NpmInstallOptions,
  _installed?: Set<string>,
): Promise<void> {
  const installed = _installed ?? new Set()
  const { name, range } = parseSpec(spec)

  if (installed.has(name)) return
  installed.add(name)

  mkdirSync(nodeModulesDir, { recursive: true })

  const metadata = await fetchMetadata(name, options?.timeout)
  const version = resolveVersion(metadata, range)
  const manifest = metadata.versions[version]

  if (!manifest) {
    throw new NpmInstallError('not_found', `Version ${version} not found for ${name}`)
  }

  // 目标目录（scoped 包需创建 @scope/ 子目录）
  const pkgDir = join(nodeModulesDir, name)

  // 下载 + 解压
  await downloadAndExtract(manifest.dist.tarball, pkgDir, options?.timeout)

  // 递归安装 dependencies（仅生产依赖，跳过 peer/dev/optional）
  const deps = manifest.dependencies ?? {}
  for (const [depName, depRange] of Object.entries(deps)) {
    try {
      await installPackage(`${depName}@${depRange}`, nodeModulesDir, options, installed)
    } catch (e) {
      // 传递依赖安装失败不阻塞主包，记录警告继续
      console.warn(
        `[npm-installer] Failed to install dependency ${depName}@${depRange}:`,
        e instanceof Error ? e.message : String(e),
      )
    }
  }
}

/**
 * 从 node_modules 移除指定包。
 */
export async function uninstallPackage(name: string, nodeModulesDir: string): Promise<void> {
  const pkgDir = join(nodeModulesDir, name)
  if (existsSync(pkgDir)) {
    rmSync(pkgDir, { recursive: true, force: true })
  }
}

/**
 * 安装 projectDir 中 package.json 的所有 dependencies。
 * 用于 git clone 后安装依赖的场景。
 */
export async function installDependencies(
  projectDir: string,
  options?: NpmInstallOptions,
): Promise<void> {
  const pkgJsonPath = join(projectDir, 'package.json')
  if (!existsSync(pkgJsonPath)) return

  let pkg: { dependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
  } catch {
    return
  }

  const deps = pkg.dependencies ?? {}
  const nodeModulesDir = join(projectDir, 'node_modules')
  const installed = new Set<string>()

  for (const [depName, depRange] of Object.entries(deps)) {
    try {
      await installPackage(`${depName}@${depRange}`, nodeModulesDir, options, installed)
    } catch (e) {
      console.warn(
        `[npm-installer] Failed to install dependency ${depName}:`,
        e instanceof Error ? e.message : String(e),
      )
    }
  }
}
