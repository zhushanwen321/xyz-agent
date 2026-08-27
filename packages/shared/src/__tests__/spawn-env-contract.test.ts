/**
 * spawn-env-contract 单测：出站契约常量的结构不变量。
 *
 * 守护（设计文档 env-propagation-boundary.md §5-U1 完成条件）：
 * - deny 清单成员最小性 = 首版恰为 2 个实证害项（D3 决策：只增不减、增删过评审）；
 * - 成员无重复、全大写蛇形命名；
 * - forward 参考清单覆盖 B 组五项 + U0① 增补项，且每条带 pi 子树消费锚点。
 */
import { describe, it, expect } from 'vitest'
import { SPAWN_ENV_OUTBOUND_DENY_LIST, SPAWN_ENV_FORWARD_REFERENCE } from '../spawn-env-contract.js'

describe('SPAWN_ENV_OUTBOUND_DENY_LIST 出站剥除清单', () => {
  it('成员最小性：恰为 2 个实证害项（D3：PACKAGED + TOKEN）', () => {
    expect(SPAWN_ENV_OUTBOUND_DENY_LIST).toHaveLength(2)
    expect([...SPAWN_ENV_OUTBOUND_DENY_LIST]).toEqual(['XYZ_AGENT_PACKAGED', 'XYZ_RUNTIME_TOKEN'])
  })

  it('无重复成员', () => {
    expect(new Set(SPAWN_ENV_OUTBOUND_DENY_LIST).size).toBe(SPAWN_ENV_OUTBOUND_DENY_LIST.length)
  })

  it('全大写蛇形命名', () => {
    for (const name of SPAWN_ENV_OUTBOUND_DENY_LIST) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })
})

describe('SPAWN_ENV_FORWARD_REFERENCE 参考清单（文档性质，不参与过滤）', () => {
  const names = SPAWN_ENV_FORWARD_REFERENCE.map(entry => entry.name)

  it('含 B 组五项', () => {
    expect(names).toContain('PI_CODING_AGENT_DIR')
    expect(names).toContain('XYZ_AGENT_DEBUG')
    expect(names).toContain('XYZ_GLOBAL_AGENTS_DIR')
    expect(names).toContain('XYZ_SUBAGENT_RELAY_SOCKET/_NODE/_SCRIPT')
    expect(names).toContain('XYZ_ZCODE_CLI')
  })

  it('含 U0① 增补项 XYZ_SUBAGENT_IDLE_TIMEOUT_MS（通道核实结论：B3 白名单继承）', () => {
    expect(names).toContain('XYZ_SUBAGENT_IDLE_TIMEOUT_MS')
  })

  it('每条目均带 injectionPath 与非空消费锚点', () => {
    for (const entry of SPAWN_ENV_FORWARD_REFERENCE) {
      expect(entry.injectionPath.trim()).not.toBe('')
      expect(entry.piConsumerAnchors.length).toBeGreaterThan(0)
      for (const anchor of entry.piConsumerAnchors) {
        expect(anchor.trim()).not.toBe('')
      }
    }
  })

  it('U0② 维持原判：LOG_LEVEL 族不入清单（extensions 零消费，仅 runtime 自身读取）', () => {
    for (const name of names) {
      expect(name.startsWith('XYZ_LOG_')).toBe(false)
    }
  })
})
