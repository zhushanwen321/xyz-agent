/**
 * Composer 工具条的模型 + 思考等级状态管理。
 *
 * 从 Composer.vue 拆出（script setup 行数合规）。职责：
 * - currentModelId：当前选中模型（session 已建读自身 sessionId 对应真值，landing 态读 flow 选定 → 全局默认）
 * - currentThinkingLevel：当前思考等级（session 已建读自身 sessionId 对应真值，landing 态用 localThinkingLevel）
 * - currentThinkingLevelMap：当前模型的思考档位映射 + 切模型自动重置（委托 useThinkingLevelSync）
 * - onModelSelect / onThinkingSelect：切换处理，session 已建走 RPC，landing 态延迟到首发提交后 apply
 * - Staging Mode（ADR-0056）：enter/exit 快照隔离 + getStagingConfig 导出暂存配置
 *
 * per-session 隔离：session 已建态按 sessionId 查真值（经 deps.getSessionState，非读全局 active），
 * split panel 下两个 Composer 各读各的 session 状态，不串读。底层数据已 per-session
 * （SessionSummary.modelId/thinkingLevel + applySnapshot(id,...)），此处只接对数据源。
 *
 * landing 态（sessionId=null）session 尚未 create，无法调 model.switch / setThinkingLevel RPC。
 * 选定值记入 pendingModel + localThinkingLevel，submitFirstMessage create session 后 apply。
 *
 * Staging Mode（ADR-0056）：composer 进入 fork-ask/handoff-ask 暂存态时，模型/thinking chip
 * 切换只写暂存快照（不影响当前源 session）。退出暂存态时清空快照，chip 恢复读常规态真值。
 * 发送时 getStagingConfig() 导出暂存配置，透传给 fork/handoff RPC 供新 session 使用。
 *
 * [W3 迁移] 迁自 renderer composables/panel/useComposerModelThinking.ts。改动：
 * - 去掉 renderer 跨域依赖（useSessionStore/useSettingsStore/useNewTaskFlow/useModel 4 个），
 *   改为经 deps 回调注入（getSessionState/defaultModel/currentModel/setPendingModel/switchModel/
 *   setThinkingLevel），core 零 store 依赖。
 * - thinking-level-sync 委托：原内部读 settingsStore.providers，现 core 已有 useThinkingLevelSync(...,deps)
 *   接收 getThinkingLevelMap。deps 加第 7 字段 getThinkingLevelMap 透传给 sync。
 * - import 路径 `@/composables/panel/useThinkingLevelSync` → core 本域 `./thinking-level-sync`（batch2 已迁入）。
 * 函数签名 / 逻辑 byte-level 保持。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { ProviderId } from '@xyz-agent/shared'
import { useThinkingLevelSync } from './thinking-level-sync'

/** useComposerModelThinking 的注入依赖（壳层 Composer 从各 store/composable 派生后注入）。 */
export interface ModelThinkingDeps {
  /** 按 sessionId 查 session 真值（per-session 隔离核心：壳层从 sessionStore.list.find 派生） */
  getSessionState: (sessionId: string) => { modelId: string; thinkingLevel?: string } | null
  /** 全局默认模型（壳层从 settingsStore.defaultModel 派生，响应式：landing 按钮需在 store 异步填充后更新） */
  defaultModel: ComputedRef<string>
  /** landing 态 flow 选定模型（壳层从 useNewTaskFlow().currentModel 取） */
  currentModel: ComputedRef<string | null>
  /** landing 态记 pendingModel（壳层从 useNewTaskFlow().setPendingModel 取） */
  setPendingModel: (model: string) => void
  /** 已建态切模型 RPC + 乐观更新编排（壳层从 useModel().switchModel 取） */
  switchModel: (sessionId: string, provider: ProviderId, modelId: string) => Promise<void>
  /** 已建态设思考等级 RPC + 乐观更新（壳层从 useModel().setThinkingLevel 取） */
  setThinkingLevel: (sessionId: string, level: string) => Promise<void>
  /** 按 modelId 派生 thinkingLevelMap（透传给 useThinkingLevelSync，壳层从 settingsStore.providers 解析） */
  getThinkingLevelMap: (modelId: string) => Record<string, string | null> | undefined
}

export function useComposerModelThinking(
  sessionId: ComputedRef<string | null> | Ref<string | null>,
  deps: ModelThinkingDeps,
): {
  currentModelId: ComputedRef<string>
  currentThinkingLevel: ComputedRef<string | undefined>
  currentThinkingLevelMap: ComputedRef<Record<string, string | null> | undefined>
  localThinkingLevel: Ref<string | undefined>
  onModelSelect: (payload: { modelId: string; provider: ProviderId }) => Promise<void>
  onThinkingSelect: (level: string) => Promise<void>
  /** Staging Mode：进入暂存态（快照当前模型/thinking） */
  enterStagingMode: () => void
  /** Staging Mode：退出暂存态（清空快照，恢复常规态） */
  exitStagingMode: () => void
  /** Staging Mode：获取暂存配置（供 fork/handoff 发送时透传给新 session） */
  getStagingConfig: () => { modelOverride?: string; thinkingOverride?: string }
} {
  const {
    getSessionState,
    defaultModel,
    currentModel,
    setPendingModel,
    switchModel,
    setThinkingLevel: applyThinkingLevel,
    getThinkingLevelMap,
  } = deps

  /**
   * landing 态本地思考等级（session 尚未 create，无 session 真值）。
   * 切模型时由 useThinkingLevelSync 自动设为新模型最高可用档（value）；
   * submitFirstMessage create session 后 apply（setThinkingLevel）。
   */
  const localThinkingLevel = ref<string | undefined>(undefined)

  // ── Staging Mode（ADR-0056）────────────────────────────────────
  /**
   * 暂存快照：进入 fork-ask/handoff-ask 时快照当前模型/thinking。
   * null = 常规态（读 session/landing 真值）；非 null = 暂存态（读快照值）。
   * 退出暂存态时清空（null），chip 自动恢复读常规态真值。
   */
  const stagingModel = ref<string | null>(null)
  const stagingThinking = ref<string | undefined>(undefined)

  /**
   * 按 sessionId 查 session 真值（per-session 隔离的核心）。
   * session 已建态经 deps.getSessionState 按 id 查（非读全局 active——active 是单焦点，
   * split 下非聚焦 panel 会串读）；landing 态（sessionId=null）返回 null，走 landing 分支。
   */
  const sessionState = computed(() =>
    sessionId.value ? getSessionState(sessionId.value) ?? null : null,
  )

  /** 常规态思考等级（不受 staging 影响，供 enterStagingMode 快照读取） */
  const regularThinkingLevel = computed(
    () => sessionState.value?.thinkingLevel ?? localThinkingLevel.value,
  )

  /**
   * 常规态模型 id（不受 staging 影响，供 enterStagingMode 快照读取）。
   * 用 || 而非 ??：session.list 广播里的已退出/磁盘 session 的 modelId 硬编码为 ''（空串）。
   */
  const regularModelId = computed(
    () => sessionState.value?.modelId || currentModel.value || defaultModel.value || '',
  )

  /** 当前思考等级：staging 活跃时读快照，否则读常规态真值 */
  const currentThinkingLevel = computed(
    () => stagingModel.value !== null
      ? stagingThinking.value
      : regularThinkingLevel.value,
  )

  /**
   * 当前选中模型 id（"provider/modelId" 复合串）。
   * staging 活跃时读暂存快照，否则读常规态真值（session > landing pendingModel > 全局默认）。
   */
  const currentModelId = computed(
    () => stagingModel.value !== null
      ? stagingModel.value
      : regularModelId.value,
  )

  /** 当前模型的思考档位映射 + 切换模型后重置不可用等级（逻辑见 useThinkingLevelSync） */
  const currentThinkingLevelMap = useThinkingLevelSync(
    currentModelId,
    currentThinkingLevel,
    (level) => { void onThinkingSelect(level) },
    { getThinkingLevelMap },
  )

  /**
   * 模型切换：staging 活跃时只写快照（不调 RPC，不改源 session）。
   * session 已建走 deps 注入的编排（RPC + 乐观更新）；
   * landing 态（sid=null）session 尚未 create，记 pendingModel 供首发提交后 apply。
   */
  async function onModelSelect(payload: { modelId: string; provider: ProviderId }): Promise<void> {
    // Staging Mode：只写暂存快照，不影响当前源 session
    if (stagingModel.value !== null) {
      stagingModel.value = `${payload.provider}/${payload.modelId}`
      return
    }
    // landing 态延迟 create：记 pendingModel，submitFirstMessage create session 后 apply
    if (!sessionId.value) {
      setPendingModel(`${payload.provider}/${payload.modelId}`)
      return
    }
    // 已建态：RPC + 乐观更新（编排逻辑归壳层 useModel，ADR-0028）
    await switchModel(sessionId.value, payload.provider, payload.modelId)
  }

  /** 思考等级切换：staging 活跃时只写快照；session 已建走 RPC，landing 态记 localThinkingLevel */
  async function onThinkingSelect(level: string): Promise<void> {
    // Staging Mode：只写暂存快照
    if (stagingModel.value !== null) {
      stagingThinking.value = level
      return
    }
    // landing 态延迟 create：记本地态，submitFirstMessage create session 后 apply
    if (!sessionId.value) {
      localThinkingLevel.value = level
      return
    }
    // 已建态：RPC + 乐观更新（编排逻辑归壳层 useModel，ADR-0028）
    await applyThinkingLevel(sessionId.value, level)
  }

  /**
   * Staging Mode：进入暂存态。
   * 快照当前 currentModelId + currentThinkingLevel 到 staging refs。
   * 之后 chip 切换只改 staging 值，不影响源 session。
   */
  function enterStagingMode(): void {
    stagingModel.value = currentModelId.value
    stagingThinking.value = currentThinkingLevel.value
  }

  /**
   * Staging Mode：退出暂存态。
   * 清空 staging refs，chip 自动恢复读常规态真值（源 session 的模型）。
   */
  function exitStagingMode(): void {
    stagingModel.value = null
    stagingThinking.value = undefined
  }

  /**
   * Staging Mode：获取暂存配置（供 fork/handoff 发送时透传给新 session）。
   * 返回 undefined 字段不传（runtime 走默认/preset 兜底）。
   */
  function getStagingConfig(): { modelOverride?: string; thinkingOverride?: string } {
    if (stagingModel.value === null) return {}
    return {
      ...(stagingModel.value ? { modelOverride: stagingModel.value } : {}),
      ...(stagingThinking.value ? { thinkingOverride: stagingThinking.value } : {}),
    }
  }

  return {
    currentModelId,
    currentThinkingLevel,
    currentThinkingLevelMap,
    localThinkingLevel,
    onModelSelect,
    onThinkingSelect,
    enterStagingMode,
    exitStagingMode,
    getStagingConfig,
  }
}
