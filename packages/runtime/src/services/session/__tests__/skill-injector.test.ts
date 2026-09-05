/**
 * SkillInjector 单测（composer-multi-skill-injection P1）。
 *
 * 覆盖任务清单 ①-⑨：pi 逐字 golden 展开 / 无标记零改动 / 超阈值降级形态 /
 * contextWindow fail-safe / 阈值边界 / 三类失效透传+提示 / location 缺省补路径。
 * SKILL.md fixture 用 mkdtempSync 自建自删（测试禁区红线：不触碰真实数据目录）；
 * get_commands / get_session_stats 以 fake client 注入（真实链路由验收阶段 Gate B 覆盖）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSkillMarker,
  SKILL_FALLBACK_GUIDANCE,
  SKILLS_BLOCK_TAG,
} from '@xyz-agent/shared'
import { SkillInjector } from '../skill-injector.js'
import type { IPiEngine, PiCommandInfo } from '../../ports/pi-engine.js'

// ── fixture：tmp 下自建两个 skill 目录 ──

let tmpRoot: string
let skillADir: string
let skillBDir: string
let skillAPath: string
let skillBPath: string

const SKILL_A_MD = [
  '---',
  'name: skill-a',
  'description: test skill a',
  '---',
  '# Skill A',
  '',
  'Body line one.',
  '',
].join('\n')

const SKILL_B_MD = ['## Skill B', '', 'No frontmatter body.', ''].join('\n')

/** skill-a 剥 frontmatter 后的 body（trim 后，展开 block 的黄金正文）。 */
const SKILL_A_BODY = '# Skill A\n\nBody line one.'
const SKILL_B_BODY = '## Skill B\n\nNo frontmatter body.'

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'skill-injector-test-'))
  skillADir = join(tmpRoot, 'skill-a')
  skillBDir = join(tmpRoot, 'skill-b')
  mkdirSync(skillADir)
  mkdirSync(skillBDir)
  skillAPath = join(skillADir, 'SKILL.md')
  skillBPath = join(skillBDir, 'SKILL.md')
  writeFileSync(skillAPath, SKILL_A_MD)
  writeFileSync(skillBPath, SKILL_B_MD)
})

afterEach(() => {
  // maxRetries：teardown 递归删除与在途异步写竞争（满载 ENOTEMPTY flake，教训 d9ad39cb8）
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── fake client ──

/**
 * skill 命令 fake：name 带 `skill:` 前缀（对齐 pi 实装 agent-session.js :1996
 * `name: \`skill:${skill.name}\``）——mock 与实装不同形会掩盖生产错位（PS-24 教训）。
 * 不设 sourceInfo.baseDir：注入器 References 行取 dirname(path)（skill.baseDir 实装语义），
 * 不消费 sourceInfo.baseDir。
 */
const skillCmd = (name: string, path: string): PiCommandInfo => ({
  name: `skill:${name}`,
  source: 'skill',
  sourceInfo: { path, source: 'skill' },
})

interface ClientOverrides {
  commands?: PiCommandInfo[]
  commandsError?: Error
  stats?: { contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } }
  statsError?: Error
}

function makeClient(overrides: ClientOverrides = {}): { client: IPiEngine; getCommands: ReturnType<typeof vi.fn>; getSessionStats: ReturnType<typeof vi.fn> } {
  const getCommands = vi.fn(async () => {
    if (overrides.commandsError) throw overrides.commandsError
    return overrides.commands ?? []
  })
  const getSessionStats = vi.fn(async () => {
    if (overrides.statsError) throw overrides.statsError
    return overrides.stats ?? {}
  })
  return { client: { getCommands, getSessionStats } as unknown as IPiEngine, getCommands, getSessionStats }
}

/** 与 pi 实装模板逐字同构的 block 期望构造（path/baseDir 为 fixture 真实路径）。 */
const expectedBlock = (name: string, path: string, baseDir: string, body: string): string =>
  `<skill name="${name}" location="${path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`

describe('SkillInjector.inject', () => {
  let injector: SkillInjector
  beforeEach(() => {
    injector = new SkillInjector()
  })

  it('① 单标记：原位展开与 pi 模板逐字一致（block 与前后正文空行分隔）', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const text = `帮我 ${marker} 处理问题`
    const { client } = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, text)
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    expect(result.text).toBe(`帮我\n\n${block}\n\n处理问题`)
    expect(result.notices).toEqual([])
  })

  it('① 多标记：两个 block 各自原位替换、空行分隔（golden 逐字）', async () => {
    const text = [
      '开头',
      buildSkillMarker('skill-a', skillAPath),
      '中间',
      buildSkillMarker('skill-b', skillBPath),
      '结尾',
    ].join(' ')
    const { client } = makeClient({
      commands: [skillCmd('skill-a', skillAPath), skillCmd('skill-b', skillBPath)],
      stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } },
    })
    const result = await injector.inject(client, text)
    const blockA = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    const blockB = expectedBlock('skill-b', skillBPath, skillBDir, SKILL_B_BODY)
    expect(result.text).toBe(`开头\n\n${blockA}\n\n中间\n\n${blockB}\n\n结尾`)
  })

  it('① 标记位于两端：对齐 pi 原生「block 开头 + args」与「正文 + block 结尾」形态', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    const { client } = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    // block 开头（pi 原生 /skill:name args 的形态）
    const head = await injector.inject(client, `${marker} 后续正文`)
    expect(head.text).toBe(`${block}\n\n后续正文`)
    // block 结尾
    const tail = await injector.inject(client, `前置正文 ${marker}`)
    expect(tail.text).toBe(`前置正文\n\n${block}`)
  })

  it('② 无标记文本零改动且不发起任何 RPC', async () => {
    const text = '普通文本 /skill:skill-a 手打命令不处理'
    const { client, getCommands, getSessionStats } = makeClient()
    const result = await injector.inject(client, text)
    expect(result.text).toBe(text)
    expect(result.notices).toEqual([])
    expect(getCommands).not.toHaveBeenCalled()
    expect(getSessionStats).not.toHaveBeenCalled()
  })

  it('③ 超阈值：整条降级为降级块（正文保留、无 skill 全文、块含 name/location 与指引行）', async () => {
    // 大 CJK body：估算 ≈ 1000+ token > 0.8 × 100 = 80
    const bigBody = '很'.repeat(1000)
    writeFileSync(skillAPath, `---\nname: skill-a\ndescription: big\n---\n${bigBody}`)
    const marker = buildSkillMarker('skill-a', skillAPath)
    const text = `正文在前 ${marker}`
    const { client, getCommands } = makeClient({
      commands: [skillCmd('skill-a', skillAPath)],
      stats: { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } },
    })
    const result = await injector.inject(client, text)
    // 正文保留 + 块形态（buildSkillsFallbackBlock 产物 + 空行拼接）
    const fallbackBlock = [
      `<${SKILLS_BLOCK_TAG}>`,
      buildSkillMarker('skill-a', skillAPath),
      `</${SKILLS_BLOCK_TAG}>`,
      SKILL_FALLBACK_GUIDANCE,
    ].join('\n')
    expect(result.text).toBe(`正文在前\n\n${fallbackBlock}`)
    expect(result.text).not.toContain(bigBody)
    expect(result.text).toContain(SKILL_FALLBACK_GUIDANCE)
    expect(result.text).toContain(skillAPath)
    expect(result.notices).toEqual([{ reason: 'budget_exceeded', skills: ['skill-a'] }])
    expect(getCommands).toHaveBeenCalledTimes(1)
  })

  it('③ 多 skill 超阈值：降级块归拢全部 name/location（按出现顺序）', async () => {
    const bigBody = '很'.repeat(600)
    writeFileSync(skillAPath, bigBody)
    writeFileSync(skillBPath, bigBody)
    const text = `${buildSkillMarker('skill-a', skillAPath)} ${buildSkillMarker('skill-b', skillBPath)}`
    const { client } = makeClient({
      commands: [skillCmd('skill-a', skillAPath), skillCmd('skill-b', skillBPath)],
      stats: { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } },
    })
    const result = await injector.inject(client, text)
    expect(result.text).toContain(`name="skill-a" location="${skillAPath}"`)
    expect(result.text).toContain(`name="skill-b" location="${skillBPath}"`)
    expect(result.notices).toEqual([{ reason: 'budget_exceeded', skills: ['skill-a', 'skill-b'] }])
  })

  it('④ get_session_stats 抛错：fail-safe 降级（reason=context_window_unavailable），不放行全文', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const { client } = makeClient({
      commands: [skillCmd('skill-a', skillAPath)],
      statsError: new Error('rpc timeout'),
    })
    const result = await injector.inject(client, `正文 ${marker}`)
    expect(result.text).toContain(`<${SKILLS_BLOCK_TAG}>`)
    expect(result.text).not.toContain(SKILL_A_BODY)
    expect(result.notices).toEqual([{ reason: 'context_window_unavailable', skills: ['skill-a'] }])
  })

  it('④ contextUsage 缺失 / contextWindow 非法：同样 fail-safe 降级', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const noUsage = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: {} })
    const resultNoUsage = await injector.inject(noUsage.client, `正文 ${marker}`)
    expect(resultNoUsage.text).toContain(`<${SKILLS_BLOCK_TAG}>`)
    expect(resultNoUsage.notices[0]?.reason).toBe('context_window_unavailable')

    const zeroWindow = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 0, contextWindow: 0, percent: null } } })
    const resultZero = await injector.inject(zeroWindow.client, `正文 ${marker}`)
    expect(resultZero.notices[0]?.reason).toBe('context_window_unavailable')
  })

  it('⑤ 阈值边界：恰好等于阈值 / 略低不降级，略超降级（纯英文字符构造精确估算值）', async () => {
    // 纯英文按 u1 公式 chars/4：构造内容使估算恰为 0.8 × window。
    // window=400 → 阈值 320 token；hypothetical = "x" + "\n\n" + block，
    // blockLen = 前缀 + N + len("\n</skill>")，令 (3 + blockLen) / 4 = 320 → N = 1277 - 前缀。
    const window = 400
    const prefix = `<skill name="skill-a" location="${skillAPath}">\nReferences are relative to ${skillADir}.\n\n`
    const suffixLen = '\n</skill>'.length
    const nExact = 1280 - 3 - (prefix.length + suffixLen)
    const bodyOf = (n: number) => 'a'.repeat(n)
    const writeBody = (n: number) => writeFileSync(skillAPath, `---\nname: skill-a\ndescription: t\n---\n${bodyOf(n)}`)
    const marker = buildSkillMarker('skill-a', skillAPath)

    // 略低（估算 318 < 320）：不降级，全文展开
    writeBody(nExact - 8)
    const low = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: window, percent: 1 } } })
    const lowResult = await injector.inject(low.client, `x ${marker}`)
    expect(lowResult.text).not.toContain(`<${SKILLS_BLOCK_TAG}>`)
    expect(lowResult.text).toContain('a'.repeat(nExact - 8))
    expect(lowResult.notices).toEqual([])

    // 恰好等于阈值（320 > 320 为 false）：不降级
    writeBody(nExact)
    const exact = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: window, percent: 1 } } })
    const exactResult = await injector.inject(exact.client, `x ${marker}`)
    expect(exactResult.text).not.toContain(`<${SKILLS_BLOCK_TAG}>`)
    expect(exactResult.notices).toEqual([])

    // 略超（321+ > 320）：降级
    writeBody(nExact + 8)
    const over = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: window, percent: 1 } } })
    const overResult = await injector.inject(over.client, `x ${marker}`)
    expect(overResult.text).toContain(`<${SKILLS_BLOCK_TAG}>`)
    expect(overResult.notices[0]?.reason).toBe('budget_exceeded')
  })

  it('⑥ name 无映射：标记原样透传 + skill_missing 提示（无 valid 时跳过预检 RPC）', async () => {
    const marker = buildSkillMarker('ghost', '/nonexistent/SKILL.md')
    const { client, getCommands, getSessionStats } = makeClient({ commands: [skillCmd('skill-a', skillAPath)] })
    const result = await injector.inject(client, `正文 ${marker} 结束`)
    expect(result.text).toBe(`正文 ${marker} 结束`)
    expect(result.notices).toEqual([{ reason: 'skill_missing', skills: ['ghost'] }])
    expect(getCommands).toHaveBeenCalledTimes(1)
    expect(getSessionStats).not.toHaveBeenCalled()
  })

  it('⑦ SKILL.md 读取失败：标记原样透传 + skill_read_failed 提示', async () => {
    const missingPath = join(skillADir, 'missing', 'SKILL.md')
    const marker = buildSkillMarker('skill-a', missingPath)
    const { client } = makeClient({ commands: [skillCmd('skill-a', missingPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, `正文 ${marker}`)
    expect(result.text).toBe(`正文 ${marker}`)
    expect(result.notices).toEqual([{ reason: 'skill_read_failed', skills: ['skill-a'] }])
  })

  it('⑦ 映射缺 sourceInfo.path：无法定位文件，按读取失败处理', async () => {
    const marker = buildSkillMarker('skill-a', '')
    const { client } = makeClient({
      commands: [{ name: 'skill:skill-a', source: 'skill' }],
      stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } },
    })
    const result = await injector.inject(client, `正文 ${marker}`)
    expect(result.text).toBe(`正文 ${marker}`)
    expect(result.notices).toEqual([{ reason: 'skill_read_failed', skills: ['skill-a'] }])
  })

  it('⑧ 标记残缺（hook 改写破坏）：残缺部分透传 + marker_malformed 提示，不发起 RPC', async () => {
    const text = `帮我 <xyz-skill name="skill-a" loc 这段`
    const { client, getCommands } = makeClient()
    const result = await injector.inject(client, text)
    expect(result.text).toBe(text)
    expect(result.notices).toEqual([{ reason: 'marker_malformed', skills: ['skill-a'] }])
    expect(getCommands).not.toHaveBeenCalled()
  })

  it('⑨ location 缺省标记：get_commands 映射补路径，正常展开', async () => {
    const marker = buildSkillMarker('skill-a')
    const { client } = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, marker)
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    expect(result.text).toBe(block)
    expect(result.notices).toEqual([])
  })

  it('PS-24：get_commands name 带 skill: 前缀（实装形态）——映射可命中且展开 block name 无前缀', async () => {
    // 实装 get_commands 的 skill 项 name 恒带 `skill:` 前缀（agent-session.js :1996）；
    // 私有标记 name 是裸名——映射按裸名命中、block name 插值剥前缀，两端都对齐 pi。
    const marker = buildSkillMarker('skill-a', skillAPath)
    const { client } = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, `帮我 ${marker}`)
    // 显式断言：不误报 skill_missing + block name 无前缀（pi 原生展开形态）
    expect(result.notices).toEqual([])
    expect(result.text).toContain(`<skill name="skill-a" location="${skillAPath}">`)
    expect(result.text).not.toContain('name="skill:')
  })

  it('get_commands 整体失败：全部标记透传 + mapping_unavailable（不走降级——location 无从构建）', async () => {
    const m1 = buildSkillMarker('skill-a', skillAPath)
    const m2 = buildSkillMarker('ghost')
    const { client, getSessionStats } = makeClient({ commandsError: new Error('rpc closed') })
    const result = await injector.inject(client, `${m1} 正文 ${m2}`)
    expect(result.text).toBe(`${m1} 正文 ${m2}`)
    expect(result.notices).toEqual([{ reason: 'mapping_unavailable', skills: ['skill-a', 'ghost'] }])
    expect(getSessionStats).not.toHaveBeenCalled()
  })

  it('失效与降级共存：降级块只含可展开者，失效标记保留正文 + 双 notice', async () => {
    writeFileSync(skillAPath, '很'.repeat(1000))
    const valid = buildSkillMarker('skill-a', skillAPath)
    const invalid = buildSkillMarker('ghost')
    const { client } = makeClient({
      commands: [skillCmd('skill-a', skillAPath)],
      stats: { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } },
    })
    const result = await injector.inject(client, `前 ${valid} 中 ${invalid} 后`)
    // 失效标记原样保留在正文
    expect(result.text).toContain(invalid)
    expect(result.text).not.toContain('很'.repeat(1000))
    expect(result.text).toContain(`name="skill-a" location="${skillAPath}"`)
    expect(result.notices).toEqual([
      { reason: 'budget_exceeded', skills: ['skill-a'] },
      { reason: 'skill_missing', skills: ['ghost'] },
    ])
  })

  it('baseDir：sourceInfo.baseDir 不保证是 SKILL.md 所在目录，References 行仍用 dirname(path)', async () => {
    // PS-24 真实 pi 探针实证：pi 展开的 References baseDir = skill.baseDir = dirname(filePath)
    //（skills.js :236/:260）；而 get_commands 的 sourceInfo.baseDir 经 resource-loader.js
    // :514-518 extension 覆盖链（findSourceInfoForPath 命中时 createSourceInfo 直接采用
    // extension metadata.baseDir，可为 skill 提供方给的任意目录）与 :612 兜底
    //（getDefaultSourceInfoForPath 的 `<...>` 形态返回对象无 baseDir 字段）装载，不可消费。
    const marker = buildSkillMarker('skill-a', skillAPath)
    const scanRoot = join(tmpRoot, 'skills-root')
    const { client } = makeClient({
      commands: [{ name: 'skill:skill-a', source: 'skill', sourceInfo: { path: skillAPath, source: 'local', scope: 'user', baseDir: scanRoot } }],
      stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } },
    })
    const result = await injector.inject(client, marker)
    expect(result.text).toContain(`References are relative to ${skillADir}.`)
    expect(result.text).not.toContain(`References are relative to ${scanRoot}`)
  })

  it('无 frontmatter 闭合 ---：镜像 pi 行为原文保留（不剥），展开正文为全文 trim', async () => {
    writeFileSync(skillAPath, '---\nname: skill-a\n没有闭合行')
    const raw = '---\nname: skill-a\n没有闭合行'
    const marker = buildSkillMarker('skill-a', skillAPath)
    const { client } = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, marker)
    expect(result.text).toBe(expectedBlock('skill-a', skillAPath, skillADir, raw))
  })
})
