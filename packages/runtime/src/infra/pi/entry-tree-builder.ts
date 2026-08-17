import type { Message, Segment, SegmentsMetadataFile } from '@xyz-agent/shared'
import type { PiSessionEntry, PiHistoryToolResult } from './pi-protocol.js'
import { convertPiHistory } from './message-converter.js'
import { mapSessionEntries } from './session-entry-mapper.js'

/**
 * entry-tree-builder —— 从 pi get_entries 返回的 entry 树重建 xyz-agent Message[]。
 *
 * 背景：客户端 message 元数据映射框架（步骤 1-5）需要 runtime 从 pi get_entries RPC
 * 拿到完整 entry 树（含 message entry + custom entry），重建 Message[] 时按
 * userEntryId ↔ clientUuid 映射回填结构化 Segment[]（图片/文件/skill badge）。
 *
 * 与 convertPiHistory（消费 get_messages 扁平 message 列表）的关系：
 * - 复用 convertPiHistory 做 message→Message 翻译（含 toolResult 合并 / compactionSummary /
 *   custom / branchSummary 系统消息处理），保证与 RPC/文件路径行为一致（规则 7.5）。
 * - 额外能力：用 custom entry "xyz.client-msg-id" 的 clientUuid 映射 +
 *   segments.json sidecar 的结构化 Segment[]，精确还原 composer 提交时的 badge 结构
 *   （convertPiHistory 路径无 entry 树信息，只能用 textToSegments 兜底纯文本）。
 *
 * 🔒 归属（R1，三层架构）：infra/pi 层内部，消费 pi 协议类型（PiSessionEntry），
 * 产出 xyz-agent 内部类型（Message）。services 层调本函数，不直接碰 pi entry 类型。
 */

/** xyz-agent extension 写入的 client-msg-id custom entry 的 data 结构。 */
interface ClientMsgIdData {
  clientUuid: string
  userEntryId: string
}

/**
 * segments.json sidecar 的结构（步骤 3 定义在 shared，这里先声明依赖）。
 *
 * 每个 user message 提交时落盘一份，clientUuid 关联到 custom entry 的 clientUuid，
 * segments 是 composer DOM 产出的完整结构化 Segment[]（含 image/file/skill/text）。
 */
// SegmentsMetadataFile 类型从 @xyz-agent/shared 导入（SSOT，与 sidecar IPC 共用）。

/** entry 树重建结果。 */
export interface RebuiltHistory {
  messages: Message[]
  /** userEntryId → clientUuid 映射（来自 "xyz.client-msg-id" custom entry）。 */
  clientUuidMap: Map<string, string>
  /**
   * 窗口内无法配对的孤儿 toolResult（W20 review Fix-1）。全量窗口正常时序恒空；
   * 增量窗口以 toolResult 开头（缓存 leafId 切在 assistant(toolCalls) 与其 toolResults
   * 之间）时非空——调用方（session-service 增量合并）应把它回填到缓存消息的 toolCall。
   *
   * 类型收 unknown[]（与 entries 入参同模式）：pi 结构（PiHistoryToolResult）不越过
   * port 边界，消费方透传给 message-converter 的 applyOrphanToolResults。
   */
  orphanToolResults: unknown[]
}

/**
 * xyz-client-msg-id extension 写入的 customType 常量。
 *
 * 与 extension 实现的 customType 字符串严格一致（步骤 1 的 xyz-client-msg-id-mapper extension）。
 * 改名需同步 extension 端 + 测试。xyz. 前缀是 xyz-agent namespace 约定，避免与 pi/其他扩展冲突。
 */
const CLIENT_MSG_ID_TYPE = 'xyz.client-msg-id'

/**
 * 从 pi get_entries 返回的 entry 树重建 xyz-agent Message[]。
 *
 * 三步（两遍扫 entry + 一遍回填）：
 *
 * 1. mapSessionEntries 统一映射 entry 树（共享单点，与文件路径共用）：
 *    message/compaction/custom_message/branch_summary → messages 伪消息（供 convertPiHistory 消费），
 *    custom → customDataEntries（下方建 clientUuidMap 用），label/session_info 跳过。
 *    同时产出与 messages 平行对齐的 entryIds（替代旧 __entryId 注入）。
 *
 * 2. clientUuidMap 从 customDataEntries 建：扫 xyz.client-msg-id custom entry，
 *    data = { clientUuid, userEntryId } → map[userEntryId] = clientUuid。
 *    data 形状不匹配（缺字段/类型错）→ 跳过该 entry（降级，不崩溃）；冲突 warn 防御保留。
 *
 * 3. 整个 message 列表走 convertPiHistory（复用 toolResult 合并 + compactionSummary /
 *    custom / branchSummary 系统消息处理），产出 Message[]。entryIds 平行传入，使产出的
 *    user/assistant Message 带 piEntryId（从 entryIds[i] 取）。
 *    ⚠️ M2 前 RPC 路径手写两遍扫只提取 message entry，丢弃 compaction/branch/custom_message，
 *    导致活跃 session 重开时这三类记录消失（违反 AGENTS.md #7.5「可重开恢复」）；
 *    改用共享 mapper 后两路径覆盖 by construction 一致。
 *
 * 4. 回填 segments：对 user message 按 piEntryId 查 clientUuidMap → 查 segmentsMetadata
 *    → 命中且非空：msg.content = segments（完整结构化 Segment[]，含 image badge）
 *    → 未命中：保持 convertPiHistory 默认产出（textToSegments / parseSkillBlock）
 *
 * 降级原则：映射缺失 / segmentsMetadata 缺失 / segments 为空 → 不阻断，保持默认产出。
 * 这保证即使 extension 未写入 custom entry 或 sidecar 丢失，历史仍可读（纯文本降级）。
 *
 * @param entries pi get_entries 返回的 entries 数组（全量或 since 增量）
 * @param segmentsMetadata segments.json sidecar（null 表示无 sidecar，全降级）
 */
export function rebuildHistoryFromEntries(
  entries: PiSessionEntry[],
  segmentsMetadata: SegmentsMetadataFile | null,
): RebuiltHistory {
  // 1. mapSessionEntries 统一映射（共享单点，M2 接入）。
  //    四类 entry（message/compaction/custom_message/branch_summary）→ messages 伪消息，
  //    供 convertPiHistory 单点消费（AGENTS.md 规则 7.5：RPC/文件两路径覆盖一致）；
  //    custom → customDataEntries（下方建 clientUuidMap 用）；label/session_info 等跳过。
  //    替代旧手写两遍扫（旧实现只提取 message entry，丢弃 compaction/branch/custom_message，
  //    导致活跃 session 重开时这三类记录消失——违反规则 7.5「可重开恢复」）。
  const { messages, entryIds, customDataEntries } = mapSessionEntries(entries)

  // 2. clientUuidMap 从 customDataEntries 建（扫 xyz.client-msg-id custom entry）。
  //    data = { clientUuid, userEntryId } → map[userEntryId] = clientUuid。
  //    data 形状不匹配（缺字段/类型错）→ 跳过该 entry（降级，不崩溃）。
  //    冲突 warn 防御保留（extension 重试/重发场景，同一 userEntryId 多条 custom entry，
  //    后写覆盖前写；概率低但冲突时 warn 让问题可见，不阻断——错配只会导致 badge 回填到错误
  //    user message，非崩溃）。
  const clientUuidMap = new Map<string, string>()
  for (const entry of customDataEntries) {
    if (entry.customType !== CLIENT_MSG_ID_TYPE) continue
    const data = entry.data as Partial<ClientMsgIdData> | null | undefined
    if (data && typeof data.clientUuid === 'string' && typeof data.userEntryId === 'string') {
      const existing = clientUuidMap.get(data.userEntryId)
      if (existing !== undefined && existing !== data.clientUuid) {
        console.warn(
          `[entry-tree-builder] clientUuidMap conflict for userEntryId=${data.userEntryId}: ` +
          `existing=${existing}, new=${data.clientUuid} (later wins)`,
        )
      }
      clientUuidMap.set(data.userEntryId, data.clientUuid)
    }
  }

  // 3. 整个数组走 convertPiHistory（复用 toolResult 合并 + 系统消息完整处理，C1 修复核心）。
  //    entryIds 与 messages 一一对应平行传入，使产出的 user/assistant Message 带 piEntryId
  //    （从 entryIds[i] 取，供下方第 4 步回查 clientUuidMap + segmentsMetadata 回填 badge）。
  //    孤儿 toolResult 收集（W20 review Fix-1）：增量窗口以 toolResult 开头时窗口局部
  //    配对失败，收集后由增量合并阶段回填到缓存中的 assistant toolCall。
  const orphanToolResults: PiHistoryToolResult[] = []
  const converted = convertPiHistory(messages, entryIds, orphanToolResults)

  // 4. 回填 segments：对 user message 按 piEntryId 查 clientUuidMap → segmentsMetadata
  const segmentsByClientUuid = new Map<string, Segment[]>()
  if (segmentsMetadata) {
    for (const e of segmentsMetadata.entries) {
      segmentsByClientUuid.set(e.clientUuid, e.segments)
    }
  }
  for (const msg of converted) {
    if (msg.role === 'user' && msg.piEntryId) {
      const clientUuid = clientUuidMap.get(msg.piEntryId)
      if (clientUuid) {
        const segments = segmentsByClientUuid.get(clientUuid)
        // segments 非空才覆盖（空 segments 不覆盖默认产出，避免把有效 textToSegments 结果清空）
        if (segments && segments.length > 0) {
          msg.content = segments
        }
      }
    }
  }

  return { messages: converted, clientUuidMap, orphanToolResults }
}
