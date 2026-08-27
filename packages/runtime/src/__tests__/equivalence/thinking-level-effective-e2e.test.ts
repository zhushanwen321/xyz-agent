/**
 * G5 real-pi 用例：思考等级生效回执端到端保险丝（pi-boundary-reliability D7-G5 / U7a）。
 *
 * 验收断言（设计 §3.3 D7 表 G5）：
 * - 真实 pi 下 reasoning:false 模型 set 'high' → runtime 回执 = get_state 实值 = 'off'；
 * - 正常（reasoning:true 且支持 high）模型 → 回执 = 请求值。
 * 这是「config ≡ pi effective」的端到端保险丝：runtime 侧回执链（settings-message-handler
 * 的 session.thinkingLevelSet reply 消费 session-service.setThinkingLevel 的返回值——
 * set 后 get_state 读 effective，非请求值）必须在真实 pi 两级门控/钳制下仍成立。
 * renderer protocol 修型（reply void → {sessionId, level}）是并行单元 U6 的领地，本测试
 * 断言 runtime 层（SessionService 生产代码）的返回值语义，不依赖 U6。
 *
 * 与探针族（src/infra/pi/__tests__/pi-semantics-*.test.ts）的分工：探针静态断言 pi dist
 * 代码形态/同源函数行为（凭证无关）；本文件起真实 pi 子进程验证 runtime 生产链路在真实
 * 钳制下的回执真值（PS-02/PS-12 的运行时实证）。
 *
 * 环境隔离：pi 的 setThinkingLevel 在档位实际变化时会写全局 settings（setDefaultThinkingLevel，
 * pi-agent-core settings-manager save）——spawn 前把 PI_CODING_AGENT_DIR 指向临时目录并
 * 拷入 auth.json/models.json/settings.json（凭证与模型解析所需），pi 的全部写入都落在临时
 * 目录，测试结束删除；不污染 ~/.pi/agent。全程无 LLM turn（set/get 皆为本地 RPC），
 * 但按 REAL_PI_TESTS 池约定仍以 REAL_PI_READY 门控（开发机跑，CI skip）。
 *
 * 本文件已登记 vitest.config.ts REAL_PI_TESTS 分池（真 pi 用例满并行下会饿死，见该文件头
 * 维护契约）。运行：cd packages/runtime && npx vitest run src/__tests__/equivalence/thinking-level-effective-e2e.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from '../../services/session/session-service.js'
import type { IPiEngine, IProcessManager } from '../../services/ports/pi-engine.js'
import type { IMessageBroker } from '../../interfaces.js'
import { spawnPiFixture, REAL_PI_READY, REAL_PI_SKIP_REASON, type PiFixture } from './pi-fixture.js'

const SID = 'g5-thinking-level'

/** 真实 pi agent 目录（与 pi-fixture.ts piAgentDir 同规则：PI_CODING_AGENT_DIR 覆盖 → ~/.pi/agent）。 */
function realPiAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR
  if (envDir && envDir.trim() !== '') return envDir
  return join(homedir(), '.pi', 'agent')
}

/** get_available_models 返回项的消费面（pi-ai Model 的宽形态，只声明用到的字段）。 */
interface AvailableModel {
  id: string
  provider: string
  reasoning?: boolean
}

/** 尽力删除（清理路径专用）：macOS 下 pi 进程残余写入可致 ENOTEMPTY 竞态，失败不应掩蔽/阻断主流程（tmp 目录由 OS 周期清理）。 */
function rmBestEffort(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 尽力而为：遗留 tmp 目录不影响断言与后续用例
  }
}

/** spawn 隔离 agent 目录的真实 pi：凭证/模型/设置文件拷入临时目录，pi 写入全部隔离。 */
async function spawnIsolatedPi(): Promise<{ fx: PiFixture; agentDir: string }> {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-g5-agent-'))
  const srcDir = realPiAgentDir()
  for (const file of ['auth.json', 'models.json', 'settings.json']) {
    const src = join(srcDir, file)
    if (existsSync(src)) copyFileSync(src, join(agentDir, file))
  }
  const saved = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  let fx: PiFixture
  try {
    // 冷启动余量 15s：全新 agent 目录首启（无 models-store 缓存/extension 扫描）+ 满套件
    // 负载下可超默认 5s（实测全量跑中偶发冷启动超时，单跑 ~1s）
    fx = await spawnPiFixture({ coldStartTimeoutMs: 15_000 })
  } catch (e) {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = saved
    rmBestEffort(agentDir)
    throw e
  }
  if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = saved
  return { fx, agentDir }
}

/** 把 fixture 的原始 JSONL RPC 适配成 SessionService 消费的 IPiEngine 语义面（唯一适配点）。 */
function makeEngine(fx: PiFixture): IPiEngine {
  return {
    getCommands: async () => [],
    getState: async () => (await fx.sendCommand('get_state')).data as Record<string, unknown>,
    setThinkingLevel: async (level: string) =>
      await fx.sendCommand('set_thinking_level', { level }),
    setModel: async (provider: string, modelId: string) =>
      await fx.sendCommand('set_model', { provider, modelId }),
  } as unknown as IPiEngine
}

/** 最小 SessionService 装置（参考 scalar-state-invalidation.test.ts 的构造形态；pm/broker 全 stub）。 */
function makeSessionService(engine: IPiEngine): SessionService {
  const broker = { broadcast: vi.fn() } as unknown as IMessageBroker
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => engine),
  } as unknown as IProcessManager
  return new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService
  )
}

describe.skipIf(!REAL_PI_READY)(
  `G5 equivalence: 思考等级生效回执（真实 pi 子进程${REAL_PI_SKIP_REASON ? `｜skip：${REAL_PI_SKIP_REASON}` : ''}）`,
  () => {
    let fixture: PiFixture | null = null
    let agentDir: string | null = null
    let svc: SessionService | null = null

    beforeAll(async () => {
      const spawned = await spawnIsolatedPi()
      fixture = spawned.fx
      agentDir = spawned.agentDir
      const engine = makeEngine(spawned.fx)
      svc = makeSessionService(engine)
      await svc.initializeManagedSession(SID, engine, spawned.fx.sessionDir, 'g5')
    }, 30_000)

    afterAll(async () => {
      try {
        svc?.removeSessionEntry(SID)
      } finally {
        if (fixture) await fixture.dispose()
        if (agentDir) rmBestEffort(agentDir)
      }
    })

    /** 当前 pi 合并清单（get_available_models，PS-10 面）。 */
    async function availableModels(): Promise<AvailableModel[]> {
      const resp = await fixture!.sendCommand('get_available_models')
      return ((resp.data as { models?: AvailableModel[] } | undefined)?.models ?? []) as AvailableModel[]
    }

    /** 切到满足谓词的模型并验证 pi 实际支持档位（get_available_thinking_levels 为准）。 */
    async function switchToModel(predicate: (m: AvailableModel) => boolean, wantLevel: string): Promise<AvailableModel> {
      const models = await availableModels()
      const candidate = models.find(predicate)
      expect(candidate, `get_available_models 中找不到满足条件的模型（清单 ${models.length} 个）`).toBeDefined()
      await fixture!.sendCommand('set_model', { provider: candidate!.provider, modelId: candidate!.id })
      const levels = (await fixture!.sendCommand('get_available_thinking_levels')) as unknown as {
        data?: { levels?: string[] }
      }
      expect(
        levels.data?.levels,
        `切换到 ${candidate!.provider}/${candidate!.id} 后 pi 报告的可用档位异常`,
      ).toContain(wantLevel)
      return candidate!
    }

    it('正常模型（reasoning:true 且支持 high）：runtime 回执 = 请求值 = get_state 实值', { timeout: 60_000 }, async () => {
      await switchToModel((m) => m.reasoning === true, 'high')

      const reply = await svc!.setThinkingLevel(SID, 'high')
      expect(reply, 'runtime 回执应等于请求值（该档位受支持，无钳制）').toBe('high')

      const raw = (await fixture!.sendCommand('get_state')).data as { thinkingLevel?: string }
      expect(raw.thinkingLevel, 'G5 核心等式：回执 = get_state 实值（pi 生效档）').toBe(reply)
    })

    it('reasoning:false 模型 set high：pi 两级门控钳回 off，runtime 回执如实返回 off（非请求值）', { timeout: 60_000 }, async () => {
      await switchToModel((m) => m.reasoning === false, 'off')

      const reply = await svc!.setThinkingLevel(SID, 'high')
      expect(reply, 'runtime 回执必须是 pi 生效值 off（PS-02 两级门控），乐观回显请求值 = 事故 B 形态').toBe('off')

      const raw = (await fixture!.sendCommand('get_state')).data as { thinkingLevel?: string }
      expect(raw.thinkingLevel, 'G5 核心等式：回执 = get_state 实值（钳制后真值）').toBe('off')
    })
  },
)
