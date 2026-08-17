/**
 * tasks builtin plugin manifest 骨架单元测试（s5 W3）。
 *
 * 覆盖：结构合法性（DM1 骨架约束）/ 序列化 round-trip / builtin:true 字面量与类型标记。
 * 测试框架 vitest，运行命令 cd packages/core && npx vitest run。
 */
import { describe, expect, it } from 'vitest'
import {
  tasksPluginManifest,
  type BuiltinActivationEvent,
  type BuiltinPluginManifest,
} from '../index'

/** 合法激活事件枚举（与 manifest.ts 的 BuiltinActivationEvent 对齐，测试侧镜像防止误写）。 */
const VALID_ACTIVATION_EVENTS: BuiltinActivationEvent[] = [
  'onStartupFinished',
  'onView',
  'onCommand',
  'onSlashCommand',
  'onSessionCreate',
]

describe('tasksPluginManifest', () => {
  it('tc-1: 结构合法——id 全局唯一命名空间、builtin:true、activationEvents 合法枚举', () => {
    expect(tasksPluginManifest.id).toBe('xyz-agent.tasks')
    expect(tasksPluginManifest.builtin).toBe(true)

    // activationEvents 非空且均为合法枚举值
    expect(tasksPluginManifest.activationEvents.length).toBeGreaterThan(0)
    for (const evt of tasksPluginManifest.activationEvents) {
      expect(VALID_ACTIVATION_EVENTS).toContain(evt)
    }
  })

  it('tc-1: contributes.slashCommands 含 /goal 与 /todo（含前导斜杠）', () => {
    const names = (tasksPluginManifest.contributes.slashCommands ?? []).map((c) => c.name)
    expect(names).toContain('/goal')
    expect(names).toContain('/todo')
    // DM1 骨架约定：name 必须含前导 /
    for (const name of names) {
      expect(name.startsWith('/')).toBe(true)
    }
  })

  it('tc-1: contributes.commands 非空且 command 字段带 tasks 命名空间前缀', () => {
    const commands = tasksPluginManifest.contributes.commands ?? []
    expect(commands.length).toBeGreaterThan(0)
    for (const c of commands) {
      expect(c.command.startsWith('xyz-agent.tasks.')).toBe(true)
      expect(c.title.length).toBeGreaterThan(0)
    }
  })

  it('tc-2: 序列化 round-trip 后值不变（未来经 WS/注入通道传输的前提）', () => {
    const roundTripped = JSON.parse(JSON.stringify(tasksPluginManifest))
    expect(roundTripped).toEqual(tasksPluginManifest)
  })

  it('tc-3: builtin 字段运行时为字面量 true（免审批/免 sandbox 锁身份标记）', () => {
    expect(tasksPluginManifest.builtin).toBe(true)
    // 类型层验证：builtin 字段在类型中声明为字面量 true，不可赋 false。
    // 若类型退化为 boolean，下行 @ts-expect-error 会变为 unused 导致 tsc 失败。
    // @ts-expect-error builtin 字面量类型强制为 true
    const invalid: BuiltinPluginManifest = { ...tasksPluginManifest, builtin: false }
    void invalid
  })
})
