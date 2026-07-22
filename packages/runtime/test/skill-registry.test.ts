/**
 * W1 skillRegistry 单测（红灯阶段）。
 * 断言未实现的 skillRegistry（packages/runtime/src/services/skill-registry.ts 不存在）→ import 失败 → fail（TDD 红灯）。
 * 实现后转绿。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('skillRegistry (W1)', () => {
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
})
