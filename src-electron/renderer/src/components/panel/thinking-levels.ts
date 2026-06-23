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
