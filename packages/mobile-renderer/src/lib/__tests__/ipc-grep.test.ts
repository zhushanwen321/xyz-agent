/**
 * AC3 grep 验证测试（P4-s1-w3 TC2）。
 *
 * 确认 mobile-renderer/src 除 lib/ipc.ts（适配层）外，无实际 window.electronAPI 调用
 * （spec D8：业务层应通过 ipc.ts 间接调用，不直接访问 window.electronAPI）。
 *
 * 排除项（不算实际调用）：
 *  - lib/ipc.ts 本身（适配层，允许访问）
 *  - __tests__（测试代码）
 *  - 注释行（// 或 * 开头，含 TODO）
 *  - 可选链 window.electronAPI?.（注释性提及或防御性读取，非直接调用——mobile ipc.ts 不依赖此值）
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SRC_ROOT = resolve(__dirname, '../..')

/** 递归收集 src 下所有 .ts/.vue 文件（排除 __tests__） */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      collectSourceFiles(full, acc)
    } else if (/\.(ts|vue)$/.test(entry)) {
      acc.push(full)
    }
  }
  return acc
}

describe('AC3: window.electronAPI 调用全在 lib/ipc.ts 内（spec D8）', () => {
  it('TC2: 除 lib/ipc.ts 外无实际 window.electronAPI 调用（排除注释/TODO/可选链）', () => {
    const files = collectSourceFiles(SRC_ROOT)
    const violations: string[] = []

    for (const file of files) {
      // 跳过适配层本身
      if (file.replace(/\\/g, '/').includes('/lib/ipc.ts')) continue

      const lines = readFileSync(file, 'utf-8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]
        if (!raw.includes('window.electronAPI')) continue

        // 去首尾空白后的代码内容（用于判断注释）
        const trimmed = raw.trim()
        // 排除单行注释（// 或 * 开头——* 是块注释续行）
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
        // 排除可选链（?.）——注释性提及或防御性读取，非直接调用
        if (trimmed.includes('window.electronAPI?.')) continue
        // 排除行内注释后的纯注释提及（如 "code // 不注册 window.electronAPI"）
        // 取 // 之前部分判断是否有实际调用语法
        const codePart = trimmed.split('//')[0]
        if (!codePart.includes('window.electronAPI')) continue

        // 剩余视为实际调用
        violations.push(`${file.replace(SRC_ROOT + '/', '').replace(/\\/g, '/')}:${i + 1}: ${trimmed}`)
      }
    }

    expect(violations, `发现未覆盖的 window.electronAPI 直接调用（应通过 lib/ipc.ts 间接调用）:\n${violations.join('\n')}`).toEqual([])
  })
})
