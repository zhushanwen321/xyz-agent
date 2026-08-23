// Session delivery kernel probes (design.md §3.3 探针表 row3/4/6 真机验证)
// P1: streaming 期间 prompt+streamingBehavior='steer' 不抛错且入队（row3 前半）
//     + sendChecked 前提：response 受理即回（不等 turn 跑完）
// P3: streaming 期间裸 steer 入队 → run 结束时被 drain（pendingMessageCount 归 0）（row6 大门）
// P2: idle 时 steer 纯入队不唤醒；下次 prompt 活动时先 drain（row4）
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const BIN = '/Users/zhushanwen/Code/xyz-agent-workspace/feat-firstmate-new-session/node_modules/.bin/pi'
const DIR = '/tmp/pi-probe-delivery-20260823'
const child = spawn(BIN, ['--mode', 'rpc', '--session-dir', DIR, '--model', 'xiaomi-token-plan-cn/mimo-v2.5-pro', '--approve'], { stdio: ['pipe', 'pipe', 'pipe'] })

const t0 = Date.now()
const events = []
const pending = new Map()
let idSeq = 1
let settledEdge = false

child.stdout.on('data', (buf) => {
  for (const line of buf.toString().split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    const t = Date.now() - t0
    events.push({ t, ...obj })
    if (obj.type === 'agent_settled') settledEdge = true
    if (obj.type === 'response' && pending.has(obj.id)) {
      pending.get(obj.id)({ t, obj })
      pending.delete(obj.id)
    }
    const keep = ['response', 'agent_settled', 'agent_start', 'agent_end', 'turn_start', 'turn_end', 'message_start', 'message_end', 'error']
    if (keep.includes(obj.type)) console.log(`[${String(t).padStart(6)}ms] ${line.slice(0, 220)}`)
  }
})
child.stderr.on('data', b => process.stderr.write(b))

function send(type, extra = {}) {
  const id = idSeq++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    console.log(`[SEND ${String(Date.now() - t0).padStart(6)}ms] ${JSON.stringify({ id, type, ...extra }).slice(0, 180)}`)
    child.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.get(id)({ t: Date.now() - t0, obj: { timeout: true } }); pending.delete(id) } }, 30000).unref()
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitSettled(timeoutMs = 180000) {
  const start = Date.now()
  while (!settledEdge) {
    if (Date.now() - start > timeoutMs) throw new Error('waitSettled timeout')
    await sleep(100)
  }
  settledEdge = false
}
async function getState() {
  const r = await send('get_state')
  return r.obj?.data
}

try {
  await sleep(3000) // let extensions settle

  // ─── P1: prompt + streamingBehavior:'steer' during streaming ───
  console.log('\n===== P1 START =====')
  const p1run = send('prompt', { message: 'Count from 1 to 30, one number per line, plain text only. Do not use any tools.' })
  await p1run // preflight ack (turn started)
  await sleep(2500) // ensure deep in streaming
  const st = await getState()
  console.log(`P1 mid-run state: isStreaming=${st.isStreaming} pending=${st.pendingMessageCount}`)
  const tSend = Date.now() - t0
  const r1 = await send('prompt', { message: 'PROBE-P1: stop counting. Reply with exactly: P1-ACK', streamingBehavior: 'steer' })
  const rtt = Date.now() - t0 - tSend
  console.log(`P1 steer-prompt response: success=${r1.obj.success} rtt=${rtt}ms err=${r1.obj.error ?? '-'}`)
  await waitSettled()
  const s1 = await getState()
  console.log(`P1 after settled: isStreaming=${s1.isStreaming} pending=${s1.pendingMessageCount}`)

  // ─── P3: bare steer during streaming → drained by run loop? ───
  console.log('\n===== P3 START =====')
  await send('prompt', { message: 'Count from 1 to 25, one number per line, plain text only. Do not use any tools.' })
  await sleep(2500)
  const st3 = await getState()
  console.log(`P3 mid-run state: isStreaming=${st3.isStreaming} pending=${st3.pendingMessageCount}`)
  const r3 = await send('steer', { message: 'PROBE-P3: stop counting. Reply with exactly: P3-ACK' })
  console.log(`P3 steer response: success=${r3.obj.success} err=${r3.obj.error ?? '-'}`)
  await waitSettled()
  const s3 = await getState()
  console.log(`P3 after settled: isStreaming=${s3.isStreaming} pending=${s3.pendingMessageCount}`)

  // ─── P2: bare steer on idle → pure queue, no wake ───
  console.log('\n===== P2 START =====')
  const r2 = await send('steer', { message: 'PROBE-P2: reply with exactly: P2-ACK' })
  console.log(`P2 idle steer response: success=${r2.obj.success} err=${r2.obj.error ?? '-'}`)
  const beforeCount = events.filter(e => e.type === 'agent_start').length
  await sleep(12000) // 12s of silence
  const s2 = await getState()
  const wakes = events.filter(e => e.type === 'agent_start').length - beforeCount
  console.log(`P2 after 12s idle: agent_start events during window=${wakes} isStreaming=${s2.isStreaming} pending=${s2.pendingMessageCount}`)
  console.log('P2 triggering drain via new prompt...')
  await send('prompt', { message: 'Say OK' })
  await waitSettled()
  const s2b = await getState()
  console.log(`P2 after trigger+settled: pending=${s2b.pendingMessageCount}`)

  // ─── entries dump for message-order verification ───
  const ge = await send('get_entries')
  writeFileSync('/tmp/pi-probe-delivery-20260823/entries.json', JSON.stringify(ge.obj, null, 2))
  console.log('\nget_entries written to entries.json')
} catch (e) {
  console.error('PROBE FAILED:', e)
} finally {
  writeFileSync('/tmp/pi-probe-delivery-20260823/events.json', JSON.stringify(events, null, 2))
  console.log('events.json written. exiting.')
  child.kill('SIGTERM')
  await sleep(500)
  process.exit(0)
}
