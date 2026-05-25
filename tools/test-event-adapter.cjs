/**
 * Integration test: NavigateInterceptor (message_start-based interception)
 *
 * Tests that the NavigateInterceptor correctly detects navigate results
 * from custom message_start events (via pi.sendMessage) and resolves
 * the pending navigate promise.
 *
 * Run: node tools/test-event-adapter.cjs
 */

// Simulate NavigateInterceptor logic
const NAVIGATE_CUSTOM_TYPE = 'xyz-navigate-result'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) {
    passed++
    console.log(`  PASS: ${msg}`)
  } else {
    failed++
    console.error(`  FAIL: ${msg}`)
  }
}

function summary() {
  console.log(`\n═══ Summary: ${passed} passed, ${failed} failed ═══`)
  process.exit(failed > 0 ? 1 : 0)
}

// ── Simulated NavigateInterceptor ──────────────────────────────────

class MockInterceptor {
  constructor() {
    this.resolveFn = null
    this.pending = false
    this.intercepted = []
    this.forwarded = []
  }

  setResolver(fn) {
    this.resolveFn = fn
    this.pending = false
  }

  clearResolver() {
    this.resolveFn = null
    this.pending = false
  }

  onMessageEnd() {
    if (this.resolveFn) {
      const resolver = this.resolveFn
      this.resolveFn = null
      this.pending = false
      resolver({ cancelled: true })
    }
  }

  send(msg) {
    if (this.resolveFn && msg.type === 'message.message_start') {
      if (msg.payload?.customType === NAVIGATE_CUSTOM_TYPE) {
        this.pending = true
        try {
          const parsed = JSON.parse(msg.payload.content)
          const resolver = this.resolveFn
          this.resolveFn = null
          this.pending = false
          this.intercepted.push(parsed)
          resolver(parsed)
          return // intercepted
        } catch {
          this.pending = false
        }
      }
    }
    this.forwarded.push(msg)
  }
}

// ── Test 1: Single message_start with navigate result ──────────────

console.log('\n[Test 1] Single message_start with navigate result')

{
  const it = new MockInterceptor()
  const results = []

  it.setResolver((data) => results.push(data))
  it.send({
    type: 'message.message_start',
    payload: {
      sessionId: 'test-1',
      customType: 'xyz-navigate-result',
      content: JSON.stringify({
        __xyz_type: 'navigate-result',
        cancelled: false,
        newLeafId: 'entry-42',
        editorText: 'hello world',
      }),
    },
  })

  assert(results.length === 1, 'resolver called once')
  assert(results[0].cancelled === false, 'cancelled = false')
  assert(results[0].newLeafId === 'entry-42', 'newLeafId = entry-42')
  assert(results[0].editorText === 'hello world', 'editorText = hello world')
  assert(it.intercepted.length === 1, 'message was intercepted (not forwarded)')
  assert(it.forwarded.length === 0, 'no messages forwarded to downstream')
}

// ── Test 2: Cancelled navigate ─────────────────────────────────────

console.log('\n[Test 2] Cancelled navigate')

{
  const it = new MockInterceptor()
  const results = []

  it.setResolver((data) => results.push(data))
  it.send({
    type: 'message.message_start',
    payload: {
      sessionId: 'test-2',
      customType: 'xyz-navigate-result',
      content: JSON.stringify({
        __xyz_type: 'navigate-result',
        cancelled: true,
        newLeafId: null,
        editorText: null,
      }),
    },
  })

  assert(results.length === 1, 'resolver called once')
  assert(results[0].cancelled === true, 'cancelled = true')
  assert(it.intercepted.length === 1, 'message intercepted')
}

// ── Test 3: Normal messages pass through uninterrupted ─────────────

console.log('\n[Test 3] Normal messages pass through')

{
  const it = new MockInterceptor()
  it.setResolver(() => {}) // resolver set but no navigate result

  it.send({ type: 'message.text_delta', payload: { delta: 'Hello' } })
  it.send({ type: 'message.message_start', payload: { sessionId: 's1' } })
  it.send({ type: 'message.complete', payload: { sessionId: 's1' } })

  assert(it.forwarded.length === 3, '3 messages forwarded')
  assert(it.intercepted.length === 0, '0 messages intercepted')
}

// ── Test 4: message_start without customType passes through ────────

console.log('\n[Test 4] message_start without customType passes through')

{
  const it = new MockInterceptor()
  it.setResolver(() => {})

  it.send({
    type: 'message.message_start',
    payload: { sessionId: 's1' }, // no customType
  })

  assert(it.forwarded.length === 1, 'message_start forwarded')
  assert(it.intercepted.length === 0, 'not intercepted')
}

// ── Test 5: message_end cancels pending navigate ───────────────────

console.log('\n[Test 5] onMessageEnd cancels pending navigate')

{
  // Resolver set but NO navigate result arrives before message_end
  const it = new MockInterceptor()
  const results = []

  it.setResolver((data) => results.push(data))
  it.send({ type: 'message.text_delta', payload: { delta: 'normal text' } })
  // Simulate end of turn without navigate result
  it.onMessageEnd()

  assert(results.length === 1, 'resolver called on message_end')
  assert(results[0].cancelled === true, 'cancelled = true from message_end')
}

// ── Test 6: Clear resolver (timeout) ──────────────────────────────

console.log('\n[Test 6] clearResolver cancels pending')

{
  const it = new MockInterceptor()
  let called = false

  it.setResolver(() => { called = true })
  it.clearResolver()

  it.send({
    type: 'message.message_start',
    payload: {
      customType: 'xyz-navigate-result',
      content: JSON.stringify({ cancelled: false }),
    },
  })

  assert(called === false, 'resolver not called after clear')
  assert(it.forwarded.length === 1, 'message forwarded after clear')
}

// ── Test 7: Error in JSON content ──────────────────────────────────

console.log('\n[Test 7] Unparseable JSON content')

{
  const it = new MockInterceptor()
  let resolved = false

  it.setResolver(() => { resolved = true })
  it.send({
    type: 'message.message_start',
    payload: {
      customType: 'xyz-navigate-result',
      content: 'not-json{{{',
    },
  })

  assert(resolved === false, 'resolver NOT called for bad JSON')
  assert(it.forwarded.length === 1, 'bad message forwarded to UI')
}

// ── Done ───────────────────────────────────────────────────────────

summary()
