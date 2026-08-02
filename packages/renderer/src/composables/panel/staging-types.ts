/**
 * staging-types —— Composer Staging 策略模式的类型契约（ADR-0057）。
 *
 * 与 ADR-0056（模型/thinking 暂存层）的关系：ADR-0056 管「模型快照」一个维度
 * （useComposerModelThinking 的 stagingModel/stagingThinking refs），明确「不抽象，用 ref 快照」。
 * 本文件管更高一层：「模式状态机 + 发送/取消行为路由」。两者不同层次，不冲突。
 *
 * 核心思想：每种 staging type（fork / handoff，未来可扩展）的完整行为契约收敛为
 * 一个 StagingAction 策略对象。Composer 经 useComposerStaging 的 activeStaging 统一消费，
 * 消除散落的 if-else/优先级链（onSend 分流、boxClass/placeholder 四级链、title 三元嵌套、
 * 互斥 watch 散落两处）。
 *
 * 新增 staging type 只需：加枚举值 + 实现 StagingAction 接口 + 在 useComposerStaging 注册。
 */
import type { Component, ComputedRef } from 'vue'

/**
 * Staging 类型枚举。
 *
 * 当前成员：'fork'（fork-ask 提问模式）/ 'handoff'（fast-handoff 交接模式）。
 * 未来扩展点：新增 type 只需加枚举值 + 实现 StagingAction 接口 + 注册到 useComposerStaging。
 */
export type StagingType = 'fork' | 'handoff'

/**
 * 暂存的模型/thinking 配置（ADR-0056 模型暂存层产出）。
 *
 * 由 useComposerModelThinking.getStagingConfig() 返回，send 时透传给 features 层
 * （useForkActions.forkSessionAsk / useHandoffActions.handoff），最终到 runtime 创建新 session。
 * 两个字段都是可选的——用户进 staging 后没切模型/thinking 时，快照值与源 session 相同，
 * 不传 override 让 runtime 走默认继承。
 */
export interface StagingConfig {
  modelOverride?: string
  thinkingOverride?: string
}

/**
 * Staging 来源信息（进入模式时记录，send 时消费）。
 *
 * fork 需要 fromMessageId（fork 点 assistant id，runtime 据此截断历史）；
 * handoff 不需要（始终从末条 assistant 打包文档，runtime 从 agent_end 提取）。
 * 用交叉类型区分，让 fork action 的 enter 签名强制要求 fromMessageId。
 */
export interface ForkSource {
  type: 'fork'
  srcSessionId: string
  fromMessageId: string
}

export interface HandoffSource {
  type: 'handoff'
  srcSessionId: string
}

export type StagingSource = ForkSource | HandoffSource

/**
 * StagingAction —— 某种 staging type 的完整行为契约。
 *
 * 分两阶段（与 Composer 生命周期对齐）：
 *
 * A 阶段「暂存态」（用户已进模式，发送前）：
 *   - isActive：此 staging 是否活跃（Composer 的 mode 单一真源派生自此）
 *   - enter / exit：进入（记来源 + enterStagingMode 快照模型 + 聚焦输入）/ 退出（清来源 + exitStagingMode）
 *   - send：发送（经 Composer.onSend 路由到此），text = draft，staging = 模型/thinking 快照配置
 *   - allowsEmptySend：是否允许空输入发送（handoff 允许 reply 为空；fork 必须有 content）
 *   - handleEsc：Esc 处理（清输入 + exit），返回是否已消费
 *
 * B 阶段「进行中态」（用户已发送，操作在跑）：
 *   - isInProgress：此操作是否进行中（handoff → chatStore.isHandingOff；fork → 始终 false）
 *   - abort：取消进行中的操作（handoff → abortHandoff；fork 无此阶段，实现可省略）
 *
 * 视觉（boxClass / placeholder / mode-chip）：
 *   - visual：派生的 class 串、placeholder 文案、chip 标签与图标
 */
export interface StagingAction<S extends StagingSource = StagingSource> {
  /** 类型标识（注册键 + 日志诊断） */
  readonly type: StagingType

  // ── A 阶段：暂存态（发送前）──

  /** 是否处于此 staging（活跃判定，Composer mode 单一真源派生自此） */
  readonly isActive: ComputedRef<boolean>
  /**
   * 进入此 staging。
   * 实现职责：记 source + enterStagingMode（快照模型/thinking）+ 聚焦输入框。
   * 互斥由 useComposerStaging.enter 统一编排（进入新 type 前退出其他 type），
   * 实现内部不需关心互斥。
   */
  readonly enter: (source: S) => void
  /** 退出此 staging（清 source + exitStagingMode 恢复常规态模型 chip） */
  readonly exit: () => void
  /**
   * 发送（经 Composer.onSend 路由到此）。
   * 实现职责：trim text（allowsEmptySend=false 时空文本拦截）+ clearInput + setSending(true)
   * + 取 getStagingConfig 透传 + 调 features 层 action（forkSessionAsk / handoff）
   * + 失败 restoreInput + toastError + finally setSending(false) + exit。
   * @param text 当前 draft
   * @param staging 模型/thinking 暂存配置（来自 useComposerModelThinking.getStagingConfig）
   */
  readonly send: (text: string, staging: StagingConfig) => Promise<void>
  /** 是否允许空输入发送（handoff 允许 reply 为空；fork 必须有 content） */
  readonly allowsEmptySend: boolean
  /**
   * Esc 处理：此 staging 活跃时清空输入 + 退出，返回 true 表示已消费。
   * 非此 staging 活跃或非 Escape 键返回 false（让上游继续派发）。
   */
  readonly handleEsc: (e: KeyboardEvent) => boolean

  // ── B 阶段：进行中态（发送后）──

  /**
   * 此操作是否进行中（Composer stop 按钮的 abort 路由依据）。
   * handoff → chatStore.isHandingOff(srcSessionId)（handoff turn 在源 session 跑）；
   * fork → 始终 false（fork-ask 是前端编排的 fork+send，无独立 inflight 可取消）。
   */
  readonly isInProgress: ComputedRef<boolean>
  /**
   * 取消进行中的操作（可选——无 B 阶段语义的 staging 如 fork 可不实现）。
   * handoff → useHandoffActions.abortHandoff（session.abortHandoff RPC + 乐观清 handingOff）。
   * @param sessionId 源 session id
   */
  readonly abort?: (sessionId: string) => Promise<void>

  // ── 视觉（boxClass / placeholder / mode-chip）──

  readonly visual: {
    /** composer-box class（accent 边框 + glow ring + accent-soft 底）；非活跃返回空串 */
    readonly boxClass: ComputedRef<string>
    /** placeholder 文案；非活跃返回 null（调用方回退到普通 placeholder） */
    readonly placeholder: ComputedRef<string | null>
    /** mode-chip 标签的 i18n key（如 panel.composer.forkChip） */
    readonly chipLabelKey: string
    /** mode-chip 图标组件（GitFork / Upload） */
    readonly chipIcon: Component
  }
}
