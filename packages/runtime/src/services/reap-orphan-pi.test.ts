/**
 * 孤儿 pi 收殓测试（integrity-hardening §3.4 D4a/D4b）。
 *
 * 锁定：
 * - argv 判据精确性：--session-dir 值精确相等（禁子串/前缀，/a/b 不得命中 /a/bc）、
 *   --mode rpc 必须在位（不误杀用户终端交互 pi）、参数顺序无关、= 等号形态、
 *   引号与未加引号的空格路径。
 * - 防线②：ppid=1（reparent 证据）才可处置——ppid=其他活值（并存合法实例的活跃
 *   子代，如 dev+打包版共存）/ ppid=ownPid（本 runtime 子代）一律不杀。
 * - 编排时序：SIGTERM → 宽限 → 探活（signal 0）→ 仍活才 SIGKILL；SIGTERM 即 ESRCH
 *   按「已回收」计且不等待宽限；枚举失败 / Windows 降级 unsupported 不抛。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/reap-orphan-pi.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import {
  parsePsOutput,
  tokenizeArgv,
  matchesOwnPiArgv,
  findOrphanPiRows,
  reapOrphanPiProcesses,
  ORPHAN_KILL_GRACE_MS,
  type PsRow,
} from './reap-orphan-pi.js'

const DIR = '/Users/tester/.xyz-agent/pi/sessions'
const OWN_PID = 100

function row(pid: number, ppid: number, command: string): PsRow {
  return { pid, ppid, command }
}

/** xyz spawn 的 pi 典型 argv（rpc-client.ts 拼参形态，--session-dir 为最后一对参数）。 */
function piCmd(sessionDir: string): string {
  return `/opt/pi/pi --mode rpc --no-extensions --approve --session-dir ${sessionDir}`
}

/** ESRCH 错误（process.kill 对不存在 pid 的 errno 形态）。 */
function esrch(): NodeJS.ErrnoException {
  const e = new Error('process not found') as NodeJS.ErrnoException
  e.code = 'ESRCH'
  return e
}

/** 构造 ps stdout（`ps -axo pid=,ppid=,command=` 的缩进列形态）。 */
function psStdout(rows: PsRow[]): string {
  return rows.map(r => `  ${r.pid}   ${r.ppid} ${r.command}`).join('\n') + '\n'
}

describe('parsePsOutput（ps 三列解析）', () => {
  it('解析 pid/ppid/command 三列，command 含空格整段保留', () => {
    const out = psStdout([
      row(123, 1, '/opt/pi/pi --mode rpc --session-dir /a/b'),
      row(456, 123, 'node server.js'),
    ])
    expect(parsePsOutput(out)).toEqual([
      { pid: 123, ppid: 1, command: '/opt/pi/pi --mode rpc --session-dir /a/b' },
      { pid: 456, ppid: 123, command: 'node server.js' },
    ])
  })

  it('空行与非数字列行跳过（fail-open 只影响覆盖面不影响精确性）', () => {
    const out = ['', 'garbage line', '   ', '  1 2 x'].join('\n')
    expect(parsePsOutput(out)).toEqual([{ pid: 1, ppid: 2, command: 'x' }])
  })
})

describe('tokenizeArgv（引号感知分词）', () => {
  it('空格/Tab 分词，多余空白收敛', () => {
    expect(tokenizeArgv('a b\tc  d ')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('双引号/单引号内空格不分词，引号剥离', () => {
    expect(tokenizeArgv('pi --session-dir "/a b/s"')).toEqual(['pi', '--session-dir', '/a b/s'])
    expect(tokenizeArgv("pi --session-dir '/a b/s'")).toEqual(['pi', '--session-dir', '/a b/s'])
  })

  it('未加引号的空格路径被拆碎（真实 ps 形态，交由尾部匹配兜底）', () => {
    expect(tokenizeArgv('pi --session-dir /a b/s')).toEqual(['pi', '--session-dir', '/a', 'b/s'])
  })
})

describe('matchesOwnPiArgv（孤儿 argv 判据）', () => {
  it('匹配形态：--mode rpc + --session-dir 精确相等', () => {
    expect(matchesOwnPiArgv(row(1, 1, piCmd(DIR)), DIR)).toBe(true)
  })

  it('不匹配形态：缺 --mode rpc（用户终端交互 pi）', () => {
    expect(matchesOwnPiArgv(row(1, 1, `/opt/pi/pi --session-dir ${DIR}`), DIR)).toBe(false)
  })

  it('不匹配形态：--session-dir 指向其他数据目录（~/.pi 等）', () => {
    expect(matchesOwnPiArgv(row(1, 1, piCmd('/Users/tester/.pi/sessions')), DIR)).toBe(false)
  })

  it('精确等值：/a/b 与 /a/bc 双向不混淆（禁前缀/子串）', () => {
    expect(matchesOwnPiArgv(row(1, 1, piCmd('/a/bc')), '/a/b')).toBe(false)
    expect(matchesOwnPiArgv(row(1, 1, piCmd('/a/b')), '/a/bc')).toBe(false)
  })

  it('参数顺序无关：--session-dir 在前、--mode 在后同样命中', () => {
    expect(matchesOwnPiArgv(row(1, 1, `pi --session-dir ${DIR} --mode rpc`), DIR)).toBe(true)
  })

  it('= 等号形态：--mode=rpc / --session-dir=<dir>', () => {
    expect(matchesOwnPiArgv(row(1, 1, `pi --mode=rpc --session-dir=${DIR}`), DIR)).toBe(true)
  })

  it('--session-dir 之后还有其他参数时仍命中（分词路径，不依赖尾部）', () => {
    expect(matchesOwnPiArgv(row(1, 1, `pi --mode rpc --session-dir ${DIR} --model provider/m`), DIR)).toBe(true)
  })

  it('引号包裹的空格路径：分词后精确相等', () => {
    const spaced = '/Users/John Doe/.xyz-agent/pi/sessions'
    expect(matchesOwnPiArgv(row(1, 1, `pi --mode rpc --session-dir "${spaced}"`), spaced)).toBe(true)
  })

  it('未加引号的空格路径：尾部整串精确匹配兜底，且不放宽精确性', () => {
    const spaced = '/Users/John Doe/.xyz-agent/pi/sessions'
    expect(matchesOwnPiArgv(row(1, 1, `pi --mode rpc --session-dir ${spaced}`), spaced)).toBe(true)
    // 尾部多出任意字符即不匹配（/a b 不命中 /a b/s）
    expect(matchesOwnPiArgv(row(1, 1, 'pi --mode rpc --session-dir /a b/s'), '/a b')).toBe(false)
  })
})

describe('findOrphanPiRows（防线②：ppid=1 reparent 证据）', () => {
  it('孤儿判据：argv 匹配 + ppid=1 才杀；并存合法实例子代（ppid=其他活值）与本 runtime 子代（ppid=ownPid）不杀', () => {
    const rows = [
      row(201, 1, piCmd(DIR)),                          // 真孤儿：旧 runtime 死后 reparent 到 launchd
      row(202, 40842, piCmd(DIR)),                      // 并存合法实例（如打包版 runtime 40842）的活跃子代——跨实例保护
      row(203, OWN_PID, piCmd(DIR)),                    // 本 runtime 自己的活跃子进程
      row(OWN_PID, 1, piCmd(DIR)),                      // 自身行（防御性排除）
      row(204, 1, piCmd('/Users/tester/.pi/sessions')), // 其他数据目录的 pi（argv 不匹配）
      row(205, 1, 'node app.js'),                       // 无关进程
    ]
    expect(findOrphanPiRows(rows, DIR, OWN_PID).map(r => r.pid)).toEqual([201])
  })

  it('ppid=任意其他活值一律不杀（跨实例保护的直接断言：dev+打包版共存场景）', () => {
    const rows = [
      row(301, 40842, piCmd(DIR)), // 打包版 runtime 的活跃 pi
      row(302, 99999, piCmd(DIR)), // 任意非 1、非 ownPid 的父
    ]
    expect(findOrphanPiRows(rows, DIR, OWN_PID)).toEqual([])
  })
})

describe('reapOrphanPiProcesses（编排）', () => {
  it('目标 = argv 匹配且 ppid=1；并存实例与本 runtime 的子代不触碰；SIGTERM 后已退出则收殓，不打 SIGKILL', async () => {
    const stdout = psStdout([
      row(201, 1, piCmd(DIR)),       // 孤儿（ppid=1）
      row(202, OWN_PID, piCmd(DIR)), // 本 runtime 子进程
      row(205, 40842, piCmd(DIR)),   // 并存合法实例（打包版）的活跃 pi——跨实例保护
      row(204, 1, 'node app.js'),    // 无关进程
    ])
    const signal = vi.fn((pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0) => {
      if (sig === 0 && pid === 201) throw esrch() // 宽限后探活：已退出
    })
    const delay = vi.fn(async () => {})
    const res = await reapOrphanPiProcesses({
      sessionsDir: DIR,
      ownPid: OWN_PID,
      listProcesses: async () => stdout,
      signal,
      delay,
    })
    expect(res.reaped).toEqual([201])
    expect(res.failed).toEqual([])
    expect(res.scanned).toBe(4)
    expect(signal).toHaveBeenCalledWith(201, 'SIGTERM')
    expect(signal).toHaveBeenCalledWith(201, 0)
    expect(signal).not.toHaveBeenCalledWith(201, 'SIGKILL')
    // 非目标 pid（202/205 活实例子代、204 无关进程）全程不被触碰
    const touched = signal.mock.calls.map(c => c[0])
    expect(touched).toEqual([201, 201])
    expect(delay).toHaveBeenCalledWith(ORPHAN_KILL_GRACE_MS)
  })

  it('顽固孤儿：SIGTERM → 宽限探活仍活 → SIGKILL（完整时序）', async () => {
    const signal = vi.fn()
    const delay = vi.fn(async () => {})
    const res = await reapOrphanPiProcesses({
      sessionsDir: DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(301, 1, piCmd(DIR))]),
      signal,
      delay,
    })
    expect(res.reaped).toEqual([301])
    expect(signal.mock.calls.map(c => `${c[0]}:${c[1]}`)).toEqual(['301:SIGTERM', '301:0', '301:SIGKILL'])
    expect(delay).toHaveBeenCalledTimes(1)
    expect(delay).toHaveBeenCalledWith(ORPHAN_KILL_GRACE_MS)
  })

  it('SIGTERM 即 ESRCH（stdin-EOF 自杀链先到）：按已回收计，不等待宽限', async () => {
    const signal = vi.fn((_pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0) => {
      if (sig === 'SIGTERM') throw esrch()
    })
    const delay = vi.fn(async () => {})
    const res = await reapOrphanPiProcesses({
      sessionsDir: DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(401, 1, piCmd(DIR))]),
      signal,
      delay,
    })
    expect(res.reaped).toEqual([401])
    expect(delay).not.toHaveBeenCalled()
  })

  it('SIGKILL 也 ESRCH（宽限期内自行退出）：按已回收计不记失败', async () => {
    const signal = vi.fn((pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0) => {
      if (sig === 'SIGKILL' && pid === 501) throw esrch()
    })
    const res = await reapOrphanPiProcesses({
      sessionsDir: DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(501, 1, piCmd(DIR))]),
      signal,
      delay: async () => {},
    })
    expect(res.reaped).toEqual([501])
    expect(res.failed).toEqual([])
  })

  it('真信号错误（非 ESRCH）：记入 failed 不抛', async () => {
    const signal = vi.fn((_pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0) => {
      if (sig === 'SIGTERM') {
        const e = new Error('not permitted') as NodeJS.ErrnoException
        e.code = 'EPERM'
        throw e
      }
    })
    const res = await reapOrphanPiProcesses({
      sessionsDir: DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(601, 1, piCmd(DIR))]),
      signal,
      delay: async () => {},
    })
    expect(res.reaped).toEqual([])
    expect(res.failed).toEqual([601])
  })

  it('枚举失败（ps 不可用）：降级 unsupported，不抛、不处置', async () => {
    const signal = vi.fn()
    const res = await reapOrphanPiProcesses({
      sessionsDir: DIR,
      ownPid: OWN_PID,
      listProcesses: async () => { throw new Error('spawn ps ENOENT') },
      signal,
    })
    expect(res.unsupported).toBe(true)
    expect(res.reaped).toEqual([])
    expect(signal).not.toHaveBeenCalled()
  })

  it('Windows：单条 warn 降级（已知边界），不枚举不处置', async () => {
    const listProcesses = vi.fn(async () => '')
    const signal = vi.fn()
    // 本仓 vitest 版本无 vi.replaceProperty，用 defineProperty 原地替换并恢复。
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const res = await reapOrphanPiProcesses({
        sessionsDir: DIR,
        ownPid: OWN_PID,
        listProcesses,
        signal,
      })
      expect(res.unsupported).toBe(true)
      expect(listProcesses).not.toHaveBeenCalled()
      expect(signal).not.toHaveBeenCalled()
    } finally {
      if (orig) Object.defineProperty(process, 'platform', orig)
    }
  })

  it('无孤儿时静默返回（零匹配不产生任何信号）', async () => {
    const signal = vi.fn()
    const res = await reapOrphanPiProcesses({
      sessionsDir: DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(701, 1, 'node app.js')]),
      signal,
    })
    expect(res).toEqual({ scanned: 1, reaped: [], failed: [], unsupported: false })
    expect(signal).not.toHaveBeenCalled()
  })
})
