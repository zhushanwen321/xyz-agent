/**
 * 双侧锁实现对照测试（integrity-hardening 实施审查 SUGGESTION #6）。
 *
 * runtime 侧 utils/file-lock.ts 与 extension 侧 @zhushanwen/pi-file-lock 的 sync 版
 * 是同一锁协议的两份孪生实现——「同一把锁」的互斥语义依赖两侧默认参数一致
 * （stale 决定夺取窗口、retry 间隔/预算决定等待形态）与 lockfile 路径推导一致
 * （<目标文件>.lock）。两份实现分属不同包，纯靠头注释互指的纪律同步会漂移：
 * ① 常量对照断言两侧导出的默认参数相等；② 行为对照断言两侧对同一目标文件
 * 真互斥（一侧持锁时另一侧按预算 fail-fast，释放后可获取）——后者同时守护
 * lockfile 路径推导不漂移。
 *
 * import 取舍：extension 包不是 runtime 的依赖（不能经包名 import、不引入
 * devDependency 改 lockfile），对照测试以相对路径直连其 workspace 源码；若
 * extension 包移位，本测试的 import 会先于任何参数漂移红掉，额外起到
 * 「孪生实现位置契约」的护栏作用。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_RETRY_BUDGET_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_STALE_MS,
  withFileLockSync,
} from '../src/utils/file-lock.js'
import {
  DEFAULT_RETRY_BUDGET_MS as EXT_RETRY_BUDGET_MS,
  DEFAULT_RETRY_DELAY_MS as EXT_RETRY_DELAY_MS,
  DEFAULT_STALE_MS as EXT_STALE_MS,
  withFileLockSync as extWithFileLockSync,
} from '../../../extensions/shared/file-lock/src/file-lock.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'file-lock-parity-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('file-lock parity（runtime ↔ extension sync 孪生实现）', () => {
  it('两侧默认参数相等（stale / retry 间隔 / 重试预算）', () => {
    expect(EXT_STALE_MS).toBe(DEFAULT_STALE_MS)
    expect(EXT_RETRY_DELAY_MS).toBe(DEFAULT_RETRY_DELAY_MS)
    expect(EXT_RETRY_BUDGET_MS).toBe(DEFAULT_RETRY_BUDGET_MS)
  })

  it('默认值与登记表锁协议一致（stale 30s / 25ms / 1s，data-source-registry §6）', () => {
    expect(DEFAULT_STALE_MS).toBe(30_000)
    expect(DEFAULT_RETRY_DELAY_MS).toBe(25)
    expect(DEFAULT_RETRY_BUDGET_MS).toBe(1_000)
  })

  it('两侧共用同一 lockfile：一侧持锁时另一侧 fail-fast，释放后可获取', () => {
    const target = join(tmpDir, 'parity-target.json')
    const events: string[] = []

    withFileLockSync(target, () => {
      events.push('runtime-critical')
      // runtime 持锁期间，extension 侧取同一把锁：压缩预算快速验证 fail-fast
      //（抛 ELOCKED 而非静默拿到——证明两侧 lockfile 路径推导一致，互斥真实成立）
      expect(() =>
        extWithFileLockSync(target, () => events.push('ext-in-runtime-critical'), {
          retryDelayMs: 5,
          retryBudgetMs: 50,
        }),
      ).toThrow()
      expect(events).toEqual(['runtime-critical'])
    })

    // runtime 释放后 extension 立即可获取（无 stale 夺取冲突）
    extWithFileLockSync(target, () => events.push('ext-after-release'))
    expect(events).toEqual(['runtime-critical', 'ext-after-release'])
  })
})
