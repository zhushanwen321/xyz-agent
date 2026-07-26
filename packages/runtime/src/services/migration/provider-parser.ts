/**
 * Provider 解析器（DM4）—— 从其他 agent 的源配置解析出 ParsedProvider[]。
 *
 * W2（cw-2026-07-26-migration-other-agents）：全部是 **Mock 实现**，返回基于真实探索样本
 * 的 fixture（覆盖关键场景：apiKey 提取成功/失败、协议映射、冲突）。真实 4 源文件解析在 W3。
 *
 * 所有 Mock 函数顶部标 `// MOCK_W3_REPLACE`，W3 替换为真实 models.json / auth.json /
 * credentials.json / config.toml 解析。
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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderSource } from '@xyz-agent/shared'
import type { PiProviderConfig, PiModelDefinition } from '../../infra/pi/pi-provider-store.js'

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
 *   W2 Mock 不产生 parseError（返回 null 表示源未安装）。
 */
export interface ParseResult {
  providers: ParsedProvider[]
  parseError?: string
}

// ══════════════════════════════════════════════════════════════════
// MOCK 实现（W3 替换为真实文件解析）
// ══════════════════════════════════════════════════════════════════

/**
 * 解析 Pi 源（~/.pi/agent/models.json + ~/.pi/agent/auth.json）。
 *
 * // MOCK_W3_REPLACE
 * Mock：源目录（<homeDir>/.pi/agent）不存在返回 null（源未安装）。
 * 存在时返回 2 个 provider 的 fixture：
 *   - deepseek-router：api=anthropic-messages，apiKeyExtracted=true（模拟 auth.json 明文提取）。
 *   - zhipu-coding-plan：api=openai-completions，apiKeyExtracted=true。
 * 各含 2-3 个 model。
 */
export function parsePiProviders(homeDir: string): ParseResult | null {
  // MOCK_W3_REPLACE：W3 替换为真实 models.json + auth.json 解析
  if (!existsSync(join(homeDir, '.pi', 'agent'))) return null

  const deepseekModels: PiModelDefinition[] = [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 64000 },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: true, contextWindow: 64000 },
  ]
  const zhipuModels: PiModelDefinition[] = [
    { id: 'glm-4.6', name: 'GLM-4.6', contextWindow: 128000 },
    { id: 'glm-4.5-air', name: 'GLM-4.5 Air', contextWindow: 128000 },
    { id: 'glm-4.5', name: 'GLM-4.5', contextWindow: 128000 },
  ]

  const providers: ParsedProvider[] = [
    {
      name: 'DeepSeek Router',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-real-pi-deepseek-key',
      api: 'anthropic-messages',
      models: deepseekModels,
      _sourceName: 'deepseek-router',
      _apiKeyExtracted: true,
      _warnings: [],
    },
    {
      name: 'Zhipu Coding Plan',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-real-pi-zhipu-key',
      api: 'openai-completions',
      models: zhipuModels,
      _sourceName: 'zhipu-coding-plan',
      _apiKeyExtracted: true,
      _warnings: [],
    },
  ]

  return { providers }
}

/**
 * 解析 ZCode 源（~/.zcode/config + ~/.zcode/credentials.json）。
 *
 * // MOCK_W3_REPLACE
 * Mock：源目录（<homeDir>/.zcode）不存在返回 null。
 * 存在时返回 2 个 provider：
 *   - bigmodel：kind=anthropic（→ api=anthropic-messages），apiKeyExtracted=true。
 *   - qwen：apiKeyExtracted=false（模拟 credentials.json 加密无法提取，warning 提示）。
 * models 从 limit.context 推断 contextWindow。
 */
export function parseZcodeProviders(homeDir: string): ParseResult | null {
  // MOCK_W3_REPLACE：W3 替换为真实 config + credentials.json 解析
  if (!existsSync(join(homeDir, '.zcode'))) return null

  const bigmodelModels: PiModelDefinition[] = [
    { id: 'glm-4.6', name: 'GLM-4.6', contextWindow: 128000 },
    { id: 'glm-4.5-air', name: 'GLM-4.5 Air', contextWindow: 128000 },
  ]
  const qwenModels: PiModelDefinition[] = [
    { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', contextWindow: 128000 },
  ]

  const providers: ParsedProvider[] = [
    {
      name: 'BigModel',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-real-zcode-bigmodel-key',
      api: 'anthropic-messages',
      models: bigmodelModels,
      _sourceName: 'bigmodel',
      _apiKeyExtracted: true,
      _warnings: [],
    },
    {
      name: 'Qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      // apiKey 留空：模拟 credentials.json 加密无法提取
      api: 'openai-completions',
      models: qwenModels,
      _sourceName: 'qwen',
      _apiKeyExtracted: false,
      _warnings: ['credentials.json encrypted, apiKey could not be extracted — please fill manually after import'],
    },
  ]

  return { providers }
}

/**
 * 解析 Codex 源（~/.codex/config.toml + env_key）。
 *
 * // MOCK_W3_REPLACE
 * Mock：源目录（<homeDir>/.codex）不存在返回 null。
 * 存在时返回 1 个 provider：
 *   - custom：wire_api=responses（→ api=openai-responses），apiKeyExtracted=true。
 * env_key 场景（provider 用环境变量引用 key 而非明文）的 provider apiKeyExtracted=false，
 * warning 提示「需设置环境变量 X」——W3 真实解析时按 provider 级 env_key 字段判定。
 */
export function parseCodexProviders(homeDir: string): ParseResult | null {
  // MOCK_W3_REPLACE：W3 替换为真实 config.toml 解析（含 env_key vs 明文 key 分流）
  if (!existsSync(join(homeDir, '.codex'))) return null

  const customModels: PiModelDefinition[] = [
    { id: 'gpt-5-codex', name: 'GPT-5 Codex', contextWindow: 200000 },
  ]

  const providers: ParsedProvider[] = [
    {
      name: 'Codex Custom',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-real-codex-custom-key',
      api: 'openai-responses',
      models: customModels,
      _sourceName: 'custom',
      _apiKeyExtracted: true,
      _warnings: [],
    },
  ]

  return { providers }
}

/**
 * 解析 Claude 源（~/.claude/settings.json / ~/.claude.json）。
 *
 * // MOCK_W3_REPLACE
 * Mock：源目录（<homeDir>/.claude）不存在返回 null。
 * 存在时返回 1 个占位 provider：
 *   - anthropic：api=anthropic-messages，apiKeyExtracted 恒 false（Claude 无明文 key 配置，
 *     key 存 OS keychain 或 OAuth token，导入后需用户手动填）。
 */
export function parseClaudeProviders(homeDir: string): ParseResult | null {
  // MOCK_W3_REPLACE：W3 替换为真实 settings.json 解析
  if (!existsSync(join(homeDir, '.claude'))) return null

  const models: PiModelDefinition[] = [
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
  ]

  const providers: ParsedProvider[] = [
    {
      name: 'Anthropic',
      // baseUrl 空：Claude 用默认端点，导入后用户可手动填
      // apiKey 空：Claude key 存 OS keychain 或 OAuth token，无法直接提取
      api: 'anthropic-messages',
      models,
      _sourceName: 'anthropic',
      _apiKeyExtracted: false,
      _warnings: ['Claude API key is stored in OS keychain or OAuth token — please fill manually after import'],
    },
  ]

  return { providers }
}

/**
 * 解析器 dispatcher：按 source 路由到对应的 Mock 解析器。
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
