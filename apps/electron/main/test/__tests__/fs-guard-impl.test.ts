/**
 * fs-guard-impl isWriteOpenArg 写句柄 flags 判定单测（review S-10：main 侧副本零单测补齐）。
 *
 * isWriteOpenArg 是模块私有函数，行为经导出的 wrapOpenFns 间接投影：wrap 后的入口函数
 * 收到写 flags 时先 guardPaths 校验 path（非白名单 → 抛 [vitest-fs-guard] BLOCKED），
 * 读 flags 直接透传原函数。以「白名单外探针路径」做判定位：抛 = 判定为写、透传 = 判定
 * 为读。探针路径是不存在的家目录下路径——guardPaths 是纯字符串前缀判定，不触碰 fs，
 * 真实数据目录零接触（仓规测试红线）。
 *
 * 判定语义（源码 fs-guard-impl.ts isWriteOpenArg）：
 * - string flags：含 a/w/x/+ 任一为写（正则 /[awx+]/）——'r'/'rs'/'sr' 只读
 * - number flags：O_ACCMODE 位（& 0o3）非零为写，O_CREAT 等附加位不构成写判定
 * - object options：取 .flags 同判定；flags 非 string/number 时落缺省
 * - 第二参缺省：open 系 'r'（放行）、createWriteStream 'w'（默认即写，必拦）
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { wrapOpenFns } from '../fs-guard-impl.js'

/** 白名单外探针路径（不存在；guardPaths 纯字符串判定，测试全程零 fs 写删）。 */
const PROBE = join(homedir(), '__fs_guard_probe_nonexistent__', 'f.txt')

type OpenEntryName = 'openSync' | 'open' | 'createWriteStream'

/** 构造 wrap 后的入口：orig 是 spy——透传时被调；拦截时 guard 先抛、orig 不触达。 */
function makeEntry(name: OpenEntryName) {
  const orig = vi.fn(() => 'fd')
  const wrapped = wrapOpenFns({}, { [name]: orig }, [name])
  const call = (...args: unknown[]): unknown => (wrapped[name] as (...a: unknown[]) => unknown)(...args)
  return {
    /** 期望判定为写：调用抛 BLOCKED 且 orig 未触达（拦截发生在原函数之前）。 */
    expectBlocked: (...args: unknown[]) => {
      expect(() => call(...args)).toThrow(/\[vitest-fs-guard\] BLOCKED/)
      expect(orig).not.toHaveBeenCalled()
    },
    /** 期望判定为读：不抛且 orig 透传被调。 */
    expectPassed: (...args: unknown[]) => {
      expect(() => call(...args)).not.toThrow()
      expect(orig).toHaveBeenCalledTimes(1)
      orig.mockClear()
    },
  }
}

describe('isWriteOpenArg string flags（经 wrapOpenFns 行为投影）', () => {
  it("'w' → 拦；'r+' → 拦（含 + 即写）", () => {
    const { expectBlocked } = makeEntry('openSync')
    expectBlocked(PROBE, 'w')
    expectBlocked(PROBE, 'r+')
  })

  it("'r' / 'rs' → 放行（'rs' 是 Node 只读 flags，不因多字母误判写）；对照 'rs+' → 拦", () => {
    const { expectPassed, expectBlocked } = makeEntry('openSync')
    expectPassed(PROBE, 'r')
    expectPassed(PROBE, 'rs')
    expectBlocked(PROBE, 'rs+')
  })

  it('number flags：O_WRONLY(1) / O_RDWR(2) → 拦；O_RDONLY(0) / 仅 O_CREAT(0o100) → 放行（O_ACCMODE 位判定）', () => {
    const { expectPassed, expectBlocked } = makeEntry('openSync')
    expectBlocked(PROBE, 1)
    expectBlocked(PROBE, 2)
    expectPassed(PROBE, 0)
    expectPassed(PROBE, 0o100)
  })
})

describe('isWriteOpenArg object 形态与缺省 flags', () => {
  it("{flags:'w'} → 拦；{flags:'r'} → 放行；{flags:2}（number 形态）→ 拦", () => {
    const { expectPassed, expectBlocked } = makeEntry('openSync')
    expectBlocked(PROBE, { flags: 'w' })
    expectPassed(PROBE, { flags: 'r' })
    expectBlocked(PROBE, { flags: 2 })
  })

  it("object 缺 flags / flags 非法类型 → 落缺省 flags（openSync 缺省 'r' 放行，脏 options 不崩溃）", () => {
    const { expectPassed } = makeEntry('openSync')
    expectPassed(PROBE, {})
    expectPassed(PROBE, { flags: true as unknown as string })
    expectPassed(PROBE)
  })

  it("createWriteStream 缺省 flags 'w' → 无第二参 / options 不带 flags 均必拦（写流入口默认写判定）", () => {
    const { expectBlocked } = makeEntry('createWriteStream')
    expectBlocked(PROBE)
    expectBlocked(PROBE, { encoding: 'utf8' })
  })

  it("callback open：缺省 / 'r' 放行、'a' 拦截（三入口逐个覆盖同名判定）", () => {
    const { expectPassed, expectBlocked } = makeEntry('open')
    expectPassed(PROBE)
    expectPassed(PROBE, 'r')
    expectBlocked(PROBE, 'a')
  })
})
