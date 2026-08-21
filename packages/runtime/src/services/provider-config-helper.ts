/**
 * Provider CRUD + 双体系聚合 helper（从 config-service.ts 抽出，控 max-lines 500）。
 * 含 provider 增删改查 + catalog∪custom 双源聚合 + builtin 模板 + env 检测 + 默认模型。
 * setProvider/listProviders 同属「provider CRUD + 双体系聚合」高内聚（共享 builtin 索引与
 * ProviderInfo 构造逻辑），不再细分。ConfigService 仅保留单行委托，行为/签名/import 零变化
 *（复用 worktree-config-helper accessors 注入模式，依赖经 configStore/authStorage 参数注入）。
 */
// wave 2（WC1）：import inline 方式消费 generated JSON——tsup bundle 把 JSON 打进 index.cjs，
// 避免运行时 fs/路径解析（打包后 asar 路径问题）。tsc 类型检查需 resolveJsonModule（tsconfig.json 已加）。
import builtinData from '../generated/builtin-providers.json'
import { type ProviderInfo, type BuiltinProviderTemplate, type ProviderId } from '@xyz-agent/shared'
import { isCatalogProvider, deriveEnabled } from './provider-catalog.js'
import type { IConfigStore, ConfigModelDefinition, ConfigProviderConfig } from './ports/config.js'
import type { AuthStorage, CredentialWriter } from './auth/auth-storage.js'
import type { XyzProviderStore } from './provider-extras-store.js'
import { readAllExtrasWithFallback, type ProviderExtrasReader } from './migration/provider-extras-migration.js'
import { pickModelCapabilityFields } from './model-mapper.js'

/** auth.json 存储能力（ConfigService 注入，与 ConfigService 构造函数 authStorage 同构）。
 * 不含 'set'——写入唯一经 credentialWriter（A1-4 收口，AuthService.saveCredential）。 */
type AuthStorageAccessors = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'hasCredentialSync' | 'listCredentialIds'>

/** providers.json 存储能力（ConfigService 注入，A1-5 写侧切换）。 */
export type ProviderExtrasAccessors = Pick<XyzProviderStore, 'modify'>

/** setProvider 的入参形状（原 ConfigService.setProvider 内联类型提取，逐字一致）。 */
export type SetProviderInput = {
  name?: string
  type?: string
  apiKey?: string
  authMethod?: 'api_key' | 'oauth' | 'env_var' | 'ambient'
  baseUrl?: string
  /** provider 级自定义请求头（B-4a，pi ProviderConfigSchema 内字段）。 */
  headers?: Record<string, string>
  /** 是否把 apiKey 写入 Authorization header（B-4a，pi ProviderConfigSchema 内字段）。 */
  authHeader?: boolean
  models?: Array<string | { id: string; name?: string; api?: string; baseUrl?: string; reasoning?: boolean; maxTokens?: number; contextWindow?: number; input?: Array<'text' | 'image'>; thinkingLevelMap?: Record<string, string | null>; enabled?: boolean; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }> }; headers?: Record<string, string>; compat?: Record<string, unknown> }>
  enabled?: boolean
}

/**
 * builtin provider id → models 索引（T9/M5：listProviders 合并兜底用）。
 * builtinData 是模块级 JSON import（单例缓存），此索引避免每次 listProviders 线性扫描 37 个 provider。
 */
const builtinModelsById = new Map<string, BuiltinProviderTemplate['models']>(
  // JSON import 推断类型与声明类型有差异（同 listBuiltinProviders 的浅校验后断言处理）
  (builtinData.providers ?? []).map(p => [p.id, p.models] as [string, BuiltinProviderTemplate['models']]),
)

/**
 * BuiltinModelSummary → ProviderInfo.models 元素形状（T9 合并兜底用）。
 * 差异：BuiltinModelSummary.input 是 string[]（恒输出 11 键），ProviderInfo 元素 input 是
 * Array<'text' | 'image'>——过滤 + null→undefined 归一。
 * A1-3：builtin 副本同样应用 modelStates（providers.json 模型启停对 catalog 内置模型
 * 生效）；有值才设 enabled（与 builtin 模板无 enabled 字段的现状一致，消费方
 * `enabled !== false` 兼容 undefined）。
 */
function toProviderModel(
  m: BuiltinProviderTemplate['models'][number],
  modelStates?: Record<string, { enabled: boolean }>,
): ProviderInfo['models'][number] {
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    baseUrl: m.baseUrl,
    reasoning: m.reasoning,
    input: m.input.filter((v): v is 'text' | 'image' => v === 'text' || v === 'image'),
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens ?? undefined,
    thinkingLevelMap: m.thinkingLevelMap ?? undefined,
    compat: m.compat ?? undefined,
    ...(modelStates?.[m.id] !== undefined ? { enabled: modelStates[m.id].enabled } : {}),
  }
}

/** builtin provider id → 完整模板索引（wave2 catalog 源聚合用，builtinModelsById 只索引 models 不够）。 */
const builtinProvidersById = new Map<string, BuiltinProviderTemplate>(
  (builtinData.providers ?? []).map(p => [p.id, p as unknown as BuiltinProviderTemplate]),
)

/**
 * ConfigModelDefinition → ProviderInfo.models 元素（wave2 双源共用，提取 custom 内联逻辑避免重复）。
 * A1-3 读源切换：model 级 enabled 以 providers.json modelStates 优先（迁移后唯一来源），
 * models.json m.enabled 兜底（迁移失败窗口 + setProvider 仍写 m.enabled 的写侧残留路径）。
 */
function toUserInfoModel(
  m: ConfigModelDefinition,
  modelStates?: Record<string, { enabled: boolean }>,
): ProviderInfo['models'][number] {
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    baseUrl: m.baseUrl,
    input: m.input,
    compat: m.compat,
    enabled: modelStates?.[m.id]?.enabled ?? (m.enabled !== false),
    ...pickModelCapabilityFields(m),
  }
}

/**
 * 按 models.json config 推断 authMethod（I6：$开头→env_var / 非空→api_key）。
 * 显式标注（extras.authMethod，providers.json 优先 + models.json 旧字段兜底）在聚合层
 * 优先于本推断（A1-3）；本函数不再读 config.authMethod——双读回退已覆盖该值，且
 * 「providers.json 已有条目时丢弃 models.json 旧值」的合并策略要求标注不穿透
 * （防 stale 旧值复活）。config 缺省→undefined。
 */
function deriveAuthMethod(config?: ConfigProviderConfig): ProviderInfo['authMethod'] {
  if (!config) return undefined
  return typeof config.apiKey === 'string' && config.apiKey.startsWith('$')
    ? 'env_var' as const
    : config.apiKey ? 'api_key' as const : undefined
}

/** Runtime type guard for thinkingLevelMap values. */
function isValidThinkingLevelMap(v: unknown): v is Record<string, string | null> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every(val => val === null || typeof val === 'string')
}

/**
 * headers 校验 + prototype-pollution 清洗（B-4a/B-4b，对齐 compat 的 sanitize 模式：
 * 类型守卫通过后、赋值前剔除 __proto__/prototype/constructor）。
 * 与 compat 的差异：headers 契约是 Record<string, string>，value 非 string 直接 throw
 * （pi schema Type.Record(String, String)——静默剔除坏 value 会让「保存成功但 header 丢失」
 * 无从排查）；compat value 是 unknown 只剔 undefined。
 */
function sanitizeHeaders(v: unknown, ctx: string): Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`Invalid ${ctx}: expected Record<string, string>`)
  }
  const sanitized: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue
    if (typeof val !== 'string') {
      throw new Error(`Invalid ${ctx}: value of "${k}" must be a string`)
    }
    sanitized[k] = val
  }
  return sanitized
}

/**
 * model 级 cost 校验（B-4b）。pi 0.84.1 ModelDefinitionSchema 的 cost 四字段是必填
 * `Type.Number()`（model-config.js ModelCostSchema）——缺字段或非法类型写入会让 pi 拒载
 * 整个 models.json，故此处 throw 而非静默丢弃。非负校验：价格为负无业务语义。
 * tiers 可选透传（存在时必须是数组，元素结构由 pi schema 自行把关）。
 */
function sanitizeModelCost(v: unknown, ctx: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`Invalid ${ctx}: expected an object with input/output/cacheRead/cacheWrite numbers`)
  }
  const raw = v as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    const val = raw[field]
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
      throw new Error(`Invalid ${ctx}: field "${field}" must be a non-negative number`)
    }
    result[field] = val
  }
  if (raw.tiers !== undefined) {
    if (!Array.isArray(raw.tiers)) {
      throw new Error(`Invalid ${ctx}: "tiers" must be an array`)
    }
    result.tiers = raw.tiers
  }
  return result
}

// ── 默认模型 ──

export function getDefaultModel(configStore: IConfigStore): { provider: ProviderId; modelId: string } | null {
  return configStore.getDefaultModel()
}

export function setDefaultModel(configStore: IConfigStore, provider: ProviderId, modelId: string): void {
  configStore.setDefaultModel(provider, modelId)
}

// ── Provider 列举 / 查询 ──

/**
 * catalog ∪ custom 双源聚合 provider 列表。
 * 纯函数：configStore / authStorage / extrasStore 经参数注入（原 ConfigService.listProviders 搬迁）。
 *
 * A1-3 读源切换：xyz 私有字段（authMethod 显式标注 / quota / modelStates 模型启停）
 * 经 readAllExtrasWithFallback 双读——providers.json 优先 + models.json 旧寄生字段兜底
 * （迁移失败窗口兼容）。未注入 extrasStore 时 extras 恒空：authMethod 退回 apiKey 推断、
 * quota 为 undefined（与迁移后 models.json 已剥离寄生字段的读值一致）。
 */
export function listProviders(
  configStore: IConfigStore,
  authStorage?: AuthStorageAccessors,
  extrasStore?: ProviderExtrasReader,
): ProviderInfo[] {
  const models = configStore.readModels()
  const enabledModels = configStore.getEnabledModels()
  const extrasAll = extrasStore ? readAllExtrasWithFallback(extrasStore, configStore) : {}
  const authIds = authStorage?.listCredentialIds() ?? []
  const authIdSet = new Set(authIds)

  const result: ProviderInfo[] = []
  // catalog id 去重集合：catalog 源处理过的 id，custom 源跳过（避免 catalog id 重复出现）
  const catalogIdsHandled = new Set<string>()

  // ── catalog 源：(auth.json keys ∪ models.json catalog keys) ∩ builtinData（F1 修复核心）──
  // 旧实现只遍历 models.json providers，catalog 凭据在 auth.json（models.json 无条目）时不显示。
  // 现聚合 auth.json 有凭据的 catalog provider，即使 models.json 无该条目也显示。
  const catalogCandidateIds = new Set<string>()
  for (const id of authIds) {
    if (isCatalogProvider(id)) catalogCandidateIds.add(id)
  }
  for (const [id] of Object.entries(models.providers)) {
    if (isCatalogProvider(id)) catalogCandidateIds.add(id)
  }

  for (const id of catalogCandidateIds) {
    const builtinP = builtinProvidersById.get(id)
    if (!builtinP) continue // 只聚合 builtin 内的 catalog provider（∩ builtinData）
    catalogIdsHandled.add(id)
    const override = models.providers[id]
    const hasOverride = !!override
    // A1-3：xyz 私有字段读 providers.json（双读回退，models.json 寄生字段仅兜底）
    const extras = extrasAll[id]
    // C1 契约「catalog 凭据 = id ∈ auth.json keys」；override?.apiKey 是 catalog provider
    // 手动填 key 的旧数据（迁移前错位）合理扩展，双源判定避免遗漏。
    const apiKeySet = authIdSet.has(id) || !!override?.apiKey
    const overrideModels = override?.models ?? []
    // B-2 聚合层配合（design §3.6）：混合合并——builtin 副本（未被 override 同 id 覆盖的）
    // + override 条目，替换旧「override 非空即整体替换」。旧逻辑与 pi 真实行为漂移：pi 侧
    // catalog override 与内置目录合并显示、内置模型恒在（design D1 探针实测）。source 在
    // 合并点标注（不做事后猜测）：override 条目（含同 id 覆盖 builtin 的）标 'override'——
    // 它已被用户定义覆盖；builtin 副本条目标 'builtin'。builtin 在前与 design §3.1 场景 A
    // 的混合列表形态一致（内置在前、自定义追加在后）。
    const overrideIds = new Set(overrideModels.map(m => m.id))
    const builtinNotOverridden = (builtinP.models ?? []).filter(m => !overrideIds.has(m.id))
    // id 来自 models.json / auth.json 的磁盘 key（反序列化边界，design D5）→ as ProviderId 提升
    result.push({
      id: id as ProviderId,
      name: override?.name || builtinP.name || id,
      api: override?.api ?? builtinP.api,
      baseUrl: override?.baseUrl ?? builtinP.baseUrl,
      apiKeySet,
      // 显式标注（extras.authMethod）优先；无标注退回 apiKey 格式推断（I6）
      authMethod: extras?.authMethod ?? deriveAuthMethod(override),
      // catalog 凭据在 auth.json：apiKeySet 已含 auth.json 判定（authIdSet.has(id)），
      // 与旧 status 逻辑（hasCredentialSync(id)）等价，避免重复读 auth.json。
      status: apiKeySet ? 'connected' as const : 'not_configured' as const,
      models: [
        ...builtinNotOverridden.map(m => ({ ...toProviderModel(m, extras?.modelStates), source: 'builtin' as const })),
        ...overrideModels.map(m => ({ ...toUserInfoModel(m, extras?.modelStates), source: 'override' as const })),
      ],
      // DM3：enabled 从 enabledModels 派生，不读 models.json provider.enabled（F2）
      enabled: deriveEnabled(id, enabledModels),
      kind: 'catalog' as const,
      hasOverride,
      quota: extras?.quota,
    })
  }

  // ── custom 源：models.json providers where !isCatalogProvider(id)（保留旧逻辑，kind='custom'）──
  // catalogIdsHandled 已收录 models.json 里的 catalog 条目（上面聚合时加入），此处跳过避免重复。
  for (const [id, config] of Object.entries(models.providers)) {
    if (catalogIdsHandled.has(id)) continue
    // A1-3：xyz 私有字段读 providers.json（双读回退，models.json 寄生字段仅兜底）
    const extras = extrasAll[id]
    const userModels = (config.models ?? []).map(m => toUserInfoModel(m, extras?.modelStates))
    const apiKeySet = !!config.apiKey
    // id 来自 models.json 的磁盘 key（反序列化边界，design D5）→ as ProviderId 提升
    result.push({
      id: id as ProviderId,
      name: config.name || id,
      // W2：回填 provider 级 api 字段，修复前端编辑 provider 时 type 下拉丢失（P0-1）
      api: config.api,
      baseUrl: config.baseUrl,
      apiKeySet,
      // 显式标注（extras.authMethod）优先；无标注退回 apiKey 格式推断（I6）
      authMethod: extras?.authMethod ?? deriveAuthMethod(config),
      // M6 status 派生：apiKey 或 auth.json 凭据任一 → connected。
      // B3：复用 authIdSet（listProviders 开头批量读），消除每次循环 hasCredentialSync 的 N+1 读盘。
      status: (config.apiKey || authIdSet.has(id))
        ? 'connected' as const
        : 'not_configured' as const,
      // T9/M5 models 合并：用户自定义 models 非空 → 保留；为空 → builtin models 兜底
      models: userModels.length > 0
        ? userModels
        : (builtinModelsById.get(id)?.map(m => toProviderModel(m, extras?.modelStates)) ?? userModels),
      // DM3：enabled 从 enabledModels 派生，不读 models.json provider.enabled（F2）
      enabled: deriveEnabled(id, enabledModels),
      kind: 'custom' as const,
      quota: extras?.quota,
    })
  }

  return result
}

/**
 * 列出内置 provider 模板（wave 2，import generated JSON，无参只读，纯函数）。
 * builtinData 模块级 import 即缓存，不触 ConfigStore 依赖。wave 1 生成时已排除 radius。
 *
 * 浅校验 guard（review M-9 修复）：生成物损坏/格式不符（非数组、条目缺 id/name）时
 * 返回空列表（前端隐藏内置入口），不抛错——内置模板是增强能力，坏了不能拖垮 Settings。
 */
export function listBuiltinProviders(): BuiltinProviderTemplate[] {
  const raw = builtinData.providers
  if (!Array.isArray(raw)) {
    console.warn('[config-service] builtin-providers.json malformed (providers is not an array), falling back to empty list')
    return []
  }
  for (const p of raw) {
    if (typeof p !== 'object' || p === null || typeof p.id !== 'string' || typeof p.name !== 'string') {
      console.warn('[config-service] builtin-providers.json malformed (provider missing id/name), falling back to empty list')
      return []
    }
  }
  // JSON import 的推断类型与 BuiltinProviderTemplate 有 optional 字段差异，浅校验后断言
  return raw as unknown as BuiltinProviderTemplate[]
}

export function checkEnvVars(names: string[]): Record<string, boolean> {
  // 去重（I3 契约）+ 空串不算已设置（env 值为空串时 pi resolveConfigValue 同样视为未配置）
  const results: Record<string, boolean> = {}
  for (const name of new Set(names)) {
    const value = process.env[name]
    results[name] = value !== undefined && value !== ''
  }
  return results
}

export function getProvider(configStore: IConfigStore, providerId: string): { apiKey?: string; name?: string; type?: string; baseUrl?: string; models?: unknown[]; enabled?: boolean } | undefined {
  return configStore.getProviderConfig(providerId)
}

// ── Provider 增删改 ──

/**
 * 新建 / 更新 provider（wave3 边界1 白名单守卫 + I9 auth.json 清理 + catalog 分体系）。
 * 纯函数：configStore / authStorage / extrasStore / credentialWriter 经参数注入
 * （原 ConfigService.setProvider 逐字搬迁）。
 *
 * A1-5 写侧切换：authMethod 写 config/providers.json（extrasStore），不再寄生 models.json；
 * quota 分支已删除（历史死分支，无前端调用方——防复活，quota 配置唯一写路径是
 * QuotaService.configure → providers.json）。
 * A1-4 收口：catalog apiKey 写入经 credentialWriter（AuthService.saveCredential），
 * 不再直接持有 authStorage.set。
 */
export async function setProvider(
  configStore: IConfigStore,
  authStorage: AuthStorageAccessors | undefined,
  extrasStore: ProviderExtrasAccessors | undefined,
  credentialWriter: CredentialWriter | undefined,
  providerId: string,
  data: SetProviderInput,
): Promise<{ newDefault?: { provider: ProviderId; modelId: string } }> {
  // wave3：existingConfig===undefined 判定「新建 provider」（边界1 白名单守卫用）
  const existingConfig = configStore.getProviderConfig(providerId)
  const existing = existingConfig ?? {}
  // A1：merged 提前声明——catalog 分支 delete merged.apiKey 需在声明之后（原顺序触发 TDZ TS2448/2454）
  // TODO: 当 pi models.json 支持 schema 后收窄类型（现有 Record<string, unknown> 是架构限制）
  const merged: Record<string, unknown> = { ...existing }
  // I9 清理① + catalog 分体系：
  // - catalog provider：apiKey 归 auth.json (api_key overwrites oauth natively)
  // - custom provider：apiKey 写 models.json，清 auth.json oauth (I9 cleanup)
  if (data.apiKey !== undefined && data.apiKey !== '') {
    if (isCatalogProvider(providerId) && credentialWriter) {
      // catalog provider: apiKey → auth.json (0600), strip from models.json
      // A1-4 收口：写入经 credentialWriter（AuthService.saveCredential），authStorage.set
      // 的直接调用全 runtime 只剩 auth-service.ts 内部。
      // MF-1（stale 广播 + 静默丢 key）：await 落盘后再 delete merged.apiKey +
      // upsertProvider。fire-and-forget 时 withFileLock 未落盘 → handler 同步返回后
      // broadcastProviderList 裸读 auth.json 拿到 stale（catalog 显示 not_configured）；
      // 且写失败只 warn，apiKey 既未进 auth.json 又已从 models.json 删 → 凭据静默丢失。
      // await 后失败直接 reject 上抛（handler try-catch 转 sendError），不静默吞、不 stale 广播。
      // 与 deleteProvider/removeProviderByKind 的 cleanAuthCredential await 对称（写入路径对齐删除路径）。
      await credentialWriter.saveCredential(providerId, { type: 'api_key', key: data.apiKey })
      // Don't write apiKey to models.json for catalog providers
      delete merged.apiKey
    } else {
      // custom provider or no authStorage: keep existing behavior (apiKey in models.json)
      // I9: clear oauth credential before writing apiKey (fire-and-forget)
      void authStorage?.remove(providerId).catch(err => {
        console.warn(`[config-service] auth.json oauth cleanup failed for ${providerId} (I9 清理①):`, err)
      })
    }
  }
  // M5-01（P0，pi-alignment 决策 1）：catalog provider 的 apiKey 只归 auth.json——上面
  // delete merged.apiKey 后若此处无条件 re-add，apiKey 会双写进 models.json（G5 迁移
  // 的安全动机被此路径持续回填）。仅非 catalog 分支写回；catalog + 无 credentialWriter 时
  // apiKey 无处安放（凭据只允许落 auth.json 0600），宁丢不写错位（生产恒注入）。
  if (data.apiKey !== undefined && !isCatalogProvider(providerId)) merged.apiKey = data.apiKey as string
  // I6 + A1-5 写侧切换：authMethod 写 config/providers.json（不再寄生 models.json）。
  // await（对齐上方 catalog apiKey 的 MF-1 语义）：modify 失败直接 reject 上抛，handler
  // try-catch 转 sendError，不静默吞、不 stale 广播。extrasStore 未注入时丢弃 + warn
  // （宁丢不写错位——生产恒注入，与 catalog apiKey 无 authStorage 时的处理对称）。
  if (data.authMethod !== undefined) {
    if (extrasStore) {
      const authMethod = data.authMethod
      await extrasStore.modify(providerId, current => ({ ...current, authMethod }))
    } else {
      console.warn(`[config-service] authMethod dropped for ${providerId}: providerExtrasStore not injected (A1-5)`)
    }
  }
  if (data.baseUrl !== undefined) merged.baseUrl = data.baseUrl as string
  if (data.type !== undefined) merged.api = configStore.applyTypeTranslation(data.type as string)
  if (data.name !== undefined) merged.name = data.name as string
  // B-4a 断链修复（design §2.1 场景 D）：headers/authHeader 是 pi ProviderConfigSchema 内
  // 字段，写入 models.json provider 条目。跟随 baseUrl/name 的 merged 赋值模式：undefined =
  // 不变（base spread 保留既有值），显式传值才覆盖——headers 传空对象 {} 即清空（pi schema
  // Type.Record 允许空对象；null 不在契约内，由 sanitizeHeaders 拒绝）。不做 apiKey 式
  // __CLEAR__ 哨兵：apiKey 需要 '' 哨兵是因 string 空串已被复用，对象 {} 天然可作清空值。
  if (data.headers !== undefined) {
    merged.headers = sanitizeHeaders(data.headers, `headers for provider "${providerId}"`)
  }
  if (data.authHeader !== undefined) {
    if (typeof data.authHeader !== 'boolean') {
      throw new Error(`Invalid authHeader for provider "${providerId}": must be a boolean`)
    }
    // boolean 不能用 truthiness 判定：显式 false 是合法值（关闭 Authorization header 注入）
    merged.authHeader = data.authHeader
  }
  // wave3 C5/TC6：停用 provider 级 enabled 写入——provider 启用改由 enabledModels 白名单承载
  // （wave2 listProviders 已不读 models.json provider.enabled）。前端 onToggleEnabled 改走
  // toggleProviderEnabled（wave4），不再传 data.enabled 给 setProvider。data.enabled 参数声明保留
  // （向后兼容），但不写入 models.json。model 级 enabled（下文 model 合并逻辑）保留。
  // A1-5：quota 写入分支已删除（历史死分支：无前端调用方传 quota；quota 配置唯一写路径是
  // QuotaService.configure → config/providers.json）。禁止恢复经 setProvider 写 models.json quota。
  if (data.models !== undefined) {
    const rawModels = data.models as Array<Record<string, unknown>>
    const existingModels = (existing.models ?? []) as ConfigModelDefinition[]
    // G3 写侧切换：model 级 enabled 收集到 providers.json modelStates（下方 modify 落盘），
    // 不再写 models.json（pi schema 外寄生字段）。
    const modelStatesUpdates: Record<string, { enabled: boolean }> = {}
    merged.models = rawModels.map(m => {
      const id = String(m.id ?? '')
      const base = existingModels.find(em => em.id === id) ?? {} as Partial<ConfigModelDefinition>
      const model: Record<string, unknown> = { ...base, id }
      if (m.name) model.name = String(m.name)
      if (typeof m.contextWindow === 'number') model.contextWindow = m.contextWindow
      if (Array.isArray(m.input)) {
        model.input = (m.input as unknown[]).filter(
          (v): v is 'text' | 'image' => v === 'text' || v === 'image',
        )
      }
      if (isValidThinkingLevelMap(m.thinkingLevelMap)) {
        model.thinkingLevelMap = m.thinkingLevelMap
      } else if (m.thinkingLevelMap === undefined && base.thinkingLevelMap) {
        // buildMap() returned undefined (all passthrough) → remove from model
        delete model.thinkingLevelMap
      }
      // review must_fix #1：前端回传的 model 级 api/baseUrl 必须写回，
      // 否则编辑保存即丢失（新模型 base={} 全丢，编辑现有模型被 base 旧值覆盖）。
      // 对齐 provider 级的「if (m.X !== undefined) model.X = ...」模式。
      // enabled 例外（G3）：pi schema 外寄生字段不写 models.json，迁 providers.json
      // modelStates——base 残留的旧 enabled（迁移失败窗口数据）一并剥除，保证本
      // 路径不再序列化该字段进 models.json。
      delete model.enabled
      if (typeof m.enabled === 'boolean' && id) {
        modelStatesUpdates[id] = { enabled: m.enabled }
      }
      if (typeof m.api === 'string') model.api = m.api
      if (typeof m.baseUrl === 'string') model.baseUrl = m.baseUrl
      // B-4b 模型写入白名单补全：reasoning/maxTokens/cost/headers 全是 pi
      // ModelDefinitionSchema 内字段（0.84.1 model-config.js），此前白名单缺失导致前端
      // 回传即丢。undefined = 不变（base spread 保留）；显式传值走校验，非法值 throw
      // 上抛（handler try-catch 转 sendError）而非静默丢弃——静默会让「保存成功但参数
      // 丢失」无从排查。与存量字段（name/contextWindow 等的静默忽略）模式不同：新字段
      // 从第一天就走校验路径，存量字段保持行为兼容不动。
      if (m.reasoning !== undefined) {
        if (typeof m.reasoning !== 'boolean') {
          throw new Error(`Invalid reasoning for model "${id}": must be a boolean`)
        }
        model.reasoning = m.reasoning
      }
      if (m.maxTokens !== undefined) {
        if (typeof m.maxTokens !== 'number' || !Number.isInteger(m.maxTokens) || m.maxTokens <= 0) {
          throw new Error(`Invalid maxTokens for model "${id}": must be a positive integer`)
        }
        model.maxTokens = m.maxTokens
      }
      if (m.cost !== undefined) {
        // 四字段必填对齐 pi ModelCostSchema（缺字段写入 → pi 拒载整个 models.json）
        model.cost = sanitizeModelCost(m.cost, `cost for model "${id}"`)
      }
      if (m.headers !== undefined) {
        // 清空语义对齐 provider 级：传 {} 即清空（pi Record 允许空对象）
        model.headers = sanitizeHeaders(m.headers, `headers for model "${id}"`)
      }
      // compat 透传：前端 compat 编辑器回传的兼容性覆盖必须写回，
      // 否则编辑保存即丢失用户手动配置的 compat（隐性数据丢失 bug）。
      // 类型守卫对齐 isValidThinkingLevelMap：必须排除 null（typeof null === 'object'）
      // 与数组（typeof [] === 'object'），否则下游遍历 null 会崩或把数组当对象写入。
      if (m.compat != null && typeof m.compat === 'object' && !Array.isArray(m.compat)) {
        // sanitize compat（守卫通过后、赋值前）：
        // - 剔除 __proto__/prototype/constructor 防 prototype pollution（compat 类型是
        //   Record<string, unknown> 前向兼容扩展点，不能假定 key 安全）
        // - 剔除 undefined value（避免 JSON 序列化丢 key 造成困惑）
        // 不做 key 白名单：compat schema 未稳定，白名单会限制前向扩展。
        const sanitized: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(m.compat)) {
          if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue
          if (v === undefined) continue
          sanitized[k] = v
        }
        model.compat = sanitized
      } else if (m.compat === undefined && base.compat) {
        // 前端 clearAll 发 undefined → 删除盘上已有的 compat（对齐 thinkingLevelMap undefined 分支），
        // 否则 base spread 会保留旧 compat，导致「清除所有 compat」按钮失效。
        delete model.compat
      }
      return model as unknown as ConfigModelDefinition
    })
    // G3 写侧切换：model 级 enabled 落 providers.json modelStates（RMW 合并，只覆写本次
    // 回传的 model 条目，其余 modelStates 保留）。await 对齐 authMethod 的 MF-1 语义：
    // modify 失败 reject 上抛（handler try-catch 转 sendError），不静默吞。extrasStore
    // 未注入时丢弃 + warn（宁丢不写错位——生产恒注入）。
    if (Object.keys(modelStatesUpdates).length > 0) {
      if (extrasStore) {
        await extrasStore.modify(providerId, current => ({
          ...current,
          modelStates: { ...current?.modelStates, ...modelStatesUpdates },
        }))
      } else {
        console.warn(`[config-service] model enabled states dropped for ${providerId}: providerExtrasStore not injected (G3 写侧切换)`)
      }
    }
  }
  const result = configStore.upsertProvider(providerId, merged)
  // 边界1（wave3 TC5 / C2）：新建 provider 时若 enabledModels 非空，加 <id>/* 白名单守卫——
  // 否则在白名单语义下新 provider 默认不启用。existingConfig===undefined 判定新建（与 importer
  // applyImport 的 upsertProvider 后守卫对称，共用水台函数 ensureProviderInWhitelist）。
  if (existingConfig === undefined) {
    configStore.ensureProviderInWhitelist(providerId)
  }
  return result
}

/**
 * 切换 provider 启用状态（wave3 IF2 / C1）——写 enabledModels 白名单。
 * 纯函数：configStore 经参数注入（原 ConfigService.toggleProviderEnabled 逐字搬迁）。
 *
 * enabled=true: 若 enabledModels 非空，加 `<id>/*`；空/undefined 时 no-op（CL1——
 *   全可用语义下 toggle(true) 无意义，加 pattern 反把其他 provider 隐式禁用）。
 * enabled=false: 移除所有 `<id>/*` 和 `<id>/<model>` pattern（provider 级 + model 级全清）。
 *   - 边界3（TC3）：重算后空 → clearEnabledModels（delete 字段，CL2），非 setEnabledModels([])。
 *   - 边界2（TC4）：若 defaultModel 承载该 provider，重选启用 provider 的 model + setDefaultModel，
     返回 newDefault 供前端同步。
 *
 * @returns 触发 defaultModel 重选时含 newDefault；否则空对象。
 */
export function toggleProviderEnabled(
  configStore: IConfigStore,
  authStorage: AuthStorageAccessors | undefined,
  extrasStore: ProviderExtrasReader | undefined,
  providerId: string,
  enabled: boolean,
): { newDefault?: { provider: ProviderId; modelId: string } } {
  const current = configStore.getEnabledModels()

  if (enabled) {
    // CL1：全可用（空/undefined）时 no-op——此时所有 provider 已启用，加 pattern 反而禁用其他
    if (current.length === 0) return {}
    const pattern = `${providerId}/*`
    if (current.includes(pattern)) return {} // 幂等
    configStore.setEnabledModels([...current, pattern])
    return {}
  }

  // enabled === false：移除所有 <id>/* 与 <id>/<model> pattern（startsWith('<id>/') 统一匹配两者）
  const prefix = `${providerId}/`
  const remaining = current.filter(p => !p.startsWith(prefix))
  if (remaining.length === current.length) {
    // 无 pattern 被移除（provider 不在白名单 / 白名单空）——幂等 no-op
    return {}
  }
  // 边界2（TC4）：先读 default 再更新白名单。生产 PiConfigStore.getDefaultModel 内部
  // findValidDefaultModel 会 auto-fix 写回（wasFixed:true）——若先更新白名单再读，被禁用
  // 的 default provider 已触发 auto-fix 重选（oldDefault 变成别的 provider），下方
  // oldDefault.provider === providerId 恒 false，pickEnabledDefaultModel 的 B1 凭据优先
  // 重选不可达（M5-02）。白名单更新前读取时该 provider 仍启用，default 若承载它返回原值。
  const oldDefault = configStore.getDefaultModel()
  // 边界3（TC3）：重算后空 → delete 字段（CL2），非写空数组（pi 语义空=全可用，写 [] 语义反转）；
  // 非空 → 写回新白名单
  if (remaining.length === 0) {
    configStore.clearEnabledModels()
  } else {
    configStore.setEnabledModels(remaining)
  }

  if (oldDefault && oldDefault.provider === providerId) {
    // 若 defaultModel 承载被禁用的 provider，显式「重选 + 持久化」（否则 pi session
    // scopedModels 不含该 provider，defaultModel 与 scope 错位）。复用 listProviders
    //（wave2 双源聚合 + deriveEnabled + B1 凭据优先）选新 default 并 setDefaultModel 写回，
    // 不依赖 getDefaultModel 的惰性 auto-fix（其 fallback 只扫 models.json，看不到
    // auth.json-only 的 catalog provider）。
    const newDefault = pickEnabledDefaultModel(configStore, authStorage, extrasStore, providerId)
    if (newDefault) {
      configStore.setDefaultModel(newDefault.provider, newDefault.modelId)
      return { newDefault }
    }
  }
  return {}
}

/**
 * 边界2 重选 defaultModel（wave3 TC4）：从启用 provider 中选首个有 model 的。
 *
 * 复用 listProviders（wave2：catalog ∪ custom 双源聚合 + deriveEnabled 派生 enabled），
 * 避免重复实现聚合/凭据/catalog 兜底逻辑。excludedId 跳过被禁用的 provider 自身。
 * 返回 undefined 表示无可用启用 provider（UI 层 wave4 拒绝禁用最后一个）。
 */
function pickEnabledDefaultModel(
  configStore: IConfigStore,
  authStorage: AuthStorageAccessors | undefined,
  extrasStore: ProviderExtrasReader | undefined,
  excludedId: string,
): { provider: ProviderId; modelId: string } | undefined {
  const providers = listProviders(configStore, authStorage, extrasStore)
  // B1：优先选有凭据（apiKeySet）的启用 provider 作 default，
  // 避免重选到无凭据的 catalog provider（用户禁用某 provider 触发重选时）。
  // 有凭据优先，找不到再 fallback 到任意启用 provider（含 ambient 认证如 bedrock）。
  // MF-3：候选 provider 选 model 时校验 model 级 enabled——p.models[0] 可能被用户显式禁用
  //（enabled:false，listProviders 经 toUserInfoModel 透传该字段），旧实现只校验 provider 级
  // p.enabled + p.models[0] 存在性，会把已禁用 model 写成新 default。改为 find 首个启用 model。
  const candidates = providers
    .filter(p => p.id !== excludedId && p.enabled)
    .map(p => ({ p, m: p.models.find(m => m.enabled !== false) }))
    .filter(x => x.m)
  const withCred = candidates.find(x => x.p.apiKeySet)
  if (withCred) return { provider: withCred.p.id, modelId: withCred.m!.id }
  const any = candidates[0]
  return any ? { provider: any.p.id, modelId: any.m!.id } : undefined
}

/**
 * 清 auth.json 凭据（api_key / oauth token），失败仅 console.warn 不抛出。
 *
 * 设计约束：auth.json 清理是 provider 删除的「附带卫生操作」（主语义是 models.json
 * 条目/override 删除），凭据清理失败不应阻断删除主流程，故 try-catch 吞错只记 warn。
 *
 * 必须 await（而非 fire-and-forget）：AuthStorage.remove 内部 withFileLock（proper-lockfile）
 * 是真异步，fire-and-forget 时锁尚未获取、auth.json 未改写，紧随其后的 broadcastProviderList
 * → listProviders 会读到旧凭据，导致 catalog provider 删除后首次广播仍含该 provider。
 */
async function cleanAuthCredential(
  authStorage: AuthStorageAccessors | undefined,
  providerId: string,
  ctx: string,
): Promise<void> {
  if (!authStorage) return
  try {
    await authStorage.remove(providerId)
  // eslint-disable-next-line taste/no-silent-catch -- 凭据清理失败不阻断删除主流程（条目删除是主语义），warn 记录便于诊断
  } catch (err) {
    console.warn(`[config-service] auth.json cleanup failed ${ctx}:`, err)
  }
}

/**
 * 删除 provider（I8：await 清 auth.json 凭据）。
 * 纯函数：configStore / authStorage 经参数注入（原 ConfigService.deleteProvider 逐字搬迁）。
 */
export async function deleteProvider(
  configStore: IConfigStore,
  authStorage: AuthStorageAccessors | undefined,
  providerId: string,
): Promise<{ removed: boolean; newDefault?: { provider: ProviderId; modelId: string } }> {
  // I8：删 provider 后 await 清 auth.json 凭据（OAuth token 强绑定，不能残留）。
  // 幂等：auth.json 无该 provider 时 no-op。顺序：先删条目（同步生效）→ 再 await 清凭据，
  // 保证 handler await 返回时条目+凭据都已清，broadcastProviderList 拿到干净列表。
  const result = configStore.removeProvider(providerId)
  // M5-05（决策 4「清残留」不变式）：与 removeProviderByKind 两分支对齐——删 provider 后清
  // enabledModels 残留 <id>/* 与 <id>/<model> pattern，否则列表/白名单残留已删 provider 的
  // 死引用（legacy RPC config.deleteProvider 路径）。
  configStore.cleanEnabledModelsResidue(providerId)
  await cleanAuthCredential(authStorage, providerId, `(I8) ${providerId}`)
  return result
}

/**
 * 按体系移除 provider（wave4 IF3 / C2）——catalog 与 custom 分体系处理。
 * 纯函数：configStore / authStorage 经参数注入（原 ConfigService.removeProviderByKind 逐字搬迁）。
 *
 * 与 deleteProvider 的区别：deleteProvider 不分体系直接 configStore.removeProvider（向后兼容
 * 保留）；removeProviderByKind 按 ProviderInfo.kind 收窄，避免误删 catalog 定义。
 *
 * - catalog：定义来自 pi 二进制内置（不可删），只清用户侧状态——auth.json 凭据
 *   （authStorage.remove）+ models.json override 条目（configStore.removeProvider 若有 override）
 *   + enabledModels 残留。清后该 catalog provider 凭据全无，listProviders 双源聚合不再显示。
 * - custom：定义全在 models.json，删条目即删定义——configStore.removeProvider + 清残留。
 *
 * newDefault：configStore.removeProvider 内部在 default 承载被删 provider 时重选并返回
 * （wave3 既有行为），透传给 transport 层广播 config.defaults。
 *
 * @param kind ProviderInfo.kind（renderer 传入，wave2 聚合层权威标注）
 */
export async function removeProviderByKind(
  configStore: IConfigStore,
  authStorage: AuthStorageAccessors | undefined,
  extrasStore: ProviderExtrasReader | undefined,
  providerId: string,
  kind: 'catalog' | 'custom',
): Promise<{ removed: boolean; newDefault?: { provider: ProviderId; modelId: string } }> {
  if (kind === 'catalog') {
    // 清 models.json override 条目（若有）。无 override 时 removeProvider 返回 { removed: false }，
    // 不影响后续清残留——catalog 的「移除」语义是清用户侧状态，override 本就可能不存在。
    // MF-2（顺序缺陷）：预读 oldDefault 在所有 mutation 之前（removeProvider /
    // cleanEnabledModelsResidue）。生产 PiConfigStore.getDefaultModel 内部 findValidDefaultModel
    // 会 auto-fix 写回（wasFixed）——若在 cleanEnabledModelsResidue（白名单变更）之后读取，
    // 被删 catalog provider 的白名单 pattern 已被清除触发 auto-fix 重选，oldDefault.provider
    // 已变成别的 provider，下方 oldDefault.provider === providerId 恒 false，M5-03 显式 B1
    // 凭据优先重选（pickEnabledDefaultModel）不可达。与 toggleProviderEnabled（先读 default 再
    // 更新白名单）顺序对齐。override 分支（removeProvider 返回 removed:true）内部自重选 default，
    // 不消费 oldDefault，预读对其无影响（无 override 时 removeProvider 返回 removed:false 不 mutate）。
    const oldDefault = configStore.getDefaultModel()
    // MF1 修复（exec-review must-fix）：catalog override 承载 defaultModel 时 removeProvider 内部
    // 重选 default + mutate settings.json，透传 newDefault 让 handler 广播 config.defaults
    // （与 custom 分支 + deleteProvider 对称，否则 renderer 收不到重选通知）。
    let overrideResult = configStore.removeProvider(providerId)
    configStore.cleanEnabledModelsResidue(providerId)
    // M5-03（G2 增删入口自动维护 defaultModel）：catalog provider 无 models.json override 时
    // removeProvider 提前 return { removed:false }，跳过 defaultProvider/defaultModel 清理重选
    //（「导入后无 override 的 catalog provider 承载 default」正是 G4 移除流程的常态形态，
    // MF1 修复只覆盖 override 分支）。default 承载该 provider 时显式重选并持久化（复用
    // toggle 边界2 的 pickEnabledDefaultModel，B1 凭据优先），透传 newDefault 广播 config.defaults。
    if (!overrideResult.removed) {
      if (oldDefault && oldDefault.provider === providerId) {
        const newDefault = pickEnabledDefaultModel(configStore, authStorage, extrasStore, providerId)
        if (newDefault) {
          configStore.setDefaultModel(newDefault.provider, newDefault.modelId)
          overrideResult = { removed: false, newDefault }
        }
      }
    }
    // 清 auth.json 凭据（api_key / oauth token，强绑定凭据不能残留）。await：remove 内部
    // withFileLock 是真异步，fire-and-forget 会导致 broadcastProviderList 读到旧凭据 → 广播
    // stale 列表（catalog provider 删除后首次广播仍含该 provider 的根因）。失败仅 warn 不阻断。
    await cleanAuthCredential(authStorage, providerId, `for catalog provider ${providerId}`)
    // catalog 定义不可删（pi 二进制内置），「移除」= 清凭据/override/残留。removed=true 表示
    // 用户侧状态已清，listProviders 双源聚合（凭据 ∪ override）将不再显示该 provider。
    return { removed: true, newDefault: overrideResult.newDefault }
  }
  // custom：删 models.json 条目（= 删定义）+ 清残留。removeProvider 内部含 defaultModel 重选。
  // custom 凭据随条目存在 models.json（apiKey 字段），删条目即清；auth.json 无需单独清理。
  const result = configStore.removeProvider(providerId)
  configStore.cleanEnabledModelsResidue(providerId)
  return result
}
