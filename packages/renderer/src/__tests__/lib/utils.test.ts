/**
 * renderer lib/utils.ts 单测 —— cn re-export shim 透传验证。
 *
 * cn 的 SSOT 在 @xyz-agent/ui（lib/utils.ts），renderer 侧是薄 re-export
 * （对齐 slashIcons / file-basename re-export shim 模式）。本测试验证
 * shim 透传后 cn 行为不变（twMerge(clsx(...)) 语义）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/lib/utils.test.ts
 */
import { describe, it, expect } from 'vitest'
import { cn } from '@/lib/utils'

describe('cn', () => {
  it('合并 class 字符串', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('过滤 falsy 值（clsx 语义）', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b')
  })

  it('tailwind-merge 冲突合并（后者覆盖冲突类）', () => {
    expect(cn('p-4', 'p-2')).toBe('p-2')
    expect(cn('text-red-500', 'text-blue-600')).toBe('text-blue-600')
  })
})
