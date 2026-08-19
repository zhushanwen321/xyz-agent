/**
 * W2 生命周期等价测试（restore-fork-attach-fix F4，不变量 I3 持久性屏障）。
 *
 * 被测不变量：附着正式文件后，会话进程退出/切换前，**登记文件必须包含 pi 已写的全部
 * entry**；重新 spawn 附着同一文件，状态（entry 数 / 最后 assistant 消息 / sessionId）
 * 与退出前一致。这正是 P0 根因（附着 tmp 文件 + unlink，pi 每轮 append 按路径重建孤儿，
 * 登记文件永不更新，重启全部丢失）的回归网。
 *
 * 覆盖边界（如实声明，ADR-0063 I3）：本测试族直接驱动 switchSession + attach 断言，
 * 不经过生产 restoreSession/forkSession 全管线——生产管线整段回退 tmp 附着时本测试族
 * 不红；该形态的运行时守卫是 I1 断言（接线在生产管线内，tmp 附着瞬间 mismatch 即
 * throw）+ 第三用例（mismatch-throw 行为锁定）。
 *
 * 三用例：
 * - restore 路径：真实会话文件 switchSession 附着 → 一轮真实 prompt → kill（dispose，
 *   SIGTERM→2s→SIGKILL，与 RpcClient.kill / ProcessManager.destroySession 同语义）→
 *   文件断言（逐 entry 类型：user message + 其后 assistant message，非只断言行数）→
 *   重新 spawn 附着同一文件断言状态一致。
 * - fork 路径：同构（createForkedSessionFile 生产函数产出 fork 文件 → attach → 真实轮次
 *   → kill → 文件含该轮 + 继承历史 → 重附着一致）。
 * - attach 断言行为（C2）：真实 switchSession(A) 成功后以期望路径 B 调生产 helper
 *   assertPiSessionFile → throw 且错误信息含 A/B/恢复指引；resolve 词法归一与
 *   /var vs /private/var symlink 形态均以真实附着实测（pi 侧不展开 symlink，探针定论
 *   见 process-manager.ts assertPiSessionFile 注释）。
 *
 * 环境约定照抄先例（live-reload.test.ts / pi-protocol-contract.test.ts）：真实 spawn
 * `pi --mode rpc`（fixture，禁 mock 子进程）；模型/RUNTIME_TEST 配置即 pi-fixture.ts
 * 的 DEFAULT_MODEL 与 REAL_PI_READY 探测；skip-if-no-real-pi 约定见 pi-fixture.ts 文件头。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  spawnPiFixture,
  REAL_PI_READY,
  REAL_PI_SKIP_REASON,
  type PiFixture,
} from './pi-fixture.js'
import { assertPiSessionFile } from '../../infra/pi/session-attach-assert.js'
import { createForkedSessionFile } from '../../services/session/session-fork.js'
import { applyHeaderCwdFallback } from '../../services/session/session-lifecycle.js'

/** 等 turn 完成的上限（真实 LLM 调用；对齐 live-reload.test.ts 余量口径） */
const TURN_TIMEOUT_MS = 120_000
/** switch_session 慢 RPC 上限（对齐生产 rpc-client SLOW_TIMEOUT_MS） */
const SWITCH_TIMEOUT_MS = 120_000
/** 用例总超时 = 多次冷启动 + 多轮 LLM turn + 多次 RPC + dispose 的和再留余量 */
const TEST_TIMEOUT_MS = 360_000

/** 文件层 entry 最小形态（loadEntriesFromFile 的 xyz 侧等价读取：逐行 JSON.parse） */
interface SessionFileEntry {
  type: string
  id?: string
  parentId?: string | null
  cwd?: string
  parentSession?: string
  message?: { role?: string; [key: string]: unknown }
  [key: string]: unknown
}

/** 等价读取（验收口径：loadEntriesFromFile 或等价读取）——pi 侧为逐行 parseSessionEntryLine */
function readSessionEntries(filePath: string): SessionFileEntry[] {
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as SessionFileEntry)
}

/** message entry 的原文序列化（user 提交原文必然逐字落盘，暗号匹配用） */
function messageText(entry: SessionFileEntry): string {
  return JSON.stringify(entry.message ?? {})
}

/** get_entries → entry 列表（kill 前的 pi 内存态快照） */
async function fetchEntries(fx: PiFixture): Promise<SessionFileEntry[]> {
  const resp = await fx.sendCommand('get_entries')
  const raw: unknown = resp.data?.entries
  if (!Array.isArray(raw)) throw new Error('get_entries reply has no entries array')
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => e as unknown as SessionFileEntry)
}

/** 最后一条 assistant message entry（kill 前/重附着后的状态一致性对比对象） */
function lastAssistantMessage(entries: SessionFileEntry[]): SessionFileEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type === 'message' && e.message?.role === 'assistant') return e
  }
  return undefined
}

/** 生产 helper 的 fixture 适配（真实 get_state RPC，非 mock 返回值） */
function fixtureStateClient(fx: PiFixture): { getState(): Promise<Record<string, unknown> | undefined> } {
  return {
    getState: async () => {
      const resp = await fx.sendCommand('get_state')
      return resp.data
    },
  }
}

/**
 * 生成一个真实会话文件到 workDir（阶段 1 公共流程）：
 * spawn fixture → 真实 prompt 一轮（含暗号）→ agent_end（pi 已 flush 落盘）→
 * 复制到 workDir 并把 header cwd 归一到 workDir（fixture sessionDir 即将被 dispose 删除，
 * 死 cwd 会使下一次附着 throw MissingSessionCwdError——变换用生产纯函数
 * applyHeaderCwdFallback，与 restoreSession F3 管线同款）→ dispose。
 */
async function seedSessionFile(workDir: string, fileName: string, marker: string): Promise<string> {
  let fx = await spawnPiFixture()
  try {
    await fx.sendCommand('prompt', { message: `Reply with exactly the word: ${marker}` })
    await fx.waitForEvent((e) => e.type === 'agent_end', TURN_TIMEOUT_MS)
    const state = await fx.sendCommand('get_state')
    const srcFile = state.data?.sessionFile
    if (typeof srcFile !== 'string') throw new Error(`get_state.sessionFile missing after seeded turn (marker: ${marker})`)
    const target = join(workDir, fileName)
    const raw = readFileSync(srcFile, 'utf-8')
    writeFileSync(target, applyHeaderCwdFallback(raw, workDir))
    return target
  } finally {
    await fx.dispose()
  }
}

/**
 * 附着指定文件并跑一轮真实 prompt。返回 kill 前快照（双基线，口径实测定论）：
 * - beforeTurnMem：附着完成（switchSession 成功 + attach 断言过）后、prompt 前的
 *   get_entries 快照——pi 内存基线；
 * - beforeTurnFileCount：附着完成后登记文件的 entry 行数——文件基线。**必须在附着后取**：
 *   附着瞬间 pi 即向登记文件写入 entry（实测：2 条 custom entry，附着 = 立即绑定写目标的
 *   直接自证），附着前基线会把这批写入误计入 turn 增长；
 * - beforeKill：agent_end 后、kill 前的 get_entries 快照（pi 已全量持久化）。
 * 口径差异（实测定论）：文件含 session header entry，get_entries 不含——两侧各自相减
 * （afterFile − beforeTurnFileCount ↔ beforeKillMem − beforeTurnMem）口径差抵消。
 */
async function attachAndRunTurn(targetFile: string, marker: string): Promise<{ fx: PiFixture; beforeTurnMem: SessionFileEntry[]; beforeTurnFileCount: number; beforeKill: SessionFileEntry[] }> {
  const fx = await spawnPiFixture()
  await fx.sendCommand('switch_session', { sessionPath: targetFile }, SWITCH_TIMEOUT_MS)
  // attach 断言（I1）：真实正式文件天然通过——本行同时是 C3「withEphemeralPi/附着天然通过」
  // 语义在真实 pi 上的直接证据。
  await assertPiSessionFile(fixtureStateClient(fx), targetFile, `attach-lifecycle(${basename(targetFile)})`)
  const beforeTurnMem = await fetchEntries(fx)
  const beforeTurnFileCount = readSessionEntries(targetFile).length
  await fx.sendCommand('prompt', { message: `Reply with exactly the word: ${marker}` })
  await fx.waitForEvent((e) => e.type === 'agent_end', TURN_TIMEOUT_MS)
  const beforeKill = await fetchEntries(fx)
  return { fx, beforeTurnMem, beforeTurnFileCount, beforeKill }
}

describe.skipIf(!REAL_PI_READY)(
  `equivalence: attach 生命周期（真实 pi 子进程，W2${REAL_PI_SKIP_REASON ? `｜skip：${REAL_PI_SKIP_REASON}` : ''}）`,
  () => {
  let fixture: PiFixture | null = null

  afterEach(async () => {
    if (fixture) {
      await fixture.dispose()
      fixture = null
    }
  })

  it(
    'restore 路径：附着正式文件 → 真实轮次 → kill → 文件含该轮（逐 entry 类型）→ 重附着状态一致',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'attach-equiv-restore-'))
      try {
        // ── 阶段 1：真实生成既有会话文件（= sessions 目录内的正式文件 / 登记路径）──
        const targetFile = await seedSessionFile(workDir, 'restored-session.jsonl', 'attach-seed')
        const header = readSessionEntries(targetFile)[0]
        expect(header?.type).toBe('session')
        const seedCount = readSessionEntries(targetFile).length
        expect(seedCount).toBeGreaterThan(0)

        // ── 阶段 2：restore 形态附着 + 一轮真实对话 ──
        const { fx, beforeTurnMem, beforeTurnFileCount, beforeKill } = await attachAndRunTurn(targetFile, 'attach-round-2')
        fixture = fx

        // 附着即绑定写目标的直接自证：附着瞬间 pi 已向登记文件写入 entry（实测 ≥2 条）
        expect(beforeTurnFileCount).toBeGreaterThan(seedCount)

        // ── 阶段 3：kill（dispose ≈ destroySession：SIGTERM → 2s → SIGKILL）──
        await fx.dispose()
        fixture = null

        // ── 阶段 4：持久性屏障（I3）——登记文件包含 pi 已写的全部 entry ──
        const afterKill = readSessionEntries(targetFile)
        // 增长量守恒（I3 精确表述）：pi 内存新增 N 条（beforeKill − beforeTurnMem）⇒ 文件
        // 新增 N 条（afterKill − beforeTurnFileCount）。两侧基线都在附着后取，口径差
        //（文件含 header、get_entries 不含）相减抵消。tmp 附着回退形态下此处必红：登记文件零增长。
        expect(afterKill.length - beforeTurnFileCount).toBe(beforeKill.length - beforeTurnMem.length)
        // 逐 entry 类型可指认（非只断言行数）：本轮 user message entry——用户提交原文必然
        // 逐字落盘，暗号匹配是强断言
        const round2UserIdx = afterKill.findIndex(
          (e) => e.type === 'message' && e.message?.role === 'user' && messageText(e).includes('attach-round-2'),
        )
        expect(round2UserIdx).toBeGreaterThan(-1)
        // 其后（同轮）assistant message entry——LLM 回复落盘
        const tail = afterKill.slice(round2UserIdx + 1)
        expect(tail.filter((e) => e.type === 'message' && e.message?.role === 'assistant').length).toBeGreaterThanOrEqual(1)
        // 继承的历史未被破坏：种子轮次的 user entry 仍在
        expect(afterKill.some((e) => e.type === 'message' && e.message?.role === 'user' && messageText(e).includes('attach-seed'))).toBe(true)
        // 新轮次确实发生在文件上：行数较附着前增长
        expect(afterKill.length).toBeGreaterThan(seedCount)

        // ── 阶段 5：重附着等价——重新 spawn 附着同一文件，状态一致 ──
        let fx2: PiFixture | null = await spawnPiFixture()
        fixture = fx2
        try {
          await fx2.sendCommand('switch_session', { sessionPath: targetFile }, SWITCH_TIMEOUT_MS)
          await assertPiSessionFile(fixtureStateClient(fx2), targetFile, 'restore-reattach')
          // 附着语义完整：pi 的 sessionId = 文件 header 的会话 id（附着的就是这个文件的那个会话）
          const state = await fx2.sendCommand('get_state')
          expect(state.data?.sessionId).toBe(header.id)
          const afterReattach = await fetchEntries(fx2)
          // 同口径等价（get_entries ↔ get_entries）：重附着后 pi 读到的**历史**与 kill 前
          // 逐条一致——以 kill 前最后一条 entry id 为界，界前 deep equal（无丢失/重复/篡改）；
          // 界后仅允许 pi 附着行为自身的追加（实测每次附着写 ~2 条 custom entry，写方是
          // pi、落在登记文件，属合法），不得改写历史。
          const lastKillId = beforeKill[beforeKill.length - 1]?.id
          if (typeof lastKillId !== 'string') throw new Error('beforeKill last entry has no id')
          const cutIdx = afterReattach.findIndex((e) => e.id === lastKillId)
          expect(cutIdx).toBe(beforeKill.length - 1)
          expect(afterReattach.slice(0, cutIdx + 1)).toEqual(beforeKill)
          expect(lastAssistantMessage(afterReattach)).toEqual(lastAssistantMessage(afterKill))
        } finally {
          await fx2.dispose()
          fixture = null
          fx2 = null
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true })
      }
    },
  )

  it(
    'fork 路径：fork 文件 attach → 真实轮次 → kill → 文件含该轮 + 继承历史 → 重附着状态一致',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'attach-equiv-fork-'))
      try {
        // ── 阶段 1：真实源会话 ──
        const sourceFile = await seedSessionFile(workDir, 'fork-source.jsonl', 'attach-fork-seed')
        const sourceEntries = readSessionEntries(sourceFile)
        // fork 点 = 源文件最后一条 message entry（includeFrom=true 保留全历史）
        let forkEntryId: string | undefined
        for (let i = sourceEntries.length - 1; i >= 0; i--) {
          const e = sourceEntries[i]
          if (e.type === 'message' && typeof e.id === 'string') { forkEntryId = e.id; break }
        }
        if (typeof forkEntryId !== 'string') throw new Error('fork source has no message entry with id')

        // ── 阶段 2：生产 fork 链路产出 fork 文件（登记表 §4 ⑥ 创建型合法形态）──
        const forked = await createForkedSessionFile(sourceFile, forkEntryId, true, workDir, forkEntryId)
        expect(existsSync(forked.filePath)).toBe(true)
        // 血缘指针未断（V3 语义的文件层断言）：header.parentSession 指回源文件
        const forkHeader = readSessionEntries(forked.filePath)[0]
        expect(forkHeader?.type).toBe('session')
        expect(forkHeader?.parentSession).toBe(sourceFile)
        const forkSeedCount = readSessionEntries(forked.filePath).length

        // ── 阶段 3：fork 文件附着 + 一轮真实对话 ──
        const { fx, beforeTurnMem, beforeTurnFileCount, beforeKill } = await attachAndRunTurn(forked.filePath, 'attach-fork-round')

        // ── 阶段 4：kill ──
        await fx.dispose()
        fixture = null

        // ── 阶段 5：持久性屏障——fork 文件包含该轮 + 继承历史 ──
        const afterKill = readSessionEntries(forked.filePath)
        // 附着即绑定写目标（同 restore 用例）+ 增长量守恒（双基线附着后取，口径差抵消）
        expect(beforeTurnFileCount).toBeGreaterThan(forkSeedCount)
        expect(afterKill.length - beforeTurnFileCount).toBe(beforeKill.length - beforeTurnMem.length)
        const roundUserIdx = afterKill.findIndex(
          (e) => e.type === 'message' && e.message?.role === 'user' && messageText(e).includes('attach-fork-round'),
        )
        expect(roundUserIdx).toBeGreaterThan(-1)
        const tail = afterKill.slice(roundUserIdx + 1)
        expect(tail.filter((e) => e.type === 'message' && e.message?.role === 'assistant').length).toBeGreaterThanOrEqual(1)
        // fork 继承的源历史在文件内（树过滤保留）
        expect(afterKill.some((e) => e.type === 'message' && e.message?.role === 'user' && messageText(e).includes('attach-fork-seed'))).toBe(true)

        // ── 阶段 6：重附着等价 ──
        let fx2: PiFixture | null = await spawnPiFixture()
        fixture = fx2
        try {
          await fx2.sendCommand('switch_session', { sessionPath: forked.filePath }, SWITCH_TIMEOUT_MS)
          await assertPiSessionFile(fixtureStateClient(fx2), forked.filePath, 'fork-reattach')
          const state = await fx2.sendCommand('get_state')
          expect(state.data?.sessionId).toBe(forked.sessionId)
          const afterReattach = await fetchEntries(fx2)
          // 同口径等价（get_entries ↔ get_entries）：历史逐条一致（同 restore 用例，以 kill
          // 前最后 entry id 为界 deep equal，界后仅附着型追加）
          const lastKillId = beforeKill[beforeKill.length - 1]?.id
          if (typeof lastKillId !== 'string') throw new Error('beforeKill last entry has no id')
          const cutIdx = afterReattach.findIndex((e) => e.id === lastKillId)
          expect(cutIdx).toBe(beforeKill.length - 1)
          expect(afterReattach.slice(0, cutIdx + 1)).toEqual(beforeKill)
          expect(lastAssistantMessage(afterReattach)).toEqual(lastAssistantMessage(afterKill))
        } finally {
          await fx2.dispose()
          fixture = null
          fx2 = null
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true })
      }
    },
  )

  it(
    'attach 断言行为：真实附着后错误期望必 throw（含双路径与恢复指引）；resolve 词法归一 / symlink 形态实测',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'attach-equiv-assert-'))
      try {
        // 空文件（0 字节）可被 pi 附着：setSessionFile 对 size===0 文件初始化 session header
        //（pi-mono session-manager.ts:817-826 loadEntriesFromFile 空文件分支）
        const fileA = join(workDir, 'case-a.jsonl')
        writeFileSync(fileA, '')
        let fx: PiFixture | null = await spawnPiFixture()
        fixture = fx
        await fx.sendCommand('switch_session', { sessionPath: fileA }, SWITCH_TIMEOUT_MS)
        const client = fixtureStateClient(fx)

        // 自洽基线：真实 switchSession(A) 后以 A 断言 → pass（双侧同源，resolve 归一后相等）
        await assertPiSessionFile(client, fileA, 'c2-self')

        // 真实附着 A 后以错误期望 B 调 helper → throw；错误信息含 A（pi 原样回报）、B、恢复指引
        const fileB = join(workDir, 'case-b.jsonl')
        const mismatch: unknown = await assertPiSessionFile(client, fileB, 'c2-mismatch').then(
          () => null,
          (e: unknown) => e,
        )
        expect(mismatch).toBeInstanceOf(Error)
        const msg = mismatch instanceof Error ? mismatch.message : String(mismatch)
        expect(msg).toContain(fileA)
        expect(msg).toContain(fileB)
        expect(msg).toContain('恢复指引')

        // resolve 词法归一实测：同文件的冗余段变体（/x/../x/...）resolve 后与 A 相等 → pass
        const dir = dirname(fileA)
        const redundant = join(dir, '..', basename(dir), basename(fileA))
        expect(resolve(redundant)).toBe(resolve(fileA))
        await assertPiSessionFile(client, redundant, 'c2-lexical-normalize')

        // /var vs /private/var 实测（macOS tmpdir 天然 /var/folders/... 形态）：pi 侧
        // resolvePath 不展开 symlink、原样回报 /var 形态；以 realpath（/private/var 形态）
        // 作期望 → resolve 归一后仍不等 → throw（symlink 视角分裂就是要 fail loud 的路径
        // 管理分裂，不误归一）。非 macOS（无此 symlink 形态差异）跳过本断言。
        const realPath = realpathSync(fileA)
        if (realPath !== fileA) {
          await expect(assertPiSessionFile(client, realPath, 'c2-symlink-split')).rejects.toThrow('[attach-mismatch]')
        }

        await fx.dispose()
        fixture = null
        fx = null
      } finally {
        rmSync(workDir, { recursive: true, force: true })
      }
    },
  )

  it(
    'I1 契约报警器：附着成功后 get_state().sessionFile 必为非空 string（pi 改字段形态时先红）',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      // 背景（W3 遗留 1）：session-attach-assert 的跳过分支 2——get_state 无 sessionFile
      // 字段时 console.warn 后跳过断言。护栏有效性依赖 pi 持续提供该字段；本用例在契约层
      // 锁定「附着成功 ⇒ sessionFile 为非空 string」，未来 pi 升级改字段名/形态时此处先红，
      // 静默跳过分支的前提被拦截（护栏失效的报警器）。
      const workDir = mkdtempSync(join(tmpdir(), 'attach-equiv-contract-'))
      try {
        // 空文件可被 pi 附着并初始化 header（同第三用例的先例口径）
        const fileA = join(workDir, 'contract.jsonl')
        writeFileSync(fileA, '')
        let fx: PiFixture | null = await spawnPiFixture()
        fixture = fx
        try {
          await fx.sendCommand('switch_session', { sessionPath: fileA }, SWITCH_TIMEOUT_MS)
          const state = await fx.sendCommand('get_state')
          // 断言强度刻意非 truthy：''（空串）或非 string 形态（null/undefined/对象）都要红
          const sessionFile: unknown = state.data?.sessionFile
          expect(typeof sessionFile).toBe('string')
          expect((sessionFile as string).length).toBeGreaterThan(0)
          // 附着绑定语义自证：回报路径就是附着目标（resolve 词法归一口径，同 assertPiSessionFile）
          expect(resolve(sessionFile as string)).toBe(resolve(fileA))
        } finally {
          await fx.dispose()
          fixture = null
          fx = null
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true })
      }
    },
  )
})
