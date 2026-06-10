import { ref, type Ref } from 'vue'

// ── Types ────────────────────────────────────────────────────────

export interface ModalModel {
  id: string
  name: string
  contextWindow: number
  enabled?: boolean
  thinkingLevelMap?: Record<string, string | null>
}

// ── Constants ────────────────────────────────────────────────────

const CTX_1M = 1_000_000
const CTX_1K = 1000

export const ctxOptions = [
  { label: '128K', value: '128000' },
  { label: '200K', value: '200000' },
  { label: '256K', value: '256000' },
  { label: '1M', value: '1000000' },
]

export function formatCtx(v: string | number | undefined): string {
  if (v == null || v === '--') return '--'
  const n = typeof v === 'string' ? parseInt(v, 10) : v
  if (Number.isNaN(n) || n <= 0) return '--'
  if (n >= CTX_1M) return `${(n / CTX_1M).toFixed(n % CTX_1M === 0 ? 0 : 1)}M`
  return `${Math.round(n / CTX_1K)}K`
}

// ── Thinking strategy ────────────────────────────────────────────

type ThinkingStrategy = 'all-levels' | 'on-off' | 'high-max'

export const THINKING_PRESETS: Record<ThinkingStrategy, Record<string, string | null> | undefined> = {
  'all-levels': undefined,
  'on-off': { minimal: null, low: null, medium: null, high: null, xhigh: 'xhigh' },
  'high-max': { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: 'max' },
}

export const STRATEGY_LABELS: Record<ThinkingStrategy, string> = {
  'all-levels': 'All Levels',
  'on-off': 'On / Off',
  'high-max': 'high / max',
}

export function getStrategyFromMap(map?: Record<string, string | null>): ThinkingStrategy {
  if (!map) return 'all-levels'
  if (map.xhigh === 'max') return 'high-max'
  return 'on-off'
}

function applyThinkingStrategy(model: ModalModel, strategy: ThinkingStrategy) {
  const preset = THINKING_PRESETS[strategy]
  model.thinkingLevelMap = preset ? structuredClone(preset) : undefined
}

// ── Composable ───────────────────────────────────────────────────

export function useModelEditor(modalModels: Ref<ModalModel[]>) {
  const editingModelId = ref<string | null>(null)
  const editingCtxValue = ref('')

  function updateModelCtx(modelId: string, value: string | number) {
    editingCtxValue.value = String(value)
    const model = modalModels.value.find(m => m.id === modelId)
    if (model) model.contextWindow = Number(value) || 0
  }

  function toggleModelEdit(modelId: string) {
    if (editingModelId.value === modelId) {
      editingModelId.value = null
    } else {
      editingModelId.value = modelId
      const model = modalModels.value.find(m => m.id === modelId)
      editingCtxValue.value = model ? String(model.contextWindow ?? 0) : '0'
    }
  }

  /** Build ctx options with a fallback for non-standard values */
  function getCtxOptionsForModel(model: ModalModel): { label: string; value: string }[] {
    const rawValue = String(model.contextWindow ?? 0)
    if (!ctxOptions.some(o => o.value === rawValue)) {
      return [{ label: formatCtx(model.contextWindow), value: rawValue }, ...ctxOptions]
    }
    return ctxOptions
  }

  function pickStrategy(model: ModalModel, strategy: ThinkingStrategy) {
    applyThinkingStrategy(model, strategy)
    editingModelId.value = null
  }

  function resetEditing() {
    editingModelId.value = null
  }

  return {
    editingModelId,
    editingCtxValue,
    updateModelCtx,
    toggleModelEdit,
    getCtxOptionsForModel,
    pickStrategy,
    resetEditing,
  }
}
