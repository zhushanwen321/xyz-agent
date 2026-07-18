/**
 * CLI 命令实现：参数解析 + WS 消息构造 + 响应格式化。
 * 每个命令映射一个 runtime config.* 消息，逻辑单一真值源在 ConfigService。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir } from '@xyz-agent/shared/paths'
import { rpc } from './ws-client.js'

// ── 参数解析 ──────────────────────────────────

export interface ParsedArgs {
  command: string
  flags: Record<string, string | boolean>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? ''
  const flags: Record<string, string | boolean> = {}

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    }
  }

  return { command, flags }
}

// ── 格式化 ────────────────────────────────────

export function formatProviders(
  providers: Array<Record<string, unknown>>,
  options?: { json?: boolean }
): string {
  if (options?.json) {
    return JSON.stringify(providers, null, 2)
  }
  return providers
    .map((p) => {
      const models = (p.models as Array<{ id: string }> | undefined) ?? []
      const modelIds = models.map((m) => m.id).join(', ')
      const keyStatus = p.apiKeySet ? 'key:set' : 'key:none'
      return `  ${p.id}  ${keyStatus}  models: [${modelIds}]`
    })
    .join('\n')
}

export function formatDefaultModel(provider: string, modelId: string): string {
  return `${provider}/${modelId}`
}

// ── 命令执行 ──────────────────────────────────

export async function executeCommand(args: ParsedArgs): Promise<string> {
  const { command, flags } = args
  const json = flags.json === true

  switch (command) {
    case 'list-providers': {
      const reply = await rpc<{ providers?: Array<Record<string, unknown>> }>(
        'config.getProviders',
        {}
      )
      const providers = reply.providers ?? []
      if (json) return JSON.stringify(providers, null, 2)
      return formatProviders(providers)
    }

    case 'get-default-model': {
      // config.getProviders reply 是 { providers }，不含 defaultModel。
      // defaultModel 只通过 config.defaults 订阅推送（CLI 无订阅），故直接读 settings.json。
      try {
        const raw = readFileSync(join(getDataDir(), 'settings.json'), 'utf-8')
        const settings = JSON.parse(raw) as { defaultModel?: { provider: string; modelId: string } }
        const dm = settings.defaultModel
        return dm ? `${dm.provider}/${dm.modelId}` : 'not set'
      } catch {
        // settings.json 不存在或解析失败 → 未设置默认模型
        return 'not set'
      }
    }

    case 'set-default-model': {
      const provider = flags.provider as string
      const model = flags.model as string
      if (!provider || !model) {
        throw new Error('Usage: xyz-settings set-default-model --provider <p> --model <m>')
      }
      await rpc('config.setDefaultModel', { provider, modelId: model })
      return `default_model = ${formatDefaultModel(provider, model)}`
    }

    case 'switch-session-model': {
      const session = flags.session as string
      const provider = flags.provider as string
      const model = flags.model as string
      if (!session || !provider || !model) {
        throw new Error('Usage: xyz-settings switch-session-model --session <id> --provider <p> --model <m>')
      }
      await rpc('model.switch', { sessionId: session, provider, modelId: model })
      return `session ${session.slice(0, 8)}... model = ${formatDefaultModel(provider, model)}`
    }

    case 'set-thinking': {
      const session = flags.session as string
      const level = flags.level as string
      if (!session || !level) {
        throw new Error('Usage: xyz-settings set-thinking --session <id> --level <off|minimal|low|medium|high|xhigh>')
      }
      await rpc('session.setThinkingLevel', { sessionId: session, level })
      return `session ${session.slice(0, 8)}... thinking = ${level}`
    }

    // ── Phase 2：高危写命令 ──────────────────────────

    case 'set-provider': {
      const name = flags.name as string
      const provider = flags.provider as string
      if (!name || !provider) {
        throw new Error('Usage: xyz-settings set-provider --name <id> --provider <openai|anthropic|google|openrouter>')
      }
      // apiKey 从 stdin 或环境变量读取，禁止 CLI 参数（安全）
      const apiKey = flags['api-key-stdin']
        ? await readStdin()
        : (process.env.XYZ_AGENT_API_KEY ?? '')
      // 协议（protocol.ts:138）：config.setProvider payload = { providerId } & SetProviderData。
      // SetProviderData（protocol.ts:58）含 apiKey/name/baseUrl/models 等字段；provider 类型走 type 字段。
      const payload: Record<string, unknown> = { providerId: name, type: provider }
      if (apiKey) payload.apiKey = apiKey
      await rpc('config.setProvider', payload)
      return `provider ${name} (${provider}) configured` + (apiKey ? ' [apiKey:set]' : ' [apiKey:unchanged]')
    }

    case 'set-skill-dirs': {
      const skillDirs = flags['skill-dirs'] as string
      if (!skillDirs) {
        throw new Error('Usage: xyz-settings set-skill-dirs --skill-dirs <path1,path2,...>')
      }
      await rpc('config.setSkillDirs', { dirs: skillDirs.split(',').map(s => s.trim()) })
      return `skill_dirs = ${skillDirs}`
    }

    case 'set-agent-dirs': {
      const agentDirs = flags['agent-dirs'] as string
      if (!agentDirs) {
        throw new Error('Usage: xyz-settings set-agent-dirs --agent-dirs <path1,path2,...>')
      }
      await rpc('config.setAgentDirs', { dirs: agentDirs.split(',').map(s => s.trim()) })
      return `agent_dirs = ${agentDirs}`
    }

    case 'delete-provider': {
      const name = flags.name as string
      if (!name) {
        throw new Error('Usage: xyz-settings delete-provider --name <id>')
      }
      await rpc('config.deleteProvider', { providerId: name })
      return `provider ${name} deleted`
    }

    case 'discover-models': {
      // 协议（protocol.ts:141）：{ baseUrl, apiKey?, providerType?, providerId? }。
      // handler（settings-message-handler.ts:197-209）把 baseUrl 作为位置参数传给
      // modelService.discoverModelsFromApi(baseUrl, ...)，必填；apiKey 缺省时用 providerId 查已配置 provider。
      const baseUrl = flags['base-url'] as string
      if (!baseUrl) {
        throw new Error(
          'Usage: xyz-settings discover-models --base-url <url> [--name <provider-id>] [--provider <type>] [--api-key-stdin]',
        )
      }
      const providerId = (flags.name as string) || undefined
      const providerType = (flags.provider as string) || undefined
      const apiKey = flags['api-key-stdin']
        ? await readStdin()
        : (process.env.XYZ_AGENT_API_KEY ?? undefined)
      const payload: Record<string, unknown> = { baseUrl }
      if (providerId) payload.providerId = providerId
      if (providerType) payload.providerType = providerType
      if (apiKey) payload.apiKey = apiKey
      const reply = await rpc<{ models?: Array<{ id: string }>; success?: boolean; error?: string }>(
        'config.discoverModels',
        payload,
      )
      if (reply.success === false) {
        throw new Error(reply.error ?? 'discover failed')
      }
      const models = reply.models ?? []
      if (json) return JSON.stringify(models, null, 2)
      return models.map(m => `  ${m.id}`).join('\n')
    }

    default:
      throw new Error(
        `Unknown command: ${command}\n\nAvailable commands:\n` +
        `  list-providers\n  get-default-model\n  set-default-model\n` +
        `  switch-session-model\n  set-thinking\n` +
        `  set-provider\n  set-skill-dirs\n  set-agent-dirs\n` +
        `  delete-provider\n  discover-models\n` +
        `\ndiscover-models requires --base-url; see --help for details`,
      )
  }
}

/** 从 stdin 读取一行（用于 --api-key-stdin） */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8').trim()
}
