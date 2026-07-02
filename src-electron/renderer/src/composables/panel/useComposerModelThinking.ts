/**
 * Composer 工具条的模型 + 思考等级状态管理。
 *
 * 从 Composer.vue 拆出（script setup 行数合规）。职责：
 * - currentModelId：当前选中模型（session 已建读 active.modelId，landing 态读 flow 选定 → 全局默认）
 * - currentThinkingLevel：当前思考等级（session 已建读 active，landing 态用 localThinkingLevel）
 * - currentThinkingLevelMap：当前模型的思考档位映射 + 切模型自动重置（委托 useThinkingLevelSync）
 * - onModelSelect / onThinkingSelect：切换处理，session 已建走 RPC，landing 态延迟到首发提交后 apply
 *
 * landing 态（sessionId=null）session 尚未 create，无法调 model.switch / setThinkingLevel RPC。
 * 选定值记入 flow.pendingModel + localThinkingLevel，submitFirstMessage create session 后 apply。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useSettingsStore } from '@/stores/settings'
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { model as modelApi, session as sessionApi } from '@/api'
import { useThinkingLevelSync } from '@/composables/panel/useThinkingLevelSync'

export function useComposerModelThinking(
  sessionId: ComputedRef<string | null> | Ref<string | null>,
): {
  currentModelId: ComputedRef<string>
  currentThinkingLevel: ComputedRef<string | undefined>
  currentThinkingLevelMap: ComputedRef<Record<string, string | null> | undefined>
  localThinkingLevel: Ref<string | undefined>
  onModelSelect: (payload: { modelId: string; provider: string }) => Promise<void>
  onThinkingSelect: (level: string) => Promise<void>
} {
  const sessionStore = useSessionStore()
  const settingsStore = useSettingsStore()
  const flow = useNewTaskFlow()

  /**
   * landing 态本地思考等级（session 尚未 create，无 sessionStore.active.thinkingLevel）。
   * 切模型时由 useThinkingLevelSync 自动设为新模型最高可用档（value）；
   * submitFirstMessage create session 后 apply（setThinkingLevel）。
   */
  const localThinkingLevel = ref<string | undefined>(undefined)

  /** 当前思考等级：session 已建读 active.thinkingLevel，landing 态用 localThinkingLevel */
  const currentThinkingLevel = computed(
    () => sessionStore.active?.thinkingLevel ?? localThinkingLevel.value,
  )

  /**
   * 当前选中模型 id —— "provider/modelId" 复合串（与 SessionSummary.modelId / config.defaults 同格式）。
   * 优先取 active session 的 modelId（per-session 真值）；landing 态（无 active session）
   * 优先用 flow.currentModel（用户在 landing 选定的 pendingModel），再回退到全局默认模型
   * （settingsStore.defaultModel，经 config.defaults 订阅）。
   *
   * 用 || 而非 ??：session.list 广播里的已退出/磁盘 session 的 modelId 硬编码为 ''（空串），
   * ?? 不兜底空串（'' ?? fallback === ''），导致模型显示消失。|| 兜底空串到 defaultModel。
   */
  const currentModelId = computed(
    () => sessionStore.active?.modelId || flow.currentModel.value || settingsStore.defaultModel || '',
  )

  /** 当前模型的思考档位映射 + 切换模型后重置不可用等级（逻辑见 useThinkingLevelSync） */
  const currentThinkingLevelMap = useThinkingLevelSync(
    currentModelId,
    currentThinkingLevel,
    (level) => { void onThinkingSelect(level) },
  )

  /**
   * 模型切换：调 runtime model.switch（sessionId + provider + modelId）；
   * 成功后乐观更新 sessionStore（立即生效，不依赖 state_changed 广播到达——
   * 未发消息的 session 可能无 streamSubscription，广播会丢）。
   * landing 态（sid=null）session 尚未 create，记 pendingModel 供首发提交后 apply。
   */
  async function onModelSelect(payload: { modelId: string; provider: string }): Promise<void> {
    // landing 态延迟 create：记 pendingModel，submitFirstMessage create session 后 apply
    if (!sessionId.value) {
      flow.setPendingModel(`${payload.provider}/${payload.modelId}`)
      return
    }
    await modelApi.switchModel(sessionId.value, payload.provider, payload.modelId)
    // 乐观更新：立即同步 active.modelId（复合串 "provider/modelId"）
    sessionStore.updateSessionState(sessionId.value, {
      modelId: `${payload.provider}/${payload.modelId}`,
    })
  }

  /** 思考等级切换：session 已建调 runtime RPC，landing 态记 localThinkingLevel（submitFirstMessage 后 apply） */
  async function onThinkingSelect(level: string): Promise<void> {
    // landing 态延迟 create：记本地态，submitFirstMessage create session 后 apply
    if (!sessionId.value) {
      localThinkingLevel.value = level
      return
    }
    await sessionApi.setThinkingLevel(sessionId.value, level)
  }

  return {
    currentModelId,
    currentThinkingLevel,
    currentThinkingLevelMap,
    localThinkingLevel,
    onModelSelect,
    onThinkingSelect,
  }
}
