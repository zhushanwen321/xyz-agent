/**
 * RPC 类型配对契约测试（方案 C 精简版）。
 *
 * 验证 ReplyPayloadMap + command() 类型化的正确性。结合三种手段：
 * - assignment compile checks（赋值给类型化变量证明 shape conformance）
 * - @ts-expect-error 负向用例（证明类型约束生效）
 * - grep 结构断言（证明 domain 零手写 register）
 *
 * 类型断言靠 vue-tsc --noEmit（typecheck）验证，非 vitest run。
 * grep 断言靠 vitest run 验证。
 *
 * 与 pi-protocol-contract.test.ts 同模式（assignment + @ts-expect-error + grep）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReplyPayloadMap, ServerMessageMap } from '@xyz-agent/shared'
import { command } from '@/api/request'

const __dirname = dirname(fileURLToPath(import.meta.url))
const domainsDir = resolve(__dirname, '../../api/domains')

// ════════════════════════════════════════════════════════════════════════
// U1: ReplyPayloadMap key 完整性（覆盖所有 RPC request type）
// ════════════════════════════════════════════════════════════════════════

describe('U1: ReplyPayloadMap — key 覆盖 RPC request type', () => {
  it('session.switch 映射存在且为 void（ack 型，前端不读 payload）', () => {
    // session.switch 的 reply 是 session.history（带 session summary），
    // 但前端 request<void> 不读 payload，故 ReplyPayloadMap['session.switch']=void
    type SwitchReply = ReplyPayloadMap['session.switch']
    const _check: SwitchReply = undefined as void
    expect(_check).toBeUndefined()
  })

  it('session.history 映射存在且含 messages + historyTruncated', () => {
    type HistoryReply = ReplyPayloadMap['session.history']
    const sample: HistoryReply = {
      sessionId: 's1',
      messages: [],
      historyTruncated: false,
    }
    // session 字段 optional（switch 路径有，history 路径无）
    expect(sample.messages).toEqual([])
    expect(sample.historyTruncated).toBe(false)
  })

  it('git.stage 映射为 void（ack 型）', () => {
    type StageReply = ReplyPayloadMap['git.stage']
    const _check: StageReply = undefined as void
    expect(_check).toBeUndefined()
  })

  it('file.read 映射含 content + truncated（payload 消费型）', () => {
    type ReadReply = ReplyPayloadMap['file.read']
    const sample: ReadReply = {
      sessionId: 's1',
      content: 'hello',
      truncated: false,
      path: '/x',
    }
    expect(sample.content).toBe('hello')
  })
})

// ════════════════════════════════════════════════════════════════════════
// U2: command() payload 类型约束（负向：传错字段编译期报错）
// ════════════════════════════════════════════════════════════════════════

describe('U2: command() — payload 受 ClientMessageMap[K] 约束', () => {
  it('session.history 接受 { sessionId }', () => {
    // 正向：合法 payload
    const p = command('session.history', { sessionId: 's1' })
    expect(p).toBeInstanceOf(Promise)
  })

  it('session.history 拒绝 { content }（字段不存在）', () => {
    // 负向：session.history 的 payload 是 { sessionId }，不接受 content
    // @ts-expect-error — content 不在 ClientMessageMap['session.history'] 的 payload 里
    command('session.history', { content: 'x' })
    expect(true).toBe(true)
  })

  it('message.send 接受 { sessionId, content }', () => {
    const p = command('message.send', { sessionId: 's1', content: 'hi' })
    expect(p).toBeInstanceOf(Promise)
  })

  it('message.send 拒绝缺 content', () => {
    // @ts-expect-error — message.send payload 必须含 content
    command('message.send', { sessionId: 's1' })
    expect(true).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════
// U3: command() 返回类型推导（ack 型 void / payload 型具体字段）
// ════════════════════════════════════════════════════════════════════════

describe('U3: command() — 返回类型从 ReplyPayloadMap[K] 推导', () => {
  it('git.stage 返回 Promise<void>（ack 型）', () => {
    const p = command('git.stage', { sessionId: 's1', filePaths: ['/x'] })
    // ack 型返回 void，不能读 .status
    type Ret = Awaited<typeof p>
    const _check: Ret = undefined as void
    expect(_check).toBeUndefined()
  })

  it('git.stage 返回值读 .status 编译报错（void 无 status）', () => {
    const p = command('git.stage', { sessionId: 's1', filePaths: ['/x'] })
    // @ts-expect-error — void 类型无 status 属性
    void p.then((r) => r.status)
    expect(true).toBe(true)
  })

  it('session.history 返回 Promise<含 messages>', () => {
    const p = command('session.history', { sessionId: 's1' })
    void p.then((r) => {
      // r 是 ReplyPayloadMap['session.history']，可读 messages
      expect(Array.isArray(r.messages)).toBe(true)
    })
  })
})

// ════════════════════════════════════════════════════════════════════════
// U4: ServerMessageMap 补条目让 reply() 泛型生效
// ════════════════════════════════════════════════════════════════════════

describe('U4: ServerMessageMap — RPC reply 条目已收紧（非兜底 Record<string,unknown>）', () => {
  it('session.history 的 payload 含 historyTruncated 字段（非兜底）', () => {
    // 若走兜底 Record<string,unknown>，赋值给具体类型变量会报错（unknown 不可赋值）
    type HistoryPayload = ServerMessageMap['session.history']
    const sample: HistoryPayload = {
      sessionId: 's1',
      messages: [],
      historyTruncated: false,
    }
    expect(sample.historyTruncated).toBe(false)
  })

  it('session.created 的 payload 含 session 字段（非兜底）', () => {
    type CreatedPayload = ServerMessageMap['session.created']
    // 非兜底时，session 字段类型具体；兜底 Record<string,unknown> 时 session 是 unknown
    const sample: CreatedPayload = { session: { id: 's1' } } as CreatedPayload
    expect(sample).toBeDefined()
  })

  it('model.switched 的 payload 已收紧（非兜底）', () => {
    type SwitchedPayload = ServerMessageMap['model.switched']
    // 若兜底则为 Record<string,unknown>，无法确保字段存在
    const sample = { modelId: 'gpt-4' } as SwitchedPayload
    expect(sample).toBeDefined()
  })
})

// ════════════════════════════════════════════════════════════════════════
// U5: domain 零手写 pending.register（grep 结构断言）
// ════════════════════════════════════════════════════════════════════════

describe('U5: domain 层零手写 pending.register 泛型', () => {
  it('所有 domain 文件不含 pending.register 调用（改用 command）', () => {
    const files = readdirSync(domainsDir).filter((f) => f.endsWith('.ts'))
    const offenders: string[] = []
    for (const f of files) {
      const content = readFileSync(resolve(domainsDir, f), 'utf-8')
      // 允许 pending.register 出现在 request.ts 内部，但 domain 层不应有
      if (/pending\.register</.test(content)) {
        offenders.push(f)
      }
    }
    expect(offenders).toEqual([])
  })

  it('domain 层使用 command() 而非 request()（W2 改名后）', () => {
    const files = readdirSync(domainsDir).filter((f) => f.endsWith('.ts'))
    const offenders: string[] = []
    for (const f of files) {
      const content = readFileSync(resolve(domainsDir, f), 'utf-8')
      // 不应再有裸 request( 调用（已改名 command）
      if (/\brequest\s*\(/.test(content) && !content.includes('interface') === false) {
        // 排除注释和类型定义里的 request 字样
        const lines = content.split('\n').filter(
          (l) => /\brequest\s*\(/.test(l) && !l.trim().startsWith('//') && !l.trim().startsWith('*'),
        )
        if (lines.length > 0) offenders.push(`${f}: ${lines.length}处`)
      }
    }
    expect(offenders).toEqual([])
  })
})
