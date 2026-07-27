/**
 * pi 二进制下载（wave4 远程化 server CLI）。
 *
 * 触发场景：findPiExecutable 返 'pi' 兜底（系统 PATH 无 pi、dataDir slot 无 pi）时，
 * server/index.ts 调本模块从 GitHub release 自动下载到 <dataDir>/pi/，使首启零依赖可用。
 *
 * 流程（对齐 scripts/prepare-pi-resources.sh 的 asset 命名 + 解压展平逻辑）：
 *  1. 平台/架构映射 → asset 名 + binary 名
 *     - darwin → pi-darwin-{arch}.tar.gz / pi-darwin-{arch}
 *     - linux  → pi-linux-{arch}.tar.gz  / pi-linux-{arch}
 *     - win32  → pi-windows-{arch}.zip   / pi-windows-{arch}.exe
 *  2. 下载 URL: https://github.com/badlogic/pi-mono/releases/download/v${PI_VERSION}/${ASSET}
 *     用 global fetch（Node 22+），fetch 自动跟随重定向。
 *     流式写临时文件 <dataDir>/pi/.download.tmp（pipeline 防 fd 泄漏）。
 *  3. 解压：
 *     - tar.gz → tar.extract({ file, cwd })
 *     - zip → 系统 bsdtar（Win10+ 自带 tar.exe，macOS/Linux 用 unzip 兜底）
 *     pi release 包一层 pi/ 目录，展平（cp pi/pi → <dataDir>/pi/<binaryName>）。
 *  4. rename + chmod +x（非 win）。
 *  5. 冒烟：execFile(<binaryPath>, ['--version']) 验返回 0。
 *  6. 失败清理临时文件 + 抛清晰错误（含 XYZ_PI_BIN / npm i -g 指引）。
 *
 * 返回最终 binary 路径（<dataDir>/pi/<binaryName>）。
 */
import { PI_VERSION } from '@xyz-agent/shared'
import { promises as fs, createWriteStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { extract } from 'tar'

const execFileAsync = promisify(execFile)

/** pi-mono release 仓库（badlogic/pi-mono，与 prepare-pi-resources.sh 同源）。 */
const PI_REPO = 'badlogic/pi-mono'
/** 冒烟 execFile 超时（ms）。pi --version 应秒级返回。 */
const SMOKE_TIMEOUT_MS = 10_000
/** bsdtar/unzip 解压超时（ms）。 */
const EXTRACT_TIMEOUT_MS = 60_000
/** 二进制可执行权限（非 win）。0o755 = owner rwx + group/other rx。 */
const EXEC_MODE = 0o755

interface PlatformAsset {
  /** release asset 文件名。 */
  asset: string
  /** 解压后的最终 binary 文件名（process-manager 期望的命名）。 */
  binaryName: string
  /** 解压方式。 */
  archive: 'tar.gz' | 'zip'
}

/**
 * 平台/架构 → asset 映射。复用 process-manager 的 binaryName 命名（pi-<plat>-<arch>[.exe]）。
 * 不支持的平台抛错（process.arch 仅 'arm64'/'x64' 常见，其余未测）。
 */
function resolveAsset(): PlatformAsset {
  const platform = process.platform // 'darwin' | 'win32' | 'linux'
  const arch = process.arch // 'arm64' | 'x64'
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Unsupported arch: ${arch}. pi release only provides arm64/x64 binaries.`)
  }
  if (platform === 'win32') {
    return { asset: `pi-windows-${arch}.zip`, binaryName: `pi-windows-${arch}.exe`, archive: 'zip' }
  }
  if (platform === 'darwin') {
    return { asset: `pi-darwin-${arch}.tar.gz`, binaryName: `pi-darwin-${arch}`, archive: 'tar.gz' }
  }
  if (platform === 'linux') {
    return { asset: `pi-linux-${arch}.tar.gz`, binaryName: `pi-linux-${arch}`, archive: 'tar.gz' }
  }
  throw new Error(`Unsupported platform: ${platform}`)
}

/**
 * 从 GitHub release 下载 pi 二进制并解压到 <dataDir>/pi/。
 *
 * @param dataDir xyz-agent 数据根目录（getDataDir()），binary 落 <dataDir>/pi/<binaryName>
 * @returns 最终 binary 绝对路径
 */
export async function fetchPiBinary(dataDir: string): Promise<string> {
  const { asset, binaryName, archive } = resolveAsset()
  const piDir = join(dataDir, 'pi')
  const tmpArchive = join(piDir, '.download.tmp')
  const finalBinaryPath = join(piDir, binaryName)

  // 已存在则跳过下载（幂等：--reset-token 等重跑不重复下载）
  if (existsSync(finalBinaryPath)) {
    return finalBinaryPath
  }

  await fs.mkdir(piDir, { recursive: true })

  try {
    // ── 1. 下载 ─────────────────────────────────────────────────────
    const url = `https://github.com/${PI_REPO}/releases/download/v${PI_VERSION}/${asset}`
    await downloadToFile(url, tmpArchive)

    // ── 2. 解压 ─────────────────────────────────────────────────────
    await extractArchive(tmpArchive, piDir, archive)

    // ── 3. 展平 pi/ 目录 + rename 到期望 binaryName ──────────────────
    await flattenAndRename(piDir, binaryName)

    // ── 4. chmod +x（非 win）────────────────────────────────────────
    if (process.platform !== 'win32') {
      await fs.chmod(finalBinaryPath, EXEC_MODE)
    }

    // ── 5. 冒烟 ─────────────────────────────────────────────────────
    await smokeTest(finalBinaryPath)

    return finalBinaryPath
  } catch (e) {
    // 失败清理临时文件 + 抛清晰错误（含手动指引）
    await safeUnlink(tmpArchive)
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(
      `Failed to setup pi binary (v${PI_VERSION}, ${asset}): ${reason}\n`
      + 'Manual options:\n'
      + `  1. Install pi globally: npm i -g @earendil-works/pi-coding-agent\n`
      + `  2. Set XYZ_PI_BIN env to an existing pi executable path\n`
      + `  3. Pre-place binary at ${finalBinaryPath}`,
    )
  } finally {
    // 无论成功失败都清临时下载文件（成功路径已 extract，tmp 不再需要）
    await safeUnlink(tmpArchive)
  }
}

/** 用 global fetch 下载 URL 到文件（流式，自动跟随重定向）。 */
async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText} for ${url}`)
  }
  if (!res.body) {
    throw new Error(`download failed: empty response body for ${url}`)
  }
  const stream = createWriteStream(dest)
  // Web ReadableStream → Node Readable 适配（Node 22+ Readable.fromWeb）
  const nodeStream = Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream<Uint8Array>)
  await pipeline(nodeStream, stream)
}

/** 解压 archive 到 cwd。tar.gz 走 tar 包，zip 走系统 bsdtar/unzip。 */
async function extractArchive(archivePath: string, cwd: string, archive: 'tar.gz' | 'zip'): Promise<void> {
  if (archive === 'tar.gz') {
    await extract({ file: archivePath, cwd })
    return
  }
  // zip：Win10+ 自带 tar.exe（bsdtar 支持 zip），macOS/Linux 用 unzip
  if (process.platform === 'win32') {
    await execFileAsync('tar', ['-xf', archivePath, '-C', cwd], { timeout: EXTRACT_TIMEOUT_MS })
  } else {
    await execFileAsync('unzip', ['-o', archivePath, '-d', cwd], { timeout: EXTRACT_TIMEOUT_MS })
  }
}

/**
 * pi release 包一层 pi/ 目录（mise 兼容），展平：
 *  - 若 <cwd>/pi/pi 或 <cwd>/pi/pi.exe 存在 → 移到 <cwd>/<binaryName>
 *  - release 内的 assets/theme/export-html/package.json/wasm 等资源也展平到 <cwd>/
 *  - 移除空的 pi/ 目录
 *
 * 兼容已扁平化的 release（直接含 pi/pi.exe）：仅 rename。
 */
async function flattenAndRename(cwd: string, binaryName: string): Promise<void> {
  const nestedPiDir = join(cwd, 'pi')
  const dest = join(cwd, binaryName)

  if (existsSync(nestedPiDir)) {
    // 展平资源文件（失败不致命，best-effort）
    const resources = ['assets', 'theme', 'export-html', 'package.json', 'photon_rs_bg.wasm']
    for (const r of resources) {
      const src = join(nestedPiDir, r)
      if (existsSync(src)) {
        try {
          await fs.rename(src, join(cwd, r))
        // eslint-disable-next-line taste/no-silent-catch -- 资源展平失败不致命（pi 可无 theme 运行），best-effort
        } catch {
          // 资源展平失败不致命（pi 可无 theme 运行），best-effort
        }
      }
    }
    // 主二进制
    const nestedBinary = existsSync(join(nestedPiDir, 'pi'))
      ? join(nestedPiDir, 'pi')
      : join(nestedPiDir, 'pi.exe')
    if (existsSync(nestedBinary)) {
      await fs.rename(nestedBinary, dest)
    }
    // 清理空 pi/ 目录（best-effort）
    try {
      await fs.rmdir(nestedPiDir)
    // eslint-disable-next-line taste/no-silent-catch -- pi/ 非空（残留资源）→ 保留，不影响主二进制可用性
    } catch {
      // pi/ 非空（残留资源）→ 保留，不影响主二进制可用性
    }
  } else if (existsSync(join(cwd, 'pi'))) {
    // 已扁平化的 linux/darwin release：直接 rename pi → binaryName
    await fs.rename(join(cwd, 'pi'), dest)
  } else if (existsSync(join(cwd, 'pi.exe')) && binaryName.endsWith('.exe')) {
    // 已扁平化的 windows release
    await fs.rename(join(cwd, 'pi.exe'), dest)
  } else {
    throw new Error(`pi binary not found in archive after extract (expected pi/pi or pi.exe in ${cwd})`)
  }
}

/** 冒烟测试：execFile <path> --version，验返回码 0。 */
async function smokeTest(binaryPath: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ['--version'], {
      timeout: SMOKE_TIMEOUT_MS,
      encoding: 'utf-8',
    })
    // pi --version 应输出版本字符串（非空）；空输出视为异常
    if (!stdout.trim()) {
      throw new Error('pi --version returned empty output')
    }
  } catch (e) {
    throw new Error(`pi smoke test failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 安全 unlink（文件不存在静默成功）。 */
async function safeUnlink(path: string): Promise<void> {
  try {
    await fs.unlink(path)
  // eslint-disable-next-line taste/no-silent-catch -- 文件不存在/不可写 → 静默（清理临时文件 best-effort）
  } catch {
    // 文件不存在 / 不可写 → 静默
  }
}

// 导出 resolveAsset 供测试（不暴露 internal helper 给 server/index.ts）
export { resolveAsset as _resolveAssetForTest }
