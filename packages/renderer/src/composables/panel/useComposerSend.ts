/**
 * Composer 发送分流（onSend）。
 *
 * 职责单一：把 onSend 的发送分流逻辑收口在此处。onSend 是 Composer 的主发送入口，
 * 优先级链：staging > landing（含 bash 检测）> bash(!/!!) > /compact > send。
 * 仅组合各 composable 提供的原语（staging / bash / restore / flow / chat），不持任何状态。
 *
 * 提取到 composable 以满足 Composer.vue <script setup> 行数上限（300 行）。
 * 行为与原 Composer.vue 内联实现完全等价，仅搬运不改逻辑。
 *
 * 不含：steer / followUp / abort（见 useComposerSubmit）/ 输入编辑（留 Composer.vue / 其他 composable）。
 */
import type { ComputedRef, Ref } from 'vue'
import type { Segment } from '@xyz-agent/shared'
import type { StagingAction, StagingConfig } from './staging-types'
import type { BashCommandExtract } from './useComposerBash'

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

interface ComposerSendDeps {
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
  /** 取 staging 模型/thinking 暂存配置（ADR-0043，仅 staging 活跃时调） */
  getStagingConfig: () => StagingConfig
  // ── 守卫 ──
  /** 是否可发送（hasInput && !isBusy）—— 非 staging 态发送守卫 */
  canSend: ComputedRef<boolean>
  /** 忙时（流式/派发/发送中/压缩中）—— staging 与普通发送共用守卫 */
  isBusy: ComputedRef<boolean>
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
  /** 发送中状态（普通 send / landing 首发期间置 true） */
  isSending: Ref<boolean>
  // ── landing 首发依赖 ──
  /** flow（submitFirstMessage —— landing 态首发提交） */
  flow: NewTaskFlowShape
  /** landing 态选定的思考等级（undefined = 用户未操作，用 runtime 默认） */
  localThinkingLevel: Ref<string | undefined>
  // ── 普通 send / compact ──
  /** 普通发送（useChat 提供） */
  send: (sessionId: string, segments: Segment[]) => Promise<void>
  /** 压缩上下文（useChat 提供） */
  compact: (sessionId: string, customInstructions?: string) => Promise<void>
  // ── 反馈 ──
  /** toast 错误（useToast 提供） */
  toastError: (msg: string) => void
  /** i18n 翻译（useI18n 提供） */
  t: (key: string, params?: Record<string, unknown>) => string
}

/**
 * @param deps staging / getStagingConfig / canSend / isBusy / draft / inputRef /
 *   sessionIdRef / variantRef / composerBash / clearInput / restoreSegments /
 *   isSending / flow / localThinkingLevel / send / compact / toastError / t
 *   （Composer.vue 内定义后注入）
 */
export function useComposerSend(deps: ComposerSendDeps): { onSend: () => Promise<void> } {
  /**
   * 发送分流（优先级）：staging > landing（含 bash 检测）> bash(!/!!) > /compact > send。
   * landing 与 active 两条路径合并：landing 走 submitFirstMessage，active 走 trySendBash / /compact / send。
   * 失败均 restoreSegments 回滚草稿（W8）。
   */
  async function onSend(): Promise<void> {
    // staging 活跃时由 StagingAction 自管 allowsEmptySend（handoff 允许空，fork 不允许）；
    // 忙时一律拦截（isBusy 复用 canSend 同守卫）。非 staging 走原 canSend 守卫。
    const activeStaging = deps.staging.activeStaging.value
    const canStagingSend = !!activeStaging && (activeStaging.allowsEmptySend || deps.canSend.value) && !deps.isBusy.value
    if (!deps.canSend.value && !canStagingSend) return
    const text = deps.draft.value
    // staging 路由：经 useComposerStaging.send → activeStaging.send。仅在有活跃 staging 时取 staging config
    // 透传（fork/handoff 内部 handleXxxSend 也自取 deps.getStagingConfig，传参与自取等价故实际被忽略）。
    // 守卫 hasActiveStaging：非 staging 态不调 getStagingConfig（避免测试 mock 未提供该方法时炸 + 语义清晰）。
    if (deps.staging.hasActiveStaging.value && await deps.staging.send(text, deps.getStagingConfig())) return
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
