/**
 * Composer 发送分流（onSend）—— D6 统一发送分发器（session-occupancy-send-closure u5b）。
 *
 * 职责单一：把 onSend 的发送分流逻辑收口在此处。onSend 是 Composer 的**唯一**发送入口
 * （Enter / Alt+Enter / 发送按钮全部汇入），优先级链：
 * staging > [D6 steer 路由] > canSend 守卫 > staging.send > [D6 defer 路由] >
 * landing（含 bash 检测）> bash(!/!!) > /compact > send。
 *
 * [u5b / D6] 路由判定（resolveSendRoute，sessionPhase → sendRoute）先于 canSend 守卫：
 * steer 路由（turn 活跃）恰在 canSend 的 isBusy 集内，守卫在前会把它拦死。steer 分支的
 * 终端是 deps.steer（useChat.steer：isActive 时并入 steering 队列；投影滞后窗口 isActive=false
 * 时内部静默 return——该窗口调用方回退走 direct 直发路径，本函数在 onSteer 式编排前以
 * sessionPhase 判定路由，迟到投影由 useChat.send 的 B 策略兜底，双通道自愈不丢输入）。
 * defer 分支（settling / compacting / bash）泛化原 isCompacting 分支：`/`、`!` 前缀命令
 * 拒绝 toast 保留（命令无法延迟重放），普通文本入 defer 队列（occupancy 全 idle 时
 * useChat occupancy handler 触发 flush 投递）。
 *
 * 提取到 composable 以满足 Composer.vue <script setup> 行数上限（300 行）。
 *
 * 不含：followUp / abort（见 useComposerSubmit）/ 输入编辑（留 Composer.vue / 其他 composable）。
 *
 * [W3 迁移] 迁自 renderer composables/panel/useComposerSend.ts。改动：
 * - 去掉 renderer 跨域依赖 `import { useCompactQueue } from './useCompactQueue'`，以及
 *   onSend 内联的 `useCompactQueue().enqueue(...)` 直调。改为经 ComposerSendDeps.enqueueCompact
 *   回调注入（壳层从 useCompactQueue 派生后传入），core 零 composable 依赖。
 * - import 路径：`./staging-types` → `../types`（StagingAction / StagingConfig）；
 *   `./useComposerBash` → `./bash`（BashCommandExtract，本域 dispatch 同目录）。
 * [u5b 改造] isCompacting dep 退役（路由判定统一由 getSendRoute 承担）；新增 getSendRoute
 * 与 steer dep（composer-shell 组装）。
 */
import type { ComputedRef, Ref } from 'vue'
import type { Segment } from '@xyz-agent/shared'
import type { BashCommandExtract, StagingAction, StagingConfig } from '../types'
import type { SendRoute } from './send-route'

/**
 * ComposerInput 实例最小契约（getSegments 经 defineExpose 暴露）。
 * 用结构类型避免 import .vue 文件（循环依赖 + 类型推断复杂），
 * 同 useComposerSubmit / useComposerRestore 范式。
 */
interface ComposerInputInstance {
  getSegments: () => Segment[]
}

/**
 * composerBash 最小契约（extractBashCommand / trySendBash）。
 * 用结构类型而非 ReturnType<typeof useComposerBash>——后者会引入 isBashMode 等本 composable
 * 不需要的成员，结构类型更精准表达「只消费这两个方法」。
 */
interface ComposerBashShape {
  /** [W5] 从文本提取 bashCommand（discriminated union），landing 态首发分流用 */
  extractBashCommand: (text: string) => BashCommandExtract
  /** 尝试 bash 分流（active 态 !/!! 前缀）。返回 true 表示已处理（调用方 return） */
  trySendBash: (rawText: string) => Promise<boolean>
}

/**
 * flow 最小契约（submitFirstMessage）。landing 态首发提交用。
 * 结构类型精准表达「只消费 submitFirstMessage」。
 */
interface NewTaskFlowShape {
  /**
   * landing 态首发提交（create session + apply 模型/思考等级 + 载入 panel + 发送）。
   * @param segments 结构化 segments（含 text/image/skill/file/mention 段）
   * @param thinkingLevel 可选思考等级（landing 态 Composer 选定值）
   * @param bashCommand bash 命令参数（仅 extractBashCommand.type === 'command' 时传入）
   */
  submitFirstMessage: (
    segments: Segment[],
    thinkingLevel?: string,
    bashCommand?: { command: string; excludeFromContext: boolean },
  ) => Promise<void>
}

export interface ComposerSendDeps {
  // ── staging 路由 ──
  /** staging 聚合层（useComposerStaging 返回），activeStaging 经派生驱动 staging 分流 */
  staging: {
    /** 是否有任意 staging 活跃（A 阶段：发送前 mode 已开） */
    hasActiveStaging: ComputedRef<boolean>
    /** 经 activeStaging 路由发送；true = 已消费（不走普通 send） */
    send: (text: string, stagingConfig: StagingConfig) => Promise<boolean>
    /** 当前活跃的 staging action（null = 普通态），allowsEmptySend 守卫用 */
    activeStaging: ComputedRef<StagingAction | null>
  }
  /** 取 staging 模型/thinking 暂存配置（ADR-0056，仅 staging 活跃时调） */
  getStagingConfig: () => StagingConfig
  // ── 守卫 ──
  /** 是否可发送（hasInput && !isBusy）—— 非 staging 态 direct 路由的发送守卫（isBusy 语义由调用方烘进 canSend）。
   *  [u5b] steer 路由不受本守卫拦（判定在其之前）；defer 路由仍受拦（isSending 期防双发）。 */
  canSend: ComputedRef<boolean>
  /** 是否有输入（D6 steer 路由分支的前置守卫——steer 判定在 canSend 之前，空输入单独拦） */
  hasInput: ComputedRef<boolean>
  // ── D6 发送路由（u5b）──
  /** 当前 session 的发送路由（D6 表：direct/steer/defer）。composer-shell 从 chat store
   *  sessionPhase 派生后注入；landing（无 session）恒 direct。 */
  getSendRoute: () => SendRoute
  // ── 输入 ──
  /** draft ref（纯文本，用于发送判断 + 文本提取） */
  draft: Ref<string>
  /** inputRef（ComposerInput 实例 ref，getSegments 快照用） */
  inputRef: Ref<ComposerInputInstance | null>
  // ── session / variant ──
  /** sessionId ref（send / compact 调用参数） */
  sessionIdRef: ComputedRef<string | null>
  /** variant ref（'panel' | 'landing'，landing 分流依据） */
  variantRef: ComputedRef<'panel' | 'landing'>
  // ── bash ──
  /** composerBash（extractBashCommand / trySendBash）—— landing + active 两态 bash 分流 */
  composerBash: ComposerBashShape
  // ── 输入恢复 ──
  /** 清空输入（useComposerRestore 提供） */
  clearInput: () => void
  /** 失败恢复 text + 各类 chip（useComposerRestore 提供） */
  restoreSegments: (segments: Segment[]) => void
  // ── 状态 ──
  /** 发送中状态（普通 send / landing 首发 / staging 发送期间置 true）——兼作 staging 双发锁
   *  （不拦 isActive：fork-ask 对源 session 只读，streaming 中合法；handoff 的 streaming
   *  拦截在 handleHandoffSend 的 isSessionActive 兑底） */
  isSending: Ref<boolean>
  // ── landing 首发依赖 ──
  /** flow（submitFirstMessage —— landing 态首发提交） */
  flow: NewTaskFlowShape
  /** landing 态选定的思考等级（undefined = 用户未操作，用 runtime 默认） */
  localThinkingLevel: Ref<string | undefined>
  // ── 普通 send / compact / steer ──
  /** 普通发送（useChat 提供；isActive 时内部 B 策略转 steer——steer 路由投影滞后的自愈兜底） */
  send: (sessionId: string, segments: Segment[]) => Promise<void>
  /** 压缩上下文（useChat 提供） */
  compact: (sessionId: string, customInstructions?: string) => Promise<void>
  /** 追加 steer（useChat 提供；isActive 时并入 steering 队列）。D6 steer 路由终端。 */
  steer: (sessionId: string, segments: Segment[]) => Promise<void>
  /** compact 期间入队待重放消息（useCompactQueue.enqueue 注入，替代直调 useCompactQueue） */
  enqueueCompact: (sessionId: string, text: string) => void
  // ── 反馈 ──
  /** toast 错误（useToast 提供） */
  toastError: (msg: string) => void
  /** i18n 翻译（useI18n 提供） */
  t: (key: string, params?: Record<string, unknown>) => string
}

/**
 * @param deps staging / getStagingConfig / canSend / getSendRoute / draft / inputRef /
 *   sessionIdRef / variantRef / composerBash / clearInput / restoreSegments /
 *   isSending / flow / localThinkingLevel / send / compact / steer / enqueueCompact / toastError / t
 *   （Composer.vue 内定义后注入）
 */
export function useComposerSend(deps: ComposerSendDeps): { onSend: () => Promise<void> } {
  /**
   * 发送分流（D6 统一分发器，Enter / Alt+Enter / 发送按钮共用）：
   * staging > [steer 路由] > canSend 守卫 > staging.send > [defer 路由] > landing（含 bash
   * 检测）> bash(!/!!) > /compact > send。
   * 失败均 restoreSegments 回滚草稿（W8）。
   */
  async function onSend(): Promise<void> {
    // [D6] 路由判定先于一切分流（staging 除外——staging 是模式提交，与 occupancy 路由正交，
    // 用户决策 streaming 中 fork 提交合法）。
    const route = deps.getSendRoute()
    // staging 活跃时由 StagingAction 自管 allowsEmptySend（handoff 允许空，fork 不允许）；
    // 双发锁只看 isSending（staging 发送自身会置位），不拦 isActive——fork-ask 发给新建
    // session 对源 session 只读，streaming 中合法（handoff 的 streaming 拦截在
    // handleHandoffSend 的 isSessionActive 兑底，非此处）。非 staging 走路由 + canSend 守卫。
    const activeStaging = deps.staging.activeStaging.value
    const canStagingSend = !!activeStaging && (activeStaging.allowsEmptySend || deps.canSend.value) && !deps.isSending.value
    // [D6] steer 路由（turn 活跃 = dispatching/generating，行 2/3）：追加当前回合，不打断。
    // 判定条件 = route==='steer' ∧ 本地 busy（canSend=false）——真实时序下 turn 活跃必然
    // 伴随本地视图 busy（streaming 实体 / 乐观 pendingSend），steer 内部 isActive 守卫必过；
    // 仅毫秒级投影失配窗口（retry/followUp 续跑的 turn-start 先于 message_start 到达，本地
    // 已收口而投影已 flip generating）会出现 route==='steer' ∧ 本地 idle——此时不进本分支，
    // 落入下方 direct 流程：useChat.send 的 B 策略内部再裁决（busy→steer）/ idle 直发被拒时
    // send.rejected 兜底静默入队自愈——不丢输入不丢消息。isSending 期拦（防双发锁失效）。
    // 命令分流（bash/ /compact）不适用——turn 活跃时命令文本按 steer 消息投递（现状 Enter
    // isActive→onSteer 同语义，pi 侧 skill 展开处理）。
    if (!activeStaging && route === 'steer' && !deps.canSend.value) {
      if (!deps.hasInput.value || deps.isSending.value) return
      const sid = deps.sessionIdRef.value
      if (!sid) return
      // clearInput 会清空 DOM，必须先快照 segments（onSend/submit 同范式）
      const segments = deps.inputRef.value?.getSegments() ?? []
      deps.clearInput()
      await deps.steer(sid, segments)
      return
    }
    if (!deps.canSend.value && !canStagingSend) return
    const text = deps.draft.value
    // staging 路由：经 useComposerStaging.send → activeStaging.send。仅在有活跃 staging 时取 staging config
    // 透传（fork/handoff 内部 handleXxxSend 也自取 deps.getStagingConfig，传参与自取等价故实际被忽略）。
    // 守卫 hasActiveStaging：非 staging 态不调 getStagingConfig（避免测试 mock 未提供该方法时炸 + 语义清晰）。
    if (deps.staging.hasActiveStaging.value && await deps.staging.send(text, deps.getStagingConfig())) return
    // [D6] defer 路由（settling / compacting / bash，行 4/5/6）：占用期发送动作改为入队待重放
    // （flush 在 occupancy 全 idle 时由 useChat occupancy handler 统一触发——触发源不再绑定
    // session.compacted）。`/` 前缀是命令——占用结束后才能执行，此处拒绝 + toast，draft 保留
    // 不清空。`!` 对称于 `/`：避免 bash 命令被静默降级为纯文本入队（重放走普通 send 不会按
    // bash 执行，用户语义被悄悄改变）。入队语义是重放纯文本（用 draft 而非 segments——segments
    // 含 chip/图片段，重放时无 chip 上下文）。
    if (route === 'defer') {
      // sessionIdRef 非空性与 defer 路由同源（无 session 的 landing 无 occupancy 记录恒 direct，
      // 不会进本分支；守卫是防御层）。把不变量局部化，消除 enqueue 处的 `!` 断言。
      if (!deps.sessionIdRef.value) return
      if (text.trim().startsWith('/') || text.trim().startsWith('!')) {
        deps.toastError(deps.t('panel.composer.commandQueuedRejected'))
        return
      }
      // 先 enqueue 再 clearInput：text 在函数开头已捕获（= draft 当前值），
      // clearInput 会把 draft 置空，顺序颠倒会入队空字符串。
      deps.enqueueCompact(deps.sessionIdRef.value, text)
      deps.clearInput()
      return
    }
    const segments = deps.inputRef.value?.getSegments() ?? [] // 先快照（clearInput 会清空 DOM）
    if (deps.variantRef.value === 'landing') {
      // landing bash 分流：提取 !/!! 前缀（empty=空命令不提交；not-bash=走普通首发）
      const bashExtract = deps.composerBash.extractBashCommand(text)
      if (bashExtract.type === 'empty') return
      deps.clearInput()
      deps.isSending.value = true
      try {
        // B6：preset 透传走 flow.pendingPreset，不在此读 store 第二真源
        const bashCommand = bashExtract.type === 'command' ? bashExtract : undefined
        await deps.flow.submitFirstMessage(segments, deps.localThinkingLevel.value, bashCommand)
      } catch (e) {
        deps.restoreSegments(segments)
        deps.toastError(deps.t('panel.panel.taskFailed', { error: e instanceof Error ? e.message : String(e) }))
      } finally {
        deps.isSending.value = false
      }
      return
    }
    // active 态：bash 分流（!/!! 前缀，必须在 /compact 前）+ /compact + 普通发送
    if (await deps.composerBash.trySendBash(text)) return
    const trimmed = text.trim()
    if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
      const customInstructions = trimmed.startsWith('/compact ')
        ? trimmed.slice('/compact '.length).trim() || undefined
        : undefined
      deps.clearInput()
      await deps.compact(deps.sessionIdRef.value!, customInstructions)
      return
    }
    deps.clearInput()
    deps.isSending.value = true
    try {
      await deps.send(deps.sessionIdRef.value!, segments)
    } catch (e) {
      deps.restoreSegments(segments)
      deps.toastError(deps.t('panel.panel.sendFailed', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      deps.isSending.value = false
    }
  }

  return { onSend }
}
