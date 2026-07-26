/**
 * Asset 下载器（流式 + sha256 校验）。
 *
 * 对应 slice auto-update-and-install w3：从 GitHub release asset 下载安装包到
 * `<dataDir>/update/`，下载完成后做 sha256（或 size）完整性校验。
 *
 * 职责链：
 *   1. fetch asset.downloadUrl（全局 fetch，与 release-checker 一致；AbortController 60s 超时）
 *   2. 流式写到 `<UPDATE_DIR>/<name>.downloading`（mkdirSync recursive）
 *   3. 下载完成后读文件算 sha256（createHash）
 *   4. asset.sha256 存在则校验，不匹配抛 UpdateIntegrityError
 *   5. asset.sha256 缺失则降级：size 存在校验 size，size 也缺失抛 UpdateIntegrityError
 *      （正常 release 必有 sha256 或非零 size，二者全缺视为可疑，拒绝）
 *   6. rename .downloading 到最终文件名，返回 { filePath }
 *
 * [HISTORICAL] 不变量：
 * - 用全局 fetch（不用 electron.net，与 release-checker 一致，便于测试 mock）
 * - 流式下载：response.body.getReader() 累加 chunk 算进度 + pipe 到 writeStream（避免 100MB 一次进内存）
 * - 超时用 AbortController + setTimeout(60000)：覆盖 fetch + 流式传输全过程
 *   （clearTimeout 在 stream 完成后才执行，保证卡住的字节流也能被 watchdog 中断）
 * - 校验失败必须删除半下载文件，避免下次误用残文件
 * - .downloading 临时后缀：崩溃后残留文件不会伪装成完整安装包
 *
 * 依赖方向：download-asset → constants + types + @xyz-agent/shared + node:crypto/fs/stream
 */
import { createHash } from 'node:crypto'
import { createWriteStream, createReadStream, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { ReleaseAsset } from '@xyz-agent/shared'
import { UPDATE_DIR } from './constants.js'
import { UpdateIntegrityError } from './types.js'

/**
 * 下载超时 watchdog：覆盖 fetch + 流式传输全过程。
 *
 * 5 分钟覆盖慢速网络下的 100MB+ Electron 产物（理论 2Mbps 下需 ~7min，但实际
 * GitHub CDN 通常更快）。若用户网络极慢，超时后清理半下载文件，用户可重试。
 * 旧的 60s 对 100MB+ 产物太短，慢速网络下会误杀正常下载。
 */
const DOWNLOAD_TIMEOUT_MS = 300_000
const PROGRESS_MAX = 100

/**
 * 下载单个 asset 并校验完整性。
 *
 * @param asset 待下载的 release 资产（含 downloadUrl / sha256 / size）
 * @param onProgress 下载进度回调（0-100 百分比）
 * @returns 下载完成后最终文件路径（已通过校验）
 * @throws UpdateIntegrityError sha256/size 校验失败
 */
export async function downloadAsset(
  asset: ReleaseAsset,
  onProgress?: (percent: number) => void,
): Promise<{ filePath: string }> {
  // 1. 准备目录 + 临时文件路径
  mkdirSync(UPDATE_DIR, { recursive: true })
  const tempPath = path.join(UPDATE_DIR, `${asset.name}.downloading`)
  const finalPath = path.join(UPDATE_DIR, asset.name)

  // 2. fetch + 流式传输共用同一个 AbortController 60s 超时 watchdog。
  //    [NOTE] clearTimeout 必须在流式传输真正完成（writeStream finish/close）
  //    或出错后才执行 —— 若像旧实现那样在 fetch resolve 后的 finally 里 clear，
  //    60s 只会约束初始 HTTP 响应；后续流式字节传输（pipe）将无超时，慢速/卡住
  //    连接的大文件可能永远挂住。下方用外层 try/finally 保证 stream 结束才 clear。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(asset.downloadUrl, { signal: controller.signal })
    if (!response.ok) {
      // [LEAK FIX] 抛错前显式 cancel body，释放底层 socket（无引用后 GC 也会清理，
      // 但显式 cancel 更确定，避免连接挂在 keep-alive 池）。
      await response.body?.cancel().catch(() => {})
      throw new UpdateIntegrityError(`download failed: HTTP ${response.status}`)
    }
    if (!response.body) {
      throw new UpdateIntegrityError('download failed: empty response body')
    }

    // 3. 流式写到 .downloading 临时文件，同时累加进度（共用上面的 controller/timer）
    const total = Number(response.headers.get('content-length') ?? 0)
    let downloaded = 0
    const writeStream = createWriteStream(tempPath)
    // response.body 是 web ReadableStream；转 node Readable 以 pipe。
    const nodeStream = Readable.fromWeb(response.body as unknown as import('stream/web').ReadableStream)
    try {
      await new Promise<void>((resolve, reject) => {
        nodeStream.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          // [NOTE] total=0（chunked 传输无 content-length）时不报进度：
          // onProgress 签名是 0-100 百分比，无总量时无法计算百分比；
          // 前端 useAppUpdate 的 state.percent 期望 0-100，传负值会 UI 异常。
          // 设计权衡：chunked 时进度条不动（但下载会完成），优于 UI 异常。
          if (onProgress && total > 0) {
            const percent = Math.min(PROGRESS_MAX, Math.round((downloaded / total) * PROGRESS_MAX))
            onProgress(percent)
          }
        })
        nodeStream.pipe(writeStream)
        writeStream.on('finish', () => resolve())
        writeStream.on('error', reject)
        nodeStream.on('error', reject)
      })
    } catch (err) {
      // [LEAK FIX] destroy writeStream 释放底层 fd，避免错误路径泄漏文件描述符。
      writeStream.destroy()
      // 清理半下载文件
      try { unlinkSync(tempPath) } catch (unlinkErr) { console.warn('[download] stream cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
      throw err
    }
  } finally {
    // 流式传输已结束（成功 finish 或抛错）才停 watchdog。
    clearTimeout(timer)
  }

  // 4. 校验：sha256 优先，缺失降级 size，再缺失拒绝
  //    [BLOCKER 4] 旧实现 `else if (asset.size && asset.size > 0)`：若 size=0 且无 sha256，
  //    完全跳过校验——攻击者可让下载文件被任意篡改而无校验拦截。改为：
  //    sha256 和非零 size 至少有一个，否则拒绝（正常 release 必有其一）。
  if (asset.sha256) {
    const actualSha = await hashFileSha256(tempPath)
    if (actualSha !== asset.sha256.toLowerCase()) {
      try { unlinkSync(tempPath) } catch (unlinkErr) { console.warn('[download] sha256 mismatch cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
      throw new UpdateIntegrityError(
        `sha256 mismatch: expected ${asset.sha256}, got ${actualSha}`,
      )
    }
  } else if (asset.size && asset.size > 0) {
    const actualSize = statSync(tempPath).size
    if (actualSize !== asset.size) {
      try { unlinkSync(tempPath) } catch (unlinkErr) { console.warn('[download] size mismatch cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
      throw new UpdateIntegrityError(
        `size mismatch: expected ${asset.size}, got ${actualSize}`,
      )
    }
  } else {
    // sha256 和有效 size 都缺失：拒绝（不应出现于正常 release）
    try { unlinkSync(tempPath) } catch (unlinkErr) { console.warn('[download] no integrity cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
    throw new UpdateIntegrityError(
      `no integrity check available (sha256 and size both missing) for ${asset.name}`,
    )
  }

  // 5. rename .downloading → 最终文件名
  renameSync(tempPath, finalPath)
  return { filePath: finalPath }
}

/**
 * 异步计算文件 sha256 hex（流式，避免 100MB 文件一次性进内存）。
 */
export async function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}
