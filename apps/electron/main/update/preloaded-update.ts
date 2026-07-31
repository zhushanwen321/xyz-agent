/**
 * 预下载产物元信息 SSOT（Single Source Of Truth）。
 *
 * 后台预下载成功后记录已下载文件信息（version/assetName/filePath/downloadedAt + 完整性），
 * 用户点击更新时 update:perform handler 读取它走「快路径」：匹配 version + asset + 文件存在
 * 且完整性校验通过 → 直接 installUpdate 跳过重复下载。
 *
 * 清除时机：
 *   - 版本不匹配（pending.version 与本次要安装的 release.version 不一致）→ 清除
 *   - asset name 不匹配（同版本但平台 asset 变更）→ 清除
 *   - 产物文件已不存在 → 清除
 *   - 完整性校验失败（size/sha256 不匹配）→ 清除
 *
 * 依赖方向：preloaded-update → constants + pick-platform-asset + @xyz-agent/shared + node:fs/path
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { LatestReleaseInfo } from '@xyz-agent/shared'
import { PRELOADED_UPDATE_FILE } from './constants.js'
import { pickPlatformAsset, pickPlatformAssetName } from './pick-platform-asset.js'
import { hashFileSha256 } from './download-asset.js'

/**
 * preloaded-update.json 落盘结构。
 */
interface PreloadedUpdateData {
  /** 预下载的目标版本（与 release.version 比较以判断产物是否仍有效） */
  version: string
  /** 下载产物文件名（与 release asset name 比较以判断 asset 是否变更） */
  assetName: string
  /** 下载产物绝对路径（installUpdate 直接用） */
  filePath: string
  /** 预下载完成时间戳（诊断用） */
  downloadedAt: string
  /** 产物文件大小（完整性校验） */
  size: number
  /** 产物 sha256 hex（完整性校验，可选兜底） */
  sha256?: string
}

/**
 * 写入预下载产物元信息。预下载成功后调用。
 * best-effort：写入失败仅 warn（快路径降级为完整下载，不影响升级）。
 */
export function writePreloadedUpdate(release: LatestReleaseInfo, filePath: string): void {
  // 取平台对应 asset 的 name/size/sha256（与 orchestrator pickPlatformAsset 同源）
  const asset = pickPlatformAsset(release)
  if (!asset?.name) {
    console.warn('[preloaded-update] cannot determine assetName, skip writing')
    return
  }
  try {
    mkdirSync(path.dirname(PRELOADED_UPDATE_FILE), { recursive: true })
    const data: PreloadedUpdateData = {
      version: release.version,
      assetName: asset.name,
      filePath,
      downloadedAt: new Date().toISOString(),
      size: asset.size ?? 0,
      sha256: asset.sha256,
    }
    // eslint-disable-next-line no-magic-numbers -- 2 = JSON 缩进空格数（人类可读）
    writeFileSync(PRELOADED_UPDATE_FILE, JSON.stringify(data, null, 2))
  } catch (err) {
    // best-effort：写元信息失败不影响已下载的文件，快路径降级为完整下载
    console.warn('[preloaded-update] write failed:', err)
  }
}

/**
 * 读取预下载产物元信息，校验有效性（version + assetName + 文件存在 + 完整性）。
 *
 * @param release 当前要安装的 release（用其 version + asset name 校验产物是否仍匹配）
 * @returns 有效的产物文件路径；无效或不存在返回 null
 */
export async function readPreloadedUpdate(release: LatestReleaseInfo): Promise<string | null> {
  if (!existsSync(PRELOADED_UPDATE_FILE)) return null

  let data: PreloadedUpdateData
  try {
    data = JSON.parse(readFileSync(PRELOADED_UPDATE_FILE, 'utf-8')) as PreloadedUpdateData
  } catch (err) {
    console.warn('[preloaded-update] parse failed, clearing:', err)
    clearPreloadedUpdate()
    return null
  }

  // 版本不匹配（release 已更新或降级）→ 产物失效，清除
  if (data.version !== release.version) {
    console.log(`[preloaded-update] version mismatch (${data.version} vs ${release.version}), clearing`)
    clearPreloadedUpdate()
    return null
  }

  // asset name 不匹配（同版本但平台 asset 变更，极少见）→ 清除
  const expectedAssetName = pickPlatformAssetName(release)
  if (expectedAssetName && data.assetName !== expectedAssetName) {
    console.log(`[preloaded-update] assetName mismatch, clearing`)
    clearPreloadedUpdate()
    return null
  }

  // 产物文件已被外部清理（用户手动删 / 磁盘清理）→ 清除元信息
  if (!existsSync(data.filePath)) {
    console.log(`[preloaded-update] file ${data.filePath} no longer exists, clearing`)
    clearPreloadedUpdate()
    return null
  }

  // 完整性校验：先比对 size（便宜），再比对 sha256（若元信息里有）
  const actualSize = statSync(data.filePath).size
  if (data.size > 0 && actualSize !== data.size) {
    console.log(`[preloaded-update] size mismatch (expected ${data.size}, got ${actualSize}), clearing`)
    clearPreloadedUpdate()
    return null
  }
  if (data.sha256) {
    const actualSha = await hashFileSha256(data.filePath)
    if (actualSha !== data.sha256.toLowerCase()) {
      console.log(`[preloaded-update] sha256 mismatch, clearing`)
      clearPreloadedUpdate()
      return null
    }
  }

  return data.filePath
}

/**
 * 清除预下载产物元信息。best-effort：失败仅 warn。
 */
export function clearPreloadedUpdate(): void {
  try {
    if (existsSync(PRELOADED_UPDATE_FILE)) {
      unlinkSync(PRELOADED_UPDATE_FILE)
    }
  } catch (err) {
    // best-effort：清除失败只留残留元信息，下次 read 校验失败会再清
    console.warn('[preloaded-update] clear failed:', err)
  }
}
