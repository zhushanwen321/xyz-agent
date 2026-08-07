/**
 * sync-mobile-from-renderer.sh 测试（P4-s1-w2 TC1）。
 *
 * 验证默认 --dry-run 行为：exit 0 + 输出含 COPY_MAP 状态行 + 不写文件。
 */
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../../../..')
const SCRIPT = resolve(REPO_ROOT, 'scripts/sync-mobile-from-renderer.sh')

describe('sync-mobile-from-renderer.sh', () => {
  it('TC1: 默认 --dry-run exit 0 + 输出状态行 + 不写文件', () => {
    // 记录 useConnection.ts（MANUAL_FORK）的 mtime，dry-run 不应改它
    const dst = resolve(REPO_ROOT, 'packages/mobile-renderer/src/composables/useConnection.ts')
    const mtimeBefore = statSync(dst).mtimeMs

    // 默认无 flag = --dry-run
    const output = execSync(`bash ${SCRIPT}`, { encoding: 'utf-8', cwd: REPO_ROOT })

    // exit 0（execSync 非 0 会抛，到这里即成功）
    expect(output).toContain('--dry-run')
    // 输出含 COPY_MAP 状态行（[IDENTICAL]/[CHANGED]/[NEW]/[FORK-SKIP] 之一）
    expect(output).toMatch(/\[(IDENTICAL|CHANGED|NEW|FORK-SKIP|SRC-MISSING)\]/)
    // summary 行
    expect(output).toContain('summary')
    // 不写文件：useConnection.ts mtime 不变
    const mtimeAfter = statSync(dst).mtimeMs
    expect(mtimeAfter).toBe(mtimeBefore)

    // MANUAL_FORK（useConnection.ts）在 --dry-run 仍 diff（不跳过，只提示）；--force 才跳过
    // dry-run 输出应含 useConnection 相关行（CHANGED 或 IDENTICAL）
    expect(output).toMatch(/composables\b/)
  })

  it('脚本内容含 COPY_MAP + MANUAL_FORK 声明（结构完整性）', () => {
    const content = readFileSync(SCRIPT, 'utf-8')
    expect(content).toContain('COPY_MAP')
    expect(content).toContain('MANUAL_FORK')
    expect(content).toContain('useConnection.ts')
    expect(content).toContain('--dry-run')
    expect(content).toContain('--force')
  })
})
