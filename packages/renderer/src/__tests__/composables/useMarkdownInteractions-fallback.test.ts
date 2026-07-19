import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { useMarkdownInteractions } from '@/composables/panel/useMarkdownInteractions'
import { useSearchModal, resetSearchModal } from '@/composables/features/useSearchModal'
import * as fileApi from '@/api/domains/file'
vi.mock('@/api/domains/file', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/api/domains/file')>()
  return { ...mod, read: vi.fn() }
})

vi.mock('@/composables/features/useFileSearch', () => ({ useFileSearch: vi.fn(() => ({ load: vi.fn(() => Promise.resolve([])) })) }))
vi.mock('@/composables/features/useFileTree', () => ({ useFileTree: vi.fn(() => ({ selectFile: vi.fn() })) }))
vi.mock('@/composables/features/useSideDrawer', () => ({ useSideDrawer: vi.fn(() => ({ open: vi.fn() })) }))

// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop() {}

describe('useMarkdownInteractions fallback to search', () => {
  beforeEach(() => {
    resetSearchModal()
    vi.restoreAllMocks()
  })

  it('U6: opens search panel when file.read fails for absolute path', async () => {
    ;(fileApi.read as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('not found'))
    const { onClick } = useMarkdownInteractions({ sessionId: 'sid-1' })
    const anchor = document.createElement('a')
    anchor.className = 'md-filepath'
    anchor.dataset.path = btoa('/var/tmp/missing.md')
    anchor.textContent = '/var/tmp/missing.md'
    document.body.appendChild(anchor)

    onClick({ target: anchor, preventDefault: noop } as unknown as MouseEvent)
    await flushPromises()

    const { isOpen, query } = useSearchModal()
    expect(isOpen.value).toBe(true)
    expect(query.value).toBe('/var/tmp/missing.md')

    document.body.removeChild(anchor)
  })
})
