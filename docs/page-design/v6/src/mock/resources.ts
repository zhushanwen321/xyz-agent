/** Mock 数据层 — Settings 资源（技能）页静态数据 */

// === Layer A：加载路径（spec §1：projectPaths 项目目录 + globalPaths 全局目录）===
export interface LoadPath {
  id: string
  path: string
  enabled: boolean
  /** 系统锁定目录：不可关/不可移/不可排序（spec §8） */
  locked?: boolean
}

export const projectPaths: LoadPath[] = [
  { id: 'lp-1', path: '~/.xyz-agent/skills', enabled: true, locked: true },
  { id: 'lp-2', path: './.xyz-agent/skills', enabled: true },
]
export const globalPaths: LoadPath[] = [
  { id: 'lp-3', path: '~/work/shared-skills', enabled: true },
  { id: 'lp-4', path: '~/lib/company-skills', enabled: false },
]

// === Layer B：资源预览（spec §5/§6/§8：6 种 badge 状态）===
export type RpSource = 'pi' | 'claude' | 'agents' | 'piinstall' | 'muted'
export interface RpItem {
  name: string
  /** 来源链：首项为生效来源（链长 >1 时首项 effective + 余项 faded） */
  sources: RpSource[]
  desc: string
}

/** mock 覆盖 6 种 badge 状态（spec §8）：pi / claude / agents / piinstall / effective（多来源链）/ muted */
export const rpItems: RpItem[] = [
  { name: 'code-review', sources: ['pi'], desc: '审查代码变更，触发词：review、code review。' },
  { name: 'browser-use', sources: ['claude'], desc: '通过浏览器自动化测试前端 GUI。' },
  { name: 'cw-cli', sources: ['agents'], desc: '结构化编码工作流 CLI。' },
  { name: 'merge', sources: ['pi', 'claude'], desc: '合并分支并发布' },
  { name: 'zcommit', sources: ['piinstall'], desc: '执行 git commit，智能生成提交信息。' },
  { name: 'legacy-notes', sources: ['muted'], desc: '旧版遗留资源，来源未知。' },
]

// === SourceImport 导入源（spec §4：claude / codex / pi / zcode）===
export interface ImportSource {
  id: string
  name: string
  dir: string
  count: number
  /** 目录无资源（0 个 skill）→ 禁选 */
  empty?: boolean
}

/** 4 源；pi 源 dir 与 globalPaths 的 ~/work/shared-skills 字面相等 → 动态判定「共享池已生效」禁选
 * （spec §4 判定：候选 dir 与现有加载路径 normalize 相等；不再静态标 shared，避免判定失真） */
export const IMPORT_SOURCES: ImportSource[] = [
  { id: 'claude', name: 'Claude', dir: '~/.claude/skills', count: 12 },
  { id: 'codex', name: 'Codex', dir: '~/.codex/skills', count: 8 },
  { id: 'pi', name: 'Pi', dir: '~/work/shared-skills', count: 5 },
  { id: 'zcode', name: 'Zcode', dir: '~/.zcode/skills', count: 0, empty: true },
]
