/**
 * Provider 导入器（IF2/IF3 落地）—— previewImport + applyImport 两步数据流。
 *
 * 安全红线（DM1）：**API key 明文绝不进前端**。
 *   - previewImport 返回脱敏 ProviderImportPreview（只 apiKeyExtracted 布尔，无 key 值）。
 *   - 完整配置（含 apiKey 明文）只活在 preview-cache（runtime 内存），applyImport 据此写 models.json。
 *
 * 数据流：
 *   Step1 previewImport(source):
 *     parseProviders(source, homeDir) → ParsedProvider[](含 apiKey 明文 + _ 元数据)
 *     → createPreview(source, providers) 存缓存，得 importId
 *     → 读现有 models.json provider ids 做冲突检测
 *     → 返回脱敏 preview（_sourceName → id/name，apiKeyExtracted 布尔，conflict 标记）
 *   Step2 applyImport(importId, selectedIds):
 *     consumePreview(importId) 取完整配置（过期则 PREVIEW_EXPIRED）
 *     → apply 时再次查冲突（preview 后 models.json 可能被改）
 *     → 逐个 upsertProvider（剥离 _ 前缀元数据）
 *     → apply 后立即 deletePreview（一次性，防 importId 复用）
 *     → 返回 ProviderImportResult（imported/skipped/failed 三态条目 + failedCount）
 *
 * provider id 语义：_sourceName 是源里的 provider 名（如 Pi 的 'deepseek-router'），
 * 导入后作为 xyz-agent models.json 的 provider id（不重命名）。
 *
 * 日志安全：preview/apply 的日志只记 importId/source/status/count，不记 apiKey（DM1）。
 */
import { homedir } from 'node:os'
import type {
  ProviderSource,
  ProviderImportPreview,
  ProviderPreviewItem,
  ProviderImportResult,
  ProviderImportedItem,
} from '@xyz-agent/shared'
import { getProviderNames, upsertProvider } from '../../infra/pi/pi-provider-store.js'
import { createPreview, consumePreview, deletePreview } from './preview-cache.js'
import { parseProviders } from './provider-parser.js'

/**
 * previewImport 的成功返回（importId 供 Step2 applyImport 用 + 脱敏 preview 供前端渲染）。
 */
export interface PreviewImportSuccess {
  importId: string
  preview: ProviderImportPreview
}

/**
 * previewImport/applyImport 的错误返回（前端按 error.code 分流，error.message 展示）。
 */
export interface ImportError {
  error: { code: string; message: string }
}

/**
 * applyImport 的成功返回。
 */
export interface ApplyImportSuccess {
  result: ProviderImportResult
}

/**
 * Step1：预览导入。
 *
 * 解析源配置 → 存缓存（得 importId）→ 冲突检测 → 返回脱敏 preview。
 *
 * @param source 迁移源（pi/zcode/codex/claude）。
 * @param homeDir 用户主目录（默认 process.env.HOME || os.homedir()）。
 * @returns 成功 { importId, preview }；源未安装 { error: { code: 'SOURCE_NOT_INSTALLED' } }。
 *
 * 安全：返回的 preview.providers 只含 apiKeyExtracted 布尔，**不含 apiKey 值**。
 */
export function previewImport(
  source: ProviderSource,
  homeDir: string = process.env.HOME || homedir(),
): PreviewImportSuccess | ImportError {
  const parsed = parseProviders(source, homeDir)
  if (!parsed) {
    return { error: { code: 'SOURCE_NOT_INSTALLED', message: `${source} not installed (source config directory not found)` } }
  }

  // 存完整配置（含 apiKey 明文）到内存缓存，得 importId
  const importId = createPreview(source, parsed.providers)

  // 冲突检测：读现有 models.json provider ids
  const existingIds = new Set(getProviderNames())

  // 构造脱敏 preview（关键：不含 apiKey 值，只留 apiKeyExtracted 布尔）
  const items: ProviderPreviewItem[] = parsed.providers.map((p) => ({
    id: p._sourceName,
    name: p._sourceName,
    protocol: p.api ?? 'unknown',
    modelCount: p.models?.length ?? 0,
    apiKeyExtracted: p._apiKeyExtracted,
    conflict: existingIds.has(p._sourceName) ? 'duplicate-id' : 'none',
    warnings: p._warnings,
  }))

  // 日志只记 id/source/count（不记 apiKey，DM1）
  console.log(`[provider-importer] preview source=${source} importId=${importId} providerCount=${items.length}`)

  return { importId, preview: { source, providers: items } }
}

/**
 * Step2：应用导入（写入 models.json）。
 *
 * 从缓存取完整配置 → apply 时再次查冲突 → 逐个 upsertProvider（剥离 _ 元数据）→ 删缓存。
 *
 * @param importId Step1 previewImport 返回的 importId。
 * @param selectedIds 用户勾选导入的 provider id 列表（对应 _sourceName）。
 * @returns 成功 { result }；缓存过期/不存在 { error: { code: 'PREVIEW_EXPIRED' } }。
 *
 * 安全：upsertProvider 写入的 config 不含 _ 前缀元数据（对象解构剥离）；apiKey 明文从缓存透传。
 */
export function applyImport(importId: string, selectedIds: string[]): ApplyImportSuccess | ImportError {
  const entry = consumePreview(importId)
  if (!entry) {
    return { error: { code: 'PREVIEW_EXPIRED', message: '预览已过期或不存在，请重新检测' } }
  }

  // apply 时再次查冲突（preview 后 models.json 可能被改）
  const existingIds = new Set(getProviderNames())
  const imported: ProviderImportedItem[] = []
  let failedCount = 0

  for (const provider of entry.providers) {
    // 只处理用户勾选的 provider
    if (!selectedIds.includes(provider._sourceName)) continue

    // 冲突跳过（不覆写已存在的同名 provider）
    if (existingIds.has(provider._sourceName)) {
      imported.push({ id: provider._sourceName, name: provider._sourceName, status: 'skipped', reason: 'duplicate' })
      continue
    }

    try {
      // 剥离 _ 前缀元数据（对象解构，剩余即干净的 PiProviderConfig）
      const { _sourceName, _apiKeyExtracted, _warnings, ...piConfig } = provider
      upsertProvider(_sourceName, piConfig)
      imported.push({ id: _sourceName, name: _sourceName, status: 'imported' })
    } catch (e) {
      imported.push({
        id: provider._sourceName,
        name: provider._sourceName,
        status: 'failed',
        reason: e instanceof Error ? e.message : String(e),
      })
      failedCount++
    }
  }

  // apply 后立即删缓存（一次性，防 importId 复用）
  deletePreview(importId)

  // 日志只记 id/source/status/count（不记 apiKey，DM1）
  const importedCount = imported.filter((i) => i.status === 'imported').length
  const skippedCount = imported.filter((i) => i.status === 'skipped').length
  console.log(
    `[provider-importer] apply source=${entry.source} importId=${importId} imported=${importedCount} skipped=${skippedCount} failed=${failedCount}`,
  )

  return { result: { source: entry.source, imported, failedCount } }
}
