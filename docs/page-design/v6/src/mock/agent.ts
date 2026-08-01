/** Mock 数据层 — Settings 代理页静态数据（与 resources.ts 同构，kind=agent） */

// === Layer A：加载路径（spec §1：projectPaths 项目目录 + globalPaths 全局目录）===
export interface LoadPath {
  id: string
  path: string
  enabled: boolean
  /** 系统锁定目录：不可关/不可移/不可排序（spec §8） */
  locked?: boolean
}

/** 系统锁定目录对齐真实组件 forcedDirs（kind=agent）：~/.xyz-agent/agents + .xyz-agent/agents */
export const projectPaths: LoadPath[] = [
  { id: 'lp-1', path: '~/.xyz-agent/agents', enabled: true, locked: true },
  { id: 'lp-2', path: './.xyz-agent/agents', enabled: true },
]
export const globalPaths: LoadPath[] = [
  { id: 'lp-3', path: '~/work/shared-agents', enabled: true },
  { id: 'lp-4', path: '~/lib/company-agents', enabled: false },
]

// === Layer B：资源预览（spec §5/§6/§8：6 种 badge 状态）===
export type RpSource = 'pi' | 'claude' | 'agents' | 'piinstall' | 'muted'
export interface RpItem {
  name: string
  /** 来源链：首项为生效来源（链长 >1 时首项 effective + 余项 faded） */
  sources: RpSource[]
  desc: string
}

/** mock 覆盖 6 种 badge 状态（spec §8）：pi / claude / agents / piinstall / effective（多来源链）/ muted。
 * agent 名取自真实项目 .agents/agents/ 下的 agent；piinstall 来源实际无，mock 覆盖 badge 用 */
export const rpItems: RpItem[] = [
  { name: 'code-reviewer', sources: ['pi'], desc: '通用代码审查专家。读取 git diff 输出，发现潜在 bug 与安全隐患。' },
  { name: 'explorer', sources: ['claude'], desc: '摸清代码库结构、找入口点，返回压缩结构地图。' },
  { name: 'general-purpose', sources: ['agents'], desc: '通用智能代理。适用于任何不匹配专用 agent 的任务。' },
  { name: 'worker', sources: ['pi', 'claude'], desc: '明确的编码、修复、文件操作任务执行者。' },
  { name: 'zcommit', sources: ['piinstall'], desc: '执行 git commit，智能分析变更并创建规范的提交信息。' },
  { name: 'legacy-notes', sources: ['muted'], desc: '旧版遗留代理，来源未知。' },
]

// === SourceImport 导入源（spec §4：claude / codex / pi / zcode）===
export interface ImportSource {
  id: string
  name: string
  dir: string
  count: number
  /** 目录无资源（0 个 agent）→ 禁选 */
  empty?: boolean
}

/** 4 源；pi 源 dir 与 globalPaths 的 ~/work/shared-agents 字面相等 → 动态判定「共享池已生效」禁选
 * （spec §4 判定：候选 dir 与现有加载路径 normalize 相等；不再静态标 shared，避免判定失真） */
export const IMPORT_SOURCES: ImportSource[] = [
  { id: 'claude', name: 'Claude', dir: '~/.claude/agents', count: 9 },
  { id: 'codex', name: 'Codex', dir: '~/.codex/agents', count: 6 },
  { id: 'pi', name: 'Pi', dir: '~/work/shared-agents', count: 4 },
  { id: 'zcode', name: 'Zcode', dir: '~/.zcode/agents', count: 0, empty: true },
]
