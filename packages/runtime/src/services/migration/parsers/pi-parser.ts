/**
 * Pi 源真实解析器（W3）—— 读 ~/.pi/agent/models.json + ~/.pi/agent/auth.json。
 *
 * 数据流：
 *   - models.json：provider 列表 + models + baseUrl + 可选 apiKey。
 *   - auth.json：providerId → { type, key } 明文 key 映射（优先于 models.json 的 apiKey）。
 *   合并后构造 ParsedProvider[]，apiKey 明文只进 ParsedProvider（runtime 内存），不进日志。
 *
 * 协议映射（ES5 安全边界内）：
 *   - api 必须是 pi 终值：openai-completions / openai-responses / anthropic-messages。
 *   - api === 'google-generative-ai'：Google GenAI 协议不支持，丢弃 + warning。
 *   - 其余未知 api：丢弃 + warning。
 *
 * 安全红线（DM1 / ES5）：
 *   - 只读 auth.json 明文 key；不读 secrets.json（${ENV} 占位，运行时解析在 pi 内部）。
 *   - apiKey 明文只存在返回的 ParsedProvider[]，绝不进日志/preview 序列化（provider-importer 脱敏）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PiProviderConfig, PiModelsConfig } from '../../../infra/pi/pi-provider-store.js'
import type { ParseResult, ParsedProvider, ParsedOrphanCredential } from '../provider-parser.js'

/**
 * Pi auth.json 形状：providerId → 凭据条目（对齐 pi-ai 0.82.1 dist/auth/types.d.ts 的 Credential）。
 *
 * type 只有 'api_key' / 'oauth' 两种真实值（AuthType，见 types.d.ts）；'env' 不是独立 type，
 * 是 api_key 凭据的 env 包字段（ApiKeyCredential.env）。
 * - api_key：key 为明文 / $VAR 占位 / !command 前缀 / ${VAR} 占位；可选 env 包（key 内嵌值）。
 * - oauth：access + refresh + expires 三元组（OAuthCredential，Phase 1 不支持，warnings 提示 Phase 2）。
 */
interface PiAuthJson {
  [providerId: string]: {
    type?: 'api_key' | 'oauth'
    /** 明文 key / $VAR 占位 / ${VAR} 占位 / !command 前缀。 */
    key?: string
    /** env 包：{ VAR: 'value' }（api_key 的 scoped env bag），Phase 1 不支持（不落盘 models.json）。 */
    env?: Record<string, string>
    /** OAuth access token（type==='oauth'，OAuthCredential.access）。Phase 1 不取。 */
    access?: string
    /** OAuth refresh token（type==='oauth'，OAuthCredential.refresh）。Phase 1 不取。 */
    refresh?: string
    /** OAuth token 过期时间戳（ms，type==='oauth'，OAuthCredential.expires）。Phase 1 不取。 */
    expires?: number
  }
}

/** pi 支持的终值协议（与 pi-provider-store 注释对齐）。 */
const PI_SUPPORTED_PROTOCOLS = new Set([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

// ══ sa3 F1：凭据六态判定共享函数（wave 4 import-credential-types + 孤儿凭据扫描共用）══
//
// 现有 providers 循环与孤儿凭据循环（auth.json 有、models.json 无定义的 providerId）
// 使用同一套六态判定，提取为模块级函数避免双份逻辑漂移。

/** classifyCredential 的返回值（六态 + 可选 envVarName/apiKey + 警告）。 */
interface CredentialClassify {
  credentialType: 'plaintext' | 'env' | 'env-bundle' | 'missing' | 'oauth' | 'command'
  envVarName?: string
  apiKey?: string
  warnings: string[]
}

/**
 * 凭据六态判定（WC1：替换单行 `apiKey = authEntry?.key ?? config.apiKey` 为六态分支）。
 *
 * 优先级：env 包 > oauth > !command > $$ 字面量 > $ENV > plaintext > missing
 * （env 包 / oauth 不落盘 apiKey，避免 models.json 落盘后 resolveConfigValueOrThrow 硬抛错）。
 *
 * @param authEntry auth.json 里该 provider 的凭据条目（可能 undefined）。
 * @param configApiKey models.json 里该 provider 的 apiKey（auth 条目缺失时的回退）。
 * @param providerId 用于 warning 文案（孤儿凭据 = auth.json 的 key）。
 */
function classifyCredential(
  authEntry: PiAuthJson[string] | undefined,
  configApiKey: string | undefined,
  providerId: string,
): CredentialClassify {
  const rawKey = authEntry?.key ?? configApiKey
  const hasEnvBundle = authEntry?.env != null && typeof authEntry.env === 'object' && Object.keys(authEntry.env).length > 0
  // 主判定 type==='oauth'；兼容缺 type 的旧格式：有 access 字段且无 key 也判 oauth。
  // 旧字段名 token/refreshToken 已废弃（pi 真实格式是 access/refresh，见 auth/types.d.ts
  // OAuthCredential），不再作为判定依据。
  const isOauth = authEntry?.type === 'oauth' || (!authEntry?.key && !!authEntry?.access)

  // 凭据形态六态：plaintext / env($VAR,${VAR}) / env-bundle(env 包) / oauth / command(!) / missing(无线索)
  if (hasEnvBundle) {
    // env 包凭据：有凭据（key 内嵌在 env 包里）但 Phase 1 不支持落盘（models.json apiKey
    // 是纯字符串无 env 字段），apiKey 不写（undefined），避免 pi 运行时 resolveConfigValueOrThrow 硬抛错
    return {
      credentialType: 'env-bundle',
      warnings: [`provider ${providerId}: env bundle credentials not supported in Phase 1, apiKey omitted (will be supported in Phase 2)`],
    }
  }
  if (isOauth) {
    // OAuth 凭据：Phase 1 不支持，不取 token 作 apiKey（token 不是 api_key 语义）
    return {
      credentialType: 'oauth',
      warnings: [`provider ${providerId}: OAuth credentials, apiKey not extracted (OAuth support planned for Phase 2)`],
    }
  }
  if (rawKey) {
    // 有 key：按前缀判 plaintext / env($VAR/${VAR}) / command(!)
    // 边界：同时 $ 和 ! → 优先 command（更危险保守判定）
    if (rawKey.startsWith('!')) {
      return {
        credentialType: 'command',
        apiKey: rawKey, // 保留原样，pi 运行时执行 shell 命令取值
        warnings: [`provider ${providerId}: apiKey starts with '!' — pi executes this as a shell command at runtime (command injection surface), imported as-is`],
      }
    }
    if (rawKey.startsWith('$$')) {
      // pi 的 $$ 是字面量转义：$$OPENAI_API_KEY 解析为字面量字符串 $OPENAI_API_KEY（单 $），
      // 不是 env 引用。按明文处理，apiKey 保留原转义串（pi 运行时负责还原字面量）。
      return { credentialType: 'plaintext', apiKey: rawKey, warnings: [] }
    }
    if (rawKey.startsWith('$')) {
      // 单 $ / ${ 才是 env 引用（$$ 已在上面拦截，不会多剥一个 $）
      const envVarName = rawKey.startsWith('${') ? rawKey.replace(/^\$\{/, '').replace(/\}$/, '') : rawKey.replace(/^\$/, '')
      return {
        credentialType: 'env',
        apiKey: rawKey, // 保留原占位串（pi 运行时解析 $VAR / ${VAR}）
        envVarName,
        warnings: [`provider ${providerId}: apiKey is an env var reference (${rawKey}) — ensure ${envVarName} is set in the environment after import`],
      }
    }
    return { credentialType: 'plaintext', apiKey: rawKey, warnings: [] }
  }
  // 无 authEntry 且无 config.apiKey：无任何 key 线索
  return { credentialType: 'missing', warnings: [] }
}

/**
 * 解析 Pi 源（~/.pi/agent/models.json + ~/.pi/agent/auth.json）。
 *
 * @param homeDir 用户主目录（绝对路径）。
 * @returns 解析结果；源目录不存在返回 null（前端据此显示「源未安装」）。
 *          parseError 仅在整体性错误（文件读不了 / JSON 损坏）时设置。
 */
export function parsePiProviders(homeDir: string): ParseResult | null {
  const piAgentDir = join(homeDir, '.pi', 'agent')
  if (!existsSync(piAgentDir)) return null // 源未安装

  // 读 models.json（必需，缺失 = parseError）
  const modelsPath = join(piAgentDir, 'models.json')
  if (!existsSync(modelsPath)) {
    return { providers: [], parseError: 'models.json not found in ~/.pi/agent' }
  }

  let modelsConfig: PiModelsConfig
  try {
    // B1：JSON.parse('null') 成功返回 null，需用 ?? {} 兜底（否则下方 .providers 崩）
    modelsConfig = ((JSON.parse(readFileSync(modelsPath, 'utf8')) as PiModelsConfig | null) ?? {}) as PiModelsConfig
  } catch (e) {
    return {
      providers: [],
      parseError: `cannot parse models.json: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  // 读 auth.json（可选，可能不存在；解析失败不阻断整体解析）
  const authPath = join(piAgentDir, 'auth.json')
  let authData: PiAuthJson = {}
  const authWarnings: string[] = []
  if (existsSync(authPath)) {
    try {
      // B1：auth.json 为 null 时也用 ?? {} 兜底（JSON.parse('null') 成功返回 null）
      authData = (JSON.parse(readFileSync(authPath, 'utf8')) as PiAuthJson | null) ?? {}
    } catch {
      // auth 解析失败不阻断 models.json 的解析，仅记全局 warning（挂到每个 provider 上）
      authWarnings.push('auth.json parse failed, apiKey from auth.json unavailable for this run')
    }
  }

  const providers: ParsedProvider[] = []
  // S5：顶层 warnings 收集器——丢弃的 provider（google-generative-ai / 未知协议 / 坏条目）
  // 的提示进 topWarnings，preview 阶段整体展示给用户（区别于 per-provider `_warnings`）。
  const topWarnings: string[] = []
  const providerEntries = modelsConfig.providers ?? {}

  for (const [providerId, configRaw] of Object.entries(providerEntries)) {
    // B1：单条目 try/catch，单个坏条目（null/非对象）不中断整体解析
    try {
      // B1：null/非对象条目显式跳过（?? {} 仅防 crash，但空对象会作为无 api 的 provider 污染列表）
      if (configRaw === null || typeof configRaw !== 'object') {
        topWarnings.push(`provider ${providerId} skipped due to malformed entry: not an object (${configRaw === null ? 'null' : typeof configRaw})`)
        continue
      }
      const config = (configRaw as PiProviderConfig) ?? {}
      const warnings: string[] = [...authWarnings]

      // 协议映射：google-generative-ai 丢弃（S5：warning 进 topWarnings 而非局部变量，
      // 否则 continue 后字符串随局部 warnings 被丢弃，用户无感知）
      if (config.api === 'google-generative-ai') {
        topWarnings.push(`provider ${providerId}: protocol google-generative-ai not supported, skipped`)
        continue
      }

      // api 必须是 pi 终值，其余丢弃（S5：同样进 topWarnings）
      if (config.api && !PI_SUPPORTED_PROTOCOLS.has(config.api)) {
        topWarnings.push(`provider ${providerId}: unknown protocol ${config.api}, skipped`)
        continue
      }

      // auth.json 合并 + 凭据六态识别（wave 4 import-credential-types + sa3 F1：六态判定
      // 提取为 classifyCredential 共享函数，与孤儿凭据扫描同源，避免双份逻辑漂移）
      const authEntry = authData[providerId]
      const classification = classifyCredential(authEntry, config.apiKey, providerId)
      const { credentialType, envVarName, apiKey } = classification
      warnings.push(...classification.warnings)

      // computed：plaintext/env/command = 已拿到可用凭据（落盘可用 / 运行时读环境变量）；
      // missing/oauth/env-bundle = 需手填、Phase 2 支持或有凭据但 Phase 1 不支持落盘
      const apiKeyExtracted = credentialType === 'plaintext' || credentialType === 'env' || credentialType === 'command'

      providers.push({
        ...config,
        apiKey,
        _sourceName: providerId,
        _apiKeyExtracted: apiKeyExtracted,
        _credentialType: credentialType,
        ...(envVarName !== undefined ? { _envVarName: envVarName } : {}),
        _warnings: warnings,
      })
    } catch (e) {
      topWarnings.push(
        `provider ${providerId} skipped due to malformed entry: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  // ══ sa3 F1：孤儿凭据扫描（B.1 缺口 4 修复）══
  //
  // auth.json 里存在、models.json 未定义的 providerId（pi 内置 provider 如 openai/anthropic/
  // deepseek 的凭据——models.json 天然没有它们，因为 provider 定义来自 pi 内置 catalog）。
  // 这些凭据现在只进 orphanCredentials（runtime 内部，含明文 apiKey），preview 脱敏为组 2，
  // apply 时匹配内置模板补全定义（provider-importer 负责）。
  //
  // 安全红线（B.5/DM1）：apiKey 明文只存在 ParsedOrphanCredential（runtime 内存 → preview-cache），
  // 与 ParsedProvider 同模式，绝不进 preview 序列化。
  const orphanCredentials: ParsedOrphanCredential[] = []
  const knownProviderIds = new Set(Object.keys(providerEntries))
  for (const [providerId, authEntryRaw] of Object.entries(authData)) {
    if (knownProviderIds.has(providerId)) continue // 已在 models.json 定义，走上方 providers 主流程
    // 防御：非对象条目（null/字符串等）无法识别凭据类型，跳过 + 顶层警告
    if (authEntryRaw === null || typeof authEntryRaw !== 'object') {
      topWarnings.push(`credential ${providerId}: malformed auth.json entry (${authEntryRaw === null ? 'null' : typeof authEntryRaw}), orphan credential skipped`)
      continue
    }
    const classification = classifyCredential(authEntryRaw as PiAuthJson[string], undefined, providerId)
    orphanCredentials.push({
      providerId,
      credentialType: classification.credentialType,
      ...(classification.envVarName !== undefined ? { envVarName: classification.envVarName } : {}),
      ...(classification.apiKey !== undefined ? { apiKey: classification.apiKey } : {}),
      warnings: classification.warnings,
    })
  }

  return {
    providers,
    orphanCredentials,
    warnings: topWarnings.length > 0 ? topWarnings : undefined,
  }
}
