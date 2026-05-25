/**
 * Integration test: Tree store flatNodes algorithm
 *
 * Tests the flattenTree logic for flat + conditional indent rendering.
 * Mirrors the algorithm from stores/tree.ts.
 *
 * Run: node tools/test-tree-flatten.cjs
 */

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

// ── Inline flattenTree algorithm (mirror of stores/tree.ts) ──

function flattenTree(nodes, leafId, pathSet, mode) {
  const result = []

  function shouldShow(node, mode) {
    switch (mode) {
      case 'all': return true
      case 'no-tools': return node.type !== 'tool'
      default: return true
    }
  }

  function walk(list, depth) {
    for (const node of list) {
      if (!shouldShow(node, mode)) {
        if (node.children.length > 0) {
          if (node.children.length > 1) {
            walk(node.children, depth + 1)
          } else {
            walk(node.children, depth)
          }
        }
        continue
      }

      const isLeaf = node.id === leafId
      const hasSiblings = list.length > 1

      result.push({ node, depth, onPath: pathSet.has(node.id), isLeaf, hasSiblings })

      if (node.children.length > 1) {
        walk(node.children, depth + 1)
      } else if (node.children.length === 1) {
        walk(node.children, depth)
      }
    }
  }

  walk(nodes, 0)
  return result
}

function buildPathToRoot(allNodes, leafId) {
  const parentMap = new Map()
  function walk(nodes) {
    for (const n of nodes) {
      parentMap.set(n.id, n.parentId)
      if (n.children.length > 0) walk(n.children)
    }
  }
  walk(allNodes)

  const path = new Set()
  let cur = leafId
  while (cur) {
    path.add(cur)
    cur = parentMap.get(cur)
  }
  return path
}

// ══════════════════════════════════════════════════════════════════
// Test: Linear chain — all same depth
// ══════════════════════════════════════════════════════════════════
console.log('\nTest: Linear chain (U→A→U→A) — all depth 0')

{
  const tree = [
    { id: 'u1', parentId: null, type: 'message', role: 'user', text: 'hi', children: [
      { id: 'a1', parentId: 'u1', type: 'message', role: 'assistant', text: 'hey', children: [
        { id: 'u2', parentId: 'a1', type: 'message', role: 'user', text: 'more', children: [
          { id: 'a2', parentId: 'u2', type: 'message', role: 'assistant', text: 'sure', children: [] }
        ]}
      ]}
    ]}
  ]

  const pathSet = buildPathToRoot(tree, 'a2')
  const flat = flattenTree(tree, 'a2', pathSet, 'all')

  assert(flat.length === 4, `4 nodes (got ${flat.length})`)
  assert(flat.every(n => n.depth === 0), 'All at depth 0')
  assert(flat[3].isLeaf === true, 'Last node is leaf')
  assert(flat.every(n => n.onPath), 'All on active path')
}

// ══════════════════════════════════════════════════════════════════
// Test: Branch — children indent
// ══════════════════════════════════════════════════════════════════
console.log('\nTest: Branch point — children get depth+1')

{
  // u1 → a1 → [u2, u3]
  // u2 is the leaf
  const tree = [
    { id: 'u1', parentId: null, type: 'message', role: 'user', text: 'hi', children: [
      { id: 'a1', parentId: 'u1', type: 'message', role: 'assistant', text: 'hey', children: [
        { id: 'u2', parentId: 'a1', type: 'message', role: 'user', text: 'q1', children: [] },
        { id: 'u3', parentId: 'a1', type: 'message', role: 'user', text: 'q2', children: [] }
      ]}
    ]}
  ]

  const pathSet = buildPathToRoot(tree, 'u2')
  const flat = flattenTree(tree, 'u2', pathSet, 'all')

  assert(flat.length === 4, `4 nodes (got ${flat.length})`)
  assert(flat[0].depth === 0, 'u1 depth 0')
  assert(flat[1].depth === 0, 'a1 depth 0 (linear from root)')
  assert(flat[2].depth === 1, 'u2 depth 1 (branched child)')
  assert(flat[3].depth === 1, 'u3 depth 1 (branched child)')
  assert(flat[2].isLeaf === true, 'u2 is leaf')
  assert(flat[3].isLeaf === false, 'u3 is not leaf')
  assert(flat[2].hasSiblings === true, 'u2 has siblings')
  assert(flat[3].hasSiblings === true, 'u3 has siblings')
}

// ══════════════════════════════════════════════════════════════════
// Test: Active path highlight
// ══════════════════════════════════════════════════════════════════
console.log('\nTest: Active path — only u1→a1→u2 path highlighted')

{
  const tree = [
    { id: 'u1', parentId: null, type: 'message', role: 'user', text: 'hi', children: [
      { id: 'a1', parentId: 'u1', type: 'message', role: 'assistant', text: 'hey', children: [
        { id: 'u2', parentId: 'a1', type: 'message', role: 'user', text: 'q1', children: [
          { id: 'a2', parentId: 'u2', type: 'message', role: 'assistant', text: 'a1', children: [] }
        ]},
        { id: 'u3', parentId: 'a1', type: 'message', role: 'user', text: 'q2', children: [
          { id: 'a3', parentId: 'u3', type: 'message', role: 'assistant', text: 'a2', children: [] }
        ]}
      ]}
    ]}
  ]

  const pathSet = buildPathToRoot(tree, 'a2')
  const flat = flattenTree(tree, 'a2', pathSet, 'all')

  const onPathIds = flat.filter(n => n.onPath).map(n => n.node.id)
  assert(onPathIds.join(',') === 'u1,a1,u2,a2', `Path: ${onPathIds.join(',')} (expected u1,a1,u2,a2)`)
  assert(!flat.find(n => n.node.id === 'u3').onPath, 'u3 not on path')
  assert(!flat.find(n => n.node.id === 'a3').onPath, 'a3 not on path')
}

// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// Test: Filter mode 'no-tools' — hides tool nodes
// ══════════════════════════════════════════════════════════════════
console.log('\nTest: Filter mode "no-tools"')

{
  const tree = [
    { id: 'u1', parentId: null, type: 'message', role: 'user', text: 'hi', children: [
      { id: 't1', parentId: 'u1', type: 'tool', text: 'search', children: [
        { id: 'r1', parentId: 't1', type: 'result', text: 'results', children: [
          { id: 'a1', parentId: 'r1', type: 'message', role: 'assistant', text: 'found', children: [] },
        ]},
      ]},
    ]},
  ]

  // no-tools hides tool nodes; children are traversed at same depth (single child)
  const flat = flattenTree(tree, 'a1', new Set([]), 'no-tools')
  const ids = flat.map(n => n.node.id)
  assert(ids.join(',') === 'u1,r1,a1', 'Tool filtered, children traversed')
}

// ══════════════════════════════════════════════════════════════════
// Test: Empty tree
// ══════════════════════════════════════════════════════════════════
console.log('\nTest: Empty tree')

{
  const flat = flattenTree([], null, new Set(), 'all')
  assert(flat.length === 0, 'Empty result for empty tree')
}

// ── Summary ──
console.log(`\n═══ Summary: ${passed} passed, ${failed} failed ═══`)
process.exit(failed > 0 ? 1 : 0)
