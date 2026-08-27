/**
 * 等价性测试 fixture：spawn 真实 `pi --mode rpc` 子进程（W5 净新增基建）。
 *
 * skip-if-no-real-pi 约定（契约锁定，后续 W7-W12 / W20-W22 / W25 equivalence 用例唯一引用点）：
 * - 本模块顶层 `export const PI_PATH = detectPi()`——which/where pi 探测，命令形态与生产代码
 *   `src/infra/pi/process-manager.ts`（isWindows ? 'where pi' : 'which pi'）完全一致；
 *   探测失败返回 null。
 * - 本模块顶层 `export const REAL_PI_READY` / `REAL_PI_SKIP_REASON = detectRealPiSkipReason()`——
 *   pi binary **与 LLM 凭证**双探测（凭证按 pi 实际解析链：env API key / auth.json stored 条目 /
 *   models.json providers apiKey）。CI 无凭证环境若只判 PI_PATH 会 fail 而非 skip（pi binary
 *   经 pnpm PATH 在 CI 可达）——这是等价性基线双轨的机制基础（见 TEST-STRATEGY.md §4）。
 * - 引用方一律 `describe.skipIf(!REAL_PI_READY)` 包裹「真实 spawn + 真实 LLM turn」用例——
 *   binary 或凭证缺席的环境（如 CI）skip 而非 fail；skip 理由注入 describe 名 + 模块加载时
 *   console.warn（双通道显式可见）。
 * - 纯 mock / fixture 重放用例（不发起 LLM 调用）不依赖 REAL_PI_READY，无条件执行——
 *   CI 继续覆盖凭证无关子集。
 * - 禁止 mock pi 子进程（vi.mock('node:child_process') 形态）——本测试族的价值就在真实子进程。
 *
 * 协议事实（pi 0.84 实测探针 + pi-mono rpc-mode.ts / agent-session.ts 源码核实）：
 * - stdin 写 JSONL 命令 `{id, type, ...params}\n`；stdout 逐行回
 *   `{id, type:'response', command, success[, data][, error]}`（id 与请求配对）。
 * - pi rpc 模式启动时自动 `session.subscribe` 并把 session 事件原样转发到 stdout
 *   （message_start/message_update/message_end、agent_end 等），无需（也不存在）
 *   session.subscribe RPC 命令——collectEvents() 直接消费该事件流。
 * - `message_end.message` 与 `get_entries` 返回的 message entry `.message` 是同一对象
 *   （agent-session.ts `_handleAgentEvent`：先 emit message_end、随后 appendMessage(event.message)
 *   持久化）——这是 live ≡ reload 断言的协议层依据。
 * - pi 0.84 不为常规 entry append 发 entry 事件（entry_appended 仅 extension appendEntry 路径），
 *   故实时累积的 entry 快照以 message_end 流为等价源（断言对象 = 原始消息/entry 序列，W20-W21
 *   后升级 store 级快照）。
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/** 低成本测试模型（workspace AGENTS.md pi 实测流程同款，验收契约锁定）。导出供附着恢复用例做 CLI-model 对照断言。 */
export const DEFAULT_MODEL = 'xiaomi-token-plan-cn/mimo-v2.5-pro'
/** 冷启动就绪等待上限（探针结论中位数 ~500ms，取 10 倍余量） */
const DEFAULT_COLD_START_TIMEOUT_MS = 5_000
/** 单条 RPC 命令默认超时 */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
/** dispose 时 SIGTERM 后等优雅退出的上限，超时升级 SIGKILL */
const KILL_TIMEOUT_MS = 2_000
const STDERR_BUFFER_MAX_LINES = 50
const STDERR_TAIL_LINES = 10
const UNPARSEABLE_BUFFER_MAX_LINES = 20
/** waitForEvent 的事件轮询间隔（events 数组无推送通知，靠定时重查） */
const EVENT_POLL_INTERVAL_MS = 50

/** pi AgentMessage 的宽形态（等价性断言做整体 deep equal，只声明消费到的字段） */
export interface PiAgentMessage {
  role: string
  [key: string]: unknown
}

/** pi RPC 响应（stdout 上 type === 'response' 的行，id 与请求配对） */
export interface PiRpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: Record<string, unknown>
  error?: string
}

/** pi session 事件（stdout 上非 response 的行；message_* / agent_end 等携带业务字段） */
export interface PiStreamEvent {
  type: string
  message?: PiAgentMessage
  [key: string]: unknown
}

export interface PiFixtureOptions {
  /**
   * spawn 模型（默认 DEFAULT_MODEL）。显式 null = 不拼 --model——P1（final gate）附着
   * 恢复用例专用：pi CLI model 恒优先于 session entry 恢复，不拼才能让 model_change
   * entry 终态生效（生产对应 RpcClientOptions.inheritSessionModel）。
   */
  model?: string | null
  coldStartTimeoutMs?: number
  commandTimeoutMs?: number
  /**
   * 显式注入的 extension 路径（生产 RpcClientOptions.extensionPaths 同款）：
   * 每个路径一个 --extension 参数。省略 = 不注入。
   */
  extensions?: string[]
  /**
   * 显式 session-dir（默认 mkdtemp 临时目录）。U9 全链路 e2e 用：session-dir 须落在
   * XYZ_AGENT_DATA_DIR/pi/sessions 下（名字带 u9-smoke）供 scanPiSessions 复扫断言；
   * dispose 仍会删除该目录（含自定义路径）。
   */
  sessionDir?: string
}

export interface PiFixture {
  readonly piPath: string
  /** 临时 session-dir（dispose 后被删除；测试可对其做 existsSync 清理断言） */
  readonly sessionDir: string
  readonly exited: boolean
  /** stdin 写 JSONL 命令并等待配对 id 的响应；success === false 时 reject */
  sendCommand(type: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<PiRpcResponse>
  /** stdin 写原始 JSONL 行（extension_ui_response 等 sendCommand 不覆盖的命令形态）。 */
  writeLine(line: string): void
  /** 收集至今的事件流快照（可选谓词过滤）；实时累积快照的唯一来源 */
  collectEvents(predicate?: (event: PiStreamEvent) => boolean): PiStreamEvent[]
  /** 轮询等待首条命中谓词的事件（进程提前退出时 reject）。第二参数为选项对象：
   * since 为事件数组下标，只匹配下标之后的事件（事件游标/新鲜度语义，设计 D3）；
   * 缺省（undefined）保持全量历史匹配语义——刻意不翻转默认：快 turn 可能在
   * sendCommand resolve 与 waitForEvent 调用之间的毫秒级窗口内完成，默认语义翻转会让
   * agent_end 先于调用到达 → 永久等不到。签名由数字改为对象是 break 真正意图：
   * TS 编译期抓出全部漏改调用点（无静默回归通道）。 */
  waitForEvent(
    predicate: (event: PiStreamEvent) => boolean,
    opts?: { timeoutMs?: number; since?: number },
  ): Promise<PiStreamEvent>
  /** 返回当前事件数组下标，供调用方在触发动作前打点（配合 waitForEvent 的 since 使用）。
   * 替代手工 collectEvents().length 计数防御写法——打点动作与等待动作之间只隔一个表达式。 */
  markEvents(): number
  /** 原子化 turn 原语（设计 D4）：markEvents → 护栏放行后发 prompt → 只等本轮 agent_end（since 打点）。
   * 消除「ack 与注册等待之间的完成竞态」+「上一轮旧 agent_end 假命中」两类缺陷；
   * 新文件的最短路径即正确路径（by construction 而非靠纪律）。
   * 仅覆盖「空闲起步 prompt + 等 agent_end」形态：steer/follow_up/streamingBehavior 转发
   * 属流中投递（语义前提就是 busy 时入队），不经本原语也不经护栏。 */
  runTurn(params: { message: string }, timeoutMs?: number): Promise<PiStreamEvent>
  /** 失败兜底（设计 D2）：busy 时 abort 在途 turn 并 drain 至清态；非 busy 零操作幂等返回。
   * 共享 fixture 文件应在 afterEach 调用，防上一用例失败后在途 turn 毒死后续用例
   * （pi 会拒绝并发 prompt：Agent is already processing）。 */
  recover(): Promise<void>
  /** kill 子进程（SIGTERM → 2s 上限 → SIGKILL）+ 删除临时目录；幂等 */
  dispose(): Promise<void>
}

/** 探测 pi 可执行文件路径（命令形态与生产 process-manager.ts 一致；失败返回 null） */
function detectPi(): string | null {
  const isWindows = process.platform === 'win32'
  const whichCmd = isWindows ? 'where pi' : 'which pi'
  try {
    const which = execSync(whichCmd, { encoding: 'utf-8' }).trim()
    // Windows 'where' 可能返回多行，取第一条（与生产逻辑一致）
    const firstMatch = which.split('\n')[0]?.trim()
    if (firstMatch && existsSync(firstMatch)) return firstMatch
    return null
  } catch {
    // expected: pi not in PATH —— 进入 skip 语义
    return null
  }
}

/** 模块顶层探测结果（skip-if-no-pi 契约的唯一引用点，见文件头注释；本模块内部消费，不导出） */
const PI_PATH: string | null = detectPi()

// ==================== 真实 LLM 凭证探测（等价性基线双轨，goal-audit 问题 1 修复） ====================

/**
 * 强制跳过真实 pi（LLM turn）用例的 env 开关（'1' / 'true' 生效）。
 * CI test-runtime job 显式设置——把「CI 只跑凭证无关子集」从隐式事实（CI 恰好无 ~/.pi）
 * 变为显式声明；本机也可用它模拟无凭证环境验证 skip 语义。双轨说明见 TEST-STRATEGY.md §4。
 */
const FORCE_SKIP_REAL_PI_ENV = 'XYZ_SKIP_REAL_PI'

/** DEFAULT_MODEL 的 provider id（pi 模型 id 形态 `<provider>/<modelId>`，'/' 前缀段） */
const DEFAULT_PROVIDER = DEFAULT_MODEL.split('/')[0]!

/** pi agent 目录（凭证所在）：与 pi config.ts getAgentDir() 同规则——PI_CODING_AGENT_DIR
 * 覆盖 → ~/.pi/agent。spawn 出的 pi 按此路径读凭证，探测必须同源否则误判。 */
function piAgentDir(): string {
  const envDir = process.env['PI_CODING_AGENT_DIR']
  if (envDir && envDir.trim() !== '') return envDir
  return join(homedir(), '.pi', 'agent')
}

/** provider 的 env API key 变量名（pi-ai env-api-keys.ts 映射表同形态：
 * 大写 + '-'→'_' + '_API_KEY' 后缀，如 xiaomi-token-plan-cn → XIAOMI_TOKEN_PLAN_CN_API_KEY）。 */
function providerEnvApiKey(provider: string): string {
  return `${provider.toUpperCase().replaceAll('-', '_')}_API_KEY`
}

interface ReadJsonResult {
  data?: unknown
  /** 文件不可读/不可解析时的错误（进 skip 理由，格式问题不静默） */
  error?: string
}

function readJsonFile(path: string): ReadJsonResult {
  try {
    return { data: JSON.parse(readFileSync(path, 'utf-8')) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 真实 pi（LLM turn）用例可用性探测：null = 就绪；非 null = skip 理由。
 *
 * 探测链对齐 pi 实际凭证解析（pi-mono auth-storage.ts hasAuth / model-registry 的静态 source）：
 * 1. env API key（environment source）
 * 2. `<agentDir>/auth.json` 的 provider 条目含非空 key（stored source，主路径——
 *    DEFAULT_MODEL 走 pi 内置 provider，本机凭证即此形态）
 * 3. `<agentDir>/models.json` providers[provider].apiKey（models_json_key source，补充路径）
 * OAuth 型凭证（token 刷新依赖 pi 运行时交互）不判定可用——只认静态可读的 api_key 形态。
 * 探测只读文件与 env，不发起网络请求，不触碰凭证值本身。
 */
function detectRealPiSkipReason(): string | null {
  if (!PI_PATH) return 'pi binary not found（which/where pi 未命中）'

  const forced = process.env[FORCE_SKIP_REAL_PI_ENV]
  if (forced === '1' || forced === 'true') {
    return `env ${FORCE_SKIP_REAL_PI_ENV}=${forced}（等价性基线双轨：本环境只跑凭证无关子集，完整基线含真实 LLM turn 跑在开发机，见 TEST-STRATEGY.md §4）`
  }

  const agentDir = piAgentDir()
  const checked: string[] = []

  // 1) env API key
  const envKey = providerEnvApiKey(DEFAULT_PROVIDER)
  const envValue = process.env[envKey]
  if (envValue && envValue.trim() !== '') return null
  checked.push(`env ${envKey}`)

  // 2) auth.json provider 条目（stored source，主路径）
  const authPath = join(agentDir, 'auth.json')
  const auth = readJsonFile(authPath)
  if (auth.data !== undefined) {
    const cred = (auth.data as Record<string, unknown>)[DEFAULT_PROVIDER]
    if (typeof cred === 'object' && cred !== null) {
      const key = (cred as { key?: unknown }).key
      if (typeof key === 'string' && key.trim() !== '') return null
      checked.push(`${authPath} 的 "${DEFAULT_PROVIDER}" 条目缺非空 key`)
    } else {
      checked.push(`${authPath} 无 "${DEFAULT_PROVIDER}" 条目`)
    }
  } else {
    checked.push(`${authPath}（${auth.error ?? '不存在或不可读'}）`)
  }

  // 3) models.json providers[provider].apiKey（models_json_key source）
  const modelsPath = join(agentDir, 'models.json')
  const models = readJsonFile(modelsPath)
  if (models.data !== undefined) {
    const providers = (models.data as { providers?: unknown }).providers
    const entry =
      typeof providers === 'object' && providers !== null
        ? (providers as Record<string, unknown>)[DEFAULT_PROVIDER]
        : undefined
    const apiKey = typeof entry === 'object' && entry !== null ? (entry as { apiKey?: unknown }).apiKey : undefined
    if (typeof apiKey === 'string' && apiKey.trim() !== '') return null
    checked.push(`${modelsPath} providers."${DEFAULT_PROVIDER}".apiKey`)
  } else {
    checked.push(`${modelsPath}（${models.error ?? '不存在或不可读'}）`)
  }

  return `pi 凭证不可用：DEFAULT_MODEL "${DEFAULT_MODEL}" 需要 provider "${DEFAULT_PROVIDER}" 的 API key，已探测 ${checked.join('；')} 均未命中。真实 LLM turn 用例 skip（mock / fixture 重放子集照跑），完整等价性基线请在凭证在位的开发机运行（TEST-STRATEGY.md §4 等价性双轨）`
}

/** 凭证探测结果（模块顶层，真实 pi 用例 skip 判定的唯一引用点）：
 * null = binary + 凭证双就绪；非 null = skip 理由（binary 缺席 / 凭证缺失 / env 强制三态可分辨）。 */
export const REAL_PI_SKIP_REASON: string | null = detectRealPiSkipReason()

/** 真实 pi（LLM turn）用例可运行。引用方一律 `describe.skipIf(!REAL_PI_READY)`
 * （取代只判 binary 的旧 `!PI_PATH` 条件——pi binary 在 CI 可达但凭证不可达）。 */
export const REAL_PI_READY: boolean = REAL_PI_SKIP_REASON === null

if (!REAL_PI_READY) {
  // skip 理由显式可见：模块加载时输出（每个引用文件一次）+ describe 名注入（见各测试文件）
  console.warn(`[equivalence] 真实 pi（LLM turn）用例 skip：${REAL_PI_SKIP_REASON}`)
}

interface PendingEntry {
  resolve: (msg: PiRpcResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function isRpcResponse(msg: unknown): msg is PiRpcResponse {
  if (typeof msg !== 'object' || msg === null) return false
  return (msg as Record<string, unknown>).type === 'response'
}

function asStreamEvent(msg: unknown): PiStreamEvent | null {
  if (typeof msg !== 'object' || msg === null) return null
  if (typeof (msg as Record<string, unknown>).type !== 'string') return null
  return msg as PiStreamEvent
}

/**
 * spawn 一个真实 pi rpc 子进程，等冷启动就绪后返回操作句柄。
 *
 * spawn 命令形态（验收契约锁定）：`pi --mode rpc --session-dir <tmp> --model <model> --approve`。
 * cwd 设为临时 session-dir：隔离项目上下文（tmp 内无 AGENTS.md / .pi），不污染真实项目。
 */
export async function spawnPiFixture(options: PiFixtureOptions = {}): Promise<PiFixture> {
  if (!PI_PATH) {
    throw new Error('pi binary not found (which/where pi) —— equivalence 用例必须以 describe.skipIf(!REAL_PI_READY) 包裹')
  }
  if (!REAL_PI_READY) {
    // describe.skipIf 已挡住正常路径；此处兜底防新用例漏包 skip 条件时以含理由的错误暴露
    throw new Error(`real pi unavailable：${REAL_PI_SKIP_REASON} —— 真实 pi 用例必须以 describe.skipIf(!REAL_PI_READY) 包裹`)
  }
  const model = options.model === undefined ? DEFAULT_MODEL : options.model
  const coldStartTimeoutMs = options.coldStartTimeoutMs ?? DEFAULT_COLD_START_TIMEOUT_MS
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS

  const sessionDir = options.sessionDir ?? mkdtempSync(join(tmpdir(), 'pi-equiv-'))
  const args = ['--mode', 'rpc', '--session-dir', sessionDir]
  if (model) args.push('--model', model)
  args.push('--approve')
  for (const extPath of options.extensions ?? []) {
    args.push('--extension', extPath)
  }
  const proc: ChildProcess = spawn(PI_PATH, args, {
    cwd: sessionDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const pending = new Map<string, PendingEntry>()
  const events: PiStreamEvent[] = []
  // turn 生命周期状态（设计 D1）：busy 状态机——prompt 的 ack 到达置位，本轮 agent_end 清态。
  // 用事件游标推导而非 get_state 轮询 isStreaming：ack 与 streaming 翻真正先后是未实测时序断言，
  // 且每 prompt 多一轮 RPC 往返；fixture 本就全量收事件，游标判定零额外 IPC。
  let busy = false
  let turnStartIdx = -1
  const isPromptWithoutStreamingBehavior = (params: Record<string, unknown>): boolean =>
    !('streamingBehavior' in params)
  const stderrLines: string[] = []
  const unparseableLines: string[] = []
  let msgCounter = 0
  let exited = false

  const stderrTail = (): string =>
    stderrLines.length === 0
      ? ''
      : `\npi stderr (last ${STDERR_TAIL_LINES} lines):\n${stderrLines.slice(-STDERR_TAIL_LINES).join('\n')}`

  const rejectAll = (err: Error): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    pending.clear()
  }

  proc.on('error', (err) => {
    exited = true
    rejectAll(new Error(`pi spawn error: ${err.message}`))
  })
  proc.on('exit', (code) => {
    exited = true
    rejectAll(new Error(`pi process exited with code ${code}${stderrTail()}`))
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trimEnd()
    if (!text) return
    stderrLines.push(text)
    if (stderrLines.length > STDERR_BUFFER_MAX_LINES) stderrLines.shift()
  })

  const rl = createInterface({ input: proc.stdout! })
  rl.on('line', (line: string) => {
    if (!line.trim()) return
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      // stdout 非 JSONL 行：截留供诊断（正常协议流不应出现）
      unparseableLines.push(line)
      if (unparseableLines.length > UNPARSEABLE_BUFFER_MAX_LINES) unparseableLines.shift()
      return
    }
    if (isRpcResponse(msg)) {
      const entry = msg.id ? pending.get(msg.id) : undefined
      if (!entry) return // 迟到的超时响应，丢弃
      clearTimeout(entry.timer)
      pending.delete(msg.id!)
      if (msg.success === false) {
        entry.reject(new Error(`RPC "${msg.command}" failed: ${msg.error ?? '(no error message)'}`))
      } else {
        entry.resolve(msg)
      }
      return
    }
    const event = asStreamEvent(msg)
    if (event) {
      const idx = events.length
      events.push(event)
      // busy 清态：agent_end 出现在本轮起点下标之后才有效——上一轮遗留的旧 agent_end
      // 不清本轮（事件新鲜度语义）。followUp 接续多轮期间 pi 只在队列 drain 后发最终
      // agent_end（broadcast-getstate :146 注释口径），故首个中间 agent_end 根本不会到达。
      if (busy && idx >= turnStartIdx && event.type === 'agent_end') {
        busy = false
        turnStartIdx = -1
      }
    }
  })

  // 内层原始发送（id 配对响应）；外层守卫版 sendCommand 对 prompt 入口套 busy 护栏
  const rawSendCommand = (
    type: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = commandTimeoutMs,
  ): Promise<PiRpcResponse> =>
    new Promise((resolve, reject) => {
      if (exited) {
        reject(new Error(`pi process not running (RPC "${type}")${stderrTail()}`))
        return
      }
      const id = `fixture_${++msgCounter}_${Date.now()}`
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`RPC "${type}" timed out after ${timeoutMs}ms${stderrTail()}`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (msg) => {
          // ack 到达即置 busy（P-ack-order 已核实：ack 先于该轮 agent_end）；
          // 带 streamingBehavior 的 prompt 是流中投递语义，不进护栏状态机
          if (type === 'prompt' && isPromptWithoutStreamingBehavior(params)) {
            busy = true
            turnStartIdx = events.length
          }
          resolve(msg)
        },
        reject,
        timer,
      })
      proc.stdin!.write(JSON.stringify({ id, type, ...params }) + '\n', (err) => {
        if (err) {
          clearTimeout(timer)
          pending.delete(id)
          reject(new Error(`stdin write failed (RPC "${type}"): ${err.message}`))
        }
      })
    })

  /** abort 在途 turn 并等待 drain 至清态（护栏超时与 recover 共用的兜底层）。 */
  const abortDrain = async (drainTimeoutMs: number): Promise<void> => {
    try {
      await rawSendCommand('abort')
    } catch {
      // 进程可能已退出/abort 已被处理：尽力而为，drain 循环会给出最终判定
    }
    const deadline = Date.now() + drainTimeoutMs
    while (busy && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, EVENT_POLL_INTERVAL_MS))
    }
  }

  /** busy 护栏（G1 本体）：busy=false 直接放行零开销（P-guard-noop by construction）；
   * busy 超预算先 abort 再重试一次（D2），仍 busy 则抛带证据与恢复指引的错误。 */
  const waitIdleGuard = async (): Promise<void> => {
    if (!busy) return
    const deadline = Date.now() + commandTimeoutMs
    while (busy && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, EVENT_POLL_INTERVAL_MS))
    }
    if (!busy) return
    await abortDrain(commandTimeoutMs)
    if (busy) {
      throw new Error(
        `pi fixture busy guard: in-flight turn 未在预算内终结（abort+drain 各 ${commandTimeoutMs}ms 后仍 busy）${stderrTail()}\n` +
          `👉 建议：对该 fixture 调 recover() 兜底，或单跑定位占用来源：npx vitest run <文件路径>`,
      )
    }
  }

  const sendCommand = (
    type: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = commandTimeoutMs,
  ): Promise<PiRpcResponse> =>
    type === 'prompt' && isPromptWithoutStreamingBehavior(params)
      ? waitIdleGuard().then(() => rawSendCommand(type, params, timeoutMs))
      : rawSendCommand(type, params, timeoutMs)

  const collectEvents = (predicate?: (event: PiStreamEvent) => boolean): PiStreamEvent[] =>
    predicate ? events.filter(predicate) : [...events]

  const writeLine = (line: string): void => {
    proc.stdin!.write(line + '\n')
  }

  const waitForEvent = (
    predicate: (event: PiStreamEvent) => boolean,
    opts: { timeoutMs?: number; since?: number } = {},
  ): Promise<PiStreamEvent> => {
    const timeoutMs = opts.timeoutMs ?? commandTimeoutMs
    const since = opts.since ?? 0
    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const poll = (): void => {
        // since 游标：只匹配下标之后的事件（D3 新鲜度语义）；缺省 0 = 既有全量匹配语义不变
        let found: PiStreamEvent | undefined
        for (let i = since; i < events.length; i++) {
          if (predicate(events[i]!)) {
            found = events[i]
            break
          }
        }
        if (found) {
          resolve(found)
          return
        }
        if (exited) {
          reject(new Error(`pi exited while waiting for event${stderrTail()}`))
          return
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`timed out after ${timeoutMs}ms waiting for event; seen types: ${[...new Set(events.map((e) => e.type))].join(', ') || '(none)'}`))
          return
        }
        setTimeout(poll, EVENT_POLL_INTERVAL_MS)
      }
      poll()
    })
  }

  /** 当前事件下标打点：markEvents() 触发动作 … waitForEvent(…, { since: 打点 }) 三步组合的游标原语 */
  const markEvents = (): number => events.length

  const recover = async (): Promise<void> => {
    if (!busy) return
    await abortDrain(commandTimeoutMs)
    if (busy) {
      throw new Error(`pi fixture recover failed: abort+drain ${commandTimeoutMs}ms 后仍 busy${stderrTail()}`)
    }
  }

  const runTurn = async (params: { message: string }, timeoutMs?: number): Promise<PiStreamEvent> => {
    const mark = markEvents()
    await sendCommand('prompt', params)
    return waitForEvent((e) => e.type === 'agent_end', {
      since: mark,
      timeoutMs: timeoutMs ?? commandTimeoutMs * 4,
    })
  }

  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    if (!exited) {
      // pi rpc-mode 注册了 SIGTERM 优雅退出（flush 后 exit）
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => resolve(), KILL_TIMEOUT_MS)
        proc.once('exit', () => {
          clearTimeout(killTimer)
          resolve()
        })
        proc.kill('SIGTERM')
      })
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL')
      }
    }
    rejectAll(new Error('pi fixture disposed'))
    rl.close()
    rmSync(sessionDir, { recursive: true, force: true })
  }

  // 冷启动就绪探针：get_state 是毫秒级只读 RPC；stdin 是管道，早写的数据缓冲到 pi
  // 开始读取为止，不会丢失，故单发探针即可。失败即 dispose + 抛错（带 stderr 证据）。
  try {
    await sendCommand('get_state', {}, coldStartTimeoutMs)
  } catch (e) {
    await dispose()
    const unparseableNote = unparseableLines.length > 0 ? `；stdout 非 JSONL 行 ${unparseableLines.length} 条` : ''
    throw new Error(`pi 冷启动就绪等待失败（上限 ${coldStartTimeoutMs}ms${unparseableNote}）：${e instanceof Error ? e.message : String(e)}`)
  }

  return {
    piPath: PI_PATH,
    sessionDir,
    get exited() {
      return exited
    },
    sendCommand,
    writeLine,
    collectEvents,
    waitForEvent,
    markEvents,
    runTurn,
    recover,
    dispose,
  }
}
