/**
 * dev 数据目录钉死回归守护（2026-09-08 Gate B 泄漏事故修复）。
 *
 * [HISTORICAL] 事故：宿主 shell 的 XYZ_AGENT_DATA_DIR=/Users/<user>/.xyz-agent
 * 泄漏进 dev Electron，main.ts isDev 块旧实现（`env ?? ~/.xyz-agent-dev`）只在
 * undefined 兜底、泄漏值被采信 → dev app 整个跑在用户 prod 数据目录上。
 * 修复语义：isDev 下外部 XYZ_AGENT_DATA_DIR 被无条件覆盖为 ~/.xyz-agent-dev。
 *
 * 测试策略（沿用 main-launch-result.test.ts 降级方案——main.ts 顶层副作用极重，
 * 直接 import 的 mock 面过宽且脆弱）：
 *   ① 源码守护：main.ts 含无条件钉死语句，且不再有「采信外部值 ?? 兜底」形态；
 *      XYZ_AGENT_PORT_OFFSET 刻意保持 ?? 语义（无泄漏风险面，不随本次修复改动）
 *   ② 行为守护：从 main.ts 源码提取对 XYZ_AGENT_DATA_DIR 的真实赋值语句并执行
 *      （new Function 注入 process/path/homedir 绑定），预置污染 env（含事故形态
 *      ~/.xyz-agent 与任意目录）→ 断言执行后一律落在 ~/.xyz-agent-dev。
 *      旧代码（?? 兜底）下提取语句为自赋值 no-op，污染值不被覆盖 → 本组转红，
 *      即红/绿判别力来自真实源码而非测试内复制品。
 *
 * 运行：cd apps/electron/main && npx vitest run test/main-dev-datadir-pin.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mainSource = readFileSync(path.resolve(__dirname, '../main.ts'), 'utf-8')

const DEV_DATA_DIR = path.join(homedir(), '.xyz-agent-dev')

/** 提取 main.ts 中对 XYZ_AGENT_DATA_DIR 的全部赋值语句（真实源码行，逐行完整） */
function extractDataDirAssignments(): string[] {
  const lines = mainSource.match(/^[ \t]*process\.env\.XYZ_AGENT_DATA_DIR[ \t]*=[^\n]*/gm)
  if (!lines) throw new Error('main.ts 中未找到 XYZ_AGENT_DATA_DIR 赋值语句')
  return lines.map((l) => l.trim())
}

/** 用注入的 process/path/homedir 绑定执行提取到的真实语句，返回执行后的 env 值 */
function executeAssignments(initial: string | undefined): string | undefined {
  const env: Record<string, string | undefined> = { XYZ_AGENT_DATA_DIR: initial }
  const run = new Function(
    'process',
    'path',
    'homedir',
    `${extractDataDirAssignments().join('\n')}`,
  )
  run({ env }, path, homedir)
  return env.XYZ_AGENT_DATA_DIR
}

describe('main.ts dev 数据目录钉死（2026-09-08 泄漏事故回归守护）', () => {
  it('源码守护：isDev 块无条件钉死 XYZ_AGENT_DATA_DIR（无 ?? 外部采信形态）', () => {
    expect(mainSource).toMatch(
      /process\.env\.XYZ_AGENT_DATA_DIR = path\.join\(homedir\(\), '\.xyz-agent-dev'\)/,
    )
    expect(mainSource).not.toMatch(
      /process\.env\.XYZ_AGENT_DATA_DIR = process\.env\.XYZ_AGENT_DATA_DIR/,
    )
  })

  it('源码守护：XYZ_AGENT_PORT_OFFSET 保持 ?? 兜底语义（无泄漏风险面，刻意不动）', () => {
    expect(mainSource).toMatch(
      /process\.env\.XYZ_AGENT_PORT_OFFSET = process\.env\.XYZ_AGENT_PORT_OFFSET \?\? String\(DEV_PORT_OFFSET\)/,
    )
  })

  it('行为守护：事故形态（宿主泄漏 ~/.xyz-agent）+ isDev → 被覆盖为 ~/.xyz-agent-dev', () => {
    // 2026-09-08 事故原形态：宿主 shell 泄漏的 prod 数据目录
    expect(executeAssignments(path.join(homedir(), '.xyz-agent'))).toBe(DEV_DATA_DIR)
  })

  it('行为守护：任意外部污染目录 + isDev → 一律落到 ~/.xyz-agent-dev', () => {
    expect(executeAssignments('/tmp/leaked-custom-dir')).toBe(DEV_DATA_DIR)
  })

  it('行为守护：env 缺省（undefined）时同样钉到 ~/.xyz-agent-dev', () => {
    expect(executeAssignments(undefined)).toBe(DEV_DATA_DIR)
  })
})
