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
 * WS 单条消息大小上限（runtime WebSocketServer maxPayload，超限连接被 close 1009）。
 *
 * 实施期校准依据（S1-W1 ⛔ 门，spec §3.3 D4）：最大合法单条消息是贴图通路
 * （session.writeImage / message.send 的 base64 图片数组，base64 膨胀 4/3）。
 * 实测贴图分布：粘贴截图典型 1-3MB PNG，P99.9 × 2 ≈ 8MB，与 16MB 取小 → 16MB
 * 仍有余量。注意边界：IMAGE_LIMITS.SINGLE_MAX_BYTES（20MB 原图解码后）允许的单图
 * base64 化后约 26.7MB，超过 16MB 的极端原图会被本传输层上限先拒——属预期收紧
 * （贴图应压缩到 12MB 原图以内；若后续实测用户贴图 P99.9 上移，调大此常量并同步
 * 复核贴图回归验收）。
 */
// eslint-disable-next-line no-magic-numbers
export const MAX_WS_PAYLOAD_BYTES: number = 16 * 1024 * 1024

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

/**
 * 插件通知/状态栏防毒化限流参数（D7「限流与防毒化」，plugin-trust-hardening S3-W4）。
 *
 * 全部为可调常量：runtime 侧 NotifyRateLimiter / StatusBarRegistry 构造时接受覆盖
 * （默认取此处 SSOT 值），不写死在逻辑里。
 *
 * 默认值校准依据（实施期门实测，2026-08-17）：
 * - 唯一 builtin 插件 statusline（resources/plugins/statusline/index.ts）代码路径
 *   **零 notify 调用**——它只被动响应 plugin:statusSetUpdate hook 转发 updateStatusBarItem，
 *   因此 notify 通道的参照实测值 = 0 条/s。
 * - statusbar 更新上游（pi extension setStatus → status-set → statusline 转发）实测：
 *   a) 真实会话日志（~/.xyz-agent/logs/pi-*.jsonl，2026-08-17 最繁忙 session）：
 *      4.6h 内 74 条 setStatus（goal 57 / todo 17），均值 ≈ 0.005 条/s；
 *   b) 活动探针（pi --mode rpc + pi-statusline + goal/todo extensions，真实 LLM turn
 *      含 todo 工具写）：完整 turn 13.1s 内 4 条，1s 窗口最大突发 = 2 条
 *      （session 初始化时 todo+plan-mode 两条相邻 2ms）。
 * - 结论：正常插件通知是用户动作/turn 边界触发型，实测突发峰值 2 条/s；
 *   20 条/s 是失控水平（连续打满令牌桶）的 ~10 倍量级，作为默认值留足余量
 *   且不会误伤任何合法 builtin 行为。
 */
export const PLUGIN_NOTIFY_LIMITS = {
  /** notify 令牌桶速率（条/秒/插件，容量 = 速率，即可瞬时突发该数） */
  // eslint-disable-next-line no-magic-numbers
  NOTIFY_RATE_PER_SEC: 20,
  /** 单条 notify message 上限（UTF-8 字节）。超出拒绝（INVALID_MESSAGE） */
  // eslint-disable-next-line no-magic-numbers
  NOTIFY_MESSAGE_MAX_BYTES: 8 * 1024,
  /** statusbar 单条 text 上限（UTF-8 字节）。D3 验收「1MB text 被拒」依此规则 */
  // eslint-disable-next-line no-magic-numbers
  STATUSBAR_TEXT_MAX_BYTES: 4 * 1024,
  /** statusbar 更新广播合并窗口（ms）：窗口内多次更新合并为一次广播 */
  // eslint-disable-next-line no-magic-numbers
  STATUSBAR_COALESCE_MS: 100,
} as const

/**
 * 前端 toast 并发上限（D7「限流与防毒化」）。
 *
 * 在列 toast 超过上限时新 toast 丢弃并计数（droppedCount），防止通知风暴刷屏。
 * 5 = 单屏可读的告警密度上限；与 runtime 侧 20/s 限流叠加构成两道独立防线。
 */
// eslint-disable-next-line no-magic-numbers
export const UI_TOAST_LIMITS = { MAX_IN_FLIGHT: 5 } as const
