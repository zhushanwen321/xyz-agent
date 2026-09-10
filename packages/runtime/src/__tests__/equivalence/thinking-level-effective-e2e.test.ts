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
 * reasoning:false 演员自足化（本文件第二轮，缺陷登记：环境依赖型用例）：钳制用例原先靠
 * `models.find(m => m.reasoning === false)` 从宿主 models.json 撞运气——宿主没有这种模型
 * 时用例必失败。现改为向隔离 agentDir 注入确定性演员（PROBE_PROVIDER_ID / PROBE_MODEL_ID，
 * 见 injectReasoningOffProbe），用例按显式模型名定位并断言，宿主文件内容不再参与该用例。
 *
 * 本文件已登记 vitest.config.ts REAL_PI_TESTS 分池（真 pi 用例满并行下会饿死，见该文件头
 * 维护契约）。运行：cd packages/runtime && npx vitest run src/__tests__/equivalence/thinking-level-effective-e2e.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch {
    // 尽力而为：遗留 tmp 目录不影响断言与后续用例
  }
}

// ==================== 注入演员（钳制用例的自足性来源） ====================

/**
 * 注入演员的 provider / model 显式名字：取宿主不可能存在的唯一值，用例按此名字断言钳制回执。
 * 宿主 models.json 里有没有 reasoning:false 的模型与本用例无关。
 */
const PROBE_PROVIDER_ID = 'e2e-thinking-probe'
const PROBE_MODEL_ID = 'e2e-reasoning-off-probe'

/**
 * 向隔离 agentDir 的 models.json 注入一个确定性 reasoning:false 演员（唯一名字）。
 *
 * 为什么注入整套 provider 而非只加一条 model 定义：pi 的「可用」判定以 provider 为单位——
 * `pi-ai` dist/models.js `Models.getAvailable` 只收 `checkProviderAuth` 通过的 provider 的模型，
 * 而带自定义 model 的 models.json provider 若既无 apiKey 也无 oauth，composeModelProvider
 * 直接抛 `no authentication method configured`。故注入条目自带**字面量** apiKey：字面量不是
 * `${ENV}` 模板（pi-coding-agent dist/core/resolve-config-value.js `parseConfigValueReference`：
 * 仅 `!` 前缀才是 shell 命令形式），因此无环境变量依赖，`composeApiKeyAuth.check` 对字面量
 * 路径直接返回 configured ⇒ 该 provider 无条件计入 get_available_models。
 *
 * why reasoning:false ⇒ 钳回 off（两级门控第二级）：pi-ai dist/models.js
 * `getSupportedThinkingLevels` 对 `!model.reasoning` 恒返回 ['off']，`setThinkingLevel` 的
 * `getAvailableThinkingLevels` 取该函数，「high」不在其中 ⇒ `clampThinkingLevel` 钳回 'off'。
 *
 * api / baseUrl 只为通过 models.json schema 与 modelFromJson 的必填校验（缺 api 或 baseUrl 会抛），
 * 本用例全程无 LLM turn（set/get 皆本地 RPC），baseUrl 不可达不影响断言。
 * 宿主 models.json 不可解析时退回空对象重建：pi 的 ModelConfig.load 在 schema/解析失败时同样
 * 丢弃全部 provider，语义等价，注入演员照常存活。
 */
function injectReasoningOffProbe(agentDir: string): void {
  const modelsPath = join(agentDir, 'models.json')
  let config: Record<string, unknown> = {}
  if (existsSync(modelsPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(modelsPath, 'utf-8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>
      }
    } catch {
      config = {}
    }
  }
  const rawProviders = config['providers']
  const providers: Record<string, unknown> =
    typeof rawProviders === 'object' && rawProviders !== null && !Array.isArray(rawProviders)
      ? (rawProviders as Record<string, unknown>)
      : {}
  providers[PROBE_PROVIDER_ID] = {
    name: 'E2E thinking-level probe',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'e2e-probe-key',
    api: 'openai-completions',
    models: [{ id: PROBE_MODEL_ID, name: 'E2E reasoning-off probe', reasoning: false }],
  }
  config['providers'] = providers
  writeFileSync(modelsPath, JSON.stringify(config, null, 2) + '\n')
}

/** spawn 隔离 agent 目录的真实 pi：凭证/模型/设置文件拷入临时目录，pi 写入全部隔离。
 * 注入演员写在隔离目录的 models.json（宿主文件的副本）里，随后由 spawnPiFixture 原样
 * 拷进它自己的 agentDir —— 注入内容全程只落在 os.tmpdir() 内。 */
async function spawnIsolatedPi(): Promise<{ fx: PiFixture; agentDir: string }> {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-g5-agent-'))
  const srcDir = realPiAgentDir()
  for (const file of ['auth.json', 'models.json', 'settings.json']) {
    const src = join(srcDir, file)
    if (existsSync(src)) copyFileSync(src, join(agentDir, file))
  }
  injectReasoningOffProbe(agentDir)
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

    /** 切到满足谓词的模型并验证 pi 实际支持档位（get_available_thinking_levels 为准）。
     * target 是失败消息里的人类可读目标（注入演员写显式名字），便于一眼看出依赖哪个演员。 */
    async function switchToModel(
      predicate: (m: AvailableModel) => boolean,
      wantLevel: string,
      target: string,
    ): Promise<AvailableModel> {
      const models = await availableModels()
      const candidate = models.find(predicate)
      expect(
        candidate,
        `get_available_models 中找不到 ${target}（清单 ${models.length} 个：${models.map((m) => `${m.provider}/${m.id}`).join(', ')}）`,
      ).toBeDefined()
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
      await switchToModel((m) => m.reasoning === true, 'high', '任一 reasoning:true 模型')

      const reply = await svc!.setThinkingLevel(SID, 'high')
      expect(reply, 'runtime 回执应等于请求值（该档位受支持，无钳制）').toBe('high')

      const raw = (await fixture!.sendCommand('get_state')).data as { thinkingLevel?: string }
      expect(raw.thinkingLevel, 'G5 核心等式：回执 = get_state 实值（pi 生效档）').toBe(reply)
    })

    it('reasoning:false 模型 set high：pi 两级门控钳回 off，runtime 回执如实返回 off（非请求值）', { timeout: 60_000 }, async () => {
      // 注入演员（injectReasoningOffProbe 写进隔离 agentDir 的 models.json），按显式名字定位：
      // 宿主 models.json 里没有该名字也能命中，用例不依赖宿主文件内容。
      const actor = await switchToModel(
        (m) => m.provider === PROBE_PROVIDER_ID && m.id === PROBE_MODEL_ID,
        'off',
        `注入演员 ${PROBE_PROVIDER_ID}/${PROBE_MODEL_ID}`,
      )
      expect(actor.reasoning, 'pi 的模型清单应把注入演员报为 reasoning:false（注入内容已生效）').toBe(false)

      const reply = await svc!.setThinkingLevel(SID, 'high')
      expect(reply, 'runtime 回执必须是 pi 生效值 off（PS-02 两级门控），乐观回显请求值 = 事故 B 形态').toBe('off')

      const raw = (await fixture!.sendCommand('get_state')).data as {
        thinkingLevel?: string
        model?: { provider?: string; id?: string }
      }
      // 演员身份核对：pi 当前生效模型就是注入条目（排除「切模型静默失败、仍停在上一用例模型」的假通过）
      expect(raw.model?.provider, 'pi 当前模型应为注入演员 provider').toBe(PROBE_PROVIDER_ID)
      expect(raw.model?.id, 'pi 当前模型应为注入演员 model id').toBe(PROBE_MODEL_ID)
      expect(raw.thinkingLevel, 'G5 核心等式：回执 = get_state 实值（钳制后真值）').toBe('off')
    })
  },
)
