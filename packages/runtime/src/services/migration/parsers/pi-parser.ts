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
import type { ParseResult, ParsedProvider } from '../provider-parser.js'

/**
 * Pi auth.json 形状：providerId → { type, key（明文）}。
 * type 通常是 'api_key' / 'oauth' 等，这里不消费，只取 key。
 */
interface PiAuthJson {
  [providerId: string]: { type?: string; key?: string }
}

/** pi 支持的终值协议（与 pi-provider-store 注释对齐）。 */
const PI_SUPPORTED_PROTOCOLS = new Set([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

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

      // auth.json 合并：若 authData 有对应 key 则填入（优先于 models.json 的 apiKey）
      const authEntry = authData[providerId]
      const apiKey = authEntry?.key ?? config.apiKey
      const apiKeyExtracted = !!apiKey

      providers.push({
        ...config,
        apiKey,
        _sourceName: providerId,
        _apiKeyExtracted: apiKeyExtracted,
        _warnings: warnings,
      })
    } catch (e) {
      topWarnings.push(
        `provider ${providerId} skipped due to malformed entry: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  return {
    providers,
    warnings: topWarnings.length > 0 ? topWarnings : undefined,
  }
}
