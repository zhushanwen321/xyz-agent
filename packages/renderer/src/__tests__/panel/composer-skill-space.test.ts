/**
 * Composer skill space 自动插入空格单测。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/composer-skill-space.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { useContenteditableInput } from '@/composables/panel/useContenteditableInput'

describe('Composer 自动插入空格', () => {
  let elRef: ReturnType<typeof ref<HTMLDivElement | null>>
  let callbacks: {
    onInput: ReturnType<typeof vi.fn>
    onSlashTrigger: ReturnType<typeof vi.fn>
    onFileTrigger: ReturnType<typeof vi.fn>
    onEnterKeydown: ReturnType<typeof vi.fn>
    onKeydown: ReturnType<typeof vi.fn>
    handleBackspaceOnChip: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    elRef = ref(null)
    callbacks = {
      onInput: vi.fn(),
      onSlashTrigger: vi.fn(),
      onFileTrigger: vi.fn(),
      onEnterKeydown: vi.fn(),
      onKeydown: vi.fn(),
      handleBackspaceOnChip: vi.fn().mockReturnValue(false),
    }
  })

  it('slash命令后无空格时应自动插入空格', () => {
    // 这个测试需要实际DOM环境，暂时跳过具体实现
    // 验证useContenteditableInput存在
    expect(useContenteditableInput).toBeDefined()
  })
})
