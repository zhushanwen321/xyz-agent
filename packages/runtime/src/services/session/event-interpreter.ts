/**
 * EventInterpreter — 消费 PiTranslatedEvent[]，执行业务编排（R1 重构）。
 *
 * [定位] service 层。承接 EventAdapter（infra 纯翻译器）产出的中间事件，做副作用：
 *   1. plugin hook 触发（onBeforeToolCall 阻断/改写、onAfterToolResult 改写、onPiEvent 观测）
 *   2. file_changes diff（turn 内写操作实时 + agent_end 最终对账）—— 经 IFileChangeDiff port
 *      （W18 采集异步化：diffChain 串行链 + turnGen 代际 + turnFinalizing 压制，03 D3-3）
 *   3. context.update 回写 session 缓存（sessionService.applyContextUpdate）
 *   4. thinkingLevel 回写 session 缓存（sessionService.setThinkingLevelCache）
 *   5. status/bridge/extension-ui 路由到 server（注册超时 / 处理 bridge 请求）
 *
 * 持有的可变态（从 event-adapter 迁来）：
 *   - currentMessageId（message_start 设置，file_changes 挂载目标）
 *   - writeContents（本 turn write 工具写入的 content，untracked 行数回退用）
 *   - diffChain / turnGen / turnFinalizing（W18 帧序三件套）
 *
 * [ADR-0024 D5] git 作为唯一真值源：写操作后 diff 当前 git status，agent_end 推 ready 全集。
 * 非 git 仓库 / cwd 缺省 → 跳过 diff（不推 file_changes）。
 * [R-09] turn-start 不再采 baseline——diffSnapshots 输出只依赖 current（死参数已删）。
 *
 * 依赖经构造注入：send（WS 帧）、fileChangeDiff（port，git 纯函数经组合根注入）、
 * 各业务回调（executeHooks / contextUpdate / thinkingLevel / status/bridge/extension-ui 路由）。
 */
import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'
import type { FileChange } from '@xyz-agent/shared'

/**
 * [ADR-0047] ping 间隔：turn 进行中每 60s 发一次 get_state 进程健康探测。
 *
 * 阈值依据见 ADR-0047「阈值依据」。平衡 RPC 流量（轻量）与响应速度。
 *
 * export 供测试 import（SR6 SSOT：测试跟随源码常量，不漂移）。
 */
export const PING_INTERVAL_MS = 60_000
/** [ADR-0047] 连续失败阈值：3 次（180s）→ 判定 pi 进程真死 → onSilentAbort。export 供测试（SR6）。 */
export const PING_FAIL_THRESHOLD = 3
/** [AC-8] 连续 2 次失败（120s）→ 广播 message.stream_warn 一次（提示性，不中断）。export 供测试（SR6）。 */
export const PING_WARN_FAIL_COUNT = 2
import { SUBAGENT_TOOL_NAMES, WORKFLOW_TOOL_NAMES, parseBgNotifyDetails } from '@xyz-agent/shared'
import { normalizeSubagentStatus } from './subagent-status.js'
import type { SubagentRecord, SubagentStatus, BgNotifyRecord } from '@xyz-agent/shared'
import { toErrorMessage } from '../../utils/errors.js'
import type { IFileChangeDiff } from '../ports/file-change-diff.js'
import type { PiTranslatedEvent } from './types.js'

/** plugin hook 执行回调（组合根注入，封装 pluginService.executeHooks + sessionId 注入）。 */
export type ExecuteHookFn = (
  hookType: string,
  context: Record<string, unknown>,
) => Promise<{ blocked: boolean; transformedData?: unknown }>

/**
 * EventInterpreter 构造依赖（全部由组合根注入）。
 *
 * 设计权衡：callbacks 用单独函数而非注入整个 pluginService/sessionService/server——
 * 保持 interpreter 单一职责（只见它需要的窄接口），便于测试 mock。
 */
export interface EventInterpreterOptions {
  /** pi session 工作目录（git baseline diff 用）。缺省 → 跳过 file_changes。 */
  cwd?: string
  /** WS 帧发送。 */
  send: (msg: ServerMessage) => void
  /** file_changes diff 引擎（port，组合根注入 infra 实现，采集经 GitStateService 异步）。 */
  fileChangeDiff?: IFileChangeDiff
  /** plugin hook 执行（onBeforeToolCall/onAfterToolResult/onPiEvent）。组合根注入 pluginService.executeHooks。 */
  executeHooks?: ExecuteHookFn
  /** agent_end usage 回写 session 缓存（组合根注入 sessionService.applyContextUpdate）。 */
  onContextUpdate?: (sessionId: string, data: { inputTokens: number; totalTokens: number }) => void
  /**
   * pi turn_end 单 turn 用量到达后触发（组合根注入 sessionService.handleTurnUsageSideEffects）。
   *
   * 承载 tryPersistLabel 主路径——「首 turn 即持久化」时序保证：第一个 turn_end 时 pi 已完成
   * 该轮 flush（session 文件存在），此时 append session_info 行安全。不等 agent_end（后者要等
   * 所有工具调用轮次跑完，中途关 app 仍会丢 label）。
   */
  onTurnUsage?: (sessionId: string) => void
  /**
   * pi agent_end 整循环结束时触发（组合根注入 sessionService.handleTurnEndSideEffects）。
   *
   * 承载两个副作用：
   *   1. 复位 isGenerating=false（不迁移则正常生成完成后 session 永远 busy，下条消息被拒）
   *   2. tryPersistLabel 兜底（turn_end 时 pi flush 尚未完成、文件不存在，在此补写）
   */
  onTurnFinalize?: (sessionId: string, stopReason?: string) => void
  /** thinking_level_changed 回写 session 缓存（组合根注入 sessionService.setThinkingLevelCache）。 */
  onThinkingLevelChanged?: (sessionId: string, level: string | undefined) => void
  /** extension 交互式 UI 请求（注册前端超时 + 缓存 pending 请求）。组合根注入 server.registerExtensionTimeout。 */
  onExtensionUIRequest?: (requestId: string, sessionId: string, method: string, payload: Record<string, unknown>) => void
  /** bridge:* 前缀请求（直接路由不经前端超时）。组合根注入 server.handleBridgeRequest。 */
  onBridgeUIRequest?: (requestId: string, sessionId: string, method: string, data: Record<string, unknown>) => void
  /** extension setStatus（路由到 statusline builtin 插件，status-bar-registry 广播）。组合根注入 server.handleStatusSetUpdate。 */
  onStatusSetUpdate?: (payload: { sessionId: string; key: string; text: string; textRaw?: string }) => void
  /**
   * pi 卡死 abort 回调（ADR-0047 ping 探测机制）。
   *
   * turn 进行中每 60s ping get_state，连续 3 次（180s）失败时判定 pi 进程真死，
   * 触发本回调由组合根调 sessionService.abort（复用现有 abort 兜底广播路径）。
   * payload 携带 sessionId，供上层定位要 abort 的 session。
   */
  onSilentAbort?: (payload: { sessionId: string }) => void
  /**
   * compaction 生命周期态切换（M4 事件驱动）—— interpreter 从 compaction_start/end 唯一置位/复位
   * runtime active.isCompacting（sendPrompt/sendBash 预检互斥依据）。
   *
   * 组合根注入：(sid, v) => 写 sessionService.getSession(sid).isCompacting（与原 dispatcher 手动
   * 路径置位对称）。事件驱动后 dispatcher 不再置位，复位责任转移到 interpreter（三路对称复位）。
   */
  onCompactingStateChange?: (sessionId: string, isCompacting: boolean) => void
  /**
   * [ADR-0047] ping get_state 进程健康探测回调（组合根注入）。
   *
   * 延迟解析 client：interpreter 在 session 创建时构造，那时 client 可能尚未 spawn。
   * 回调内部按当前 sessionId 取 pm.getClient(sessionId)?.getState()，client 未就绪时
   * 返回 undefined（计为一次失败但不抛错——AC-9：client 偶发未就绪不应让 interpret 批次崩溃）。
   *
   * 返回值语义：
   *   - resolve(非 undefined) → pi 健康（事件循环活，能响应 get_state）→ 清零失败计数
   *   - resolve(undefined)   → client 未就绪或拿不到 state → 计失败但不抛错（AC-9）
   *   - reject               → pi 真卡死（get_state 超时）→ 计失败
   *
   * 设计权衡：ping 能穿透所有「pi 合理等待」场景（ask_user / 网络 / 文件锁）——
   * pi 阻塞在 await 时事件循环仍活，get_state 必响应。只有进程真死才连续 3 次失败。
   * 详见 ADR-0047「ping 可行性验证」。
   */
  pingPi?: () => Promise<Record<string, unknown> | undefined> | undefined
}

/** 可能改文件的工具（baseline diff 触发判定，与原 event-adapter 一致）。 */
const FILE_MUTATING_TOOLS = new Set(['write', 'edit', 'bash'])

export class EventInterpreter {
  /** 当前 assistant message 的 id（message_start 设置，file_changes 挂载目标，跨事件保持） */
  private currentMessageId: string | undefined
  /** 本 turn write 工具写入的 content（untracked 行数回退用，message_start 重置换新）。 */
  private writeContents: Map<string, string> = new Map()
  /**
   * [W18 帧序三件套，03 D3-3] per-session 串行 diff 链：file_changes 的 diff 计算按触发序
   * 串行执行，turn-end 的 ready 排链尾 → ready 恒为该回合最后一帧（by-construction）。
   * 链上每段 catch 兜底，diffChain 永不 reject（单帧失败不断链）。
   */
  private diffChain: Promise<void> = Promise.resolve()
  /** 回合代际守卫：turn-start 自增；链上执行时 gen 不匹配 → 丢弃 accumulating（ready 绕过恒推，见 sendDiffFileChanges） */
  private turnGen = 0
  /** turn-end 压制标记：true 后到达的 accumulating 直接 no-op（同回合迟到 tool-call-end 不产生新帧） */
  private turnFinalizing = false
  /**
   * subagent 内存态：subagentId → SubagentRecord。
   * tool-call-end 建 running 记录，bg-notify 更新终态。每次变更广播 session.subagents。
   * per-session（interpreter 实例级），session 销毁时随实例释放。
   */
  private subagentRecords: Map<string, SubagentRecord> = new Map()
  /** subagent tool-call-start 的 startParam 缓存（toolCallId → startParam），end 时取出合并 */
  private pendingStartParams: Map<string, { agent: string; slug: string; task: string }> = new Map()
  /**
   * toolCall 产出顺序锚点缓存（toolCallId → contentIndex，pi toolcall_start 提供）。
   * tool-call-start（tool_execution_start）到达时取出附到 tool_call_start WS 帧，
   * 前端按 contentIndex 有序插入 contentBlocks（§11 检查点 3 两条路径顺序语义统一）。
   */
  private toolCallContentIndex: Map<string, number> = new Map()

  // ── [ADR-0047] ping 探测状态 ──
  /** ping 定时器句柄（null = 未在探测） */
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /** 当前连续失败计数（成功即清零） */
  private pingFailCount = 0
  /** 本 turn 是否已广播过 message.stream_warn（避免重复） */
  private pingWarned = false

  constructor(
    private readonly sessionId: string,
    private readonly opts: EventInterpreterOptions,
  ) {}

  /**
   * 消费一批翻译事件，逐个编排。
   *
   * 同步执行（不 await 单个 handle）：message/status/turn-* 等纯转发/回写事件同步送出，
   * 使 WS 帧在事件循环同一微任务内可见（前端/测试无需等 flush）。
   * 仅 tool-call-start/end 的 hook 改写是异步的 —— 由各自 handler 内部 await hook 后再 send，
   * 不阻塞本循环（同一 pi-event 不会同时产出 tool-call 与其他需保序的事件）。
   */
  interpret(events: PiTranslatedEvent[]): void {
    for (const ev of events) {
      // W1：per-event try-catch —— 对每个事件的编排（hook/diff/WS 转发）单独隔离。
      // 若第 N 个事件触发 handler 抛错（如 send 回调抛、某 details 形状异常），
      // 裸 for 循环会被中断，后续事件（含关键的 turn-end / agent_end）被吞掉，导致：
      //   - isGenerating 永不复位（onTurnFinalize 未触发）
      //   - message.complete 不送达前端（streaming 永远不停）
      // 故单事件失败仅记日志不中断批次（复用 event-adapter.logInterpretFailure 的隔离思路）。
      try {
        // 微项 4（wave:perf-w09）：高频 delta 帧快速路径——kind 路由（handle 的大 switch）
        // 与 subagent-bg-notify / workflow-result 的 payload 检查全部跳过，纯转发。
        // text_delta / thinking_delta 占 streaming 期事件量绝对大头，等价性依据：
        // 两者的 payload 是 { sessionId, delta, contentIndex? }（event-adapter :99-106），
        // 永不带 customType，跳过的两个检查函数（handleSubagentBgNotify / handleWorkflowResult
        // 首行 customType 守卫）对它们恒 early-return，行为与走 handle 完全一致。
        // 运行时护栏（W09 review 补）：快速路径条件额外要求 payload 无 customType——
        // 未来若新增带 customType 的 delta 产出点，缺此护栏会静默绕过两个检查函数，
        // 此处强制其回落完整 handle 路径。
        // 仍在 W1 try 内：send 抛错不中断批次。
        if (ev.kind === 'message') {
          const t = ev.message.type
          if ((t === 'message.text_delta' || t === 'message.thinking_delta')
            && !('customType' in (ev.message.payload ?? {}))) {
            this.opts.send(ev.message)
            continue
          }
        }
        this.handle(ev)
      } catch (err: unknown) {
        // B2（PR#86 review）：终态事件（turn-end）自身 handler 抛错时，onTurnFinalize 未执行 →
        // isGenerating 永不复位（session 永久 busy，违反 AGENTS.md 规则 #3）。
        // 兜底强制执行。onTurnFinalize 幂等（finalizeSession 幂等，见 chat.ts），重复调用无副作用。
        if (ev.kind === 'turn-end') {
          try {
            // S4：传 ev.stopReason 而非 undefined——对齐正常路径（handleTurnEnd L352）。
            // handleTurnEndSideEffects 在 stopReason undefined 时 outcome 走 'done' 分支，
            // 对「handler 抛错」场景写 'done' 是错的；turn-end 事件本身携带 stopReason（types.ts L120）。
            this.opts.onTurnFinalize?.(this.sessionId, ev.stopReason)
          } catch (finalizeErr) {
            // best-effort: onTurnFinalize 本身就是 handle(ev) 抛错后的兜底，此处失败无更上层可传播，静默降级
            console.debug('[event-interpreter] onTurnFinalize fallback failed:', finalizeErr)
          }
        }
        console.error(
          `[event-interpreter] handle event error (isolated; batch continues) sid=${this.sessionId} kind=${ev.kind}:`,
          err,
        )
      }
    }
  }

  private handle(ev: PiTranslatedEvent): void {
    switch (ev.kind) {
      case 'noop':
        return
      case 'message':
        this.opts.send(ev.message)
        // subagent bg-notify：更新内存态终态 → 广播 session.subagents
        this.handleSubagentBgNotify(ev.message)
        // workflow-result（run 完成）：广播 session.workflows 增量信号
        this.handleWorkflowResult(ev.message)
        return
      case 'turn-start':
        // 记 messageId（file_changes 挂载目标）+ 推进回合代际（W18 帧序三件套）。
        // [R-09 简化] 原 turn-start 同步采 baseline 快照已删除——diffSnapshots 的 baseline
        // 参数是死参数（[HISTORICAL] dirty 漏报修复后输出只依赖 current），turn-start 采集
        // 是每 turn 一次的纯浪费（W18 前为 execSync 同步阻塞）。
        this.currentMessageId = ev.messageId
        this.turnGen += 1
        this.turnFinalizing = false
        // 替换新 Map（非原地 clear）：上一 turn 排在 diff 链上的 ready 计算闭包仍持有旧引用，
        // 原地清空会让 untracked 行数回退拿不到 content。
        this.writeContents = new Map()
        // [ADR-0047] turn 开始启动 ping 探测（每 60s get_state）。
        // ping 在 turn 进行中持续，turn-end / agent_end / onSilentAbort 停止（见各分支）。
        // turn 间不探测（AC-3）：startPingLoop 在 turn-start 调用，确保只在 turn 内跑。
        this.startPingLoop()
        return
      case 'tool-call-start':
        // hook 改写是异步的：handler 内部 await 后 send（不阻塞本循环）
        void this.handleToolCallStart(ev)
        return
      case 'tool-call-index':
        // 缓存 toolCall 产出顺序锚点（pi toolcall_start），tool-call-start 到达时附到 WS 帧
        this.toolCallContentIndex.set(ev.toolCallId, ev.contentIndex)
        return
      case 'tool-call-end':
        void this.handleToolCallEnd(ev)
        return
      case 'turn-end':
        this.handleTurnEnd(ev)
        return
      case 'turn-usage':
        // pi turn_end 的单 turn 用量：回写 context.update（用量在前），再触发 onTurnUsage
        // （tryPersistLabel 主路径——首 turn 即持久化，文件已由 pi flush 创建）。
        // 不转发 message.complete（避免每 turn 触发 setStreaming 闪烁；
        // message.complete 仍由 turn-end/agent_end 独占）。
        this.opts.onContextUpdate?.(ev.sessionId, { inputTokens: ev.inputTokens, totalTokens: ev.totalTokens })
        this.opts.onTurnUsage?.(ev.sessionId)
        return
      case 'status-set':
        this.opts.onStatusSetUpdate?.({ sessionId: this.sessionId, key: ev.key, text: ev.text, textRaw: ev.textRaw })
        return
      case 'status-broadcast':
        this.opts.send(ev.message)
        return
      case 'bridge-ui':
        this.opts.onBridgeUIRequest?.(ev.requestId, ev.sessionId, ev.method, ev.data)
        return
      case 'extension-ui':
        this.opts.onExtensionUIRequest?.(ev.requestId, ev.sessionId, ev.method, ev.payload)
        return
      case 'thinking-level':
        this.opts.onThinkingLevelChanged?.(this.sessionId, ev.level)
        return
      case 'hook':
        // agent_start 等纯观测事件（无 WS 帧产出）
        this.opts.executeHooks?.('onPiEvent', { event: ev.eventType, ...ev.data }).catch(() => {})
        return
      case 'subagent-stream':
        // 路径 A-1：subagent 逐字 streaming → subagent.stream_delta WS 帧
        this.opts.send({
          type: 'subagent.stream_delta' as ServerMessageType,
          payload: { sessionId: ev.sessionId, recordId: ev.recordId, lines: ev.lines },
        })
        return
      case 'compaction-start':
        this.handleCompactionStart(ev)
        return
      case 'compaction-end':
        this.handleCompactionEnd(ev)
        return
    }
  }

  /** tool-call-start：跑 onBeforeToolCall hook（可阻断/改写 input）后产出 tool_call_start WS 帧 + onPiEvent hook。 */
  private async handleToolCallStart(ev: PiTranslatedEvent & { kind: 'tool-call-start' }): Promise<void> {
    const { toolCallId, toolName } = ev
    let input = ev.input

    let blocked = false
    if (this.opts.executeHooks) {
      try {
        const hookResult = await this.opts.executeHooks('onBeforeToolCall', { toolName, input })
        if (hookResult.blocked === true) {
          blocked = true
        } else if (hookResult.transformedData !== undefined) {
          input = hookResult.transformedData
        }
      } catch (e) {
        // 插件 hook 失败不影响主流程（best-effort 数据改写），降级到 debug 日志
        console.debug(`[event-interpreter] hook tool_execution_start error: ${toErrorMessage(e)}`)
      }
    }
    if (blocked) {
      // 阻断：不产出 tool_call_start，但仍触发 onPiEvent hook（带 blocked 标记，供观测插件）。
      // 移到 try-catch 外：与 tool_execution_end 的 fire-and-forget 模式一致——
      // onBeforeToolCall hook 失败（catch 分支）时仍触发 onPiEvent（不因 hook 失败丢观测事件）。
      // contentIndex 锚点不再被消费，同步清理（防 Map 残留）。
      this.toolCallContentIndex.delete(toolCallId)
      this.opts.executeHooks?.('onPiEvent', { event: 'tool_execution_start', toolCallId, toolName, input, blocked: true }).catch(() => {})
      return
    }

    // 观测 hook（tool_execution_start）
    this.opts.executeHooks?.('onPiEvent', { event: 'tool_execution_start', toolCallId, toolName, input }).catch(() => {})

    this.opts.send({
      type: 'message.tool_call_start',
      payload: {
        sessionId: this.sessionId,
        toolCallId,
        toolName,
        input,
        // §11 检查点 3：toolCall 产出顺序锚点（pi toolcall_start 提供，模型输出 tool_use 时）。
        // tool_call_start 帧由 tool_execution_start（工具执行时）驱动，若无此锚点，同 turn 内
        // text 在 tool 之后时 contentBlocks 顺序会错位（text_delta 先到）。缺失（旧 pi/异常）时不带。
        ...(this.toolCallContentIndex.get(toolCallId) !== undefined ? { contentIndex: this.toolCallContentIndex.get(toolCallId) } : {}),
      },
    })
    // 锚点已消费，清除缓存（防 Map 无限增长；同 id 重复 start 无意义）
    this.toolCallContentIndex.delete(toolCallId)

    // subagent tool-call-start：缓存 startParam（agent/slug/task），end 时取出合并 details 建记录
    if (SUBAGENT_TOOL_NAMES.has(toolName)) {
      this.cacheSubagentStartParam(toolCallId, input)
    }
  }

  /** tool-call-end：跑 onAfterToolResult hook（改写 output）+ 触发 file_changes diff + 产出 tool_call_end WS 帧 + onPiEvent hook。 */
  private async handleToolCallEnd(ev: PiTranslatedEvent & { kind: 'tool-call-end' }): Promise<void> {
    const { toolCallId, toolName, isError } = ev
    let output = ev.output
    const { details, images } = ev

    if (this.opts.executeHooks) {
      try {
        const hookResult = await this.opts.executeHooks('onAfterToolResult', { toolCallId, output })
        if (hookResult.transformedData !== undefined) output = hookResult.transformedData as string
      } catch (e) {
        // 插件 hook 失败不影响主流程（best-effort 数据改写），降级到 debug 日志
        console.debug(`[event-interpreter] hook tool_execution_end error: ${toErrorMessage(e)}`)
      }
    }

    // 观测 hook（tool_execution_end）
    this.opts.executeHooks?.('onPiEvent', { event: 'tool_execution_end', toolCallId, output, details, images }).catch(() => {})

    // ADR-0024 D5：失败的调用不触发 diff（避免噪声）；实时 diff
    if (!isError) {
      // [已知限制] ev.writeContent 恒为 undefined（pi tool_execution_end 从不发 args，见
      // event-adapter handleToolExecutionEnd 注释），writeContents 累积逻辑保护的是当前无数据
      // 流经的路径——后续 pi 若透出 writeContent 则自动激活（untracked 行数回退）。
      if (FILE_MUTATING_TOOLS.has(toolName)) {
        // await 保持「file_changes(accumulating) 先于 tool_call_end」帧序（W18 前为同步实现
        // 天然满足；异步化后显式 await——本 handler 本就是 fire-and-forget 异步路径，
        // await 不阻塞 interpret 循环）。等待的是整个 diff 链尾 = 前序链段 + 自身（每段最坏
        // = status + numstat 两个采集超时之和，各 5000ms）；fire-and-forget 语义下不阻塞
        // 事件循环，仅延迟 tool_call_end 相对时序。
        await this.sendDiffFileChanges('accumulating')
      }
    }

    this.opts.send({
      type: 'message.tool_call_end',
      payload: {
        sessionId: this.sessionId,
        toolCallId,
        output,
        outputRaw: ev.outputRaw,
        details,
        images,
        // 与历史路径 convertPiHistory（tc.status='error'）保持一致：实时失败的 tool call
        // 必须带 status:'error'，否则前端 Block.vue 的 isFailed 判定恒为 false（恒显示成功）。
        status: isError ? 'error' : 'completed',
        error: isError ? output : undefined,
      },
    })

    // subagent tool-call-end：合并缓存 startParam + details 建记录 → 广播 session.subagents
    if (SUBAGENT_TOOL_NAMES.has(toolName)) {
      this.handleSubagentEnd(toolCallId, details)
    }
    // workflow tool-call-end：action=run 发起 → 广播 session.workflows running 信号
    if (WORKFLOW_TOOL_NAMES.has(toolName)) {
      this.handleWorkflowToolEnd(details)
    }
  }

  /** turn-end（agent_end）：转发 message.complete + context.update 回写 + onTurnFinalize（副作用）+ 观测 hook + file_changes ready diff + 清空态。 */
  private handleTurnEnd(ev: PiTranslatedEvent & { kind: 'turn-end' }): void {
    // 转发 message.complete WS 帧
    this.opts.send(ev.message)

    // context.update 回写（inputTokens > 0 时）
    if (ev.inputTokens) {
      this.opts.onContextUpdate?.(this.sessionId, { inputTokens: ev.inputTokens, totalTokens: ev.totalTokens ?? 0 })
    }

    // 副作用：复位 isGenerating=false + tryPersistLabel 兜底 + session_end 终态写入（W4）
    this.opts.onTurnFinalize?.(this.sessionId, ev.stopReason)

    // 观测 hook（agent_end）
    this.opts.executeHooks?.('onPiEvent', { event: 'agent_end', stopReason: ev.stopReason, usage: ev.usage }).catch(() => {})

    // ADR-0024 D5：agent_end 推 ready 全集（diff 最终结果）。
    // W18 帧序三件套：turn-end 置 turnFinalizing（其后迟到的 accumulating no-op）；
    // ready 排 diff 链尾（fire-and-forget，禁止 await——await 会阻塞 turn-end 处理链），
    // 天然晚于所有在途 accumulating → ready 恒为链尾；message.complete 已在上方同步先发。
    this.turnFinalizing = true
    void this.sendDiffFileChanges('ready')
    // 替换新 Map（非原地 clear）：ready 排链后本 handler 立即返回，链上计算闭包持有旧引用
    // 做 untracked 行数回退，原地清空会拿不到 content。
    this.writeContents = new Map()

    // [ADR-0047] turn 结束停止 ping 探测（AC-3：turn 间不探测）。
    this.stopPingLoop()
  }

  /**
   * 推送 diff 结果的 file_changes 帧（W18 异步化 + 帧序三件套，03 D3-3）。
   *
   * 机制：采集当前 git status（异步，经 GitStateService 单飞）→ diff → 行数填充 → 推帧。
   * isFullSet=true（每次全量结果，前端全集替换）。非 git 仓库 / cwd 缺省 → 跳过。
   *
   * 帧序不变量（by-construction）：
   * 1. 单飞串行链——diff 计算入 per-session promise 链按触发序串行，turn-end 的 ready
   *    排链尾 → 恒晚于所有在途 accumulating；
   * 2. 回合代际守卫（仅 accumulating）——捕获排链时的 turnGen，链上执行时（含 await 窗口后
   *    send 前）不匹配即丢弃，上回合迟到 accumulating 不落新回合。ready 绕过守卫恒推
   *    （03 §3.1「ready 恒推」；W18 review）：pi followUp 续跑（triggerTurn）会立即开新 turn
   *    （turnGen++），若 ready 也按代际丢弃，本回合变更集卡永久停在 accumulating——前端无
   *    恢复路径（markChangeSetsSuperseded 仅 git.commit 触发、hydrate 不写 changeSetStatus）。
   *    迟到的 ready 挂排链时捕获的旧 messageId，前端按 messageId 分区 + 单向守卫幂等；
   * 3. turnFinalizing 压制——turn-end 后到达的 accumulating 直接 no-op。
   *
   * 返回链尾 promise：handleToolCallEnd await 它以保持「accumulating 先于 tool_call_end」；
   * handleTurnEnd 不 await（禁止阻塞 turn-end 处理链）。
   */
  private sendDiffFileChanges(changeSetStatus: 'accumulating' | 'ready'): Promise<void> {
    if (this.turnFinalizing && changeSetStatus === 'accumulating') {
      console.debug(`[event-interpreter] file_changes accumulating suppressed by turnFinalizing sid=${this.sessionId}`)
      return Promise.resolve()
    }
    const messageId = this.currentMessageId
    if (!messageId) return Promise.resolve()
    const { cwd, fileChangeDiff } = this.opts
    if (!cwd || !fileChangeDiff) return Promise.resolve()
    const gen = this.turnGen
    // writeContents 捕获引用快照：turn-end / turn-start 排链后替换新 Map，链上计算仍持旧引用
    const writeContents = this.writeContents
    const run = async (): Promise<void> => {
      // 回合代际守卫（仅 accumulating，见上方 JSDoc 第 2 条）：排链到执行之间可能已跨 turn
      if (changeSetStatus === 'accumulating' && gen !== this.turnGen) {
        console.debug(`[event-interpreter] file_changes accumulating dropped by turn-generation guard sid=${this.sessionId}`)
        return
      }
      const current = await fileChangeDiff.snapshotGitStatus(cwd)
      if (!current) return
      const changes: FileChange[] = fileChangeDiff.diffSnapshots(current)
      if (changes.length === 0) return
      const numstatMap = await fileChangeDiff.numstat(cwd)
      // 二次 gen 校验（仅 accumulating）：采集 await 窗口内跨 turn 的迟到帧不发出（守卫覆盖整个链上生命周期）
      if (changeSetStatus === 'accumulating' && gen !== this.turnGen) {
        console.debug(`[event-interpreter] file_changes accumulating dropped by turn-generation guard (post-await) sid=${this.sessionId}`)
        return
      }
      // 行数：numstat（已跟踪）+ writeContents 回退（untracked）
      fileChangeDiff.computeLineCounts(changes, numstatMap, writeContents)
      this.opts.send({
        type: 'message.file_changes',
        payload: {
          sessionId: this.sessionId,
          messageId,
          fileChanges: changes,
          changeSetStatus,
          isFullSet: true,
        },
      })
    }
    // 单段失败不断链：catch 后 diffChain 保持 resolved，后续帧照常排队。
    // warn（非 debug）：链段失败 = 一帧 file_changes 静默丢失，prod info 级日志下应可见
    const next = this.diffChain.then(run).catch((e: unknown) => {
      console.warn(`[event-interpreter] file_changes diff failed (frame dropped): ${toErrorMessage(e)}`)
    })
    this.diffChain = next
    return next
  }

  // ── subagent 内存态 + session.subagents 广播 ──

  /**
   * 缓存 subagent tool-call-start 的 startParam（agent/slug/task）。
   * tool-call-end 时按 toolCallId 取出，合并 details 的 subagentId/sessionFile/bgResponse 建记录。
   */
  private cacheSubagentStartParam(toolCallId: string, input: unknown): void {
    const args = input as { action?: string; startParam?: Record<string, unknown> } | undefined
    if (!args || args.action !== 'start' || !args.startParam) return
    const sp = args.startParam
    this.pendingStartParams.set(toolCallId, {
      agent: typeof sp.agent === 'string' ? sp.agent : 'general-purpose',
      slug: typeof sp.slug === 'string' ? sp.slug : '',
      task: typeof sp.task === 'string' ? sp.task : '',
    })
  }

  /**
   * subagent tool-call-end：合并缓存 startParam + details(SubagentToolResult) 建 running 记录。
   * details 结构（pi-subagent-workflow）：{action:'start', subagentId, sessionFile, bgResponse:{status:'running',...}}
   */
  private handleSubagentEnd(toolCallId: string, details: Record<string, unknown> | undefined): void {
    const startParam = this.pendingStartParams.get(toolCallId)
    this.pendingStartParams.delete(toolCallId)
    // start 事件丢失或不匹配 → 无法建记录（agent/slug/task 缺失），跳过
    if (!startParam) return
    if (!details) return

    const subagentId = typeof details.subagentId === 'string' ? details.subagentId : null
    if (!subagentId) return

    // 新发起的 subagent 恒为 running（pi-subagent-workflow 的 start action 返回 bgResponse.status='running'）
    const status: SubagentStatus = 'running'

    const record: SubagentRecord = {
      subagentId,
      sessionFile: typeof details.sessionFile === 'string' ? details.sessionFile : null,
      agent: startParam.agent,
      slug: startParam.slug,
      task: startParam.task,
      status,
    }

    this.subagentRecords.set(subagentId, record)
    this.broadcastSubagents()
  }

  /**
   * subagent bg-notify（custom_message）：更新已有记录的终态。
   *
   * details 两种形态（pi-subagent-workflow notifier 滑动窗口 60s 内合并）：
   *   - 单条：BgNotifyRecord = {id, status:'done'|'failed'|'cancelled', agent, model, result, error, startedAt, endedAt}
   *   - 批量：{batch:true, items: BgNotifyRecord[]}
   *
   * 用 parseBgNotifyDetails 解析（统一处理两种形态 + 防御性校验），
   * 用 normalizeSubagentStatus 归一（兼容 completed/error/crashed 等上游变体）。
   * agent 字段以 notify.agent 为准（pi 执行期回传的真实值，比 startParam 兜底权威）。
   * 批量多条更新后只广播一次（避免 N 次广播）。
   */
  private handleSubagentBgNotify(msg: ServerMessage): void {
    const payload = msg.payload as { customType?: string; details?: unknown } | undefined
    if (payload?.customType !== 'subagent-bg-notify') return

    const parsed = parseBgNotifyDetails(payload.details)
    if (!parsed) return

    const records: BgNotifyRecord[] = 'batch' in parsed ? parsed.items : [parsed]
    let changed = false
    for (const notify of records) {
      const existing = this.subagentRecords.get(notify.id)
      // 只更新已存在的内存记录（running 记录由 handleSubagentEnd 建入），不新建
      if (!existing) continue

      const updated: SubagentRecord = {
        ...existing,
        status: normalizeSubagentStatus(notify.status),
        // notify.agent 是 pi 执行期回传的真实 agent（finalize 时从 record.agent 来），
        // 覆盖 startParam 兜底的 'general-purpose'
        agent: notify.agent ?? existing.agent,
        model: notify.model ?? existing.model,
        error: notify.error ?? existing.error,
        startedAt: notify.startedAt ?? existing.startedAt,
        endedAt: notify.endedAt ?? existing.endedAt,
      }
      this.subagentRecords.set(notify.id, updated)
      changed = true
    }

    if (changed) this.broadcastSubagents()
  }

  /** 广播当前内存态的全量 subagent 列表（session.subagents server push） */
  private broadcastSubagents(): void {
    this.opts.send({
      type: 'session.subagents' as ServerMessageType,
      payload: {
        sessionId: this.sessionId,
        subagents: Array.from(this.subagentRecords.values()),
      },
    })
  }

  // ── workflow 实时推送 ──

  /**
   * workflow-result customStart（run 完成通知）：广播 session.workflows 增量信号。
   * details 结构（pi-subagent-workflow notifyDone）：{runId, name, status:'done', reason, traceLength, __gui__?}
   * 前端收到推送后调 loadWorkflows RPC 拉取完整列表（含 agentCalls）。
   */
  private handleWorkflowResult(msg: ServerMessage): void {
    const payload = msg.payload as { customType?: string; details?: Record<string, unknown> } | undefined
    if (payload?.customType !== 'workflow-result') return
    const details = payload.details
    if (!details) return

    const runId = typeof details.runId === 'string' ? details.runId : null
    if (!runId) return

    const reason = typeof details.reason === 'string' ? details.reason : undefined
    this.broadcastWorkflowUpdate({ runId, status: 'done', reason })
  }

  /**
   * workflow tool-call-end（action=run 发起）：广播 session.workflows running 信号。
   * details 结构（pi-subagent-workflow tool-workflow.ts）：{action:'run', runId, status:'running', name, slug?}
   * 前端收到推送后调 loadWorkflows RPC 拉取完整列表。
   */
  private handleWorkflowToolEnd(details: Record<string, unknown> | undefined): void {
    if (!details) return
    if (details.action !== 'run' || details.status !== 'running') return
    const runId = typeof details.runId === 'string' ? details.runId : null
    if (!runId) return

    this.broadcastWorkflowUpdate({ runId, status: 'running' })
  }

  /**
   * 广播 workflow 增量信号（session.workflows server push）。
   * 推送 {runId, status, reason?} 增量，非全量列表——前端收到后触发 loadWorkflows RPC 拉取完整数据。
   * 设计理由：发起时刻 runtime 无 agentCalls（workflow 刚启动），全量需读 state 文件增加复杂度；
   * 增量信号 + RPC 拉取复用现有 loadWorkflows 链路，零新增 IO 逻辑。
   */
  private broadcastWorkflowUpdate(update: { runId: string; status: string; reason?: string }): void {
    this.opts.send({
      type: 'session.workflowUpdate' as ServerMessageType,
      payload: {
        sessionId: this.sessionId,
        update,
      },
    })
  }

  // ── compaction 生命周期编排（M4 事件驱动：interpreter 唯一源）──

  /**
   * compaction_start → 广播 session.compacting{reason} + 置 runtime active.isCompacting=true。
   *
   * reason 透传给前端，驱动 compacting 浮层文案区分手动（'manual'）/自动（'threshold'|'overflow'）。
   * runtime active.isCompacting 经 onCompactingStateChange 回调置位，sendPrompt/sendBash 预检据此互斥。
   */
  private handleCompactionStart(ev: PiTranslatedEvent & { kind: 'compaction-start' }): void {
    this.opts.send({
      type: 'session.compacting',
      payload: { sessionId: this.sessionId, status: 'compacting', reason: ev.reason },
    })
    this.opts.onCompactingStateChange?.(this.sessionId, true)
  }

  /**
   * compaction_end → 唯一驱动 compaction 终态（成功/aborted/failed 三路）。
   *
   * 失败判据：errorMessage 真值为 failed（非 aborted 字段、非 key 存在性）—— pi 三种 aborted:true
   * 形态在 errorMessage 真值层面一致（extension cancel/signal abort 无 key；手动 catch 取消类
   * errorMessage 为 undefined）。分叉干净。
   *
   * 三路均复位 isCompacting（与 compaction_start 置位对称，SUG-新2）—— 否则 auto compact 结束后
   * active.isCompacting 永远 true，sendPrompt 预检永远拒，session 卡死。
   *
   * 孤儿 end 容错（SUG-新3）：overflow「已 retry 过一次」早退路径无 preceding start，end handler
   * 复位对「本来就 false 的 isCompacting」幂等无害；不维护 start/end 配对状态机。
   */
  private handleCompactionEnd(ev: PiTranslatedEvent & { kind: 'compaction-end' }): void {
    const hasError = !!ev.errorMessage
    if (hasError) {
      // failed：广播 session.compacted{error}（前端 compacted handler error 非空 → 不 flush，队列保留）
      // + message.error 进对话流（错误作为 assistant 消息插入，AGENTS.md 规则 #3）。
      this.opts.send({
        type: 'session.compacted',
        payload: { sessionId: this.sessionId, status: 'compacted', error: ev.errorMessage },
      })
      this.opts.send({
        type: 'message.error',
        payload: { sessionId: this.sessionId, message: `上下文压缩失败：${ev.errorMessage}（可重试 /compact，上下文未压缩、agent 记忆未变）` },
      })
    } else {
      // 成功（result 真值）或 aborted（无 errorMessage 真值）—— 都不带 error，前端 compacted handler flush queue。
      // 成功额外发 compactionSummary 进对话流 + applyContextUpdate 刷新 context 用量。
      if (ev.result) {
        const r = ev.result as { summary?: string; tokensBefore?: number; estimatedTokensAfter?: number }
        if (r.summary) {
          this.opts.send({
            type: 'message.compactionSummary',
            payload: {
              sessionId: this.sessionId,
              summary: r.summary,
              tokensBefore: r.tokensBefore,
              timestamp: Date.now(),
            },
          })
        }
        if (typeof r.estimatedTokensAfter === 'number' && r.estimatedTokensAfter > 0) {
          // compact 后无 turn_end，context 用量不会自动刷新。用 pi 返回的估算值触发 applyContextUpdate。
          this.opts.onContextUpdate?.(this.sessionId, {
            inputTokens: r.estimatedTokensAfter,
            totalTokens: r.estimatedTokensAfter,
          })
        }
      }
      this.opts.send({
        type: 'session.compacted',
        payload: { sessionId: this.sessionId, status: 'compacted' },
      })
    }
    // 三路复位对称（SUG-新2）
    this.opts.onCompactingStateChange?.(this.sessionId, false)
  }

  // ── [ADR-0047] ping 探测（进程健康检测，替代事件静默检测）──

  /**
   * 启动 ping 探测循环（turn-start 调用）。
   *
   * 幂等：若已有循环在跑（如上一 turn 未正常 stop），先清。每次 turn-start 重置
   * 失败计数与 warned，确保跨 turn 独立计数（本 turn 第 1 次失败 = 新一轮，不继承上 turn）。
   */
  private startPingLoop(): void {
    this.stopPingLoop()
    this.pingFailCount = 0
    this.pingWarned = false
    // [vitest 时序] setInterval 回调同步调度 tick；tick 内 await pingPi() 是微任务，
    // vi.advanceTimersByTimeAsync 能同时推进宏任务（setInterval tick）与被 flush 的微任务。
    this.pingTimer = setInterval(() => { void this.pingTick() }, PING_INTERVAL_MS)
  }

  /** 停止 ping 探测循环（turn-end / agent_end / onSilentAbort 调用）。幂等。 */
  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  /**
   * 单次 ping tick：调 pingPi() 探测 pi 进程是否响应 get_state。
   *
   * 成功（resolve 非 undefined）→ 清零失败计数 + warned 标志（AC-8b：中途成功重置累积）。
   * 失败（reject 或 resolve undefined）→ failCount++；达 2 次且 !warned 广播 WARN；达 3 次触发 onSilentAbort + stopPingLoop（AC-7）。
   */
  private async pingTick(): Promise<void> {
    const cb = this.opts.pingPi
    if (!cb) return // 未注入 pingPi（如组合根尚未接入）→ 不探测，不误 abort
    let ok = false
    try {
      const state = await cb()
      // resolve(undefined) 计为失败但不抛错（AC-9：client 未就绪不算崩溃信号，累积到 3 次仍 abort）
      ok = state !== undefined
    } catch (e) {
      // SR5：记日志（经 logger patchConsole 落盘，架构约定 #4），不静默吞错——pi 卡死的真实诊断依赖此处
      console.warn('[event-interpreter] ping get_state failed:', e)
      ok = false
    }
    // SR1（M1 并发 bug）：await cb() 窗口最长 PING_INTERVAL_MS，期间 turn-end 可能已到来
    // 触发 stopPingLoop（清 timer）。此时已 in-flight 的 pingTick 绝不能继续更新 failCount——
    // 否则 turn 已正常结束却因累积达阈值误触发 onSilentAbort，广播 aborted。
    // pingTimer === null 即被 stop，直接 return（不增计数、不广播、不 abort）。
    if (this.pingTimer === null) return
    if (ok) {
      // 健康响应 → 清零（AC-8b：中途成功后需重新累积 2 次才 WARN）
      this.pingFailCount = 0
      this.pingWarned = false
      return
    }
    this.pingFailCount += 1
    // AC-8：连续 2 次失败广播 message.stream_warn 一次（提示性，不中断流）
    if (this.pingFailCount === PING_WARN_FAIL_COUNT && !this.pingWarned) {
      this.pingWarned = true
      this.opts.send({
        type: 'message.stream_warn',
        payload: {
          sessionId: this.sessionId,
          // SR3：间隔由 PING_INTERVAL_MS 决定，不硬编码 60（常量 SSOT）
          // 1000 = ms→s 换算常数，无语义歧义
          // eslint-disable-next-line no-magic-numbers
          content: `pi 进程连续 ${this.pingFailCount * (PING_INTERVAL_MS / 1000)}s 未响应健康探测，可能卡死`,
        },
      })
    }
    // ADR-0047：连续 3 次失败 → 判定 pi 进程真死 → onSilentAbort + 停止 ping（AC-7）
    if (this.pingFailCount >= PING_FAIL_THRESHOLD) {
      this.stopPingLoop()
      this.opts.onSilentAbort?.({ sessionId: this.sessionId })
    }
  }
}
