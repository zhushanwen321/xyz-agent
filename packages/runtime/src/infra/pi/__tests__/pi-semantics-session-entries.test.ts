/**
 * PS-09 探针：plain custom entry 不进 LLM 上下文（D6 探针层）。
 *
 * 登记条目（docs/pi-semantics.json）：「plain appendEntry 写入的 type=custom entry 不进
 * LLM 上下文；进上下文的是 custom_message entry（sessionEntryToContextMessages 对其余
 * 类型返回 []）」——事故 A 审查期实测；「live ≡ reload」等价性的 entry 投影依据。
 *
 * 断言方式：静态形态断言（函数窗口内的分支清单 + 兜底 return [] + 无 plain-custom 分支）
 * + 行为级断言（动态 import dist/core/session-manager.js 直调 sessionEntryToContextMessages：
 * type=custom → []，type=custom_message → 恰一条 role=custom 消息）。dist 不可达 / 动态
 * import 失败时 skip 不 fail；不进 REAL_PI_TESTS 分池。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-session-entries.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 定位实装 pi-coding-agent dist（cwd 逐级上溯，同 pi-paths-config-dir-contract.test.ts 范式）。 */
function locatePiCodingAgentDist(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist')
    if (existsSync(join(candidate, 'config.js'))) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

const PI_DIST = locatePiCodingAgentDist()
const SKIP_REASON = PI_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (!PI_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

/** 行为级断言用：动态 import session-manager.js（纯投影函数，依赖 fs/crypto/pi-ai 均可解析）。 */
type SessionManagerModule = {
  sessionEntryToContextMessages?: (entry: Record<string, unknown>) => unknown[]
}
const sessionManager: SessionManagerModule | null = await (async () => {
  if (!PI_DIST) return null
  try {
    return (await import(pathToFileURL(join(PI_DIST, 'core', 'session-manager.js')).href)) as SessionManagerModule
  } catch {
    return null
  }
})()

/** 提取函数窗口（到下一个 export function / 函数声明 / 文件尾）。 */
function functionWindow(text: string, header: string): string {
  const start = text.indexOf(header)
  if (start === -1) return ''
  const rest = text.slice(start + header.length)
  const next = /\n(?:export )?function /.exec(rest)
  return next ? rest.slice(0, next.index) : rest.slice(0, 3000)
}

describe.skipIf(!PI_DIST)(
  `PS-09 探针：sessionEntryToContextMessages 投影白名单（代码形态断言${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const src = readFileSync(join(PI_DIST as string, 'core', 'session-manager.js'), 'utf-8')

    it('白名单分支：message / custom_message / branch_summary / compaction，兜底 return []', () => {
      const win = functionWindow(src, 'export function sessionEntryToContextMessages(entry)')
      expect(win, 'PS-09 漂移：sessionEntryToContextMessages 函数消失/改名——entry→上下文投影改形，复核 PS-09 锚点').not.toBe('')
      for (const t of ['message', 'custom_message', 'branch_summary', 'compaction']) {
        expect(
          win.includes(`entry.type === "${t}"`),
          `PS-09 漂移：白名单分支 "${t}" 消失——投影面变化，复核 PS-09（live ≡ reload 等价性依据）`,
        ).toBe(true)
      }
      expect(win.includes('return []'), 'PS-09 漂移：兜底 return [] 消失——未知类型将进上下文？复核 PS-09').toBe(true)
    })

    it('无 plain custom 分支（type=custom 不被特判）', () => {
      const win = functionWindow(src, 'export function sessionEntryToContextMessages(entry)')
      expect(
        !/entry\.type === "custom"(?!_message)/.test(win),
        'PS-09 漂移：出现了 plain custom 特判分支——custom entry 开始进上下文，复核 PS-09 与 event-adapter 的 entry 映射',
      ).toBe(true)
    })
  },
)

describe.skipIf(!sessionManager?.sessionEntryToContextMessages)(
  'PS-09 探针：sessionEntryToContextMessages 行为断言（动态 import dist/core/session-manager.js）',
  () => {
    const fn = sessionManager!.sessionEntryToContextMessages!

    it('plain appendEntry 的 type=custom → []（不进 LLM 上下文）', () => {
      expect(fn({ type: 'custom', data: { foo: 1 }, timestamp: 1 })).toEqual([])
    })

    it('type=custom_message → 恰一条 role=custom 消息（customType 透传）', () => {
      const got = fn({ type: 'custom_message', customType: 'probe-type', content: [], display: 'hidden', timestamp: 1 })
      expect(got).toHaveLength(1)
      expect(got[0]).toMatchObject({ role: 'custom', customType: 'probe-type' })
    })
  },
)
