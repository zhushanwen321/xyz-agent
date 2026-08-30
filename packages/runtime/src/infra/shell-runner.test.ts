/**
 * ShellRunner env 出站接线单测（U4-B8，docs/design/env-propagation-boundary.md）。
 *
 * 覆盖：execute 传给 spawn 的 env 必须是 buildOutboundChildEnv 输出——
 * 污染父 env（deny 两键）不出站、白名单基座键（PATH/HOME/XYZ_ 前缀）放行（R2：
 * PATH/HOME 不许静默丢失）。spawn 经构造函数注入 mock，env 断言直取捕获的 options。
 * process.env 一律经 vi.stubEnv 注入/还原（红线 R3：测试禁直接读写真实 env）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/shell-runner.test.ts
 */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShellRunner } from './shell-runner.js'
import type { SpawnFn } from '../services/ports/shell-runner.js'

/** 构造注入用假 spawn：同步 emit close(0)，并暴露捕获到的 spawn options。 */
function createFakeSpawn() {
  let capturedOptions: Record<string, unknown> | undefined
  const spawnFn = vi.fn((_cmd: string, _args: string[], opts: Record<string, unknown>) => {
    capturedOptions = opts
    const child = new EventEmitter() as unknown as {
      stdout: EventEmitter
      stderr: EventEmitter
      on: EventEmitter['on']
      once: EventEmitter['once']
      emit: EventEmitter['emit']
      kill: (signal?: string) => void
      killed: boolean
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => { child.killed = true }
    queueMicrotask(() => child.emit('close', 0))
    return child
  })
  return { spawnFn: spawnFn as unknown as SpawnFn, getOptions: () => capturedOptions }
}

describe('ShellRunner env 出站接线（U4-B8）', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('污染 deny 键不入站产出；白名单基座（PATH/HOME/XYZ_）放行', async () => {
    // 污染：deny 清单两键 + 合法白名单键
    vi.stubEnv('XYZ_AGENT_PACKAGED', '1')
    vi.stubEnv('XYZ_RUNTIME_TOKEN', 'secret-token')
    vi.stubEnv('PATH', '/usr/bin:/bin')
    vi.stubEnv('HOME', '/Users/tester')
    vi.stubEnv('XYZ_AGENT_DEBUG', '1')

    const { spawnFn, getOptions } = createFakeSpawn()
    const runner = new ShellRunner({ spawn: spawnFn })
    const result = await runner.execute({ scriptPath: '/tmp/setup.sh', cwd: '/tmp' })

    expect(result.exitCode).toBe(0)
    const env = getOptions()?.env as Record<string, string>
    expect(env).toBeTruthy()
    expect(env.XYZ_AGENT_PACKAGED).toBeUndefined()
    expect(env.XYZ_RUNTIME_TOKEN).toBeUndefined()
    // R2：白名单基座保 PATH/HOME，hooks 里不因 env 缺失而 git: command not found
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe('/Users/tester')
    expect(env.XYZ_AGENT_DEBUG).toBe('1')
  })

  it('env 为显式构建值而非隐式继承：非白名单键被基座过滤掉', async () => {
    // 隐式继承语义下该键会原样跟随子进程；显式白名单基座下必须消失
    vi.stubEnv('SOME_RANDOM_SESSION_VAR', 'leak-probe')

    const { spawnFn, getOptions } = createFakeSpawn()
    const runner = new ShellRunner({ spawn: spawnFn })
    await runner.execute({ scriptPath: '/tmp/setup.sh', cwd: '/tmp' })

    const env = getOptions()?.env as Record<string, string>
    expect(env.SOME_RANDOM_SESSION_VAR).toBeUndefined()
  })
})
