/**
 * RecentWorkspaceRecord DTO（领域就近归属，E2 架构候选——protocol.ts 只保留 type→payload 映射）。
 *
 * 系统设计：system-architecture.md §5（技术流程编排，无 aggregate，纯 DTO 无行为）。
 * 字段决策（D-006 + §4 label 决策）：
 * - cwd: 业务标识 + 去重键（绝对路径）
 * - lastUsedAt: number（Date.now()，与 session.lastActiveAt 一致，D-006）
 * - label: cwd basename（运行时算，零冗余存储——见 code-architecture.md §4 label 决策）
 */
export interface RecentWorkspaceRecord {
  /** 业务标识 + 去重键。绝对路径，非空串（INV-1）。 */
  cwd: string
  /** 排序键。Date.now() 毫秒时间戳（D-006，与 session.lastActiveAt 同精度）。 */
  lastUsedAt: number
  /** 显示名。cwd basename，record 时算出填入（零冗余，不持久化额外字段）。 */
  label: string
}
