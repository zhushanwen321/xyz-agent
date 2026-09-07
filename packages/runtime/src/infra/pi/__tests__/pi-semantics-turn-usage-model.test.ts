/**
 * PS-25 探针：turn_end.message 的 AssistantMessage 结构 + model vs responseModel 语义（D6 探针层）。
 *
 * 登记条目（docs/pi-semantics.json PS-25）：
 * turn_end.message 恒为完整 AssistantMessage（正常路径 = streamAssistantResponse 产物；
 * 失败路径 = handleRunFailure 合成 failureMessage，同形态 + EMPTY_USAGE），model/provider/
 * usage 全字段自带并经 RPC 原样下发；`model` = 请求侧 model.id（用户选择/会话当前模型），
 * `responseModel?` = 仅 openai-completions 在 provider 报告模型 ≠ 请求 id 时才设置
 * （OpenRouter auto 路由场景）——gen-stats 分桶 key 采 model 不采 responseModel 的裁定依据。
 *
 * 断言方式：静态直读 node_modules 实装 dist（pi-ai / pi-agent-core / pi-coding-agent 三包），
 * 同 pi-semantics-rpc-surface.test.ts 范式。dist 不可达时 skip 不 fail；不进 REAL_PI_TESTS
 * 分池。pi 升级后红 = AssistantMessage 结构 / turn_end 通路 / responseModel 语义漂移，
 * 先复核 PS-25 锚点再更新登记。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-turn-usage-model.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 定位实装 pi 包 dist（cwd 逐级上溯，同 pi-semantics-rpc-surface.test.ts 范式）。 */
function locatePiDist(pkg: string, sentinel: string): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', '@earendil-works', pkg, 'dist')
    if (existsSync(join(candidate, sentinel))) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

const PI_AI_DIST = locatePiDist('pi-ai', 'models.js')
const AGENT_CORE_DIST = locatePiDist('pi-agent-core', 'agent.js')
const CODING_AGENT_DIST = locatePiDist('pi-coding-agent', 'config.js')
const SKIP_REASON = PI_AI_DIST && AGENT_CORE_DIST && CODING_AGENT_DIST
  ? ''
  : 'node_modules/@earendil-works/{pi-ai,pi-agent-core,pi-coding-agent}/dist 不可达（cwd 上溯 6 级未命中）'
if (SKIP_REASON) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

describe.skipIf(SKIP_REASON !== '')(
  `PS-25 探针：turn_end.message AssistantMessage 结构与 model 语义（静态断言${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const typesDts = readFileSync(join(PI_AI_DIST as string, 'types.d.ts'), 'utf-8')
    const openaiCompletions = readFileSync(join(PI_AI_DIST as string, 'api', 'openai-completions.js'), 'utf-8')
    const agentCore = readFileSync(join(AGENT_CORE_DIST as string, 'agent.js'), 'utf-8')
    const agentLoop = readFileSync(join(AGENT_CORE_DIST as string, 'agent-loop.js'), 'utf-8')
    const agentSession = readFileSync(join(CODING_AGENT_DIST as string, 'core', 'agent-session.js'), 'utf-8')
    const jsonEvent = readFileSync(join(CODING_AGENT_DIST as string, 'modes', 'json-event.js'), 'utf-8')
    const rpcMode = readFileSync(join(CODING_AGENT_DIST as string, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8')

    it('pi-ai AssistantMessage：provider/model/usage 必填自带，responseModel 可选', () => {
      const m = /export interface AssistantMessage \{[\s\S]*?\n\}/.exec(typesDts)
      expect(m, 'PS-25 漂移：pi-ai AssistantMessage 接口声明消失——复核 dist/types.d.ts 锚点').not.toBeNull()
      const body = m![0]
      // 必填三件套（gen-stats 扩展字段的类型层依据）
      expect(body, 'provider 必填字段消失').toMatch(/^\s{4}provider: ProviderId;$/m)
      expect(body, 'model 必填字段消失').toMatch(/^\s{4}model: string;$/m)
      expect(body, 'usage 必填字段消失').toMatch(/^\s{4}usage: Usage;$/m)
      // responseModel 可选（≠ model 语义：实际响应模型，多数 provider 恒缺）
      expect(body, 'responseModel 可选声明消失（若改为必填，PS-25 裁定前提变化，须重新登记）').toMatch(/^\s{4}responseModel\?: string;$/m)
    })

    it('pi-ai Usage：input/output/cacheRead/cacheWrite/totalTokens 全必填 number', () => {
      const m = /export interface Usage \{[\s\S]*?\n\}/.exec(typesDts)
      expect(m, 'PS-25 漂移：pi-ai Usage 接口声明消失——复核 dist/types.d.ts 锚点').not.toBeNull()
      const body = m![0]
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) {
        expect(body, `Usage.${field} 必填 number 声明消失`).toMatch(new RegExp(`^\\s{4}${field}: number;$`, 'm'))
      }
    })

    it('pi-ai openai-completions：AssistantMessage 构造 model=model.id / provider=model.provider；responseModel 仅在 chunk.model≠请求 id 时设置', () => {
      // 构造点：流式 output 对象初始化（请求侧 id，非 provider 报告值）
      expect(
        openaiCompletions.includes('provider: model.provider,'),
        'PS-25 漂移：构造点 provider 不再取 model.provider——AssistantMessage.provider 语义变化，复核 PS-25',
      ).toBe(true)
      expect(
        openaiCompletions.includes('model: model.id,'),
        'PS-25 漂移：构造点 model 不再取 model.id——AssistantMessage.model 语义变化（这是「请求侧模型」裁定的承重锚点）',
      ).toBe(true)
      // responseModel 唯一赋值点：条件 chunk.model !== model.id（实际响应模型 ≠ 请求 id 才记录）
      const assign = /if \(typeof chunk\.model === "string" && chunk\.model\.length > 0 && chunk\.model !== model\.id\) \{\s*\n\s*output\.responseModel \|\|= chunk\.model;/.exec(openaiCompletions)
      expect(
        assign,
        'PS-25 漂移：responseModel 赋值条件改变（不再限定于 provider 报告模型≠请求 id）——responseModel 语义复核',
      ).not.toBeNull()
    })

    it('pi-agent-core agent-loop：turn_end.message = streamAssistantResponse 产物（正常路径恒 AssistantMessage）', () => {
      expect(
        agentLoop.includes('const message = await streamAssistantResponse('),
        'PS-25 漂移：turn 消息不再产自 streamAssistantResponse——复核 agent-loop.js',
      ).toBe(true)
      expect(
        /await emit\(\{ type: "turn_end", message, toolResults: \[\] \}\);/.test(agentLoop) &&
        /await emit\(\{ type: "turn_end", message, toolResults \}\);/.test(agentLoop),
        'PS-25 漂移：turn_end 发射点不再携带 streamAssistantResponse 的 message——复核 agent-loop.js 两个发射分支',
      ).toBe(true)
    })

    it('pi-agent-core handleRunFailure：失败路径合成 failureMessage 同 AssistantMessage 形态 + EMPTY_USAGE 全 0', () => {
      // EMPTY_USAGE：totalTokens=0 → xyz runtime 的 usage.totalTokens gate 丢弃失败 turn（不产 gen-stats 样本）
      const emptyUsage = /const EMPTY_USAGE = \{[\s\S]*?\};/.exec(agentCore)
      expect(emptyUsage, 'PS-25 漂移：EMPTY_USAGE 常量消失——复核 agent.js').not.toBeNull()
      expect(emptyUsage![0], 'EMPTY_USAGE.totalTokens 不再为 0——失败 turn 将穿过 runtime totalTokens gate，须重审 gen-stats 丢弃语义').toMatch(/totalTokens: 0/)
      // failureMessage：model/provider 取请求侧 state.model，usage = EMPTY_USAGE
      const failure = /const failureMessage = \{[\s\S]*?\n\s{8}\};/.exec(agentCore)
      expect(failure, 'PS-25 漂移：handleRunFailure.failureMessage 构造消失——复核 agent.js').not.toBeNull()
      const body = failure![0]
      expect(body, '失败路径 model 不再取 _state.model.id').toMatch(/model: this\._state\.model\.id,/)
      expect(body, '失败路径 provider 不再取 _state.model.provider').toMatch(/provider: this\._state\.model\.provider,/)
      expect(body, '失败路径 usage 不再是 EMPTY_USAGE').toMatch(/usage: EMPTY_USAGE,/)
      expect(
        agentCore.includes('await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });'),
        'PS-25 漂移：失败路径不再发射 turn_end——复核 agent.js handleRunFailure',
      ).toBe(true)
    })

    it('pi-coding-agent agent-session：turn_end 原样透传 listeners（仅 agent_end 附加 willRetry）', () => {
      expect(
        agentSession.includes('this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);'),
        'PS-25 漂移：_handleAgentEvent 的 listener 透传形态改变（turn_end 不再原样 _emit）——复核 agent-session.js',
      ).toBe(true)
      // 扩展事件形态：message 字段原样引用 event.message（无字段重写/裁剪）
      const ext = /type: "turn_end",\s*\n\s*turnIndex: this\._turnIndex,\s*\n\s*message: event\.message,/.exec(agentSession)
      expect(ext, 'PS-25 漂移：_emitExtensionEvent 的 turn_end.message 不再原样引用 event.message').not.toBeNull()
    })

    it('pi-coding-agent RPC 通路：toJsonEvent 非 message_update 原样返回 + rpc-mode 经其下发全部 session 事件', () => {
      expect(
        jsonEvent.includes('if (event.type !== "message_update") {'),
        'PS-25 漂移：toJsonEvent 的原样透传分支消失——turn_end RPC 下发形态改变，复核 modes/json-event.js',
      ).toBe(true)
      expect(
        /if \(event\.type !== "message_update"\) \{\s*\n\s*return event;/.test(jsonEvent),
        'PS-25 漂移：toJsonEvent 非 message_update 不再 return event 原样——AssistantMessage 附加字段可能在 RPC 下发时被裁剪',
      ).toBe(true)
      expect(
        rpcMode.includes('output(toJsonEvent(event));'),
        'PS-25 漂移：rpc-mode 不再经 toJsonEvent 下发 session 事件——复核 modes/rpc/rpc-mode.js subscribe 段',
      ).toBe(true)
    })
  },
)
