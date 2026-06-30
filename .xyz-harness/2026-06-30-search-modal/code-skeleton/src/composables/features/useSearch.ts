/**
 * useSearch（#4 D-026 + #17）—— 搜索编排（聚合 4 源 query() + loadSeq + WS 超时 race + 分组）。
 *
 * [D-026 REVISIT of issues #4] 编排归 composable（非 domain），与 useSidebar/useFileSearch 同层
 * 跨 store+domain 编排。domain 严格只调 transport+pending 的铁律不变。
 *
 * 接线层级：跨模块（调 matchFilter + commandStore + fileSearchStore + composer/session domain + WS race）。
 * 依赖方向：lib（match-engine/search-types）+ stores（command/fileSearch）+ api（composer/session domain）+ useCommandRegistry/useRecents。
 *
 * 数据流：SearchModal.watch(query) → debounce 120ms → query(q, ctx) →
 *   allSettled 并行查 3 源（命令内存 / file WS 缓存优先 / session WS）→
 *   合并候选 → matchFilter 过滤 → DTO 映射 → 按类型分组（符号占位 D-001）→ Section[]
 *
 * 失败路径：
 *  - file 源 WS reject：error 从 composer.getFileCandidates 冒泡（AC-4.5 不经 useFileSearch.load 吞错层）→ allSettled rejected → 分组空态（MR-4.2 单源静默）
 *  - WS 断连 pending 永不 settle（#17 F-1）：WS 超时 race 10s → reject → allSettled settled → 分组空态+toast（AC-17.1，不永久挂死）
 *  - 全源失败：四类空态 + toast（AC-17.3）
 *  - 乱序响应：loadSeq 守卫 seq!==loadSeq 丢弃旧结果（BC-9，D-022 骨架约束）
 *
 * 并发（BC-9）：loadSeq 模块级自增序列号，await 后比对，旧响应丢弃。
 */
import { matchFilter } from '@/lib/match-engine'
import {
  WS_SOURCE_TIMEOUT_MS,
  type SearchCtx,
  type Section,
} from '@/lib/search-types'
import { useCommandRegistry } from '@/composables/features/useCommandRegistry'
import { useRecents } from '@/composables/features/useRecents'
import { useFileSearchStore } from '@/stores/fileSearch'
import { composer as composerApi, session as sessionApi } from '@/api'
import type { FileNode, SessionGroup, SessionSummary } from '@xyz-agent/shared'
import type { SearchItem } from '@/api/mock/search-data'

export function useSearch(activeSessionId: { value: string | null }) {
  const fileSearchStore = useFileSearchStore()
  const commandRegistry = useCommandRegistry(activeSessionId)
  const recents = useRecents()

  /** [BC-9 / D-022 骨架约束] loadSeq 序列号守卫（乱序响应不覆盖新结果） */
  let loadSeq = 0

  /**
   * 查询（核心入口）。
   * @param q 查询词（已 trim）
   * @param ctx 搜索上下文（activeSessionId）
   * @returns 四类分组 Section[]（空组过滤，符号占位 D-001）
   */
  async function query(q: string, ctx: SearchCtx): Promise<Section[]> {
    const seq = ++loadSeq // BC-9 守卫入口

    // 空查询：recents + 建议命令（不查 WS 源）
    if (!q) {
      const recentItems = mapRecentsToItems(recents.read())
      const suggested = mapCommandsToItems(commandRegistry.list().value).slice(0, 3)
      return [
        { label: '最近', items: recentItems },
        { label: '建议命令', items: suggested },
      ].filter((s) => s.items.length > 0)
    }

    // 非空查询：allSettled 并行查 3 源
    const [commandRes, fileRes, sessionRes] = await Promise.allSettled([
      queryCommandSource(), // 内存，无 WS
      queryFileSource(ctx.activeSessionId), // WS 缓存优先 + #17 超时 race
      querySessionSource(), // WS + #17 超时 race
    ])

    // BC-9 守卫：旧响应丢弃（seq !== loadSeq 说明有更新查询）
    if (seq !== loadSeq) return []

    // 合并候选 + matchFilter 过滤（MR-4.2：单源 rejected 取空，不阻断其他源）
    const commands = commandRes.status === 'fulfilled' ? commandRes.value : []
    const files = fileRes.status === 'fulfilled' ? fileRes.value : []
    const sessions = sessionRes.status === 'fulfilled' ? sessionRes.value : []
    const allCandidates = [...commands, ...files, ...sessions]
    const filtered = matchFilter(allCandidates, q)

    // 按类型分组 + 符号占位（D-001，GAP-E1 归 domain→归 useSearch D-026）
    return groupByType(filtered)
  }

  /** 命令源（内存，无 WS）：useCommandRegistry 聚合 → SearchItem 映射 */
  async function queryCommandSource(): Promise<SearchItem[]> {
    return mapCommandsToItems(commandRegistry.list().value)
  }

  /**
   * file 源（WS 缓存优先 + #17 超时 race）。
   * AC-4.9：缓存命中直返（不重复递归）。
   * AC-4.5：缓存未命中直调 composer.getFileCandidates（不经 useFileSearch.load 吞错层）。
   * AC-4.10：消费缓存须自绑 setupInvalidation watch（实现期在 useSearch 初始化时绑，不依赖 CommandPopover 挂载）。
   * #17：WS 源包 Promise.race timeout（防 pending 永不 settle）。
   */
  async function queryFileSource(sid: string | null): Promise<SearchItem[]> {
    if (!sid) return [] // AC-4.8 无 session → file 源空
    const cached = fileSearchStore.get(sid)
    let nodes: FileNode[]
    if (cached) {
      nodes = cached // AC-4.9 缓存命中
    } else {
      // AC-4.5：直调 composer.getFileCandidates（不经 useFileSearch.load 吞错层）
      // #17：WS 超时 race（10s，防 WS 断连 pending 永不 settle 致浮层挂死）
      nodes = await withWsTimeout(composerApi.getFileCandidates(sid))
      fileSearchStore.set(sid, nodes) // 写缓存供下次命中
    }
    return mapFilesToItems(nodes)
  }

  /** session 源（WS + #17 超时 race）：session.list 全量跨项目 → 内存 matchFilter 过滤 */
  async function querySessionSource(): Promise<SearchItem[]> {
    // #17：WS 超时 race
    const groups = await withWsTimeout(sessionApi.list())
    return mapSessionsToItems(groups)
  }

  /**
   * #17 WS 源超时 race（D-023 F-1 漏洞修复）。
   * ws-client.ts onclose 不 reject in-flight pending（pending.ts 无 clear/flush），
   * WS 断连时 pending 永不 settle → allSettled 永不 resolve → 浮层永久 loading 挂死。
   * 本函数对 WS 源包 Promise.race timeout：超时→reject→allSettled settled→分组空态+toast。
   */
  function withWsTimeout<T>(wsCall: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('搜索服务暂时不可用')), // AC-17.3
        WS_SOURCE_TIMEOUT_MS,
      )
    })
    return Promise.race([wsCall, timeout]).finally(() => {
      // AC-17.2 资源清理：成功时 clearTimeout（防泄漏，与 AC-8.4 同模式）
      if (timer) clearTimeout(timer)
    })
  }

  // ── DTO 映射（D-025：real 源异构 DTO → SearchItem，参考 lib/file-candidates.ts 模式）──
  function mapCommandsToItems(cmds: unknown[]): SearchItem[] {
    // 实现期填：AppCommand/SessionCommand → SearchItem{type:'command', title:name, sub:shortcut/desc}
    return cmds.map((c) => toCommandItem(c))
  }
  function mapFilesToItems(nodes: FileNode[]): SearchItem[] {
    return nodes.map((n) => ({
      type: 'file' as const,
      title: n.name,
      sub: n.path, // AC-3.1 相对路径展示（非绝对路径）
    }))
  }
  function mapSessionsToItems(groups: SessionGroup[]): SearchItem[] {
    const out: SearchItem[] = []
    for (const g of groups) {
      for (const s of g.sessions) {
        out.push(toSessionItem(s)) // gitBranch 缺失降级（AC-4.1/T4.2）
      }
    }
    return out
  }
  function mapRecentsToItems(entries: { type: SearchItem['type']; title: string; sub: string }[]): SearchItem[] {
    return entries.map((e) => ({ type: e.type, title: e.title, sub: e.sub }))
  }

  function toCommandItem(_c: unknown): SearchItem {
    return { type: 'command', title: '', sub: '' } // 实现期填
  }
  function toSessionItem(_s: SessionSummary): SearchItem {
    return { type: 'session', title: '', sub: '' } // 实现期填（含 gitBranch 缺失降级）
  }

  /** 按类型分组（符号占位 D-001，空组过滤） */
  function groupByType(items: SearchItem[]): Section[] {
    const byType = new Map<SearchItem['type'], SearchItem[]>()
    for (const it of items) {
      const arr = byType.get(it.type) ?? []
      arr.push(it)
      byType.set(it.type, arr)
    }
    const labels: Record<SearchItem['type'], string> = {
      command: '命令',
      file: '文件',
      symbol: '符号',
      session: '会话',
    }
    const sections: Section[] = []
    for (const t of ['command', 'file', 'symbol', 'session'] as const) {
      if (t === 'symbol') {
        // D-001 符号占位：恒占位 section（不随查询变化，不参与匹配）
        sections.push({ label: labels[t], items: [] })
      } else {
        const its = byType.get(t) ?? []
        if (its.length > 0) sections.push({ label: labels[t], items: its })
      }
    }
    return sections
  }

  return { query }
}
