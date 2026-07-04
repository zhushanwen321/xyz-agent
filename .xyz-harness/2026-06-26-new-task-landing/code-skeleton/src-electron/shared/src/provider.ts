/**
 * provider 类型桩（protocol.ts 引用）。
 * 骨架只需类型存在以让 protocol.ts 编译；完整定义在 src-electron/shared/src/provider.ts（未改动，本期不涉及）。
 * 标注为桩：字段收敛属后续 wave，此处仅满足类型依赖。
 */

export interface ProviderInfo {
  id: string
  name: string
  type: string
  enabled: boolean
  models?: Array<string | { id: string; name?: string }>
}

export interface SkillInfo {
  name: string
  description?: string
  source: string
  enabled?: boolean
}

export interface AgentInfo {
  name: string
  description?: string
  source: string
}

export interface ModelInfo {
  id: string
  name?: string
  provider: string
  contextWindow?: number
}
