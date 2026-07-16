/**
 * W1 TDD 测试：config-service 的 skill/agent 全局强制目录用动态 getConfigDir()。
 *
 * 背景：config-service.ts 顶层硬编码了强制全局目录：
 *   const FORCED_GLOBAL_SKILL_DIR = '~/.xyz-agent/skills'
 *   const FORCED_GLOBAL_AGENT_DIR = '~/.xyz-agent/agents'
 * 这导致即使设置了 XYZ_AGENT_DATA_DIR（getDataDir SSOT 读此 env，缺省 ~/.xyz-agent），
 * loadSkills/loadAgents 仍去扫硬编码的 ~/.xyz-agent/skills/agents，而不是用户配置的数据目录。
 * 后果：多实例隔离 / 自定义数据目录时，全局 skill/agent 不生效（pi 实际目录已重定向，
 * 但强制全局目录没跟上）。
 *
 * W1 改动：FORCED_GLOBAL_SKILL_DIR / FORCED_GLOBAL_AGENT_DIR 改为
 *   join(getConfigDir(), 'skills') / join(getConfigDir(), 'agents')
 * （getConfigDir 委托 getDataDir 读 env）。
 *
 * [红灯说明] 当前常量是硬编码 '~/.xyz-agent/skills'，设置 XYZ_AGENT_DATA_DIR 后
 * loadSkills 不扫该目录 → 断言「能扫到 skill」失败。改为动态 getConfigDir() 后应转绿。
 *
 * 验证方式：设置 XYZ_AGENT_DATA_DIR=<tmp>，在 <tmp>/skills/ 放一个 SKILL.md，
 * 调 loadSkills 断言扫到。Agent 同理（<tmp>/agents/*.md）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigService } from '../src/services/config-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import {
  setModelsPath,
  refreshModels,
} from '../src/infra/pi/pi-provider-store.js'
import { setSettingsPath } from '../src/infra/pi/pi-settings-store.js'
import { setDiscoveryPath, invalidateDiscoveryCache } from '../src/infra/pi/discovery-store.js'
import { getPiAgentDir, getConfigDir } from '../src/infra/pi/pi-paths.js'

let tmpDataDir: string
let configService: ConfigService
let savedEnv: string | undefined

beforeEach(() => {
  // 每个用例独立临时数据目录
  tmpDataDir = mkdtempSync(join(tmpdir(), 'config-paths-test-'))
  mkdirSync(join(tmpDataDir, 'pi', 'agent'), { recursive: true })

  // 设置 XYZ_AGENT_DATA_DIR → getDataDir/getConfigDir/getPiAgentDir 全部基于此
  savedEnv = process.env.XYZ_AGENT_DATA_DIR
  process.env.XYZ_AGENT_DATA_DIR = tmpDataDir

  // 把 pi 各模块的单例路径指向临时目录（避免污染真实 ~/.xyz-agent）
  setModelsPath(join(tmpDataDir, 'pi', 'agent', 'models.json'))
  setSettingsPath(join(tmpDataDir, 'pi', 'agent', 'settings.json'))
  setDiscoveryPath(join(tmpDataDir, 'pi', 'agent', 'discovery.json'))
  refreshModels()
  invalidateDiscoveryCache()

  configService = new ConfigService(tmpDataDir, new PiConfigStore())
})

afterEach(() => {
  // 还原 env
  if (savedEnv === undefined) delete process.env.XYZ_AGENT_DATA_DIR
  else process.env.XYZ_AGENT_DATA_DIR = savedEnv
  rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('W1: config-service skill/agent 全局强制目录跟随 getConfigDir()', () => {
  // ── CP1：loadSkills 扫描 XYZ_AGENT_DATA_DIR/skills ───────────
  it('CP1: 设 XYZ_AGENT_DATA_DIR 后，loadSkills 扫描 <datadir>/skills 而非硬编码 ~/.xyz-agent/skills', () => {
    // sanity：getConfigDir 应基于 env
    expect(getConfigDir()).toBe(tmpDataDir)

    // 在 <datadir>/skills/my-env-skill/ 放 SKILL.md（W1 修复后此目录会被强制扫描）
    const skillDir = join(tmpDataDir, 'skills', 'my-env-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\ndescription: env skill\n---\nbody')

    // 确认该文件确实存在（排除 fs 层面问题）
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)

    const skills = configService.loadSkills(tmpDataDir)
    const names = skills.map((s) => s.name)

    // 当前硬编码 ~/.xyz-agent/skills 时此处扫不到 → 红灯
    expect(names).toContain('my-env-skill')
  })

  // ── CP2：loadAgents 扫描 XYZ_AGENT_DATA_DIR/agents ───────────
  it('CP2: 设 XYZ_AGENT_DATA_DIR 后，loadAgents 扫描 <datadir>/agents 而非硬编码 ~/.xyz-agent/agents', () => {
    expect(getPiAgentDir()).toBe(join(tmpDataDir, 'pi', 'agent'))

    // 在 <datadir>/agents/ 放 agent.md（W1 修复后此目录会被强制扫描）
    const agentsDir = join(tmpDataDir, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, 'env-agent.md'), '---\nname: env-agent\ndescription: env agent\n---\nbody')

    const agents = configService.loadAgents(tmpDataDir)
    const ids = agents.map((a) => a.id)

    // 当前硬编码 ~/.xyz-agent/agents 时此处扫不到 → 红灯
    expect(ids).toContain('env-agent')
  })
})
