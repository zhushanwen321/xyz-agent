/**
 * Shared constants used by both runtime (Node.js) and renderer (Electron).
 * Single source of truth — import from here, never hardcode.
 */

/** Base port for the runtime WebSocket server */
// eslint-disable-next-line no-magic-numbers
export const BASE_PORT = 3210 as const

/** Port offset used in dev mode to avoid connecting to prod runtime */
// eslint-disable-next-line no-magic-numbers
export const DEV_PORT_OFFSET = 100 as const

/** Maximum valid port number */
// eslint-disable-next-line no-magic-numbers
export const MAX_PORT = 65535 as const

/** pi-subagents 扩展的 subagent tool 名集合（识别 subagent 调用用，SSOT）。
 *  pi-subagents 通过名为 "subagent" 的 tool 执行子 agent，前端据此判定特殊渲染。 */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['subagent'])

/** pi-subagent-workflow 扩展的 workflow tool 名集合（识别 workflow 调用用，SSOT）。
 *  workflow 扩展通过名为 "workflow" 的 tool 执行 workflow run，event-interpreter 据此
 *  捕获发起时刻（action=run → 广播 session.workflows 增量信号）。 */
export const WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set(['workflow'])

/** pi 支持的 provider api 标识（前后端共享 SSOT）。
 *  runtime 的 applyTypeTranslation 改为透传后，前端 Select 必须直接发送此集合内的终值。
 *  注意：pi 不支持 ollama；ollama 的前端适配在 W4 处理，runtime 不做别名翻译。 */
export const PROVIDER_API_TYPES = ['anthropic-messages', 'openai-completions'] as const
export type ProviderApiType = (typeof PROVIDER_API_TYPES)[number]

/** Environment variable prefixes allowed to pass to child processes */
export const ENV_WHITELIST_PREFIXES: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LANG', 'TERM',
  'NODE_', 'NVM_', 'XYZ_', 'XDG_',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'SYSTEMROOT', 'TEMP', 'TMP',
]
