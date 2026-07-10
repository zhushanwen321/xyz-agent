/**
 * NpmInstaller — 纯 Node.js npm 包安装器。
 *
 * 替代 `execFileSync('npm', ...)` 调用，解决打包后 Electron 应用中
 * npm CLI 不在 PATH 导致的 ENOENT 错误。
 *
 * 原理：npm registry API 获取元数据 + HTTP 下载 tarball + tar 解压 +
 * 递归依赖安装（flat node_modules 布局）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { createGunzip } from 'node:zlib'
import crypto from 'node:crypto'
import semver from 'semver'
import { extract as tarExtract } from 'tar'
import { toErrorMessage } from '../../utils/errors.js'

// ── 常量 ──────────────────────────────────────────────────────

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_TIMEOUT = 60_000
const MAX_REDIRECTS = 5
// HTTP status codes used in response handling
const HTTP_OK = 200
const HTTP_NOT_FOUND = 404
const HTTP_REDIRECT_LOW = 301
const HTTP_REDIRECT_HIGH = 308
const HTTP_NOT_MODIFIED = 304

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
  readonly code: 'not_found' | 'network' | 'extract' | 'integrity'

  constructor(code: 'not_found' | 'network' | 'extract' | 'integrity', message: string) {
    super(message)
    this.name = 'NpmInstallError'
    this.code = code
  }
}

// ── SSRF 防护 ────────────────────────────────────────────────

/** 内网 / 特殊用途 IP 段，禁止 HTTP 请求访问 */
const PRIVATE_IP_RANGES = [
  /^0\./,                        // 0.0.0.0/8
  /^10\./,                       // 10.0.0.0/8
  /^127\./,                      // 127.0.0.0/8
  /^169\.254\./,                 // 169.254.0.0/16 (link-local)
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.0\.2\./,                // 192.0.2.0/24 (TEST-NET-1)
  /^192\.168\./,                 // 192.168.0.0/16
  /^198\.51\.100\./,             // 198.51.100.0/24 (TEST-NET-2)
  /^203\.0\.113\./,              // 203.0.113.0/24 (TEST-NET-3)
  /^22[4-9]\./,                  // 224.0.0.0/4 (multicast)
  /^23[0-9]\./,                  // 239.0.0.0/8 (multicast)
  /^24[0-9]\./,                  // 240.0.0.0/4 (reserved)
  /^25[0-5]\./,                  // 255.0.0.0/8 (broadcast)
]

export function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_RANGES.some(re => re.test(ip))
}

/** 校验 URL host 不是内网地址，防止 SSRF */
export function validateUrlHost(urlStr: string): void {
  let parsed: URL
  try {
    parsed = new URL(urlStr)
  } catch {
    throw new NpmInstallError('network', `Invalid URL: ${urlStr}`)
  }

  // 只允许 https（registry 和 tarball 都走 HTTPS）
  if (parsed.protocol !== 'https:') {
    throw new NpmInstallError('network', `Blocked non-HTTPS URL: ${urlStr}`)
  }

  const hostname = parsed.hostname

  // IPv6 loopback / link-local
  if (hostname.startsWith('[')) {
    const bare = hostname.replace(/^\[|\]$/g, '')
    if (bare === '::1' || bare.startsWith('fe80:') || bare.startsWith('fc00:') || bare.startsWith('fd')) {
      throw new NpmInstallError('network', `Blocked private IP in URL: ${urlStr}`)
    }
    return
  }

  // 纯域名（含字母）— 不做 IP 检查，由 DNS + HTTPS 保障
  if (/[a-zA-Z]/.test(hostname)) return

  // 纯 IP 地址
  if (isPrivateIp(hostname)) {
    throw new NpmInstallError('network', `Blocked private IP in URL: ${urlStr}`)
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

/** 跟随 HTTP 重定向（最多 MAX_REDIRECTS 次），带 SSRF 校验 */
async function followRedirects(
  res: http.IncomingMessage,
  timeout?: number,
  remaining = MAX_REDIRECTS,
): Promise<http.IncomingMessage> {
  const status = res.statusCode ?? 0
  if (status >= HTTP_REDIRECT_LOW && status <= HTTP_REDIRECT_HIGH && status !== HTTP_NOT_MODIFIED) {
    if (remaining <= 0) {
      throw new NpmInstallError('network', 'Too many redirects')
    }
    res.resume() // drain response body to avoid leak
    const location = res.headers.location
    if (!location) {
      throw new NpmInstallError('network', `Redirect ${status} with no Location header`)
    }
    // SSRF: 校验重定向目标
    validateUrlHost(location)
    const next = await httpGet(location, timeout)
    return followRedirects(next, timeout, remaining - 1)
  }
  return res
}

async function fetchJson<T>(url: string, timeout?: number): Promise<T> {
  const res = await httpGet(url, timeout)
  const final = await followRedirects(res, timeout)

  if (final.statusCode === HTTP_NOT_FOUND) {
    throw new NpmInstallError('not_found', `Package not found (${HTTP_NOT_FOUND})`)
  }
  if (final.statusCode !== HTTP_OK) {
    throw new NpmInstallError('network', `HTTP ${final.statusCode}`)
  }

  return new Promise<T>((resolve, reject) => {
    let data = ''
    // body 读取阶段也需超时——服务器发了 header 后 stall 不发 body 会永久 pending
    const bodyTimer = setTimeout(() => {
      final.destroy(new Error(`Body read timeout after ${timeout ?? DEFAULT_TIMEOUT}ms`))
    }, timeout ?? DEFAULT_TIMEOUT)
    final.on('data', (chunk: Buffer) => { data += chunk.toString() })
    final.on('end', () => {
      clearTimeout(bodyTimer)
      try { resolve(JSON.parse(data)) }
      catch { reject(new NpmInstallError('network', 'Invalid JSON from registry')) }
    })
    final.on('error', (err) => {
      clearTimeout(bodyTimer)
      reject(err)
    })
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

// ── 完整性校验 ────────────────────────────────────────────────

/** 校验 tarball 的 SRI integrity 或 shasum */
function verifyIntegrity(
  buffer: Buffer,
  dist: { integrity?: string; shasum?: string },
  packageName: string,
): void {
  if (dist.integrity) {
    // SRI 格式: "sha512-<base64>" 或 "sha384-<base64>"
    const match = dist.integrity.match(/^(\w+)-([a-zA-Z0-9+/=]+)$/)
    if (match) {
      const [, algo, expectedBase64] = match
      if (crypto.getHashes().includes(algo)) {
        const hash = crypto.createHash(algo).update(buffer).digest('base64')
        if (hash !== expectedBase64) {
          throw new NpmInstallError(
            'integrity',
            `Integrity check failed for ${packageName}: expected ${dist.integrity}, got ${algo}-${hash}`,
          )
        }
      }
    }
  } else if (dist.shasum) {
    // shasum 是 hex 编码的 SHA-1
    const hash = crypto.createHash('sha1').update(buffer).digest('hex')
    if (hash !== dist.shasum) {
      throw new NpmInstallError(
        'integrity',
        `Shasum check failed for ${packageName}: expected ${dist.shasum}, got ${hash}`,
      )
    }
  }
  // 两者都没有时不校验（极少数老旧包可能缺失）
}

// ── Tarball 下载 + 解压 ──────────────────────────────────────

/**
 * gunzip + tar 解压到 tmpDir（D26）。
 *
 * `feedGunzip` 由调用方提供，决定如何把数据喂给 gunzip：
 * - integrity 路径：先 buffer 化并校验，再 `gunzip.write(buffer); gunzip.end()`
 * - 流式路径：`final.pipe(gunzip)`
 *
 * 错误处理（gunzip/extract 失败 → NpmInstallError('extract')）与 finish 解析对所有
 * 调用方一致，原本在 downloadAndExtract 内重复两遍。
 */
function extractTarStream(
  tmpDir: string,
  feedGunzip: (gunzip: NodeJS.WritableStream) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const gunzip = createGunzip()
    const extract = tarExtract({ cwd: tmpDir, strip: 1 })
    gunzip.on('error', (err) => {
      reject(new NpmInstallError('extract', `Gunzip failed: ${err.message}`))
    })
    extract.on('error', (err) => {
      reject(new NpmInstallError('extract', `Tar extract failed: ${err.message}`))
    })
    extract.on('finish', resolve)
    feedGunzip(gunzip)
    gunzip.pipe(extract as unknown as NodeJS.WritableStream)
  })
}

async function downloadAndExtract(
  tarballUrl: string,
  targetDir: string,
  dist: { integrity?: string; shasum?: string },
  packageName: string,
  timeout?: number,
): Promise<void> {
  // SSRF: 校验 tarball URL
  validateUrlHost(tarballUrl)

  // 原子下载：先解压到 .tmp 目录，成功后 rename 到目标位置
  const tmpDir = `${targetDir}.tmp`
  // 清理残留的 .tmp 目录
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
  mkdirSync(tmpDir, { recursive: true })

  const res = await httpGet(tarballUrl, timeout)
  const final = await followRedirects(res, timeout)

  if (final.statusCode !== HTTP_OK) {
    rmSync(tmpDir, { recursive: true, force: true })
    throw new NpmInstallError('network', `Tarball download failed: HTTP ${final.statusCode}`)
  }

  // 如果有 integrity/shasum，先完整下载到 buffer 校验，再解压
  const needsIntegrityCheck = Boolean(dist.integrity || dist.shasum)

  try {
    if (needsIntegrityCheck) {
      // 下载到内存，校验完整性，再写入 tmp 目录
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        final.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        final.on('end', () => { resolve(Buffer.concat(chunks)) })
        final.on('error', reject)
      })
      verifyIntegrity(buffer, dist, packageName)

      // 校验通过，解压到 tmp 目录（feed buffer 给 gunzip）
      await extractTarStream(tmpDir, (gunzip) => {
        gunzip.write(buffer)
        gunzip.end()
      })
    } else {
      // 无 integrity 信息，直接流式解压（pipe 下载流给 gunzip）
      await extractTarStream(tmpDir, (gunzip) => {
        final.pipe(gunzip)
      })
    }

    // 解压成功，原子替换目标目录
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }
    renameSync(tmpDir, targetDir)
  } catch (e) {
    // 清理失败的 tmp 目录
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
    throw e
  }
}

// ── 内部递归安装 ──────────────────────────────────────────────

/**
 * 递归安装 npm 包及其依赖。
 * 内部函数，installed 集合在递归调用间共享。
 */
async function installPackageRecursive(
  spec: string,
  nodeModulesDir: string,
  options: NpmInstallOptions | undefined,
  installed: Set<string>,
): Promise<void> {
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

  // 下载 + 解压（原子操作）
  await downloadAndExtract(manifest.dist.tarball, pkgDir, manifest.dist, name, options?.timeout)

  // 递归安装 dependencies（仅生产依赖，跳过 peer/dev/optional）
  const deps = manifest.dependencies ?? {}
  for (const [depName, depRange] of Object.entries(deps)) {
    try {
      await installPackageRecursive(`${depName}@${depRange}`, nodeModulesDir, options, installed)
    } catch (e) { // eslint-disable-line taste/no-silent-catch
      // 传递依赖安装失败不阻塞主包。仅记录错误继续安装其他依赖。
      console.warn(
        `[npm-installer] Failed to install dependency ${depName}@${depRange}:`,
        toErrorMessage(e),
      )
    }
  }
}

/**
 * 从 npm registry 获取包的 latest 版本号。
 * 用于扩展升级检查：比较当前版本与 latest 决定是否需要升级。
 */
export async function fetchLatestVersion(
  pkgName: string,
  timeout?: number,
): Promise<string> {
  const metadata = await fetchMetadata(pkgName, timeout)
  const latest = metadata['dist-tags'].latest
  if (!latest) {
    throw new NpmInstallError('not_found', `No latest version found for ${pkgName}`)
  }
  return latest
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
): Promise<void> {
  return installPackageRecursive(spec, nodeModulesDir, options, new Set())
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
      await installPackageRecursive(`${depName}@${depRange}`, nodeModulesDir, options, installed)
    } catch (e) { // eslint-disable-line taste/no-silent-catch
      // 传递依赖安装失败不阻塞主包。仅记录错误继续安装其他依赖。
      console.warn(
        `[npm-installer] Failed to install dependency ${depName}:`,
        toErrorMessage(e),
      )
    }
  }
}
