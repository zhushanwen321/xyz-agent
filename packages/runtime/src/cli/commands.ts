/**
 * CLI 命令实现：参数解析 + WS 消息构造 + 响应格式化。
 * 每个命令映射一个 runtime config.* 消息，逻辑单一真值源在 ConfigService。
 */
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
      // getDefaults 是订阅推送，CLI 需要主动拉——用 listProviders 的 defaultModel 字段
      // 或者直接读 settings.json。这里走 WS 查询。
      const reply = await rpc<{ defaultModel?: string }>('config.getProviders', {})
      return reply.defaultModel ?? 'not set'
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

    default:
      throw new Error(
        `Unknown command: ${command}\n\nAvailable commands:\n  list-providers\n  get-default-model\n  set-default-model\n  switch-session-model\n  set-thinking`
      )
  }
}
