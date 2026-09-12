/**
 * paths.ts getPiSessionsDir 单测（PR #203 增量覆盖率门禁补测）。
 *
 * 覆盖：注入 dataDir 形态（join(dataDir, 'agent', 'sessions')）与缺省形态
 * （读 XYZ_AGENT_DATA_DIR env，未设时 homedir() 兜底）。__tests__ 此前无
 * XYZ_AGENT_DATA_DIR env 注入先例，缺省形态用 vitest 原生 vi.stubEnv 桩——
 * 被测函数是纯路径字符串推导，全程不触任何真实数据目录（~/.xyz-agent）、
 * 不做任何 fs 读断言。
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/paths.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getPiSessionsDir } from '../paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getPiSessionsDir', () => {
  it('注入 dataDir：join(dataDir, agent, sessions)（SSOT 同构推导，禁各进程手拼层级）', () => {
    expect(getPiSessionsDir('/tmp/xyz-shared-test-data')).toBe(
      join('/tmp/xyz-shared-test-data', 'agent', 'sessions'),
    )
  })

  it('缺省形态：读 XYZ_AGENT_DATA_DIR env（vi.stubEnv 注入，无 env 注入先例故用 env 桩）', () => {
    vi.stubEnv('XYZ_AGENT_DATA_DIR', '/tmp/xyz-shared-test-data')
    expect(getPiSessionsDir()).toBe(join('/tmp/xyz-shared-test-data', 'agent', 'sessions'))
  })

  it('缺省且 env 未设：homedir() 兜底 ~/.xyz-agent（纯字符串推导，不触 fs）', () => {
    vi.stubEnv('XYZ_AGENT_DATA_DIR', undefined)
    expect(getPiSessionsDir()).toBe(join(homedir(), '.xyz-agent', 'agent', 'sessions'))
  })
})
