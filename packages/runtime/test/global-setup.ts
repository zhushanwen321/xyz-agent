/**
 * Vitest globalSetup — 测试运行最早期执行（早于任何测试文件的 import）。
 *
 * [HISTORICAL] 2026-07-26 事故结构性兜底：
 * runtime 的多个 store 模块在 import 时 eager 初始化（模块级 `let xxxStore = createXxxStore(getXxxPath())`），
 * getXxxPath() 读 process.env.XYZ_AGENT_DATA_DIR。如果测试文件在 beforeEach 漏调 setXxxPath，
 * store 会绑定到用户真实数据目录 ~/.xyz-agent，写入污染用户数据。
 *
 * 本 globalSetup 强制把 XYZ_AGENT_DATA_DIR 指向测试专用 tmp 目录，
 * 让所有 eager 初始化天然走 tmp，结构性杜绝污染。
 *
 * 注意：globalSetup 在隔离进程跑，return 的 teardown 在所有测试结束后调用。
 * process.env 的设置通过 `process.env.X = ...` 直接赋值，对 worker 进程可见
 * （vitest fork worker 继承父进程 env）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let testDataDir: string | null = null

export function setup(): void {
  // 已设（如外层 CI 指定），尊重不覆盖
  if (process.env.XYZ_AGENT_DATA_DIR) return
  testDataDir = mkdtempSync(join(tmpdir(), 'xyz-agent-test-data-'))
  process.env.XYZ_AGENT_DATA_DIR = testDataDir
}

export function teardown(): void {
  if (testDataDir) {
    try {
      rmSync(testDataDir, { recursive: true, force: true })
    } catch (e) {
      // best-effort cleanup；globalSetup teardown 失败不应阻断 vitest 退出
      console.warn(`[global-setup] teardown rmSync failed for ${testDataDir}:`, e instanceof Error ? e.message : e)
    }
  }
}

export default function globalSetup(): (() => void) | void {
  setup()
  return teardown
}
