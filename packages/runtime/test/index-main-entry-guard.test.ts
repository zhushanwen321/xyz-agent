/**
 * Bug 1 (CRITICAL) 回归测试：index.ts 顶层 main() 入口判定 guard。
 *
 * 背景：原正则 `/index(\.cjs|\.js|\.ts)?$/` 匹配任何以 index 结尾的路径，
 * 导致 dev 模式跑 `tsx src/server/index.ts` 时，server/index.ts import `../index.js`，
 * 被 import 的 index 模块因 argv[1]='.../src/server/index.ts' 匹配正则，顶层 main() 误触发，
 * 与 server/index.ts 自身的 main() 重复启动 → EADDRINUSE。
 *
 * 修复：抽出纯函数 _isRuntimeMainEntry，正则锚定 `src/index.ts`（含路径分隔符），
 * 不再匹配 `src/server/index.ts`。
 *
 * 测试 4 场景（直接测纯函数，避免动态 import + 模块缓存副作用复杂度）：
 *  - dev runtime 入口 (.../src/index.ts) → true（main 执行）
 *  - dev server CLI 入口 (.../src/server/index.ts) → false（main 不执行，CLI 显式调）
 *  - packaged runtime (.../index.cjs) → true（main 执行）
 *  - packaged server CLI (.../server.cjs) → false（main 不执行）
 */
import { describe, it, expect } from 'vitest'
import { _isRuntimeMainEntry } from '../src/index.js'

describe('_isRuntimeMainEntry (Bug 1: src/server/index.ts 不应触发 main)', () => {
  it('argv[1]=.../src/index.ts → true（dev runtime 入口）', () => {
    expect(_isRuntimeMainEntry('/abs/path/packages/runtime/src/index.ts')).toBe(true)
  })

  it('argv[1]=.../src/server/index.ts → false（dev server CLI 入口，绝不触发）', () => {
    // 这是 Bug 1 的核心回归点：原正则误匹配此路径 → EADDRINUSE
    expect(_isRuntimeMainEntry('/abs/path/packages/runtime/src/server/index.ts')).toBe(false)
  })

  it('argv[1]=.../index.cjs → true（packaged runtime 入口）', () => {
    expect(_isRuntimeMainEntry('/abs/path/apps/electron/dist/runtime/index.cjs')).toBe(true)
  })

  it('argv[1]=.../server.cjs → false（packaged server CLI）', () => {
    expect(_isRuntimeMainEntry('/abs/path/apps/electron/dist/runtime/server.cjs')).toBe(false)
  })

  it('argv[1]=.../cli.cjs → false（packaged xyz-settings CLI）', () => {
    expect(_isRuntimeMainEntry('/abs/path/apps/electron/dist/runtime/cli.cjs')).toBe(false)
  })

  it('Windows 风格反斜杠路径 ...\\src\\index.ts → true', () => {
    expect(_isRuntimeMainEntry('C:\\proj\\packages\\runtime\\src\\index.ts')).toBe(true)
  })

  it('Windows 风格反斜杠路径 ...\\src\\server\\index.ts → false', () => {
    expect(_isRuntimeMainEntry('C:\\proj\\packages\\runtime\\src\\server\\index.ts')).toBe(false)
  })

  it('argv[1] 为空字符串 → false（被 import 时 argv[1] 可能不存在）', () => {
    expect(_isRuntimeMainEntry('')).toBe(false)
  })

  it('不匹配 /index.js 结尾的任意路径（如 /foo/index.js 不在 src 下）→ false', () => {
    // 旧行为会匹配；新逻辑要求 src/index.ts 或 index.cjs 严格锚定
    expect(_isRuntimeMainEntry('/some/random/index.js')).toBe(false)
  })
})
