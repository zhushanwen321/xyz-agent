/**
 * ZCode 源真实解析器（W3）—— 读 ~/.zcode/v2/config.json 的 provider 对象。
 *
 * 数据流：
 *   - config.json：provider id → { name, kind, options: { apiKey, baseURL }, models }。
 *   - kind 映射到 pi 协议：anthropic → anthropic-messages；openai* → openai-completions。
 *   - apiKey：只读 config.json 明文（不读 credentials.json，加密 ES5）。
 *
 * 安全红线（DM1 / ES5）：
 *   - 不读 credentials.json（enc:v1: 加密，不解密）。
 *   - apiKey 明文只存在返回的 ParsedProvider[]，不进日志/preview 序列化。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PiModelDefinition } from '../../../infra/pi/pi-provider-store.js'
import type { ParseResult, ParsedProvider } from '../provider-parser.js'

/**
 * ZCode config.json 中 provider 条目的形状（只取已知字段，未知容忍）。
 */
interface ZcodeModelDef {
  name?: string
  reasoning?: { enabled?: boolean; variants?: string[]; defaultVariant?: string }
  limit?: { context?: number; output?: number }
  modalities?: { input?: string[]; output?: string[] }
}

interface ZcodeProviderEntry {
  name?: string
  /** 'anthropic' | 'openai' | 'openai-compatible' | 其他 */
  kind?: string
  enabled?: boolean
  source?: string
  options?: { apiKey?: string; baseURL?: string }
  models?: Record<string, ZcodeModelDef>
}

interface ZcodeConfigJson {
  provider?: Record<string, ZcodeProviderEntry>
}

/**
 * 从 ZCode model 的 reasoning.variants 推断 thinkingLevelMap。
 *
 * ZCode 用 variants 数组表示思维级别（如 ['low','medium','high']），与 pi 的
 * thinkingLevelMap（key → value 映射）形状不同。这里做简化直传：variant → variant。
 * 真实场景若需 mapping 由后续 provider-importer / 用户手动调整。
 */
function inferThinkingLevelMap(
  reasoning: ZcodeModelDef['reasoning'],
): Record<string, string | null> | undefined {
  if (!reasoning?.variants || reasoning.variants.length === 0) return undefined
  const map: Record<string, string | null> = {}
  for (const v of reasoning.variants) map[v] = v
  return map
}

/**
 * 解析 ZCode 源（~/.zcode/v2/config.json）。
 *
 * @param homeDir 用户主目录（绝对路径）。
 * @returns 解析结果；源目录不存在返回 null。parseError 仅在整体性错误时设置。
 */
export function parseZcodeProviders(homeDir: string): ParseResult | null {
  const configPath = join(homeDir, '.zcode', 'v2', 'config.json')
  if (!existsSync(configPath)) return null

  let config: ZcodeConfigJson
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as ZcodeConfigJson
  } catch (e) {
    return {
      providers: [],
      parseError: `cannot parse zcode config.json: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  const providers: ParsedProvider[] = []
  for (const [id, entry] of Object.entries(config.provider ?? {})) {
    const warnings: string[] = []

    // kind 映射到 pi 协议
    let api: string
    if (entry.kind === 'anthropic') {
      api = 'anthropic-messages'
    } else if (entry.kind && entry.kind.startsWith('openai')) {
      // openai / openai-compatible 都映射到 openai-completions。
      // 注：openai-compatible 可能实际是 responses 协议，但无法从 kind 区分，默认 completions + warning。
      api = 'openai-completions'
      warnings.push(`kind=${entry.kind} mapped to openai-completions, verify if responses protocol is needed`)
    } else {
      // 未知 kind 跳过（避免产出无法路由的 provider）
      warnings.push(`provider ${id}: unknown kind ${entry.kind ?? '(undefined)'}, skipped`)
      continue
    }

    // key 提取：只 config.json 明文（不读 credentials.json）
    const apiKey = entry.options?.apiKey
    const apiKeyExtracted = !!apiKey

    // models 转换：ZCode model def → PiModelDefinition
    const models: PiModelDefinition[] = Object.entries(entry.models ?? {}).map(([modelId, m]) => ({
      id: modelId,
      name: m.name ?? modelId,
      contextWindow: m.limit?.context,
      maxTokens: m.limit?.output,
      reasoning: m.reasoning?.enabled,
      thinkingLevelMap: inferThinkingLevelMap(m.reasoning),
    }))

    providers.push({
      name: entry.name ?? id,
      api,
      baseUrl: entry.options?.baseURL,
      apiKey,
      models,
      _sourceName: id,
      _apiKeyExtracted: apiKeyExtracted,
      _warnings: warnings,
    })
  }

  return { providers }
}
