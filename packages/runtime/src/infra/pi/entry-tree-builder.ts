import type { Message, Segment, SegmentsMetadataFile } from '@xyz-agent/shared'
import type {
  PiSessionEntry,
  PiSessionMessageEntry,
  PiSessionCustomEntry,
  PiHistoryMessage,
} from './pi-protocol.js'
import { convertPiHistory } from './message-converter.js'

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
 * 1. 第一遍扫 entries：
 *    a) 建 clientUuidMap：扫所有 "xyz.client-msg-id" custom entry，
 *       data = { clientUuid, userEntryId } → map[userEntryId] = clientUuid。
 *       data 形状不匹配（缺字段/类型错）→ 跳过该 entry（降级，不崩溃）。
 *    b) 从所有 message entry 提取 message 字段 + entryId（保持原始顺序，一一对应）。
 *
 * 2. 整个 message 列表走 convertPiHistory（复用 toolResult 合并 + compactionSummary /
 *    custom / branchSummary 系统消息处理），产出 Message[]。entryIds 与 messages 一一对应
 *    传入，使产出的 user/assistant Message 带 piEntryId（从 entryIds[i] 取）。
 *    ⚠️ 这是 C1 修复核心：之前直接调 convertSinglePiMessage 绕过了 convertPiHistory 的
 *    toolResult/系统消息处理，导致重开 session 时工具输出 / 压缩记录 / bg-notify / 分支摘要
 *    全部丢失（违反 AGENTS.md #7.5）。
 *
 * 3. 回填 segments：对 user message 按 piEntryId 查 clientUuidMap → 查 segmentsMetadata
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
  // 1. 第一遍：建 clientUuidMap + 从 message entry 提取 message 列表（顺序保留，带 entryId）
  const clientUuidMap = new Map<string, string>()
  const messages: PiHistoryMessage[] = []
  const entryIds: string[] = []
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === CLIENT_MSG_ID_TYPE) {
      const data = entry.data as Partial<ClientMsgIdData> | null | undefined
      // 防御：data 可能是任意形状（pi 不校验 custom entry data），字段类型不对就跳过
      if (data && typeof data.clientUuid === 'string' && typeof data.userEntryId === 'string') {
        clientUuidMap.set(data.userEntryId, data.clientUuid)
      }
      continue
    }
    if (entry.type === 'message') {
      const messageEntry = entry as PiSessionMessageEntry
      messages.push(messageEntry.message)
      entryIds.push(messageEntry.id)
    }
    // 非 message 非 xyz.client-msg-id entry（label/summary/其他 custom）→ 跳过（未来扩展点）
  }

  // 2. 整个数组走 convertPiHistory（复用 toolResult 合并 + 系统消息完整处理，C1 修复核心）
  const converted = convertPiHistory(messages, entryIds)

  // 3. 回填 segments：对 user message 按 piEntryId 查 clientUuidMap → segmentsMetadata
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

  return { messages: converted, clientUuidMap }
}

// ── 类型 re-export（供 services 层按需引用，不直接碰 pi-protocol） ─────
// PiSessionCustomEntry 此处 re-export 仅为消费侧断言 custom entry data 时可选引用；
// 当前无消费点（重建逻辑封装在本文件内），保留以备 services 层未来直接读 custom entry。
export type { PiSessionCustomEntry }
