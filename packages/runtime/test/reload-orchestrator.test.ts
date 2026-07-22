/**
 * W5 reload-orchestrator 单测（红灯阶段）。
 * 断言未实现的 reload-orchestrator → import 失败 → fail（TDD 红灯）。
 */
import { describe, it, expect, vi } from 'vitest'

describe('reload-orchestrator (W5)', () => {
  it('U10: builtin extension 注册 __xyz_reload__', async () => {
    // 读 xyz-agent-extension.js 源码断言注册
    const fs = await import('node:fs')
    const src = fs.readFileSync(
      `${process.cwd()}/../../xyz-agent-extension.js`,
      'utf-8',
    )
    expect(src).toContain("registerCommand('__xyz_reload__'")
    expect(src).toContain('ctx.reload()')
  })

  it('U11: idle session skill 变更立即 promptReload', async () => {
    const { ReloadOrchestrator } = await import('../src/services/session/reload-orchestrator.js')
    const promptReload = vi.fn().mockResolvedValue(undefined)
    const isIdle = vi.fn().mockResolvedValue(true)
    const orch = new ReloadOrchestrator({
      sessionService: { isSessionIdle: isIdle, promptReload } as never,
    } as never)
    await orch.onSkillChange(['sid-a'])
    expect(promptReload).toHaveBeenCalledWith('sid-a')
  })

  it('U12: running session 排队 + message.complete 触发 reload 清 flag', async () => {
    const { ReloadOrchestrator } = await import('../src/services/session/reload-orchestrator.js')
    const promptReload = vi.fn().mockResolvedValue(undefined)
    const isIdle = vi.fn().mockReturnValue(false)
    const orch = new ReloadOrchestrator({
      sessionService: { isSessionIdle: isIdle, promptReload } as never,
    } as never)
    await orch.onSkillChange(['sid-a'])
    expect(promptReload).not.toHaveBeenCalled() // running 不立即发
    await orch.onMessageComplete('sid-a')
    expect(promptReload).toHaveBeenCalledWith('sid-a') // message.complete 后发
  })

  it('U13: 降级 - reload 失败清 flag 不重试', async () => {
    const { ReloadOrchestrator } = await import('../src/services/session/reload-orchestrator.js')
    const promptReload = vi.fn().mockRejectedValue(new Error('pi reload failed'))
    const isIdle = vi.fn().mockReturnValue(true)
    const orch = new ReloadOrchestrator({
      sessionService: { isSessionIdle: isIdle, promptReload } as never,
    } as never)
    await orch.onSkillChange(['sid-a']) // 抛错
    // 二次变更不应因 flag 残留被忽略（flag 已清）
    await orch.onSkillChange(['sid-a'])
    expect(promptReload).toHaveBeenCalledTimes(2) // 两次都尝试（flag 每次清）
  })
})
