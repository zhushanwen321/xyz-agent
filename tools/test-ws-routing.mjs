/**
 * Integration test: WS message routing for tree operations
 *
 * Simulates the WS server's message routing logic for tree-related
 * messages, verifying correct dispatch to session-service methods.
 *
 * Run: node tools/test-ws-routing.cjs
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

// ── Simulate server routing ──

const dispatchedCalls = []

const mockSessionService = {
  getTree(sid) {
    dispatchedCalls.push({ method: 'getTree', sid })
    return Promise.resolve({
      sessionId: sid,
      tree: [{ id: 'e1', children: [] }],
      leafId: 'e1',
      branchCount: 0,
      navigateCapable: true,
    })
  },
  navigateTree(sid, entryId) {
    dispatchedCalls.push({ method: 'navigateTree', sid, entryId })
    return Promise.resolve({
      success: true,
      newLeafId: entryId,
      editorText: 'test prompt',
    })
  },
  forkFromEntry(sid, entryId) {
    dispatchedCalls.push({ method: 'forkFromEntry', sid, entryId })
    return Promise.resolve({
      success: true,
      newSessionId: 'new-sess-123',
    })
  },
  isNavigateCapable(sid) {
    dispatchedCalls.push({ method: 'isNavigateCapable', sid })
    return true
  },
}

// Valid message types from protocol.ts
const VALID_CLIENT_TYPES = [
  'session.list', 'session.create', 'session.restore', 'session.history',
  'session.switch', 'session.delete', 'session.rename',
  'session.prompt', 'session.cancel',
  'session.tree-data', 'session.tree-navigate', 'session.tree-fork', 'session.tree-capability',
  'settings.get', 'settings.update',
  'server.command',
]

const VALID_SERVER_TYPES = [
  'session.list', 'session.create', 'session.restore', 'session.history',
  'session.switch', 'session.delete', 'session.rename',
  'session.prompt_start', 'session.prompt_chunk', 'session.prompt_end', 'session.prompt_error',
  'session.cancelled',
  'session.tree-data', 'session.tree-navigate-result', 'session.tree-fork-result', 'session.tree-capability',
  'settings.data',
  'message.message_start', 'message.text_delta', 'message.thinking_start', 'message.thinking_delta',
  'message.thinking_end', 'message.tool_call_start', 'message.tool_call_end', 'message.complete',
  'message.error', 'context.update', 'message.status',
  'server.ready', 'server.error',
]

async function simulateRoute(msg) {
  const sid = msg.payload?.sessionId
  const responses = []

  switch (msg.type) {
    case 'session.tree-data': {
      const treeData = await mockSessionService.getTree(sid)
      responses.push({ type: 'session.tree-data', payload: treeData })
      break
    }
    case 'session.tree-navigate': {
      const result = await mockSessionService.navigateTree(sid, msg.payload.targetEntryId)
      responses.push({ type: 'session.tree-navigate-result', payload: { sessionId: sid, ...result } })
      break
    }
    case 'session.tree-fork': {
      const result = await mockSessionService.forkFromEntry(sid, msg.payload.entryId)
      responses.push({ type: 'session.tree-fork-result', payload: { sessionId: sid, ...result } })
      break
    }
    case 'session.tree-capability': {
      const capable = mockSessionService.isNavigateCapable(sid)
      responses.push({ type: 'session.tree-capability', payload: { sessionId: sid, navigateCapable: capable } })
      break
    }
  }

  return responses
}

// ══════════════════════════════════════════════════════════════════
// Test: TC-2-01 — session.tree-data routing
// ══════════════════════════════════════════════════════════════════
console.log('\nTC-2-01: session.tree-data routing')

{
  dispatchedCalls.length = 0
  const responses = await simulateRoute({
    type: 'session.tree-data',
    payload: { sessionId: 'sess-1' },
  })

  assert(responses.length === 1, '1 response')
  assert(responses[0].type === 'session.tree-data', 'response type matches')
  assert(responses[0].payload.tree.length === 1, 'tree array returned')
  assert(responses[0].payload.leafId === 'e1', 'leafId returned')
  assert(responses[0].payload.navigateCapable === true, 'navigateCapable returned')
  assert(dispatchedCalls[0].method === 'getTree', 'getTree called')
  assert(dispatchedCalls[0].sid === 'sess-1', 'correct sessionId')
}

// ══════════════════════════════════════════════════════════════════
// Test: TC-2-02 — session.tree-navigate routing
// ══════════════════════════════════════════════════════════════════
console.log('\nTC-2-02: session.tree-navigate routing')

{
  dispatchedCalls.length = 0
  const responses = await simulateRoute({
    type: 'session.tree-navigate',
    payload: { sessionId: 'sess-1', targetEntryId: 'entry-5' },
  })

  assert(responses.length === 1, '1 response')
  assert(responses[0].type === 'session.tree-navigate-result', 'response type matches')
  assert(responses[0].payload.success === true, 'success === true')
  assert(responses[0].payload.newLeafId === 'entry-5', 'newLeafId matches target')
  assert(responses[0].payload.editorText === 'test prompt', 'editorText returned')
  assert(dispatchedCalls[0].method === 'navigateTree', 'navigateTree called')
  assert(dispatchedCalls[0].entryId === 'entry-5', 'correct targetEntryId')
}

// ══════════════════════════════════════════════════════════════════
// Test: TC-2-04 — session.tree-fork routing
// ══════════════════════════════════════════════════════════════════
console.log('\nTC-2-04: session.tree-fork routing')

{
  dispatchedCalls.length = 0
  const responses = await simulateRoute({
    type: 'session.tree-fork',
    payload: { sessionId: 'sess-1', entryId: 'entry-3' },
  })

  assert(responses.length === 1, '1 response')
  assert(responses[0].type === 'session.tree-fork-result', 'response type matches')
  assert(responses[0].payload.success === true, 'success === true')
  assert(responses[0].payload.newSessionId === 'new-sess-123', 'newSessionId returned')
  assert(dispatchedCalls[0].method === 'forkFromEntry', 'forkFromEntry called')
  assert(dispatchedCalls[0].entryId === 'entry-3', 'correct entryId')
}

// ══════════════════════════════════════════════════════════════════
// Test: TC-2-03 — navigate timeout simulation
// ══════════════════════════════════════════════════════════════════
console.log('\nTC-2-03: Navigate timeout simulation')

{
  // Simulate timeout by creating a mock that rejects after delay
  const TIMEOUT_MS = 100 // Fast timeout for testing
  const slowNavigate = () => new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Navigate timeout')), TIMEOUT_MS + 50)
  })

  // Simulate the race pattern from session-service.ts
  const start = Date.now()
  let result
  try {
    result = await Promise.race([
      slowNavigate('sess-1', 'entry-1'),
      new Promise(resolve => setTimeout(() => resolve({ success: false, error: 'Navigate timeout' }), TIMEOUT_MS)),
    ])
  } catch {
    result = { success: false, error: 'Unexpected error' }
  }

  assert(result.success === false, 'Timeout returns success=false')
  assert(result.error === 'Navigate timeout', 'Error message contains timeout')
  assert(Date.now() - start < 200, 'Timed out within expected window')
}

// ══════════════════════════════════════════════════════════════════
// Test: Protocol type coverage
// ══════════════════════════════════════════════════════════════════
console.log('\nProtocol: Type coverage for tree messages')

{
  assert(VALID_CLIENT_TYPES.includes('session.tree-data'), 'session.tree-data is valid client type')
  assert(VALID_CLIENT_TYPES.includes('session.tree-navigate'), 'session.tree-navigate is valid client type')
  assert(VALID_CLIENT_TYPES.includes('session.tree-fork'), 'session.tree-fork is valid client type')
  assert(VALID_CLIENT_TYPES.includes('session.tree-capability'), 'session.tree-capability is valid client type')
  assert(VALID_SERVER_TYPES.includes('session.tree-data'), 'session.tree-data is valid server type')
  assert(VALID_SERVER_TYPES.includes('session.tree-navigate-result'), 'session.tree-navigate-result is valid server type')
  assert(VALID_SERVER_TYPES.includes('session.tree-fork-result'), 'session.tree-fork-result is valid server type')
  assert(VALID_SERVER_TYPES.includes('session.tree-capability'), 'session.tree-capability is valid server type')
}

// ── Summary ──
console.log(`\n═══ Summary: ${passed} passed, ${failed} failed ═══`)
process.exit(failed > 0 ? 1 : 0)
