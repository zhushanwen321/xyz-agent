/**
 * command-registry.ts —— CommandRegistry（IF6）。
 *
 * 统一命令表：命令面板 + 快捷键 + slash + 菜单按钮的唯一来源（D1）。
 * command 型 contribution 经 registerFromContribution 归一（来自 ContributionRegistry，
 * W1 parseContributes 已解析进 ContributionRecord.command）；api.commands.register
 * （s3 落地）走 registerCommand(CommandRecord)。execute 触发
 * ActivationManager.ensureActivated(pluginId, 'onCommand') + 调注入的 CommandExecutor。
 *
 * 契约（IF6）：
 * - registerCommand 幂等：同 id 重复注册覆盖不翻倍
 * - registerFromContribution：command 型 contribution 转 CommandRecord 注册（id←contributionId），
 *   非 command 型 ignore；slashCommand 型 D1 归一（contributes.slashCommands 唯一声明源进表）归
 *   s3 api.commands.register 落地 + s5（W3 只建表结构，clarify Q4）
 * - execute 未找到命令：emit {kind:'error', source:'CommandRegistry', message:'command not found: <id>'}
 *   （ERR6 出声机制）+ resolve 不 throw——Promise<void> 下 ERR6 的「resolve(false)」退化，消费端
 *   据 error 事件显示禁用态/toast（clarify Q2）；激活/执行失败 reject 上抛（不静默）
 * - 先激活后执行：runtime executeCommand 要求 worker 已存在（TC6 论据），
 *   ensureActivated(pluginId, 'onCommand') 幂等（未声明激活事件 no-op）
 */
import type { InternalEventBus } from './internal-event-bus'
import type { ActivationManager } from './activation-manager'
import type { ContributionRecord } from './types'

/** 统一命令记录（命令面板/快捷键/slash/菜单按钮同表条目）。 */
export interface CommandRecord {
  id: string
  title: string
  category?: string
  keybinding?: string
  when?: string
  pluginId: string
  /** 命令处理器引用——api.commands.register 落地（s3）后填充；声明型 contribution 无 handler（执行归 executor/RPC）。 */
  handlerRef?: string
}

/** 命令执行注入接口：壳适配 runtime 的 commands.execute RPC（s3 新增）。 */
export interface CommandExecutor {
  execute(id: string, args?: unknown): Promise<void>
}

export interface CommandRegistryDeps {
  bus: InternalEventBus
  activationManager: ActivationManager
  executor: CommandExecutor
}

export class CommandRegistry {
  private commands = new Map<string, CommandRecord>()

  constructor(private deps: CommandRegistryDeps) {}

  /** 注册命令（api.commands.register 入口，s3）。幂等：同 id 覆盖不翻倍。 */
  registerCommand(cmd: CommandRecord): void {
    this.commands.set(cmd.id, cmd)
  }

  /**
   * command 型 contribution 归一入口（来自 ContributionRegistry.getContributions({type:'command'})）。
   * id←contributionId（= command id）、title/category/keybinding/when←c.command.*、pluginId←c.pluginId、
   * handlerRef←undefined（声明型无 handler）。非 command 型 ignore。
   */
  registerFromContribution(c: ContributionRecord): void {
    if (c.type !== 'command' || !c.command) return
    this.registerCommand({
      id: c.contributionId,
      title: c.command.title,
      category: c.command.category,
      keybinding: c.command.keybinding,
      when: c.command.when,
      pluginId: c.pluginId,
    })
  }

  /** 卸载命令（contribution 移除 / plugin 卸载时）。不存在 id：no-op。 */
  unregisterCommand(id: string): void {
    this.commands.delete(id)
  }

  get(id: string): CommandRecord | undefined {
    return this.commands.get(id)
  }

  /** 全量命令（命令面板/快捷键/slash/菜单按钮唯一来源）。 */
  list(): CommandRecord[] {
    return Array.from(this.commands.values())
  }

  /** 执行命令：先激活（ensureActivated(pluginId, 'onCommand')）后执行（executor.execute）。 */
  async execute(id: string, args?: unknown): Promise<void> {
    const cmd = this.commands.get(id)
    if (!cmd) {
      // ERR6 COMMAND_NOT_FOUND：出声机制（error 事件）+ resolve 不 throw（消费端据事件显示禁用态）
      this.deps.bus.emit({
        kind: 'error',
        source: 'CommandRegistry',
        message: `command not found: ${id}`,
      })
      return
    }
    // 先激活后执行（懒激活语义，TC6）：未声明 onCommand 激活事件的 plugin 此调用 no-op
    await this.deps.activationManager.ensureActivated(cmd.pluginId, 'onCommand')
    await this.deps.executor.execute(id, args)
  }
}
