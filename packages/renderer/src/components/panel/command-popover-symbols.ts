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
import type { SessionSummary, SubagentRecord } from '@xyz-agent/shared'

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
 * landing 态（hasSessionId=false）返回空——设计 out-of-scope：无活跃 session 不弹 # 浮层。
 */
export function buildSessionCandidates(
  sessions: SessionSummary[],
  query: string,
  hasSessionId: boolean,
  now = Date.now(),
): SymbolCandidate[] {
  if (!hasSessionId) return []
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
