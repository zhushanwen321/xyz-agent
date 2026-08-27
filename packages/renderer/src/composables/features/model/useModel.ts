/**
 * useModel —— 模型切换 + 思考等级设置编排（R2 features 层，跨 api + stores 的唯一合法层）。
 *
 * 这是「api 调用只在 features 层」铁律（ADR-0028）的落点：所有 model.switch /
 * session.setThinkingLevel RPC 调用 + sessionStore 更新的编排统一收口于此，
 * 上层（panel/useComposerModelThinking、features/useNewTaskFlow）不再直调 @/api。
 *
 * 两种态的统一处理：
 * - session 已建态：直接调 RPC + 更新 sessionStore.applySnapshot（modelId 乐观写
 *   （权威确认经 state_changed 广播回流）；thinkingLevel 写回执生效值（U6 弃乐观写，
 *   pi 钳制档位时回执 ≠ 请求值）——立即生效，不依赖广播到达——未发消息的 session
 *   可能无 streamSubscription，广播会丢）。
 * - landing 延迟态（useNewTaskFlow）：session 尚未 create，无法调 RPC。本 composable
 *   不处理 pending 记录（那是 useNewTaskFlow 的状态机职责），只暴露「session 已建后 apply」
 *   的能力，供 submitFirstMessage 在 create session 后调用，消除 useNewTaskFlow 与
 *   useComposerModelThinking 中重复的「RPC + 乐观更新」逻辑。
 *
 * 与 useThinkingLevelSync 的联动：模型切换的乐观更新按 sessionId 经 applySnapshot 写
 * sessionStore 对应 session 的 modelId，useThinkingLevelSync 的 watch(currentThinkingLevelMap)
 * 会在 modelId 变化后自动对齐思考等级（同体系直接映射 / 跨体系重置到最高可用档，经 onReset →
 * onThinkingSelect → setThinkingLevel 回到此 composable）。本 composable 只负责单次 RPC +
 * 乐观更新，不破坏该 watch 链。
 */
import { model as modelApi, session as sessionApi } from '@/api'
import type { ProviderId } from '@xyz-agent/shared'
import { useSessionStore } from '@/stores/session'

export function useModel() {
  const sessionStore = useSessionStore()

  /**
   * 切换 session 的模型：调 runtime model.switch RPC + 乐观更新 sessionStore。
   *
   * 乐观更新写入 "provider/modelId" 复合串（与 SessionSummary.modelId 同格式），
   * 按 sessionId 立即同步对应 session 的 modelId（Composer 工具条显示跟随），不依赖 state_changed 广播。
   *
   * 调用方职责区分：
   * - session 已建（Composer 工具条切换）：直传 sessionId + provider + modelId
   * - landing 延迟态：调用方记 pendingModel，create session 后调本方法 apply
   *
   * @param sessionId 目标 session id（须已 create）
   * @param provider 模型 provider id
   * @param modelId 模型 id（不含 provider 前缀）
   */
  async function switchModel(sessionId: string, provider: ProviderId, modelId: string): Promise<void> {
    await modelApi.switchModel(sessionId, provider, modelId)
    // 乐观更新：立即同步 active.modelId（复合串 "provider/modelId"；applySnapshot 单字段入参，
    // 权威确认经 session.state_changed 广播回流）
    sessionStore.applySnapshot(sessionId, {
      modelId: `${provider}/${modelId}`,
    })
  }

  /**
   * 设置 session 的思考等级：调 runtime session.setThinkingLevel RPC，以回执生效值写 store。
   *
   * level 是前端 6 级枚举字符串（off/low/medium/high/xhigh/max）。
   * 回执消费（U6 弃乐观写）：reply.level 是 pi 实际生效档（pi 会钳制模型族不支持的档位，
   * 如 mimo 族 max → high，钳制时不发事件不写 entry）——显示值从第一毫秒起就是真值，
   * 不存在「过一会自己变回去」（事故 B 根因 ③）。RPC 失败时不写 store（显示保持旧真值）。
   *
   * 调用方职责区分：
   * - session 已建（Composer 工具条切换档位）：直传 sessionId + level
   * - landing 延迟态：调用方记 localThinkingLevel，create session 后调本方法 apply
   *
   * @param sessionId 目标 session id（须已 create）
   * @param level 前端 6 级枚举字符串
   */
  async function setThinkingLevel(sessionId: string, level: string): Promise<void> {
    const reply = await sessionApi.setThinkingLevel(sessionId, level)
    sessionStore.applySnapshot(sessionId, { thinkingLevel: reply.level })
  }

  return { switchModel, setThinkingLevel }
}
