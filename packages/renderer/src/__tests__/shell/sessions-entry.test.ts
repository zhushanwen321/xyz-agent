/**
 * TC-7：sessions-entry 占位导出单元测试（C-W5-3 / D5）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/shell/sessions-entry.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SESSIONS_SHELL_MOUNT_POINT } from '@/shell/sessions-entry'
import type { SessionsShellMountPoint } from '@/shell/sessions-entry'

describe('sessions-entry (TC-7)', () => {
  it('SESSIONS_SHELL_MOUNT_POINT 占位标识导出为非空字符串 "sessions"', () => {
    expect(SESSIONS_SHELL_MOUNT_POINT).toBe('sessions')
  })

  it('SessionsShellMountPoint 接口签名对齐 useSidebar 挂载点消费子集', () => {
    // 类型层断言：构造一个对齐 useSidebar 返回签名子集的对象赋给 SessionsShellMountPoint，
    // 编译期通过即证明接口形状正确（focus/select/new/load/rename/delete/deleteFolder/retry）
    const mp: SessionsShellMountPoint = {
      focusedSessionId: (() => null) as unknown as SessionsShellMountPoint['focusedSessionId'],
      focusedSession: (() => null) as unknown as SessionsShellMountPoint['focusedSession'],
      selectSession: async () => {},
      newSession: async () => null,
      loadSessions: async () => {},
      renameSession: async () => {},
      deleteSession: async () => {},
      deleteFolder: async () => ({ cwd: '', deleted: [], failed: [] }),
      retryHistory: async () => {},
    }
    expect(mp.selectSession).toBeTypeOf('function')
    expect(mp.newSession).toBeTypeOf('function')
  })

  it('sessions-entry.ts 源不 import contribution / extension-host registry（D5 占位约束）', () => {
    const src = readFileSync(
      resolve(__dirname, '../../shell/sessions-entry.ts'),
      'utf-8',
    )
    // D5 占位约束：不 import contribution registry / extension-host 机制（只在注释中提及 P4 升级方向）。
    // 断言实际 ES import 语句的 source path 不含这些模块（允许注释描述中出现词汇）。
    const importSources = [...src.matchAll(/^\s*import\s+[^;]+from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(importSources.length).toBeGreaterThan(0) // 确保正则捕获到 import（vue + shared）
    for (const s of importSources) {
      expect(s).not.toMatch(/contribution|extension-host|MountPointRegistry/i)
    }
  })
})
