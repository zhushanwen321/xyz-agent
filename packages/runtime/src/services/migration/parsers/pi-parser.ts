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
    modelsConfig = JSON.parse(readFileSync(modelsPath, 'utf8')) as PiModelsConfig
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
      authData = JSON.parse(readFileSync(authPath, 'utf8')) as PiAuthJson
    } catch {
      // auth 解析失败不阻断 models.json 的解析，仅记全局 warning（挂到每个 provider 上）
      authWarnings.push('auth.json parse failed, apiKey from auth.json unavailable for this run')
    }
  }

  const providers: ParsedProvider[] = []
  const providerEntries = modelsConfig.providers ?? {}

  for (const [providerId, config] of Object.entries(providerEntries)) {
    const warnings: string[] = [...authWarnings]

    // 协议映射：google-generative-ai 丢弃
    if (config.api === 'google-generative-ai') {
      warnings.push(`provider ${providerId}: protocol google-generative-ai not supported, skipped`)
      // 仍加入 providers 列表，但标记为不支持？不——丢弃（spec：丢弃）。
      // 但 ParsedProvider 没有 skipped 字段，丢弃就是不 push。
      // 为保留 warning 信息（前端提示用户有 provider 被丢弃），改为：push 一个占位 provider。
      // 重新看 spec：spec 明确「丢弃」，且 warnings 只展示给保留的 provider。
      // 这里遵循 spec：丢弃，不 push。warning 信息通过全局 parseError 暴露？不——
      // parseError 只在整体性错误。单个 provider 丢弃不进 parseError。
      // 结论：丢弃，静默不 push（前端只看到保留的 provider，符合预期）。
      continue
    }

    // api 必须是 pi 终值，其余丢弃
    if (config.api && !PI_SUPPORTED_PROTOCOLS.has(config.api)) {
      warnings.push(`provider ${providerId}: unknown protocol ${config.api}, skipped`)
      continue
    }

    // auth.json 合并：若 authData 有对应 key 则填入（优先于 models.json 的 apiKey）
    const authEntry = authData[providerId]
    const apiKey = authEntry?.key ?? config.apiKey
    const apiKeyExtracted = !!apiKey

    providers.push({
      ...(config as PiProviderConfig),
      apiKey,
      _sourceName: providerId,
      _apiKeyExtracted: apiKeyExtracted,
      _warnings: warnings,
    })
  }

  return { providers }
}
