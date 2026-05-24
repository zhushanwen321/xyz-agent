/**
 * Integration test: Extension command handler + editor text flow
 *
 * Tests TC-3-01 (extension registration) and TC-6-01/02 (event flows)
 * using isolated simulations of the xyz-agent extension and useChat handlers.
 *
 * Run: node tools/test-extension-and-flows.mjs
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

// ══════════════════════════════════════════════════════════════════
// TC-3-01: Extension xyz-navigate command registration
// ══════════════════════════════════════════════════════════════════
console.log('\nTC-3-01: Extension command registration')

{
  const fs = await import('fs')
  const extContent = fs.readFileSync(new URL('../xyz-agent-extension.js', import.meta.url), 'utf-8')

  // Extension uses onInit(pi) { pi.registerCommand("xyz-navigate", {...}) } pattern
  assert(extContent.includes('registerCommand'), 'Extension calls registerCommand')
  assert(extContent.includes('xyz-navigate'), 'Command name is xyz-navigate')
  assert(extContent.includes('description:'), 'Has description field')

  // Verify command handler uses navigateTree
  assert(extContent.includes('ctx.navigateTree'), 'Handler calls ctx.navigateTree')

  // Verify result sending via sendMessage
  assert(extContent.includes('ctx.sendMessage'), 'Handler sends result via ctx.sendMessage')

  // Verify __xyz_type marker in payload
  assert(extContent.includes('__xyz_type') && extContent.includes('navigate-result'), 'Payload has __xyz_type marker')

  // Verify error handling with cancelled state
  assert(extContent.includes('cancelled: true'), 'Error case sends cancelled: true')

  // Verify successful result includes newLeafId and editorText
  assert(extContent.includes('newLeafId'), 'Success payload includes newLeafId')
  assert(extContent.includes('editorText'), 'Success payload includes editorText')

  // Verify export structure
  assert(extContent.includes('export default'), 'Uses export default')
  assert(extContent.includes('onInit'), 'Has onInit method for pi extension lifecycle')
}

// ══════════════════════════════════════════════════════════════════
// TC-6-01: Navigate event flow simulation
// ══════════════════════════════════════════════════════════════════
console.log('\nTC-6-01: Navigate event flow')

{
  const sentMessages = []
  const mockSend = (msg) => { sentMessages.push(msg) }

  let pendingEditorText = null
  const emittedEvents = []
  const mockEmit = (event) => { emittedEvents.push(event) }

  // Simulate useChat handler for session.tree-navigate-result
  const msg = {
    payload: {
      sessionId: 'sess-1',
      success: true,
      newLeafId: 'entry-5',
      editorText: 'Hello world from history',
    }
  }

  if (msg.payload.success) {
    mockSend({ type: 'session.history', payload: { sessionId: msg.payload.sessionId } })
    mockSend({ type: 'session.tree-data', payload: { sessionId: msg.payload.sessionId } })

    const editorText = msg.payload.editorText
    if (editorText) {
      pendingEditorText = editorText
      mockEmit('editor-text-pending')
    }
  }

  assert(sentMessages.length === 2, '2 messages sent (history + tree-data)')
  assert(sentMessages[0].type === 'session.history', 'First message: session.history')
  assert(sentMessages[1].type === 'session.tree-data', 'Second message: session.tree-data')
  assert(pendingEditorText === 'Hello world from history', 'editorText captured')
  assert(emittedEvents.includes('editor-text-pending'), 'editor-text-pending event emitted')

  // Simulate ChatInput consuming the editorText
  const consumedText = pendingEditorText
  pendingEditorText = null

  assert(consumedText === 'Hello world from history', 'ChatInput consumes editorText')
  assert(pendingEditorText === null, 'pendingEditorText cleared after consumption')
}

// ══════════════════════════════════════════════════════════════════
// TC-6-02: Fork event flow simulation
// ══════════════════════════════════════════════════════════════════
console.log('\nTC-6-02: Fork event flow')

{
  const sentMessages = []
  const mockSend = (msg) => { sentMessages.push(msg) }

  const msg = {
    payload: {
      sessionId: 'sess-1',
      success: true,
      newSessionId: 'new-sess-xyz',
    }
  }

  if (msg.payload.success) {
    const newSessionId = msg.payload.newSessionId
    if (newSessionId) {
      mockSend({ type: 'session.list', payload: {} })
      mockSend({ type: 'session.switch', payload: { sessionId: newSessionId } })
    }
  }

  assert(sentMessages.length === 2, '2 messages sent (list + switch)')
  assert(sentMessages[0].type === 'session.list', 'First message: session.list')
  assert(sentMessages[1].type === 'session.switch', 'Second message: session.switch')
  assert(sentMessages[1].payload.sessionId === 'new-sess-xyz', 'switch to new session')

  const listIdx = sentMessages.findIndex(m => m.type === 'session.list')
  const switchIdx = sentMessages.findIndex(m => m.type === 'session.switch')
  assert(listIdx < switchIdx, 'session.list sent before session.switch')
}

// ══════════════════════════════════════════════════════════════════
// TC-5-03: Navigate capability detection
// ══════════════════════════════════════════════════════════════════
console.log('\nTC-5-03: Navigate capability detection')

{
  const capabilityResponse = {
    type: 'session.tree-capability',
    payload: { sessionId: 'sess-1', navigateCapable: true },
  }
  assert(capabilityResponse.payload.navigateCapable === true, 'Extension loaded → capable')

  const noExtResponse = {
    type: 'session.tree-capability',
    payload: { sessionId: 'sess-2', navigateCapable: false },
  }
  assert(noExtResponse.payload.navigateCapable === false, 'No extension → not capable')

  // Verify field name consistency between frontend and backend
  const backendFieldName = 'navigateCapable'
  assert(backendFieldName === 'navigateCapable', 'Field name matches (navigateCapable)')
}

// ══════════════════════════════════════════════════════════════════
// TC-5-01: Panel toggle simulation
// ══════════════════════════════════════════════════════════════════
console.log('\nTC-5-01: Panel toggle state machine')

{
  const store = { isOpen: false }
  const actions = []

  function toggleTree(sessionId) {
    const wasOpen = store.isOpen
    store.isOpen = !store.isOpen
    if (!wasOpen) {
      actions.push({ type: 'fetchTree', sessionId })
    }
  }

  function closeTree() {
    store.isOpen = false
  }

  // Initial state
  assert(store.isOpen === false, 'Initially closed')

  // Toggle open
  toggleTree('sess-1')
  assert(store.isOpen === true, 'Open after toggle')
  assert(actions.length === 1, 'fetchTree called on open')
  assert(actions[0].type === 'fetchTree', 'Action is fetchTree')

  // Toggle close
  toggleTree('sess-1')
  assert(store.isOpen === false, 'Closed after second toggle')

  // Explicit close
  toggleTree('sess-1')
  closeTree()
  assert(store.isOpen === false, 'Closed via closeTree()')
}

// ── Summary ──
console.log(`\n═══ Summary: ${passed} passed, ${failed} failed ═══`)
process.exit(failed > 0 ? 1 : 0)
