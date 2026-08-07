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
// 升级 pi-ai 后 verifyEnvVars() 做双向守卫校验（镜像表 ⊆ pi-ai 且 pi-ai ⊆ 镜像表），
// 任一方向不一致则报错 exit 1。
// 特殊标注：google-vertex 有显式 API key 路径（GOOGLE_CLOUD_API_KEY，envMap 有条目），
// 但主要凭据是 ADC 云凭证，故 authMode 仍为 ambient；amazon-bedrock 纯 ambient（AWS profile/IAM，
// envMap 无条目）为 []；openai-codex 是 oauth-only（envMap 无条目）为 []。
const PROVIDER_ENV_VARS = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
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

// 提取 model 的 11 个字段（design §4.2 / 附录 A.4；pi-ai Model 类型见 dist/types.d.ts:637）。
// id/name/api/baseUrl/reasoning/input/cost/contextWindow/maxTokens 在 pi-ai 是必填；
// thinkingLevelMap/compat 可选——缺省时置 null（保持 11 键恒定，前端契约简单）。
function summarizeModel(m) {
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    baseUrl: m.baseUrl ?? '',
    reasoning: m.reasoning,
    input: Array.isArray(m.input) ? m.input : [],
    cost: m.cost ?? null,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens ?? null,
    thinkingLevelMap: m.thinkingLevelMap ?? null,
    compat: m.compat ?? null,
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
 * 双向守卫校验 PROVIDER_ENV_VARS 镜像表与 pi-ai findEnvKeys 一致。
 *
 * 方向 1（pi-ai → 镜像表）：对 catalog 每个 provider 调 findEnvKeys，得到 pi-ai 实际识别的
 * 全部 env var 名（probeEnv 用 Proxy——任意属性读都返回真值，等价于「所有变量均已设置」，
 * 见 dist/utils/provider-env.js getProviderEnvValue 的 env?.[name] 访问），镜像表漏配即 M-1 类遗漏。
 * 方向 2（镜像表 → pi-ai）：镜像表有、findEnvKeys 不认识的 = 镜像表错配（pi-ai 改名/删除后残留）。
 * 额外：镜像表条目不在 catalog（孤儿条目）也报错（pi-ai provider 改名后旧条目残留）。
 * 任一不一致 console.error 明确报错 + exit 1（阻断 build）。
 */
export function verifyEnvVars() {
  const catalogIds = getBuiltinProviders()
  const failures = []
  // Proxy env：任意属性读返回真值 → findEnvKeys 返回该 provider 的完整 env var 列表
  const probeEnv = new Proxy({}, { get: () => 'x' })
  for (const id of catalogIds) {
    const actual = findEnvKeys(id, probeEnv) ?? []
    const mirror = PROVIDER_ENV_VARS[id] ?? []
    const missing = actual.filter((v) => !mirror.includes(v)) // pi-ai 有、镜像表漏（M-1 类遗漏）
    const extra = mirror.filter((v) => !actual.includes(v)) // 镜像表有、pi-ai 无（错配）
    if (missing.length > 0 || extra.length > 0) {
      failures.push({ provider: id, missing, extra, actual, mirror })
    }
  }
  // 镜像表条目不在 pi-ai catalog（孤儿）：provider 改名/删除后旧条目残留，同样阻断
  for (const id of Object.keys(PROVIDER_ENV_VARS)) {
    if (!catalogIds.includes(id)) {
      failures.push({ provider: id, orphan: true })
    }
  }
  if (failures.length > 0) {
    for (const f of failures) {
      if (f.orphan) {
        console.error(
          `[verifyEnvVars] provider '${f.provider}' 在镜像表但不在 pi-ai catalog —— 镜像表残留孤儿条目，请移除`,
        )
      } else {
        console.error(
          `[verifyEnvVars] provider '${f.provider}' 镜像表与 pi-ai 不一致：` +
            `镜像表漏配=${JSON.stringify(f.missing)} 镜像表错配=${JSON.stringify(f.extra)} ` +
            `(pi-ai 实际=${JSON.stringify(f.actual)} 镜像表=${JSON.stringify(f.mirror)})`,
        )
      }
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
