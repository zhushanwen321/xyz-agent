/**
 * live ≡ reload 等价性断言雏形（W5，data-source-governance P0.4）。
 *
 * 不变量：实时链路累积的消息快照 == `get_entries` 全量重放的 message entry 快照。
 * 对应仓库规则 #9「对话流状态实时可见 + 重开 session 仍可见」的协议层基线——
 * 实时链路（事件流）与持久化链路（get_entries 重放）若分叉，重开 session 后对话流
 * 就会与实时看到的不一致。
 *
 * 断言对象为原始消息/entry 序列（W20-W21 后升级 store 级快照）。live 侧等价源是
 * message_end 事件流（pi 0.84 不为常规 append 发 entry 事件，协议依据见 pi-fixture.ts
 * 文件头「协议事实」节）。边界：本雏形的 prompt 不触发工具调用——bash 执行消息走独立
 * 持久化路径（不经 message_end），带工具的等价性由后续 wave 在本目录扩展覆盖。
 *
 * skip-if-no-pi：pi 缺席时本 describe 整体 skip（约定见 pi-fixture.ts 文件头）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import {
  spawnPiFixture,
  PI_PATH,
  type PiFixture,
  type PiAgentMessage,
  type PiSessionEntry,
} from './pi-fixture.js'

/** 等 turn 完成的上限（真实 LLM 调用；探针实测一轮 ~5s，取 24 倍余量） */
const TURN_TIMEOUT_MS = 120_000
/** 用例总超时 = 冷启动 + turn + get_entries + dispose 的和再留余量 */
const TEST_TIMEOUT_MS = 180_000

describe.skipIf(!PI_PATH)('equivalence: live ≡ reload（真实 pi 子进程）', () => {
  let fixture: PiFixture | null = null

  afterEach(async () => {
    if (fixture) {
      await fixture.dispose()
      fixture = null
    }
  })

  it('实时累积的消息快照 == get_entries 全量重放快照', { timeout: TEST_TIMEOUT_MS }, async () => {
    const fx = await spawnPiFixture()
    fixture = fx

    // 最小操作序列：发一条 prompt（prompt 响应在 preflight 即返回，不等生成完成），
    // 等 turn 收口事件 agent_end（message_end 持久化先于 agent_end，见 pi-fixture 头注释）
    await fx.sendCommand('prompt', { message: 'Reply with exactly the word: pong' })
    await fx.waitForEvent((e) => e.type === 'agent_end', TURN_TIMEOUT_MS)

    // live 侧：实时累积的消息快照（message_end 流，含 user + assistant）
    const liveMessages = fx
      .collectEvents((e) => e.type === 'message_end')
      .map((e) => e.message)
      .filter((m): m is PiAgentMessage => m !== undefined)

    // reload 侧：get_entries 全量重放，取 message entry 的 .message
    const reloadResp = await fx.sendCommand('get_entries')
    const rawEntries: unknown = reloadResp.data?.entries
    expect(Array.isArray(rawEntries)).toBe(true)
    const entries = (rawEntries as unknown[]).filter(
      (e): e is PiSessionEntry => typeof e === 'object' && e !== null,
    )
    const messageEntries = entries.filter((e) => e.type === 'message')
    const reloadMessages = messageEntries
      .map((e) => e.message)
      .filter((m): m is PiAgentMessage => m !== undefined)

    // 非空守卫（防 0 == 0 空转）+ deep equal（逐字段，禁止只断言长度）
    expect(liveMessages.length).toBeGreaterThan(0)
    expect(reloadMessages.length).toBeGreaterThan(0)
    expect(liveMessages).toEqual(reloadMessages)

    // entry 级结构断言：message entry 依次构成线性父子链（parentId 逐字段指向前者 id）
    messageEntries.forEach((curr, i) => {
      if (i === 0) return
      const prev = messageEntries[i - 1]
      if (prev) expect(curr.parentId).toBe(prev.id)
    })

    // dispose 后临时 session-dir 清理断言（契约锁定）
    const sessionDir = fx.sessionDir
    await fx.dispose()
    fixture = null
    expect(existsSync(sessionDir)).toBe(false)
  })
})
