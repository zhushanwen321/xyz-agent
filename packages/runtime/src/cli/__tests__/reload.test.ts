import { describe, it, expect, vi } from 'vitest'
import { attemptReload } from '../reload.js'

vi.mock('../ws-client.js', () => ({
  rpc: vi.fn(),
}))

describe('attemptReload', () => {
  it('calls reload when session is idle', async () => {
    const { rpc } = await import('../ws-client.js')
    vi.mocked(rpc).mockResolvedValueOnce({ data: { isGenerating: false } }) // get_state
    vi.mocked(rpc).mockResolvedValueOnce({}) // reload

    const result = await attemptReload()
    expect(result.reloaded).toBe(true)
  })

  it('skips reload when session is busy, returns hint message', async () => {
    const { rpc } = await import('../ws-client.js')
    vi.mocked(rpc).mockResolvedValueOnce({ isGenerating: true })

    const result = await attemptReload()
    expect(result.reloaded).toBe(false)
    expect(result.message).toContain('busy')
  })

  it('handles reload RPC failure gracefully', async () => {
    const { rpc } = await import('../ws-client.js')
    vi.mocked(rpc).mockRejectedValueOnce(new Error('connection refused'))

    const result = await attemptReload()
    expect(result.reloaded).toBe(false)
    expect(result.message).toContain('failed')
  })
})
