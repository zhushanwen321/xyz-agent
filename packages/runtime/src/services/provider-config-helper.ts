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
import { type ProviderInfo, type BuiltinProviderTemplate } from '@xyz-agent/shared'
import { isCatalogProvider, deriveEnabled } from './provider-catalog.js'
import type { IConfigStore, ConfigModelDefinition, ConfigProviderConfig } from './ports/config.js'
import type { AuthStorage } from './auth/auth-storage.js'
import { pickModelCapabilityFields } from './model-mapper.js'

/** auth.json 存储能力（ConfigService 注入，与 ConfigService 构造函数 authStorage 同构）。 */
type AuthStorageAccessors = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

/** setProvider 的入参形状（原 ConfigService.setProvider 内联类型提取，逐字一致）。 */
export type SetProviderInput = {
  name?: string
  type?: string
  apiKey?: string
  authMethod?: 'api_key' | 'oauth' | 'env_var' | 'ambient'
  baseUrl?: string
  models?: Array<string | { id: string; name?: string; api?: string; baseUrl?: string; contextWindow?: number; input?: Array<'text' | 'image'>; thinkingLevelMap?: Record<string, string | null>; enabled?: boolean; compat?: Record<string, unknown> }>
  enabled?: boolean
  /** Coding Plan 额度查询配置（手动选择 fetcher + 启用状态）。 */
  quota?: { fetcher?: string; enabled: boolean; cookieSet?: boolean }
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
 */
function toProviderModel(m: BuiltinProviderTemplate['models'][number]): ProviderInfo['models'][number] {
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
  }
}

/** builtin provider id → 完整模板索引（wave2 catalog 源聚合用，builtinModelsById 只索引 models 不够）。 */
const builtinProvidersById = new Map<string, BuiltinProviderTemplate>(
  (builtinData.providers ?? []).map(p => [p.id, p as unknown as BuiltinProviderTemplate]),
)

/**
 * ConfigModelDefinition → ProviderInfo.models 元素（wave2 双源共用，提取 custom 内联逻辑避免重复）。
 * model 级 enabled 透传（默认 true 向上兼容存量无此字段的 model）。
 */
function toUserInfoModel(m: ConfigModelDefinition): ProviderInfo['models'][number] {
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    baseUrl: m.baseUrl,
    input: m.input,
    compat: m.compat,
    // W2：model 级 enabled 透传（默认 true 向上兼容存量无此字段的 model）
    enabled: m.enabled !== false,
    ...pickModelCapabilityFields(m),
  }
}

/** 按 models.json config 推断 authMethod（I6：优先标注值，否则 $开头→env_var / 非空→api_key）。config 缺省→undefined。 */
function deriveAuthMethod(config?: ConfigProviderConfig): ProviderInfo['authMethod'] {
  if (!config) return undefined
  return config.authMethod
    ?? (typeof config.apiKey === 'string' && config.apiKey.startsWith('$')
      ? 'env_var' as const
      : config.apiKey ? 'api_key' as const : undefined)
}

/** Runtime type guard for thinkingLevelMap values. */
function isValidThinkingLevelMap(v: unknown): v is Record<string, string | null> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every(val => val === null || typeof val === 'string')
}

// ── 默认模型 ──

export function getDefaultModel(configStore: IConfigStore): { provider: string; modelId: string } | null {
  return configStore.getDefaultModel()
}

export function setDefaultModel(configStore: IConfigStore, provider: string, modelId: string): void {
  configStore.setDefaultModel(provider, modelId)
}

// ── Provider 列举 / 查询 ──

/**
 * catalog ∪ custom 双源聚合 provider 列表。
 * 纯函数：configStore / authStorage 经参数注入（原 ConfigService.listProviders 逐字搬迁）。
 */
export function listProviders(configStore: IConfigStore, authStorage?: AuthStorageAccessors): ProviderInfo[] {
  const models = configStore.readModels()
  const enabledModels = configStore.getEnabledModels()
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
    // C1 契约「catalog 凭据 = id ∈ auth.json keys」；override?.apiKey 是 catalog provider
    // 手动填 key 的旧数据（迁移前错位）合理扩展，双源判定避免遗漏。
    const apiKeySet = authIdSet.has(id) || !!override?.apiKey
    const overrideModels = override?.models ?? []
    result.push({
      id,
      name: override?.name || builtinP.name || id,
      api: override?.api ?? builtinP.api,
      baseUrl: override?.baseUrl ?? builtinP.baseUrl,
      apiKeySet,
      authMethod: deriveAuthMethod(override),
      // catalog 凭据在 auth.json：apiKeySet 已含 auth.json 判定（authIdSet.has(id)），
      // 与旧 status 逻辑（hasCredentialSync(id)）等价，避免重复读 auth.json。
      status: apiKeySet ? 'connected' as const : 'not_configured' as const,
      // models 优先 override，空则 builtin 副本（builtinP.models 经 toProviderModel 映射）
      models: overrideModels.length > 0
        ? overrideModels.map(toUserInfoModel)
        : (builtinP.models?.map(toProviderModel) ?? []),
      // DM3：enabled 从 enabledModels 派生，不读 models.json provider.enabled（F2）
      enabled: deriveEnabled(id, enabledModels),
      kind: 'catalog' as const,
      hasOverride,
      quota: override?.quota,
    })
  }

  // ── custom 源：models.json providers where !isCatalogProvider(id)（保留旧逻辑，kind='custom'）──
  // catalogIdsHandled 已收录 models.json 里的 catalog 条目（上面聚合时加入），此处跳过避免重复。
  for (const [id, config] of Object.entries(models.providers)) {
    if (catalogIdsHandled.has(id)) continue
    const userModels = (config.models ?? []).map(toUserInfoModel)
    const apiKeySet = !!config.apiKey
    result.push({
      id,
      name: config.name || id,
      // W2：回填 provider 级 api 字段，修复前端编辑 provider 时 type 下拉丢失（P0-1）
      api: config.api,
      baseUrl: config.baseUrl,
      apiKeySet,
      authMethod: deriveAuthMethod(config),
      // M6 status 派生：apiKey 或 auth.json 凭据任一 → connected。
      // B3：复用 authIdSet（listProviders 开头批量读），消除每次循环 hasCredentialSync 的 N+1 读盘。
      status: (config.apiKey || authIdSet.has(id))
        ? 'connected' as const
        : 'not_configured' as const,
      // T9/M5 models 合并：用户自定义 models 非空 → 保留；为空 → builtin models 兜底
      models: userModels.length > 0
        ? userModels
        : (builtinModelsById.get(id)?.map(toProviderModel) ?? userModels),
      // DM3：enabled 从 enabledModels 派生，不读 models.json provider.enabled（F2）
      enabled: deriveEnabled(id, enabledModels),
      kind: 'custom' as const,
      quota: config.quota,
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
 * 纯函数：configStore / authStorage 经参数注入（原 ConfigService.setProvider 逐字搬迁）。
 */
export function setProvider(
  configStore: IConfigStore,
  authStorage: AuthStorageAccessors | undefined,
  providerId: string,
  data: SetProviderInput,
): { newDefault?: { provider: string; modelId: string } } {
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
    if (isCatalogProvider(providerId) && authStorage) {
      // catalog provider: apiKey → auth.json (0600), strip from models.json
      void authStorage.set(providerId, { type: 'api_key', key: data.apiKey }).catch(err => {
        console.warn(`[config-service] auth.json api_key write failed for ${providerId}:`, err)
      })
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
  if (data.apiKey !== undefined) merged.apiKey = data.apiKey as string
  // I6：authMethod 透传（ProviderQuickSetup.onSave 按所选认证方式填充）
  if (data.authMethod !== undefined) merged.authMethod = data.authMethod
  if (data.baseUrl !== undefined) merged.baseUrl = data.baseUrl as string
  if (data.type !== undefined) merged.api = configStore.applyTypeTranslation(data.type as string)
  if (data.name !== undefined) merged.name = data.name as string
  // wave3 C5/TC6：停用 provider 级 enabled 写入——provider 启用改由 enabledModels 白名单承载
  // （wave2 listProviders 已不读 models.json provider.enabled）。前端 onToggleEnabled 改走
  // toggleProviderEnabled（wave4），不再传 data.enabled 给 setProvider。data.enabled 参数声明保留
  // （向后兼容），但不写入 models.json。model 级 enabled（下文 model 合并逻辑）保留。
  // Coding Plan 额度查询：整体覆写 quota（fetcher/enabled/cookieSet 三字段一起持久化）
  if (data.quota !== undefined) merged.quota = data.quota
  if (data.models !== undefined) {
    const rawModels = data.models as Array<Record<string, unknown>>
    const existingModels = (existing.models ?? []) as ConfigModelDefinition[]
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
      // review must_fix #1：前端回传的 model 级 api/baseUrl/enabled 必须写回，
      // 否则编辑保存即丢失（新模型 base={} 全丢，编辑现有模型被 base 旧值覆盖）。
      // 对齐 provider 级的「if (m.X !== undefined) model.X = ...」模式。
      if (typeof m.api === 'string') model.api = m.api
      if (typeof m.baseUrl === 'string') model.baseUrl = m.baseUrl
      if (typeof m.enabled === 'boolean') model.enabled = m.enabled
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
  providerId: string,
  enabled: boolean,
): { newDefault?: { provider: string; modelId: string } } {
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
  // 边界3（TC3）：重算后空 → delete 字段（CL2），非写空数组（pi 语义空=全可用，写 [] 语义反转）；
  // 非空 → 写回新白名单
  if (remaining.length === 0) {
    configStore.clearEnabledModels()
  } else {
    configStore.setEnabledModels(remaining)
  }

  // 边界2（TC4）：若 defaultModel 承载被禁用的 provider，重选（否则 pi session scopedModels
  // 不含该 provider，defaultModel 与 scope 错位）。复用 listProviders（wave2 双源聚合 + deriveEnabled）
  // 找首个启用且有 model 的 provider——不依赖 findValidDefaultModel（其主路径未过滤 enabledModels）。
  const oldDefault = configStore.getDefaultModel()
  if (oldDefault && oldDefault.provider === providerId) {
    const newDefault = pickEnabledDefaultModel(configStore, authStorage, providerId)
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
  excludedId: string,
): { provider: string; modelId: string } | undefined {
  const providers = listProviders(configStore, authStorage)
  // B1：优先选有凭据（apiKeySet）的启用 provider 作 default，
  // 避免重选到无凭据的 catalog provider（用户禁用某 provider 触发重选时）。
  // 有凭据优先，找不到再 fallback 到任意启用 provider（含 ambient 认证如 bedrock）。
  const candidates = providers.filter(p => p.id !== excludedId && p.enabled && p.models[0])
  const withCred = candidates.find(p => p.apiKeySet)
  if (withCred) return { provider: withCred.id, modelId: withCred.models[0].id }
  const any = candidates[0]
  return any ? { provider: any.id, modelId: any.models[0].id } : undefined
}

/**
 * 删除 provider（I8：同步清 auth.json 凭据）。
 * 纯函数：configStore / authStorage 经参数注入（原 ConfigService.deleteProvider 逐字搬迁）。
 */
export function deleteProvider(
  configStore: IConfigStore,
  authStorage: AuthStorageAccessors | undefined,
  providerId: string,
): { removed: boolean; newDefault?: { provider: string; modelId: string } } {
  // I8：删 provider 同步清 auth.json 凭据（OAuth token 是强绑定凭据，不能残留）。
  // 幂等：auth.json 无该 provider 时 no-op。清理失败记 warn（fire-and-forget，不阻塞删除主流程）。
  void authStorage?.remove(providerId).catch(err => {
    console.warn(`[config-service] auth.json cleanup failed for ${providerId} (I8):`, err)
  })
  return configStore.removeProvider(providerId)
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
export function removeProviderByKind(
  configStore: IConfigStore,
  authStorage: AuthStorageAccessors | undefined,
  providerId: string,
  kind: 'catalog' | 'custom',
): { removed: boolean; newDefault?: { provider: string; modelId: string } } {
  if (kind === 'catalog') {
    // 清 auth.json 凭据（api_key / oauth token，强绑定凭据不能残留）。fire-and-forget。
    void authStorage?.remove(providerId).catch(err => {
      console.warn(`[config-service] auth.json cleanup failed for catalog provider ${providerId}:`, err)
    })
    // 清 models.json override 条目（若有）。无 override 时 removeProvider 返回 { removed: false }，
    // 不影响后续清残留——catalog 的「移除」语义是清用户侧状态，override 本就可能不存在。
    // MF1 修复（exec-review must-fix）：catalog override 承载 defaultModel 时 removeProvider 内部
    // 重选 default + mutate settings.json，透传 newDefault 让 handler 广播 config.defaults
    // （与 custom 分支 + deleteProvider 对称，否则 renderer 收不到重选通知）。
    const overrideResult = configStore.removeProvider(providerId)
    configStore.cleanEnabledModelsResidue(providerId)
    // catalog 定义不可删（pi 二进制内置），「移除」= 清凭据/override/残留。removed=true 表示
    // 用户侧状态已清，listProviders 双源聚合（凭据 ∪ override）将不再显示该 provider。
    return { removed: true, newDefault: overrideResult.newDefault }
  }
  // custom：删 models.json 条目（= 删定义）+ 清残留。removeProvider 内部含 defaultModel 重选。
  const result = configStore.removeProvider(providerId)
  configStore.cleanEnabledModelsResidue(providerId)
  return result
}
