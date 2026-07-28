/**
 * SkillRegistry watcher 真实 fs 集成测试（real chokidar，不 mock）。
 *
 * 验证根因修复（2026-07-27）：watcher 在「已 watch 的 skill 目录下新建子目录」时必须触发 rescan。
 *
 * 背景（预存 bug）：chokidar v4 移除了 native fsevents 绑定，macOS 上退化为纯 Node fs.watch，
 * 对「新建子目录 / 新文件」事件不可靠（nodejs/node#52601 启动竞态 + FSEvents coalescing 丢事件），
 * 实测触发率 ~40%（flaky）。修复在 WATCH_OPTIONS 启用 usePolling:true 切到 stat-polling 后端，
 * 让 watcher 对跨进程磁盘操作可靠触发。
 *
 * 本文件不 mock chokidar（顶层的 vi.mock('chokidar') 仅作用于 skill-registry.test.ts 同文件作用域，
 * 独立 test 文件默认走真实 chokidar），用真实磁盘 + 跨进程 spawn 创建 skill 子目录，验证 onChange 被触发。
 *
 * 运行：cd packages/runtime && npx vitest run test/skill-registry-watcher-real.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { SkillInfo } from '@xyz-agent/shared'

/**
 * watcher 触发检测的挂钟轮询 deadline（reviewer-D WARNING-4 加固）。
 *
 * usePolling interval(1500ms) + debounce(300ms)：原 6000ms 预算只能覆盖 ~4 次轮询周期，
 * CI 慢机器 / 系统抖动时 polling 可能滑到 2s+，4 次预算紧张导致偶发超时 flaky。
 * 提升到 12000ms 给 ~8 次轮询预算，留足缓冲应对 CI 抖动。
 * 配合 it() timeout（30000ms）确保测试本身不会先于 deadline 超时。
 */
const WATCH_DETECT_DEADLINE_MS = 12000

/**
 * chokidar 轮询 baseline 预热时长（ms）。
 *
 * 为什么需要：chokidar usePolling 的 first-tick 会快照当前目录状态作为 baseline，之后每个 interval
 * 与 baseline diff 出增量事件。若新建文件的 spawnSync 在 first-tick **之前**完成，新文件就被
 * baseline 快照「吞掉」，后续轮询看不到 diff → 事件永不触发（ignoreInitial 也会跳过）。
 * 原测试用异步 spawn（fire-and-forget）侥幸绕过：子进程 fork 后真正写盘通常落在 first-tick 之后，
 * 但这是隐式时序依赖（CI 调度抖动即可打破）。spawnSync 改为同步后写盘在 first-tick 前 → 必须显式
 * 等 first-tick 跑完再创建文件。1700ms > WATCH_POLL_INTERVAL_MS(1500ms) 确保至少一次轮询已建好 baseline。
 */
const WATCH_BASELINE_WARMUP_MS = 1700

/**
 * 简易 scanFn：把 skill 容器目录下的子目录当作 skill 返回（每个含 SKILL.md 的子目录一项）。
 * 用于让 onChange 触发后的 globalCache 有可观察内容，不依赖真实 ConfigService 扫描逻辑。
 */
function makeScanFn(skillDir: string) {
  return async (): Promise<SkillInfo[]> => {
    let entries: string[] = []
    try {
      entries = readdirSync(skillDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
    } catch {
      entries = []
    }
    return entries.map(name => ({ id: name, name } as SkillInfo))
  }
}

/**
 * 跨进程创建 skill 子目录（模拟用户从 shell / Finder 创建 skill，不经 settings）。
 * 直接用 Node fs 在同进程创建也可，但跨进程更贴近真实场景且能暴露 fs.watch 的进程外事件丢失问题。
 *
 * 用 spawnSync（非 spawn）：spawn 不等待子进程完成也不跟踪 child 引用，测试失败/超时清理时
 * 子进程可能变僵尸（reviewer-D WARNING-5）。创建目录是同步操作，spawnSync 等待完成更简单可靠。
 */
function createSkillSubdir(parentDir: string, skillName: string): void {
  spawnSync('sh', ['-c', `mkdir -p ${join(parentDir, skillName)} && echo body > ${join(parentDir, skillName, 'SKILL.md')}`], { encoding: 'utf-8' })
}

describe('SkillRegistry watcher real fs (W5: 新建 skill 子目录触发 rescan)', () => {
  let tempRoot: string
  let skillDir: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'skill-reg-w5-real-'))
    skillDir = join(tempRoot, 'skills')
    mkdirSync(skillDir, { recursive: true })
    // 预置一个已存在 skill，让 watch 初始非空
    mkdirSync(join(skillDir, 'existing-skill'), { recursive: true })
    writeFileSync(join(skillDir, 'existing-skill', 'SKILL.md'), '---\nname: existing-skill\n---\nbody\n')
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('W5a: 全局 watcher 在已扫描目录下新建 skill 子目录时触发 onChange（rescan + 通知）', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [skillDir], getPiAgentDir: () => '/pi' } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => ['sid-w5a'] } as never,
      _scanFn: makeScanFn(skillDir),
    } as never)
    try {
      await reg.initGlobal()
      // initGlobal 扫到 1 个 skill（existing-skill）
      expect(reg.getGlobalSkills()).toHaveLength(1)

      // 注册 onChange：捕获 watcher 触发的 rescan 通知
      const events: Array<{ scope: string; affectedSessionIds: string[] }> = []
      reg.onChange(e => events.push({ scope: e.scope, affectedSessionIds: e.affectedSessionIds }))

      // 等 chokidar 轮询建好 baseline（含 existing-skill）。spawnSync 同步写盘，若在 first-tick 前
      // 完成会被 baseline 吞掉（见 WATCH_BASELINE_WARMUP_MS 注释），必须先等 first-tick 跑完。
      await new Promise(r => setTimeout(r, WATCH_BASELINE_WARMUP_MS))

      // 跨进程新建 skill 子目录（不经 settings，模拟用户直接磁盘操作）
      createSkillSubdir(skillDir, 'new-skill-w5a')

      // 等 watcher 触发：usePolling interval(1500ms) + debounce(300ms) + 余量
      // 最长等 WATCH_DETECT_DEADLINE_MS（polling 周期最多触发 8 次，足够稳定，CI 抖动有缓冲）
      const deadline = Date.now() + WATCH_DETECT_DEADLINE_MS
      while (Date.now() < deadline && events.length === 0) {
        await new Promise(r => setTimeout(r, 200))
      }

      // 核心断言：watcher 触发了 rescan → onChange 收到 global scope 通知
      expect(events.length).toBeGreaterThan(0)
      expect(events[0]).toMatchObject({ scope: 'global', affectedSessionIds: ['sid-w5a'] })
      // rescan 后 globalCache 含新 skill
      const skills = reg.getGlobalSkills()
      expect(skills.some(s => s.id === 'new-skill-w5a')).toBe(true)
    } finally {
      reg.dispose()
    }
  }, 30000)

  it('W5b: 项目 watcher 在已扫描目录下新建 skill 子目录时触发 onChange（scope=project）', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reg-w5b-cwd-'))
    const projectSkillDir = join(cwd, '.xyz-agent', 'skills')
    mkdirSync(projectSkillDir, { recursive: true })
    try {
      const reg = new SkillRegistry({
        configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi' } as never,
        configDir: '/cfg',
        sessionService: {
          getActiveSessionIds: () => ['sid-w5b'],
          getSessionCwd: (sid: string) => (sid === 'sid-w5b' ? cwd : undefined),
        } as never,
        _scanFn: makeScanFn(projectSkillDir),
      } as never)
      try {
        await reg.getProjectSkills(cwd)

        const events: Array<{ scope: string; cwd?: string }> = []
        reg.onChange(e => events.push({ scope: e.scope, cwd: e.cwd }))

        // 等 chokidar 轮询建好 baseline（见 WATCH_BASELINE_WARMUP_MS 注释）。
        await new Promise(r => setTimeout(r, WATCH_BASELINE_WARMUP_MS))

        // 跨进程新建项目 skill 子目录
        createSkillSubdir(projectSkillDir, 'new-proj-skill')

        const deadline = Date.now() + WATCH_DETECT_DEADLINE_MS
        while (Date.now() < deadline && events.length === 0) {
          await new Promise(r => setTimeout(r, 200))
        }

        expect(events.length).toBeGreaterThan(0)
        expect(events[0]).toMatchObject({ scope: 'project', cwd })
        const skills = await reg.getProjectSkills(cwd)
        expect(skills.some(s => s.id === 'new-proj-skill')).toBe(true)
      } finally {
        reg.dispose()
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 30000)
})
