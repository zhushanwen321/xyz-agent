/**
 * Integration test: NavigateInterceptor
 *
 * Tests the cross-chunk buffering and JSON parsing of navigate-result
 * messages within the NavigateInterceptor's WsSender decoration.
 *
 * Run: node tools/test-event-adapter.cjs
 */

// This is a self-contained test that mirrors the EventAdapter's navigate
// interception logic and verifies it handles single-delta, multi-delta,
// and edge cases correctly.

const fs = require('fs')
const path = require('path')

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

/**
 * Simulates the EventAdapter's navigate interception logic.
 * Extracted from event-adapter.ts for isolated testing.
 */
function simulateNavigateInterception(deltas, hasResolver = true) {
  let navigateResolve = hasResolver ? (data) => { capturedResult = data } : null
  let navigateBuffer = ''
  let isNavigateStream = false
  let capturedResult = null
  const forwardedDeltas = []

  for (const delta of deltas) {
    // Simulate text_delta handling
    if (navigateResolve) {
      if (!isNavigateStream && /"__xyz_type"\s*:\s*"navigate-result"/.test(delta)) {
        isNavigateStream = true
        navigateBuffer = delta
      } else if (isNavigateStream) {
        navigateBuffer += delta
      }

      if (isNavigateStream) {
        try {
          const parsed = JSON.parse(navigateBuffer)
          navigateResolve(parsed)
          navigateResolve = null
          navigateBuffer = ''
          isNavigateStream = false
          continue // don't forward
        } catch {
          // JSON incomplete, wait for more
          continue // don't forward
        }
      }
    }

    forwardedDeltas.push(delta)
  }

  // Simulate message_end cleanup
  isNavigateStream = false
  navigateBuffer = ''

  return { capturedResult, forwardedDeltas }
}

// ══════════════════════════════════════════════════════════════════
// Test: Single-delta navigate-result (happy path)
// ══════════════════════════════════════════════════════════════════
console.log('\nTest: Single-delta navigate-result')

{
  const payload = JSON.stringify({
    __xyz_type: 'navigate-result',
    success: true,
    newLeafId: 'entry-abc123',
    editorText: 'Hello world',
  })

  const { capturedResult, forwardedDeltas } = simulateNavigateInterception([payload])

  assert(capturedResult !== null, 'Result captured')
  assert(capturedResult.__xyz_type === 'navigate-result', 'Has correct __xyz_type')
  assert(capturedResult.success === true, 'success === true')
  assert(capturedResult.newLeafId === 'entry-abc123', 'newLeafId correct')
  assert(capturedResult.editorText === 'Hello world', 'editorText correct')
  assert(forwardedDeltas.length === 0, 'No deltas forwarded to chat')
}

// ══════════════════════════════════════════════════════════════════
// Test: Multi-delta navigate-result (split across 3 chunks)
// ══════════════════════════════════════════════════════════════════
console.log('\nTest: Multi-delta navigate-result (3 chunks)')

{
  const fullJson = '{"__xyz_type":"navigate-result","success":true,"newLeafId":"entry-xyz","editorText":null}'
  // First chunk must contain the full marker for startsWith to work
  const chunk1 = fullJson.slice(0, 45) // includes full marker + part of payload
  const chunk2 = fullJson.slice(45, 70)
  const chunk3 = fullJson.slice(70)

  const { capturedResult, forwardedDeltas } = simulateNavigateInterception([chunk1, chunk2, chunk3])

  assert(capturedResult !== null, 'Result captured from 3 chunks')
  assert(capturedResult.success === true, 'success === true')
  assert(capturedResult.newLeafId === 'entry-xyz', 'newLeafId correct')
  assert(forwardedDeltas.length === 0, 'No deltas forwarded during accumulation')
}

// ══════════════════════════════════════════════════════════════════
// Test: Normal text_delta not intercepted (no navigate marker)
// ══════════════════════════════════════════════════════════════════
console.log('\nTest: Normal text_delta passes through')

{
  const { capturedResult, forwardedDeltas } = simulateNavigateInterception([
    'Hello, ',
    'how can I ',
    'help you?',
  ])

  assert(capturedResult === null, 'No navigate result captured')
  assert(forwardedDeltas.length === 3, 'All 3 deltas forwarded')
  assert(forwardedDeltas.join('') === 'Hello, how can I help you?', 'Content preserved')
}

// ══════════════════════════════════════════════════════════════════
// Test: No resolver set — navigate-result treated as normal text
// ══════════════════════════════════════════════════════════════════
console.log('\nTest: No resolver — navigate-result forwarded as text')

{
  const payload = JSON.stringify({
    __xyz_type: 'navigate-result',
    success: false,
    error: 'Navigate failed',
  })

  const { capturedResult, forwardedDeltas } = simulateNavigateInterception([payload], false)

  assert(capturedResult === null, 'Nothing captured (no resolver)')
  assert(forwardedDeltas.length === 1, 'Delta forwarded as normal text')
}

// ══════════════════════════════════════════════════════════════════
// Test: Navigate-result followed by normal text in same message
// ══════════════════════════════════════════════════════════════════
console.log('\nTest: Navigate-result then normal text')

{
  const navPayload = JSON.stringify({
    __xyz_type: 'navigate-result',
    success: true,
    newLeafId: 'entry-1',
    editorText: null,
  })

  const { capturedResult, forwardedDeltas } = simulateNavigateInterception([
    navPayload,
    'Some normal text after',
    'more text',
  ])

  assert(capturedResult !== null, 'Navigate result captured')
  assert(capturedResult.success === true, 'Navigate success')
  assert(forwardedDeltas.length === 2, 'Normal text forwarded after navigate')
  assert(forwardedDeltas.join('') === 'Some normal text aftermore text', 'Normal text preserved')
}

// ══════════════════════════════════════════════════════════════════
// Test: Cancelled navigate (extension error)
// ══════════════════════════════════════════════════════════════════
console.log('\nTest: Cancelled navigate result')

{
  const payload = JSON.stringify({
    __xyz_type: 'navigate-result',
    cancelled: true,
    newLeafId: 'entry-original',
    editorText: null,
  })

  const { capturedResult, forwardedDeltas } = simulateNavigateInterception([payload])

  assert(capturedResult !== null, 'Result captured')
  assert(capturedResult.cancelled === true, 'cancelled === true')
  assert(forwardedDeltas.length === 0, 'Not forwarded to chat')
}

// ── Summary ──
console.log(`\n═══ Summary: ${passed} passed, ${failed} failed ═══`)
process.exit(failed > 0 ? 1 : 0)
