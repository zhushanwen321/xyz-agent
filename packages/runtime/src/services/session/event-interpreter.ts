/**
 * EventInterpreter — 消费 PiTranslatedEvent[]，执行业务编排（R1 重构）。
 *
 * [定位] service 层。承接 EventAdapter（infra 纯翻译器）产出的中间事件，做副作用：
 *   1. plugin hook 触发（onBeforeToolCall 阻断/改写、onAfterToolResult 改写、onPiEvent 观测）
 *   2. file_changes baseline diff（turn 内写操作实时 + agent_end 最终对账）—— 经 IFileChangeDiff port
 *   3. context.update 回写 session 缓存（sessionService.applyContextUpdate）
 *   4. thinkingLevel 回写 session 缓存（sessionService.setThinkingLevelCache）
 *   5. status/bridge/extension-ui 路由到 server（注册超时 / 处理 bridge 请求）
 *
 * 持有的可变态（从 event-adapter 迁来）：
 *   - currentMessageId（message_start 设置，file_changes 挂载目标）
 *   - statusBaseline（turn 开始 git status 快照，baseline diff 基准）
 *   - writeContents（本 turn write 工具写入的 content，untracked 行数回退用）
 *
 * [ADR-0024 D5] git 作为唯一真值源：turn 开始采 baseline，写操作后 diff，agent_end 推 ready 全集。
 * 非 git 仓库 / cwd 缺省 → 跳过 diff（不推 file_changes）。
 *
 * 依赖经构造注入：send（WS 帧）、fileChangeDiff（port，git 纯函数经组合根注入）、
 * 各业务回调（executeHooks / contextUpdate / thinkingLevel / status/bridge/extension-ui 路由）。
 */
import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'
import type { FileChange } from '@xyz-agent/shared'
import { SUBAGENT_TOOL_NAMES, WORKFLOW_TOOL_NAMES } from '@xyz-agent/shared'
import type { SubagentRecord, SubagentStatus } from '@xyz-agent/shared'
import { toErrorMessage } from '../../utils/errors.js'
import type { IFileChangeDiff, FileChangeSnapshot } from '../ports/file-change-diff.js'
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
  /** file_changes baseline diff 引擎（port，组合根注入 infra 实现）。 */
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
  onTurnFinalize?: (sessionId: string) => void
  /** thinking_level_changed 回写 session 缓存（组合根注入 sessionService.setThinkingLevelCache）。 */
  onThinkingLevelChanged?: (sessionId: string, level: string | undefined) => void
  /** extension 交互式 UI 请求（注册前端超时）。组合根注入 server.registerExtensionTimeout。 */
  onExtensionUIRequest?: (requestId: string, sessionId: string, method: string) => void
  /** bridge:* 前缀请求（直接路由不经前端超时）。组合根注入 server.handleBridgeRequest。 */
  onBridgeUIRequest?: (requestId: string, sessionId: string, method: string, data: Record<string, unknown>) => void
  /** extension setStatus（路由到 statusline 插件）。组合根注入 server.handleStatusSetUpdate。 */
  onStatusSetUpdate?: (payload: { sessionId: string; key: string; text: string; textRaw?: string }) => void
}

/** 可能改文件的工具（baseline diff 触发判定，与原 event-adapter 一致）。 */
const FILE_MUTATING_TOOLS = new Set(['write', 'edit', 'bash'])

export class EventInterpreter {
  /** 当前 assistant message 的 id（message_start 设置，file_changes 挂载目标，跨事件保持） */
  private currentMessageId: string | undefined
  /** turn 开始时的 git status 快照（baseline diff 基准，message_start 采集，agent_end 清空） */
  private statusBaseline: FileChangeSnapshot = null
  /** 本 turn write 工具写入的 content（untracked 行数回退用，message_start 清空） */
  private writeContents: Map<string, string> = new Map()
  /**
   * subagent 内存态：subagentId → SubagentRecord。
   * tool-call-end 建 running 记录，bg-notify 更新终态。每次变更广播 session.subagents。
   * per-session（interpreter 实例级），session 销毁时随实例释放。
   */
  private subagentRecords: Map<string, SubagentRecord> = new Map()
  /** subagent tool-call-start 的 startParam 缓存（toolCallId → startParam），end 时取出合并 */
  private pendingStartParams: Map<string, { agent: string; slug: string; task: string }> = new Map()

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
        this.handle(ev)
      // eslint-disable-next-line taste/no-silent-catch -- 仅隔离日志：不 re-throw 会让后续事件（含 agent_end）无法投递，单条坏事件炸掉整条事件流
      } catch (err: unknown) {
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
        // 记 messageId（file_changes 挂载目标）+ 采 baseline 快照（ADR-0024 D5）
        this.currentMessageId = ev.messageId
        this.statusBaseline = this.opts.cwd && this.opts.fileChangeDiff
          ? this.opts.fileChangeDiff.snapshotGitStatus(this.opts.cwd)
          : null
        this.writeContents.clear()
        return
      case 'tool-call-start':
        // hook 改写是异步的：handler 内部 await 后 send（不阻塞本循环）
        void this.handleToolCallStart(ev)
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
        this.opts.onExtensionUIRequest?.(ev.requestId, ev.sessionId, ev.method)
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
    }
  }

  /** tool-call-start：跑 onBeforeToolCall hook（可阻断/改写 input）后产出 tool_call_start WS 帧 + onPiEvent hook。 */
  private async handleToolCallStart(ev: PiTranslatedEvent & { kind: 'tool-call-start' }): Promise<void> {
    const { toolCallId, toolName } = ev
    let input = ev.input

    if (this.opts.executeHooks) {
      try {
        const hookResult = await this.opts.executeHooks('onBeforeToolCall', { toolName, input })
        if (hookResult.blocked === true) {
          // 阻断：不产出 tool_call_start，但仍触发 onPiEvent hook（带 blocked 标记，供观测插件）
          this.opts.executeHooks?.('onPiEvent', { event: 'tool_execution_start', toolCallId, toolName, input, blocked: true }).catch(() => {})
          return
        }
        if (hookResult.transformedData !== undefined) {
          input = hookResult.transformedData
        }
      // eslint-disable-next-line taste/no-silent-catch
      } catch (e) {
        console.debug(`[event-interpreter] hook tool_execution_start error: ${toErrorMessage(e)}`)
      }
    }

    // 观测 hook（tool_execution_start）
    this.opts.executeHooks?.('onPiEvent', { event: 'tool_execution_start', toolCallId, toolName, input }).catch(() => {})

    this.opts.send({
      type: 'message.tool_call_start',
      payload: { sessionId: this.sessionId, toolCallId, toolName, input },
    })

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
      // eslint-disable-next-line taste/no-silent-catch
      } catch (e) {
        console.debug(`[event-interpreter] hook tool_execution_end error: ${toErrorMessage(e)}`)
      }
    }

    // 观测 hook（tool_execution_end）
    this.opts.executeHooks?.('onPiEvent', { event: 'tool_execution_end', toolCallId, output, details, images }).catch(() => {})

    // ADR-0024 D5：失败的调用不触发 diff（避免噪声）；累积 write content + 实时 diff
    if (!isError) {
      if (ev.writeContent) {
        this.writeContents.set(ev.writeContent.filePath, ev.writeContent.content)
      }
      if (FILE_MUTATING_TOOLS.has(toolName)) {
        this.sendDiffFileChanges('accumulating')
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
  private handleTurnEnd(ev: PiTranslatedEvent & { kind: 'turn-end' }): Promise<void> {
    // 转发 message.complete WS 帧
    this.opts.send(ev.message)

    // context.update 回写（inputTokens > 0 时）
    if (ev.inputTokens) {
      this.opts.onContextUpdate?.(this.sessionId, { inputTokens: ev.inputTokens, totalTokens: ev.totalTokens ?? 0 })
    }

    // 副作用：复位 isGenerating=false + tryPersistLabel 兜底（原 attachUsageListener agent_end 分支）
    this.opts.onTurnFinalize?.(this.sessionId)

    // 观测 hook（agent_end）
    this.opts.executeHooks?.('onPiEvent', { event: 'agent_end', stopReason: ev.stopReason, usage: ev.usage }).catch(() => {})

    // ADR-0024 D5：agent_end 推 ready 全集（baseline diff 最终结果），推后清空 baseline + writeContents
    this.sendDiffFileChanges('ready')
    this.statusBaseline = null
    this.writeContents.clear()

    return Promise.resolve()
  }

  /**
   * 推送 baseline diff 结果的 file_changes 帧（从 event-adapter 迁来）。
   *
   * 机制：diff 当前 git status vs turn 开始 baseline → 本 turn 变更。
   * isFullSet=true（baseline diff 每次全量结果，前端全集替换）。
   * 非 git 仓库 / cwd 缺省 → 跳过。
   */
  private sendDiffFileChanges(changeSetStatus: 'accumulating' | 'ready'): void {
    if (!this.currentMessageId) return
    const { cwd, fileChangeDiff } = this.opts
    if (!cwd || !fileChangeDiff) return
    const current = fileChangeDiff.snapshotGitStatus(cwd)
    if (!current) return
    const changes: FileChange[] = fileChangeDiff.diffSnapshots(this.statusBaseline, current)
    if (changes.length === 0) return
    // 行数：numstat（已跟踪）+ writeContents 回退（untracked）
    fileChangeDiff.computeLineCounts(cwd, changes, this.writeContents)
    this.opts.send({
      type: 'message.file_changes',
      payload: {
        sessionId: this.sessionId,
        messageId: this.currentMessageId,
        fileChanges: changes,
        changeSetStatus,
        isFullSet: true,
      },
    })
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
   * details 结构（BgNotifyDetails）：{id, status:'done'|'failed'|'cancelled', agent, model, result, error, startedAt, endedAt}
   */
  private handleSubagentBgNotify(msg: ServerMessage): void {
    const payload = msg.payload as { customType?: string; details?: Record<string, unknown> } | undefined
    if (payload?.customType !== 'subagent-bg-notify') return
    const details = payload.details
    if (!details) return

    const subagentId = typeof details.id === 'string' ? details.id : null
    if (!subagentId) return

    const existing = this.subagentRecords.get(subagentId)
    if (!existing) return

    const status = details.status === 'done' ? 'done'
      : details.status === 'failed' ? 'failed'
      : details.status === 'cancelled' ? 'cancelled'
      : existing.status

    const updated: SubagentRecord = {
      ...existing,
      status,
      model: typeof details.model === 'string' ? details.model : existing.model,
      error: typeof details.error === 'string' ? details.error : existing.error,
      startedAt: typeof details.startedAt === 'number' ? details.startedAt : existing.startedAt,
      endedAt: typeof details.endedAt === 'number' ? details.endedAt : existing.endedAt,
    }

    this.subagentRecords.set(subagentId, updated)
    this.broadcastSubagents()
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
}
