/**
 * 存量迁移（provider-config-quota 架构 Phase A1-2）：models.json 寄生字段 → providers.json。
 *
 * 背景：xyz 私有字段（provider 级 quota/authMethod/enabled、models[].enabled）寄生在
 * pi 的 models.json 里，靠 pi typebox 校验对额外属性宽容而存活；pi 升级收紧 schema 时
 * 全部 provider 定义失效（G3 风险）。本迁移在启动期（listen 前、sanitizeInvalidProviders
 * 之前）幂等执行：
 *
 * 1. 对每个 provider 条目剥离寄生字段：provider 级 quota/authMethod/enabled 直接迁出；
 *    models[].enabled 转为 providers.json 的 modelStates（key = modelId）。
 * 2. 剥离后条目若 pi 八字段（models/baseUrl/headers/compat/modelOverrides/apiKey/oauth/
 *    authHeader）全缺 → 整条删除（pi applyModelsJson 对此 throw 的空壳，典型来源：
 *    setProvider 仅传 quota/name 的历史形态）——寄生数据已先保入 providers.json。
 * 3. 合并策略：providers.json 已有该 providerId 条目则不覆盖（丢弃 models.json 旧值）——
 *    防止迁移失败窗口内的用户新写入被 stale 旧值覆盖（设计文档 §3.4 错误规格）。
 * 4. 成功后写回剥离版 models.json，写回前备份原文件为 models.json.bak-migrate-<ts>。
 *
 * 幂等：无任何条目含寄生字段时完全 no-op（不备份、不写盘、mtime 不变）。
 * 失败不阻塞启动：挂载点 catch + warn，下次启动重试（步骤 3 保证重试安全）。
 *
 * 顺序约束（挂载点 index.ts）：
 * - 必须在 migrateProviderEnabledToWhitelist（step2）之后：step2 把 provider 级 enabled
 *   迁成 enabledModels 白名单（有消费方的启停语义），本迁移只负责剥字段。
 * - 必须在 sanitizeInvalidProviders 之前：sanitize 对非 catalog 空壳条目直接删除，
 *   先迁移才能把空壳条目的 quota 等寄生数据保入 providers.json（否则数据丢失）。
 */
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IConfigStore, ConfigProviderConfig } from '../ports/config.js'
import type { XyzProviderStore, ProviderExtras } from '../provider-extras-store.js'
import { isInvalidProvider } from '../../infra/pi/pi-provider-repair.js'

/** 单条目剥离结果：extras = 迁出数据，stripped = 剥离后条目，dirty = 是否含寄生字段。 */
export interface StripResult {
  extras: ProviderExtras
  stripped: ConfigProviderConfig
  dirty: boolean
}

/** extras 是否含实质数据（authMethod/quota/modelStates 任一）。只有 enabled 死字段的条目剥除即可，无需在 providers.json 落空条目。 */
function hasSubstantiveExtras(extras: ProviderExtras): boolean {
  return extras.authMethod !== undefined || extras.quota !== undefined || extras.modelStates !== undefined
}

/**
 * 从 models.json 条目剥离 xyz 寄生字段（纯函数，迁移与 readExtrasWithFallback 共用）。
 * - provider 级 authMethod/quota/enabled 迁出（enabled 是 wave3 C5 停写的死字段，直接剥除不迁）
 * - models[].enabled → modelStates（显式 true/false 都保真迁出；省略的默认 true 不迁）
 */
export function stripParasiticFields(config: ConfigProviderConfig): StripResult {
  const { authMethod, quota, enabled: providerEnabled, models, ...rest } = config
  const extras: ProviderExtras = {}
  if (authMethod !== undefined) extras.authMethod = authMethod
  if (quota !== undefined) extras.quota = quota

  let modelStatesDirty = false
  const modelStates: Record<string, { enabled: boolean }> = {}
  const strippedModels = models?.map(m => {
    if (m.enabled === undefined) return m
    modelStatesDirty = true
    modelStates[m.id] = { enabled: m.enabled }
    const { enabled: _modelEnabled, ...modelRest } = m
    return modelRest as NonNullable<ConfigProviderConfig['models']>[number]
  })

  if (modelStatesDirty) extras.modelStates = modelStates

  const stripped = { ...rest, ...(strippedModels !== undefined ? { models: strippedModels } : {}) } as ConfigProviderConfig
  return {
    extras,
    stripped,
    dirty: authMethod !== undefined || quota !== undefined || providerEnabled !== undefined || modelStatesDirty,
  }
}

export interface ProviderExtrasMigrationReport {
  /** 寄生数据搬入 providers.json 的 providerId（含空壳条目——其数据先保后删）。 */
  migrated: string[]
  /** 剥离后 pi 八字段全缺被整条删除的 providerId。 */
  removedShells: string[]
  /** 完全 no-op（无寄生字段，未写任何文件）。 */
  noOp: boolean
  /** providers.json 写入时被合并策略跳过的条目（已有条目，旧值丢弃）。 */
  skippedExisting: string[]
}

/**
 * 启动期一次性迁移（幂等）。models.json 读写经 IConfigStore port，providers.json 经
 * XyzProviderStore（唯一读写者），备份经 fs copy 磁盘原文件。
 *
 * 写序：寄生数据先入 providers.json → 再写回剥离版 models.json——providers.json 写失败
 * 时 models.json 未动，下次启动重试（幂等前提）。
 */
export async function migrateProviderExtras(
  configStore: IConfigStore,
  extrasStore: XyzProviderStore,
): Promise<ProviderExtrasMigrationReport> {
  const report: ProviderExtrasMigrationReport = { migrated: [], removedShells: [], noOp: true, skippedExisting: [] }
  const models = configStore.readModels()

  // 第一遍：剥离 + 收集（不动盘）
  const dirtyEntries: Array<{ providerId: string; result: StripResult }> = []
  for (const [providerId, config] of Object.entries(models.providers)) {
    const result = stripParasiticFields(config)
    if (result.dirty) dirtyEntries.push({ providerId, result })
  }
  if (dirtyEntries.length === 0) {
    report.noOp = true
    return report
  }
  report.noOp = false

  // 备份磁盘原文件（写回前；no-op 时不产生备份，保证二次启动文件 mtime/hash 不变）
  const modelsPath = join(configStore.getPiAgentDir(), 'models.json')
  if (existsSync(modelsPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '')
    copyFileSync(modelsPath, `${modelsPath}.bak-migrate-${ts}`)
  }

  // 第二遍：寄生数据入 providers.json（合并策略：已有条目不覆盖）。
  // 只有 enabled 死字段的条目（extras 空）不落 providers.json——空条目无信息量，
  // 还会阻断 readExtrasWithFallback 的 models.json 回退路径。
  for (const { providerId, result } of dirtyEntries) {
    if (!hasSubstantiveExtras(result.extras)) continue
    await extrasStore.modify(providerId, current => {
      if (current !== undefined) {
        report.skippedExisting.push(providerId)
        return current
      }
      return result.extras
    })
    report.migrated.push(providerId)
  }

  // 第三遍：写回剥离版 models.json（空壳整条删除）
  for (const { providerId, result } of dirtyEntries) {
    // isInvalidProvider = pi 0.84.1 八字段全缺判定（pi-provider-repair 权威实现；
    // ConfigProviderConfig 与 PiProviderConfig 结构同构，port 视图可直接传入）
    if (isInvalidProvider(result.stripped)) {
      configStore.removeProvider(providerId)
      report.removedShells.push(providerId)
    } else {
      configStore.upsertProvider(providerId, result.stripped)
    }
  }

  return report
}

/**
 * 双读回退（Wave 2 读侧切换预留，本波只实现不接消费方）：
 * providers.json 优先，无条目时回退读 models.json 旧寄生字段——兼容迁移失败窗口
 * （迁移失败时 models.json 寄生字段仍在，读侧仍能取到值；迁移成功后 models.json
 * 已剥离，providers.json 恒命中）。
 */
export async function readExtrasWithFallback(
  extrasStore: XyzProviderStore,
  configStore: IConfigStore,
  providerId: string,
): Promise<ProviderExtras | undefined> {
  const fromStore = await extrasStore.getExtras(providerId)
  if (fromStore !== undefined) return fromStore
  const legacy = configStore.getProviderConfig(providerId)
  if (legacy === undefined) return undefined
  const { extras, dirty } = stripParasiticFields(legacy)
  return dirty ? extras : undefined
}
