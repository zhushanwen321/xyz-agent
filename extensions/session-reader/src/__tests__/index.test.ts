import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Check } from 'typebox/value'

/**
 * M3 pi 边界层（src/index.ts）单测（MF-6：此前该层零测试）。
 *
 * mock pi/ctx（as unknown as ExtensionAPI），测：
 * 1. execute catch → isError:true 文本返回（「execute 不向 pi 抛」契约守护）
 * 2. session_start handler 的 ctx.mode!=='tui' 守卫
 * 3. registeredPis WeakSet 去重：同 pi 二次 session_start 不重复注册；不同 pi 可注册
 * 4. typeof ctx.ui.addAutocompleteProvider 运行时守卫（ui 缺方法 → 跳过，不崩）
 * 5. registerCommand + addAutocompleteProvider 组装（tui 模式下各注册一次）
 * 6. TypeBox schema 与 SessionReadParams 对齐：合法 params 过、非法 action/scope 拒
 *
 * 不触碰真实文件系统：getAgentDir mock 固定假路径（execute 用例只触发 F5 抛错路径，
 * 不读盘）。
 */

// vi.mock 在 import 前 hoist；SessionManager stub 仅防 session-command/hash-provider
// 模块加载期缺导出（本文件用例不调用它）
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/tmp/pi-session-reader-test-agent',
  SessionManager: class {
    static async listAll(): Promise<never[]> {
      return []
    }
  },
}))

import sessionReaderExtension from '../index.js'

interface FakePi {
  pi: Record<string, unknown>
  registerTool: ReturnType<typeof vi.fn>
  registerCommand: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

function makeFakePi(): FakePi {
  const registerTool = vi.fn()
  const registerCommand = vi.fn()
  const on = vi.fn()
  return { pi: { registerTool, registerCommand, on }, registerTool, registerCommand, on }
}

interface FakeCtx {
  ctx: Record<string, unknown>
  addAutocompleteProvider: ReturnType<typeof vi.fn>
}

function makeFakeCtx(opts: { mode?: string; withUi?: boolean; sessionDir?: string } = {}): FakeCtx {
  const addAutocompleteProvider = vi.fn()
  const ctx: Record<string, unknown> = {
    mode: opts.mode ?? 'tui',
    sessionManager: { getSessionDir: () => opts.sessionDir ?? '/tmp/fake-session-dir' },
  }
  if (opts.withUi ?? true) {
    ctx.ui = { addAutocompleteProvider }
  } else {
    ctx.ui = {}
  }
  return { ctx, addAutocompleteProvider }
}

/** 触发 fake pi 的 session_start handler（取第一个注册的 handler）。 */
function fireSessionStart(on: ReturnType<typeof vi.fn>, ctx: Record<string, unknown>): void {
  const handler = on.mock.calls.find((c) => c[0] === 'session_start')?.[1]
  expect(handler).toBeTypeOf('function')
  handler({ type: 'session_start' }, ctx)
}

describe('sessionReaderExtension - execute 契约', () => {
  let fake: FakePi

  beforeEach(() => {
    fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
  })

  it('handler 抛错 → execute 返回 isError:true + 👉 文本，不向 pi 抛', async () => {
    const toolDef = fake.registerTool.mock.calls[0][0] as {
      name: string
      execute: (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown,
      ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>
    }
    expect(toolDef.name).toBe('session_read')
    // action=find 缺 query → F5 requireStr 抛错 → execute catch 转换
    const result = await toolDef.execute('tc-1', { action: 'find' }, undefined, undefined, undefined)
    expect(result.isError).toBe(true)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('👉')
    // 非 Error 抛错（string）也能转文本
    const result2 = await toolDef.execute('tc-2', { action: 123 }, undefined, undefined, undefined)
    expect(result2.isError).toBe(true)
    expect(typeof result2.content[0].text).toBe('string')
  })
})

describe('sessionReaderExtension - session_start TUI 注册', () => {
  it('mode !== tui → 不注册 command/provider', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const { ctx } = makeFakeCtx({ mode: 'rpc', withUi: true })
    fireSessionStart(fake.on, ctx)
    expect(fake.registerCommand).not.toHaveBeenCalled()
  })

  it('tui 模式 → registerCommand(session-pick) + addAutocompleteProvider 各一次', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const { ctx, addAutocompleteProvider } = makeFakeCtx({ mode: 'tui' })
    fireSessionStart(fake.on, ctx)
    expect(fake.registerCommand).toHaveBeenCalledTimes(1)
    expect(fake.registerCommand.mock.calls[0][0]).toBe('session-pick')
    expect(addAutocompleteProvider).toHaveBeenCalledTimes(1)
  })

  it('同 pi 二次 session_start → 不重复注册（WeakSet 去重，防 provider 堆叠）', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    fireSessionStart(fake.on, makeFakeCtx().ctx)
    fireSessionStart(fake.on, makeFakeCtx().ctx)
    expect(fake.registerCommand).toHaveBeenCalledTimes(1)
  })

  it('不同 pi 实例（resume 新 session）→ 各自可注册', () => {
    const fake1 = makeFakePi()
    const fake2 = makeFakePi()
    sessionReaderExtension(fake1.pi as unknown as ExtensionAPI)
    sessionReaderExtension(fake2.pi as unknown as ExtensionAPI)
    fireSessionStart(fake1.on, makeFakeCtx().ctx)
    fireSessionStart(fake2.on, makeFakeCtx().ctx)
    expect(fake1.registerCommand).toHaveBeenCalledTimes(1)
    expect(fake2.registerCommand).toHaveBeenCalledTimes(1)
  })

  it('ctx.ui 无 addAutocompleteProvider（typeof 守卫）→ 跳过注册不崩', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const { ctx } = makeFakeCtx({ withUi: false })
    fireSessionStart(fake.on, ctx)
    expect(fake.registerCommand).not.toHaveBeenCalled()
  })
})

describe('sessionReaderExtension - TypeBox schema 与 SessionReadParams 对齐', () => {
  it('合法完整 params 通过 schema 校验；非法 action/scope/类型被拒', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const toolDef = fake.registerTool.mock.calls[0][0] as { parameters: unknown }
    const schema = toolDef.parameters

    // 各 action 合法形态
    expect(Check(schema, { action: 'find', query: 'e6c96', limit: 5 })).toBe(true)
    expect(
      Check(schema, {
        action: 'search',
        session: '019e6c96',
        pattern: 'plugin',
        scope: 'toolResult',
      }),
    ).toBe(true)
    expect(Check(schema, { action: 'outline', session: 'e6c96', granularity: 'entry' })).toBe(true)
    expect(Check(schema, { action: 'export', session: 'e6c96', format: 'family' })).toBe(true)
    expect(
      Check(schema, { action: 'extract', session: 'e6c96', what: 'tool-results', tool: 'bash' }),
    ).toBe(true)
    // 全部可选字段齐全
    expect(
      Check(schema, {
        action: 'detail',
        session: 'e6c96',
        turns: 'T001-T003',
        includeToolResult: true,
        includeThinking: false,
        allBranches: true,
      }),
    ).toBe(true)

    // 非法值被拒（enum 约束生效）
    expect(Check(schema, { action: 'bogus' })).toBe(false)
    expect(Check(schema, { action: 'find', scope: 'nope' })).toBe(false)
    expect(Check(schema, { action: 'extract', what: 'everything' })).toBe(false)
    expect(Check(schema, { action: 42 })).toBe(false)
    expect(Check(schema, {})).toBe(false) // 缺必填 action
  })

  it('source 字段：合法值（main/subagent）通过、非法值拒绝；不传 source 向后兼容', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const toolDef = fake.registerTool.mock.calls[0][0] as { parameters: unknown }
    const schema = toolDef.parameters

    // 合法值通过（enum 约束）
    expect(Check(schema, { action: 'find', query: 'x', source: 'main' })).toBe(true)
    expect(Check(schema, { action: 'find', query: 'x', source: 'subagent' })).toBe(true)
    // 非法值被拒
    expect(Check(schema, { action: 'find', query: 'x', source: 'bogus' })).toBe(false)
    // 不传 source 向后兼容（既有合法形态仍 true）
    expect(Check(schema, { action: 'find', query: 'x' })).toBe(true)
  })

  it('TC-w6-schema-action：action enum 含 workflow + runId optional（w6）', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const toolDef = fake.registerTool.mock.calls[0][0] as { parameters: unknown }
    const schema = toolDef.parameters

    // action='workflow' 不传 runId（合法）
    expect(Check(schema, { action: 'workflow', session: 'e6c96' })).toBe(true)
    // action='workflow' 传 runId（合法）
    expect(Check(schema, { action: 'workflow', session: 'e6c96', runId: 'wf-1' })).toBe(true)
    // runId 传任意 action 均合法（其他 action 忽略 runId，不报错）
    expect(Check(schema, { action: 'find', query: 'x', runId: 'wf-1' })).toBe(true)
    // 不传 runId 向后兼容
    expect(Check(schema, { action: 'outline', session: 'e6c96' })).toBe(true)
    // runId 类型校验：非 string 被拒
    expect(Check(schema, { action: 'workflow', session: 'x', runId: 123 })).toBe(false)
  })

  it('TC-m3b-schema-recursive：recursive optional boolean（family 专用）', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const toolDef = fake.registerTool.mock.calls[0][0] as { parameters: unknown }
    const schema = toolDef.parameters

    // recursive=true（合法）
    expect(Check(schema, { action: 'family', session: 'e6c96', recursive: true })).toBe(true)
    // 不传 recursive（向后兼容，合法）
    expect(Check(schema, { action: 'family', session: 'e6c96' })).toBe(true)
    // recursive=false（合法）
    expect(Check(schema, { action: 'family', session: 'e6c96', recursive: false })).toBe(true)
    // recursive 非 boolean 被拒
    expect(Check(schema, { action: 'family', session: 'x', recursive: 'yes' })).toBe(false)
    expect(Check(schema, { action: 'family', session: 'x', recursive: 1 })).toBe(false)
  })
})
