/**
 * Provider 解析器（DM4）—— 从其他 agent 的源配置解析出 ParsedProvider[]。
 *
 * W3：真实解析器实现位于 ./parsers/（pi-parser / zcode-parser / claude-parser / codex-parser），
 * 本文件只保留类型定义 + dispatcher 路由（薄转发层）。W2 的 Mock fixture 已移除。
 *
 * 安全约束（DM1）：
 *   - 解析出的 apiKey 明文只存在返回的 ParsedProvider[]（runtime 内存），经 preview-cache 暂存，
 *     apply 时写 models.json，**绝不返回前端**（preview 只暴露 apiKeyExtracted 布尔）。
 *   - 源目录不存在返回 null（前端据此显示「源未安装」）。
 *
 * ParsedProvider 结构：
 *   - 继承 PiProviderConfig（models.json provider 配置形状，含 apiKey 明文）。
 *   - 加 3 个 _ 前缀元数据字段（apply 时剥离，不写 models.json）：
 *     - _sourceName：源里的 provider 名（导入后作为 xyz-agent models.json 的 provider id）。
 *     - _apiKeyExtracted：是否成功提取 apiKey（脱敏布尔，preview 用）。
 *     - _warnings：解析期警告（preview 展示）。
 */
import type { ProviderSource } from '@xyz-agent/shared'
import type { PiProviderConfig } from '../../infra/pi/pi-provider-store.js'
// 真实解析器（W3）—— 各源配置解析在 ./parsers/ 下
import { parsePiProviders as parsePiProvidersImpl } from './parsers/pi-parser.js'
import { parseZcodeProviders as parseZcodeProvidersImpl } from './parsers/zcode-parser.js'
import { parseCodexProviders as parseCodexProvidersImpl } from './parsers/codex-parser.js'
import { parseClaudeProviders as parseClaudeProvidersImpl } from './parsers/claude-parser.js'

// ── DM4 — 解析器输出（含元数据，apply 时剥离）──────────────────────

/**
 * 解析后的单个 provider（含元数据）。
 *
 * extends PiProviderConfig 以便 apply 时直接透传给 upsertProvider（剥离 _ 字段后）。
 * 三个 _ 前缀字段是 runtime 内部元数据，apply 时解构剥离，不写 models.json。
 */
export interface ParsedProvider extends PiProviderConfig {
  /** 源里的 provider 名（如 Pi 的 'deepseek-router'），导入后作 xyz-agent models.json 的 provider id。 */
  _sourceName: string
  /** 源里是否成功提取到 apiKey 明文（脱敏布尔，preview 用；apply 时 apiKey 字段照原样写）。 */
  _apiKeyExtracted: boolean
  /** 解析期警告（如「env_key 未设置」「key 加密无法提取」），preview 逐条展示。 */
  _warnings: string[]
}

/**
 * 单个源解析结果。
 *
 * - providers：解析出的 provider 列表（含 apiKey 明文 + _ 元数据）。
 * - parseError：解析期致命错误（如文件格式损坏）。有 parseError 时 providers 可能为空或部分。
 */
export interface ParseResult {
  providers: ParsedProvider[]
  parseError?: string
}

// ══════════════════════════════════════════════════════════════════
// 各源解析（W3：薄转发到 ./parsers/ 下的真实实现）
// ══════════════════════════════════════════════════════════════════

/**
 * 解析 Pi 源（~/.pi/agent/models.json + ~/.pi/agent/auth.json）。
 * @see ./parsers/pi-parser.ts
 */
export function parsePiProviders(homeDir: string): ParseResult | null {
  return parsePiProvidersImpl(homeDir)
}

/**
 * 解析 ZCode 源（~/.zcode/v2/config.json）。
 * @see ./parsers/zcode-parser.ts
 */
export function parseZcodeProviders(homeDir: string): ParseResult | null {
  return parseZcodeProvidersImpl(homeDir)
}

/**
 * 解析 Codex 源（~/.codex/config.toml + 可选 auth.json）。
 * @see ./parsers/codex-parser.ts
 */
export function parseCodexProviders(homeDir: string): ParseResult | null {
  return parseCodexProvidersImpl(homeDir)
}

/**
 * 解析 Claude 源（~/.claude/settings.json）。
 * @see ./parsers/claude-parser.ts
 */
export function parseClaudeProviders(homeDir: string): ParseResult | null {
  return parseClaudeProvidersImpl(homeDir)
}

/**
 * 解析器 dispatcher：按 source 路由到对应的解析器。
 *
 * @param source 迁移源（pi/zcode/codex/claude）。
 * @param homeDir 用户主目录（绝对路径）。
 * @returns 解析结果；源目录不存在返回 null（前端据此显示「源未安装」）。
 */
export function parseProviders(source: ProviderSource, homeDir: string): ParseResult | null {
  switch (source) {
    case 'pi': return parsePiProviders(homeDir)
    case 'zcode': return parseZcodeProviders(homeDir)
    case 'codex': return parseCodexProviders(homeDir)
    case 'claude': return parseClaudeProviders(homeDir)
  }
}
