/**
 * 迁移功能（从其他 agent 迁移配置）共享类型。
 *
 * W1（cw-2026-07-26-migration-other-agents）：定义 config.detectSources 检测结果的 DTO。
 * 后续 wave（W2/W3）会在 SourceDetectResult 上扩展 provider 维度的字段。
 *
 * 设计约束（安全）：
 * - 检测阶段只统计文件数量，不读取文件内容（不提取任何 API key、不解析配置正文）。
 * - skillCount 递归统计 SKILL.md；agentCount 仅统计顶层 *.md（agent 文件位于根目录）。
 */

/** 可作为 skill 迁移源的 agent（4 源）。 */
export type ProviderSource = 'pi' | 'zcode' | 'codex' | 'claude'

/** 可作为 agent 迁移源的 agent（W1 仅支持 Claude Code）。 */
export type AgentSource = 'claude'

/**
 * 单个迁移源的检测结果。
 *
 * - skill 候选可含全部 4 源（pi/zcode/codex/claude）。
 * - agent 候选仅 'claude'（其余源无标准 agent 目录）。
 */
export interface SourceDetectResult {
  /** 源类型。skill 候选可含全部 4 源；agent 候选仅 'claude'。 */
  source: ProviderSource | AgentSource
  /** 源配置目录是否存在（源 agent 是否安装）。目录不存在时为 false。 */
  installed: boolean
  /** 检测的目录绝对路径（skill 目录）。 */
  dir: string
  /** skill 数量（递归 SKILL.md 文件计数）。installed=false 时省略。 */
  skillCount?: number
  /** agent 数量（顶层 *.md 文件计数，仅 claude 有）。installed=false 时省略。 */
  agentCount?: number
  /** provider 数量（W1 不实现，留 undefined）。W2/W3 填充。 */
  providerCount?: number
}
