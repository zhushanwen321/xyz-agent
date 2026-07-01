/**
 * 思考等级 6 级（前端固定枚举，非后端推送数据）。
 *
 * 后端 session.setThinkingLevel 只接收一个 level 字符串，不推送等级列表——
 * 故用常量而非订阅。组件从本文件取，不再直接 import api/mock/composer-data。
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

/**
 * 解析当前模型的可用思考档位。
 *
 * thinkingLevelMap 语义：value 非 null = 该档位可用，value 值 = 发给 pi 的实际 level。
 * - map 为 undefined 或空对象 → 全 6 档可用（all-levels 预设）
 * - map 非空 → value 非 null 的 entry 为可用档位
 *
 * 注意 key 空间（off/minimal/low/medium/high/xhigh）与 ThinkingLevel 枚举
 * （off/low/medium/high/xhigh/max）不一致：按 value（非 null 且为合法 ThinkingLevel）
 * 判定可用，不依赖 key。
 *
 * @returns 可用的 ThinkingLevel 列表（按强度升序）
 */
export function resolveAvailableLevels(
  map?: Record<string, string | null>,
): ThinkingLevel[] {
  if (!map || Object.keys(map).length === 0) return [...THINKING_LEVELS.map((o) => o.level)]
  const available = new Set<ThinkingLevel>()
  for (const value of Object.values(map)) {
    if (value !== null && isThinkingLevel(value)) available.add(value)
  }
  return available.size > 0
    ? [...available].sort((a, b) => LEVEL_STRENGTH[a] - LEVEL_STRENGTH[b])
    : [...THINKING_LEVELS.map((o) => o.level)] // 全 null fallback 全可用
}

/** 判断字符串是否为合法 ThinkingLevel 枚举值 */
export function isThinkingLevel(v: string): v is ThinkingLevel {
  return v in LEVEL_STRENGTH
}

/**
 * 取当前模型的最高可用思考档位。
 *
 * 用于切换模型后当前选中档位不可用时，重置到最高可用档。
 * 按 value 强度序取最大；map 为 undefined/空 → 'max'（全可用时的最高档）。
 */
export function highestAvailableLevel(
  map?: Record<string, string | null>,
): ThinkingLevel {
  const levels = resolveAvailableLevels(map)
  return levels[levels.length - 1] ?? 'max'
}
