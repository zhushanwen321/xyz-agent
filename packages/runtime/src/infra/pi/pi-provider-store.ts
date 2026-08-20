/**
 * Pi Provider/Model/Settings Store — xyz-pi 配置文件读写层。
 *
 * 重构说明（Phase 1 拆分）：本文件曾 883 行超 ESLint max-lines(500)，现按职责拆到
 * pi-maintenance / pi-enabled-models / pi-skill-paths / pi-provider-repair。本文件保留
 * models.json 读写 + provider CRUD + defaultModel 校验 + refresh + sanitizeInvalidProviders
 *（依赖 modelsStore 模块级缓存）+ barrel re-export 保 import 路径不变，行为/签名零变化。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
// builtin provider catalog（QuickSetup 模板源）：sanitizeInvalidProviders 对 catalog 已知的
// 空壳 provider 合并 models 修复而非删除（对齐 config-service 的 builtinModelsById 先例）。
import builtinData from '../../generated/builtin-providers.json'
import { deriveEnabled } from '../../services/provider-catalog.js'
import { JsonStore } from '../../utils/json-store.js'
import { getModelsPath, getPiAgentDir } from './pi-paths.js'
// settings.json 的唯一读写层（D17 收口）：readSettings/updateSettingsFields/PiSettings/缓存/
// 跨进程锁/原子写都收敛到 pi-settings-store，model 域（本文件）与 extension 域共享同一
// 所有者 + 缓存 + 锁。
import {
  readSettings,
  updateSettingsFields,
  invalidateSettingsCache,
} from './pi-settings-store.js'
// enabledModels 白名单读写（Phase 1 拆出到 pi-enabled-models）：本文件的 pickFirstModelProvider /
// findValidDefaultModel 经 getEnabledModels 派生启用状态，不直接碰 settings.enabledModels。
import { getEnabledModels } from './pi-enabled-models.js'
// provider 有效性校验（Phase 1 拆出到 pi-provider-repair）：sanitizeInvalidProviders 启动时
// 剔除空壳 provider 用。isInvalidProvider 是纯函数，不碰 modelsStore。
import { isInvalidProvider } from './pi-provider-repair.js'
import type { ProviderId } from '@xyz-agent/shared'

// ── 类型定义（对齐 pi models.json / settings.json 的 schema）────

export interface PiModelDefinition {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  reasoning?: boolean
  /** model 级启停（W1）。省略时默认 true，向上兼容存量数据。 */
  enabled?: boolean
  input?: Array<'text' | 'image'>
  contextWindow?: number
  maxTokens?: number
  headers?: Record<string, string>
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  compat?: Record<string, unknown>
  thinkingLevelMap?: Record<string, string | null>
}

export interface PiProviderConfig {
  name?: string
  baseUrl?: string
  apiKey?: string
  api?: string
  /** 认证方式（I6）：ProviderQuickSetup.onSave 标注。旧数据缺失时按 apiKey 格式推断。 */
  authMethod?: 'api_key' | 'oauth' | 'env_var' | 'ambient'
  /** provider 级启停（W1）。省略时默认 true，向上兼容存量数据。 */
  enabled?: boolean
  headers?: Record<string, string>
  authHeader?: boolean
  models?: PiModelDefinition[]
  modelOverrides?: Record<string, Record<string, unknown>>
  /**
   * Coding Plan 额度查询配置（可选）。
   * 持久化在 models.json 的 provider 级，listProviders 映射到 ProviderInfo.quota。
   */
  quota?: {
    /** 用户手动指定的 fetcher id（省略时 QuotaService 自动按 baseUrl/name 匹配）。 */
    fetcher?: string
    /** 是否启用额度查询。 */
    enabled: boolean
    /** cookie 类 provider 的 cookie 是否已写入 secrets（布尔态，明文不入 models.json）。 */
    cookieSet?: boolean
    /**
     * api-key 类 provider 是否有 Coding Plan 专属 API Key（明文存 secrets，不写 models.json）。
     * 未设置/false = 复用 provider.apiKey。
     */
    apiKeySet?: boolean
  }
}

export interface PiModelsConfig {
  providers: Record<string, PiProviderConfig>
}

export type { PiSettings } from './pi-settings-store.js'

// ── 缓存 ─────────────────────────────────────────────────────
// 注：settings.json 的缓存 + readSettings/writeSettings 收敛到 pi-settings-store（D17）。
// 此处 models.json 的 read-through 缓存 + 原子读写收敛到 JsonStore（P0-1）。

/**
 * models.json 路径。生产用 getModelsPath()（= ~/.xyz-agent/pi/agent/models.json）。
 * 测试可经 setModelsPath() 指向临时目录，与 setSettingsPath 对称。
 */
let modelsFilePath: string = getModelsPath()

/** models.json 存储：read-through（TTL 缓存 + ENOENT 容错）+ atomicWrite。 */
let modelsStore = createModelsStore(modelsFilePath)

function createModelsStore(path: string): JsonStore<PiModelsConfig> {
  return new JsonStore<PiModelsConfig>(path, { providers: {} }, {
    ttlMs: 3_000,
    deserialize: (raw): PiModelsConfig => {
      if (!raw || typeof raw !== 'object' || typeof (raw as PiModelsConfig).providers !== 'object') {
        console.warn(`[provider-store] ${path} schema 不匹配，使用 fallback`)
        return { providers: {} }
      }
      return raw as PiModelsConfig
    },
  })
}

/**
 * 覆盖 models.json 路径（仅测试用）。生产不应调用。
 * 重建 store 实例并清空缓存，确保后续读拿到新路径的文件。
 */
export function setModelsPath(path: string): void {
  modelsFilePath = path
  modelsStore = createModelsStore(path)
}

// ── Models.json 操作 ──────────────────────────────────────────

export function readModels(): PiModelsConfig {
  return modelsStore.read()
}

export function writeModels(config: PiModelsConfig): void {
  modelsStore.write(config)
}

export function getProviderNames(): string[] {
  return Object.keys(readModels().providers)
}

export function getProviderConfig(providerId: string): PiProviderConfig | undefined {
  const config = readModels().providers[providerId]
  return config ? JSON.parse(JSON.stringify(config)) : undefined
}

/**
 * 扫描 providers，返回第一个含 model 的 provider 及其第一个 model id（D10）。
 *
 * upsertProvider / removeProvider 在 default 失效时各内联了一遍同样的「找第一个有
 * models 的 provider」循环。返回 undefined 表示无可用 provider。
 */
function pickFirstModelProvider(
  providers: Record<string, PiProviderConfig>,
): { provider: ProviderId; modelId: string } | undefined {
  // A8：跳过被 enabledModels 禁用的 provider（与 findValidDefaultModel 主路径守卫一致），
  // 避免 removeProvider/upsertProvider 重选与 findValidDefaultModel fallback 选到用户已禁用的 provider。
  // enabledModels 空（全启用）时 deriveEnabled 恒 true，行为不变。重选场景 enabledModels 不变，
  // 实时读 getEnabledModels 安全（无 updateSettingsFields 回调内 stale 风险）。
  const enabledModels = getEnabledModels()
  for (const [pid, pcfg] of Object.entries(providers)) {
    if (!deriveEnabled(pid, enabledModels)) continue
    if (pcfg.models && pcfg.models.length > 0) {
      // pid 来自 models.json 磁盘 key（反序列化边界，design D5）→ as ProviderId
      return { provider: pid as ProviderId, modelId: pcfg.models[0].id }
    }
  }
  return undefined
}

/**
 * 读 auth.json 凭据表（catalog 兜底的凭据校验用）。
 * 文件不存在返回 {}；JSON 损坏返回 {} + warn（兜底是 best-effort，不因损坏阻断）。
 * 不依赖 AuthStorage 实例——本模块是纯函数读写层，无注入依赖。
 */
function readAuthCredentials(): Record<string, unknown> {
  const authPath = join(getPiAgentDir(), 'auth.json')
  if (!existsSync(authPath)) return {}
  try {
    const raw = readFileSync(authPath, 'utf-8')
    if (raw.trim() === '') return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (cause) {
    console.warn(`[provider-store] auth.json 损坏: ${authPath}`, cause)
    return {}
  }
}

/**
 * 更新 provider 配置并同步校验 defaultModel。
 * 全程同步（无 await），避免竞态窗口。
 */
export function upsertProvider(providerId: string, config: PiProviderConfig): {
  newDefault?: { provider: ProviderId; modelId: string }
} {
  const models: PiModelsConfig = JSON.parse(JSON.stringify(readModels()))
  models.providers[providerId] = config
  writeModels(models)

  // 同步校验 defaultModel：经 updateSettingsFields('model') 单次锁内 RMW。
  // 结果通过外层变量捕获（mutator 不返回值）。
  let outcome: { newDefault?: { provider: ProviderId; modelId: string } } = {}
  updateSettingsFields('model', s => {
    if (s.defaultProvider !== providerId) { outcome = {}; return }

    // models 未参与本次更新（partial upsert：clearApiKey 剥离 apiKey / quota 覆写 /
    // QuickSetup 保存不携带 models）时跳过 default 校验——builtin override-only provider
    // 的 models.json 条目本无 models 数组，把 undefined 视作「模型被清空」会把
    // defaultProvider/defaultModel 静默删除并回退到别的 provider（用户默认模型在 OAuth
    // 授权成功瞬间被改写，spec §8 未授权该副作用）。显式传 models（含空数组）仍走校验。
    if (config.models === undefined) { outcome = {}; return }

    const newModelList = config.models
    if (newModelList.length === 0) {
      delete s.defaultProvider
      delete s.defaultModel
      const fallback = pickFirstModelProvider(models.providers)
      if (fallback) {
        s.defaultProvider = fallback.provider
        s.defaultModel = fallback.modelId
      }
      outcome = s.defaultProvider
        ? { newDefault: { provider: s.defaultProvider as ProviderId, modelId: s.defaultModel! } }
        : {}
      return
    }

    const currentModelId = s.defaultModel
    if (currentModelId && !newModelList.find(m => m.id === currentModelId)) {
      s.defaultModel = newModelList[0].id
      console.warn(`[provider-store] defaultModel "${currentModelId}" no longer in provider "${providerId}", falling back to "${newModelList[0].id}"`)
    }
    outcome = { newDefault: { provider: providerId as ProviderId, modelId: s.defaultModel! } }
  })
  return outcome
}

/**
 * 删除 provider 并同步清理 defaultProvider/defaultModel。
 * 全程同步（无 await），避免竞态窗口。
 */
export function removeProvider(providerId: string): {
  removed: boolean
  newDefault?: { provider: ProviderId; modelId: string }
} {
  const models: PiModelsConfig = JSON.parse(JSON.stringify(readModels()))
  if (!(providerId in models.providers)) return { removed: false }
  delete models.providers[providerId]
  writeModels(models)

  // 同步清理 defaultProvider/defaultModel：经 updateSettingsFields('model') 单次锁内 RMW。
  let outcome: { removed: boolean; newDefault?: { provider: ProviderId; modelId: string } } = { removed: true }
  updateSettingsFields('model', s => {
    if (s.defaultProvider !== providerId) { outcome = { removed: true }; return }
    delete s.defaultProvider
    delete s.defaultModel
    const fallback = pickFirstModelProvider(models.providers)
    if (fallback) {
      s.defaultProvider = fallback.provider
      s.defaultModel = fallback.modelId
    }
    outcome = s.defaultProvider
      ? { removed: true, newDefault: { provider: s.defaultProvider as ProviderId, modelId: s.defaultModel! } }
      : { removed: true }
  })
  return outcome
}

export function getAllModels(): Array<PiModelDefinition & { providerId: string }> {
  const result: Array<PiModelDefinition & { providerId: string }> = []
  const models = readModels()
  for (const [providerId, providerConfig] of Object.entries(models.providers)) {
    for (const model of providerConfig.models ?? []) {
      result.push({ ...model, providerId })
    }
  }
  return result
}

export function getApiKeyForProvider(providerId: string): string | undefined {
  return readModels().providers[providerId]?.apiKey
}

// ── Settings.json 操作 ───────────────────────────────────────
// readSettings/updateSettingsFields 收敛到 pi-settings-store（D17 唯一读写层）；setSettingsPath 供测试 tmpdir 隔离。
export { readSettings, writeSettings, updateSettingsFields, setSettingsPath } from './pi-settings-store.js'

/**
 * 纯校验：检查 defaultProvider/defaultModel 在 models.json 中是否有效。
 * 无副作用，不修改任何文件。
 */
export function findValidDefaultModel(): {
  result: { provider: ProviderId; modelId: string } | null
  wasFixed: boolean
} { // eslint-disable-line indent -- standard TS function signature with multi-line return type
  const settings = readSettings()
  const models = readModels()
  const { defaultProvider, defaultModel } = settings

  if (defaultProvider && defaultModel) {
    const providerConfig = models.providers[defaultProvider]
    // A8：被 enabledModels 禁用的 default provider 不走主路径，fall through 到 fallback 重选
    // （主路径原只校验 provider/model 有效，未过滤 enabledModels，被禁用的 default 会直接返回）。
    const isEnabled = deriveEnabled(defaultProvider, getEnabledModels())
    if (providerConfig?.models?.length && isEnabled) {
      const found = providerConfig.models.find(m => m.id === defaultModel)
      if (found) {
        // defaultProvider 来自 settings.json 磁盘读（反序列化边界，design D5）→ as ProviderId
        return { result: { provider: defaultProvider as ProviderId, modelId: defaultModel }, wasFixed: false }
      }
      console.warn(`[provider-store] defaultModel "${defaultModel}" not found in provider "${defaultProvider}", falling back to "${providerConfig.models[0].id}"`)
      return { result: { provider: defaultProvider as ProviderId, modelId: providerConfig.models[0].id }, wasFixed: true }
    }
    if (!providerConfig?.models?.length) {
      console.warn(`[provider-store] defaultProvider "${defaultProvider}" not found in models.json`)
    }
    // isEnabled===false：default provider 被禁用，静默 fall through 到 fallback（不 warn 误导）
  }

  const fallback = pickFirstModelProvider(models.providers)
  if (fallback) {
    return { result: { provider: fallback.provider, modelId: fallback.modelId }, wasFixed: true }
  }

  // catalog 兜底：models.json 无可用 provider 时，查 builtin-providers 副本找
  // 「凭据可解析」的 catalog provider 作默认候选（决策 4：校验 auth.json credential /
  // models.json apiKey 任一）。遍历而非取排序第一个——amazon-bedrock 等 ambient 认证
  // provider 无凭据时不可用，不能作为默认。
  // wasFixed=false：兜底是临时展示，不是配置修复——写回 settings.json 会污染用户配置
  //（曾踩坑：兜底结果经 updateSettingsFields 覆盖用户默认 provider，见 2026-08-09 回归）。
  if (!fallback) {
    const authCredentials = readAuthCredentials()
    const builtinProviders = (builtinData.providers ?? []) as Array<{
      id: string
      models?: Array<{ id: string }>
    }>
    for (const bp of builtinProviders) {
      const hasCredential =
        bp.id in authCredentials || !!models.providers[bp.id]?.apiKey
      // ES3：被 enabledModels 禁用的 catalog provider 不作 default 候选（避免返回用户已禁用的 provider）。
      // deriveEnabled 复用 listProviders 的启用判定（DM3），保持「可用 provider」语义一致。
      if (hasCredential && deriveEnabled(bp.id, getEnabledModels()) && bp.models && bp.models.length > 0) {
        return {
          // bp.id 来自 builtin-providers.json 磁盘读（反序列化边界，design D5）→ as ProviderId
          result: { provider: bp.id as ProviderId, modelId: bp.models[0].id },
          wasFixed: false,
        }
      }
    }
  }

  return { result: null, wasFixed: false }
}

/**
 * 获取默认模型，带有效性校验和自动修复。
 */
export function getDefaultModel(): { provider: ProviderId; modelId: string } | null {
  const { result, wasFixed } = findValidDefaultModel()
  if (wasFixed && result) {
    updateSettingsFields('model', s => {
      s.defaultProvider = result.provider
      s.defaultModel = result.modelId
    })
    console.log(`[provider-store] auto-fixed defaultModel: ${result.provider}/${result.modelId}`)
  }
  return result
}

export function setDefaultModel(provider: ProviderId, modelId: string): void {
  updateSettingsFields('model', s => {
    s.defaultProvider = provider
    s.defaultModel = modelId
  })
}

export function getDefaultThinkingLevel(): string {
  return readSettings().defaultThinkingLevel ?? 'high'
}

export function setDefaultThinkingLevel(level: string): void {
  updateSettingsFields('model', s => { s.defaultThinkingLevel = level })
}

// ── models.json 无效 provider 清理（重装后 "Model not found" 自愈）──────
//
// 背景见下 sanitizeInvalidProviders JSDoc（bundled pi 0.80.3 严格校验空壳 provider 致整个 models.json 加载失败）。
//
// MF-5（R3 review）：catalog 已知内置 provider 的空壳不删除——QuickSetup 保存 baseUrl
// 为空串模板（amazon-bedrock/azure-openai-responses/cloudflare-*/google-vertex/opencode* 等
// 7 个）时条目五字段全缺，旧实现重启即删除（用户刚保存的 apiKey/authMethod 静默丢失）。
// 这类空壳从 catalog 合并 models 修复（模型级 baseUrl 由 catalog 提供），保留用户数据且
// 仍满足 bundled pi 严格校验；非 catalog 的空壳（外部脚本 fixture）维持删除语义。
// [W1b 语义变更] 无效判定已对齐 pi 0.84.1 八字段（isInvalidProvider，锚点见
// pi-provider-repair.ts）：QuickSetup 条目通常含 apiKey → 直接合法，不再进修复路径；
// 修复路径仅剩八字段全缺（连 apiKey 都无）的 catalog 空壳。曾被旧五字段判定误删的
// 配置不追溯恢复（known-issue，见 pi-provider-repair.ts）。
// MF-6（R4 review）：修复前提是 catalog models 每个模型都有可用 baseUrl（见下）。
// azure-openai-responses 的 38 个 catalog models 全为空串 baseUrl，合并即毒化 pi 组合，
// 排除出修复名单（维持删除语义）——目录中不存在任何可用 baseUrl 数据。

/**
 * builtin provider id → catalog models 索引（MF-5 修复空壳用）。
 * JSON import 推断类型与 PiModelDefinition 有 input 等字段差异，构造时断言（对齐
 * config-service builtinModelsById 的 `as [string, ...]` 处理）。
 */
const builtinModelsById = new Map<string, PiModelDefinition[]>(
  (builtinData.providers ?? []).map(p => [p.id, p.models] as [string, PiModelDefinition[]]),
)

/**
 * 启动时清理 models.json 里的无效 provider（八字段全缺的空壳，判定 = isInvalidProvider，
 * 对齐 pi 0.84.1 applyModelsJson 抛错条件，锚点与 known-issue 见 pi-provider-repair.ts）。
 *
 * 修复根因（历史）：空壳 provider（如仅 {name}，八字段全缺）导致 bundled pi 0.80.3
 * 严格校验时整个 models.json 加载失败。系统 pi 0.83 对此容错但 bundled 0.80.3 不容错，
 * 重装后切换 bundled pi 必现 "Model not found"。本函数让 xyz-agent 自愈这种脏数据。
 *
 * [W1b 语义变更] 0.84.1 判定放宽为八字段（apiKey/oauth/authHeader 在场即合法）：
 * 只配 apiKey 的合法 provider 不再被删（旧五字段判定的误删是数据丢失级 bug，审计 A-02；
 * 被误删数据不追溯恢复——known-issue 见 pi-provider-repair.ts）。
 *
 * MF-5：catalog 已知内置 provider 的空壳不删除，合并 catalog models 修复（条目合法化，
 * name/authMethod 等既有字段保留，模型级 baseUrl 由 catalog 提供）。[W1b 语义变更]
 * QuickSetup 保存的条目含 apiKey 时直接合法、不进修复路径；修复路径仅剩无 apiKey 的
 * catalog 空壳。非 catalog 空壳维持删除语义（外部 fixture 不留存）。
 * MF-6：修复前提是 catalog models 每个模型均有非空 baseUrl（pi modelFromJson 对空 baseUrl
 * 直接 throw，毒化整个 provider 组合且无自愈路径）。catalog models 含空 baseUrl 的 provider
 * （azure-openai-responses）排除出修复名单，维持删除语义；catalog 未来补全 baseUrl 后自动恢复修复。
 *
 * 启动时一次性调用（index.ts cleanLeakedPackages 之后）。幂等：无无效 provider 时不触发写。
 * 永不抛错：失败仅 warn 不阻塞启动（对齐 cleanLeakedPackages ES1 风格）。
 *
 * @returns { removed: string[]; repaired: string[] } 被剔除 / 被修复（合并 models）的 provider id 列表
 */
export function sanitizeInvalidProviders(): { removed: string[]; repaired: string[] } {
  try {
    modelsStore.invalidate()
    const draft: PiModelsConfig = JSON.parse(JSON.stringify(readModels()))
    const removed: string[] = []
    const repaired: string[] = []
    for (const [id, cfg] of Object.entries(draft.providers)) {
      if (isInvalidProvider(cfg)) {
        // catalog 已知内置 provider 的空壳 → 合并 catalog models 修复（保留 name/authMethod
        // 等既有字段；[W1b 语义变更] 含 apiKey 的条目直接合法，不进此分支）。
        // MF-6（R4 review）：catalog models 含空 baseUrl 的 provider 不可修复——pi modelFromJson
        // 对每个自定义模型强制非空 baseUrl（空串非 nullish，`??` 不跳过 → 直接 throw），任一空
        // baseUrl 模型即毒化整个 provider 组合（composeModelProvider 抛错 → pi 回退 builtin base，
        // 用户 apiKey 静默失效且条目 isInvalidProvider===false 无自愈路径）。这类 provider
        // （azure-openai-responses 38/38 模型空 baseUrl）维持删除语义；过滤空 baseUrl 模型会退回
        // models:[] 八字段全缺态再次被删（transient 非法态），合成 baseUrl 不可接受（catalog 无数据）。
        const catalogModels = builtinModelsById.get(id)
        if (catalogModels && catalogModels.length > 0 && catalogModels.every(m => !!m.baseUrl)) {
          draft.providers[id] = { ...cfg, models: catalogModels }
          repaired.push(id)
        } else {
          delete draft.providers[id]
          removed.push(id)
        }
      }
    }
    if (removed.length > 0 || repaired.length > 0) {
      writeModels(draft)
      if (removed.length > 0) {
        console.log('[provider-store] sanitized invalid providers:', removed)
      }
      if (repaired.length > 0) {
        console.log('[provider-store] repaired catalog-known invalid providers (merged builtin models):', repaired)
      }
    }
    return { removed, repaired }
  } catch (e) {
    // best-effort 降级：models.json 异常不阻塞启动（pi 自身加载时也会容错或报错）
    console.warn('[provider-store] sanitizeInvalidProviders failed:', e)
    return { removed: [], repaired: [] }
  }
}

// ── 缓存控制 ─────────────────────────────────────────────────

export function refreshModels(): void {
  modelsStore.invalidate()
}

export function refreshSettings(): void {
  // settings.json 缓存归属 pi-settings-store（D17），这里委托失效。
  invalidateSettingsCache()
}

export function refreshAll(): void {
  refreshModels()
  refreshSettings()
}

// ── Barrel re-export（Phase 1 拆分：保 import 路径不变）──────────────────
// 以下函数已拆到 pi-maintenance / pi-enabled-models / pi-skill-paths / pi-provider-repair，
// re-export 保 import 路径不变（现有测试零改动即全绿 = 行为零变化证据）。
export { migrateToPiSubdir, isLeakedPackage, cleanLeakedPackages } from './pi-maintenance.js'
export {
  getEnabledModels,
  setEnabledModels,
  clearEnabledModels,
  ensureProviderInWhitelist,
  cleanEnabledModelsResidue,
} from './pi-enabled-models.js'
export {
  getSkillPaths,
  getSkillPathScopes,
  setSkillPaths,
  addSkillPath,
  removeSkillPath,
  migrateSettingsSkillsToDiscovery,
} from './pi-skill-paths.js'
export { isInvalidProvider }
