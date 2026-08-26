/**
 * [U7] SessionService 子代理引擎配置读写测试（getSubagentEngineConfig /
 * setSubagentDefaultEngine）——Settings 引擎选择器的 runtime 数据面。
 *
 * 覆盖：engines.json 动态清单读取与缺失/损坏兜底 ['pi']；config.json defaultEngine
 * 读取与缺省；set 的引擎校验（未知引擎 throw）、读改写保留其他字段、幂等零写。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-service-engine-config.test.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import lockfile from 'proper-lockfile'
import { SessionService } from '../services/session/session-service.js'
import { MessageBus } from '../services/message-bus/message-bus.js'
import type { IMessageBroker } from '../interfaces.js'

const PREV_DATA_DIR = process.env['XYZ_AGENT_DATA_DIR']
let tmpDataRoot: string

function makeService(extOverride?: { getExtensionPaths: () => Promise<string[]> }): SessionService {
  const broker = { broadcast: vi.fn() } as unknown as IMessageBroker
  const pm = {
    onSessionExit: vi.fn(),
    spawnSession: vi.fn(),
  } as never
  const bus = new MessageBus({} as never)
  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    (extOverride ?? {}) as never, // extensionService：本测试面仅消费 getExtensionPaths（U7b 回退链）
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never,
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never,
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never,
    {} as never,
    bus,
  )
  return svc
}

function writeJson(rel: string, v: unknown): void {
  const p = path.join(tmpDataRoot, 'pi/agent/subagents', rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(v, null, 2))
}

beforeEach(() => {
  tmpDataRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'engine-config-'))
  process.env['XYZ_AGENT_DATA_DIR'] = tmpDataRoot
})

afterEach(() => {
  if (PREV_DATA_DIR === undefined) delete process.env['XYZ_AGENT_DATA_DIR']
  else process.env['XYZ_AGENT_DATA_DIR'] = PREV_DATA_DIR
  fs.rmSync(tmpDataRoot, { recursive: true, force: true })
})

describe('getSubagentEngineConfig', () => {
  it('engines.json + config.json 合成视图', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 6, defaultEngine: 'zcode' })
    const view = await makeService().getSubagentEngineConfig()
    expect(view).toEqual({ engines: ['pi', 'zcode'], defaultEngine: 'zcode' })
  })

  it('engines.json 缺失/损坏 → 兜底 [pi]；config defaultEngine 缺省 pi', async () => {
    writeJson('config.json', { version: 1, maxConcurrent: 6 })
    expect(await makeService().getSubagentEngineConfig()).toEqual({ engines: ['pi'], defaultEngine: 'pi' })
    writeJson('engines.json', '{ torn')
    expect(await makeService().getSubagentEngineConfig()).toEqual({ engines: ['pi'], defaultEngine: 'pi' })
  })

  it('[U7b] engines.json 缺失 → 回退 subagent-workflow 包静态声明（冷启动无 pi 场景）', async () => {
    // 伪造 subagent-workflow 安装目录（package.json 带 xyz-agent.subagentEngines）
    const swDir = path.join(tmpDataRoot, 'fake-install', 'subagent-workflow')
    fs.mkdirSync(swDir, { recursive: true })
    fs.writeFileSync(
      path.join(swDir, 'package.json'),
      JSON.stringify({ name: '@zhushanwen/pi-subagent-workflow', 'xyz-agent': { subagentEngines: ['pi', 'zcode'] } }),
    )
    const svc = makeService({ getExtensionPaths: async () => [swDir] })
    writeJson('config.json', { version: 1, defaultEngine: 'zcode' })
    expect(await svc.getSubagentEngineConfig()).toEqual({ engines: ['pi', 'zcode'], defaultEngine: 'zcode' })
  })

  it('[U7b] 静态声明也缺失（无 subagent-workflow 目录/无字段/坏 JSON）→ 最终兜底 [pi]', async () => {
    const noSw = makeService({ getExtensionPaths: async () => [] })
    expect(await noSw.getSubagentEngineConfig()).toEqual({ engines: ['pi'], defaultEngine: 'pi' })
    const noFieldDir = path.join(tmpDataRoot, 'no-field', 'subagent-workflow')
    fs.mkdirSync(noFieldDir, { recursive: true })
    fs.writeFileSync(path.join(noFieldDir, 'package.json'), JSON.stringify({ name: 'x' }))
    const noField = makeService({ getExtensionPaths: async () => [noFieldDir] })
    expect(await noField.getSubagentEngineConfig()).toEqual({ engines: ['pi'], defaultEngine: 'pi' })
  })
})

describe('setSubagentDefaultEngine', () => {
  it('合法引擎：读改写 config.json（保留其他字段）+ 原子写', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 3, engineRouting: { strict: true } })
    const svc = makeService()
    await svc.setSubagentDefaultEngine('zcode')
    const conf = JSON.parse(
      fs.readFileSync(path.join(tmpDataRoot, 'pi/agent/subagents/config.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(conf['defaultEngine']).toBe('zcode')
    expect(conf['maxConcurrent']).toBe(3)
    expect(conf['engineRouting']).toEqual({ strict: true })
    // 读回视图一致
    expect(await svc.getSubagentEngineConfig()).toEqual({ engines: ['pi', 'zcode'], defaultEngine: 'zcode' })
  })

  it('未知引擎 → throw（防写坏配置）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi'], updatedAt: 1 })
    await expect(makeService().setSubagentDefaultEngine('ghost')).rejects.toThrow(/unknown subagent engine/)
  })

  it('值未变 → 幂等零写（mtime 不动）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 6, defaultEngine: 'zcode' })
    const p = path.join(tmpDataRoot, 'pi/agent/subagents/config.json')
    const statBefore = fs.statSync(p)
    await makeService().setSubagentDefaultEngine('zcode')
    expect(fs.statSync(p).mtimeMs).toBe(statBefore.mtimeMs)
  })

  it('RMW 持跨进程锁：他方持同锁期间写入 fail-fast（ELOCKED），锁释放后重试成功且其他字段不被覆盖回滚', async () => {
    // review round1 MUST_FIX：config.json 是多写方共享文件（runtime RMW / agent bash /
    // 用户手编），RMW 必须持 withFileLockSync（lockfile = <config.json>.lock）。
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 5, engineRouting: { strict: true } })
    const configPath = path.join(tmpDataRoot, 'pi/agent/subagents/config.json')
    // 他方（遵守锁协议的另一写方）持同一把锁
    const release = lockfile.lockSync(configPath, { realpath: false })
    const p = makeService().setSubagentDefaultEngine('zcode')
    await expect(p).rejects.toThrow(/ELOCKED/)
    // 锁竞争失败零写入（不是降级无锁写）：defaultEngine 未落盘，其他字段原样
    const confDuring = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(confDuring['defaultEngine']).toBeUndefined()
    expect(confDuring['maxConcurrent']).toBe(5)
    release()
    // 锁释放后重试成功：defaultEngine 写入，engineRouting / maxConcurrent 不被 RMW 覆盖回滚
    await makeService().setSubagentDefaultEngine('zcode')
    const confAfter = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(confAfter['defaultEngine']).toBe('zcode')
    expect(confAfter['maxConcurrent']).toBe(5)
    expect(confAfter['engineRouting']).toEqual({ strict: true })
  })
})
