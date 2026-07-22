/**
 * W1 skillRegistry 单测。
 *
 * U1-U3：原始能力（全局扫描 / 项目懒加载缓存 / onChange 通知）。
 * U4-U5：EMFILE 事故修复（2026-07-22）回归防护——
 *   U4 验证 watcher 范围收窄（只 watch skill 子目录，不 watch 整个 cwd），
 *   U5 验证连续同类错误熔断（防 chokidar EMFILE 死循环刷屏）。
 *
 * vi.mock('chokidar')：U1-U3 因 mock 的 configStore 路径不存在 → dirs 为空 → 不调 watch，不受影响；
 * U4/U5 依赖 mock 捕获 watch 参数 + 控制 watcher error 事件（ESM 下 spyOn 模块 namespace 不可用）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

vi.mock('chokidar', () => ({
  // 默认实现：返回带 close 的 EventEmitter；U5 用 mockReturnValueOnce 覆盖为测试持有的实例
  watch: vi.fn(() => {
    const ee = new EventEmitter()
    ;(ee as unknown as { close: () => Promise<void> }).close = () => Promise.resolve()
    return ee
  }),
}))

describe('skillRegistry (W1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('U1: getGlobalSkills 返回启动扫描的 skill', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi' } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
    })
    await reg.initGlobal()
    const skills = reg.getGlobalSkills()
    expect(Array.isArray(skills)).toBe(true)
    // 全局 skill 取决于环境是否有 ~/.agents/skills 目录，不断言非空
  })

  it('U2: projectCache 懒加载 + cwd 隔离（同 cwd 二次命中缓存）', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const scanSpy = vi.fn().mockResolvedValue([])
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi' } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: scanSpy,
    } as never)
    await reg.getProjectSkills('/proj-a')
    await reg.getProjectSkills('/proj-a') // 命中缓存
    await reg.getProjectSkills('/proj-b')
    expect(scanSpy).toHaveBeenCalledTimes(2) // proj-a 一次，proj-b 一次（proj-a 二次命中缓存）
  })

  it('U3: onChange 回调注册 + 触发通知 affectedSessions', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi' } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => ['sid-a', 'sid-b'] } as never,
    } as never)
    const onChangeSpy = vi.fn()
    reg.onChange(onChangeSpy)
    // 模拟全局目录变动
    await reg._notifyGlobalChange()
    expect(onChangeSpy).toHaveBeenCalledWith(['sid-a', 'sid-b'])
  })

  it('U4: getProjectSkills 只 watch 项目 skill 子目录，不递归 watch 整个 cwd（EMFILE 根因防护）', async () => {
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    // 创建临时 cwd：含 .xyz-agent/skills（应被 watch）和 node_modules（绝不该被 watch，fd 爆炸源）
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reg-u4-'))
    mkdirSync(join(cwd, '.xyz-agent', 'skills'), { recursive: true })
    mkdirSync(join(cwd, 'node_modules', 'some-pkg'), { recursive: true })
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi' } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)
    try {
      await reg.getProjectSkills(cwd)
      expect(chokidar.watch).toHaveBeenCalledTimes(1)
      const watchedPaths = vi.mocked(chokidar.watch).mock.calls[0][0] as string[]
      // 核心断言：watch 的是 skill 子目录，不是整个 cwd（原 bug）
      expect(watchedPaths).toContain(join(cwd, '.xyz-agent', 'skills'))
      expect(watchedPaths).not.toContain(cwd)
    } finally {
      reg.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('U5: watcher 连续同类错误达 MAX_WATCHER_ERRORS 后熔断 close（防 EMFILE 死循环刷屏）', async () => {
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reg-u5-'))
    mkdirSync(join(cwd, '.xyz-agent', 'skills'), { recursive: true })
    // 持有 fakeWatcher 引用以便手动 emit error
    const fakeWatcher = new EventEmitter()
    const closeSpy = vi.fn().mockResolvedValue(undefined)
    ;(fakeWatcher as unknown as { close: ReturnType<typeof vi.fn> }).close = closeSpy
    vi.mocked(chokidar.watch).mockReturnValueOnce(fakeWatcher as never)
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi' } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)
    const emfile = () => Object.assign(new Error('too many open files'), { code: 'EMFILE' })
    try {
      await reg.getProjectSkills(cwd)
      // 连续 4 次同类错误：未达阈值（MAX_WATCHER_ERRORS=5），不熔断
      for (let i = 0; i < 4; i++) fakeWatcher.emit('error', emfile())
      expect(closeSpy).not.toHaveBeenCalled()
      // 第 5 次达阈值 → 熔断 close
      fakeWatcher.emit('error', emfile())
      expect(closeSpy).toHaveBeenCalledTimes(1)
    } finally {
      reg.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
