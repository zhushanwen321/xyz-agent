/**
 * history 域完整模块（S6 迁出，缓存 + 读编排同居）：HistoryRebuildCache（纯缓存类，
 * wave:perf-w20 D6）+ SessionHistoryReader（读编排：getHistory 三分支重建 / getFullHistory
 * 文件直读，原 Facade 方法逐字随迁）。
 *
 * 设计依据：.xyz-harness/2026-08-15-perf/04-history-incremental.md §3.3 D6-1/D6-3。
 *
 * 为什么缓存做在 runtime 而非 renderer：getHistory 只在「无基底路径」被调
 * （首次进入 / LRU 驱逐后重进 / renderer 重载——renderer 消息数组已空），
 * renderer 无 append 入口可用；runtime 是唯一持有「上次重建结果」的层。
 *
 * 生命周期（D6-1）：
 * - 写入：getHistory 每次成功重建后（全量与增量路径都写）
 * - 读取：getHistory 命中时走 getEntries(since=lastLeafId) 增量（空增量 = 缓存新鲜）
 * - 清除：SessionHistoryReader.onSessionDisposed（Facade removeSessionEntry 第 ⑤ 步直调，
 *   与 traceSync/projection/records 并列；session 删除 + pi 进程退出两条路汇聚点）+ 容量帽 LRU 驱逐
 * - 无持久化：重开 app 后 runtime 内存已空，必然全量重建（纯派生数据，丢弃无一致性风险）
 *
 * pi get_entries(since) 行为（2026-08-16 实测，pi 0.84.0，脚本 /tmp/verify-pi-since.mjs 已验证后删除）：
 * - leafId 随 append 前进；空增量（since=当前 leafId）返回 success + entries:[]
 * - since 指向不存在的 entry → error "Entry not found: <id>"（E 大写 not 小写）
 * - compact 是 append-only（compaction entry append，旧 entry 不删除）→ since 不会因 compact 失效
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message, SegmentsMetadataFile } from '@xyz-agent/shared'
// paths.ts 是 Node-only 模块，刻意不从 shared barrel 导出（见 shared/src/index.ts L32 注释），
// Node 端从子路径 import
import { getAttachmentsDir } from '@xyz-agent/shared/paths'
import type { IProcessManager } from '../ports/pi-engine.js'
import type { ISessionStore } from '../ports/session.js'
import { getHistoryFromFilePath, getHistoryTailFromFile } from '../session-history.js'
import { applyOrphanToolResults } from '../../infra/pi/message-converter.js'
import { isEntryNotFoundError } from './trace-sync.js'
import { toErrorMessage } from '../../utils/errors.js'

/**
 * get_entries RPC 响应的域内收窄（u-s4 EntriesSinceResult 同款先例）：entries 只消费
 * parentId（增量首条的不变量检测）+ 整体透传 rebuildHistoryFromEntries（unknown[] 形参），
 * 不依赖 pi 原始 entry 全形状。
 */
type GetEntriesResult = { data?: { entries?: Array<{ parentId?: string | null }>; leafId?: string | null } }

/** 单个 session 的重建缓存条目。 */
export interface HistoryRebuildCacheEntry {
  /** 上次重建时 get_entries 响应的 leafId（增量拉取的 since 基准）。 */
  leafId: string | null
  /** 上次重建的全量消息（增量合并的基底）。 */
  messages: Message[]
  /** 上次重建的 truncated 标志（entry 树重建恒 false，保留字段对齐 getHistory 返回形状）。 */
  truncated: boolean
}

/**
 * 容量帽 = 最近 8 个 session（对齐 renderer LRU_MAX_SESSIONS）。
 * 只有可能被驱逐重进的 session 才值得缓存，超出 renderer LRU 窗口的缓存无消费者。
 */
const HISTORY_CACHE_MAX_SESSIONS = 8

/**
 * per-session 重建缓存（LRU，Map 插入序实现）。
 *
 * LRU 语义：get/set 命中时把 key 移到 Map 尾部（delete + set），超帽驱逐 Map 头部
 * （最久未访问）。与 renderer chat store 的 LRU 窗口对齐——被 renderer 驱逐的 session
 * 下次重进走全量重建，等价于「缓存从未存在」，行为退化为现状。
 */
export class HistoryRebuildCache {
  private readonly entries = new Map<string, HistoryRebuildCacheEntry>()

  constructor(private readonly maxSessions = HISTORY_CACHE_MAX_SESSIONS) {}

  /** 取缓存并刷新 LRU 位置。无缓存返回 undefined。 */
  get(sessionId: string): HistoryRebuildCacheEntry | undefined {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return undefined
    // LRU touch：移到 Map 尾部（最近使用）
    this.entries.delete(sessionId)
    this.entries.set(sessionId, entry)
    return entry
  }

  /** 写入/覆盖缓存条目（超帽驱逐最久未访问的 session 条目）。 */
  set(sessionId: string, entry: HistoryRebuildCacheEntry): void {
    if (this.entries.has(sessionId)) this.entries.delete(sessionId)
    this.entries.set(sessionId, entry)
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /** 删除单个 session 的缓存（session 删除 / pi 进程退出清理点）。 */
  delete(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  /** 当前缓存条目数（测试用）。 */
  get size(): number {
    return this.entries.size
  }
}

/**
 * 增量合并（D6-3）：缓存消息 + 增量消息按 piEntryId 去重合并。
 *
 * - 增量消息的 piEntryId 已在缓存中 → 跳过（不重复；pi 端 slice 已排除 since entry 本身，
 *   正常时序无重复，此去重是 compact/异常时序的防御性兜底）
 * - 新 piEntryId → 追加到尾部
 * - 无 piEntryId 的消息（理论上重建路径全带——entry-tree-builder 全路径传 entryIds；
 *   防御）→ 顺序追加 + debug 日志，保证消息不丢
 *
 * 去重身份是 piEntryId 而非 Message.id：重建消息的 id 由 core applyEntry reducer 从
 * entry 确定性派生（entry.id（真实 uuidv7）缺失时按喂入下标 `e<N>`，W20 起），跨两次
 * 重建无 entry id 的消息仍不保证稳定——按 Message.id 去重恒失效。renderer
 * prependHistoryMut（mutations.ts）是同语义的现成范式，此处是 runtime 侧复用。
 *
 * @returns 新数组（不修改入参），供直接写入缓存与返回
 */
export function mergeIncrementalMessages(cached: Message[], incremental: Message[]): Message[] {
  const seen = new Set<string>()
  for (const m of cached) {
    if (m.piEntryId !== undefined) seen.add(m.piEntryId)
  }
  const merged = [...cached]
  for (const m of incremental) {
    if (m.piEntryId === undefined) {
      // 防御：重建路径理论上全带 piEntryId。无 id 时宁可重复不可丢消息（append + 可见日志）。
      console.debug('[history-rebuild-cache] incremental message without piEntryId, appending defensively')
      merged.push(m)
      continue
    }
    if (seen.has(m.piEntryId)) continue
    seen.add(m.piEntryId)
    merged.push(m)
  }
  return merged
}

/**
 * SessionHistoryReader 装配依赖（窄注入，S5/D2 风格；原 Facade 字段直读的逐字等价面）。
 */
export interface SessionHistoryReaderDeps {
  /** pi 进程管理（getClient：活跃 session 走 RPC 重建，无 client 走尾读降级）。 */
  pm: IProcessManager
  /** session 存储端口（rebuildHistoryFromEntries 重建 / 尾读与全量文件读的转换链）。 */
  sessionStore: ISessionStore
}

/**
 * session 历史读编排（S6 迁出，原 Facade 方法逐字随迁）：getHistory 三分支重建 +
 * getFullHistory 文件直读。Facade 保留两方法一行委托（ISessionService 契约不变）；
 * 销毁清理经 onSessionDisposed 由 Facade removeSessionEntry 第 ⑤ 步直调
 * （与 traceSync/projection/records 并列）。
 */
export class SessionHistoryReader {
  /**
   * wave:perf-w20（D6）：per-session 历史重建缓存 + lastLeafId（LRU 容量帽 8）。
   * getHistory 命中缓存时走 getEntries(since=lastLeafId) 增量；onSessionDisposed
   * （session 删除 + pi 进程退出汇聚点）清除。纯派生数据，可随时丢弃退化为全量重建。
   */
  private readonly historyCache = new HistoryRebuildCache()
  /**
   * W20 review Fix-5：per-session getHistory inflight 复用。并发 getHistory 共享同一
   * promise（GitStateService inflightSnapshot 同款模式），消除「后完成者的旧 delta 与
   * 先完成者的新缓存交错写回」竞态。finally 清理，无泄漏。
   */
  private readonly inflightGetHistory = new Map<string, Promise<{ messages: Message[]; truncated: boolean }>>()

  constructor(private readonly deps: SessionHistoryReaderDeps) {}

  /**
   * 拉取 session 历史（wave:perf-w20 D6：重建缓存 + lastLeafId 增量）。
   *
   * 优先走 pi get_entries RPC + entry 树重建（rebuildHistoryFromEntries）：从完整 entry 树
   * （含 message + custom entry）重建 Message[]，按 clientUuid ↔ userEntryId 映射回填
   * 结构化 Segment[]（image/file/skill badge，读 segments.json sidecar）。
   *
   * 三分支（04-history-incremental.md §3.3）：
   * 1. 缓存命中 → getEntries(since=lastLeafId) 增量。空增量 = leafId 未变 = 缓存新鲜，
   *    直接返回缓存（R-12 短路：不走尾读 fallback）。pi 侧成本 = findIndex + 空/小窗口序列化，
   *    全量 entry 树序列化（主要卡顿源）被消除。
   * 2. 增量非空 → parentId 不变量校验（W20 review Fix-2：delta 首条 entry.parentId 必须等于
   *    缓存 leafId，branch 后不成立 → 丢缓存全量重建，防静默混合历史）→ 重建增量窗口 +
   *    piEntryId 去重合并入缓存（D6-3）+ 孤儿 toolResult 回填（W20 review Fix-1：窗口以
   *    toolResult 开头时配对失败的输出按 toolCallId 回填到缓存 assistant 的 toolCall）。
   * 3. 无缓存（首次进入 / LRU 驱逐重进 / "Entry not found" fallback / parentId 不变量 violation）
   *    → 全量重建 + 写缓存。
   *
   * 并发（W20 review Fix-5）：per-session inflight 复用，同 session 并发调用共享同一 promise。
   *
   * 错误处理（D6-4）：
   * - 增量报 "Entry not found"（pi 实测文案，E 大写 not 小写）→ 丢缓存 → 全量重拉。
   *   触发面：缓存跨 pi 进程存活且 session 文件被外部改写（D6-1 的 removeSessionEntry
   *   清理已结构性消除常态触发，此为防御兜底）。
   * - 其他错误（超时/pi 内部错误）→ 与现状同链降级（尾读），缓存不动（下次重试仍走 since）。
   *
   * R-12：pi RPC 成功但 entries 为空 → 短路返回空列表。pi 的 get_entries 是活跃 session
   * 的权威视图（内存 fileEntries，restore 时从文件加载），空就是空；尾读会给出与 RPC
   * 视图不一致的文件尾部（最多 20 turn），两次 getHistory 结果闪变。
   *
   * 返回 { messages, truncated }——truncated=true 仅出现在尾读降级路径（N1）。
   *
   * 返回值契约（终审 minor）：messages 是缓存/重建结果的**浅拷贝**（数组级隔离，调用方可
   * 安全就地变更）；Message 元素引用与缓存共享，仍受只读契约约束（深层拷贝在数百条消息
   * 量级下成本不可接受，元素级污染面仅限「调用方 mutate message 对象自身」）。
   */
  async getHistory(sessionId: string): Promise<{ messages: Message[]; truncated: boolean }> {
    // W20 review Fix-5：并发 getHistory 复用同一 inflight promise（同 session 共享一次
    // RPC + 重建 + 缓存写回），消除「后完成者的旧 delta 写回旧基线 / 覆盖先完成者结果」竞态。
    const inflight = this.inflightGetHistory.get(sessionId)
    if (inflight) return inflight
    const promise = this.doGetHistory(sessionId).finally(() => this.inflightGetHistory.delete(sessionId))
    this.inflightGetHistory.set(sessionId, promise)
    return promise
  }

  private async doGetHistory(sessionId: string): Promise<{ messages: Message[]; truncated: boolean }> {
    const client = this.deps.pm.getClient(sessionId)
    if (client) {
      // ── 分支 1/2：缓存命中 → since 增量 ──
      const cached = this.historyCache.get(sessionId)
      if (cached && cached.leafId !== null) {
        const incremental = await this.getIncrementalHistory(sessionId, client, cached)
        if (incremental) return incremental
      }
      // ── 分支 3：全量重建（无缓存 / D6-4 fallback / Fix-2 parentId 不变量 violation 丢缓存后）──
      try {
        const result = await client.getEntries() as GetEntriesResult
        const entries = result.data?.entries ?? []
        if (entries.length > 0) {
          // 读 segments.json sidecar（runtime 直接读文件，不经 IPC——IPC 是 renderer→main，runtime 是独立进程）。
          // 文件缺失/损坏 → null（rebuildHistoryFromEntries 全降级为占位文本，非硬错误）。
          const segmentsMetadata = await readSegmentsMetadataFile(sessionId)
          const rebuilt = this.deps.sessionStore.rebuildHistoryFromEntries(entries, segmentsMetadata)
          // leafId 是 session 当前叶子 entry id，记录为下次增量拉取的 since 基准（D6-1）。
          this.historyCache.set(sessionId, { leafId: result.data?.leafId ?? null, messages: rebuilt.messages, truncated: false })
          // entry 树重建返回全量历史（get_entries 不截断），truncated=false。
          // rebuilt.messages 已写入缓存，返回浅拷贝与缓存本体分离（终审 minor，同上防御）
          return { messages: rebuilt.messages.slice(), truncated: false }
        }
        // R-12：entries 空 → 短路返回空列表（pi RPC 是活跃 session 的权威视图，不走尾读）。
        return { messages: [], truncated: false }
      } catch (e) {
        console.warn(`[session-service] getHistory via getEntries failed: ${toErrorMessage(e)}, falling back to tail read`)
        return await getHistoryTailFromFile(sessionId, this.deps.sessionStore)
      }
    }
    // 无 RPC client（离线 session）：走尾读，避免大文件全量读（不读不写缓存——文件路径无 leafId 概念）
    return await getHistoryTailFromFile(sessionId, this.deps.sessionStore)
  }

  /**
   * 增量路径（doGetHistory 分支 1/2）：缓存命中时 getEntries(since=leafId) 增量拉取。
   *
   * 返回 undefined = 缓存已丢（parentId 不变量 violation / "Entry not found" fallback），
   * 调用方 fall-through 全量重建；返回结果 = 增量命中或尾读降级。
   */
  private async getIncrementalHistory(
    sessionId: string,
    client: NonNullable<ReturnType<IProcessManager['getClient']>>,
    cached: HistoryRebuildCacheEntry,
  ): Promise<{ messages: Message[]; truncated: boolean } | undefined> {
    try {
      const inc = await client.getEntries(cached.leafId as string) as GetEntriesResult
      const incEntries = inc.data?.entries ?? []
      if (incEntries.length === 0) {
        // R-12 短路：空增量 = leafId 未变 = 缓存新鲜。零重建直接返回（不走尾读 fallback）。
        console.log(`[session-service] getHistory cache fresh (empty delta) for ${sessionId}, returning ${cached.messages.length} cached messages`)
        // 终审 minor：返回浅拷贝而非缓存引用——调用方就地 sort/splice/push 会打穿缓存
        // 基底（增量合并的正确性依赖缓存未被污染）。元素级引用仍共享（只读契约，
        // 与 scanPiSessions 浅拷贝注释同边界）。
        return { messages: cached.messages.slice(), truncated: cached.truncated }
      }
      // W20 review Fix-2：parentId 不变量检测。pi append-only 下 delta 首条 entry 的
      // parentId 恒等于缓存基线 leafId（上次响应的叶子即本次增量的父）；branch
      // （pi rpc-mode 把 navigateTree 暴露给 extension command context）后新分支首条
      // parentId 是 branch 点，pi **不报错**但直接合并会静默产出「老分支尾 + 新分支」
      // 的混合历史（D6-4 的 "Entry not found" fallback 只覆盖 entry 消失场景）。
      // 不满足不变量 → 丢缓存 fall-through 全量重建（正确性优先，代价一次全量）。
      if (incEntries[0].parentId !== cached.leafId) {
        console.warn(
          `[session-service] getHistory incremental parent-id invariant violated for ${sessionId}: ` +
          `delta head parent=${String(incEntries[0].parentId)} != cached leafId=${cached.leafId} (branch/rewrite?), dropping cache and full rebuild`,
        )
        this.historyCache.delete(sessionId)
        return undefined
      }
      const segmentsMetadata = await readSegmentsMetadataFile(sessionId)
      const rebuilt = this.deps.sessionStore.rebuildHistoryFromEntries(incEntries, segmentsMetadata)
      const merged = mergeIncrementalMessages(cached.messages, rebuilt.messages)
      // W20 review Fix-1：增量窗口以 toolResult 开头（缓存 leafId 切在 assistant(toolCalls)
      // 与其 toolResults 之间——后台 session 生成中 getHistory 写缓存所致）时，convertPiHistory
      // 窗口局部配对失败的孤儿 toolResult 按 toolCallId 回填到缓存中 assistant 的 toolCall，
      // 工具输出不再静默丢失。
      if (rebuilt.orphanToolResults.length > 0) {
        applyOrphanToolResults(merged, rebuilt.orphanToolResults)
      }
      const newLeafId = inc.data?.leafId ?? null
      this.historyCache.set(sessionId, { leafId: newLeafId, messages: merged, truncated: false })
      console.log(`[session-service] getHistory incremental for ${sessionId}: ${incEntries.length} delta entries, merged ${cached.messages.length} -> ${merged.length} messages`)
      // merged 已写入缓存，返回浅拷贝与缓存本体分离（终审 minor，同上防御）
      return { messages: merged.slice(), truncated: false }
    } catch (e) {
      if (isEntryNotFoundError(e)) {
        // D6-4 fallback：since 失效（缓存基线不在 pi 当前 entry 集合）→ 丢缓存 → 全量重拉
        console.warn(`[session-service] getHistory incremental Entry-not-found for ${sessionId}, dropping cache and full rebuild`)
        this.historyCache.delete(sessionId)
        return undefined
      }
      // 其他错误：现有降级链（尾读），缓存不动（下次重试仍走 since）
      console.warn(`[session-service] getHistory via getEntries(since) failed: ${toErrorMessage(e)}, falling back to tail read`)
      return await getHistoryTailFromFile(sessionId, this.deps.sessionStore)
    }
  }

  /**
   * W4 H4：全量读取 session 历史（加载更多 fallback）。
   *
   * 与 getHistory 的区别：getHistory 优先走 RPC（pi client.getEntries entry 树重建），文件路径
   * fallback 走尾读（W1 tailReadHistory，只加载最近 20 turn）。本方法显式走全量
   * 文件读取（getHistoryFromFilePath），供前端「加载更多历史」按钮调用（FR-4）。
   */
  async getFullHistory(sessionId: string): Promise<Message[]> {
    // wave:perf-w26（D9-1 消费方分层，plan M-3）：路径解析消费方 force 旁路 TTL——
    // 刚落盘 session 的「加载更多」在 TTL 窗口内也不静默返回空。
    const target = this.deps.sessionStore.scanSessions({ force: true }).find((s) => s.id === sessionId)
    if (!target) return []
    return getHistoryFromFilePath(target.filePath, this.deps.sessionStore)
  }

  /**
   * 销毁清理（Facade removeSessionEntry 第 ⑤ 步直调，与 traceSync/projection/records
   * 的 onSessionDisposed 并列）：清历史重建缓存 + lastLeafId。pi 进程退出后缓存基线
   * （lastLeafId）不再与新进程的 entry 集合对应，保留只会走 "Entry not found" fallback。
   */
  onSessionDisposed(sessionId: string): void {
    this.historyCache.delete(sessionId)
  }
}

/**
 * 读 segments.json sidecar（runtime 直接读文件，不经 IPC）。
 *
 * IPC 的 writeSegmentsMetadata / readSegmentsMetadata 是 renderer→main 通道，runtime 是独立 Node 进程
 * （不持 electron app 句柄），不能走 IPC。runtime 直接读 <dataDir>/attachments/<sessionId>/segments.json。
 *
 * 文件缺失/损坏（JSON parse 失败 / entries 非数组）→ 返回 null（rebuildHistoryFromEntries 据此
 * 全降级为占位文本，非硬错误）。异步读：与周围 getEntries RPC / readFile 一致，sidecar 是小文件
 * （每条 user message 一条 entry）但统一走异步避免事件循环阻塞。
 */
async function readSegmentsMetadataFile(sessionId: string): Promise<SegmentsMetadataFile | null> {
  try {
    const filePath = join(getAttachmentsDir(sessionId), 'segments.json')
    if (!existsSync(filePath)) return null
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as SegmentsMetadataFile
    if (!parsed || !Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
  }
}
