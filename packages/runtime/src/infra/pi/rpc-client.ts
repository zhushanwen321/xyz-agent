import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { getSessionsDir, getPiAgentDir } from './pi-paths.js'
import { getDefaultModel } from './pi-provider-store.js'
import { RpcTimeoutError } from '../../utils/errors.js'
import type { ThinkingLevel, ProviderId } from '@xyz-agent/shared'
// B3 出站契约唯一构建器（U3 收口点；实现本体在 @xyz-agent/shared，此处走 runtime 门面）
import { buildOutboundChildEnv } from '../spawn-env.js'
import type { IPiEngine, PiSessionStats, PiCompactionResult, PiBashResult, PiCommandInfo } from '../../services/ports/pi-engine.js'
import { createPiSessionLog, type PiSessionLog } from '../logger.js'

/**
 * Generic shape of a message received from pi's JSONL stdout.
 * Broader than PiAnyIncomingMessage in types.ts — covers both RPC responses
 * (with success/error/data) and unsolicited events (with various payloads).
 * The listener API uses this wide type; consumers narrow via event.type.
 */
export interface PiMessage {
  id?: string
  type: string
  payload?: Record<string, unknown>
  /** pi RPC 响应的 data 字段（如 get_state 返回 sessionFile/sessionId） */
  data?: Record<string, unknown>
  success?: boolean
  error?: string
}

export type PiEventListener = (event: PiMessage) => void

/**
 * pi get_available_models 返回的模型元素（pi-ai Model 翻译为内部消费形状的子集：
 * id/provider/reasoning/thinkingLevelMap，对账所需字段）。
 *
 * 非 Pi 前缀命名：本类型会被 services/model-capability.ts 消费——PiXxx 命名只许
 * 留在 infra/pi 内部（check_pi_type_leak / runtime-three-layer-design 边界规则），
 * 对上导出的翻译类型用内部命名（pi-events 翻译范式）。
 */
export interface AvailableModelSnapshot {
  id: string
  /** pi Model.provider（provider id，如 'zai-coding-cn'）。 */
  provider: string
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string | null>
}

export interface RpcClientOptions {
  cwd?: string
  model?: string
  /**
   * 附着恢复模式（restoreSession 专用）：true 时 start() 不拼 --model——options.model
   * 与全局默认兜底都被抑制。pi 的 CLI model 恒优先于 session entry 恢复（main.js
   * buildSessionOptions 的 `if (parsed.model)` 分支），拼了就会把用户在会话内切换过的
   * 模型在重启重开时静默压回默认（final gate V1⑤ 实证）；模型终态由 pi 从
   * model_change entry 恢复。create/fork 保持 launch 语义（不设此开关）。
   */
  inheritSessionModel?: boolean
  env?: Record<string, string>
  skillPaths?: string[]
  /** pi 可执行文件路径（默认 'pi'，从 PATH 查找） */
  piCommand?: string
  /** pi 扩展路径列表，每个路径通过 --extension 参数传递 */
  extensionPaths?: string[]
  /** session id（用于命名 pi stdout 日志文件，架构约定 #4） */
  sessionId?: string
  /** 替换 pi 核心系统提示词（走 --system-prompt CLI，仅新建会话生效）。空白时不传。 */
  systemPrompt?: string
  /**
   * 工具白名单（替换语义，映射 pi `--tools <comma-joined>`，附录 A.1）。
   * 非空时以逗号连接 push，只启用列出的工具。与 excludeTools/noTools 互斥；
   * 同时出现多个时 rpc-client 按 noTools > tools > excludeTools 优先级取一个并 warn（W-RT-6）。
   */
  tools?: string[]
  /**
   * 工具黑名单（叠加语义，映射 pi `--exclude-tools <comma-joined>`，附录 A.1）。
   * 在 pi 默认启用集合之上排除列出的工具。与 tools/noTools 互斥（见 tools 注释的优先级）。
   */
  excludeTools?: string[]
  /** 禁用所有工具（built-in + extension + custom），映射 pi `--no-tools`。与 tools/excludeTools 互斥。 */
  noTools?: boolean
  /** 禁用所有 skill，映射 pi `--no-skills`。调用方同时需清空 skillPaths。 */
  noSkills?: boolean
  /** 禁用 context files（AGENTS.md/CLAUDE.md 自动发现），映射 pi `--no-context-files`。 */
  noContextFiles?: boolean
  /** 覆盖思考级别，映射 pi `--thinking <level>`（注意：非 --thinking-level，附录 A.4）。 */
  thinkingLevel?: ThinkingLevel
}

const CMD_TIMEOUT_MS = 60_000
const COMPACT_TIMEOUT_MS = 300_000
const KILL_TIMEOUT_MS = 2_000
/** 快速操作超时（L6：getState/getCommands 等毫秒级 RPC，10s 足够，60s 等太久才报错） */
const FAST_TIMEOUT_MS = 10_000
/** 慢操作超时（L6：switchSession 加载大 session 文件可能耗时，120s 避免误超时） */
const SLOW_TIMEOUT_MS = 120_000
const STARTUP_DELAY_MS = 500
/** timedOutIds 条目存活时间（S6：超时后迟到响应的防御窗口，5s 后清理避免 Set 无界增长） */
const TIMED_OUT_ID_TTL_MS = 5_000
const STDERR_BUFFER_MAX_LINES = 50
const STDERR_TAIL_LINES = 10

/**
 * RPC 超时错误（integrity-hardening D3a：pi 半死自愈）。
 *
 * pi 事件循环卡死（native 模块 / 同步 IO 冻结）时一切 RPC 都以超时失败——这类失败
 * 意味着进程「半死」（活着但不响应），处置是强杀重建而非重试。调用方
 * （message-dispatcher 的 abort 强杀分支）经 instanceof 判别，因此必须是独立类型：
 * 字符串 message 匹配无编译期防护，改文案即断链。
 *
 * [arch] 类本体定义在 utils/errors.ts（中立层——services 层 instanceof 判别需要运行时
 * 值 import，定义在 infra 会让 services→infra 违反三层规则），此处 re-export 保持
 * 既有 import 路径（rpc-client.js）兼容。
 */
export { RpcTimeoutError } from '../../utils/errors.js'

export class RpcClient implements IPiEngine {
  private proc: ChildProcess | null = null
  private pending = new Map<string, {
    resolve: (msg: PiMessage) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  /**
   * 已超时的 RPC id（S6 防御迟到响应被误当 event 广播）。
   *
   * sendCommand 超时后 id 从 pending 删除但记入此 Set（5s TTL）。
   * handleMessage 收到带这些 id 的迟到响应时丢弃（不当 event 广播给 listeners），
   * 避免幽灵 UI 副作用（如迟到 get_state 响应触发 sidebar 状态错乱）。
   * TTL 到后自动从 Set 删除，避免无界增长。
   */
  private timedOutIds = new Set<string>()
  private listeners = new Set<PiEventListener>()
  private msgCounter = 0
  private _exited = false
  private _killing = false
  /**
   * 进程退出回调集合（多播）。
   *
   * 曾是单槽字段（exitCallback = cb）：第二个注册者会静默覆盖第一个——若覆盖
   * ProcessManager 的清理回调即复刻「僵尸 session」根因（handoff-service.ts:63-70
   * 曾因此被迫轮询 exited 绕开）。改 Set + onExit 返回 unsubscribe，与 onEvent 对称。
   */
  private exitCallbacks = new Set<(code: number | null, stderr: string) => void>()
  /** 收集 pi 进程的 stderr 输出，用于在启动失败时提供具体错误信息 */
  private stderrChunks: string[] = []
  /** pi stdout JSONL 原始流落盘（架构约定 #4，诊断 pi 卡死的决定性证据） */
  private piSessionLog: PiSessionLog | null = null

  constructor(private options: RpcClientOptions = {}) {}

  async start(): Promise<void> {
    const modelRef = getDefaultModel()
    // P1（pi-assumption final gate）：附着恢复路径不拼 --model——pi CLI model 恒优先于
    // session entry 恢复，全局默认兜底一旦拼进 args，用户切换过的模型就被静默压回默认。
    const model = this.options.inheritSessionModel
      ? undefined
      : this.options.model ?? (modelRef ? `${modelRef.provider}/${modelRef.modelId}` : '')

    // B3 出站契约收口（docs/design/env-propagation-boundary.md §5-U3）：白名单过滤父
    // env 为基座 → extras 在基座之上整体覆盖 → deny 清单兜底剥除 XYZ_AGENT_PACKAGED /
    // XYZ_RUNTIME_TOKEN。旧私有第二份 buildSafeEnv 已被共享构建器取代（重复实现漂移消灭）。
    const outboundExtras: Record<string, string> = {}
    for (const [key, value] of Object.entries(this.options.env ?? {})) {
      // 旧私有实现对 undefined extras 键跳过不写（「undefined=删除」语义属 main 侧
      // safe-env）。保留跳过行为：防上游误传 undefined 时吞掉白名单基座继承键
      // （R2 远距离爆炸防线，如 PATH 被删 → hooks 里 command not found）。
      if (value !== undefined) outboundExtras[key] = value
    }
    const env = buildOutboundChildEnv({ parentEnv: process.env, extras: outboundExtras })

    // xyz-pi agent 目录：~/.xyz-agent/pi/agent/
    // 开发模式和打包模式统一使用此目录，不使用系统 pi 的 ~/.pi/agent/
    env.PI_CODING_AGENT_DIR = getPiAgentDir()

    // --approve: 强制信任 cwd（trustOverride=true），让 pi 加载项目级 .pi/skills 和 .pi/extensions。
    // 短期方案：xyz-agent 的 RPC 模式无交互 UI，pi 原生信任流程在 hasUI=false 时默认拒绝，
    // 导致 <cwd>/.pi/ 下的 skill/extension 被跳过。--approve 绕过信任确认，代价是所有
    // 项目自动信任（失去 pi 信任机制对恶意 .pi/extensions 的安全防护）。
    //
    // 三个 flag 的交互（见下方 args 拼接，架构约定 #11：extension 通过 --extension CLI 参数
    // 在 pi 启动时注入路径，pi 原生 loader 加载）：
    // - --no-extensions：抑制 pi 自动发现/加载的全局扩展（内置/全局扩展目录），不影响显式注入的扩展。
    // - --extension <path>：显式注入 xyz-agent 管理的扩展路径（本文件下方 extensionPaths 循环），
    //   走独立参数，不受 --no-extensions 影响；扩展数据隔离在 ~/.xyz-agent/ 数据目录。
    // - --approve：绕过项目级 .pi/skills 和 .pi/extensions 的信任确认。
    // 因此 xyz-agent 的 extension 走 --extension 显式注入 + ~/.xyz-agent/ 数据目录隔离，
    // 不依赖 --approve 加载项目级 .pi/extensions；--approve 实际主要为信任项目级 .pi/skills
    // （skills 加载见 pi 的 skills.ts）。
    // TODO(follow-up): 实现 Project Trust UI，让用户逐项目确认信任，移除全局 --approve。
    // 当前为产品决策（local-first 工具，所有项目可信），非临时 hack。
    const args = ['--mode', 'rpc', '--no-extensions', '--approve']
    if (model) args.push('--model', model)
    // --system-prompt: 替换 pi 核心系统提示词（身份/工具列表/指引/pi 文档路径 4 段）。
    // 动态段（project_context/skills/日期/cwd）仍由 pi 照常拼接。空白/未传不拼。
    if (this.options.systemPrompt?.trim()) {
      args.push('--system-prompt', this.options.systemPrompt)
    }
    if (this.options.skillPaths?.length) {
      for (const skillPath of this.options.skillPaths) {
        args.push('--skill', skillPath)
      }
    }
    if (this.options.extensionPaths?.length) {
      for (const extPath of this.options.extensionPaths) {
        args.push('--extension', extPath)
      }
    }
    // Preset 启动参数（设计文档 §2.5 / 附录 A）：6 个字段映射到 pi CLI args。
    // tools/excludeTools 用逗号连接（pi 单参数多值语义）；开关类 push 单 flag；
    // thinkingLevel 走 --thinking（pi 参数名，非 --thinking-level）。
    // W-RT-6：tools/excludeTools/noTools 三者互斥，按优先级 noTools > tools > excludeTools 取一个，
    // 同时出现多个时 warn（不抛错，避免运行时炸），保持单写者语义清晰。
    const hasTools = !!this.options.tools?.length
    const hasExcludeTools = !!this.options.excludeTools?.length
    const hasNoTools = !!this.options.noTools
    if (
      (hasNoTools && hasTools)
      || (hasNoTools && hasExcludeTools)
      || (hasTools && hasExcludeTools)
    ) {
      console.warn('[rpc] conflicting tool options detected, using priority: noTools > tools > excludeTools')
    }
    if (hasNoTools) {
      args.push('--no-tools')
    } else if (hasTools) {
      args.push('--tools', this.options.tools!.join(','))
    } else if (hasExcludeTools) {
      args.push('--exclude-tools', this.options.excludeTools!.join(','))
    }
    if (this.options.noSkills) {
      args.push('--no-skills')
    }
    if (this.options.noContextFiles) {
      args.push('--no-context-files')
    }
    if (this.options.thinkingLevel) {
      args.push('--thinking', this.options.thinkingLevel)
    }

    // 使用 pi 的 sessions 目录
    const sessionDir = getSessionsDir()
    args.push('--session-dir', sessionDir)

    const piCmd = this.options.piCommand ?? 'pi'

    // Bun 编译的 bundled pi 用 process.execPath 定位资源（package.json、themes 等），
    // 不依赖 process.cwd() 查找 package.json。因此 spawn cwd 可以安全地设为用户项目目录。
    // 这样 pi 的初始 session、system prompt、CLAUDE.md 查找、bash 工具都基于正确的 cwd。
    // Verified: xyz-pi 0.75.5-xyz-0.1 uses process.execPath for resource resolution.
    // Re-verified 2026-08-20 (W6 A-11 探针) on upstream 0.84.1，双形态均不依赖 cwd：
    // - bun binary（打包产物 apps/electron/resources/pi/pi-darwin-arm64）：getPackageDir() =
    //   dirname(process.execPath)（pi 0.84.1 dist config.js isBunBinary 分支）；cwd=/tmp spawn
    //   --version 输出 0.84.1 正常，资源布局 binary 同目录 theme/package.json 与该分支一致。
    // - node dist（dev 形态）：从 __dirname 向上找 package.json（config.js getPackageDir Node 分支），
    //   实测 cwd=HOME//tmp//usr 三种 cwd 下 getPackageDir/getThemesDir 返回完全一致。
    const spawnCwd = this.options.cwd ?? process.cwd()

    console.log('[rpc] spawning pi:', piCmd, args.join(' '), 'cwd:', spawnCwd)

    this.proc = spawn(piCmd, args, {
      cwd: spawnCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // pi stdout JSONL 原始流落盘（架构约定 #4）。pi 卡死时（prompt 后零事件），
    // 这个文件是判断「pi 没发事件」vs「runtime 没转发」的决定性证据。
    // logger 未初始化时（如单元测试）返回 no-op 写入器，无副作用。
    if (this.options.sessionId) {
      this.piSessionLog = createPiSessionLog(this.options.sessionId)
    }

    const proc = this.proc

    proc.on('error', (err) => {
      console.error('[rpc] spawn error:', err)
      this.rejectAll(new Error(`Failed to spawn pi: ${err.message}`))
    })

    proc.on('exit', (code) => {
      this._exited = true
      console.log(`[rpc] process exited with code ${code}`)
      this.piSessionLog?.end()
      this.piSessionLog = null
      // Only reject pending requests on unexpected exits.
      // For normal kill flow (_killing=true), rejectAll is called in kill()
      // via a separate safety net to avoid leaving callers hanging until CMD_TIMEOUT_MS.
      if (!this._killing) {
        this.rejectAll(new Error(`pi process exited with code ${code}${this.formatStderrSuffix()}`))
        for (const cb of this.exitCallbacks) {
          cb(code, this.getStderrTail())
        }
      }
    })

    // Parse stdout JSONL
    const rl = createInterface({ input: proc.stdout! })
    rl.on('line', (line) => {
      if (!line.trim()) return
      // tee 原始 JSONL 到 pi session 日志（架构约定 #4，卡死诊断证据）
      this.piSessionLog?.write(line)
      try {
        const msg: PiMessage = JSON.parse(line)
        this.handleMessage(msg)
      // eslint-disable-next-line taste/no-silent-catch -- malformed line from pi process, skip and continue
      } catch (e) {
        console.error('[rpc] stdout parse error:', line, e)
      }
    })

    // W2：监听 stdout stream 的 'error' 事件。
    // proc.on('error') 只覆盖 spawn 失败；stdout 是独立的 Readable stream，pi 崩溃 /
    // 管道断裂（EPIPE / ECONNRESET）时 stdout 会 emit 'error'，若无 listener 则升级为
    // uncaughtException → runtime 主进程崩溃。此处捕获后 rejectAll pending 并标记 _exited，
    // 把 stream error 纳入与进程退出相同的清理路径。
    //
    // 管道断裂但进程可能仍存活（孤儿泄漏）：SIGKILL 加速其死亡，让下方 proc.on('exit')
    // 作为死亡通知的唯一出口（避免「stream error 通知 + exit 通知」双触发）。
    // 刻意调 ChildProcess 原生 kill 而非 this.kill()：后者置 _killing=true，
    // exit 处理器会跳过 exitCallbacks —— 死亡通知整条丢失。
    const killProcAfterStreamError = (stream: 'stdout' | 'stderr'): void => {
      try {
        this.proc?.kill('SIGKILL')
      } catch (e) {
        // best-effort 降级：kill 抛错说明进程已死，exit 事件已/将至并走唯一出口，无需传播
        console.error(`[rpc] SIGKILL after ${stream} stream error failed (process may already be dead):`, e)
      }
    }

    proc.stdout?.on('error', (err: NodeJS.ErrnoException) => {
      console.error('[rpc] stdout stream error:', err)
      this._exited = true
      this.rejectAll(new Error(`pi stdout stream error: ${err.message}`))
      killProcAfterStreamError('stdout')
    })

    // 收集 stderr 用于错误诊断，同时转发到日志
    this.stderrChunks = []
    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString().trimEnd()
        console.error('[rpc:stderr]', text)
        // 只保留最后 N 行，避免内存泄漏
        this.stderrChunks.push(text)
        if (this.stderrChunks.length > STDERR_BUFFER_MAX_LINES) {
          this.stderrChunks.shift()
        }
      })
      // W2：同 stdout，stderr stream 的 'error' 独立于 proc.on('error')。
      // pi 崩溃时 stderr 管道可能先断，未捕获会变 uncaughtException。捕获后 rejectAll + 标记 _exited。
      proc.stderr.on('error', (err: NodeJS.ErrnoException) => {
        console.error('[rpc] stderr stream error:', err)
        this._exited = true
        this.rejectAll(new Error(`pi stderr stream error: ${err.message}`))
        killProcAfterStreamError('stderr')
      })
    }

    // Wait briefly to confirm process didn't exit immediately
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const onExit = (code: number | null) => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`pi process exited immediately with code ${code}${this.formatStderrSuffix()}`))
      }
      const onError = (err: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`pi spawn error: ${err.message}`))
      }
      const cleanup = () => {
        proc.removeListener('exit', onExit)
        proc.removeListener('error', onError)
      }
      proc.on('exit', onExit)
      proc.on('error', onError)
      setTimeout(() => {
        if (settled) return
        cleanup()
        if (!this._exited) resolve()
        else reject(new Error(`pi process exited during startup${this.formatStderrSuffix()}`))
      }, STARTUP_DELAY_MS)
    })
  }

  private handleMessage(msg: PiMessage): void {
    // If id matches a pending request, resolve it; otherwise emit as event.
    // resolve 只认 RPC response：pi 的 RpcResponse union 所有变体 type === 'response'
    // （pi-mono coding-agent/src/modes/rpc/rpc-types.ts:114-223），事件各有独立 type 字符串。
    // pi 0.84.1 新增 bash_execution_update 流事件复用发起 RPC 的 id
    // （node_modules @earendil-works/pi-coding-agent dist/core/agent-session.d.ts:103-106
    // {type:"bash_execution_update", id?, delta}；docs/rpc.md:26「bash_execution_update
    // events also include the id of their originating bash command」）——仅凭 id 命中
    // pending 就 resolve 会把首条 delta 误当 response（真 response 到达时 pending 已删，
    // 真实 output 丢失，bash() shape guard 落 [protocol error: malformed] fallback）。
    // 非 response 的带 id 消息走下方 listener 路径（event-adapter NULL_EVENTS 已登记）。
    if (msg.type === 'response' && msg.id && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)!
      clearTimeout(entry.timer)
      this.pending.delete(msg.id)
      entry.resolve(msg)
    } else if (msg.id && this.timedOutIds.has(msg.id)) {
      // S6: 该 id 的请求已超时 reject，pi 迟到的响应丢弃（不当 event 广播给 listeners，
      // 避免幽灵 UI 副作用）。timedOutIds 由 sendCommand 超时回调写入，5s TTL 后自动清理。
      return
    } else {
      for (const listener of this.listeners) {
        listener(msg)
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
    // 进程退出 / stream error 时 pending 已全清，对应的 timedOutIds 也应一并清空——
    // 否则残留 id 会在 Set 里存活到 TTL（5s）才被自动删除（虽进程即将退出，仍补齐一致性）。
    this.timedOutIds.clear()
  }

  private nextId(): string {
    return `rpc_${++this.msgCounter}_${Date.now()}`
  }

  /**
   * Send a raw command and wait for a response with matching id.
   * If the response indicates failure (success: false), the promise is rejected.
   */
  /**
   * 向 pi stdin 写入一行原始 JSON，不注册 pending、不等 RPC reply。
   *
   * 用于 pi 不回复 `{type:'response'}` 的命令（目前仅 `extension_ui_response`——
   * pi rpc-mode.ts 处理后直接 return，不回 RPC 确认）。用 sendCommand 会导致 pending
   * 永不 resolve → 60s CMD_TIMEOUT_MS 后才超时（timer 泄漏 + 无用等待）。
   *
   * 注意：调用方自行保证 JSON 格式正确 + 换行符结尾。
   */
  sendRaw(data: string): void {
    if (!this.proc || this._exited) {
      console.error('[rpc] sendRaw failed: pi process is not running')
      return
    }
    const line = data.endsWith('\n') ? data : data + '\n'
    try {
      this.proc.stdin!.write(line)
    // eslint-disable-next-line taste/no-silent-catch -- sendRaw 是 void fire-and-forget（pi 不回复 extension_ui_response），无调用方可传播错误；console.error 经 logger.patchConsole tee 到 runtime 日志文件（架构约定 #4）
    } catch (e) {
      console.error('[rpc] sendRaw write failed:', e)
    }
  }

  sendCommand(type: string, params: Record<string, unknown> = {}, timeout = CMD_TIMEOUT_MS): Promise<PiMessage> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this._exited) {
        return reject(new Error('pi process is not running'))
      }

      const id = this.nextId()
      const msg = JSON.stringify({ id, type, ...params }) + '\n'

      const timer = setTimeout(() => {
        this.pending.delete(id)
        // S6: 标记此 id 已超时，handleMessage 收到带此 id 的迟到响应时丢弃而非广播为 event。
        // 5s TTL 后自动从 Set 删除，避免无界增长；.unref() 避免阻止进程退出。
        this.timedOutIds.add(id)
        setTimeout(() => this.timedOutIds.delete(id), TIMED_OUT_ID_TTL_MS).unref()
        // D3a：超时以 RpcTimeoutError 类型 reject（字段化 commandType/timeoutMs），调用方
        // instanceof 判别后走强杀自愈路径，不再靠 message 字符串匹配。
        reject(new RpcTimeoutError(type, timeout))
      }, timeout)

      this.pending.set(id, {
        resolve: (msg) => {
          // Check if the response indicates failure (PiMessage.success / .error 已声明类型)
          if (msg.success === false) {
            reject(new Error(msg.error ?? `RPC command "${type}" failed`))
          } else {
            // 归一：pi 响应兼容 data/payload 两位置（historically readRpcData 在调用方做
            // data ?? payload），现下沉到 sendCommand，统一后调用方直接读 msg.data。
            if (msg.data === undefined && msg.payload !== undefined) {
              msg.data = msg.payload
            }
            resolve(msg)
          }
        },
        reject,
        timer,
      })

      try {
        console.log('[rpc] send: type=' + type)
        const ok = this.proc.stdin!.write(msg)
        if (!ok) {
          this.proc.stdin!.once('drain', () => {})
        }
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`Failed to write to pi stdin: ${e}`))
      }
    })
  }

  /**
   * Register a callback for when the pi process exits unexpectedly. stderr 为 pi 进程尾部输出。
   * 多播（可多订阅者，后注册者不再覆盖先注册者），返回 unsubscribe（与 onEvent 对称）。
   * 每个进程 exit 恰好通知一次：proc.on('exit') 是唯一出口（stream error 只 kill 不通知）；
   * _killing=true 的主动 kill 流程不通知，语义不变。
   */
  onExit(callback: (code: number | null, stderr: string) => void): () => void {
    this.exitCallbacks.add(callback)
    return () => { this.exitCallbacks.delete(callback) }
  }

  /**
   * Register an event listener for non-response messages from pi.
   * Returns an unsubscribe function.
   */
  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 将收集到的 pi stderr 格式化为可读后缀，附到错误消息末尾 */
  private formatStderrSuffix(): string {
    if (this.stderrChunks.length === 0) return ''
    const last = this.stderrChunks.slice(-STDERR_TAIL_LINES)
    return `\n\npi stderr (last ${last.length} lines):\n${last.join('\n')}`
  }

  /** 返回 pi stderr 尾部内容（不含前缀），供 exitCallback 透传到上层展示给用户 */
  private getStderrTail(): string {
    if (this.stderrChunks.length === 0) return ''
    return this.stderrChunks.slice(-STDERR_TAIL_LINES).join('\n')
  }

  get exited(): boolean {
    return this._exited
  }

  // ── High-level API ────────────────────────────────────────────────

  /**
   * Send a user message to pi. The returned promise resolves when
   * pi acknowledges receipt (not when generation completes).
   * Actual content arrives via onEvent() listeners as text_delta etc.
   *
   * Note: pi RPC protocol uses "message" field, not "content".
   *
   * images 是 shared 层图片附件形状（{data;base64;mimeType}，无 type 字段）。
   * 此方法是 shared→pi ImageContent 的唯一组装点（AGENTS.md 规则 #5）：
   * map 时补 `type:'image' as const`，pi 私有 type 字段不出 infra 层。
   * images 为 undefined 或空数组时归一化为不传 images 键（避免 pi 收到空数组），
   * 走与改动前完全一致的路径，零回归。
   */
  prompt(content: string, images?: Array<{ data: string; mimeType: string }>, streamingBehavior?: 'steer' | 'followUp'): Promise<PiMessage> {
    const piImages = images && images.length > 0
      ? images.map(i => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))
      : undefined
    const params: Record<string, unknown> = { message: content }
    if (piImages) params.images = piImages
    if (streamingBehavior) params.streamingBehavior = streamingBehavior
    return this.sendCommand('prompt', params)
  }

  abort(): Promise<PiMessage> {
    return this.sendCommand('abort')
  }

  steer(content: string): Promise<PiMessage> {
    return this.sendCommand('steer', { message: content })
  }

  followUp(content: string): Promise<PiMessage> {
    return this.sendCommand('follow_up', { message: content })
  }

  setModel(provider: ProviderId, modelId: string): Promise<PiMessage> {
    return this.sendCommand('set_model', { provider, modelId })
  }

  setThinkingLevel(level: string): Promise<PiMessage> {
    return this.sendCommand('set_thinking_level', { level })
  }

  /**
   * 设置 pi session 名（set_session_name）。
   *
   * W1（数据源治理）：活跃 session 的 label 持久化唯一写入口——pi 内部经
   * sessionManager.appendSessionInfo 落盘 + 广播 session_info_changed，取代 xyz
   * 直写 session JSONL（消除与 pi 进程内 rename-session 扩展的 last-write-wins 竞争）。
   * success:false / 超时由 sendCommand 既有约定 reject（调用方决定失败语义）。
   */
  setSessionName(name: string): Promise<PiMessage> {
    // L6：set_session_name 是毫秒级 RPC（pi 内存缓冲 append），用 FAST_TIMEOUT_MS 快速失败
    return this.sendCommand('set_session_name', { name }, FAST_TIMEOUT_MS)
  }

  /** [DEAD] pi get_messages 死路径——生产零调用（session-service.getHistory 走 client.getEntries entry 树重建）。
   *  保留供未来扁平 message 列表场景；删除前确认无 mock/测试依赖。 */
  getHistory(): Promise<PiMessage> {
    return this.sendCommand('get_messages')
  }

  /**
   * 拉取 pi session 的完整 entry 树（get_entries RPC）。
   *
   * 与 getHistory（get_messages，只返回扁平 message 列表）不同：get_entries 返回全部 entry 类型
   * （message/custom/label/compaction/branch_summary/...），含 parentId 树结构。
   * entry-tree-builder 用 message entry + "xyz.client-msg-id" custom entry 重建结构化 Message[]。
   *
   * since 可选：传 entry id 时返回该 entry 之后的 entry（增量拉取，pi 找不到 since id 会报错）。
   * 返回的 PiMessage.data 已由 sendCommand 归一（data ?? payload），调用方按 GetEntriesResponse 断言。
   */
  getEntries(since?: string): Promise<PiMessage> {
    return this.sendCommand('get_entries', since !== undefined ? { since } : {})
  }

  async compact(customInstructions?: string): Promise<PiCompactionResult> {
    const msg = await this.sendCommand('compact', customInstructions ? { customInstructions } : {}, COMPACT_TIMEOUT_MS)
    return msg.data as unknown as PiCompactionResult
  }

  /**
   * 直接执行 bash 命令（pi bash RPC）。
   *
   * excludeFromContext 透传规则：undefined 时不传该键（走 pi 默认），显式 true/false 时透传。
   * bash 可能长跑，复用 COMPACT_TIMEOUT_MS（300s）避免误超时。
   * 返回值归一为 PiBashResult（sendCommand 已归一 data ?? payload，此处按结构断言）。
   */
  async bash(command: string, excludeFromContext?: boolean): Promise<PiBashResult> {
    const args = excludeFromContext !== undefined ? { command, excludeFromContext } : { command }
    const msg = await this.sendCommand('bash', args, COMPACT_TIMEOUT_MS)
    // [W6] shape guard：pi 返回 malformed 数据时 fallback，避免下游因 undefined 字段崩溃。
    // [S1] fallback 不用 exitCode:1（会被前端误读为「命令失败」，实为 pi 协议异常），
    // 改用 exitCode:undefined（PiBashResult.exitCode 类型 number|undefined，dispatcher 广播时
    // `?? null` 归一为 null，前端 BashOutputBlock 渲染为「无 exit code」而非「失败」），
    // 并在 output 写诊断提示让用户可见协议异常（而非空 output 静默吞错）。
    const data = msg.data as Record<string, unknown> | undefined
    if (typeof data !== 'object' || data === null || !('output' in data)) {
      console.warn('[rpc] bash: malformed PiBashResult from pi, using fallback. data=', msg.data)
      return { output: '[protocol error: malformed bash response from pi]', exitCode: undefined, cancelled: false, truncated: false }
    }
    return data as unknown as PiBashResult
  }

  /** 取消进行中的 bash 执行（pi abort_bash 命令）。 */
  abortBash(): Promise<PiMessage> {
    return this.sendCommand('abort_bash')
  }

  /**
   * Clear is not directly supported by pi RPC. Use new_session instead.
   * Kept for API compatibility — creates a new session.
   */
  clear(): Promise<PiMessage> {
    return this.sendCommand('new_session')
  }

  async getCommands(): Promise<PiCommandInfo[]> {
    // L6：getCommands 是毫秒级操作，用 FAST_TIMEOUT_MS（10s）替代默认 60s，失败更快报错
    const msg = await this.sendCommand('get_commands', {}, FAST_TIMEOUT_MS)
    // 透传 pi RpcSlashCommand 的完整结构（含 sourceInfo），消费方按需取用
    return (msg.data?.commands as PiCommandInfo[]) ?? []
  }

  async getSessionStats(): Promise<PiSessionStats> {
    const msg = await this.sendCommand('get_session_stats')
    return (msg.data ?? {}) as PiSessionStats
  }

  /** 切换 pi 进程到指定 session 文件（restore / fork 用）。 */
  switchSession(sessionPath: string): Promise<void> {
    // L6：switchSession 加载大 session 文件可能耗时，用 SLOW_TIMEOUT_MS（120s）避免误超时
    return this.sendCommand('switch_session', { sessionPath }, SLOW_TIMEOUT_MS).then(() => undefined)
  }

  /** 查询 pi session 状态（get_state），返回归一后的 state 对象（sendCommand 已归一 data ?? payload）。 */
  async getState(): Promise<Record<string, unknown> | undefined> {
    // L6：getState 是毫秒级操作，用 FAST_TIMEOUT_MS（10s）替代默认 60s
    return (await this.sendCommand('get_state', {}, FAST_TIMEOUT_MS)).data
  }

  /**
   * 取 pi 合并模型清单快照（get_available_models RPC，U5 能力注册表在线对账数据源）。
   *
   * 返回 pi 进程内视角的可用模型全集（内置 catalog ∪ models.json 自定义 ∪
   * models-store 远端目录刷新合并），元素是 pi-ai Model 经本层翻译的内部类型
   * AvailableModelSnapshot（含 reasoning/thinkingLevelMap）——services/model-capability.ts
   * 的 runCapabilityReconcile 用它检测配置聚合与 pi 运行态的漂移（配置有而 pi 无 /
   * reasoning 不一致 / 大小写孪生）。毫秒级内存快照，FAST_TIMEOUT_MS 即可；
   * malformed 响应抛错由对账层降级捕获（避免误判为全量漂移）。
   */
  async getAvailableModels(): Promise<AvailableModelSnapshot[]> {
    const msg = await this.sendCommand('get_available_models', {}, FAST_TIMEOUT_MS)
    const models = msg.data?.models
    if (!Array.isArray(models)) {
      throw new Error('[rpc] getAvailableModels: malformed response from pi (data.models is not an array)')
    }
    return models as AvailableModelSnapshot[]
  }

  /**
   * 向 pi 发送 extension_ui_response（extension UI 请求 / bridge 请求的响应）。
   *
   * pi 对 extension_ui_response 不回 RPC reply（rpc-mode.ts 直接 resolve pending 后 return），
   * 故用 sendRaw 写入（不等 reply，不注册 pending，避免 60s timer 泄漏）。
   *
   * 两种 payload 格式（吸收 extension-message-handler 的 buildExtensionUiResponse 映射）：
   *
   * 1. extension UI 场景（带 method）——pi 鸭子类型字段检测（rpc-mode.ts:136-149）：
   *    - response === null → {id, cancelled:true}（取消 / 超时）
   *    - method === 'confirm' → {id, confirmed:boolean}
   *    - 其余（select/input/editor）→ {id, value:string}
   *
   * 2. bridge 场景（无 method）——pi bridge extension 的 pendingExtensionRequests 期望
   *    `{response: <payload>}` 包裹结构（见 transport/bridge-handler.ts:32）：
   *    - response 是对象 → {id, response}（原样发）
   *
   * 判定优先级：null（取消）> bridge（无 method 且对象）> confirm > value。
   */
  sendExtensionUiResponse(id: string, response: unknown, method?: string): void {
    let payload: Record<string, unknown>
    if (response === null) {
      // 取消 / 超时（无论 method）
      payload = { type: 'extension_ui_response', id, cancelled: true }
    } else if (method === undefined && typeof response === 'object') {
      // bridge 场景：response 是完整对象 + 无 method → {id, response}
      payload = { type: 'extension_ui_response', id, response }
    } else if (method === 'confirm') {
      payload = { type: 'extension_ui_response', id, confirmed: response as boolean }
    } else {
      // select / input / editor → value
      payload = { type: 'extension_ui_response', id, value: String(response) }
    }
    this.sendRaw(JSON.stringify(payload))
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async kill(): Promise<void> {
    if (!this.proc || this._exited) return

    this._killing = true

    return new Promise<void>((resolve) => {
      const proc = this.proc!
      let settled = false

      const done = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }

      const killTimer = setTimeout(() => {
        console.warn('[rpc] SIGKILL after timeout')
        proc.kill('SIGKILL')
        done()
      }, KILL_TIMEOUT_MS)

      proc.on('exit', () => {
        clearTimeout(killTimer)
        // Safety net: clean up any pending requests that weren't rejected
        // by the unexpected-exit handler (because _killing=true skips it).
        // Without this, callers await until their own CMD_TIMEOUT_MS (60s).
        this.rejectAll(new Error('pi process killed'))
        done()
      })

      // D3a（integrity-hardening）：SIGTERM 前先 SIGCONT——唤醒可能被 SIGSTOP 冻结的
      // 进程（事件循环卡死的一种形态），否则 SIGTERM 会被冻结状态吞掉、只能等 2s 后
      // SIGKILL，丢失优雅退出路径（扩展落盘等 exit handler）的执行机会。对未冻结进程
      // 无副作用（SIGCONT 对运行中进程仅确认继续执行）；对已退出进程 kill() 返回 false
      // 不抛错。
      proc.kill('SIGCONT')
      proc.kill('SIGTERM')
    })
  }
}
