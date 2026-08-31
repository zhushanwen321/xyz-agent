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
 *
 * [u3 记忆恢复]（设计 model-thinking-level-memory.md D2/D3，记忆表 = ./model-thinking-memory）：
 * - armed 意图持有与设立：onModelSelect 三分支各设 {modelId, at, callId}；已建态走 try/catch——
 *   失败清/成功清均按 callId 归属校验（规则 4/5）；换绑 watch 清（规则 6，注册先于 sync watch）
 * - in-flight 按 callId 引用计数：规则 1 过期判定的豁免数据源（E10），finally 撤销晚于 flush
 * - 记录 watch（D2 双条件门禁）：已建态生效档位 → 反查 UI key → 可用性校验 → record 写穿
 * - landing memory-aware：localAuthored + 跟随 watch（immediate + 变化触发，双路径）
 * - 对外 API 不变（u4 壳层解构面零变化）；记忆模块为 core 域内单例，直接 import（非 deps 注入）
 */
import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { ProviderId } from '@xyz-agent/shared'
import { useThinkingLevelSync } from './thinking-level-sync'
import {
  normalizeSupportedLevels,
  highestAvailableLevel,
  resolveThinkingKey,
  resolveThinkingValue,
} from './thinking-levels'
import { loadOnce, lookup, onLoaded, record } from './model-thinking-memory'

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
  /**
   * 按 modelId 派生档位可用集（ProviderInfo.models[].supportedLevels，U6 切源——runtime
   * 能力注册表 pi 同源计算的 view-ready 下发，renderer 零推导）。non-reasoning 模型该集
   * 为 ['off']；undefined = 下发链路未接通（归一为默认五档）。
   */
  getSupportedLevels: (modelId: string) => string[] | undefined
}

export function useComposerModelThinking(
  sessionId: ComputedRef<string | null> | Ref<string | null>,
  deps: ModelThinkingDeps,
): {
  currentModelId: ComputedRef<string>
  currentThinkingLevel: ComputedRef<string | undefined>
  currentThinkingLevelMap: ComputedRef<Record<string, string | null> | undefined>
  /** 当前模型档位可用集（supportedLevels，U6 切源；下发未接通时 undefined → 归一默认五档） */
  currentSupportedLevels: ComputedRef<string[] | undefined>
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
    getSupportedLevels,
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

  // ── [u3 记忆恢复] armed 切模型意图 + in-flight 计数（设计 D3）────────────
  /**
   * armed 完整结构（D3）：消费侧只读切片 {modelId, at} 已由 u2 的 ArmedModelSwitchIntent
   * 定义，本结构多一个 callId 供规则 4/5 的归属校验（结构化兼容该切片，无需显式实现）。
   * 每次显式选模型自增唯一 callId——并发连切时后一次调用覆盖 armed（所有权转移），
   * 先回包的调用只允许操作自己设立的 token。
   */
  interface ArmedIntent {
    modelId: string
    at: number
    callId: number
  }

  const armed = ref<ArmedIntent | null>(null)
  let armedCallIdSeq = 0

  /**
   * in-flight switchModel 按 callId 引用计数（Set，非 reactive——消费侧经闭包同步读，
   * 无 watch 依赖）。规则 1 过期判定的豁免数据源：finally 撤销自己份额必然晚于
   * watch flush（D3 证据②），慢 RPC 回包触发的消费落在计数仍 >0 的豁免窗内（E10）。
   */
  const inFlightCallIds = new Set<number>()

  /**
   * [u3·D2] landing 档位 authored 标志：用户显式选档（onThinkingSelect）置位后，
   * landing 跟随 watch 永久失效——用户选过的值不该被记忆/默认档改写。
   * sync onReset 的自动对齐走内部路由（routeThinkingLevel）不置位——自动对齐值
   * 不是用户 authored（D2 拆分入口的原因，见 routeThinkingLevel 注释）。
   */
  const localAuthored = ref(false)

  /**
   * [u3·D3 规则 6「换绑清」] panel 换绑 session 瞬间清 armed——无论 callId 归属：
   * 切模型意图绑定发起时的 session，换绑即作废全部未消费意图。
   * 必须注册在 useThinkingLevelSync 的 sync watch 之前：同一 flush 内 watch job 按
   * 注册序执行，若消费检查先跑，换绑到恰为 armed 目标模型的 session 会在作废前被
   * 消费（伪恢复，D3 被否①的换绑变体）。
   */
  watch(sessionId, () => {
    armed.value = null
  })

  /**
   * 规则 4/5 专用清（callId 归属校验）：只清自己设立的 token——arm 后被后续调用
   * 覆盖时所有权已转移，先回包调用禁清后来者的（D3 callId 归属校验）。
   */
  function clearArmedIfOwner(callId: number): void {
    if (armed.value?.callId === callId) armed.value = null
  }

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
    // [u3·D2] 自动对齐走内部路由（routeThinkingLevel）而非用户入口 onThinkingSelect——
    // 经用户入口会置位 localAuthored，landing 跟随被 auto 值冻结（D2 拆分入口的原因）
    (level) => { void routeThinkingLevel(level) },
    {
      getThinkingLevelMap,
      getSupportedLevels,
      // [u3·D3] armed 意图 + in-flight 计数 + 记忆查询接入消费侧（u2 契约，配对闭环）
      getRememberedLevel: lookup,
      getArmed: () => armed.value,
      clearArmed: () => { armed.value = null },
      getInFlightCount: () => inFlightCallIds.size,
    },
  )

  /** 当前模型档位可用集（供 popover 判定可用档，U6 切 supportedLevels） */
  const currentSupportedLevels = computed(() => getSupportedLevels(currentModelId.value))

  // ── [u3·D2] landing memory-aware：跟随 watch + 预载触发 + E7② 补写 ──────────
  /**
   * landing 未 authored 的 local 档位跟随模型重设：memory[当前模型] ?? 最高可用档（value 形态，
   * localThinkingLevel 存 value——§2.2 关键事实①）。
   * 为什么需要：landing 挂载时 sync watch 的「无档位」分支会自动设最高可用档，该 auto 值经
   * 首发透传（send → flow apply）会以「用户从未选择」的身份进入已建态记录 watch——纯态轴
   * 门禁挡不住它（D2 被否③：判别轴错位，污染只是从挂载时点换到首发时点）。跟随重设让
   * auto 值本身 memory-aware，污染在源头消灭；顺带让新任务默认档贴合用户习惯（G1 延伸）。
   */
  function followRememberedOrDefault(): void {
    if (sessionId.value || localAuthored.value) return
    const key =
      lookup(currentModelId.value) ??
      highestAvailableLevel(getSupportedLevels(currentModelId.value))
    localThinkingLevel.value = resolveThinkingValue(key, getThinkingLevelMap(currentModelId.value))
  }

  /**
   * 跟随 watch：{ immediate: true } 且模型变化触发，双路径缺一即间歇性缺陷（D2 被否⑤教训）——
   * immediate 覆盖 defaultModel 早到（挂载时模型已就绪且后续不变，非 immediate 永不触发，
   * auto 值透传覆写 memory）；变化触发覆盖晚到（'' → 真实模型）。
   * 仅 landing 态生效：已建 session 初值保持现状（最高档），记忆表绝不主动触碰已建 session（G3）。
   */
  watch(currentModelId, followRememberedOrDefault, { immediate: true })

  // [u3·E7②] KV 惰性预载 fire-and-forget 触发（首个消费方组装点）。加载完成前 lookup
  // 恒 undefined，跟随/恢复自然回落最高档/现有规则（E7①）；加载完成回调补一次跟随重设，
  // 消灭「landing 在毫秒级窗口内不碰档位直接发送」才会踩中的 auto 值覆写窗口。
  loadOnce()
  let disposed = false
  onLoaded(() => {
    // split panel 实例可能在预载完成前被销毁——死实例的 localThinkingLevel 不再写
    if (!disposed) followRememberedOrDefault()
  })
  onScopeDispose(() => {
    disposed = true
  })

  /**
   * [u3·D2] 记录 watch：把「已建 session 生效档位」写入记忆表。
   * 条件 b（来源语义）：值最终生效于已建 session 即记录，不区分是否用户手动——含手动选档、
   * 切模型自动对齐、session 加载既有状态（immediate 覆盖最后一种，mount 即记录载入值）。
   * 条件 a（态轴）：landing 悬空值（sessionId 空）与 staging 试选值（stagingModel 非空——
   * fork/handoff 暂存取消时不该入表）不入表；其生效时点（新 session 建立）必进已建态由门禁补上。
   */
  watch(
    [currentModelId, currentThinkingLevel],
    ([modelId, level]) => {
      if (!sessionId.value || stagingModel.value !== null) return
      if (!level) return
      // 记录的是 UI key（D1：跨模型恢复的语义是档位名而非实现值）——value 经当前模型 map 反查
      const uiKey = resolveThinkingKey(level, getThinkingLevelMap(modelId))
      // 可用性校验（E5 防线）：体系外脏值（transient 窗口值/异常快照）不入表
      if (!normalizeSupportedLevels(getSupportedLevels(modelId)).includes(uiKey)) return
      record(modelId, uiKey)
    },
    { immediate: true },
  )

  /**
   * 模型切换：staging 活跃时只写快照（不调 RPC，不改源 session）。
   * session 已建走 deps 注入的编排（RPC + 乐观更新）；
   * landing 态（sid=null）session 尚未 create，记 pendingModel 供首发提交后 apply。
   *
   * [u3·D3] 三分支各设 armed 意图（{modelId, at, callId}）：恢复只挂在显式切模型上，
   * 消费点在 sync watch 回调顶部（u2 规则 1/2/3）；本函数只负责设立与生命周期防线
   * （规则 4 失败清 / 规则 5 成功清 / 规则 6 换绑清见上方 watch）。
   */
  async function onModelSelect(payload: { modelId: string; provider: ProviderId }): Promise<void> {
    const callId = ++armedCallIdSeq
    const targetModelId = `${payload.provider}/${payload.modelId}`
    // Staging Mode：只写暂存快照，不影响当前源 session
    if (stagingModel.value !== null) {
      stagingModel.value = targetModelId
      // armed 同步设立（staging 分支）：恢复经同一 onReset 通路写入暂存快照（B5——暂存态
      // 恢复不另设通路）；无 RPC，token 由消费侧规则 2 或后续显式动作处置
      armed.value = { modelId: targetModelId, at: Date.now(), callId }
      return
    }
    // landing 态延迟 create：记 pendingModel，submitFirstMessage create session 后 apply
    if (!sessionId.value) {
      setPendingModel(targetModelId)
      armed.value = { modelId: targetModelId, at: Date.now(), callId }
      return
    }
    // 已建态：RPC + 乐观更新（编排逻辑归壳层 useModel，ADR-0028）
    armed.value = { modelId: targetModelId, at: Date.now(), callId }
    inFlightCallIds.add(callId)
    try {
      await switchModel(sessionId.value, payload.provider, payload.modelId)
      // [u3·D3 规则 5「成功清」] 时序依据（D3 证据②）：applySnapshot 在 switchModel 内同步
      // 执行，watch flush 微任务于 applySnapshot 时刻入队，本 await 续段晚于 flush——
      // watch 回调总是先跑。故此处只对「回调未能消费」的残留 token 生效（pi 静默换模 /
      // re-select 同模型），清除后陈旧 token 不再被后续无关触发延迟消费（chip 突跳伪恢复）。
      clearArmedIfOwner(callId)
    } catch (err) {
      // [u3·D3 规则 4「失败清」/ E4] RPC 失败 store 不写（U6 现状语义），armed 立即清除
      // 自己 callId 的——失败 token 残留会被后续换绑到同模型 session 误消费（D3 被否②(a)）。
      // 重抛维持调用方既有失败路径不变。
      clearArmedIfOwner(callId)
      throw err
    } finally {
      // [u3·E10] in-flight 撤销必须留在 finally（晚于 flush）：回包触发的 watch 消费发生在
      // 计数仍 >0 的豁免窗内，规则 1 不误杀慢 RPC（>5s 回包仍正常匹配消费）
      inFlightCallIds.delete(callId)
    }
  }

  /**
   * 思考等级切换（用户显式入口）：置 localAuthored——用户选过之后 landing 跟随永久失效
   * （D2），随后与自动对齐同构路由。
   */
  async function onThinkingSelect(level: string): Promise<void> {
    localAuthored.value = true
    await routeThinkingLevel(level)
  }

  /**
   * 思考等级路由（三分支，原 onThinkingSelect 主体）。
   * [u3·D2] sync onReset 的自动对齐走本函数而非用户入口：自动对齐值不是用户 authored，
   * 不得置位 localAuthored 冻结 landing 跟随（否则 landing auto 初值经 sync 设置后跟随
   * 即失效，memory-aware 初值落空——D2 拆分入口的原因）。
   */
  async function routeThinkingLevel(level: string): Promise<void> {
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
    currentSupportedLevels,
    localThinkingLevel,
    onModelSelect,
    onThinkingSelect,
    enterStagingMode,
    exitStagingMode,
    getStagingConfig,
  }
}
