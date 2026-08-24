// P3': bare steer DURING streaming (assistant message_start observed) → turn-boundary drain
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const BIN = '/Users/zhushanwen/Code/xyz-agent-workspace/feat-firstmate-new-session/node_modules/.bin/pi'
const DIR = '/tmp/pi-probe-delivery-20260823'
const child = spawn(BIN, ['--mode', 'rpc', '--session-dir', DIR, '--model', 'xiaomi-token-plan-cn/mimo-v2.5-pro', '--approve'], { stdio: ['pipe', 'pipe', 'pipe'] })

const t0 = Date.now()
const events = []
const pending = new Map()
let idSeq = 1
let assistantStreaming = false // assistant message_start seen, message_end not yet
let settledEdge = false

child.stdout.on('data', (buf) => {
  for (const line of buf.toString().split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    const t = Date.now() - t0
    events.push({ t, ...obj })
    if (obj.type === 'message_start' && obj.message?.role === 'assistant') assistantStreaming = true
    if (obj.type === 'message_end' && obj.message?.role === 'assistant') assistantStreaming = false
    if (obj.type === 'agent_settled') settledEdge = true
    if (obj.type === 'response' && pending.has(obj.id)) { pending.get(obj.id)({ t, obj }); pending.delete(obj.id) }
    const keep = ['response', 'agent_settled', 'agent_start', 'turn_start', 'turn_end', 'message_start', 'message_end', 'error']
    if (keep.includes(obj.type)) console.log(`[${String(t).padStart(6)}ms] ${line.slice(0, 200)}`)
  }
})
child.stderr.on('data', b => process.stderr.write(b))

function send(type, extra = {}) {
  const id = idSeq++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    console.log(`[SEND ${String(Date.now() - t0).padStart(6)}ms] ${JSON.stringify({ id, type, ...extra }).slice(0, 170)}`)
    child.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.get(id)({ t: Date.now() - t0, obj: { timeout: true } }); pending.delete(id) } }, 60000).unref()
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitUntil(fn, timeoutMs = 180000) {
  const start = Date.now()
  while (!fn()) { if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout'); await sleep(50) }
}
async function getState() { return (await send('get_state')).obj?.data }

try {
  await sleep(3000)
  console.log('===== P3-PRIME START (steer strictly during assistant streaming) =====')
  await send('prompt', { message: 'Count from 1 to 60, one number per line, plain text only. Do not use any tools.' })
  await waitUntil(() => assistantStreaming)
  const st = await getState()
  console.log(`P3' mid-streaming: isStreaming=${st.isStreaming} pending=${st.pendingMessageCount}`)
  const r = await send('steer', { message: "PROBE-P3B: stop counting now. Reply with exactly: P3B-ACK" })
  console.log(`P3' steer response: success=${r.obj.success} err=${r.obj.error ?? '-'}`)
  const st2 = await getState()
  console.log(`P3' post-steer state: isStreaming=${st2.isStreaming} pending=${st2.pendingMessageCount}`)
  await waitUntil(() => settledEdge, 180000)
  settledEdge = false
  const s = await getState()
  console.log(`P3' after settled: isStreaming=${s.isStreaming} pending=${s.pendingMessageCount}`)
  const ge = await send('get_entries')
  writeFileSync('/tmp/pi-probe-delivery-20260823/entries-p3.json', JSON.stringify(ge.obj, null, 2))
} catch (e) {
  console.error('PROBE FAILED:', e)
} finally {
  writeFileSync('/tmp/pi-probe-delivery-20260823/events-p3.json', JSON.stringify(events, null, 2))
  console.log('artifacts written. exiting.')
  child.kill('SIGTERM')
  await sleep(500)
  process.exit(0)
}
