/**
 * Codex 源真实解析器（W3）—— 读 ~/.codex/config.toml + ~/.codex/auth.json。
 *
 * 数据流：
 *   - config.toml：顶层 model（占位 model id）+ [model_providers.<id>] 表，每表含
 *     name / base_url / env_key / wire_api（responses|chat）/ http_headers。
 *   - auth.json（可选）：{ OPENAI_API_KEY }，作为默认 openai provider 的 key 回退。
 *   合并后构造 ParsedProvider[]，apiKey 明文只进 ParsedProvider（runtime 内存），不进日志。
 *
 * 协议映射（wire_api → pi 终值）：
 *   - wire_api='responses' → openai-responses。
 *   - wire_api='chat'      → openai-completions（chat 已废弃，warning 提示）。
 *   - 其余/缺失            → openai-completions（warning 提示 defaulted）。
 *
 * 安全红线（DM1 / ES5）：
 *   - env_key 只从 process.env 静态查（不执行任何脚本，不读 keychain）。
 *   - apiKey 明文只存在返回的 ParsedProvider[]，绝不进日志/preview 序列化。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as TOML from '@iarna/toml'
import type { PiModelDefinition } from '../../../infra/pi/pi-provider-store.js'
import type { ParseResult, ParsedProvider } from '../provider-parser.js'

/**
 * Codex config.toml 中 [model_providers.<id>] 表的形状（只取已知字段，未知容忍）。
 */
interface CodexModelProvider {
  name?: string
  base_url?: string
  /** provider 级环境变量名（如 ROUTER_KEY），运行时从 process.env 取值。 */
  env_key?: string
  /** 'responses' | 'chat'（chat 已废弃）。其余值视为未知。 */
  wire_api?: string
  http_headers?: Record<string, string>
}

/** Codex auth.json 形状（可选，仅消费 OPENAI_API_KEY 作为 openai provider 的默认 key）。 */
interface CodexAuthJson {
  OPENAI_API_KEY?: string
}

/** Codex config.toml 顶层形状（只取已知字段，未知容忍）。 */
interface CodexConfig {
  /** 顶层单 model 字段，作为占位 model id（Codex 在 config 里只暴露一个当前 model）。 */
  model?: string
  model_provider?: string
  model_providers?: Record<string, CodexModelProvider>
}

/**
 * 解析 Codex 源（~/.codex/config.toml + 可选 ~/.codex/auth.json）。
 *
 * @param homeDir 用户主目录（绝对路径）。
 * @returns 解析结果；源目录不存在返回 null（前端据此显示「源未安装」）。
 *          parseError 仅在整体性错误（目录存在但 config.toml 缺失 / TOML 损坏）时设置。
 */
export function parseCodexProviders(homeDir: string): ParseResult | null {
  const codexDir = join(homeDir, '.codex')
  if (!existsSync(codexDir)) return null // 源未安装

  const configPath = join(codexDir, 'config.toml')
  if (!existsSync(configPath)) {
    return { providers: [], parseError: 'config.toml not found in ~/.codex' }
  }

  let config: CodexConfig
  try {
    config = TOML.parse(readFileSync(configPath, 'utf8')) as unknown as CodexConfig
  } catch (e) {
    return {
      providers: [],
      parseError: `cannot parse config.toml: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  // 读 auth.json（可选，可能不存在；解析失败不阻断整体解析）
  let authData: CodexAuthJson = {}
  const authPath = join(codexDir, 'auth.json')
  if (existsSync(authPath)) {
    try {
      authData = JSON.parse(readFileSync(authPath, 'utf8')) as CodexAuthJson
    } catch {
      // auth.json 解析失败不阻断 config.toml 的解析（auth 仅作 openai provider 的 key 回退）
    }
  }

  const topModel = config.model // 顶层单 model 字段
  const providers: ParsedProvider[] = []

  for (const [id, mp] of Object.entries(config.model_providers ?? {})) {
    const warnings: string[] = []

    // wire_api 映射到 pi 终值协议
    let api: string
    if (mp.wire_api === 'responses') {
      api = 'openai-responses'
    } else if (mp.wire_api === 'chat') {
      api = 'openai-completions'
      warnings.push('wire_api=chat is deprecated, mapped to openai-completions')
    } else {
      api = 'openai-completions'
      warnings.push(`unknown wire_api ${mp.wire_api ?? '(undefined)'}, defaulted to openai-completions`)
    }

    // env_key 解析：只从 process.env 静态查（不执行任何脚本）
    let apiKey: string | undefined
    let apiKeyExtracted = false
    if (mp.env_key) {
      const envValue = process.env[mp.env_key]
      if (envValue) {
        apiKey = envValue
        apiKeyExtracted = true
      } else {
        warnings.push(`env_key ${mp.env_key} not set in environment, apiKey not extracted`)
      }
    }
    // auth.json 的 OPENAI_API_KEY 作为默认 openai provider 的 key（id 含 'openai' 且无 env_key 提取到值）
    if (!apiKey && id.toLowerCase().includes('openai') && authData.OPENAI_API_KEY) {
      apiKey = authData.OPENAI_API_KEY
      apiKeyExtracted = true
    }

    // 占位 model：Codex config 只暴露顶层单 model 字段，model 列表不完整
    const models: PiModelDefinition[] = []
    if (topModel) {
      models.push({ id: topModel, name: topModel })
      warnings.push('Codex model list incomplete (only top-level model field), please add models manually')
    }

    providers.push({
      name: mp.name ?? id,
      api,
      baseUrl: mp.base_url,
      apiKey,
      headers: mp.http_headers,
      models,
      _sourceName: id,
      _apiKeyExtracted: apiKeyExtracted,
      _warnings: warnings,
    })
  }

  return { providers }
}
