// prebuild 提取脚本：从 pi-ai catalog 提取 37 个内置 provider 元数据，
// 生成 packages/runtime/src/generated/builtin-providers.json 供运行时零 pi-ai 依赖消费。
//
// 关键 import 路径（已实测）：
// - getBuiltinProviders / getBuiltinModels / builtinProviders → @earendil-works/pi-ai/providers/all
// - findEnvKeys → @earendil-works/pi-ai/compat（providers/all 不导出 findEnvKeys；
//   ./env-api-keys 子路径被 package.json exports 封锁 ERR_PACKAGE_PATH_NOT_EXPORTED，
//   compat 是唯一通过 exports 校验且 re-export findEnvKeys 的入口，见 dist/compat.js:22）

import { getBuiltinProviders, getBuiltinModels, builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { findEnvKeys } from '@earendil-works/pi-ai/compat'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 镜像 pi-ai 0.82.1 dist/env-api-keys.js 的 getApiKeyEnvVars 映射。
// 升级 pi-ai 后 verifyEnvKeys() 会用 findEnvKeys 守卫校验一致性，不一致则报错 exit 1。
// ambient provider（google-vertex / amazon-bedrock）走云凭证（ADC/AWS profile），
// 不消费 env var，显式标注为 []；openai-codex 是 oauth-only，同样 []。
const PROVIDER_ENV_VARS = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': [],
  'amazon-bedrock': [],
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  'openai-codex': [],
  openrouter: ['OPENROUTER_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  xai: ['XAI_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  'ant-ling': ['ANT_LING_API_KEY'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'moonshotai-cn': ['MOONSHOT_API_KEY'],
  huggingface: ['HF_TOKEN'],
  fireworks: ['FIREWORKS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
}

// ambient provider：走云凭证（Google ADC / AWS profile），不消费 env var。
// 显式硬编码为 {google-vertex, amazon-bedrock} 两个云 provider。
// 注意：不能靠 PROVIDER_ENV_VARS[id].length === 0 推断 —— openai-codex 虽 envVars=[]
// 但它是 oauth-only（走 OAuth 流程），不是云凭证，authMode 应为 'oauth'。
const AMBIENT_PROVIDERS = new Set(['google-vertex', 'amazon-bedrock'])

function deriveAuthMode(provider) {
  if (AMBIENT_PROVIDERS.has(provider.id)) return 'ambient'
  const hasApiKey = !!provider.auth?.apiKey
  const hasOAuth = !!provider.auth?.oauth
  if (hasApiKey && hasOAuth) return 'both'
  if (hasApiKey && !hasOAuth) return 'api_key'
  if (!hasApiKey && hasOAuth) return 'oauth'
  // 理论上不可达：catalog provider 至少有一种 auth 方式
  return 'api_key'
}

function summarizeModel(m) {
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    contextWindow: m.contextWindow,
    reasoning: m.reasoning,
    input: Array.isArray(m.input) ? m.input : [],
  }
}

/**
 * 从 pi-ai catalog 提取 37 个内置 provider 元数据。纯函数无副作用，供测试与 main 共用。
 * @returns {Array<object>} provider 模板数组（见 contract c1）
 */
export function generateBuiltinProviders() {
  // getBuiltinProviders() 返回 MODELS 的 keys（37 个，自然排除 radius——radius 是 dynamic provider 无静态 catalog）
  const catalogIds = getBuiltinProviders()
  // builtinProviders() 返回完整 provider 对象数组（含 auth/baseUrl，但含 radius 共 38 个），
  // 建立 id -> provider 映射供按需取对象字段
  const providerMap = new Map(builtinProviders().map((p) => [p.id, p]))

  return catalogIds.map((id) => {
    const provider = providerMap.get(id)
    if (!provider) {
      throw new Error(
        `provider '${id}' in catalog (getBuiltinProviders) but missing from builtinProviders() — pi-ai 版本不一致?`,
      )
    }
    const models = getBuiltinModels(id)
    return {
      id: provider.id,
      name: provider.name,
      api: models[0]?.api ?? '',
      baseUrl: provider.baseUrl ?? '',
      authMode: deriveAuthMode(provider),
      envVars: PROVIDER_ENV_VARS[id] ?? [],
      oauthSupported: !!provider.auth?.oauth,
      apiKeyName: provider.auth?.apiKey?.name,
      oauthName: provider.auth?.oauth?.name,
      modelCount: models.length,
      models: models.map(summarizeModel),
      logoUrl: '',
    }
  })
}

/**
 * 用 pi-ai findEnvKeys 守卫校验 PROVIDER_ENV_VARS 镜像表与运行时一致。
 * 对每个非空 envVar 传 {[envVar]:'x'} 调 findEnvKeys，断言返回值含该 var。
 * 不一致则 console.error 明确报错 + exit 1（阻断 build）。
 */
export function verifyEnvVars() {
  const catalogIds = getBuiltinProviders()
  const failures = []
  for (const id of catalogIds) {
    const envVars = PROVIDER_ENV_VARS[id] ?? []
    for (const envVar of envVars) {
      const got = findEnvKeys(id, { [envVar]: 'x' })
      if (!Array.isArray(got) || !got.includes(envVar)) {
        failures.push({ provider: id, envVar, got: JSON.stringify(got) })
      }
    }
  }
  if (failures.length > 0) {
    for (const f of failures) {
      console.error(
        `[verifyEnvVars] provider '${f.provider}' envVar '${f.envVar}' 应被 findEnvKeys 识别，实际返回: ${f.got}`,
      )
    }
    console.error(
      `[verifyEnvVars] ${failures.length} 处不一致 —— PROVIDER_ENV_VARS 镜像表与 pi-ai findEnvKeys 不匹配，` +
        `请确认 pi-ai 版本（当前期望 0.82.1）是否升级并同步镜像表`,
    )
    process.exit(1)
  }
}

function main() {
  verifyEnvVars()
  const providers = generateBuiltinProviders()
  const payload = {
    generatedAt: new Date().toISOString(),
    piAiVersion: '0.82.1',
    providers,
  }
  const outPath = fileURLToPath(new URL('../src/generated/builtin-providers.json', import.meta.url))
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
  console.log(`[gen-builtin-providers] wrote ${providers.length} providers -> ${outPath}`)
}

// 仅当直接执行时运行 main（import 时不触发写文件，保证测试可安全 import）
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
