/**
 * 思考等级（前端固定枚举，非后端推送数据）。
 *
 * 枚举对齐 pi ThinkingLevel（off/minimal/low/medium/high/xhigh）。
 * 前端不暴露 minimal（用户无需此档），但 isThinkingLevel 仍认 minimal（兼容 pi 返回值）。
 *
 * **前端直接发 key 给 pi**，pi 内部 provider 层自查 thinkingLevelMap[key] 取 value 发给 API。
 * 前端不做 key→value 映射（pi 自己做，前端越权会导致 pi 存错值）。
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface ThinkingLevelOption {
  level: ThinkingLevel
  label: string
  en: string
  available: boolean
}

/**
 * UI 可选档位（不暴露 minimal）。popover 只渲染这些。
 * pi 返回的 thinkingLevel 可能是 minimal，resolveThinkingKey 兜底处理。
 */
export const THINKING_LEVELS: ThinkingLevelOption[] = [
  { level: 'off', label: '关', en: 'off', available: true },
  { level: 'low', label: '低', en: 'low', available: true },
  { level: 'medium', label: '中', en: 'medium', available: true },
  { level: 'high', label: '高', en: 'high', available: true },
  { level: 'xhigh', label: '极高', en: 'xhigh', available: true },
]

/** ThinkingLevel 强度序（数值越大强度越高，用于排序可用档位） */
const LEVEL_STRENGTH: Record<ThinkingLevel, number> = {
  off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5,
}

/** 判断字符串是否为合法 ThinkingLevel 枚举值（含 minimal，兼容 pi 返回值） */
export function isThinkingLevel(v: string): v is ThinkingLevel {
  return v in LEVEL_STRENGTH
}

/**
 * 解析当前模型的可用思考档位（按 **key** 判定，对齐 pi getSupportedThinkingLevels）。
 *
 * thinkingLevelMap 语义（pi models.ts:50）：
 * - key 存在且 value 非 null → 该档可用
 * - value = null → 该档不可用
 * - map 为 undefined 或空 → 全档可用（all-levels 预设）
 *
 * @returns 可用的 ThinkingLevel 列表（按强度升序，含 minimal 若配置启用）
 */
export function resolveAvailableLevels(
  map?: Record<string, string | null>,
): ThinkingLevel[] {
  if (!map || Object.keys(map).length === 0) {
    return THINKING_LEVELS.map((o) => o.level)
  }
  const available = new Set<ThinkingLevel>()
  for (const key of Object.keys(map)) {
    if (map[key] !== null && isThinkingLevel(key)) {
      available.add(key)
    }
  }
  return available.size > 0
    ? [...available].sort((a, b) => LEVEL_STRENGTH[a] - LEVEL_STRENGTH[b])
    : THINKING_LEVELS.map((o) => o.level) // 全 null fallback 全可用
}

/**
 * on/off 模式判定：map 只有 off + high 两个可用档位。
 * 该模式下 high 档 UI 显示「开」（而非通用 label「高」），语义为开/关二选一。
 */
function isOnOffMap(map?: Record<string, string | null>): boolean {
  if (!map) return false
  const keys = Object.keys(map).filter((k) => map[k] !== null)
  const ON_OFF_AVAILABLE_COUNT = 2
  return keys.length === ON_OFF_AVAILABLE_COUNT && keys.includes('off') && keys.includes('high')
}

/**
 * 取某档位的显示 label。on/off 模式下 high → 「开」，其余用通用 label。
 */
export function getDisplayLabel(level: ThinkingLevel, map?: Record<string, string | null>): string {
  if (level === 'high' && isOnOffMap(map)) return '开'
  return THINKING_LEVELS.find((o) => o.level === level)?.label ?? '思考'
}

/**
 * 将 runtime/pi 返回的 thinkingLevel 解析为 UI 档位。
 *
 * 前端直接发 key 给 pi，pi 存的就是 key（off/low/medium/high/xhigh/minimal）。
 * 直接判定是否合法 ThinkingLevel 即可，无需反查 map。
 * - pi 返回 minimal（前端不暴露）→ 降级到 high（最接近的用户可见档）
 *
 * @returns UI 档位 ThinkingLevel；无法映射时回退 fallback
 */
export function resolveThinkingKey(
  value: string,
  _map?: Record<string, string | null>,
  fallback: ThinkingLevel = 'xhigh',
): ThinkingLevel {
  if (isThinkingLevel(value)) {
    // pi 返回 minimal 但前端不暴露 → 降级到 high
    if (value === 'minimal') return 'high'
    return value
  }
  return fallback
}

/**
 * 取当前模型的最高可用思考档位。
 *
 * 用于切换模型后当前选中档位不可用时，自动重置到最高可用档。
 * map 为 undefined/空 → 'xhigh'（全可用时的最高档）。
 */
export function highestAvailableLevel(
  map?: Record<string, string | null>,
): ThinkingLevel {
  const levels = resolveAvailableLevels(map)
  return levels[levels.length - 1] ?? 'xhigh'
}
