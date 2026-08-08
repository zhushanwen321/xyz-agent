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

/** pi 支持的 provider api 标识全集（前后端共享 SSOT）。
 *  runtime 的 applyTypeTranslation 改为透传后，前端 Select 必须直接发送此集合内的终值。
 *  注意：pi 不支持 ollama；ollama 的前端适配在 W4 处理，runtime 不做别名翻译。 */
export const PROVIDER_API_TYPES = ['anthropic-messages', 'openai-completions'] as const
export type ProviderApiType = (typeof PROVIDER_API_TYPES)[number]

/** pi 运行时实际支持的所有 api 终值（用于 runtime warn 校验）。
 *  比 PROVIDER_API_TYPES 多 openai-responses —— 前端 Select 暂未暴露该类型，
 *  但 pi 运行时支持，传入时不应 warn。两个常量分离：前者是「前端可选」，后者是「pi 认识」。 */
export const KNOWN_PI_API_TYPES: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
])

/** Environment variable prefixes allowed to pass to child processes */
export const ENV_WHITELIST_PREFIXES: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LANG', 'TERM',
  'NODE_', 'NVM_', 'XYZ_', 'XDG_',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'SYSTEMROOT', 'TEMP', 'TMP',
  // ambient 云凭证具体变量名（spec §7）：只加具体名不整前缀（AWS_/GOOGLE_ 整前缀会
  // 把用户生产 AWS 凭证暴露给所有 pi 子进程，最小暴露面）。GOOGLE_APPLICATION_CREDENTIALS
  // 是文件型自定义 ADC 路径（spec §7 点名，漏掉则自定义路径检测不到）。
  'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_PROFILE',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GCLOUD_PROJECT', 'CLOUDSDK_REGION',
]

/**
 * ambient 云凭证相关环境变量名（spec §7 / wave-env-check）。
 * 与 ENV_WHITELIST_PREFIXES 的追加名单一致，供 shell-env.ts 回写复用（避免两处维护漂移）：
 * GUI 启动时 LaunchServices 最小环境缺这些变量，登录 shell 有值时补齐。
 */
export const AMBIENT_ENV_NAMES: readonly string[] = [
  'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_PROFILE',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GCLOUD_PROJECT', 'CLOUDSDK_REGION',
]

/** 系统提示词 replace.prompt 最大字符长度（argv 安全边界）。
 *  走 pi `--system-prompt` CLI → 进程 argv，Windows 命令行约 32k 上限，留安全边际。
 *  runtime ConfigService.setSystemPromptConfig 超限拒存；前端 UI 计数器/提示共用此值。 */
// eslint-disable-next-line no-magic-numbers
export const SYSTEM_PROMPT_MAX_LENGTH = 16000 as const

/**
 * 图片附件相关上限（SSOT）。
 *
 * write-session-image IPC 校验单图大小用 SINGLE_MAX_BYTES（防超大输入撑爆内存/磁盘）。
 */
export const IMAGE_LIMITS = {
  /** 单图上限（write-session-image IPC 校验，base64 解码字节数 <= 此值才接受） */
  // eslint-disable-next-line no-magic-numbers
  SINGLE_MAX_BYTES: 20 * 1024 * 1024,
} as const

/**
 * ADR-0021 §2/§3 预设可选 skill/agent 目录候选（UI 「可选目录」的固定来源）。
 *
 * SSOT：services/skill-dir-config.ts（buildDirConfigs 读取端）与 infra/pi/discovery-store.ts
 * （setSkillDirs/setAgentDirs 写入端）共同 import 此常量，消除本地副本漂移风险。
 *
 * 语义：用户可勾选启用/可拖排序；勾选的进 discovery.json 数组。强制目录
 * （~/.xyz-agent/...）不在此列（UI 另行只读展示）。preset 成员豁免 existsSync 脏数据过滤
 * ——推荐候选语义，启用后即使此机器不存在也要保留（防 UI 消失回归）。
 */
export const PRESET_SKILL_DIRS = [
  '~/.pi/agent/skills',
  '~/.claude/skills',
  '~/.agents/skills',
  '.agents/skills',
] as const

export const PRESET_AGENT_DIRS = [
  '~/.pi/agent/agents',
  '~/.claude/agents',
  '~/.agents/agents',
  '.agents/agents',
] as const

/**
 * extension 加载路径预设候选（镜像 skill/agent 的两套：P1 pi 原生 + P2 xyz-agent）。
 *
 * P1 pi 原生扫描目录：
 *   - ~/.pi/agent/extensions（user 级，pi 默认全局扫描）
 *   - .pi/extensions（project 级，pi 默认项目扫描，受 trust 门控）
 *
 * P2 xyz-agent 强制目录结构：
 *   - .xyz-agent/extensions（project 级；user 级 ~/.xyz-agent/extensions 是强制目录不在此列）
 *
 * 注意：extension 与 skill/agent 的目录语义不同——extension 是代码模块（注册 tool/hook/command），
 * 而非数据资源。discovery 目录顺序仅影响加载顺序（对 hook 链执行顺序有意义），不等于统一优先级。
 */
export const PRESET_EXTENSION_DIRS = [
  '~/.pi/agent/extensions',
  '.pi/extensions',
  '.xyz-agent/extensions',
] as const
