/**
 * CommandPopover 四符号候选派生纯函数（composer-symbol-system U2a）。
 *
 * 定位：# session / @ subagent 两路浮层候选的数据整形（过滤/排序/副行文案），
 * 从 CommandPopover.vue 拆出（照 command-popover-source.ts 先例）——纯函数无副作用，
 * 可直接单测；CommandPopover 只负责消费 store 数据 + 渲染。
 *
 * 数据源（G2/G3）：
 * - session 路：sessionStore（sidebar 同款 groups/list，跨 cwd 全量）
 * - subagent 路：subagentStore per-session 分区（ADR-0049 Map 分区）+ 固定尾部「新建」项
 */
import type { CommandSourceInfo, SessionSummary, SkillInfo, SubagentRecord } from '@xyz-agent/shared'
import { isInternalSkillName, isInternalSlashName } from '@/lib/internal-command-filter'

/** 「＋ 新建 subagent」固定项 id（CommandPopover 选中上抛 subagentId/slug 空串） */
export const NEW_SUBAGENT_ITEM_ID = '__new_subagent__'

/** 浮层统一候选项视图（file/slash 路在 CommandPopover 内联派生，session/subagent 路在此派生） */
export interface SymbolCandidate {
  id: string
  /** 主行文本（session=label / subagent=slug / 新建项=文案） */
  name: string
  kind: string
  /** SLASH_ICON_COMPONENTS key（session→folder / subagent→Bot） */
  icon: string
  /** 两行展示的副行文本（session=cwd · age / subagent=agent · status / 新建项=无） */
  subText?: string
  /** session 路透传（onCmdSelect → insertSessionChip） */
  sessionId?: string
  label?: string
  /** subagent 路透传（onCmdSelect → insertSubagentChip；新建项两字段空串） */
  subagentId?: string
  slug?: string
}

/** 1 分钟 / 1 小时 / 1 天 毫秒数（formatAge 分桶阈值） */
const ONE_MINUTE = 60_000
const ONE_HOUR = 3_600_000
const ONE_DAY = 86_400_000

/**
 * 相对时间 age 格式化（照 TUI hash-provider 的 age 简化实现）：xxm / xxh / xxd。
 * <1m → 'now'；≥1d → 'Nd' 封顶（更久也用天，浮层场景无需月/年粒度）。
 */
export function formatAge(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  if (diff < ONE_MINUTE) return 'now'
  if (diff < ONE_HOUR) return `${Math.floor(diff / ONE_MINUTE)}m`
  if (diff < ONE_DAY) return `${Math.floor(diff / ONE_HOUR)}h`
  return `${Math.floor(diff / ONE_DAY)}d`
}

/**
 * session 候选派生（G2）：全量 session（跨 cwd）按 lastActiveAt 降序，
 * query 按 label/id 子串过滤（大小写不敏感——id 是 uuid 子串也要能命中），
 * hidden session 排除（与 sidebar 展示口径一致）。
 * landing/panel 统一「有数据就列」（D1 删 hasSessionId 门：sessionStore 启动即常驻，
 * landing 也直接列；D7：不做 landing 特殊过滤，跨 cwd 全量口径不变）。
 */
export function buildSessionCandidates(
  sessions: SessionSummary[],
  query: string,
  now = Date.now(),
): SymbolCandidate[] {
  const q = query.trim().toLowerCase()
  return sessions
    .filter((s) => !s.hidden)
    .filter((s) => {
      if (!q) return true
      return s.label.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
    })
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .map((s) => ({
      id: `session-${s.id}`,
      name: s.label || s.id,
      kind: 'session',
      icon: 'folder',
      subText: `${s.cwd} · ${formatAge(s.lastActiveAt, now)}`,
      sessionId: s.id,
      label: s.label || s.id,
    }))
}

/**
 * subagent 候选派生（G3）：当前 session 分区的 records，query 按 slug/agent 过滤，
 * 固定尾部「＋ 新建 subagent」项（subagentId/slug 空串，选中语义由上层定）。
 * landing 态（hasSessionId=false）返回空——@ 范围限当前 session（D3 拍板），无 session 无数据源。
 */
export function buildSubagentCandidates(
  records: SubagentRecord[],
  query: string,
  hasSessionId: boolean,
  newSubagentLabel: string,
): SymbolCandidate[] {
  if (!hasSessionId) return []
  const q = query.trim().toLowerCase()
  const items: SymbolCandidate[] = records
    .filter((r) => {
      if (!q) return true
      return r.slug.toLowerCase().includes(q) || r.agent.toLowerCase().includes(q)
    })
    .map((r) => ({
      id: `subagent-${r.subagentId}`,
      name: r.slug || r.subagentId,
      kind: 'subagent',
      icon: 'subagents',
      subText: `${r.agent} · ${r.status}`,
      subagentId: r.subagentId,
      slug: r.slug,
    }))
  items.push({
    id: NEW_SUBAGENT_ITEM_ID,
    name: newSubagentLabel,
    kind: 'subagent',
    icon: 'subagents',
    subagentId: '',
    slug: '',
  })
  return items
}

// ── slash 路（行首命令浮层）候选派生（自 CommandPopover.vue 拆出，≤300 行规范）──────────

/** slash 名归一化：补 / 前缀（pi 返回 'goal' → '/goal'，含路由前缀供 onSelect → pi 路由）。 */
export function normalizedSlashName(name: string): string {
  return name.startsWith('/') ? name : `/${name}`
}

/** skill 显示名：剥离 /skill: 或 / 前缀，只留 skill 名（icon 已表示类型）。 */
export function skillDisplayName(name: string): string {
  if (name.startsWith('/skill:')) return name.slice('/skill:'.length)
  if (name.startsWith('/')) return name.slice(1)
  return name
}

export interface SlashCandidateInput {
  id: string
  name: string
  kind: string
  icon?: string
  description?: string
  /** skill 项：SKILL.md 绝对路径（pi sourceInfo.path / landing sourcePath，可得时带上；
   *  onCmdSelect 按 isSkill 分流后透传 insertSkillChip 落 chip dataset——设计 D3） */
  location?: string
}

/**
 * slash 路候选（行首命令浮层）：query 过滤（子串匹配）+ CmdItem 组装。
 * skill 命令去 /skill: 前缀显名（icon 已表示类型）；displayName 仅用于模板，onSelect 传完整
 * name；声明侧无 icon（schema v2 无 icon 字段）——iconKeyForCommand 按 name/source 推断
 * （builtin 命中 / skill→star / extension→terminal）。
 */
export function buildSlashCandidates(
  all: SlashCandidateInput[],
  query: string | undefined,
  iconKeyForCommand: (name: string, kind: string) => string,
): Array<{
  id: string
  name: string
  displayName: string
  kind: string
  icon: string
  isSkill: boolean
  description?: string
  location?: string
  dirPath: undefined
}> {
  const q = (query ?? '').trim().toLowerCase()
  const filtered = q ? all.filter((c) => normalizedSlashName(c.name).toLowerCase().includes(q)) : all
  return filtered.map((c) => {
    const name = normalizedSlashName(c.name)
    return {
      id: c.id,
      name,
      displayName: c.kind === 'skill' ? skillDisplayName(c.name) : name,
      kind: c.kind,
      icon: c.icon ?? iconKeyForCommand(c.name, c.kind),
      isSkill: c.kind === 'skill' || name.startsWith('/skill:'),
      description: c.description,
      location: c.location,
      dirPath: undefined,
    }
  })
}

/**
 * panel 态 slash 候选组装（自 CommandPopover.vue 拆出，≤300 行规范）：
 * compact 固定头部 + merged 过滤内部命令。D3：merged（resolveSlashCommands 合并）会丢
 * pi 真源的 sourceInfo——skill 项的 SKILL.md 路径在此从真源按归一化名回填，
 * 供 onCmdSelect 按 isSkill 分流后透传 insertSkillChip。
 */
export function buildPanelSlashCandidates(
  merged: ReadonlyArray<SlashCandidateInput>,
  piCmds: Array<{ name: string; sourceInfo?: CommandSourceInfo }>,
  compactCmd: SlashCandidateInput,
): Array<SlashCandidateInput & { location?: string }> {
  const skillLocationByName = new Map<string, string>()
  for (const c of piCmds) {
    const path = c.sourceInfo?.path
    if (path) skillLocationByName.set(normalizedSlashName(c.name), path)
  }
  const withLocation = merged
    .filter((c) => !isInternalSlashName(c.name))
    .map((c) => ({ ...c, location: skillLocationByName.get(normalizedSlashName(c.name)) }))
  return [compactCmd, ...withLocation]
}

/**
 * landing 态 slash 候选组装（自 CommandPopover.vue 拆出，≤300 行规范）：
 * merged 声明源 + SkillInfo[] → slash 项（/skill:<name> 归一化），跳过 merged 已有同名
 * 与 __ 内部 skill。优先级：merged 源已在 seen，全局次之（globalSkills），项目最后
 * （projectSkills 补独有项）。D3：location 取 SkillInfo.sourcePath（可得时带上）。
 */
export function buildLandingSlashCandidates(
  merged: ReadonlyArray<SlashCandidateInput>,
  globalSkills: SkillInfo[],
  projectSkills: SkillInfo[],
): Array<SlashCandidateInput> {
  const seen = new Set<string>()
  merged.forEach((c) => seen.add(normalizedSlashName(c.name)))
  // SkillInfo[] → slash 项（/skill:<name> 归一化），跳过 seen 同名 + __ 前缀
  const mapSkillInfo = (skills: SkillInfo[]) =>
    skills
      .filter((s) => !isInternalSkillName(s.name))
      .filter((s) => !seen.has(`/skill:${s.name}`))
      .map((s) => {
        seen.add(`/skill:${s.name}`)
        return {
          id: `skill-${s.name}`,
          name: `/skill:${s.name}`,
          kind: 'skill',
          icon: 'star',
          description: s.description,
          location: s.sourcePath,
        }
      })
  return [...merged, ...mapSkillInfo(globalSkills), ...mapSkillInfo(projectSkills)]
}
