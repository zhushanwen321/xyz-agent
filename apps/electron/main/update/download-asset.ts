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
 * 依赖方向：download-asset → constants + types + hash + @xyz-agent/shared + node:fs/stream
 *   （hash 为无网络依赖的纯函数叶子模块，见 hash.ts / review S#13）
 */
import { createWriteStream, createReadStream, mkdirSync, renameSync, statSync, unlinkSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ProxyAgent } from 'undici'
import type { ReleaseAsset, IProxyConfig } from '@xyz-agent/shared'
import { UPDATE_DIR } from './constants.js'
import { hashFileSha256 } from './hash.js'
import { resolveProxyUrl } from './proxy-config.js'
import { UpdateError, UpdateIntegrityError } from './types.js'
import { classifyNetError, getNodeErrnoCode } from './net-errors.js'

/**
 * 断点续传状态接口。
 * 记录下载进度和文件路径，支持从断点继续下载。
 */
interface IResumeState {
  /** 已下载的字节数 */
  downloadedBytes: number
  /** 总字节数 */
  totalBytes: number
  /** 临时文件路径 */
  tempPath: string
  /** 最终文件路径 */
  finalPath: string
}

/**
 * 断点续传状态文件路径。
 */
const RESUME_STATE_FILE = path.join(UPDATE_DIR, 'resume-state.json')

/**
 * 下载总超时 watchdog：覆盖 fetch + 流式传输全过程（兜底上限）。
 *
 * 1 小时（3600s）覆盖慢速网络下的 170MB+ Electron 产物。
 * 国内网络环境下，下载 GitHub CDN 的大文件可能需要 10-20 分钟，
 * 1小时超时留足余量，避免误杀正常下载。
 *
 * 仅靠总超时不足以应对国内网络典型故障（连接建立后中途停滞）——
 * 那种场景下流仍在「等字节」但实际已挂死，要等满 1 小时。
 * 配合 IDLE_TIMEOUT_MS 做空闲检测：长时间无新数据即主动中断。
 */
const DOWNLOAD_TIMEOUT_MS = 3_600_000

/**
 * 空闲超时：流式传输过程中连续 N ms 没有收到新数据字节即中断。
 *
 * 国内网络典型故障是「连接建立后中途停滞」，仅靠总超时要等满 1 小时
 * 等同挂死。30s 无新数据基本可判定连接已无效，主动 abort 后上层
 * 可走断点续传重连，远比挂死 1 小时体验好。
 */
const IDLE_TIMEOUT_MS = 30_000

/**
 * 把 fetch 返回的 web ReadableStream 适配成 Node stream/web 的 ReadableStream 类型，
 * 供 `Readable.fromWeb` 消费。
 *
 * [S#4 / type-safety] 这是 Node Web Stream 互操作的公认 TS 缺陷：
 * fetch `response.body` 是 lib.dom 的 `ReadableStream<Uint8Array>`，与 `node:stream/web`
 * 的 `ReadableStream` 结构性不兼容（同构但分别声明），TS 拒绝直接赋值。
 * 运行时两者是同一个对象（Node 用 undici 实现 fetch，返回的就是 web ReadableStream）。
 * 把 `as unknown as T` 双重断言集中收敛到这唯一一处封装函数，其余调用点不再散落断言。
 */
function toNodeReadableWebStream(
  body: ReadableStream<Uint8Array> | null,
): import('stream/web').ReadableStream<Uint8Array> {
  return body as unknown as import('stream/web').ReadableStream<Uint8Array>
}

/**
 * 返回 temp 文件当前真实落盘字节数；读取失败时回退到内存计数器。
 *
 * pipe 写盘是缓冲异步的，内存计数器可能比真实文件偏大或偏小。
 * 续传必须用真实落盘字节，否则 Range 起点会越过已写内容造成重叠/空洞。
 */
function getPersistedBytes(tempPath: string, fallback: number): number {
  try {
    return statSync(tempPath).size
  } catch (err) {
    console.warn('[download] stat temp for resume failed:', err)
    return fallback
  }
}

/** ms → s 换算因子（用于错误消息里的超时秒数展示）。 */
const MS_PER_SECOND = 1000

/** HTTP 206 Partial Content：服务器接受 Range 请求、返回断点续传数据。 */
const HTTP_PARTIAL_CONTENT = 206

/**
 * 断点续传状态保存阈值：每超过上次保存点 N 字节才落盘一次。
 *
 * 替代旧的 `downloaded % 1MB === 0` 整除判断——后者在续传场景
 * （downloaded 从非 1MB 整数倍起步）几乎永远不再命中，导致中途崩溃
 * state 仍是旧值。改用阈值比较保证进度稳步落盘且不过频写文件。
 */
// eslint-disable-next-line no-magic-numbers -- 1MB 的字节数，语义即常量名
const SAVE_INTERVAL_BYTES = 1024 * 1024

/**
 * totalBytes 一致性校验容差：续传时新请求拿到的 content-length 与
 * 记录的 totalBytes 差异超此阈值，视为 release 文件已变更（残文件过期），
 * 作废重下。允许小容差以容忍 CDN 行为差异。
 */
const TOTAL_BYTES_TOLERANCE = 1024

const PROGRESS_MAX = 100

/** 下载请求 User-Agent：与 release-checker 保持一致，避免部分 CDN 因空 UA 限速/拒绝。 */
const DOWNLOAD_USER_AGENT = 'xyz-agent-updater'

/**
 * 多段并行下载：把单条 TCP 连接拆成 N 条并发 Range 请求，绕过部分代理/出口对
 * 单条 HTTP/1.1 连接的限速。GitHub release asset 位于 Azure Blob，支持
 * accept-ranges: bytes，具备拆分条件。
 */
const MULTI_PART_COUNT = 4

/** 只有文件大于此阈值才启用多段（小文件拆分收益低、连接开销占比大）。 */
const MIN_MULTI_PART_SIZE = 10 * 1024 * 1024

/** 每段至少 2MB，防止段数过多。 */
const MIN_BYTES_PER_PART = 2 * 1024 * 1024

/** 进度回调节流间隔：同一段下载内最多每 N ms 推一次进度，降低 IPC 压力。 */
const PROGRESS_THROTTLE_MS = 200

/**
 * 下载单个 asset 并校验完整性。
 *
 * @param asset 待下载的 release 资产（含 downloadUrl / sha256 / size）
 * @param onProgress 下载进度回调（0-100 百分比）
 * @param proxyConfig 代理配置（可选，不传则禁用代理）
 * @returns 下载完成后最终文件路径（已通过校验）
 * @throws UpdateIntegrityError sha256/size 校验失败
 */
export async function downloadAsset(
  asset: ReleaseAsset,
  onProgress?: (percent: number) => void,
  proxyConfig?: IProxyConfig,
): Promise<{ filePath: string }> {
  // 1. 准备目录 + 临时文件路径
  mkdirSync(UPDATE_DIR, { recursive: true })
  const tempPath = path.join(UPDATE_DIR, `${asset.name}.downloading`)
  const finalPath = path.join(UPDATE_DIR, asset.name)

  // 2. 检查是否有断点续传状态
  const resumeState = loadResumeState()
  let downloadedBytes = 0
  if (resumeState && resumeState.tempPath === tempPath && resumeState.finalPath === finalPath) {
    // 有断点续传状态，检查临时文件是否存在
    if (existsSync(tempPath)) {
      const stat = statSync(tempPath)
      // [B-4] 续传判定放宽为「temp 落盘字节 <= state 记录值」即从 stat.size 续传。
      // 旧实现严格相等会在崩溃时刻不巧时误判 mismatch 重下：
      //   - 正常进度保存用内存 downloaded 计数器（偏大，pipe 未完全 flush）
      //   - 可恢复错误保存用 statSync 真实字节（偏小）
      // 两种口径不一致 → stat.size 与 state.downloadedBytes 经常差几 KB → 重下丢数据。
      // 现在统一：只要 temp 不大于 state，就以更准确的 stat.size 为续传起点。
      // 只有 temp 异常大于 state（残文件被外部追加等）才作废重下。
      if (stat.size <= resumeState.downloadedBytes) {
        downloadedBytes = stat.size
        console.log(`[download] resuming from ${downloadedBytes} bytes (state ${resumeState.downloadedBytes})`)
      } else {
        // temp 比 state 记录的大很多，异常 → 重新下载
        console.log(`[download] resume state mismatch (temp ${stat.size} > state ${resumeState.downloadedBytes}), restarting download`)
        clearResumeState()
      }
    } else {
      // 临时文件不存在，重新下载
      console.log(`[download] temp file not found, restarting download`)
      clearResumeState()
    }
  }

  // 3. 决定单段 or 多段并行下载：
  //    - 无续传状态、文件较大、远端支持 accept-ranges: bytes 时启用多段并行。
  //    - 多段绕过单条 HTTP/1.1 连接被代理/出口限速的问题，类似 Chrome 多连接。
  let useMultiPart = false
  // [S#1 / business-logic] 多段启用阈值用 release 声明的 asset.size，而非 probe 返回的
  // 真实 totalBytes：此判定在 probe 之前，目的是先过滤掉小文件，避免对每个小文件都发一次
  // HEAD probe（额外 RTT）。即使 release 声明 size 被误填偏小，导致大文件误走单段下载，
  // probe 仍会兜底判 supported=false；多段只是加速优化，单段下载本身完全正确，无正确性风险。
  if (!resumeState && asset.size && asset.size >= MIN_MULTI_PART_SIZE) {
    const { supported, totalBytes } = await probeMultiPartSupport(asset, proxyConfig)
    if (supported) {
      const multiResult = await downloadMultiPart(asset, totalBytes, onProgress, proxyConfig)
      // [RM3] 服务器/代理不遵守 Range（任一段非 206 或段长不符）→ 整批放弃多段：
      // 不设 useMultiPart，落入下方单段路径完整下载。此时 downloadedBytes=0（进多段
      // 的前提就是无续传状态），单段全新请求不带 Range 头，既有 206/200 分类天然
      // 兼容「忽略 Range 回 200」的服务器，sha256 校验兜底产物正确性。
      useMultiPart = !multiResult.degradedToSingle
    }
  }

  // 4. 单段下载（续传或 Probe 未通过时走此路径）。
  //    fetch + 流式传输共用同一个 AbortController，配两个 watchdog：
  //    - timer: 总超时 DOWNLOAD_TIMEOUT_MS（兜底上限，3600s）
  //    - idleTimer: 空闲超时 IDLE_TIMEOUT_MS（30s 无新数据字节即中断）
  //    [NOTE] clearTimeout 必须在流式传输真正完成（writeStream finish/close）
  //    或出错后才执行 —— 若像旧实现那样在 fetch resolve 后的 finally 里 clear，
  //    60s 只会约束初始 HTTP 响应；后续流式字节传输（pipe）将无超时，慢速/卡住
  //    连接的大文件可能永远挂住。下方用外层 try/finally 保证 stream 结束才 clear。
  if (!useMultiPart) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  let response: Response
  // dispatcher 声明在外层，确保外层 finally 能访问到做 close（连接池清理）。
  let dispatcher: ProxyAgent | undefined
  try {
    // 构建 fetch 选项：User-Agent + 代理 + 断点续传 Range 头。
    const rangeHeaders = downloadedBytes > 0
      ? { Range: `bytes=${downloadedBytes}-` }
      : undefined
    const fetchOptions = buildFetchOptions(proxyConfig, controller.signal, rangeHeaders)
    dispatcher = fetchOptions.dispatcher

    // 执行 fetch（dispatcher 存在时真正走代理），捕获网络错误并分类
    try {
      response = await fetch(asset.downloadUrl, fetchOptions as RequestInit)
    } catch (fetchErr) {
      // D1: 使用统一的分类函数替代内联字符串匹配（收敛三条 fetch 路径）
      const proxyUrl = proxyConfig ? resolveProxyUrl(proxyConfig) : undefined
      throw classifyNetError(fetchErr, 'downloading', proxyUrl)
    }
    if (!response.ok) {
      // [LEAK FIX] 抛错前显式 cancel body，释放底层 socket（无引用后 GC 也会清理，
      // 但显式 cancel 更确定，避免连接挂在 keep-alive 池）。
      await response.body?.cancel().catch(() => {})
      throw new UpdateError(`download failed: HTTP ${response.status}`, 'downloading', 'UPDATE_NETWORK_FAILED')
    }
    if (!response.body) {
      throw new UpdateError('download failed: empty response body', 'downloading', 'UPDATE_NETWORK_FAILED')
    }

    // 4. 流式写到 .downloading 临时文件，同时累加进度（共用上面的 controller/timer）
    //
    // [C3] Range 续传响应分类：发了 Range: bytes=N- 后必须区分
    //   - 206 Partial Content：续传成功，content-length 是剩余部分大小，
    //     total = content-length + downloadedBytes，writeStream 用追加模式 'a'。
    //   - 200 OK：服务器/CDN 忽略 Range（整文件回源）。若仍按续传处理，
    //     content-length 是整个文件大小，total 会多算 downloadedBytes；
    //     且 writeStream 追加模式会把完整内容拼到残文件后 → 文件损坏。
    //     因此回退到完整下载：重置 downloadedBytes=0，total 用 content-length，
    //     writeStream 用覆盖模式 'w'。
    const requestedRange = downloadedBytes > 0
    const resumeAccepted = requestedRange && response.status === HTTP_PARTIAL_CONTENT
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    // 续传成功用追加模式 + 累加 total；否则覆盖写（200 回退或全新下载）
    const writeFlags: 'a' | 'w' = resumeAccepted ? 'a' : 'w'
    const total = resumeAccepted ? contentLength + downloadedBytes : contentLength

    // [m5] totalBytes 一致性校验：续传成功（206）时，对比新算出的 total 与
    // 上次记录的 totalBytes。差异超容差说明 release 文件已变更（残文件过期），
    // 作废重下，避免把不同版本的内容拼接到一起。注意只在 resumeAccepted
    // 分支校验——200 回退场景 total 计算方式本就不同，不参与此校验。
    if (resumeAccepted && resumeState && Math.abs(total - resumeState.totalBytes) > TOTAL_BYTES_TOLERANCE) {
      console.log(`[download] total bytes changed (expected ${resumeState.totalBytes}, got ${total}), restarting`)
      await response.body?.cancel().catch(() => {})
      // 残文件过期：清理后递归重下（从头开始）
      try { unlinkSync(tempPath) } catch (e) { console.warn('[download] stale temp cleanup failed:', e) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
      clearResumeState()
      return downloadAsset(asset, onProgress, proxyConfig)
    }

    // 续传起点（206 = downloadedBytes；200 回退/全新 = 0）
    let downloaded = resumeAccepted ? downloadedBytes : 0
    // 如果是断点续传（206），使用追加模式打开文件；否则覆盖写
    const writeStream = createWriteStream(tempPath, { flags: writeFlags })
    // response.body 是 web ReadableStream；转 node Readable 以 pipe。
    const nodeStream = Readable.fromWeb(toNodeReadableWebStream(response.body))
    // [M1] idle timeout：长时间无新数据字节即中断。每次收到 chunk 重置。
    let idleTimer: NodeJS.Timeout | undefined = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
    // [M3] 记录上次保存进度（续传起点），超过 SAVE_INTERVAL_BYTES 才落盘（替代整除判断）
    let lastSavedBytes = downloaded
    // 进度回调节流：每段下载内按百分比变化 + 时间间隔推，降低 IPC 压力。
    const reportProgress = createThrottledProgress(onProgress, total)
    const clearTimers = () => {
      clearTimeout(timer)
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
    }
    try {
      await new Promise<void>((resolve, reject) => {
        nodeStream.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          // [M1] 收到新数据重置 idle timer（只要有字节流动就不算挂死）
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
          // [NOTE] total=0（chunked 传输无 content-length）时不报进度：
          // onProgress 签名是 0-100 百分比，无总量时无法计算百分比；
          // 前端 useAppUpdate 的 state.percent 期望 0-100，传负值会 UI 异常。
          // 设计权衡：chunked 时进度条不动（但下载会完成），优于 UI 异常。
          if (total > 0) {
            reportProgress(downloaded)
          }
          // [M3] 保存断点续传状态：每超过上次保存点 SAVE_INTERVAL_BYTES 字节才落盘。
          // 旧实现 `downloaded % 1MB === 0` 在续传场景（起点非 1MB 整数倍）几乎
          // 永不命中，中途崩溃 state 仍是旧值。
          // [B-4] 统一保存口径：这里也用真实落盘字节（statSync）而非内存 downloaded 计数器。
          // 原先进度保存用 downloaded（偏大，pipe 未完全 flush）、可恢复错误保存用
          // statSync（偏小）→ 两口径不一致 → 续传判定 mismatch 重下。现在两处统一，
          // 配合放宽的续传判定（stat.size <= state）形成正确续传闭环。
          if (downloaded - lastSavedBytes >= SAVE_INTERVAL_BYTES) {
            const persisted = getPersistedBytes(tempPath, downloaded)
            saveResumeState({
              downloadedBytes: persisted,
              totalBytes: total,
              tempPath,
              finalPath,
            })
            lastSavedBytes = persisted
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
      // 超时判定（用于错误分类：UPDATE_NETWORK_TIMEOUT vs 其他），不影响是否保留 temp。
      const isTimeout = err instanceof Error && (
        err.name === 'AbortError' ||
        err.message.includes('aborted') ||
        err.message.includes('timeout')
      )
      // [W-6] 磁盘错误判定：优先用 Node errno code（ENOSPC）精确匹配，
      // 子串 'disk space' 仅作非英文 OS message 的 fallback。
      const errno = getNodeErrnoCode(err)
      const isDiskError = errno === 'ENOSPC' ||
        (err instanceof Error && err.message.toLowerCase().includes('disk space'))

      // [B-2] 默认 Error 视为可恢复——保留 temp + state 让下次续传。
      // 旧实现用白名单子串匹配（ECONNRESET/ETIMEDOUT + NETWORK_* code）判 isRecoverable，
      // 但国内网络常见错误不命中：undici 流中断 UND_ERR_SOCKET/UND_ERR_BODY_TIMEOUT
      // （message 形如 'other side closed'）、代理中途 407/TLS 错误经流 reject，
      // message 都不含上述子串 → 走 else 删 temp。这恰恰在最需要续传的「流中途断开」
      // 场景丢数据，违背 PR 核心目标。
      // 现在反转默认值：只有明确命中 isDiskError 才删 temp；其余一律保留。
      // sha256 mismatch 不受影响（它在校验段单独删 temp，不进 stream catch）。
      if (!isDiskError) {
        // 保留 temp + 用真实落盘字节存 state，下次可续传。
        const persistedBytes = getPersistedBytes(tempPath, downloaded)
        saveResumeState({
          downloadedBytes: persistedBytes,
          totalBytes: total,
          tempPath,
          finalPath,
        })
        console.log(`[download] recoverable error, kept temp file for resume (${persistedBytes} bytes)`)
      } else {
        // 磁盘空间不足：删 temp + 清 state（无法续传）。
        // [W-5] 此路径不再 saveResumeState——马上就 clear 了，save 纯属浪费。
        try { unlinkSync(tempPath) } catch (unlinkErr) { console.warn('[download] stream cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
        clearResumeState()
      }
      // 流式传输错误分类（throw 什么 errorCode）；与是否保留 temp 无关。
      if (isDiskError) {
        throw new UpdateError(
          'insufficient disk space',
          'downloading',
          'UPDATE_DISK_SPACE',
        )
      }
      // 超时（含 idle/total abort）：映射为 UPDATE_NETWORK_TIMEOUT
      if (isTimeout) {
        throw new UpdateError(
          `download timeout (idle ${IDLE_TIMEOUT_MS / MS_PER_SECOND}s or total ${DOWNLOAD_TIMEOUT_MS / MS_PER_SECOND}s)`,
          'downloading',
          'UPDATE_NETWORK_TIMEOUT',
        )
      }
      // 如果已经是 UpdateError（来自上面的网络错误分类），直接抛出
      if (err instanceof UpdateError) {
        throw err
      }
      throw new UpdateError(
        `download stream error: ${err instanceof Error ? err.message : String(err)}`,
        'downloading',
        'UPDATE_NETWORK_FAILED',
      )
    } finally {
      // [M1] 流式传输已结束（成功 finish 或抛错）才停两个 watchdog。
      clearTimers()
    }

    // 5. 下载完成，清除断点续传状态
    clearResumeState()

  } finally {
    // 外层兜底：fetch 阶段异常也确保 total timer 被清理。
    clearTimeout(timer)
    // ProxyAgent 持有连接池，下载结束（成功/失败）后显式关闭避免句柄泄漏。
    if (dispatcher) {
      await dispatcher.close().catch(() => {}) // best-effort 连接池清理，失败不影响下载结果
    }
  }
  }

  // 6. 校验：sha256 优先，缺失降级 size，再缺失拒绝
  //    [BLOCKER 4] 旧实现 `else if (asset.size && asset.size > 0)`：若 size=0 且无 sha256，
  //    完全跳过校验——攻击者可让下载文件被任意篡改而无校验拦截。改为：
  //    sha256 和非零 size 至少有一个，否则拒绝（正常 release 必有其一）。
  if (asset.sha256) {
    const actualSha = await hashFileSha256(tempPath)
    if (actualSha !== asset.sha256.toLowerCase()) {
      try { unlinkSync(tempPath) } catch (unlinkErr) { console.warn('[download] sha256 mismatch cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
      throw new UpdateIntegrityError(
        `sha256 mismatch: expected ${asset.sha256}, got ${actualSha}`,
        'UPDATE_SHA256_MISMATCH',
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

  // 7. rename .downloading → 最终文件名
  try {
    renameSync(tempPath, finalPath)
  } catch (renameErr) {
    // 权限错误分类。[W-6] 优先用 errno code（EACCES/EPERM）精确匹配，
    // 子串 'permission' 仅作非英文 OS message 的 fallback。
    const renameErrno = getNodeErrnoCode(renameErr)
    if (renameErrno === 'EACCES' || renameErrno === 'EPERM' ||
        (renameErr instanceof Error && renameErr.message.toLowerCase().includes('permission'))) {
      throw new UpdateError(
        'permission denied during file replacement',
        'replacing',
        'UPDATE_PERMISSION_DENIED',
      )
    }
    // [m9] 归一化落定失败此前复用 UPDATE_INTEGRITY_FAILED（「安装包完整性校验失败」），
    // 语义错配：完整性没问题，是文件系统把 .downloading 改名到终态时失败（跨卷 / 占用 /
    // 只读等）。改用独立错误码，前端文案才可能对症（见 types.ts UPDATE_ERROR_MESSAGES）。
    throw new UpdateError(
      `file rename failed: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
      'replacing',
      'UPDATE_FILE_RENAME_FAILED',
    )
  }
  return { filePath: finalPath }
}

/**
 * 构造 fetch 选项（User-Agent + 代理 + signal + 可选 Range 头）。
 * 与 release-checker 保持一致的 User-Agent，避免部分 CDN 因空 UA 拒绝/限速。
 */
function buildFetchOptions(
  proxyConfig: IProxyConfig | undefined,
  signal: AbortSignal,
  extraHeaders?: Record<string, string>,
): RequestInit & { dispatcher?: ProxyAgent } {
  const headers: Record<string, string> = {
    'User-Agent': DOWNLOAD_USER_AGENT,
    ...extraHeaders,
  }
  const options: RequestInit & { dispatcher?: ProxyAgent } = { signal, headers }
  const proxyUrl = proxyConfig ? resolveProxyUrl(proxyConfig) : undefined
  if (proxyUrl) {
    try {
      options.dispatcher = new ProxyAgent(proxyUrl)
    } catch (err) {
      console.warn('[download] proxy agent init failed, fallback to direct:', err)
    }
  }
  return options
}

/**
 * 探测目标是否支持多段并行下载（HEAD 请求检查 accept-ranges + content-length）。
 *
 * @returns supported=true 表示支持 Range 且 totalBytes 已知；否则返回 false
 */
async function probeMultiPartSupport(
  asset: ReleaseAsset,
  proxyConfig: IProxyConfig | undefined,
): Promise<{ supported: boolean; totalBytes: number }> {
  let dispatcher: ProxyAgent | undefined
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    const options = buildFetchOptions(proxyConfig, controller.signal)
    dispatcher = options.dispatcher
    const response = await fetch(asset.downloadUrl, { ...options, method: 'HEAD' })
    clearTimeout(timer)
    const acceptRanges = response.headers.get('accept-ranges') ?? ''
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    // 无论是否支持都释放 body
    await response.body?.cancel().catch(() => {})
    const supported = response.ok &&
      acceptRanges.includes('bytes') &&
      contentLength > 0 &&
      contentLength >= MIN_MULTI_PART_SIZE
    return { supported, totalBytes: contentLength }
  } catch (err) {
    console.warn('[download] multipart probe failed:', err)
    return { supported: false, totalBytes: 0 }
  } finally {
    if (dispatcher) {
      await dispatcher.close().catch(() => {})
    }
  }
}

/** 多段下载的单个段描述。 */
interface IPartSpec {
  index: number
  start: number
  end: number
  tempPath: string
}

/**
 * [RM3] 服务器未遵守 Range 协议的内部信号：多段请求收到非 206 响应（典型：
 * 服务器/代理忽略 Range 回 200 全量），或响应内容长度与请求段不符。
 *
 * 定位是内部控制流信号而非用户可见错误——捕获方 downloadMultiPart 据此整批
 * 放弃多段、降级单段完整下载（单段路径已有正确的 206/200 分类），绝不把错位
 * 的段内容合并成损坏文件。刻意不继承 UpdateError：面向用户的网络错误分类
 * （classifyNetError）不应对降级信号生效。
 */
class RangeNotRespectedError extends Error {
  constructor(partIndex: number, reason: string) {
    super(`part ${partIndex}: server did not honor Range request (${reason})`)
    this.name = 'RangeNotRespectedError'
  }
}

/** 创建带节流的进度回调（降低 IPC/渲染进程压力）。 */
function createThrottledProgress(
  onProgress: ((percent: number) => void) | undefined,
  totalBytes: number,
): (downloadedBytes: number) => void {
  if (!onProgress || totalBytes <= 0) return () => {}
  let lastPercent = -1
  let lastTime = 0
  return (downloadedBytes: number) => {
    const percent = Math.min(PROGRESS_MAX, Math.round((downloadedBytes / totalBytes) * PROGRESS_MAX))
    const now = Date.now()
    if (percent !== lastPercent && (now - lastTime >= PROGRESS_THROTTLE_MS || percent === PROGRESS_MAX)) {
      lastPercent = percent
      lastTime = now
      onProgress(percent)
    }
  }
}

/**
 * 下载一个段（Range: bytes=start-end）到临时文件。
 *
 * @param asset 下载目标
 * @param part 段描述
 * @param proxyConfig 代理配置
 * @param onProgress 段内进度（实际只更新总进度，这里传 no-op 或段内计数）
 * @returns 下载字节数
 */
async function downloadPart(
  asset: ReleaseAsset,
  part: IPartSpec,
  proxyConfig: IProxyConfig | undefined,
  onProgress: (bytes: number) => void,
): Promise<number> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  let idleTimer: NodeJS.Timeout | undefined = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
  let dispatcher: ProxyAgent | undefined
  let writeStream: ReturnType<typeof createWriteStream> | undefined
  try {
    const options = buildFetchOptions(proxyConfig, controller.signal, {
      Range: `bytes=${part.start}-${part.end}`,
    })
    dispatcher = options.dispatcher
    const response = await fetch(asset.downloadUrl, options)
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new UpdateError(`part ${part.index} download failed: HTTP ${response.status}`, 'downloading', 'UPDATE_NETWORK_FAILED')
    }
    // [RM3] 旧实现只查 response.ok，200 全量也算 ok——服务器忽略 Range 时四段各下
    // 全量，合并出 4 倍损坏文件后卡 sha 失败重试死循环。必须是 206，status 检查放
    // 最前：200 场景 body 是整文件，立即 cancel 切断，避免 4 段并发白耗整文件流量。
    // 段长校验由流结束后的实下字节数兜底（见下方 finish 回调），覆盖 chunked 等
    // 无 content-length 场景。任一失守抛 RangeNotRespectedError，downloadMultiPart
    // 据此整批放弃降级单段。
    if (response.status !== HTTP_PARTIAL_CONTENT) {
      await response.body?.cancel().catch(() => {})
      throw new RangeNotRespectedError(part.index, `HTTP ${response.status}, expected 206 Partial Content`)
    }
    const expectedPartLength = part.end - part.start + 1
    const nodeStream = Readable.fromWeb(toNodeReadableWebStream(response.body))
    writeStream = createWriteStream(part.tempPath, { flags: 'w' })
    let downloaded = 0
    return await new Promise<number>((resolve, reject) => {
      nodeStream.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        if (idleTimer) {
          clearTimeout(idleTimer)
        }
        idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
        onProgress(downloaded)
      })
      nodeStream.pipe(writeStream!)
      writeStream!.on('finish', () => {
        // [RM3] 段长兜底校验：206 但 body 被中途截短/错位（代理返回错误区间等）
        // 同样视为未遵守 Range，拒绝进入合并。
        if (downloaded !== expectedPartLength) {
          reject(new RangeNotRespectedError(part.index, `downloaded ${downloaded} bytes != part length ${expectedPartLength}`))
          return
        }
        resolve(downloaded)
      })
      writeStream!.on('error', reject)
      nodeStream.on('error', reject)
    })
  } catch (err) {
    writeStream?.destroy()
    // [MUST-FIX #4] 失败时 best-effort 删除本段已写的 part 临时文件，保证单段失败自清理。
    // 旧实现只 destroy writeStream，清理完全依赖 downloadMultiPart 的 catch（Promise.all 层），
    // 但若本段 reject 先于其他段完成，其他段的 .part-i 可能正被并发写，downloadMultiPart
    // 的 unlinkSync 与并发 write 竞争会抛 EBUSY/EPERM 吞掉原始错误。这里每段清理自己的
    // part 文件（try/catch 容错，文件不存在或被占用都不影响抛出原始 err）。
    try { unlinkSync(part.tempPath) } catch (unlinkErr) { console.warn(`[download] part ${part.index} temp cleanup failed:`, unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
    // [B4] 已构造的 UpdateError 原样直通，不再进 classifyNetError 兜底分支：
    // 上面 HTTP 非 200 抛的 `part N download failed: HTTP xxx` 若被重新分类，
    // 会二次包装成「download failed: part N ...」双重前缀（探针已实证）。
    // 已构造错误原样直通，不再进 classifyNetError 兜底分支：
    //   - [RM3] RangeNotRespectedError 是内部降级信号而非网络故障，被二次包装后
    //     downloadMultiPart 将无法识别降级条件（误报成网络错误而非降级）。
    //   - [B4] UpdateError 直通：`part N download failed: HTTP xxx` 被重新分类会
    //     产生「download failed: part N ...」双重前缀（探针已实证）。
    // 放在清理之后是刻意的——destroy/unlink 对所有错误类型都必须执行，
    // 不能提前 return 跳过。
    if (err instanceof RangeNotRespectedError || err instanceof UpdateError) {
      throw err
    }
    // D1: 对 downloadPart 的网络错误做统一分类（覆盖断点 1b：多段路径原无分类）
    const proxyUrl = proxyConfig ? resolveProxyUrl(proxyConfig) : undefined
    throw classifyNetError(err, 'downloading', proxyUrl)
  } finally {
    clearTimeout(timer)
    if (idleTimer) clearTimeout(idleTimer)
    if (dispatcher) await dispatcher.close().catch(() => {})
  }
}

/**
 * 多段并行下载完整 asset。
 *
 * 1. 把 totalBytes 拆成 N 段（每段至少 MIN_BYTES_PER_PART）
 * 2. 每段独立 Range 请求 + 独立 ProxyAgent 连接，并发下载到各自 temp 文件
 * 3. 全部完成后按顺序合并到 .downloading 文件
 * 4. 删除段临时文件
 * 5. [RM3] 任一段检测到服务器未遵守 Range（非 206 / 段长不符）→ 清理全部段文件，
 *    返回 degradedToSingle=true，由调用方降级单段完整下载，绝不合并错位内容。
 *
 * [MUST-FIX #4 / timeout 语义说明] downloadPart 每段独立用 DOWNLOAD_TIMEOUT_MS（3600s 总）
 * + IDLE_TIMEOUT_MS（30s 空闲）。这是多段下载的固有特性：某段 Range 落到 CDN 缓存未命中的
 * 字节区，单段 30s idle 中断即触发整批 Promise.all reject。这与单段下载「同一区域只中断一次
 * 可续传」语义不同。不放宽 timeout（30s idle 是国内网络挂死检测的合理阈值，放宽会退化为挂死），
 * 阈值调整（10MB→更大）超出 must-fix 范围。确定性风险已通过 downloadPart 失败自清 part 文件
 * （见 downloadPart catch）收敛。
 */
async function downloadMultiPart(
  asset: ReleaseAsset,
  totalBytes: number,
  onProgress?: (percent: number) => void,
  proxyConfig?: IProxyConfig,
): Promise<{ tempPath: string; degradedToSingle?: boolean }> {
  const maxParts = Math.max(1, Math.min(MULTI_PART_COUNT, Math.floor(totalBytes / MIN_BYTES_PER_PART)))
  const partSize = Math.floor(totalBytes / maxParts)
  const parts: IPartSpec[] = []
  const tempPath = path.join(UPDATE_DIR, `${asset.name}.downloading`)
  mkdirSync(UPDATE_DIR, { recursive: true })
  // [MUST-FIX #2] multipart 路径全程不写 resume-state（各段独立写 .part-N，无单一进度可记）。
  // 若上次单段下载残留了 resume-state（state.downloadedBytes 可能远大于本次合并进度），
  // 本次 multipart 失败后下次启动会被误判为「单段续传起点」拼接到损坏的合并片段上。
  // 因此进入 multipart 前先清旧 state，保证此路径不被跨次残留干扰。
  clearResumeState()
  for (let i = 0; i < maxParts; i++) {
    const start = i * partSize
    const end = (i === maxParts - 1) ? totalBytes - 1 : (i + 1) * partSize - 1
    parts.push({
      index: i,
      start,
      end,
      tempPath: `${tempPath}.part-${i}`,
    })
  }
  const progress = createThrottledProgress(onProgress, totalBytes)
  const downloadedPerPart = new Array(maxParts).fill(0)
  const updateProgress = () => {
    const total = downloadedPerPart.reduce((a, b) => a + b, 0)
    progress(total)
  }
  const abortController = new AbortController()
  const partPromises = parts.map(async (part) => {
    try {
      const bytes = await downloadPart(asset, part, proxyConfig, (bytes) => {
        downloadedPerPart[part.index] = bytes
        updateProgress()
      })
      downloadedPerPart[part.index] = bytes
      updateProgress()
      return part
    } catch (err) {
      abortController.abort()
      throw err
    }
  })
  // [RM3] 用 allSettled 收集全部段结果而非 Promise.all：段失败会 abort 其他段，
  // 其他段的 AbortError 与 Range 违约信号谁先入队是竞态——Promise.all 只暴露第一个
  // rejection，可能把「应降级」误判为网络失败。全部收集后统一判定才符合
  // 「任一段违约 → 整批放弃多段」的语义。
  const rejected = (await Promise.allSettled(partPromises)).filter(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  )
  if (rejected.length > 0) {
    // 清理段临时文件
    for (const part of parts) {
      try { unlinkSync(part.tempPath) } catch (unlinkErr) { console.warn('[download] part cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
    }
    // 任一段 Range 违约 → 整批放弃多段，降级单段完整下载；否则抛第一个真实错误
    if (rejected.some((r) => r.reason instanceof RangeNotRespectedError)) {
      console.log('[download] server did not honor Range requests, abandon multipart and fall back to single-stream download')
      return { tempPath, degradedToSingle: true }
    }
    throw rejected[0]?.reason
  }
  // 合并段文件到 .downloading
  const writeStream = createWriteStream(tempPath, { flags: 'w' })
  try {
    for (const part of parts) {
      await pipeline(createReadStream(part.tempPath), writeStream, { end: false })
    }
    writeStream.end()
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve)
      writeStream.on('error', reject)
    })
  } catch (err) {
    writeStream.destroy()
    // [MUST-FIX #2] 合并失败：除段临时文件外，半写入的合并产物 .downloading 也必须清理。
    // 旧的 finally 只清 .part-N，留下损坏的 .downloading；若此时 resume-state 又被
    // 上一次单段下载残留填充，下次启动会误把它当续传起点拼接，造成不可恢复的损坏。
    try { unlinkSync(tempPath) } catch (unlinkErr) { console.warn('[download] merged file cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
    throw err
  } finally {
    // 清理段临时文件（合并后无用）
    for (const part of parts) {
      try { unlinkSync(part.tempPath) } catch (unlinkErr) { console.warn('[download] part cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
    }
  }
  // [MUST-FIX #2] multipart 成功：与单段路径对齐，清除 resume-state（本路径开头已 clear，
  // 但中途单段下载流程不会重新 save，这里保持幂等清理，确保成功后无残留）。
  clearResumeState()
  return { tempPath }
}

/**
 * 保存断点续传状态到文件。
 *
 * @param state 断点续传状态
 */
function saveResumeState(state: IResumeState): void {
  try {
    // 原子写（批次 5 m12 / §3.7.2）：先写 .tmp 再 rename，避免读到半截 JSON
    // （半截 state 会被 loadResumeState 的 parse 失败分支吞掉，丢掉续传进度）
    const tmpPath = `${RESUME_STATE_FILE}.tmp`
    writeFileSync(tmpPath, JSON.stringify(state, null, 2)) // eslint-disable-line no-magic-numbers -- JSON 缩进 2 空格
    renameSync(tmpPath, RESUME_STATE_FILE)
  } catch (err) {
    // best-effort：resume state 只是续传优化，写入失败不应中断下载，下次重头下即可
    console.warn('[download] save resume state failed:', err)
  }
}

/**
 * 从文件加载断点续传状态。
 *
 * @returns 断点续传状态，如果文件不存在或解析失败则返回 null
 */
function loadResumeState(): IResumeState | null {
  try {
    if (!existsSync(RESUME_STATE_FILE)) {
      return null
    }
    const data = readFileSync(RESUME_STATE_FILE, 'utf-8')
    return JSON.parse(data) as IResumeState
  } catch (err) {
    console.warn('[download] load resume state failed:', err)
    return null
  }
}

/**
 * 清除断点续传状态文件。
 */
function clearResumeState(): void {
  try {
    if (existsSync(RESUME_STATE_FILE)) {
      unlinkSync(RESUME_STATE_FILE)
    }
  } catch (err) {
    // best-effort：清理失败只留下残留 state 文件，下次下载会因 mismatch 自动重下，无副作用
    console.warn('[download] clear resume state failed:', err)
  }
}
