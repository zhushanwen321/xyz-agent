/**
 * 存量 provider 配置迁移：catalog provider 错位 apiKey 迁 auth.json。
 *
 * 背景：xyz-agent 此前不区分 pi 的两套 provider 体系，catalog provider 的
 * apiKey 被错位写进 models.json（0644 明文）。此迁移在启动期幂等执行：
 * - catalog provider 条目含 apiKey → apiKey 迁 auth.json，删 models.json 条目
 * - 若条目有非默认 override（baseUrl/compat）→ 保留 override-only 条目只删 apiKey
 * - 自定义 provider 条目 → 不动
 * - OAuth 冲突（auth.json 已有 oauth）→ 跳过
 * - 迁移失败不阻断启动，warn + 下次重试
 */
import { readModels, upsertProvider, getProviderNames, setEnabledModels, clearEnabledModels, removeProvider } from '../../infra/pi/pi-provider-store.js'
import { isCatalogProvider } from '../provider-catalog.js'
import { AuthStorage } from '../auth/auth-storage.js'
import { join } from 'node:path'
import type { PiProviderConfig } from '../../infra/pi/pi-provider-store.js'

export interface MigrationReport {
  migrated: string[]
  kept: string[]
  failed: string[]
  skipped: string[]
  errors: string[]
}

/**
 * step2 迁移结果：provider 级 enabled → settings.json.enabledModels 白名单。
 *
 * - migratedEnabled=false：models.json 无 provider 级 enabled 字段，完全 no-op（幂等，TC6）
 * - migratedEnabled=true：曾发现有 enabled 字段，已删字段；可能同时设了白名单
 * - fullDisabledWarn=true：所有 provider enabled===false（pi 契约不支持全禁用，
 *   迁移后全可用 + warn 提示用户手动移除，ES4/TC3）
 */
export interface ProviderEnabledMigrationReport {
  migratedEnabled: boolean
  fullDisabledWarn?: boolean
}

/**
 * migrateProviderConfig 合并报告：step1 catalog apiKey 迁移 + step2 provider.enabled 迁移。
 * 启动期调用，失败不阻断启动。 */
export interface ProviderConfigMigrationReport {
  catalog: MigrationReport
  enabled: ProviderEnabledMigrationReport
}

/**
 * 启动期幂等迁移：catalog provider 错位 apiKey → auth.json。
 * @param authStorage AuthStorage 实例（操作 auth.json）
 * @returns MigrationReport
 */
export async function migrateLegacyProviderConfig(authStorage: AuthStorage): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: [], kept: [], failed: [], skipped: [], errors: [] }

  try {
    const models = readModels()
    const providers = models.providers ?? {}

    for (const [providerId, config] of Object.entries(providers)) {
      // 只处理 catalog provider
      if (!isCatalogProvider(providerId)) {
        report.kept.push(providerId)
        continue
      }

      // 只处理有 apiKey 的条目（无 apiKey 的是 override-only 条目，不动）
      if (!config.apiKey || config.apiKey === '') {
        report.kept.push(providerId)
        continue
      }

      // OAuth 冲突检查
      try {
        const existing = await authStorage.get(providerId)
        if (existing?.type === 'oauth') {
          report.skipped.push(providerId)
          continue
        }
      } catch {
        // auth.json 读失败不阻断，继续迁移（秘钥会覆盖写入）
      }

      try {
        // 写 apiKey 到 auth.json
        await authStorage.set(providerId, { type: 'api_key', key: config.apiKey as string })

        // 删 models.json 条目（重建不含 apiKey 的配置）
        const { apiKey, ...rest } = config as Record<string, unknown>
        // 如果只剩下默认字段（name/api/baseUrl 来自 builtin template），直接删条目
        // 如果有额外 override 字段 → 保留 override-only 条目
        const hasOverride = Object.keys(rest).length > 0 && (
          rest.baseUrl !== undefined || rest.compat !== undefined || rest.headers !== undefined
        )
        if (hasOverride) {
          upsertProvider(providerId, rest as Parameters<typeof upsertProvider>[1])
        } else {
          // 无 override → 删除整个条目，catalog provider 回退 builtin template。
          // A7：用 removeProvider（功能完整：删条目 + 同步清理 default）替代「写最小条目」变通
          // （写 {name,api,baseUrl} 会丢失 models/quota 等字段且语义不准）。
          // removeProvider 若删的是 default 承载 provider 会重选 newDefault 并写回 settings.json，
          // 运行时 findValidDefaultModel 兜底（catalog provider 仍可用，凭据已正位 auth.json）。
          removeProvider(providerId)
        }

        report.migrated.push(providerId)
      } catch (e) {
        report.failed.push(providerId)
        report.errors.push(`${providerId}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (e) {
    report.errors.push(`migration failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  return report
}

/**
 * step2 启动期幂等迁移：provider 级 enabled 字段 → settings.json.enabledModels 白名单。
 *
 * 背景（G5）：wave3 把 provider 启停源改为 enabledModels（SSOT）后，存量 models.json 的
 * provider 级 `enabled` 字段未被消费，存量用户的启停配置「丢失」（deriveEnabled 只读
 * enabledModels，不再读 provider.enabled）。本 step 把存量 enabled 字段迁移成白名单。
 *
 * 逻辑（design CL1/CL2/C1-C3）：
 * 1. 收集有 provider 级 enabled 字段的条目（`'enabled' in config`）。无任何条目有此字段
 *    → 完全 no-op（幂等，TC6）。
 * 2. 全 enabled（无 disabled）→ 不设白名单（保持「无白名单=全可用」语义，TC2/CL1）。
 *    避免「全 enabled 迁移后设全部 pattern」的冗余（全 pattern ≡ 空 = 全可用，但空更简洁，
 *    且未来新增 provider 不自动可用是白名单语义的反效果）。
 * 3. 有 disabled → enabledModels = enabled 条目的 `<id>/*`（TC1）。
 * 4. 全 disabled（enabled 为空）→ clearEnabledModels + fullDisabledWarn（ES4/TC3）。
 *    pi 契约不支持全禁用（白名单语义空=全可用），迁移后全可用 + warn 提示用户手动移除。
 * 5. 删 provider 级 enabled 字段（upsertProvider 写回无 enabled 的 config）。model 级
 *    `models[].enabled` 保留不动（TC4）——它由 pi 原生消费，不在本次迁移范围。
 * 6. defaultModel 重选不主动做（CL2）：依赖运行时 findValidDefaultModel 兜底（wave2 catalog
 *    兜底已过滤 enabledModels），迁移后若 default 落白名单外下次 getDefaultModel 自动重选。
 *
 * @returns migratedEnabled=true 表示曾发现有 enabled 字段并已处理（删字段 ± 设白名单）
 */
export async function migrateProviderEnabledToWhitelist(): Promise<ProviderEnabledMigrationReport> {
  const report: ProviderEnabledMigrationReport = { migratedEnabled: false }

  try {
    const models = readModels()
    const providers = models.providers ?? {}

    // 收集有 provider 级 enabled 字段的（含 enabled:true / enabled:false）
    const providersWithEnabled = Object.entries(providers).filter(
      ([, config]) => config !== null && typeof config === 'object' && 'enabled' in config,
    ) as Array<[string, PiProviderConfig]>

    // 无 provider 级 enabled 字段 → 完全 no-op（幂等，TC6）
    if (providersWithEnabled.length === 0) {
      return report
    }

    // 分 enabled(enabled!==false) / disabled(enabled===false)。
    // 与 deriveEnabled 同语义：省略/true/其他 truthy 都视为启用，仅严格 ===false 视为禁用。
    const enabledProviderIds: string[] = []
    for (const [providerId, config] of providersWithEnabled) {
      if (config.enabled !== false) {
        enabledProviderIds.push(providerId)
      }
    }
    const hasDisabled = enabledProviderIds.length < providersWithEnabled.length

    if (hasDisabled) {
      if (enabledProviderIds.length === 0) {
        // 全 disabled → clearEnabledModels + warn（ES4/TC3）
        clearEnabledModels()
        report.fullDisabledWarn = true
      } else {
        // 部分禁用 → enabledModels = enabled 的 <id>/*（TC1）
        setEnabledModels(enabledProviderIds.map(id => `${id}/*`))
      }
    }
    // 全 enabled（无 disabled）→ 不设白名单（保持全可用，TC2/CL1）

    // 删 provider 级 enabled 字段（TC4 + 幂等 TC6 前提）。
    // model 级 models[].enabled 不动（pi 原生消费）。
    for (const [providerId, config] of providersWithEnabled) {
      const { enabled: _removed, ...rest } = config
      upsertProvider(providerId, rest)
    }

    report.migratedEnabled = true
  } catch (e) {
    // 迁移失败不阻断启动（与 step1 同模式），warn + 下次重试
    console.warn('[runtime] migrateProviderEnabledToWhitelist failed:', e)
  }

  return report
}

/**
 * 启动期编排：step1（catalog 错位 apiKey → auth.json）+ step2（provider.enabled → enabledModels）。
 *
 * 顺序：step2 先跑（MF1 修复，exec-review must-fix）。原因：step1 对无 override 的 catalog provider
 * 「写最小 {name,api,baseUrl} 条目」（step1 预存变通）会丢弃 enabled 字段，若 step1 先跑则 step2
 * 读不到 enabled → 启停状态丢失（G5 核心场景：catalog+apiKey+enabled+无override）。step2 先读 enabled
 * 迁 enabledModels + 删字段，再 step1 处理 apiKey（操作 models.json，settings.json 的 enabledModels
 * 不受影响），确保 G5 覆盖。两步各自 try/catch，互不阻断。
 *
 * @param authStorage AuthStorage 实例（step1 操作 auth.json）
 */
export async function migrateProviderConfig(authStorage: AuthStorage): Promise<ProviderConfigMigrationReport> {
  const enabled = await migrateProviderEnabledToWhitelist()
  const catalog = await migrateLegacyProviderConfig(authStorage)
  return { catalog, enabled }
}
