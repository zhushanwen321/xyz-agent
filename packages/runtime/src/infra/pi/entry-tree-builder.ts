import type { Message, Segment, SegmentsMetadataFile } from '@xyz-agent/shared'
import type {
  PiSessionEntry,
  PiSessionMessageEntry,
  PiSessionCustomEntry,
} from './pi-protocol.js'
import { convertSinglePiMessage } from './message-converter.js'

/**
 * entry-tree-builder —— 从 pi get_entries 返回的 entry 树重建 xyz-agent Message[]。
 *
 * 背景：客户端 message 元数据映射框架（步骤 1-5）需要 runtime 从 pi get_entries RPC
 * 拿到完整 entry 树（含 message entry + custom entry），重建 Message[] 时按
 * userEntryId ↔ clientUuid 映射回填结构化 Segment[]（图片/文件/skill badge）。
 *
 * 与 convertPiHistory（消费 get_messages 扁平 message 列表）的区别：
 * - convertPiHistory：只看 message，无 entry 树信息，无法回填 badge（textToSegments 兜底纯文本）。
 * - rebuildHistoryFromEntries：用 custom entry "xyz.client-msg-id" 的 clientUuid 映射 +
 *   segments.json sidecar 的结构化 Segment[]，精确还原 composer 提交时的 badge 结构。
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
 * 两遍遍历（顺序无关，custom entry 可在 message entry 前或后）：
 *
 * 1. 第一遍建 clientUuidMap：扫所有 "xyz.client-msg-id" custom entry，
 *    data = { clientUuid, userEntryId } → map[userEntryId] = clientUuid。
 *    data 形状不匹配（缺字段/类型错）→ 跳过该 entry（降级，不崩溃）。
 *
 * 2. 第二遍转 message entry + 回填 segments：
 *    - message entry → convertSinglePiMessage(message, { entryId }) 产出 Message（含 piEntryId）
 *    - user message 且 clientUuidMap[entry.id] 命中 → 查 segmentsMetadata[clientUuid]
 *      → 命中且非空：msg.content = segments（完整结构化 Segment[]，含 image badge）
 *      → 未命中：保持 convertSinglePiMessage 默认产出（textToSegments / parseSkillBlock）
 *    - 非 message entry（label/summary/其他 custom）→ 跳过（未来扩展点）
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
  // 1. 第一遍：建 clientUuidMap（userEntryId → clientUuid）
  const clientUuidMap = new Map<string, string>()
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === CLIENT_MSG_ID_TYPE) {
      const data = entry.data as Partial<ClientMsgIdData> | null | undefined
      // 防御：data 可能是任意形状（pi 不校验 custom entry data），字段类型不对就跳过
      if (data && typeof data.clientUuid === 'string' && typeof data.userEntryId === 'string') {
        clientUuidMap.set(data.userEntryId, data.clientUuid)
      }
    }
  }

  // 2. 第二遍：转 message entry + 回填 segments
  // segmentsMetadata → clientUuid → Segment[] 索引（避免每次线性查找）
  const segmentsByClientUuid = new Map<string, Segment[]>()
  if (segmentsMetadata) {
    for (const e of segmentsMetadata.entries) {
      segmentsByClientUuid.set(e.clientUuid, e.segments)
    }
  }

  const messages: Message[] = []
  for (const entry of entries) {
    // 只处理 message entry；label/summary/其他 custom 当前跳过（未来扩展点）
    if (entry.type !== 'message') continue

    const messageEntry = entry as PiSessionMessageEntry
    const msg = convertSinglePiMessage(messageEntry.message, { entryId: messageEntry.id })
    // convertSinglePiMessage 对未知 role 返回 null（跳过）；message entry 的 role 正常是
    // user/assistant/toolResult，toolResult 经 convertSinglePiMessage 内部判定 role!==user&&!==assistant → null。
    // 故 toolResult message entry 在此被跳过（与 convertPiHistory 的 toolResult 合并逻辑不同——
    // entry 树重建不合并 toolResult 到 assistant toolCall，那是 convertPiHistory 的职责；
    // 本函数面向"回填 user message badge"场景，toolResult badge 无意义故跳过）。
    if (!msg) continue

    // user message 且有 clientUuid 映射 → 回填完整结构化 segments（含 image/file/skill badge）
    if (msg.role === 'user' && messageEntry.id) {
      const clientUuid = clientUuidMap.get(messageEntry.id)
      if (clientUuid) {
        const segments = segmentsByClientUuid.get(clientUuid)
        // segments 非空才覆盖（空 segments 不覆盖默认产出，避免把有效 textToSegments 结果清空）
        if (segments && segments.length > 0) {
          msg.content = segments
        }
      }
    }
    messages.push(msg)
  }

  return { messages, clientUuidMap }
}

// ── 类型 re-export（供 services 层按需引用，不直接碰 pi-protocol） ─────
// PiSessionCustomEntry 此处 re-export 仅为消费侧断言 custom entry data 时可选引用；
// 当前无消费点（重建逻辑封装在本文件内），保留以备 services 层未来直接读 custom entry。
export type { PiSessionCustomEntry }
