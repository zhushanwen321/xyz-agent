/**
 * useProviderEdit —— Provider 编辑弹窗业务编排（F1 拆分自 ProviderEditModal.vue）。
 *
 * 承载原组件 3 个非展示职责：② test/discover（合并两套近似 try/catch 为 runDiscover）
 * ③ 模型清单 CRUD ④ save 持久化。凭据 form 也在此持有（组件模板 v-model 绑定）。
 * provider ref 变化时重置全部编辑态（原 watch(props.provider)）。
 *
 * 依赖方向：@xyz-agent/shared 类型 + @/api(config) + @/stores/settings（D8 过期快照 watch）。
 */
import { ref, reactive, watch, computed, type Ref } from 'vue'
import { config } from '@/api'
import { useSettingsStore } from '@/stores/settings'
import type { ProviderInfo } from '@xyz-agent/shared'
import i18n from '@/i18n'

const t = i18n.global.t

// ── 类型 ──

/** 本地编辑态模型（ProviderInfo.models 的可编辑副本）。
 *  含 api/baseUrl/enabled 透传位（与 ProviderInfo.models 元素同构，W4）：
 *  编辑保存时这些字段必须回传，否则 model 级配置会在 setProvider 合并时被丢弃。 */
export interface LocalModel {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  reasoning?: boolean
  contextWindow?: number
  input?: Array<'text' | 'image'>
  thinkingLevelMap?: Record<string, string | null>
  /** model 级启停透传（省略时 runtime 默认 true） */
  enabled?: boolean
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

/** 思考策略 Select 选项（template thinkingStrategies 来源）。
 *  fullLabel 保留为回退展示（向后兼容旧 import）；新代码优先用 labelKey + t()。 */
export const THINKING_STRATEGIES: Array<{
  key: ThinkingStrategy
  fullLabel: string
  labelKey: string
}> = [
  { key: 'all-levels', fullLabel: 'All Levels', labelKey: 'composable.thinkingStrategy.allLevels' },
  { key: 'on-off', fullLabel: 'On / Off', labelKey: 'composable.thinkingStrategy.onOff' },
  { key: 'high-max', fullLabel: 'High / Max', labelKey: 'composable.thinkingStrategy.highMax' },
]

/** discover 动作：test（探活，结果显示连接成败）/ discover（合并发现的模型） */
type DiscoverAction = 'test' | 'discover'

/**
 * apiKey「清除」哨兵值（D18）。
 * 表单内 form.apiKey 默认 ''=不变（save 时 `apiKey || undefined` 跳过）。
 * 用户点「清除」时把 form.apiKey 置为此哨兵，save 识别后发送空串给 runtime
 * （config-service `if (data.apiKey !== undefined) merged.apiKey = data.apiKey`，空串=清空 key）。
 */
export const API_KEY_CLEAR_SENTINEL = '__CLEAR__'

/**
 * 计算 save 时实际发送的 apiKey（D18）。
 * - 哨兵 → ''（清空已配置的 key）
 * - 空 → undefined（保持不变）
 * - 非空 → 原值
 */
function resolveApiKeyForSave(apiKey: string): string | undefined {
  if (apiKey === API_KEY_CLEAR_SENTINEL) return ''
  return apiKey || undefined
}

// ── 纯函数 helpers（模块级，不计入 composable 行数）──

/** 从 headerRows 构建 headers Record + 重复 key 检测（syncHeadersFromRows 提取） */
function buildHeadersFromRows(
  rows: Array<{ key: string; value: string }>,
): { headers: Record<string, string>; hasDuplicate: boolean } {
  const headers: Record<string, string> = {}
  const seen = new Set<string>()
  let hasDuplicate = false
  for (const r of rows) {
    const k = r.key.trim()
    if (!k) continue
    if (seen.has(k)) hasDuplicate = true
    seen.add(k)
    headers[k] = r.value
  }
  return { headers, hasDuplicate }
}

// ── composable ──

/**
 * @param providerRef 当前编辑的 provider（null = 弹窗关闭）。变化时重置全部编辑态。
 */
export function useProviderEdit(providerRef: Ref<ProviderInfo | null>) {
  // ── 表单 / 列表状态 ──

  /** form.headers/authHeader（D7）：provider 级自定义请求头 + 是否把 apiKey 写入 Authorization。
   *  headers 用 Record 形态（save 时回写 setProvider），UI 通过 headerRows 行编辑驱动。 */
  const form = reactive({
    name: '',
    api: 'anthropic-messages',
    baseUrl: '',
    apiKey: '',
    headers: {} as Record<string, string>,
    authHeader: false,
  })
  const newModel = reactive({
    name: '',
    contextWindow: 200_000,
    inputTypes: ['text'] as Array<'text' | 'image'>,
    thinking: 'on-off' as ThinkingStrategy,
  })
  const localModels = ref<LocalModel[]>([])

  /**
   * headers 行编辑态（D7）：每行一对 key/value，UI 双向绑定。
   * 与 form.headers 双向同步：headerRows 改 → 同步回 form.headers（save 用）；
   * provider 加载时从 p.headers 初始化 headerRows。
   */
  const headerRows = ref<Array<{ key: string; value: string }>>([])

  /**
   * 把 headers Record 转成行数组（W3 D7）。
   * headers 是已知 schema 的 Record<string,string>（非任意用户输入），故直接 entries。
   */
  function rowsFromHeaders(headers: Record<string, string>): Array<{ key: string; value: string }> {
    // eslint-disable-next-line taste/no-unsafe-object-entries -- headers is a known schema Record<string,string>
    return Object.entries(headers).map(([k, v]) => ({ key: k, value: v }))
  }

  /**
   * 打开时的初始快照（用于 isDirty 对比，D13 取消确认）。
   * 每次 provider 变化重置编辑态后记录；手动改 form/localModels 后 isDirty=true。
   * 快照基础字段（name/api/baseUrl/authHeader）+ apiKey 状态（是否清空）+ models 的 id 列表
   * + headers（W3 D7：headers 改也算 dirty）。
   */
  interface FormSnapshot {
    name: string
    api: string
    baseUrl: string
    /** apiKey 是否被「清除」（哨兵态或用户输入了值都算 dirty） */
    apiKeyChanged: boolean
    /** models 的 id 列表（顺序无关，按集合对比增删） */
    modelIds: string[]
    /** provider 级 authHeader（W3 D7） */
    authHeader: boolean
    /** provider 级 headers 序列化（W3 D7：JSON 串对比，键值任一变更即 dirty） */
    headersJson: string
  }
  const snapshot = ref<FormSnapshot | null>(null)

  /** 记录当前 form/localModels 为初始快照（provider 切换/打开后调） */
  function captureSnapshot(): void {
    snapshot.value = {
      name: form.name,
      api: form.api,
      baseUrl: form.baseUrl,
      apiKeyChanged: form.apiKey !== '',
      modelIds: localModels.value.map((m) => m.id),
      authHeader: form.authHeader,
      headersJson: JSON.stringify(form.headers),
    }
  }

  /**
   * form 相对初始快照是否有变更（D13 取消确认 + W3 过期快照刷新用）。
   * 对比 name/api/baseUrl/apiKey 状态/models 的 id 集合/authHeader/headers。snapshot=null（未初始化）→ false。
   */
  const isDirty = computed<boolean>(() => {
    const s = snapshot.value
    if (!s) return false
    if (form.name !== s.name) return true
    if (form.api !== s.api) return true
    if (form.baseUrl !== s.baseUrl) return true
    // apiKey：用户输入了值 或 点了清除（哨兵）都算变更
    const apiKeyChangedNow = form.apiKey !== ''
    if (apiKeyChangedNow !== s.apiKeyChanged) return true
    // models id 集合对比（增删即 dirty；内部字段改不算——按 id 对比足够覆盖取消确认场景）
    const currentIds = new Set(localModels.value.map((m) => m.id))
    if (currentIds.size !== s.modelIds.length) return true
    for (const id of s.modelIds) {
      if (!currentIds.has(id)) return true
    }
    // W3 D7：authHeader / headers 变更即 dirty
    if (form.authHeader !== s.authHeader) return true
    if (JSON.stringify(form.headers) !== s.headersJson) return true
    return false
  })

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
    () => providerRef.value,
    (p) => {
      if (p) {
        // 编辑模式：用现有 provider 数据填充表单
        form.name = p.name
        form.api = p.api ?? 'anthropic-messages'
        form.baseUrl = p.baseUrl ?? ''
        form.apiKey = ''
        // W3 D7：回填 headers / authHeader
        form.headers = p.headers ? { ...p.headers } : {}
        form.authHeader = p.authHeader ?? false
        headerRows.value = rowsFromHeaders(form.headers)
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
        form.headers = {}
        form.authHeader = false
        headerRows.value = []
        showKey.value = false
        testResult.value = null
        discoverResult.value = ''
        showAddModel.value = false
        actionError.value = ''
        localModels.value = []
      }
      // 记录初始快照（isDirty 对比基线）。重置后立即捕获，确保用户首次输入才变 dirty。
      captureSnapshot()
    },
    { immediate: true },
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

  // ── ② test/discover 编排（统一 runDiscover：testConnection 与 autoDiscover 共用）──

  /** 统一探活（config.discoverModels）：test 取 success→testResult；discover 合并 models + discoverResult */
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
        discoverResult.value = t('composable.discoveredModels', { count: res.models.length, merged: merged.length > 0 ? t('composable.newMerged', { count: merged.length }) : t('composable.allExisted') })
      } else {
        actionError.value = res.error ?? t('composable.discoverFailed')
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

  // ── ④ save 持久化（校验 → config.setProvider；D15b：name 空返回 false）──

  /** 保存：校验 → config.setProvider，成功返回 true，调用方据此 emit close。 */
  async function save(): Promise<boolean> {
    // 前端校验（D15b）：供应商名称必填
    if (!form.name.trim()) {
      actionError.value = t('composable.providerNameRequired')
      return false
    }
    saving.value = true
    actionError.value = ''
    const providerId = providerRef.value?.id ?? form.name
    try {
      await config.setProvider(providerId, {
        name: form.name,
        type: form.api,
        baseUrl: form.baseUrl,
        // D18：apiKey 空=不变（undefined）；哨兵=清空（''）；非空=原值
        apiKey: resolveApiKeyForSave(form.apiKey),
        // W3 D7：headers（空对象时不传，避免覆盖 runtime 既有值）+ authHeader 回写。
        headers: Object.keys(form.headers).length > 0 ? form.headers : undefined,
        authHeader: form.authHeader,
        // 透传 model 级 api/baseUrl/enabled：runtime setProvider 用 spread 合并 base，
        // 缺字段会被 base 兜底，但显式回传避免「编辑保存丢字段」（P1 bug #4/#5）。
        models: localModels.value.map((m) => ({
          id: m.id,
          name: m.name,
          api: m.api,
          baseUrl: m.baseUrl,
          contextWindow: m.contextWindow,
          input: m.input,
          thinkingLevelMap: m.thinkingLevelMap,
          enabled: m.enabled,
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

  /** 清除 apiKey（D18）：置哨兵，save 时识别为清空。仅已配置 key 时有意义 */
  function clearApiKey(): void {
    form.apiKey = API_KEY_CLEAR_SENTINEL
  }

  // ── headers 行编辑 CRUD（W3 D7）：headerRows UI 行态 ↔ form.headers Record ──

  /** 把 headerRows 同步回 form.headers（filter 掉空 key 的行 + 重复 key 校验） */
  function syncHeadersFromRows(): void {
    const { headers, hasDuplicate } = buildHeadersFromRows(headerRows.value)
    form.headers = headers
    if (hasDuplicate) {
      actionError.value = t('composable.duplicateHeaderKey')
    } else if (actionError.value === t('composable.duplicateHeaderKey')) {
      actionError.value = ''
    }
  }
  /** 新增一个空 header 行 */
  function addHeader(): void {
    headerRows.value.push({ key: '', value: '' })
  }
  /** 移除指定下标的 header 行，并同步回 form.headers */
  function removeHeader(index: number): void {
    headerRows.value.splice(index, 1)
    syncHeadersFromRows()
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

  /**
   * 新增模型到清单（来自底部新增表单）。
   * D15a：空名/重名 id 抛错（调用方 catch 后填 actionError），替代原静默 return。
   * 抛错而非静默：CLAUDE.md 规则 #3——用户操作无反馈是 bug。
   */
  function addModel(): void {
    const name = newModel.name.trim()
    if (!name) throw new Error(t('composable.modelNameRequired'))
    // 重复 id 校验：localModels 已含同 id → 抛错
    if (localModels.value.some((m) => m.id === name)) {
      throw new Error(t('composable.modelAlreadyExists', { name }))
    }
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

  // ── D8：编辑弹窗过期快照刷新 ──
  // 弹窗打开期间若外部广播更新了同 provider（onProviders 整体替换 store.providers），
  // 弹窗表单不刷新会覆盖并发变更。watch store.providers，仅在「用户未手动改」（!isDirty）时
  // 重新快照 form（name/api/baseUrl/headers/authHeader/models），用户改动优先（isDirty=true 不刷新）。
  const settingsStore = useSettingsStore()
  watch(
    () => settingsStore.providers,
    (list) => {
      // 仅编辑态（providerRef 非 null）刷新；新增态无 provider 可对齐。
      const editingId = providerRef.value?.id
      if (!editingId) return
      // 用户已手动改 → 不刷新（改动优先）
      if (isDirty.value) return
      const fresh = list.find((p) => p.id === editingId)
      if (!fresh) return
      // 同步基础字段 + headers/authHeader + models
      form.name = fresh.name
      form.api = fresh.api ?? 'anthropic-messages'
      form.baseUrl = fresh.baseUrl ?? ''
      form.headers = fresh.headers ? { ...fresh.headers } : {}
      form.authHeader = fresh.authHeader ?? false
      headerRows.value = rowsFromHeaders(form.headers)
      localModels.value = fresh.models.map((m) => ({ ...m }))
      // 刷新后重新捕获快照（新基线，避免下次广播触发不必要的「dirty」）
      captureSnapshot()
    },
    { deep: true },
  )

  return {
    // 状态（template 绑定）
    form,
    newModel,
    localModels,
    headerRows,
    showKey,
    testing,
    discovering,
    testResult,
    discoverResult,
    showAddModel,
    saving,
    actionError,
    /** form 相对打开时快照是否有变更（D13 取消确认 + W3 过期快照刷新用） */
    isDirty,
    // 纯函数 helper
    getStrategyFromMap,
    // 编排
    testConnection,
    autoDiscover,
    save,
    /** 清除 apiKey（D18）：置哨兵，save 时识别为清空 */
    clearApiKey,
    // 模型 CRUD
    toggleInput,
    toggleNewInput,
    updateCtx,
    pickStrategy,
    addModel,
    removeModel,
    // headers CRUD（W3 D7）
    addHeader,
    removeHeader,
    syncHeadersFromRows,
  }
}
