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

// 捕获 ConfigService 构造时传入的 root（S5 验证全局扫描不传 process.cwd()）。
// vi.hoisted 保证 hoisted 的 mock factory 能引用到此数组。
const { configRoots } = vi.hoisted(() => ({ configRoots: [] as string[] }))

// mock config-service：defaultScanFn 经此 mock 返回空数组（U1 不依赖真实磁盘扫描），
// 同时捕获构造 root 供 S5 断言「全局扫描 root !== process.cwd()」。
// 用 class 而非 vi.fn：ConfigService 以 `new` 调用，箭头函数不能作构造函数。
vi.mock('../src/services/config-service.js', () => ({
  ConfigService: class {
    constructor(root: string) {
      configRoots.push(root)
    }
    loadSkills() {
      return []
    }
  },
}))

describe('skillRegistry (W1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configRoots.length = 0
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
    // config-service 已 mock（返回 []），此处只验证 initGlobal 不抛错 + 返回数组
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
      const watchArgs = vi.mocked(chokidar.watch).mock.calls[0]
      const watchedPaths = watchArgs[0] as string[]
      // 核心断言：watch 的是 skill 子目录，不是整个 cwd（原 bug）
      expect(watchedPaths).toContain(join(cwd, '.xyz-agent', 'skills'))
      expect(watchedPaths).not.toContain(cwd)
      // options 断言：ignored 正则 + ignoreInitial:true（防几余重扫 + node_modules 排除被删）
      expect(watchArgs[1]).toMatchObject({
        ignored: expect.any(RegExp),
        ignoreInitial: true,
      })
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

  it('U6: getProjectSkills 并发同 cwd 去重——只 scan 一次 + 只 watch 一次（防 TOCTOU watcher 泄漏）', async () => {
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reg-u6-'))
    mkdirSync(join(cwd, '.xyz-agent', 'skills'), { recursive: true })
    // scanFn 加人为延迟，让多个 getProjectSkills 调用同时处于 in-flight 窗口
    let resolveScan!: (v: []) => void
    const scanSpy = vi.fn(
      () => new Promise<[]>(resolve => { resolveScan = resolve as (v: []) => void }),
    )
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi' } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: scanSpy,
    } as never)
    try {
      // 三个并发调用，全部在 scanFn resolve 前发出
      const p1 = reg.getProjectSkills(cwd)
      const p2 = reg.getProjectSkills(cwd)
      const p3 = reg.getProjectSkills(cwd)
      resolveScan([])
      await Promise.all([p1, p2, p3])
      // in-flight 去重：三个调用共享同一次 scan + 同一次 watch
      expect(scanSpy).toHaveBeenCalledTimes(1)
      expect(chokidar.watch).toHaveBeenCalledTimes(1)
    } finally {
      reg.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('W3: 缓存命中时补查新建的 skill 目录——补挂 watcher + 重扫缓存', async () => {
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reg-w3-'))
    // scanFn 返回空——本用例只验证「补挂 watcher + 重扫触发」，不关心扫到的 skill 内容
    const scanSpy = vi.fn().mockResolvedValue([])
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi' } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: scanSpy,
    } as never)
    try {
      // 首次扫描：无 skill 目录 → dirs 为空 → 不挂 watcher，缓存空数组
      await reg.getProjectSkills(cwd)
      expect(chokidar.watch).not.toHaveBeenCalled()
      expect(scanSpy).toHaveBeenCalledTimes(1)
      // 用户后续创建 skill 目录（首次扫描时不存在，现在出现）
      mkdirSync(join(cwd, '.xyz-agent', 'skills'), { recursive: true })
      // 再次调用：命中缓存，但检测到「应 watch 但无 watcher」→ 异步补挂 watcher + 重扫
      // setupProjectWatcher 同步注册 watcher 后 scanFn 被同步调用（await 前），放此处的断言可立即生效
      await reg.getProjectSkills(cwd)
      expect(chokidar.watch).toHaveBeenCalledTimes(1)
      expect(scanSpy).toHaveBeenCalledTimes(2)
    } finally {
      reg.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('W4: watcher 熔断后推终态通知（上游感知 skill 列表已停更）', async () => {
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reg-w4-'))
    mkdirSync(join(cwd, '.xyz-agent', 'skills'), { recursive: true })
    const fakeWatcher = new EventEmitter()
    ;(fakeWatcher as unknown as { close: () => Promise<void> }).close = () => Promise.resolve()
    vi.mocked(chokidar.watch).mockReturnValueOnce(fakeWatcher as never)
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi' } as never,
      configDir: '/cfg',
      sessionService: {
        getActiveSessionIds: () => ['sid-x'],
        getSessionCwd: (sid: string) => (sid === 'sid-x' ? cwd : undefined),
      } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)
    const onChangeSpy = vi.fn()
    reg.onChange(onChangeSpy)
    const emfile = () => Object.assign(new Error('too many open files'), { code: 'EMFILE' })
    try {
      await reg.getProjectSkills(cwd)
      // 5 次同类错误 → 熔断 → notifyProjectChange(cwd) → affected = cwd 匹配的 ['sid-x']
      for (let i = 0; i < 5; i++) fakeWatcher.emit('error', emfile())
      expect(onChangeSpy).toHaveBeenCalledWith(['sid-x'])
    } finally {
      reg.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('S5: 全局扫描（projectRoot 空串）不传 process.cwd()，避免项目 skill 混入 globalCache', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi' } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
    })
    await reg.initGlobal()
    // defaultScanFn 经 mock ConfigService 捕获构造 root
    expect(configRoots).toHaveLength(1)
    // 核心断言：全局扫描的 root 绝不能是 process.cwd()（否则 cwd 下项目 skill 混入 globalCache，
    // 且这些条目不被全局 watcher 监听 → 缓存与磁盘发散）
    expect(configRoots[0]).not.toBe(process.cwd())
    // S5 用 os.tmpdir() 下不存在的子路径作为 root
    expect(configRoots[0]).toContain(tmpdir())
  })
})
