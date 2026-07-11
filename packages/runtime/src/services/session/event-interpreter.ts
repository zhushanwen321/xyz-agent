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
import type { ServerMessage } from '@xyz-agent/shared'
import type { FileChange } from '@xyz-agent/shared'
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
  /** thinking_level_changed 回写 session 缓存（组合根注入 sessionService.setThinkingLevelCache）。 */
  onThinkingLevelChanged?: (sessionId: string, level: string | undefined) => void
  /** extension 交互式 UI 请求（注册前端超时）。组合根注入 server.registerExtensionTimeout。 */
  onExtensionUIRequest?: (requestId: string, sessionId: string, method: string) => void
  /** bridge:* 前缀请求（直接路由不经前端超时）。组合根注入 server.handleBridgeRequest。 */
  onBridgeUIRequest?: (requestId: string, sessionId: string, method: string, data: Record<string, unknown>) => void
  /** extension setStatus（路由到 statusline 插件）。组合根注入 server.handleStatusSetUpdate。 */
  onStatusSetUpdate?: (payload: { sessionId: string; key: string; text: string }) => void
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
      this.handle(ev)
    }
  }

  private handle(ev: PiTranslatedEvent): void {
    switch (ev.kind) {
      case 'noop':
        return
      case 'message':
        this.opts.send(ev.message)
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
        // pi turn_end 的单 turn 用量：只回写 context.update，不转发 message.complete
        // （避免每 turn 触发 setStreaming 闪烁；message.complete 仍由 turn-end/agent_end 独占）
        this.opts.onContextUpdate?.(ev.sessionId, { inputTokens: ev.inputTokens, totalTokens: ev.totalTokens })
        return
      case 'status-set':
        this.opts.onStatusSetUpdate?.({ sessionId: this.sessionId, key: ev.key, text: ev.text })
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
  }

  /** turn-end（agent_end）：转发 message.complete + context.update 回写 + 观测 hook + file_changes ready diff + 清空态。 */
  private handleTurnEnd(ev: PiTranslatedEvent & { kind: 'turn-end' }): Promise<void> {
    // 转发 message.complete WS 帧
    this.opts.send(ev.message)

    // context.update 回写（inputTokens > 0 时）
    if (ev.inputTokens) {
      this.opts.onContextUpdate?.(this.sessionId, { inputTokens: ev.inputTokens, totalTokens: ev.totalTokens ?? 0 })
    }

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
}
