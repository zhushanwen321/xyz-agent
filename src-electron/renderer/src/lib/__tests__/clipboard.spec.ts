import { describe, it, expect, vi, beforeEach } from 'vitest'
import { copyWithToast } from '../clipboard'

describe('copyWithToast', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  it('copies text to clipboard', async () => {
    await copyWithToast('hello')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello')
  })

  it('defaults to markdown format', async () => {
    await copyWithToast('# Title')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('# Title')
  })

  it('handles clipboard API failure gracefully', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error('denied')),
      },
    })
    // Should not throw
    await expect(copyWithToast('text')).resolves.toBeUndefined()
  })
})
