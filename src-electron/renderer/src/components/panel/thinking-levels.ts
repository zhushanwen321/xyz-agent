/**
 * 思考等级（前端固定枚举，非后端推送数据）。
 *
 * 后端 session.setThinkingLevel 只接收一个 level 字符串，不推送等级列表——
 * 故用常量而非订阅。组件从本文件取，不再直接 import api/mock/composer-data。
 *
 * 前端有自己的 UI 档位名（含 max），通过 thinkingLevelMap 的 key→value 映射
 * 把 UI 档位名转换成 pi 认识的值，发给 runtime 的是 value。
 * 展示是展示，传递 value 是 value——两回事。
 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ThinkingLevelOption {
  level: ThinkingLevel
  label: string
  en: string
  available: boolean
}

export const THINKING_LEVELS: ThinkingLevelOption[] = [
  { level: 'off', label: '关', en: 'off', available: true },
  { level: 'low', label: '低', en: 'low', available: true },
  { level: 'medium', label: '中', en: 'medium', available: true },
  { level: 'high', label: '高', en: 'high', available: true },
  { level: 'xhigh', label: '极高', en: 'xhigh', available: true },
  { level: 'max', label: '最高', en: 'max', available: true },
]

/** ThinkingLevel 强度序（数值越大强度越高，用于排序可用档位） */
const LEVEL_STRENGTH: Record<ThinkingLevel, number> = {
  off: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5,
}

/** 判断字符串是否为合法 ThinkingLevel 枚举值 */
export function isThinkingLevel(v: string): v is ThinkingLevel {
  return v in LEVEL_STRENGTH
}

/**
 * 解析当前模型的可用思考档位（按 **key** 判定）。
 *
 * thinkingLevelMap 语义（key-based）：
 * - **key** = UI 可选档位（ThinkingLevel 枚举值，含 max）
 * - **value** = 发给 runtime/pi 的实际 level（string = 可用，null = 不可用）
 * - key 存在且 value 非 null → 该档可用
 * - key 存在且 value = null → 该档不可用
 * - map 为 undefined 或空 → 全 6 档可用（all-levels 预设）
 *
 * 展示是展示，传递 value 是 value——key 是前端展示用的，value 是发给 pi 的。
 *
 * @returns 可用的 ThinkingLevel 列表（按强度升序）
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
 * 将 UI 档位（key）解析为发给 runtime 的实际 level（value）。
 *
 * thinkingLevelMap 的 value 是发给 runtime/pi 的字符串。选中某档位时：
 * - key 存在且 value 非 null → 发 value（如 max 档发 xhigh）
 * - map 为 undefined/空（all-levels）→ 发 key 自身（档位名 = 发送值）
 *
 * 展示是展示（key），传递 value 是 value——这是两回事。
 *
 * @returns 发给 runtime 的 level 字符串；key 无映射时回退 key 自身
 */
export function resolveThinkingValue(
  key: ThinkingLevel,
  map?: Record<string, string | null>,
): string {
  if (!map || Object.keys(map).length === 0) return key
  const v = map[key]
  return v ?? key
}

/**
 * 将 runtime 返回的 level（value）反向解析为 UI 档位（key）。
 *
 * pi/session.thinkingLevel 存的是发给 pi 的 value（如 'xhigh'），需反查 map
 * 找到对应的 UI 档位 key（如 'max'）才能正确高亮 popover。
 * - value 能反查到 key → 返回该 key
 * - value 等于某个 ThinkingLevel 枚举值且不在 map 的 value 里 → value 本身就是 key（all-levels 或 value=key）
 * - 都不匹配 → 返回 fallback
 *
 * @returns UI 档位 ThinkingLevel；无法映射时回退 fallback
 */
export function resolveThinkingKey(
  value: string,
  map?: Record<string, string | null>,
  fallback: ThinkingLevel = 'max',
): ThinkingLevel {
  // 反查 map：value → key
  if (map && Object.keys(map).length > 0) {
    for (const [key, val] of Object.entries(map)) {
      if (val === value && isThinkingLevel(key)) return key
    }
  }
  // all-levels（map 为空）或 value 直接是档位名
  if (isThinkingLevel(value)) return value
  return fallback
}

/**
 * 取当前模型的最高可用思考档位。
 *
 * 用于切换模型后当前选中档位不可用时，自动重置到最高可用档。
 * map 为 undefined/空 → 'max'（全可用时的最高档）。
 */
export function highestAvailableLevel(
  map?: Record<string, string | null>,
): ThinkingLevel {
  const levels = resolveAvailableLevels(map)
  return levels[levels.length - 1] ?? 'max'
}
