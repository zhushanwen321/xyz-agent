/**
 * SessionBuffer 模块隔离单测（P2-s1-w2 / TK-W2.1）。
 *
 * 覆盖 SessionBuffer class 的核心行为（不依赖 broker/services mock）：
 * - append 基本：push 入尾、bytes 累加、entries 按 seq 升序
 * - TC-W2.2（模块级）：getReplayPlan 返回原样 data 字符串（零再序列化的基础）
 * - TC-W2.3（模块级）：条数双限 LRU 驱逐（maxCount 超限删头 + onEvict 回调）
 * - TC-W2.4（模块级）：字节双限 LRU 驱逐（maxBytes 超限删头 + bytes 扣减）
 * - getReplayPlan 过滤（seq>lastSeq，保升序）
 * - onEvict 回调在每次驱逐时触发，参数是被驱逐 seq
 *
 * 完整分桶/路由/broker 编排测试见 message-broker.replay.test.ts。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/session-buffer.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionBuffer } from '../session-buffer.js'

describe('SessionBuffer（模块隔离）', () => {
  // ── append 基本 ──────────────────────────────────────────────────

  it('append：push 入尾、bytes 累加、entries 按 seq 升序', () => {
    const buf = new SessionBuffer(100, 1024, () => {})
    buf.append(1, '{"seq":1}')
    buf.append(2, '{"seq":2}')
    buf.append(3, '{"seq":3}')

    expect(buf.entries.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(buf.bytes).toBe('{"seq":1}'.length + '{"seq":2}'.length + '{"seq":3}'.length)
    expect(buf.size).toBe(3)
  })

  it('append 存原样 data 字符串（getReplayPlan 返回的 data 与入参严格相等）', () => {
    const buf = new SessionBuffer(100, 1024, () => {})
    const data = '{"type":"message.start","seq":1,"payload":{"sessionId":"A"}}'
    buf.append(1, data)

    const plan = buf.getReplayPlan(0)
    expect(plan).toHaveLength(1)
    // 严格相等：证实原样存储，回放零再序列化（TC-W2.2 模块级基础）
    expect(plan[0].data).toBe(data)
    expect(plan[0].seq).toBe(1)
  })

  // ── TC-W2.3（模块级）：条数双限 LRU 驱逐 ──────────────────────────

  it('TC-W2.3 模块级：maxCount=3，第 4 条触发删头 + onEvict 回调推进', () => {
    const evicted: number[] = []
    const buf = new SessionBuffer(3, 1024, (s) => evicted.push(s))

    buf.append(1, 'a')
    buf.append(2, 'b')
    buf.append(3, 'c')
    expect(buf.size).toBe(3)
    expect(evicted).toEqual([])

    // 第 4 条触发删头（seq=1 被驱逐）
    buf.append(4, 'd')
    expect(buf.entries.map((e) => e.seq)).toEqual([2, 3, 4])
    expect(buf.size).toBe(3)
    expect(evicted).toEqual([1])
  })

  it('条数驱逐：连发 5 条 maxCount=3，头部两条都被驱逐，onEvict 依次触发', () => {
    const evicted: number[] = []
    const buf = new SessionBuffer(3, 1024, (s) => evicted.push(s))

    for (let i = 1; i <= 5; i++) buf.append(i, 'x')

    expect(buf.entries.map((e) => e.seq)).toEqual([3, 4, 5])
    expect(evicted).toEqual([1, 2])
    // bytes 只剩 3 条
    expect(buf.bytes).toBe(3)
  })

  // ── TC-W2.4（模块级）：字节双限 LRU 驱逐 ──────────────────────────

  it('TC-W2.4 模块级：maxBytes=10 累计超限删头，bytes 同步扣减', () => {
    const evicted: number[] = []
    // 每条 data.length=4，maxBytes=10 → 第 3 条累计 12 > 10 触发删头
    const buf = new SessionBuffer(100, 10, (s) => evicted.push(s))

    buf.append(1, 'aaaa') // bytes=4
    buf.append(2, 'bbbb') // bytes=8
    expect(buf.bytes).toBe(8)
    expect(evicted).toEqual([])

    buf.append(3, 'cccc') // bytes=12 > 10 → 删 seq=1（bytes-4=8）
    expect(buf.entries.map((e) => e.seq)).toEqual([2, 3])
    expect(buf.bytes).toBe(8)
    expect(evicted).toEqual([1])
  })

  it('字节驱逐：单次 append 字节超限需删多条才满足', () => {
    const evicted: number[] = []
    // 每条 4B，maxBytes=10：先存 2 条（8B），再 append 一条 4B → 12B，删 1 条 → 8B ok。
    // 但若 append 后立即又超（如 maxBytes 极小），while 持续删。
    const buf = new SessionBuffer(100, 6, (s) => evicted.push(s))

    buf.append(1, 'aaaa') // 4B <= 6 ok
    buf.append(2, 'bbbb') // 8B > 6 → 删 seq=1 → 4B ok
    expect(buf.entries.map((e) => e.seq)).toEqual([2])
    expect(evicted).toEqual([1])

    buf.append(3, 'cccc') // 8B > 6 → 删 seq=2 → 4B ok
    expect(buf.entries.map((e) => e.seq)).toEqual([3])
    expect(evicted).toEqual([1, 2])
  })

  // ── getReplayPlan 过滤 ───────────────────────────────────────────

  it('getReplayPlan：返回 seq>lastSeq 条目，保升序', () => {
    const buf = new SessionBuffer(100, 1024, () => {})
    for (let i = 1; i <= 5; i++) buf.append(i, `d${i}`)

    expect(buf.getReplayPlan(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
    expect(buf.getReplayPlan(2).map((e) => e.seq)).toEqual([3, 4, 5])
    expect(buf.getReplayPlan(5)).toEqual([]) // 无 seq>5
    expect(buf.getReplayPlan(99)).toEqual([]) // lastSeq 超过所有 seq
  })

  it('getReplayPlan：驱逐后只返回仍在桶内的 seq>lastSeq 条目', () => {
    const buf = new SessionBuffer(3, 1024, () => {})
    for (let i = 1; i <= 5; i++) buf.append(i, `d${i}`)
    // 桶内只剩 seq 3,4,5（1,2 被驱逐）

    expect(buf.getReplayPlan(0).map((e) => e.seq)).toEqual([3, 4, 5]) // 1,2 已不在桶
    expect(buf.getReplayPlan(4).map((e) => e.seq)).toEqual([5])
  })

  // ── onEvict 回调 ─────────────────────────────────────────────────

  it('onEvict：每次驱逐触发，参数是被驱逐 seq（顺序 = 删头顺序）', () => {
    const evicted: number[] = []
    const buf = new SessionBuffer(2, 1024, (s) => evicted.push(s))

    buf.append(1, 'a')
    buf.append(2, 'b')
    buf.append(3, 'c') // 删 seq=1
    buf.append(4, 'd') // 删 seq=2

    expect(evicted).toEqual([1, 2])
  })

  it('无驱逐时 onEvict 不触发', () => {
    const onEvict = vi.fn()
    const buf = new SessionBuffer(100, 1024, onEvict)

    buf.append(1, 'a')
    buf.append(2, 'b')
    expect(onEvict).not.toHaveBeenCalled()
  })

  // ── 字节口径：Buffer.byteLength（真实 UTF-8 字节，非 .length UTF-16 code unit）──────────

  it('bytes 按 Buffer.byteLength(utf8) 计算：CJK「你好」length=2 但 byteLength=6', () => {
    const buf = new SessionBuffer(100, 1024, () => {})
    const data = '你好' // .length=2，UTF-8 字节=6
    expect(data.length).toBe(2) // sanity：确认 JS 字符串 length 是 code unit 数
    buf.append(1, data)

    // 修复前（data.length）：bytes=2（偏松，env 名是字节语义但用 code unit 计数）
    // 修复后（Buffer.byteLength）：bytes=6（真实 UTF-8 字节）
    expect(buf.bytes).toBe(Buffer.byteLength(data, 'utf8'))
    expect(buf.bytes).toBe(6)
    expect(buf.bytes).not.toBe(data.length)
  })

  it('bytes 按 Buffer.byteLength(utf8) 计算：emoji 😀 length=2 但 byteLength=4', () => {
    const buf = new SessionBuffer(100, 1024, () => {})
    const data = '😀' // .length=2（代理对），UTF-8 字节=4
    expect(data.length).toBe(2) // sanity
    buf.append(1, data)

    expect(buf.bytes).toBe(Buffer.byteLength(data, 'utf8'))
    expect(buf.bytes).toBe(4)
  })

  it('字节驱逐用 byteLength 口径：CJK 消息超 maxBytes 按 UTF-8 字节驱逐', () => {
    const evicted: number[] = []
    // maxBytes=5：单条「你好」byteLength=6 > 5 → append 后立即驱逐自身（兜底防护）
    const buf = new SessionBuffer(100, 5, (s) => evicted.push(s))
    buf.append(1, '你好') // byteLength=6 > 5

    // 该条刚 push，bytes=6 > 5 触发驱逐，shift 删自身 → entries 空、bytes=0
    expect(buf.entries).toHaveLength(0)
    expect(buf.bytes).toBe(0)
    expect(evicted).toEqual([1])
  })

  it('字节驱逐边界：ASCII 与 CJK 混合，byteLength 累加正确', () => {
    const evicted: number[] = []
    // maxBytes=7：'ab'(2) + '你好'(6) = 8 > 7 → 删 'ab' → 剩 '你好'(6) <= 7 ok
    const buf = new SessionBuffer(100, 7, (s) => evicted.push(s))
    buf.append(1, 'ab') // byteLength=2，bytes=2
    buf.append(2, '你好') // byteLength=6，bytes=8 > 7 → 删 seq=1 → bytes=6

    expect(buf.entries.map((e) => e.seq)).toEqual([2])
    expect(buf.bytes).toBe(6)
    expect(evicted).toEqual([1])
  })
})
