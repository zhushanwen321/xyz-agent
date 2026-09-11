/**
 * migrate-pi-layout-v2.mjs 单测（实施计划 u14a；设计 §6.11 六步 + V9⑥⑧⑨ + P-12 幂等三态）。
 *
 * fixture 全部落 mkdtempSync(join(tmpdir(),...)) 自建自删；注入 execPgrep/resolvePiBinary
 * 为确定性 fake（绝不真实跑 pgrep / which），脚本对真实数据目录（~/.xyz-agent、
 * ~/.xyz-agent-dev、~/.pi）零写入——只读统计除外（P-11 实测独立执行，见下）。
 *
 * P-11 实测登记（实施期门，§11.10；2026-09-10 只读统计，方法 = 逐文件读首行 64KB
 * 解析 header）：真实 ~/.xyz-agent/pi/sessions/*.jsonl 共 11 个，首行 header
 * type==='session' 且 cwd 非空 string 的覆盖率 = 100%（11/11；无 cwd 0、坏头 0、
 * 解析失败 0）。→ _migrated-no-cwd/ 在当前真实数据上预期占比 0%（该分支仅对
 * 坏头/无头文件触发，测试用构造 fixture 覆盖）。
 *
 * 场景对应：V9⑥ 幂等三态 / V9⑦ 分域并道全场景（X/Y/伴随字段/畸形两形态三向/
 * 独立凭据/偏好）/ V9⑧ 负向（进程命中列 PID、非 .xyz-agent* 拒绝、pi 无
 * agent|sessions 形态拒绝）/ V9①②③④ tmp 布局端到端 / V9⑨ 报告字段完整性。
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, renameSync, writeFileSync, copyFileSync } from 'node:fs'
import * as fsReal from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runMigration,
  encodeCwd,
  validateDataDirShape,
  detectRunningPiProcesses,
  listBackups,
  unionProviderFile,
  parseSessionHeader,
  mergeRecordTree,
  TRIPLET_SPECS,
  PROCESS_PATTERNS,
} from '../migrate-pi-layout-v2.mjs'

// ---------- fixture 工厂 ----------

const NO_PROC = {
  execPgrep: () => ({ status: 1, stdout: '' }),
  resolvePiBinary: () => '/opt/homebrew/bin/pi', // 命中 PROCESS_PATTERNS 的 pi 模式（自证通过）
}

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), 'migrate-pi-v2-fx-'))
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}
function w(dir, rel, content) {
  const p = join(dir, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
}
const j = (obj) => JSON.stringify(obj)
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

/**
 * 构造旧布局 <dataDir>/pi（prod 形态：agent/ + sessions/ + 顶层残片）。
 * opts: { agentFiles: {rel: jsonValue}, flatSessions: [{name, cwd, sidecars?, headerType?}],
 *         encSessions: [{enc, name, cwd}], fragments: {name: content}, rawSessions }
 */
function makeLegacyPi(dataDir, opts = {}) {
  const pi = join(dataDir, 'pi')
  for (const [rel, val] of Object.entries(opts.agentFiles ?? {})) w(pi, `agent/${rel}`, typeof val === 'string' ? val : j(val))
  for (const s of opts.flatSessions ?? []) {
    const header = s.headerType ? { type: s.headerType, cwd: s.cwd } : { type: 'session', cwd: s.cwd, id: s.name }
    w(pi, `sessions/${s.name}`, j(header) + '\n' + (s.body ?? '{"type":"user"}\n'))
    for (const sc of s.sidecars ?? []) w(pi, `sessions/${s.name}${sc}`, 'sidecar')
  }
  for (const s of opts.encSessions ?? []) {
    w(pi, `sessions/${s.enc}/${s.name}`, j({ type: 'session', cwd: s.cwd }) + '\n')
  }
  for (const [name, content] of Object.entries(opts.fragments ?? {})) w(pi, name, content)
  return pi
}

const TS = 1725900000000
const run = (dataDir, extra = {}) =>
  runMigration({ dataDir, now: () => TS, log: () => {}, ...NO_PROC, ...extra })

// ---------- encodeCwd（与 pi-paths.ts:122-124 同规则） ----------

describe('encodeCwd（复刻 pi-paths.ts 规则，步骤 3 分发依据）', () => {
  it('posix 路径：去首斜杠 + / \\ : → -', () => {
    expect(encodeCwd('/Users/x/proj')).toBe('--Users-x-proj--')
    expect(encodeCwd('/private/tmp')).toBe('--private-tmp--') // dev 实测 --private-tmp--/ 目录形态
  })
  it('win32 盘符路径与混合分隔符', () => {
    // 权威 = pi-paths.ts:122-124 实现规则（: 与 \ 各替换为一个 -）；头注释示例已与
    // 实现对齐（design-code-sync F4）——迁移分发须与 runtime 写侧同码
    expect(encodeCwd('C:\\Users\\x\\proj')).toBe('--C--Users-x-proj--')
    expect(encodeCwd('C:/Users/x')).toBe('--C--Users-x--')
  })
  it('已带尾斜杠/多层路径', () => {
    expect(encodeCwd('/a/b/')).toBe('--a-b---')
  })
})

// ---------- 步骤 0a：实参形态（V9⑧ 负向） ----------

describe('步骤 0a 实参形态校验', () => {
  it('非 .xyz-agent* basename 拒绝（防误传资源布局目录被 rename）', () => {
    const d = makeDataDir()
    try {
      const bad = join(d, 'resources-pi')
      const r = run(bad)
      expect(r.aborted).toEqual({ step: '0a', reason: expect.stringContaining('.xyz-agent*') })
    } finally {
      cleanup(d)
    }
  })
  it('pi/ 存在但既无 agent/ 也无 sessions/ → 拒绝（形态判据）', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      mkdirSync(join(dd, 'pi'), { recursive: true })
      w(dd, 'pi/auth.json', '{}')
      const r = run(dd)
      expect(r.aborted.step).toBe('0a')
      expect(r.aborted.reason).toContain('既无 agent/ 也无 sessions/')
    } finally {
      cleanup(d)
    }
  })
  it('pi/ 含 agent 或任一子目录即通过；pi 不存在（续传形态）仅 basename 校验', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      mkdirSync(join(dd, 'pi', 'sessions'), { recursive: true })
      expect(validateDataDirShape(dd, { existsSync })).toEqual({ ok: true })
      const dd2 = join(d, '.xyz-agent-dev')
      expect(validateDataDirShape(dd2, { existsSync })).toEqual({ ok: true })
    } finally {
      cleanup(d)
    }
  })
})

// ---------- 步骤 0b：进程检测（V9⑧） ----------

describe('步骤 0b 进程检测（pgrep 模式清单 + pi 二进制自证）', () => {
  it('pgrep 命中 → 中止并列 PID；自证失败（pi 二进制不被 pi 模式命中）→ 中止', () => {
    const hit = detectRunningPiProcesses({
      execPgrep: (ere) => (ere === 'relay\\.mjs' ? { status: 0, stdout: '4321\n' } : { status: 1, stdout: '' }),
      resolvePiBinary: () => '/usr/local/bin/pi',
    })
    expect(hit.ok).toBe(false)
    expect(hit.pids).toEqual(['4321'])
    expect(hit.reason).toContain('4321')

    const badSelf = detectRunningPiProcesses({
      execPgrep: () => ({ status: 1, stdout: '' }),
      resolvePiBinary: () => '/some/weird/pibin', // 不被 /pi(\.js)?($| ) 命中
    })
    expect(badSelf.ok).toBe(false)
    expect(badSelf.reason).toContain('自证失败')
    expect(badSelf.reason).toContain('PROCESS_PATTERNS')
  })
  it('自证通过 + 无命中 → 放行；本机无 pi 二进制 → 放行并注明', () => {
    expect(detectRunningPiProcesses(NO_PROC).ok).toBe(true)
    const none = detectRunningPiProcesses({ execPgrep: () => ({ status: 1, stdout: '' }), resolvePiBinary: () => null })
    expect(none.ok).toBe(true)
    expect(none.selfCheck.checked).toBe(false)
  })
  it('pi 模式清单形态锚点：…/pi、…/pi --mode rpc、…/pi.js 命中；pip / pibin 不命中', () => {
    const re = new RegExp(PROCESS_PATTERNS[0].ere)
    expect(re.test('/opt/homebrew/bin/pi')).toBe(true)
    expect(re.test('node /x/bin/pi --mode rpc')).toBe(true)
    expect(re.test('node /x/pi-mono/cli.js')).toBe(false)
    expect(re.test('/opt/homebrew/bin/pip')).toBe(false)
    expect(re.test('/opt/homebrew/bin/pibin')).toBe(false)
  })
  it('runMigration 集成：注入 pgrep 命中 → aborted 0b 含 PID，且 pi/ 不被 rename（数据零动作）', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      makeLegacyPi(dd, { agentFiles: { 'settings.json': {} }, flatSessions: [{ name: 'a.jsonl', cwd: '/w' }] })
      const r = run(dd, {
        execPgrep: () => ({ status: 0, stdout: '111\n222\n' }),
        resolvePiBinary: () => '/opt/homebrew/bin/pi',
      })
      expect(r.aborted.step).toBe('0b')
      expect(r.aborted.pids).toEqual(['111', '222'])
      expect(existsSync(join(dd, 'pi'))).toBe(true) // 中止于前置，未动数据
      expect(existsSync(join(dd, 'pi.backup-v2-' + TS))).toBe(false)
    } finally {
      cleanup(d)
    }
  })
})

// ---------- 步骤 0c：三判 ----------

describe('步骤 0c 三判（首迁 / 无需迁移 / 续传）', () => {
  it('pi 存在 → migrate：rename 为 pi.backup-v2-<ts>（步骤 1），pi/ 消失', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      makeLegacyPi(dd, { agentFiles: { 'settings.json': {} } })
      const r = run(dd)
      expect(r.mode).toBe('migrate')
      expect(r.backupPath).toBe(join(dd, `pi.backup-v2-${TS}`))
      expect(existsSync(join(dd, 'pi'))).toBe(false)
      expect(existsSync(r.backupPath)).toBe(true)
    } finally {
      cleanup(d)
    }
  })
  it('无 pi 无备份 → nothing（全新安装形态，打印无需迁移）', () => {
    const d = makeDataDir()
    try {
      const r = run(join(d, '.xyz-agent'))
      expect(r.mode).toBe('nothing')
      expect(r.aborted).toBeNull()
    } finally {
      cleanup(d)
    }
  })
  it('无 pi 有备份 → resume：取备份名内嵌 ts 最大的一份；多份在 notice 注明', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      mkdirSync(join(dd, 'pi.backup-v2-100'), { recursive: true })
      mkdirSync(join(dd, 'pi.backup-v2-300'), { recursive: true })
      mkdirSync(join(dd, 'pi.backup-v2-200'), { recursive: true })
      w(dd, 'pi.backup-v2-300/agent/settings.json', j({ theme: 'dark' }))
      const r = run(dd)
      expect(r.mode).toBe('resume')
      expect(r.backupPath).toBe(join(dd, 'pi.backup-v2-300'))
      expect(r.notices.some((n) => n.includes('3 份备份'))).toBe(true)
      expect(listBackups(dd, { existsSync, readdirSync }).map((b) => b.name)).toEqual([
        'pi.backup-v2-300',
        'pi.backup-v2-200',
        'pi.backup-v2-100',
      ])
    } finally {
      cleanup(d)
    }
  })
})

// ---------- 先迁后升端到端（V9①②③④ + ⑤ 报告字段） ----------

describe('先迁后升端到端（tmp 布局副本，V9①②③④）', () => {
  it('agent 上移 + header.cwd 分发 + sidecar 随行 + 残片留备份 + sessionDir 清除 + 报告字段完整', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      makeLegacyPi(dd, {
        agentFiles: {
          'models.json': { providers: { p1: { name: 'P1' } } },
          'auth.json': { p1: { key: 'k1' } },
          'settings.json': { theme: 'dark', sessionDir: '/some/override' },
          'config/providers.json': { version: 1, providers: { p1: { quota: 1 } }, scopedModels: ['a'] },
          'subagents/--private-tmp--/sessions/sub-1.jsonl': '{"type":"session"}\n',
          'workflow-state/wf-1.json': { stage: 1 },
        },
        flatSessions: [
          { name: 'aaaa1111-1.jsonl', cwd: '/Users/x/proj', sidecars: ['.handoff.json', '.model.json'] },
          { name: 'bbbb2222-2.jsonl', headerType: 'summary' }, // 坏头（非 session）→ 无 cwd
          { name: 'cccc3333-3.jsonl', cwd: '' }, // session 头但 cwd 空串 → 无 cwd
        ],
        encSessions: [{ enc: '--private-tmp--', name: 'dddd4444-4.jsonl', cwd: '/private/tmp' }],
        fragments: { 'auth.json': '{}', 'models-store.json': '{}' }, // dev 实测 2B 空壳残片形态
      })
      const r = run(dd)
      expect(r.aborted).toBeNull()

      // ① pi/agent/* 全部出现在 <dataDir>/agent/
      const agentNew = join(dd, 'agent')
      expect(readJson(join(agentNew, 'models.json'))).toEqual({ providers: { p1: { name: 'P1' } } })
      expect(readJson(join(agentNew, 'auth.json'))).toEqual({ p1: { key: 'k1' } })
      expect(existsSync(join(agentNew, 'subagents', '--private-tmp--', 'sessions', 'sub-1.jsonl'))).toBe(true)
      expect(readJson(join(agentNew, 'workflow-state', 'wf-1.json'))).toEqual({ stage: 1 })
      expect(existsSync(join(dd, 'pi'))).toBe(false)

      // ② 平铺主 session 按 header.cwd 落 encodeCwd 子目录；无/坏头入 _migrated-no-cwd/
      const sess = join(agentNew, 'sessions')
      expect(existsSync(join(sess, '--Users-x-proj--', 'aaaa1111-1.jsonl'))).toBe(true)
      expect(existsSync(join(sess, '--private-tmp--', 'dddd4444-4.jsonl'))).toBe(true)
      const noCwd = join(sess, '_migrated-no-cwd')
      expect(readdirSync(noCwd).sort()).toEqual(['bbbb2222-2.jsonl', 'cccc3333-3.jsonl'])

      // ③ sidecar 前缀随行（含 .handoff.json——非白名单后缀）
      const movedDir = join(sess, '--Users-x-proj--')
      expect(readdirSync(movedDir).sort()).toEqual(['aaaa1111-1.jsonl', 'aaaa1111-1.jsonl.handoff.json', 'aaaa1111-1.jsonl.model.json'])

      // ④ pi.backup-v2-* 存在且含未迁移残留（顶层残片）
      expect(r.backupPath).toBe(join(dd, `pi.backup-v2-${TS}`))
      expect(r.fragments.sort()).toEqual(['auth.json', 'models-store.json'])
      expect(existsSync(join(r.backupPath, 'auth.json'))).toBe(true)

      // 步骤 5：sessionDir 覆盖位清除，其余字段保留
      const settings = readJson(join(agentNew, 'settings.json'))
      expect(settings).toEqual({ theme: 'dark' })
      expect(r.sessionDirCleared).toBe(true)

      // 计数
      expect(r.counts.sessionDistributed).toBe(2)
      expect(r.counts.sessionNoCwd).toBe(2)
      expect(r.counts.sidecarsMoved).toBe(2)
      // agent/ 不存在 → 2a 整体 rename（subagents/workflow-state 随整体上移，不走逐文件计数）
      expect(r.counts.recordMoved).toBe(0)
      expect(r.counts.filesMoved).toBe(1) // 仅 agent/ 目录本身
      expect(r.conflicts).toEqual([])

      // ⑤ 报告字段完整性：备份体积 / 回滚命令 / 旧备份清单 / 进程模式清单
      expect(r.backupStats.files).toBeGreaterThan(0)
      expect(r.backupStats.bytes).toBeGreaterThan(0)
      expect(r.rollbackCommand).toContain(`rm -rf "${agentNew}"`)
      expect(r.rollbackCommand).toContain(`pi.backup-v2-${TS}`)
      expect(r.oldBackups).toEqual([])
      expect(r.processPatterns).toEqual(PROCESS_PATTERNS.map((p) => p.label))
      expect(r.selfCheck).toEqual({ checked: true, ok: true, piBinary: '/opt/homebrew/bin/pi' })
    } finally {
      cleanup(d)
    }
  })
  it('报告字段完整性：既有旧备份时 oldBackups 列出各份规模（文件数/字节数）', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      mkdirSync(join(dd, 'pi.backup-v2-111'), { recursive: true })
      w(dd, 'pi.backup-v2-111/agent/old-models.json', j({ providers: {} }))
      w(dd, 'pi.backup-v2-111/sessions/leftover.jsonl', '{"type":"session"}\n') // 旧残部：不被任何分支消费
      makeLegacyPi(dd, { agentFiles: { 'settings.json': {} } })
      const r = run(dd)
      expect(r.mode).toBe('migrate')
      expect(r.oldBackups).toEqual([{ name: 'pi.backup-v2-111', files: 2, bytes: expect.any(Number) }])
      expect(r.oldBackups[0].bytes).toBeGreaterThan(0)
      expect(r.backupPath).toBe(join(dd, `pi.backup-v2-${TS}`)) // 本次备份不在旧备份清单内
      expect(r.notices.some((n) => n.includes('1 份既有备份'))).toBe(true)
    } finally {
      cleanup(d)
    }
  })
  it('步骤 5 清除日志含 sessionDir 原值（delete 前先存值——时序回归锁）', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      makeLegacyPi(dd, { agentFiles: { 'settings.json': { theme: 'dark', sessionDir: '/some/override' } } })
      const logs = []
      const r = run(dd, { log: (m) => logs.push(m) })
      expect(r.sessionDirCleared).toBe(true)
      expect(logs.some((m) => m.includes('sessionDir') && m.includes('/some/override'))).toBe(true)
    } finally {
      cleanup(d)
    }
  })
  it('旧旧布局 <dataDir>/sessions 兼并（步骤 4，同法分发）', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      makeLegacyPi(dd, { agentFiles: { 'settings.json': {} } })
      w(dd, 'sessions/eeee5555-5.jsonl', j({ type: 'session', cwd: '/old/layout' }) + '\n')
      const r = run(dd)
      expect(existsSync(join(dd, 'agent', 'sessions', '--old-layout--', 'eeee5555-5.jsonl'))).toBe(true)
      expect(r.counts.sessionDistributed).toBe(1)
    } finally {
      cleanup(d)
    }
  })
})

// ---------- 分域并道（V9⑦：场景 X/Y、伴随字段、畸形两形态三向、独立凭据、偏好） ----------

/** 三件套并道 fixture：old 侧（备份 agent/）+ new 侧（dataDir/agent/，先升后迁窗口期形态） */
function makeConcurrentTriplet(d, { authOld, authNew, modelsOld, modelsNew, provOld, provNew, extraOld = {}, extraNew = {} }) {
  const dd = join(d, '.xyz-agent')
  const oldAgent = { 'auth.json': authOld, 'models.json': modelsOld, 'config/providers.json': provOld, ...extraOld }
  const newAgent = { 'auth.json': authNew, 'models.json': modelsNew, 'config/providers.json': provNew, ...extraNew }
  for (const [rel, val] of Object.entries(oldAgent)) w(join(dd, 'pi'), `agent/${rel}`, typeof val === 'string' ? val : j(val))
  for (const [rel, val] of Object.entries(newAgent)) w(dd, `agent/${rel}`, typeof val === 'string' ? val : j(val))
  return dd
}

describe('步骤 2b 分域并道：provider 三件套 keyed union（域锚点 auth 顶层 / models 与 providers 在 .providers）', () => {
  it('场景 X：既有 provider 换 key → 三个文件同 key 均取新侧，逐 key 冲突进清单', () => {
    const d = makeDataDir()
    try {
      const dd = makeConcurrentTriplet(d, {
        authOld: { p1: { key: 'old-key' } },
        authNew: { p1: { key: 'new-key' } },
        modelsOld: { providers: { p1: { name: 'Old', baseUrl: 'https://old' } } },
        modelsNew: { providers: { p1: { name: 'New', baseUrl: 'https://new' } } },
        provOld: { version: 1, providers: { p1: { quota: 1 } }, scopedModels: ['a'] },
        provNew: { version: 1, providers: { p1: { quota: 9 } }, scopedModels: ['b'] },
      })
      const r = run(dd)
      expect(r.aborted).toBeNull()
      expect(readJson(join(dd, 'agent', 'auth.json'))).toEqual({ p1: { key: 'new-key' } })
      expect(readJson(join(dd, 'agent', 'models.json')).providers.p1).toEqual({ name: 'New', baseUrl: 'https://new' })
      const prov = readJson(join(dd, 'agent', 'config', 'providers.json'))
      expect(prov.providers.p1).toEqual({ quota: 9 })
      expect(prov.scopedModels).toEqual(['b'])
      expect(prov.version).toBe(1)
      // 三 key 冲突 + scopedModels 伴随冲突（union 结果与主位现状深等 → 无写动作，但差异必须进清单）
      const keyConflicts = r.conflicts.filter((c) => c.type === 'key')
      expect(keyConflicts.map((c) => c.file).sort()).toEqual(['auth.json', 'config/providers.json', 'models.json'])
      expect(keyConflicts.every((c) => c.direction === 'new')).toBe(true)
      expect(r.conflicts.filter((c) => c.type === 'aside')).toEqual([
        { file: 'config/providers.json', type: 'aside', key: 'scopedModels', direction: 'new', detail: expect.stringContaining('取新侧') },
      ])
      expect(r.counts.unionWrites).toBe(0)
      expect(r.counts.unionSkipped).toBe(3)
      // 三件套双侧并道路径的重跑幂等：旧侧仍留备份（union 不搬旧侧）→ 重跑无写动作、主位内容不变
      const r2 = run(dd)
      expect(r2.mode).toBe('resume')
      expect(r2.counts.unionWrites).toBe(0)
      expect(r2.counts.unionSkipped).toBe(3)
      expect(r2.counts.filesMoved).toBe(0)
      expect(r2.counts.asidesCreated).toBe(0)
      expect(readJson(join(dd, 'agent', 'auth.json'))).toEqual({ p1: { key: 'new-key' } })
    } finally {
      cleanup(d)
    }
  })
  it('场景 Y：窗口期新增自定义 provider p2 → 迁移后定义与凭据在三件中同时在位（交叉失配被 union 消除）', () => {
    const d = makeDataDir()
    try {
      const dd = makeConcurrentTriplet(d, {
        authOld: { p1: { key: 'k1' } },
        authNew: { p1: { key: 'k1' }, p2: { key: 'k2' } },
        modelsOld: { providers: { p1: { name: 'P1' } } },
        modelsNew: { providers: { p1: { name: 'P1' }, p2: { name: 'P2' } } },
        provOld: { version: 1, providers: { p1: { quota: 1 } }, scopedModels: [] },
        provNew: { version: 1, providers: { p1: { quota: 1 }, p2: { quota: 2 } }, scopedModels: [] },
      })
      const r = run(dd)
      const auth = readJson(join(dd, 'agent', 'auth.json'))
      const models = readJson(join(dd, 'agent', 'models.json'))
      const prov = readJson(join(dd, 'agent', 'config', 'providers.json'))
      expect(auth.p2).toEqual({ key: 'k2' })
      expect(models.providers.p2).toEqual({ name: 'P2' })
      expect(prov.providers.p2).toEqual({ quota: 2 })
      expect(Object.keys(models.providers).sort()).toEqual(['p1', 'p2'])
      expect(r.conflicts).toEqual([]) // p1 双侧同值非冲突
      // union 结果与主位现状深等 → 三件全 skip（重跑幂等的判定基础）
      expect(r.counts.unionWrites).toBe(0)
      expect(r.counts.unionSkipped).toBe(3)
    } finally {
      cleanup(d)
    }
  })
  it('伴随字段取新侧进清单：version 与 scopedModels 双侧不同 → 均取新侧', () => {
    const d = makeDataDir()
    try {
      const dd = makeConcurrentTriplet(d, {
        authOld: { p1: { key: 'k' } },
        authNew: { p1: { key: 'k' } },
        modelsOld: { providers: { p1: { name: 'P1' } }, legacyTop: 'old-value' },
        modelsNew: { providers: { p1: { name: 'P1' } }, legacyTop: 'new-value' },
        provOld: { version: 1, providers: { p1: { quota: 1 } }, scopedModels: ['stale'] },
        provNew: { version: 2, providers: { p1: { quota: 1 } }, scopedModels: ['fresh'] },
      })
      const r = run(dd)
      const prov = readJson(join(dd, 'agent', 'config', 'providers.json'))
      expect(prov.version).toBe(2)
      expect(prov.scopedModels).toEqual(['fresh'])
      // models.json 顶层未来新增键同样伴随取新；旧侧独有伴随键（legacyTop 之外无）被丢弃
      expect(readJson(join(dd, 'agent', 'models.json')).legacyTop).toBe('new-value')
      const asides = r.conflicts.filter((c) => c.type === 'aside')
      expect(asides.map((c) => `${c.file}:${c.key}`).sort()).toEqual([
        'config/providers.json:scopedModels',
        'config/providers.json:version',
        'models.json:legacyTop',
      ])
      expect(r.counts.unionWrites).toBe(0) // 结果与主位现状深等（伴随本来就取新侧）
      expect(r.counts.unionSkipped).toBe(3)
    } finally {
      cleanup(d)
    }
  })
  it('畸形形态 1（keyed 域子对象畸形）三向：旧坏→新赢 / 新坏→旧赢+新避让 / 双坏→不动报人工', () => {
    // 旧坏（auth.json 顶层数组）→ 新赢，旧侧留备份
    const d1 = makeDataDir()
    try {
      const dd = makeConcurrentTriplet(d1, {
        authOld: '[{"broken": true}]',
        authNew: { p1: { key: 'new' } },
        modelsOld: { providers: { p1: {} } },
        modelsNew: { providers: { p1: {} } },
        provOld: { version: 1, providers: {}, scopedModels: [] },
        provNew: { version: 1, providers: {}, scopedModels: [] },
      })
      const r = run(dd)
      expect(readJson(join(dd, 'agent', 'auth.json'))).toEqual({ p1: { key: 'new' } })
      expect(r.conflicts.some((c) => c.file === 'auth.json' && c.direction === 'take-new')).toBe(true)
      expect(r.manualIntervention).toEqual([])
    } finally {
      cleanup(d1)
    }
    // 新坏（models.json .providers 是数组）→ 旧赢 + 畸形新侧避让 *.new-v2-aside
    const d2 = makeDataDir()
    try {
      const dd = makeConcurrentTriplet(d2, {
        authOld: { p1: { key: 'k' } },
        authNew: { p1: { key: 'k' } },
        modelsOld: { providers: { p1: { name: 'OldDef' } } },
        modelsNew: { providers: ['broken'] },
        provOld: { version: 1, providers: {}, scopedModels: [] },
        provNew: { version: 1, providers: {}, scopedModels: [] },
      })
      const r = run(dd)
      expect(readJson(join(dd, 'agent', 'models.json')).providers).toEqual({ p1: { name: 'OldDef' } })
      expect(readFileSync(join(dd, 'agent', 'models.json.new-v2-aside'), 'utf8')).toContain('broken')
      expect(r.counts.asidesCreated).toBe(1)
      expect(r.conflicts.some((c) => c.file === 'models.json' && c.direction === 'take-old')).toBe(true)
    } finally {
      cleanup(d2)
    }
    // 双坏（auth 顶层数组 + models providers 数组）→ 不动 + 报人工（不产坏数据主位）
    const d3 = makeDataDir()
    try {
      const dd = makeConcurrentTriplet(d3, {
        authOld: '[1]',
        authNew: '[2]',
        modelsOld: { providers: { p1: {} } },
        modelsNew: { providers: { p1: {} } },
        provOld: { version: 1, providers: {}, scopedModels: [] },
        provNew: { version: 1, providers: {}, scopedModels: [] },
      })
      const r = run(dd)
      expect(readFileSync(join(dd, 'agent', 'auth.json'), 'utf8')).toContain('2') // 主位保持新侧原文件
      expect(r.manualIntervention.length).toBe(1)
      expect(r.manualIntervention[0]).toContain('auth.json')
      expect(r.manualIntervention[0]).toContain('双侧均畸形')
    } finally {
      cleanup(d3)
    }
  })
  it('畸形形态 2（伴随字段畸形）三向：version 字符串→旧侧坏新赢；scopedModels 对象→新侧坏旧赢；双坏→不动', () => {
    const d1 = makeDataDir()
    try {
      const dd = makeConcurrentTriplet(d1, {
        authOld: { p1: { key: 'k' } },
        authNew: { p1: { key: 'k' } },
        modelsOld: { providers: { p1: {} } },
        modelsNew: { providers: { p1: {} } },
        provOld: { version: '1', providers: { p1: { old: true } }, scopedModels: [] }, // 旧侧伴随畸形
        provNew: { version: 1, providers: { p1: { new: true } }, scopedModels: [] },
      })
      const r = run(dd)
      expect(readJson(join(dd, 'agent', 'config', 'providers.json')).providers.p1).toEqual({ new: true })
      expect(r.conflicts.some((c) => c.file === 'config/providers.json' && c.direction === 'take-new')).toBe(true)
      expect(r.conflicts.find((c) => c.file === 'config/providers.json' && c.direction === 'take-new').detail).toContain('version 非预期形态')
    } finally {
      cleanup(d1)
    }
    const d2 = makeDataDir()
    try {
      const dd = makeConcurrentTriplet(d2, {
        authOld: { p1: { key: 'k' } },
        authNew: { p1: { key: 'k' } },
        modelsOld: { providers: { p1: {} } },
        modelsNew: { providers: { p1: {} } },
        provOld: { version: 1, providers: { p1: { old: true } }, scopedModels: [] },
        provNew: { version: 1, providers: { p1: { new: true } }, scopedModels: { broken: true } }, // 新侧伴随畸形
      })
      const r = run(dd)
      const prov = readJson(join(dd, 'agent', 'config', 'providers.json'))
      expect(prov.providers.p1).toEqual({ old: true })
      expect(prov.scopedModels).toEqual([])
      expect(existsSync(join(dd, 'agent', 'config', 'providers.json.new-v2-aside'))).toBe(true)
      expect(r.conflicts.some((c) => c.file === 'config/providers.json' && c.direction === 'take-old')).toBe(true)
    } finally {
      cleanup(d2)
    }
    const d3 = makeDataDir()
    try {
      const dd = makeConcurrentTriplet(d3, {
        authOld: { p1: { key: 'k' } },
        authNew: { p1: { key: 'k' } },
        modelsOld: { providers: { p1: {} } },
        modelsNew: { providers: { p1: {} } },
        provOld: { version: 'x', providers: {}, scopedModels: [] },
        provNew: { version: true, providers: {}, scopedModels: 3 },
      })
      const r = run(dd)
      expect(r.manualIntervention.length).toBe(1)
      expect(r.manualIntervention[0]).toContain('config/providers.json')
    } finally {
      cleanup(d3)
    }
  })
  it('单侧三件套：仅旧侧有 → 整体搬入；仅新侧有 → 主位不动', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      w(join(dd, 'pi'), 'agent/auth.json', j({ p1: { key: 'only-old' } }))
      w(dd, 'agent/models.json', j({ providers: { p9: { name: 'OnlyNew' } } }))
      const r = run(dd)
      expect(readJson(join(dd, 'agent', 'auth.json'))).toEqual({ p1: { key: 'only-old' } })
      expect(readJson(join(dd, 'agent', 'models.json')).providers.p9).toEqual({ name: 'OnlyNew' })
      expect(r.counts.unionWrites).toBe(0)
    } finally {
      cleanup(d)
    }
  })
})

describe('步骤 2b 分域并道：独立凭据 / 偏好 / 记录型 / 资源目录', () => {
  it('独立凭据 token*：双侧都有 → 主位留新侧 + 旧侧避让 *.old-v2-aside；双侧同值 → 无动作', () => {
    const d = makeDataDir()
    try {
      const dd = makeConcurrentTriplet(d, {
        authOld: { p1: { key: 'k' } },
        authNew: { p1: { key: 'k' } },
        modelsOld: { providers: { p1: {} } },
        modelsNew: { providers: { p1: {} } },
        provOld: { version: 1, providers: {}, scopedModels: [] },
        provNew: { version: 1, providers: {}, scopedModels: [] },
        extraOld: { 'token-legacy.json': { token: 'old-token' }, 'token-same.json': { token: 'same' } },
        extraNew: { 'token-legacy.json': { token: 'new-token' }, 'token-same.json': { token: 'same' } },
      })
      const r = run(dd)
      expect(readJson(join(dd, 'agent', 'token-legacy.json'))).toEqual({ token: 'new-token' }) // 新赢
      expect(readJson(join(dd, 'agent', 'token-legacy.json.old-v2-aside'))).toEqual({ token: 'old-token' }) // 旧避让
      expect(existsSync(join(dd, 'agent', 'token-same.json.old-v2-aside'))).toBe(false) // 同值非冲突
      expect(r.conflicts.some((c) => c.file === 'token-legacy.json' && c.direction === 'new-wins-old-aside')).toBe(true)
      expect(r.counts.asidesCreated).toBe(1)
    } finally {
      cleanup(d)
    }
  })
  it('偏好类单文件 settings.json：双侧都有 → 旧赢 + 新侧避让 *.new-v2-aside（数月定制损失面 > 窗口期增量）', () => {
    const d = makeDataDir()
    try {
      const dd = makeConcurrentTriplet(d, {
        authOld: { p1: { key: 'k' } },
        authNew: { p1: { key: 'k' } },
        modelsOld: { providers: { p1: {} } },
        modelsNew: { providers: { p1: {} } },
        provOld: { version: 1, providers: {}, scopedModels: [] },
        provNew: { version: 1, providers: {}, scopedModels: [] },
        extraOld: { 'settings.json': { theme: 'months-of-customization' } },
        extraNew: { 'settings.json': { theme: 'window-increment' } },
      })
      const r = run(dd)
      expect(readJson(join(dd, 'agent', 'settings.json'))).toEqual({ theme: 'months-of-customization' })
      expect(readJson(join(dd, 'agent', 'settings.json.new-v2-aside'))).toEqual({ theme: 'window-increment' })
      expect(r.conflicts.some((c) => c.file === 'settings.json' && c.direction === 'old-wins-new-aside')).toBe(true)
    } finally {
      cleanup(d)
    }
  })
  it('记录型子树文件级并入：encodeCwd 同名子目录内部合并 + 同名文件跳过计数；主 session 平铺层并入不丢', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      // old 侧：subagents/<enc>/sessions/{a,b}.jsonl；new 侧（窗口期）：同 <enc>/sessions/{b,c}.jsonl + workflow-state/n.json
      w(join(dd, 'pi'), 'agent/subagents/--w--/sessions/a.jsonl', '{"type":"session"}\n')
      w(join(dd, 'pi'), 'agent/subagents/--w--/sessions/dup.jsonl', '{"from":"old"}\n')
      w(join(dd, 'pi'), 'agent/workflow-state/wf-old.json', j({ from: 'old' }))
      w(dd, 'agent/subagents/--w--/sessions/dup.jsonl', '{"from":"new"}\n')
      w(dd, 'agent/subagents/--w--/sessions/c.jsonl', '{"type":"session"}\n')
      w(dd, 'agent/workflow-state/wf-new.json', j({ from: 'new' }))
      const r = run(dd)
      const sub = join(dd, 'agent', 'subagents', '--w--', 'sessions')
      expect(readdirSync(sub).sort()).toEqual(['a.jsonl', 'c.jsonl', 'dup.jsonl']) // 内部合并、零丢失
      expect(readFileSync(join(sub, 'dup.jsonl'), 'utf8')).toContain('"new"') // 同名跳过：主位（新）保留
      expect(readJson(join(dd, 'agent', 'workflow-state', 'wf-old.json'))).toEqual({ from: 'old' })
      expect(r.counts.recordMoved).toBe(2)
      expect(r.counts.recordSkipped).toBe(1)
    } finally {
      cleanup(d)
    }
  })
  it('资源型目录 npm/ extensions/ tmp/：目标不存在整体搬；目标存在即跳过（双侧皆为生成物）', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      w(join(dd, 'pi'), 'agent/npm/@x/pkg-a/index.js', 'old')
      w(join(dd, 'pi'), 'agent/extensions/old-ext/dist.js', 'old')
      w(join(dd, 'pi'), 'agent/tmp/pending.json', '{}')
      w(dd, 'agent/settings.json', j({})) // 预建 new 侧 agent/ → 触发 2b 分域并道
      const r = run(dd)
      expect(existsSync(join(dd, 'agent', 'npm', '@x', 'pkg-a', 'index.js'))).toBe(true) // 目标不存在 → 整体搬
      expect(existsSync(join(dd, 'agent', 'extensions', 'old-ext', 'dist.js'))).toBe(true)
      expect(existsSync(join(dd, 'agent', 'tmp', 'pending.json'))).toBe(true)
      expect(r.counts.resourcesMoved).toBe(3)
      expect(r.counts.resourcesSkipped).toBe(0)
    } finally {
      cleanup(d)
    }
    const d2 = makeDataDir()
    try {
      const dd2 = join(d2, '.xyz-agent')
      w(join(dd2, 'pi'), 'agent/npm/@x/pkg-a/index.js', 'old')
      w(dd2, 'agent/npm/@x/pkg-b/index.js', 'new') // 目标 npm/ 已存在 → 整目录跳过（pkg-a 不并入）
      const r = run(dd2)
      expect(existsSync(join(dd2, 'agent', 'npm', '@x', 'pkg-a', 'index.js'))).toBe(false)
      expect(existsSync(join(dd2, 'agent', 'npm', '@x', 'pkg-b', 'index.js'))).toBe(true) // 新侧生成物不动
      expect(r.counts.resourcesSkipped).toBe(1)
    } finally {
      cleanup(d2)
    }
  })
})

// ---------- 幂等三态（V9⑥ / P-12） ----------

describe('幂等三态（V9⑥）', () => {
  const SEED = {
    agentFiles: {
      'models.json': { providers: { p1: { name: 'P1' } } },
      'auth.json': { p1: { key: 'k1' } },
      'settings.json': { theme: 'dark' },
      'config/providers.json': { version: 1, providers: { p1: { quota: 1 } }, scopedModels: [] },
      'subagents/--w--/s1.jsonl': '{"type":"session"}\n',
    },
    flatSessions: [{ name: 'm1.jsonl', cwd: '/w', sidecars: ['.handoff.json'] }],
  }
  it('完整成功后重跑（resume 模式重入）→ 全跳过：动作计数全 0、冲突 0、内容零漂移', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      makeLegacyPi(dd, SEED)
      const r1 = run(dd)
      expect(r1.mode).toBe('migrate')
      const snapshot = () => readdirSync(join(dd, 'agent', 'sessions'), { withFileTypes: true }).map((e) => e.name).sort()
      const snap1 = snapshot()

      const r2 = run(dd)
      expect(r2.mode).toBe('resume')
      expect(r2.aborted).toBeNull()
      expect(r2.backupPath).toBe(r1.backupPath)
      expect(r2.counts.sessionDistributed).toBe(0)
      expect(r2.counts.sessionSkipped).toBe(0)
      expect(r2.counts.sidecarsMoved).toBe(0)
      expect(r2.counts.recordMoved).toBe(0)
      expect(r2.counts.recordSkipped).toBe(0)
      expect(r2.counts.filesMoved).toBe(0)
      expect(r2.counts.unionWrites).toBe(0)
      expect(r2.counts.unionSkipped).toBe(0) // 2a 整体 rename 后 backup/agent 已空：union 无双侧输入，零动作
      expect(r2.counts.asidesCreated).toBe(0)
      expect(r2.conflicts).toEqual([])
      expect(snapshot()).toEqual(snap1) // 目录形态零漂移
    } finally {
      cleanup(d)
    }
  })
  it('步骤 1 后中断 → 重跑进续传完成迁移，已搬文件零重复（备份即暂存）', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      makeLegacyPi(dd, SEED)
      // 模拟中断态：人工完成步骤 1（rename pi → 备份）后进程被杀，步骤 2-6 未跑
      const backupPath = join(dd, `pi.backup-v2-${TS - 1000}`)
      renameSync(join(dd, 'pi'), backupPath)

      const r = run(dd)
      expect(r.mode).toBe('resume')
      expect(r.backupPath).toBe(backupPath)
      expect(existsSync(join(dd, 'agent', 'models.json'))).toBe(true)
      expect(existsSync(join(dd, 'agent', 'sessions', '--w--', 'm1.jsonl'))).toBe(true)
      // 零重复：m1.jsonl + sidecar 随行恰各一份
      expect(readdirSync(join(dd, 'agent', 'sessions', '--w--')).sort()).toEqual([
        'm1.jsonl',
        'm1.jsonl.handoff.json',
      ])
      expect(r.counts.sessionDistributed).toBe(1)
      // agent 整体 rename 后（2a），subagents 记录不再走 record 计数
      expect(r.counts.filesMoved).toBe(1)
      // 中断前没跑步骤 5：续传必须补做 sessionDir 清除
      expect(r.sessionDirCleared).toBe(false) // SEED 无 sessionDir 字段：清除动作为零、非失败
      // 步骤 3 后备份 sessions 层数据已搬空（脚本不夹带清理：目录骨架留备份）
      const leftover = existsSync(join(backupPath, 'sessions'))
        ? readdirSync(join(backupPath, 'sessions'), { withFileTypes: true })
        : []
      expect(leftover.filter((e) => !e.isDirectory())).toEqual([])
    } finally {
      cleanup(d)
    }
  })
  it('中断注入：主文件已在位 + sidecar 未搬 → 重跑补搬 sidecar（skip 不吞随行，F3）', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      // 局部 seed：源里 .handoff.json + .model.json 两个 sidecar（.model.json 另在目标位
      // 预置成双侧并存形态），同用例覆盖 sidecar「目标缺失 → 补搬」与「目标已在 → skip」两分支
      makeLegacyPi(dd, {
        ...SEED,
        flatSessions: [{ name: 'm1.jsonl', cwd: '/w', sidecars: ['.handoff.json', '.model.json'] }],
      })
      // 模拟上次迁移中断态：步骤 1 已 rename（备份在位），主文件已落目标位而 sidecar 未搬。
      // 源侧两者均留存（同 id 在源与目标并存 = skip 分支的真实触发形态：先升后迁窗口写入 /
      // 双源同名兼并 / 续传残部同 id 重复）。
      const backupPath = join(dd, `pi.backup-v2-${TS - 1000}`)
      renameSync(join(dd, 'pi'), backupPath)
      mkdirSync(join(dd, 'agent', 'sessions', '--w--'), { recursive: true })
      copyFileSync(
        join(backupPath, 'sessions', 'm1.jsonl'),
        join(dd, 'agent', 'sessions', '--w--', 'm1.jsonl'),
      )
      // 目标位预置 .model.json（与源并存）
      w(dd, 'agent/sessions/--w--/m1.jsonl.model.json', 'target-already-here')

      const r = run(dd)
      expect(r.mode).toBe('resume')
      expect(r.aborted).toBeNull()
      // 主文件目标已在位 → skip 计数、目标内容不被覆盖
      expect(r.counts.sessionSkipped).toBe(1)
      expect(r.counts.sessionDistributed).toBe(0)
      expect(readFileSync(join(dd, 'agent', 'sessions', '--w--', 'm1.jsonl'), 'utf8')).toContain('"cwd":"/w"')
      // 修复核心：skip 后 sidecar 随行循环仍执行 → 未搬的 .handoff.json 补搬、
      // 双侧并存的 .model.json 走「目标已在」skip
      expect(r.counts.sidecarsMoved).toBe(1)
      expect(r.counts.sidecarSkipped).toBe(1)
      expect(readFileSync(join(dd, 'agent', 'sessions', '--w--', 'm1.jsonl.handoff.json'), 'utf8')).toBe('sidecar')
      expect(readFileSync(join(dd, 'agent', 'sessions', '--w--', 'm1.jsonl.model.json'), 'utf8')).toBe(
        'target-already-here',
      )

      // 零重复动作：再跑一遍 → sidecar 零搬移，双侧并存的 .model.json 仍走 skip 计数
      const r2 = run(dd)
      expect(r2.mode).toBe('resume')
      expect(r2.counts.sidecarsMoved).toBe(0)
      expect(r2.counts.sidecarSkipped).toBe(1)
      expect(r2.counts.sessionSkipped).toBe(1)
      expect(readdirSync(join(dd, 'agent', 'sessions', '--w--')).sort()).toEqual([
        'm1.jsonl',
        'm1.jsonl.handoff.json',
        'm1.jsonl.model.json',
      ])
    } finally {
      cleanup(d)
    }
  })
  it('先升后迁并道无覆盖丢失：窗口期增量（新 provider/新 session）与旧数据共存', () => {
    const d = makeDataDir()
    try {
      const dd = join(d, '.xyz-agent')
      // 旧布局 pi/ + 窗口期新布局 agent/（新版启动已写入增量）同时存在
      makeLegacyPi(dd, {
        ...SEED,
        agentFiles: {
          ...SEED.agentFiles,
          'models.json': { providers: { p1: { name: 'P1' }, pNew: { name: 'WindowNew' } } }, // 窗口期新增 provider
          'settings.json': { theme: 'window' },
        },
      })
      w(dd, 'agent/sessions/--window-cwd--/new-session.jsonl', '{"type":"session","cwd":"/window/cwd"}\n') // 窗口期新 session

      const r = run(dd)
      expect(r.mode).toBe('migrate') // pi 存在 → 首迁
      expect(r.aborted).toBeNull()
      // 2b 并道：union 后新 provider 定义在位、旧 provider 不丢
      const models = readJson(join(dd, 'agent', 'models.json'))
      expect(models.providers.p1).toEqual({ name: 'P1' })
      expect(models.providers.pNew).toEqual({ name: 'WindowNew' })
      // 窗口期新 session 不被覆盖
      expect(existsSync(join(dd, 'agent', 'sessions', '--window-cwd--', 'new-session.jsonl'))).toBe(true)
      // 旧 session 分发到位
      expect(existsSync(join(dd, 'agent', 'sessions', '--w--', 'm1.jsonl'))).toBe(true)
      expect(r.counts.sessionSkipped).toBe(0)
    } finally {
      cleanup(d)
    }
  })
})

// ---------- 纯函数单元面 ----------

describe('纯函数单元', () => {
  it('parseSessionHeader：session 头取 cwd；坏 JSON / 非 session / 空 cwd → null；只读首行', () => {
    const d = makeDataDir()
    try {
      w(d, 'ok.jsonl', j({ type: 'session', cwd: '/a/b' }) + '\n' + 'x'.repeat(100000))
      w(d, 'bad.jsonl', 'not-json\n')
      w(d, 'other.jsonl', j({ type: 'summary' }) + '\n')
      w(d, 'empty-cwd.jsonl', j({ type: 'session', cwd: '' }) + '\n')
      w(d, 'empty.jsonl', '')
      expect(parseSessionHeader(join(d, 'ok.jsonl'), fsReal).cwd).toBe('/a/b')
      expect(parseSessionHeader(join(d, 'bad.jsonl'), fsReal).cwd).toBeNull()
      expect(parseSessionHeader(join(d, 'other.jsonl'), fsReal).cwd).toBeNull()
      expect(parseSessionHeader(join(d, 'empty-cwd.jsonl'), fsReal).cwd).toBeNull()
      expect(parseSessionHeader(join(d, 'empty.jsonl'), fsReal).cwd).toBeNull()
      expect(parseSessionHeader(join(d, 'missing.jsonl'), fsReal).cwd).toBeNull()
      // 只读首行：第二行损坏不影响判定
      w(d, 'long.jsonl', j({ type: 'session', cwd: '/x' }) + '\n{"broken')
      expect(parseSessionHeader(join(d, 'long.jsonl'), fsReal).cwd).toBe('/x')
    } finally {
      cleanup(d)
    }
  })
  it('unionProviderFile 纯函数：skip（深等）/ union（root 重组）/ leave-both（域路径解析不到）三态', () => {
    const spec = TRIPLET_SPECS[2] // config/providers.json
    // 域路径缺失（旧侧无 providers 键）→ 旧坏 → take-new
    const r1 = unionProviderFile({ version: 1 }, { version: 1, providers: { p: {} }, scopedModels: [] }, spec)
    expect(r1.status).toBe('take-new')
    expect(r1.conflicts[0].detail).toContain('域路径')
    // 双侧域路径都缺 → leave-both
    const r2 = unionProviderFile({ version: 1 }, { version: 1 }, spec)
    expect(r2.status).toBe('leave-both')
    // 域内单侧 key + 同值双侧 → skip（与主位现状深等）
    const r3 = unionProviderFile(
      { version: 1, providers: { p: { a: 1 } }, scopedModels: [] },
      { version: 1, providers: { p: { a: 1 } }, scopedModels: [] },
      spec,
    )
    expect(r3.status).toBe('skip')
    // 旧侧独有 key 保留 + 双侧同 key 新赢 → union 重组
    const r4 = unionProviderFile(
      { version: 1, providers: { pOld: { x: 1 }, p: { a: 1 } }, scopedModels: [] },
      { version: 1, providers: { p: { a: 2 } }, scopedModels: [] },
      spec,
    )
    expect(r4.status).toBe('union')
    expect(r4.root.providers).toEqual({ pOld: { x: 1 }, p: { a: 2 } })
      expect(r4.conflicts.map((c) => c.key)).toEqual(['p'])
  })
  it('mergeRecordTree 直挂：嵌套目录并入与同名跳过计数', () => {
    const d = makeDataDir()
    try {
      w(d, 'src/x/a.jsonl', 'a')
      w(d, 'src/x/nested/b.jsonl', 'b')
      w(d, 'dst/x/a.jsonl', 'existing')
      const report = { counts: { recordMoved: 0, recordSkipped: 0 } }
      mergeRecordTree(join(d, 'src'), join(d, 'dst'), report, fsReal)
      expect(readFileSync(join(d, 'dst', 'x', 'a.jsonl'), 'utf8')).toBe('existing')
      expect(existsSync(join(d, 'dst', 'x', 'nested', 'b.jsonl'))).toBe(true)
      expect(report.counts.recordMoved).toBe(1)
      expect(report.counts.recordSkipped).toBe(1)
    } finally {
      cleanup(d)
    }
  })
})
