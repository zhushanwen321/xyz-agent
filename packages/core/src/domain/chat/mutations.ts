/**
 * messages ref 的写入 helper（W1 shallowRef 适配 → W10 D-1 容器范式升级）。
 *
 * 背景（D-1，07 文档 §3.3）：messages 是 `ShallowRef<Map<string, ShallowRef<Message[]>>>`
 * ——外层 Map 恒等稳定（只在增删 sid key 时替换），每个 sid 持有独立的内层 ShallowRef。
 * 同 sid commit 只替换该分区的内层 ref（`existing.value = next`），A session 更新不再让
 * 依赖 B session 分区的 watcher / computed 失效（Map 整体替换的连带重算被消除）。
 *
 * 不变式（07 文档 §3.3.2）：
 * 1. 外层 Map 引用只在「增删 sid key」时替换；sid 已存在时 commit 只替换 existing.value。
 * 2. 每 sid 的分区 ref 一旦创建（首次 commit），引用在 session 存活期间稳定。
 *
 * 浅代理边界对齐 ADR-0039：浅到「外层 Map + 每 sid 数组」两层，内层用 shallowRef
 * （Message 对象本身不代理；用 ref 会深代理整条数组，违反 ADR-0039）。
 */

import { shallowRef, type ShallowRef } from 'vue'
import type { Message } from '@xyz-agent/shared'

/** messages ref 的结构类型（兼容 Vue Ref 与裸 { value } 结构）。 */
export type MessagesRef = { value: Map<string, ShallowRef<Message[]>> }

/**
 * 写入：同 sid 替换该分区内层 ref（外层 Map 引用不变，恒等稳定）；
 * 首次建 key（含 subagent:* 与 agentcall:* 虚拟 session 动态 id）替换外层 Map
 * （增删 session 是外层 Map 替换的唯一触发点）。
 */
export function commitMessages(
  messages: MessagesRef,
  sessionId: string,
  next: Message[],
): void {
  const existing = messages.value.get(sessionId)
  if (existing) {
    existing.value = next
  } else {
    messages.value = new Map(messages.value).set(sessionId, shallowRef(next))
  }
}

/**
 * 不可变删除：构造新 Map，delete 后整体赋值 .value（减 key 的合法 Map 替换情形）。
 * LRU 驱逐（lru.deleteMessageKey）/ disposeSession 经此或等价的 Map 替换路径。
 *
 * 类型参数 V 默认 ShallowRef<Message[]>，但允许泛化（lru 的 deps 用 Map<string, unknown> 宽类型）。
 */
export function deleteMessages<V = ShallowRef<Message[]>>(messages: { value: Map<string, V> }, sessionId: string): void {
  const next = new Map(messages.value)
  next.delete(sessionId)
  messages.value = next
}

/**
 * 截断 session 消息到 messageId（模块级，从 chat.ts 移入控制行数）。
 * inclusive=true 含 messageId，false 仅其后。findIndex 定位，slice 不可变更新。
 */
export function truncateMessagesFrom(
  messages: MessagesRef,
  sessionId: string,
  messageId: string,
  inclusive: boolean,
): void {
  const prev = messages.value.get(sessionId)?.value ?? []
  const idx = prev.findIndex((m) => m.id === messageId)
  if (idx === -1) return
  const end = inclusive ? idx : idx + 1
  commitMessages(messages, sessionId, prev.slice(0, end))
}

/**
 * W4 H4：全量历史去重合并到列表头部（模块级，从 chat.ts 移入控制行数）。
 *
 * [W5 D5] id 去重从「正确性依赖」降级为「兜底断言 + 安全网」：
 * live 侧 id（`u-`/`e<N>`/`bash-` 前缀混合）与文件侧 id（entry 派生 pi uuidv7）是两个
 * **永不相等**的 id 空间——此前把它当正确性依赖，导致活跃 session load-more 时 live 消息
 * 的文件对应物全部被误判为「新消息」重复前插（机制 5）。现在正确性由调用方
 * （useChat.loadMoreHistory）的锚定切分承担，本函数只做最后的安全网：命中重复即
 * console.warn（说明锚切分异常或锚降级兜底触发），行为仍去重（宁可少插不可重插）。
 */
export function prependHistory(
  messages: MessagesRef,
  sessionId: string,
  fullHistory: Message[],
): void {
  const prev = messages.value.get(sessionId)?.value ?? []
  const existingIds = new Set(prev.map((m) => m.id))
  const newMsgs = fullHistory.filter((m) => !existingIds.has(m.id))
  const dedupedCount = fullHistory.length - newMsgs.length
  if (dedupedCount > 0) {
    console.warn(
      `[mutations] prependHistory deduped ${dedupedCount} message(s) already present in session ${sessionId}` +
        ' — anchor split did not exclude them (degraded anchor path or anchor missing; see splitHistoryBeforeAnchor)',
    )
  }
  if (newMsgs.length === 0) return
  commitMessages(messages, sessionId, [...newMsgs, ...prev])
}

// ── W5 D5：load-more 锚定切分 ────────────────────────────────────────────────

/** 锚定位结果：exact = piEntryId/id 精确命中；fingerprint = 内容指纹降级命中；none = 零匹配。 */
export type AnchorSplitStrategy = 'exact' | 'fingerprint' | 'none'

/** splitHistoryBeforeAnchor 返回：segment = 只该前插的段；none 时 = 全量（语义退回 id 去重兜底）。 */
export interface AnchorSplitResult {
  segment: Message[]
  strategy: AnchorSplitStrategy
}

/**
 * 消息内容指纹：role + 首段文本归一 + timestamp（D5 降级路径用）。
 *
 * 「首段文本」：content 为 string 时取全文；为 Segment[] 时取首个 text segment 的 text
 * （skill/file/image 等 chip 段不含正文）。两侧（hydrate 尾窗 / 文件全量）的 timestamp 均
 * 从同一 entry ISO timestamp 派生（ms 整数精确往返：mapSessionEntries toMs →
 * liftHistoryToEntries ms→ISO → reducer toMs），故直接用全等比较。
 */
function messageFingerprint(m: Message): string {
  let firstText: string
  if (typeof m.content === 'string') {
    firstText = m.content
  } else {
    const first = m.content.find((s) => s.type === 'text')
    firstText = first?.type === 'text' ? first.text : ''
  }
  return `${m.role}|${firstText.trim()}|${m.timestamp}`
}

/**
 * [W5 D5] 按 hydrate 尾窗锚切分全量历史：只返回锚之前的段，锚及之后的段整段跳过。
 *
 * 为什么需要锚切分：store 在活跃 session 中混合两类消息——hydrate 注入的文件侧消息
 * （id = entry 派生 uuidv7）与 live 消息（id = `u-`/`e<N>`/`bash-` 前缀）。getFullHistory
 * 返回的全量里，锚之后的段既包含已 hydrate 的消息（id 恰好相等，旧去重碰巧能挡住），
 * 也包含 live 消息的文件对应物（id 永不相等，旧去重必漏 → 重复前插、分组错乱）。
 * 锚 = hydrate 尾窗首条的 entry 身份，它之前的段必然不在 store 中，可无脑前插。
 *
 * 三级定位：
 * 1. exact：`m.piEntryId === anchorId || m.id === anchorId`（对称取值 `piEntryId ?? id`——
 *    user/assistant 消息带 piEntryId；system 族消息 id 即 entry 派生 uuidv7，无 piEntryId 字段）。
 * 2. fingerprint：锚 id miss（锚 entry 已被外部改写等异常）时按 `messageFingerprint`
 *    定位，取**最后一个**匹配位（最接近尾窗，与 hydrate 尾窗语义一致；多条同指纹时
 *    取首个会多前插一段已存在的历史）。
 * 3. none：两路均未命中——segment 返回全量，调用方 console.warn 后走 prependHistory
 *    的 id 去重兜底（退化为现状水平：hydated 部分能挡、live 对应物会重复，不崩溃）。
 *
 * 探针 ③ 结论（决定兜底路径真实触发率，对 0.84.1 dist 实测）：
 * pi session 文件是 **append-only**（session-manager.js `_appendEntry`→`_persist`→
 * `appendFileSync`，:754-758/:724-752）；compaction 只 append 一条 `type:'compaction'`
 * entry（`appendCompaction` :802-813，agent-session.js :1432/:1670 调用，带 firstKeptEntryId），
 * **不从文件删除被摘要的 entry、entry id 不变**——compaction 过滤只发生在发 LLM 的
 * `buildContextEntries`（:191-220），`getEntries()` 与 `get_entries` RPC（rpc-mode.js :504）
 * 均返回全量文件 entries。`_rewriteFile` 仅三处调用：文件空初始化 header（:627）、
 * v1→v2/v3 版本迁移（:634，migrateV1ToV2 会重新生成 id，仅影响 version 1 旧文件）、
 * createBranchedSession（写**新**文件不动原文件）。故 exact 路径在 compaction 后仍然
 * 命中，fingerprint/none 兜底的真实触发率 ≈ 0（仅剩 v1 旧文件迁移重写 id 等极端场景）。
 *
 * @param fullHistory getFullHistory 返回的全量（文件侧，id 均为 entry 派生）
 * @param anchorId hydrate 尾窗首条的 `piEntryId ?? id`（store.hydrate 记录）；undefined = 无锚
 * @param anchorSource 锚消息当前形态（store 最旧消息，load-more 时 = hydrate 尾窗首条），
 *   仅 fingerprint 降级用；exact 路径不依赖
 */
export function splitHistoryBeforeAnchor(
  fullHistory: Message[],
  anchorId: string | undefined,
  anchorSource: Message | undefined,
): AnchorSplitResult {
  // 1. exact：piEntryId 优先，id 兜底（system 族消息无 piEntryId 字段但 id 即 entry uuidv7）
  if (anchorId !== undefined) {
    const exactIdx = fullHistory.findIndex(
      (m) => m.piEntryId === anchorId || m.id === anchorId,
    )
    if (exactIdx >= 0) return { segment: fullHistory.slice(0, exactIdx), strategy: 'exact' }
  }
  // 2. fingerprint：role + 首段文本归一 + timestamp，取最后一个匹配位
  if (anchorSource !== undefined) {
    const fp = messageFingerprint(anchorSource)
    for (let i = fullHistory.length - 1; i >= 0; i--) {
      if (messageFingerprint(fullHistory[i]) === fp) {
        return { segment: fullHistory.slice(0, i), strategy: 'fingerprint' }
      }
    }
  }
  // 3. none：全量返回，调用方 warn + id 去重兜底
  return { segment: fullHistory, strategy: 'none' }
}
