/**
 * applyHeaderCwdFallback 单测（W11，数据源治理）。
 *
 * [HISTORICAL] 本文件原测 session-file-utils 的 persistSessionName / patchSessionCwd
 * （两个直写 pi session JSONL 的函数），两者已随 W11 删除——label 持久化切 pi
 * set_session_name RPC（活跃走既有进程、非活跃走 process-manager.withEphemeralPi 短命
 * 附着）；cwd 降级改经纯字符串变换 helper（[W1 语义变更：直附着正式文件] 现用于
 * restoreSession F3 归一化管线，变换产物经 normalizeSessionFileInPlace 原地落回原文件，
 * 不再走 tmp 拷贝）。
 * 原「规则 #6：文件不存在不创建」守卫语义由 sidecar 家族测试承接
 * （session-fork-fields.test.ts U3 系）。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-file-utils.test.ts
 */
import { describe, it, expect } from 'vitest'
import { applyHeaderCwdFallback } from '../src/services/session/session-lifecycle.js'

describe('applyHeaderCwdFallback（F3 归一化管线内 header cwd 降级，纯字符串变换）', () => {
  it('替换首行 session header 的 cwd，其余 entry 原样保留', () => {
    const content = [
      JSON.stringify({ type: 'session', version: 3, id: 'test-id', cwd: '/dead/cwd', timestamp: '2025-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [] } }),
      JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [] } }),
    ].join('\n') + '\n'

    const patched = applyHeaderCwdFallback(content, '/home/fallback')

    const lines = patched.split('\n')
    const header = JSON.parse(lines[0])
    expect(header.cwd).toBe('/home/fallback')
    // 其他 header 字段与后续 entry 字节不变（只动 cwd）
    expect(header.id).toBe('test-id')
    expect(header.version).toBe(3)
    expect(lines[1]).toBe(JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [] } }))
    expect(lines[2]).toBe(JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [] } }))
    // 末尾换行保留（pi _persist 期望每行以 \n 结尾，与 stripSessionEndEntries 契约一致）
    expect(patched.endsWith('\n')).toBe(true)
  })

  it('首行非 session 类型 → 原样返回（防御，与原 patchSessionCwd 同语义）', () => {
    const content = JSON.stringify({ type: 'other', cwd: '/old' }) + '\n'
    expect(applyHeaderCwdFallback(content, '/new')).toBe(content)
  })

  it('首行 JSON 损坏 → 原样返回不抛', () => {
    const content = 'not-json\nmore\n'
    expect(applyHeaderCwdFallback(content, '/new')).toBe(content)
  })

  it('空文本 → 原样返回', () => {
    expect(applyHeaderCwdFallback('', '/new')).toBe('')
  })
})
