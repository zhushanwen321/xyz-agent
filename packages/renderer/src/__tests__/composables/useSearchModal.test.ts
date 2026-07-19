import { describe, it, expect, beforeEach } from 'vitest'
import { useSearchModal, resetSearchModal } from '@/composables/features/useSearchModal'

describe('useSearchModal', () => {
  beforeEach(() => {
    resetSearchModal()
  })

  it('U5: open sets isOpen true and initial query', () => {
    const { isOpen, query } = useSearchModal()
    useSearchModal().open('src/main.ts')
    expect(isOpen.value).toBe(true)
    expect(query.value).toBe('src/main.ts')
  })

  it('U5b: close resets open state', () => {
    const { isOpen, query } = useSearchModal()
    useSearchModal().open('foo')
    useSearchModal().close()
    expect(isOpen.value).toBe(false)
    expect(query.value).toBe('')
  })
})
