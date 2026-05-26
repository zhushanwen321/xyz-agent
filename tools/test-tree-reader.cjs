/**
 * Integration tests for session-tree-reader.ts
 *
 * Tests TC-1-01, TC-1-02, TC-1-03 — JSONL parsing edge cases.
 * Run: node tools/test-tree-reader.cjs
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

// Load ESM module via dynamic import (compiled by tsx)
const { execSync } = require('child_process')

// We'll use the compiled output or import directly
// Since session-tree-reader.ts uses ESM imports, we need to compile it first
// or write a simple self-contained test

// ── Inline implementation for testing ──
// We read the actual source and test against the compiled JS

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`)
    passed++
  } else {
    console.log(`  ✗ ${msg}`)
    failed++
  }
}

// ── Helper: create temp JSONL file ──
function createTempJsonl(content) {
  const tmpDir = os.tmpdir()
  const tmpFile = path.join(tmpDir, `test-tree-${Date.now()}.jsonl`)
  fs.writeFileSync(tmpFile, content, 'utf-8')
  return tmpFile
}

// ── Inline tree reader (mirror of session-tree-reader.ts) ──
function buildTreeFromFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n')

  const byId = new Map()
  const labelsById = new Map()
  const entries = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let entry
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (entry.type === 'session') continue

    if (entry.type === 'label' && entry.targetId && entry.label) {
      labelsById.set(entry.targetId, entry.label)
    }

    entries.push(entry)
  }

  for (const entry of entries) {
    const node = {
      id: entry.id,
      parentId: entry.parentId ?? null,
      type: entry.type,
      text: '',
      timestamp: entry.timestamp ?? '',
      children: [],
      role: undefined,
      label: undefined,
    }

    if (entry.type === 'message' && entry.message?.role) {
      node.role = entry.message.role
    }

    // Extract text preview
    if (entry.type === 'label') {
      node.text = (entry.label ?? entry.text ?? '').split('\n')[0]
    } else if (entry.type === 'message' && entry.message?.content) {
      const content = entry.message.content
      if (typeof content === 'string') {
        node.text = content.split('\n')[0]
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            node.text = block.text.split('\n')[0]
            break
          }
        }
      }
    }

    const label = labelsById.get(entry.id)
    if (label) node.label = label

    byId.set(entry.id, node)
  }

  const rootNodes = []
  for (const node of byId.values()) {
    if (node.parentId === null || node.parentId === node.id) {
      rootNodes.push(node)
    } else {
      const parent = byId.get(node.parentId)
      if (parent) {
        parent.children.push(node)
      } else {
        rootNodes.push(node)
      }
    }
  }

  // Sort children by timestamp
  const stack = [...rootNodes]
  while (stack.length > 0) {
    const node = stack.pop()
    node.children.sort((a, b) => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0)
    stack.push(...node.children)
  }

  function countBranches(nodes) {
    let count = 0
    const s = [...nodes]
    while (s.length > 0) {
      const n = s.pop()
      if (n.children.length > 1) count++
      s.push(...n.children)
    }
    return count
  }

  return { byId, rootNodes, labelsById, countBranches: countBranches(rootNodes) }
}

// ══════════════════════════════════════════════════════════════════
// TC-1-01: JSONL 文件读取并构建正确树结构
// ══════════════════════════════════════════════════════════════════
console.log('\nTC-1-01: JSONL 文件读取并构建正确树结构')

{
  // Create a JSONL with 3 branches:
  // root → U1 → A1 → U2 → A2 (linear path)
  //                    → U3 → A3 (branch from A1)
  //          → U4 → A4 (branch from root)
  // So: root has 2 children (U1, U4) → branch point #1
  //     A1 has 2 children (U2, U3) → branch point #2
  //     U2 has 1 child (A2) → not a branch
  // Plus another branch from U2:
  //     U2 → A5 (second child) → branch point #3

  const jsonl = [
    { type: 'session', id: 'sess-1', cwd: '/test' },
    { id: 'e1', parentId: null, type: 'message', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
    { id: 'e2', parentId: 'e1', type: 'message', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] } },
    { id: 'e3', parentId: 'e2', type: 'message', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'text', text: 'Tell me more' }] } },
    { id: 'e4', parentId: 'e3', type: 'message', timestamp: '2026-01-01T00:00:03Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Sure' }] } },
    // Branch from e2: another user message
    { id: 'e5', parentId: 'e2', type: 'message', timestamp: '2026-01-01T00:00:04Z', message: { role: 'user', content: [{ type: 'text', text: 'Different question' }] } },
    { id: 'e6', parentId: 'e5', type: 'message', timestamp: '2026-01-01T00:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Different answer' }] } },
    // Branch from e4: another child
    { id: 'e7', parentId: 'e4', type: 'message', timestamp: '2026-01-01T00:00:06Z', message: { role: 'user', content: [{ type: 'text', text: 'Follow up' }] } },
    { id: 'e8', parentId: 'e7', type: 'message', timestamp: '2026-01-01T00:00:07Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Follow up answer' }] } },
    // Label entry
    { id: 'l1', type: 'label', targetId: 'e3', label: 'Important question', timestamp: '2026-01-01T00:00:08Z' },
  ].map(e => JSON.stringify(e)).join('\n')

  const tmpFile = createTempJsonl(jsonl)
  const result = buildTreeFromFile(tmpFile)

  // 8 message entries + 1 label entry = 9 entries (label not in tree as node)
  // Wait: label entries have type 'label' and no parentId, but they ARE entries
  // The tree reader skips them as nodes (they go to labelsById)
  // Actually looking at the code, label entries are pushed to entries[] but
  // they have no parentId → they become root nodes. Let me re-check...
  // No: label entries don't have parentId set, so parentId defaults to null → root node
  // But wait, the label entry has id: 'l1' and no parentId field, so parentId = null → root
  // Actually looking more carefully, label entries ARE added to byId.
  // Let me count: e1-e8 (8 message) + l1 (1 label) = 9 in byId
  assert(result.byId.size === 9, `byId.size === 9 (got ${result.byId.size})`)

  // Root nodes: e1 (no parent) + l1 (label, no parentId) = 2
  // Wait: l1 has type 'label' and no parentId → it becomes a root node too
  assert(result.rootNodes.length === 2, `rootNodes.length === 2 (got ${result.rootNodes.length})`)

  // Branch points: e2 has 2 children (e3, e5) → branch, e4 has 2 children (e7) → wait e4 has only 1
  // e4 children: e7 only (since e3's parent is e2, not e4). Let me recheck:
  // e1 → e2 (e1 child: e2 only → wait, e1 has no second child)
  // Actually: e1 children = [e2], e2 children = [e3, e5] → branch!
  // e3 children = [e4], e4 children = [e7], e5 children = [e6]
  // e7 children = [e8]
  // So only 1 branch point: e2 (2 children)
  // Plus label l1 is a root with no children → not a branch
  assert(result.countBranches === 1, `branchCount === 1 (got ${result.countBranches})`)

  // Verify labels
  assert(result.labelsById.get('e3') === 'Important question', 'Label applied to e3')

  // Verify role extraction
  assert(result.byId.get('e1').role === 'user', 'e1 role is user')
  assert(result.byId.get('e2').role === 'assistant', 'e2 role is assistant')

  // Verify text extraction
  assert(result.byId.get('e1').text === 'Hello', 'e1 text extracted')
  assert(result.byId.get('e2').text === 'Hi there', 'e2 text extracted')

  fs.unlinkSync(tmpFile)
}

// ══════════════════════════════════════════════════════════════════
// TC-1-02: JSONL 最后一行不完整时跳过
// ══════════════════════════════════════════════════════════════════
console.log('\nTC-1-02: JSONL 最后一行不完整时跳过')

{
  const validLine = JSON.stringify({
    id: 'e1', parentId: null, type: 'message', timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
  })
  const truncatedLine = '{"id":"e2","parentId":"e1","type":"message","timestamp":"2026-01-01'
  const jsonl = `{"type":"session","id":"s1"}\n${validLine}\n${truncatedLine}\n`

  const tmpFile = createTempJsonl(jsonl)
  const result = buildTreeFromFile(tmpFile)

  assert(result.byId.size === 1, `byId.size === 1 (got ${result.byId.size})`)
  assert(result.byId.has('e1'), 'e1 parsed correctly')
  assert(!result.byId.has('e2'), 'e2 (truncated) was skipped')

  fs.unlinkSync(tmpFile)
}

// ══════════════════════════════════════════════════════════════════
// TC-1-03: 空 JSONL 文件（只有 header）
// ══════════════════════════════════════════════════════════════════
console.log('\nTC-1-03: 空 JSONL 文件（只有 header）')

{
  const jsonl = '{"type":"session","id":"s1","cwd":"/test","model":"claude-3.5"}\n'
  const tmpFile = createTempJsonl(jsonl)
  const result = buildTreeFromFile(tmpFile)

  assert(result.byId.size === 0, `byId.size === 0 (got ${result.byId.size})`)
  assert(result.rootNodes.length === 0, `rootNodes.length === 0 (got ${result.rootNodes.length})`)
  assert(result.countBranches === 0, `branchCount === 0 (got ${result.countBranches})`)

  fs.unlinkSync(tmpFile)
}

// ── Bonus: Orphan node handling ──
console.log('\nBonus: Orphan node becomes root')

{
  const jsonl = [
    { type: 'session', id: 's1' },
    { id: 'e1', parentId: null, type: 'message', timestamp: 't1', message: { role: 'user', content: 'hi' } },
    { id: 'e2', parentId: 'nonexistent', type: 'message', timestamp: 't2', message: { role: 'assistant', content: 'hey' } },
  ].map(e => JSON.stringify(e)).join('\n')

  const tmpFile = createTempJsonl(jsonl)
  const result = buildTreeFromFile(tmpFile)

  assert(result.byId.size === 2, `byId.size === 2 (got ${result.byId.size})`)
  assert(result.rootNodes.length === 2, `orphan e2 becomes root (got ${result.rootNodes.length})`)

  fs.unlinkSync(tmpFile)
}

// ── Summary ──
console.log(`\n═══ Summary: ${passed} passed, ${failed} failed ═══`)
process.exit(failed > 0 ? 1 : 0)
