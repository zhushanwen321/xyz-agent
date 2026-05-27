/**
 * Reads pi JSONL session files and builds a tree structure.
 *
 * Pure file parsing — no RPC dependency. Designed for the session-tree
 * feature to construct a navigable tree from pi's session history.
 *
 * JSONL format:
 * - Line 1: { type: "session", ... }  (header, skipped)
 * - Subsequent lines: entries with id/parentId forming a tree
 * - Label entries: { type: "label", targetId, label } — applied to target nodes
 * - Message entries: { type: "message", message: { role, content: [...] } }
 */

import { readFile } from 'node:fs/promises'
import type { TreeNode } from './types.js'

// ── Content block shapes from pi JSONL ─────────────────────────────

interface TextBlock {
  type: 'text'
  text: string
}

interface ThinkingBlock {
  type: 'thinking'
  thinking: string
}

interface ToolCallBlock {
  type: 'toolCall' | 'tool_use'
  name: string
}

type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | Record<string, unknown>

// ── Raw JSONL entry shapes ─────────────────────────────────────────

interface RawEntry {
  id: string
  parentId?: string | null
  type: string
  timestamp?: string
  // message entries
  message?: {
    role: string
    content?: string | ContentBlock[]
  }
  // label entries
  targetId?: string
  label?: string
  text?: string
}

interface BuildTreeResult {
  byId: Map<string, TreeNode>
  rootNodes: TreeNode[]
  labelsById: Map<string, string>
  /** 最后一条 entry 的 id（近似 leafId，pi 不暴露真实 leafId 时使用） */
  lastEntryId: string | null
  /** 原始 JSONL entry map（用于提取完整文本等场景，TreeNode.text 是截断预览） */
  rawEntries: Map<string, RawEntry>
}

// ── Constants ──────────────────────────────────────────────────────

/** Max characters for extracted text preview. */
const TEXT_PREVIEW_MAX = 100

// ── Public API ─────────────────────────────────────────────────────

/**
 * Parse a pi JSONL session file and build the tree structure.
 *
 * @param filePath - Absolute path to a `.jsonl` session file.
 * @returns Tree data: node map, root nodes, and label map.
 */
export async function buildTreeFromFile(filePath: string): Promise<BuildTreeResult> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    // 文件可能不存在（pi 延迟写入：assistant 消息到达前不会 flush session 文件）
    return { byId: new Map(), rootNodes: [], labelsById: new Map(), lastEntryId: null, rawEntries: new Map() }
  }
  const lines = raw.split('\n')

  const byId = new Map<string, TreeNode>()
  const labelsById = new Map<string, string>()

  // Two-pass: first collect labels, then build nodes.
  // This ensures labels are available when building nodes.
  const entries: RawEntry[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let entry: RawEntry
    try {
      entry = JSON.parse(trimmed) as RawEntry
    } catch {
      // Skip malformed lines
      continue
    }

    // Skip session header
    if (entry.type === 'session') continue

    // Collect label entries for the label map
    if (entry.type === 'label' && entry.targetId && entry.label) {
      labelsById.set(entry.targetId, entry.label)
    }

    entries.push(entry)
  }

  // Build TreeNode for each entry + 保留原始 entry map（用于提取完整文本）
  const rawEntries = new Map<string, RawEntry>()
  for (const entry of entries) {
    rawEntries.set(entry.id, entry)
    const node: TreeNode = {
      id: entry.id,
      parentId: entry.parentId ?? null,
      type: entry.type,
      text: extractText(entry),
      timestamp: entry.timestamp ?? '',
      children: [],
    }

    // Extract role from message entries
    if (entry.type === 'message' && entry.message?.role) {
      node.role = entry.message.role
    }

    // Apply label if one targets this entry
    const label = labelsById.get(entry.id)
    if (label) {
      node.label = label
    }

    byId.set(entry.id, node)
  }

  // 最后一条 message entry 的 id（pi 的 leafId fallback）
  // 注意：不使用 entries 最后一项，因为 JSONL 中可能有多棵树，
  // 最后一棵可能全是 model_change/thinking_level_change，没有实际消息。
  // 遍历所有 entry，找到最后一个 type=message 的作为 leafId 近似值。
  let lastEntryId: string | null = null
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === 'message') {
      lastEntryId = entries[i]!.id
      break
    }
  }

  // Build parent-child relationships and identify roots
  const rootNodes: TreeNode[] = []

  for (const node of byId.values()) {
    if (node.parentId === null || node.parentId === node.id) {
      rootNodes.push(node)
    } else {
      const parent = byId.get(node.parentId)
      if (parent) {
        parent.children.push(node)
      } else {
        // Orphan — parent doesn't exist, treat as root
        rootNodes.push(node)
      }
    }
  }

  // Sort children by timestamp (oldest first)
  sortChildrenRecursive(rootNodes)

  return { byId, rootNodes, labelsById, lastEntryId, rawEntries }
}

/**
 * Compute the active path from a leaf node to the root.
 *
 * @param byId - The node map from buildTreeFromFile.
 * @param leafId - The leaf entry ID to trace from.
 * @returns Set of all node IDs on the path (inclusive of leaf and root).
 */
export function computeActivePath(byId: Map<string, TreeNode>, leafId: string): Set<string> {
  const path = new Set<string>()
  let current: string | null = leafId

  while (current !== null) {
    path.add(current)
    const node = byId.get(current)
    if (!node) break
    current = node.parentId
    // Guard against cycles
    if (current !== null && path.has(current)) break
  }

  return path
}

/**
 * 从原始 entry 中提取完整的用户消息文本（不截断）。
 * 用于 navigate 到 user message 时预填编辑器。
 */
export function extractFullText(entry: RawEntry): string | undefined {
  if (entry.type !== 'message' || !entry.message?.content) return undefined
  const content = entry.message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  return content
    .filter((b): b is TextBlock => typeof b === 'object' && b !== null && b.type === 'text' && 'text' in b)
    .map(b => b.text)
    .join('\n') || undefined
}

/**
 * Count branch points in the tree (nodes with >1 children).
 *
 * @param rootNodes - Root nodes of the tree.
 * @returns Number of branch points.
 */
export function countBranches(rootNodes: TreeNode[]): number {
  let count = 0
  const stack = [...rootNodes]

  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.children.length > 1) {
      count++
    }
    stack.push(...node.children)
  }

  return count
}

// ── Internal helpers ───────────────────────────────────────────────

/**
 * Extract a text preview from a raw entry.
 * For message entries: extracts first line from the first text block in content.
 * For label entries: uses the label text.
 * For other entries: empty string.
 */
function extractText(entry: RawEntry): string {
  if (entry.type === 'label') {
    return truncateToFirstLine(entry.label ?? entry.text ?? '')
  }

  if (entry.type !== 'message' || !entry.message?.content) {
    return ''
  }

  const content = entry.message.content

  // Content can be a string (old format?) or array of blocks
  if (typeof content === 'string') {
    return truncateToFirstLine(content)
  }

  if (!Array.isArray(content)) return ''

  // Find the first text block
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      'type' in block
    ) {
      const typed = block as ContentBlock
      if (typed.type === 'text' && 'text' in typed) {
        return truncateToFirstLine((typed as TextBlock).text)
      }
    }
  }

  return ''
}

/** Take the first line and truncate to TEXT_PREVIEW_MAX characters. */
function truncateToFirstLine(text: string): string {
  if (!text) return ''
  const firstLine = text.split('\n')[0] ?? ''
  if (firstLine.length <= TEXT_PREVIEW_MAX) return firstLine
  return firstLine.slice(0, TEXT_PREVIEW_MAX) + '...'
}

/** Iterative sort of children by timestamp across the whole tree. */
function sortChildrenRecursive(rootNodes: TreeNode[]): void {
  const stack = [...rootNodes]
  while (stack.length > 0) {
    const node = stack.pop()!
    node.children.sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
    )
    stack.push(...node.children)
  }
}
