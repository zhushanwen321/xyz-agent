/**
 * useProviderEdit —— Provider 编辑弹窗业务编排（F1 拆分自 ProviderEditModal.vue）。
 *
 * 承载原组件 3 个非展示职责：② test/discover（合并两套近似 try/catch 为 runDiscover）
 * ③ 模型清单 CRUD ④ save 持久化。凭据 form 也在此持有（组件模板 v-model 绑定）。
 * provider ref 变化时重置全部编辑态（原 watch(props.provider)）。
 *
 * 依赖方向：@xyz-agent/shared 类型 + @/api(config)，不依赖 store，与 useSettings 同层。
 */
import { ref, reactive, watch, type Ref } from 'vue'
import { config } from '@/api'
import type { ProviderInfo } from '@xyz-agent/shared'

// ── 类型 ──

/** 本地编辑态模型（ProviderInfo.models 的可编辑副本） */
export interface LocalModel {
  id: string
  name?: string
  reasoning?: boolean
  contextWindow?: number
  input?: Array<'text' | 'image'>
  thinkingLevelMap?: Record<string, string | null>
}

/** 思考策略预设 key（UI Select 值） */
export type ThinkingStrategy = 'all-levels' | 'on-off' | 'high-max'

// ── 常量 ──

/** 上下文窗口选项（template ctxOptions 来源） */
export const CONTEXT_OPTIONS = [
  { label: '128K', value: 128_000 },
  { label: '200K', value: 200_000 },
  { label: '256K', value: 256_000 },
  { label: '512K', value: 512_000 },
  { label: '1M', value: 1_000_000 },
] as const

/**
 * 思考策略预设 → thinkingLevelMap。thinkingLevelMap 语义：
 * - key = UI 可选档位（ThinkingLevel 枚举值，含 max），用于展示和判定可用
 * - value = 发给 runtime/pi 的实际 level（string=可用，null=不可用）
 * - 发给 pi 的是 value（如 max 档发 xhigh），不是 key——展示是展示，传递 value 是 value
 * 预设：all-levels(undefined=全档) / on-off(off+high) / high-max(off+high+max→xhigh)
 */
const THINKING_PRESETS: Record<ThinkingStrategy, Record<string, string | null> | undefined> = {
  'all-levels': undefined,
  'on-off': { off: 'off', high: 'high' },
  'high-max': { off: 'off', high: 'high', max: 'xhigh' },
}

/** 思考策略 Select 选项（template thinkingStrategies 来源） */
export const THINKING_STRATEGIES: Array<{ key: ThinkingStrategy; fullLabel: string }> = [
  { key: 'all-levels', fullLabel: 'All Levels' },
  { key: 'on-off', fullLabel: 'On / Off' },
  { key: 'high-max', fullLabel: 'High / Max' },
]

/** discover 动作：test（探活，结果显示连接成败）/ discover（合并发现的模型） */
type DiscoverAction = 'test' | 'discover'

// ── composable ──

/**
 * @param providerRef 当前编辑的 provider（null = 弹窗关闭）。变化时重置全部编辑态。
 */
export function useProviderEdit(providerRef: Ref<ProviderInfo | null>) {
  // ── 表单 / 列表状态 ──

  const form = reactive({ name: '', api: 'anthropic-messages', baseUrl: '', apiKey: '' })
  const newModel = reactive({
    name: '',
    contextWindow: 200_000,
    inputTypes: ['text'] as Array<'text' | 'image'>,
    thinking: 'on-off' as ThinkingStrategy,
  })
  const localModels = ref<LocalModel[]>([])

  // ── UI 状态（pending / 结果显示）──

  const showKey = ref(false)
  const testing = ref(false)
  const discovering = ref(false)
  /** test 结果：ok=连接成功 / error=失败 / null=未测 */
  const testResult = ref<'ok' | 'error' | null>(null)
  /** discover 结果文案（如「已发现 N 个模型，新增 M 个已合并」） */
  const discoverResult = ref('')
  const showAddModel = ref(false)
  const saving = ref(false)
  /** 动作错误（保存/测试/发现失败时显示在底栏，非静默吞） */
  const actionError = ref('')

  // ── provider 同步：打开/切换 provider 时重置编辑态 ──

  watch(
    providerRef,
    (p) => {
      if (p) {
        // 编辑模式：用现有 provider 数据填充表单
        form.name = p.name
        form.api = p.api ?? 'anthropic-messages'
        form.baseUrl = p.baseUrl ?? ''
        form.apiKey = ''
        showKey.value = false
        testResult.value = null
        discoverResult.value = ''
        showAddModel.value = false
        actionError.value = ''
        localModels.value = p.models.map((m) => ({ ...m }))
      } else {
        // 新增模式：重置为初始空状态（providerRef 变 null 时触发，避免残留上次编辑数据）
        form.name = ''
        form.api = 'anthropic-messages'
        form.baseUrl = ''
        form.apiKey = ''
        showKey.value = false
        testResult.value = null
        discoverResult.value = ''
        showAddModel.value = false
        actionError.value = ''
        localModels.value = []
      }
    },
  )

  // ── 纯函数 helpers（template 也直接调）──

  /**
   * 从 thinkingLevelMap 反推策略预设（Select 回显当前选中）。按可用档位 key 判定：
   * 含 max→high-max；含 high（无 max）→on-off；空→all-levels。
   */
  function getStrategyFromMap(map?: Record<string, string | null>): ThinkingStrategy {
    if (!map || Object.keys(map).length === 0) return 'all-levels'
    // 可用档位（key 存在且 value 非 null）
    const availableKeys = Object.keys(map).filter((k) => map[k] !== null)
    if (availableKeys.includes('max')) return 'high-max'
    if (availableKeys.includes('high')) return 'on-off'
    return 'all-levels'
  }

  // ── ② test/discover 编排（统一 runDiscover）──

  /**
   * 统一探活编排（testConnection 与 autoDiscover 共用，消除两套近似 try/catch）。
   * 都调 config.discoverModels（domain 无独立 testConnection，W08 决策），仅结果消费不同：
   * test 取 success→testResult(ok/error)；discover 成功则合并 res.models 到 localModels（去重）
   * + 设 discoverResult 文案，失败填 actionError。
   */
  async function runDiscover(action: DiscoverAction): Promise<void> {
    if (action === 'test') {
      testing.value = true
      testResult.value = null
    } else {
      discovering.value = true
      discoverResult.value = ''
    }
    actionError.value = ''

    try {
      const res = await config.discoverModels({
        baseUrl: form.baseUrl,
        apiKey: form.apiKey || undefined,
        providerType: form.api,
        providerId: providerRef.value?.id,
      })

      if (action === 'test') {
        testResult.value = res.success ? 'ok' : 'error'
        if (!res.success && res.error) actionError.value = res.error
        return
      }

      // discover：成功合并，失败显示错误
      if (res.success) {
        const existing = new Set(localModels.value.map((m) => m.id))
        const merged = res.models.filter((m) => !existing.has(m.id))
        localModels.value.push(
          ...merged.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
        )
        discoverResult.value = `已发现 ${res.models.length} 个模型，${merged.length > 0 ? `新增 ${merged.length} 个已合并` : '均已存在'}`
      } else {
        actionError.value = res.error ?? '发现失败'
      }
    } catch (e) {
      if (action === 'test') testResult.value = 'error'
      actionError.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (action === 'test') testing.value = false
      else discovering.value = false
    }
  }

  /** 测试连接（探活，复用 discoverModels，见 runDiscover 'test'） */
  async function testConnection(): Promise<void> {
    await runDiscover('test')
  }

  /** 自动发现模型（探活 + 合并到清单，见 runDiscover 'discover'） */
  async function autoDiscover(): Promise<void> {
    await runDiscover('discover')
  }

  // ── ④ save 持久化 ──

  /**
   * 保存：调 config.setProvider（新建用 providerId=form.name，编辑用原 id）。
   * 状态经 onProviders 订阅推回（单一数据源，避免竞态）。成功返回 true，调用方据此 emit close。
   */
  async function save(): Promise<boolean> {
    saving.value = true
    actionError.value = ''
    const providerId = providerRef.value?.id ?? form.name
    try {
      await config.setProvider(providerId, {
        name: form.name,
        type: form.api,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey || undefined,
        models: localModels.value.map((m) => ({
          id: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          input: m.input,
          thinkingLevelMap: m.thinkingLevelMap,
        })),
      })
      return true
    } catch (e) {
      actionError.value = e instanceof Error ? e.message : String(e)
      return false
    } finally {
      saving.value = false
    }
  }

  // ── ③ 模型清单 CRUD ──

  /** 行级输入类型 toggle（点击 text/image icon 切换） */
  function toggleInput(m: LocalModel, type: 'text' | 'image'): void {
    if (!m.input) m.input = []
    const idx = m.input.indexOf(type)
    if (idx >= 0) m.input.splice(idx, 1)
    else m.input.push(type)
  }

  /** 新增模型表单的输入类型 toggle（多选，与行级 toggleInput 同语义） */
  function toggleNewInput(type: 'text' | 'image'): void {
    const idx = newModel.inputTypes.indexOf(type)
    if (idx >= 0) newModel.inputTypes.splice(idx, 1)
    else newModel.inputTypes.push(type)
  }

  /** 行级上下文窗口更新（Select） */
  function updateCtx(m: LocalModel, value: number): void {
    m.contextWindow = value
  }

  /** 行级思考策略（Select → 写 thinkingLevelMap） */
  function pickStrategy(m: LocalModel, strategy: ThinkingStrategy): void {
    m.thinkingLevelMap = THINKING_PRESETS[strategy]
      ? structuredClone(THINKING_PRESETS[strategy])
      : undefined
  }

  /** 新增模型到清单（来自底部新增表单） */
  function addModel(): void {
    const name = newModel.name.trim()
    if (!name) return
    localModels.value.push({
      id: name,
      name,
      contextWindow: newModel.contextWindow,
      input: [...newModel.inputTypes],
      thinkingLevelMap: THINKING_PRESETS[newModel.thinking]
        ? structuredClone(THINKING_PRESETS[newModel.thinking])
        : undefined,
    })
    newModel.name = ''
  }

  /** 移除清单中指定下标的模型 */
  function removeModel(index: number): void {
    localModels.value.splice(index, 1)
  }

  return {
    // 状态（template 绑定）
    form,
    newModel,
    localModels,
    showKey,
    testing,
    discovering,
    testResult,
    discoverResult,
    showAddModel,
    saving,
    actionError,
    // 纯函数 helper
    getStrategyFromMap,
    // 编排
    testConnection,
    autoDiscover,
    save,
    // 模型 CRUD
    toggleInput,
    toggleNewInput,
    updateCtx,
    pickStrategy,
    addModel,
    removeModel,
  }
}
