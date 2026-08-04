/**
 * command-registry.test.ts —— CommandRegistry 契约（IF6，TC-1/TC-2/TC-4）。
 *
 * TC-1：command 型 contribution 注册后 list() 含该命令（registerFromContribution 归一 + 字段映射）
 * TC-2：execute 触发 ensureActivated(onCommand) + mock executor（双 spy + 调用顺序）
 * TC-4：未注册 execute → ERR6 error 事件 + resolve 不 throw + executor 零调用
 * 另覆盖：registerCommand 幂等覆盖 / unregister / 非 command 型 ignore / 执行失败 reject
 */
import { describe, it, expect, vi } from 'vitest'
import { CommandRegistry, type CommandExecutor } from '../command-registry'
import { ActivationManager, type ActivationTrigger } from '../activation-manager'
import { InternalEventBus } from '../internal-event-bus'
import type { ContributionRecord } from '../types'

function setup() {
  const bus = new InternalEventBus()
  const emit = vi.spyOn(bus, 'emit')
  const activationTrigger = vi.fn<ActivationTrigger['ensureActivated']>().mockResolvedValue(undefined)
  const activationManager = new ActivationManager({ trigger: { ensureActivated: activationTrigger } })
  const executeFn = vi.fn<CommandExecutor['execute']>().mockResolvedValue(undefined)
  const executor: CommandExecutor = { execute: executeFn }
  const registry = new CommandRegistry({ bus, activationManager, executor })
  return { bus, emit, activationTrigger, activationManager, executor, executeFn, registry }
}

/** command 型 contribution 样本（W1 parseContributes 产出形状）。 */
function commandContribution(overrides: Partial<ContributionRecord> = {}): ContributionRecord {
  return {
    pluginId: 'p1',
    contributionId: 'p1.hello',
    type: 'command',
    placement: 'commands',
    available: true,
    command: { title: 'Hello', category: 'Demo', keybinding: 'Ctrl+H', when: 'editorFocus' },
    ...overrides,
  }
}

describe('CommandRegistry 统一命令表（TC-1 + registerCommand 幂等）', () => {
  it('TC-1a: registerFromContribution(command 型) → list() 含该命令 + get 字段映射正确', () => {
    const { registry } = setup()
    registry.registerFromContribution(commandContribution())
    expect(registry.list()).toHaveLength(1)
    const cmd = registry.get('p1.hello')
    expect(cmd).toMatchObject({
      id: 'p1.hello',
      title: 'Hello',
      category: 'Demo',
      keybinding: 'Ctrl+H',
      when: 'editorFocus',
      pluginId: 'p1',
    })
    expect(cmd?.handlerRef).toBeUndefined() // 声明型无 handler（R2）
  })

  it('TC-1b: registerCommand 手动注册（api.commands.register 入口）→ get/list 正确', () => {
    const { registry } = setup()
    registry.registerCommand({
      id: 'p1.dynamic',
      title: 'Dynamic',
      pluginId: 'p1',
      handlerRef: 'handler:dynamic',
    })
    expect(registry.get('p1.dynamic')?.handlerRef).toBe('handler:dynamic')
    expect(registry.list().map((c) => c.id)).toEqual(['p1.dynamic'])
  })

  it('TC-1c: 同 id 重复注册覆盖不翻倍（registerCommand 幂等）', () => {
    const { registry } = setup()
    registry.registerCommand({ id: 'x', title: 'A', pluginId: 'p1' })
    registry.registerCommand({ id: 'x', title: 'B', pluginId: 'p1' })
    expect(registry.list()).toHaveLength(1)
    expect(registry.get('x')?.title).toBe('B')
  })

  it('TC-1d: registerFromContribution 非 command 型（view/slashCommand）→ ignore 不进表', () => {
    const { registry } = setup()
    registry.registerFromContribution({
      pluginId: 'p1',
      contributionId: 'v1',
      type: 'view',
      placement: 'sidebar.tab',
      available: true,
      view: { viewType: 'gui', title: 'View', initialVisibility: 'hidden' },
    })
    registry.registerFromContribution({
      pluginId: 'p1',
      contributionId: 'goal',
      type: 'slashCommand',
      placement: 'slash',
      available: true,
      slashCommand: { name: 'goal', description: '创建目标' },
    })
    expect(registry.list()).toHaveLength(0)
  })
})

describe('CommandRegistry.execute（TC-2 激活→执行 + TC-4 ERR6）', () => {
  it('TC-2a: execute 触发 ensureActivated(\'p1\',\'onCommand\') + executor.execute(id, args)，顺序先激活后执行', async () => {
    const { activationTrigger, activationManager, executeFn, registry } = setup()
    registry.registerCommand({ id: 'p1.hello', title: 'Hello', pluginId: 'p1' })
    activationManager.registerActivationEvents('p1', ['onCommand'])
    await registry.execute('p1.hello', { x: 1 })
    expect(activationTrigger).toHaveBeenCalledWith('p1', 'onCommand')
    expect(executeFn).toHaveBeenCalledWith('p1.hello', { x: 1 })
    // 顺序：激活先于执行
    expect(activationTrigger.mock.invocationCallOrder[0]).toBeLessThan(
      executeFn.mock.invocationCallOrder[0],
    )
  })

  it('TC-2b: 未声明 onCommand 激活事件的 plugin → ensureActivated no-op，但命令仍执行', async () => {
    const { activationTrigger, executeFn, registry } = setup()
    registry.registerCommand({ id: 'p1.hello', title: 'Hello', pluginId: 'p1' })
    // 不 registerActivationEvents → no-op 不阻塞
    await registry.execute('p1.hello')
    expect(activationTrigger).not.toHaveBeenCalled()
    expect(executeFn).toHaveBeenCalledWith('p1.hello', undefined)
  })

  it('TC-4a: execute 未注册 id → ERR6 error 事件（kind/source/message）+ resolve 不 throw + executor 零调用', async () => {
    const { emit, executeFn, registry } = setup()
    await expect(registry.execute('ghost.command')).resolves.toBeUndefined()
    const err = emit.mock.calls.map((c) => c[0]).find((e) => e.kind === 'error')
    expect(err).toBeDefined()
    expect(err).toMatchObject({
      kind: 'error',
      source: 'CommandRegistry',
    })
    expect((err as { message: string }).message).toContain('command not found: ghost.command')
    expect(executeFn).not.toHaveBeenCalled()
  })

  it('TC-4b: unregisterCommand 后 get()===undefined + execute 走未注册路径', async () => {
    const { emit, executeFn, registry } = setup()
    registry.registerCommand({ id: 'p1.hello', title: 'Hello', pluginId: 'p1' })
    registry.unregisterCommand('p1.hello')
    expect(registry.get('p1.hello')).toBeUndefined()
    await registry.execute('p1.hello')
    expect(executeFn).not.toHaveBeenCalled()
    expect(emit.mock.calls.some((c) => c[0].kind === 'error')).toBe(true)
  })

  it('TC-4c: 执行失败（executor reject）→ execute reject 上抛（不静默吞）', async () => {
    const { registry } = setup()
    registry.registerCommand({ id: 'p1.hello', title: 'Hello', pluginId: 'p1' })
    const failingExecutor: CommandExecutor = {
      execute: vi.fn().mockRejectedValue(new Error('exec failed')),
    }
    const reg2 = new CommandRegistry({
      bus: new InternalEventBus(),
      activationManager: new ActivationManager({ trigger: { ensureActivated: vi.fn() } }),
      executor: failingExecutor,
    })
    reg2.registerCommand({ id: 'p1.hello', title: 'Hello', pluginId: 'p1' })
    await expect(reg2.execute('p1.hello')).rejects.toThrow('exec failed')
  })

  it('TC-4d: 激活失败（trigger reject）→ execute reject 上抛', async () => {
    const failingTrigger: ActivationTrigger = {
      ensureActivated: vi.fn().mockRejectedValue(new Error('activate failed')),
    }
    const am = new ActivationManager({ trigger: failingTrigger })
    am.registerActivationEvents('p1', ['onCommand'])
    const reg2 = new CommandRegistry({
      bus: new InternalEventBus(),
      activationManager: am,
      executor: { execute: vi.fn() },
    })
    reg2.registerCommand({ id: 'p1.hello', title: 'Hello', pluginId: 'p1' })
    await expect(reg2.execute('p1.hello')).rejects.toThrow('activate failed')
  })
})
