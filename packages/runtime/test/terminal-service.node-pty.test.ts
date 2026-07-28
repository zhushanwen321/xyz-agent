/**
 * terminal-service node-pty 缺失优雅降级测试（TC4，wave5 P0 T4）。
 *
 * 场景：@xyz-agent/runtime npm 全局安装在缺 build-essential 的宿主机上，node-pty
 * （native 模块）加载失败。终端功能应优雅降级，而非崩溃整个 runtime：
 *   1. 模块本身能 import（不抛）——pty=null 哨兵已建立；
 *   2. terminal.spawn 抛 terminal_unavailable（而非真实 spawn 或崩溃）；
 *   3. terminal.write/resize/kill/destroyPty 在 spawn 已尝试且失败后抛 terminal_unavailable
 *      （未触发 spawn 时保持 no-op 契约）。
 *
 * mock 策略：vi.doMock('node-pty', () => { throw }) 模拟 MODULE_NOT_FOUND。
 * 关键：terminal-service 用动态 import('node-pty')（非 require），vi.doMock 能拦截。
 * vi.resetModules() 保证每个 it 重新加载 terminal-service（pty/ptyLoadAttempted 模块级
 * 状态重置），独立验证。
 *
 * 运行：cd packages/runtime && npx vitest run test/terminal-service.node-pty.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'

describe('terminal-service node-pty 缺失降级', () => {
  beforeEach(() => {
    // 重置模块注册表：terminal-service 的模块级 pty/ptyLoadAttempted 状态随之重置，
    // 每个 it 独立加载 fresh module。
    vi.resetModules()
    // doMock（非 hoisted 的 mock）：动态 import('node-pty') 时工厂抛错，模拟
    // 「native 模块缺失」运行时场景。vi.mock 是 hoisted 也会被此 doMock 覆盖。
    vi.doMock('node-pty', () => {
      throw new Error("Cannot find module 'node-pty'")
    })
  })

  it('node-pty 缺失时模块加载成功（pty=null 哨兵建立，不崩溃）', async () => {
    // 动态 import 触发模块评估；terminal-service 不在顶层 import node-pty，
    // 故模块加载本身不抛（pty=null 在首次 spawn 才确定）。
    const mod = await import('../src/services/terminal/terminal-service')
    expect(mod).toBeDefined()
    expect(mod.TerminalService).toBeTypeOf('function')
  })

  it('terminal.spawn 在 node-pty 缺失时抛 terminal_unavailable', async () => {
    const { TerminalService } = await import('../src/services/terminal/terminal-service')
    const messages: ServerMessage[] = []
    const svc = new TerminalService({ broadcast: (m) => messages.push(m) })

    // spawn 触发 loadPty() → 动态 import('node-pty') 被 doMock 拦截抛错 → pty=null
    // → 守卫抛 terminal_unavailable。
    await expect(svc.spawn('s1', undefined, 80, 24)).rejects.toMatchObject({
      code: 'terminal_unavailable',
      message: expect.stringContaining('node-pty not installed'),
    })
    // 无 PTY spawn，无任何广播（terminal.alive/data/exit 都不发）
    expect(messages).toHaveLength(0)
  })

  it('spawn 失败后 write/resize/kill 抛 terminal_unavailable（ptyLoadAttempted && !pty）', async () => {
    const { TerminalService } = await import('../src/services/terminal/terminal-service')
    const svc = new TerminalService({ broadcast: () => {} })

    // 先触发一次 spawn 让 loadPty() 执行并确定 pty=null（ptyLoadAttempted=true）
    await expect(svc.spawn('s1', undefined, 80, 24)).rejects.toMatchObject({
      code: 'terminal_unavailable',
    })

    // 此时同步方法守卫命中（ptyLoadAttempted && !pty），抛 terminal_unavailable
    // 注意：destroyPty 例外（C1 fix）——它是 session 生命周期回调，路径无 try/catch，
    // 单独在下一个 it 验证其 no-op 契约。
    expect(() => svc.write('s1', 'x')).toThrow(
      expect.objectContaining({ code: 'terminal_unavailable' }),
    )
    expect(() => svc.resize('s1', 80, 24, 'local', 'local')).toThrow(
      expect.objectContaining({ code: 'terminal_unavailable' }),
    )
    expect(() => svc.kill('s1')).toThrow(
      expect.objectContaining({ code: 'terminal_unavailable' }),
    )
  })

  it('destroyPty 在 node-pty 缺失时不抛错（session 生命周期回调安全）', async () => {
    // C1 回归：destroyPty 被 sessionService.setOnSessionDelete 回调调用（index.ts:343-346），
    // 调用路径 removeSessionEntry → onSessionDelete → terminalService.destroyPty 无 try/catch。
    // 若 destroyPty 在 node-pty 缺失时抛 terminal_unavailable，会中断 session 删除/进程退出清理：
    //   - session 文件终态（stopped）缺失
    //   - 前端收不到 session.exited 广播
    // 故即便 spawn 已尝试加载且失败（ptyLoadAttempted=true, pty=null），destroyPty 仍必须 no-op。
    const { TerminalService } = await import('../src/services/terminal/terminal-service')
    const svc = new TerminalService({ broadcast: () => {} })

    // 先触发 spawn 让 loadPty() 执行并确定 pty=null（ptyLoadAttempted=true）
    await expect(svc.spawn('s1', undefined, 80, 24)).rejects.toMatchObject({
      code: 'terminal_unavailable',
    })

    // 此后 session 销毁回调触发 destroyPty——必须 not.throw，保持与 ports 契约「sid 无 PTY 时 no-op」一致。
    expect(() => svc.destroyPty('s1')).not.toThrow()
  })

  it('未触发 spawn 前 write/resize/kill/destroyPty 保持 no-op 契约（不抛错）', async () => {
    // 回归守卫：ptyLoadAttempted 默认 false（loadPty 未调用），同步方法不应抛
    // terminal_unavailable——保持原「不存在的 sid 是 no-op」契约，避免误伤竞态场景
    // （如 client 在 spawn 响应前发 write）。
    const { TerminalService } = await import('../src/services/terminal/terminal-service')
    const svc = new TerminalService({ broadcast: () => {} })

    expect(() => svc.write('s1', 'x')).not.toThrow()
    expect(() => svc.resize('s1', 80, 24, 'local', 'local')).not.toThrow()
    expect(() => svc.kill('s1')).not.toThrow()
    expect(() => svc.destroyPty('s1')).not.toThrow()
  })
})
