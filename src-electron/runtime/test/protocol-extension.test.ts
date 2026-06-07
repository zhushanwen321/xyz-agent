import { describe, it, expect } from 'vitest'
import type {
  ClientMessage,
  ServerMessage,
  ExtensionUIRequestPayload,
  ExtensionUIResponsePayload,
  ExtensionErrorPayload,
  ToolCallUpdatePayload,
  ExtensionInfo,
  ExtensionDiscoveredPayload,
  ExtensionInstallProgressPayload,
  ExtensionInstallErrorPayload,
} from '@xyz-agent/shared'

/**
 * Task 1 tests: shared protocol types for extension system.
 *
 * These tests verify that:
 * 1. ClientMessageType union includes extension.* types
 * 2. ServerMessageType union includes extension.* and related types
 * 3. Payload interfaces have correct shapes
 * 4. ClientMessage discriminated union handles new types
 */
describe('Protocol: extension types', () => {
  // ── ClientMessageType ──────────────────────────────────────────

  it('ClientMessage accepts extension.ui_response type', () => {
    const msg: ClientMessage = {
      type: 'extension.ui_response',
      id: 'test-1',
      payload: { sessionId: 's1', requestId: 'r1', result: true },
    }
    expect(msg.type).toBe('extension.ui_response')
    expect(msg.payload).toEqual({ sessionId: 's1', requestId: 'r1', result: true })
  })

  it('ClientMessage accepts extension.toggle type', () => {
    const msg: ClientMessage = {
      type: 'extension.toggle',
      id: 'test-2',
      payload: { name: 'my-ext', enabled: true },
    }
    expect(msg.type).toBe('extension.toggle')
    expect(msg.payload).toEqual({ name: 'my-ext', enabled: true })
  })

  it('ClientMessage accepts extension.list type', () => {
    const msg: ClientMessage = {
      type: 'extension.list',
      id: 'test-3',
      payload: {},
    }
    expect(msg.type).toBe('extension.list')
  })

  it('extension.ui_response accepts boolean result', () => {
    const msg: ClientMessage = {
      type: 'extension.ui_response',
      payload: { sessionId: 's1', requestId: 'r1', result: false },
    }
    expect((msg.payload as { result: boolean }).result).toBe(false)
  })

  it('extension.ui_response accepts string result', () => {
    const msg: ClientMessage = {
      type: 'extension.ui_response',
      payload: { sessionId: 's1', requestId: 'r1', result: 'selected-option' },
    }
    expect((msg.payload as { result: string }).result).toBe('selected-option')
  })

  it('extension.ui_response accepts null result', () => {
    const msg: ClientMessage = {
      type: 'extension.ui_response',
      payload: { sessionId: 's1', requestId: 'r1', result: null },
    }
    expect((msg.payload as { result: null }).result).toBeNull()
  })

  // ── ServerMessageType ───────────────────────────────────────────

  it('ServerMessage accepts extension.ui_request type', () => {
    const msg: ServerMessage = {
      type: 'extension.ui_request',
      payload: {
        sessionId: 's1',
        requestId: 'r1',
        method: 'confirm',
        title: 'Allow access?',
        message: 'Extension wants to read files',
      },
    }
    expect(msg.type).toBe('extension.ui_request')
  })

  it('ServerMessage accepts extension.ui_timeout type', () => {
    const msg: ServerMessage = {
      type: 'extension.ui_timeout',
      payload: { sessionId: 's1', requestId: 'r1' },
    }
    expect(msg.type).toBe('extension.ui_timeout')
  })

  it('ServerMessage accepts extension.error type', () => {
    const msg: ServerMessage = {
      type: 'extension.error',
      payload: { sessionId: 's1', extensionName: 'ext-1', error: 'crashed' },
    }
    expect(msg.type).toBe('extension.error')
  })

  it('ServerMessage accepts message.tool_call_update type', () => {
    const msg: ServerMessage = {
      type: 'message.tool_call_update',
      payload: { sessionId: 's1', toolCallId: 'tc1', progress: 50, detail: 'processing...' },
    }
    expect(msg.type).toBe('message.tool_call_update')
  })

  it('ServerMessage accepts config.extensions type', () => {
    const msg: ServerMessage = {
      type: 'config.extensions',
      payload: { extensions: [] },
    }
    expect(msg.type).toBe('config.extensions')
  })

  // ── Payload interfaces ──────────────────────────────────────────

  it('ExtensionUIRequestPayload has correct shape for confirm', () => {
    const payload: ExtensionUIRequestPayload = {
      sessionId: 's1',
      requestId: 'r1',
      method: 'confirm',
      title: 'Allow?',
      message: 'Please confirm',
    }
    expect(payload.method).toBe('confirm')
    expect(payload.options).toBeUndefined()
    expect(payload.default).toBeUndefined()
  })

  it('ExtensionUIRequestPayload has correct shape for select with options', () => {
    const payload: ExtensionUIRequestPayload = {
      sessionId: 's1',
      requestId: 'r1',
      method: 'select',
      title: 'Choose one',
      options: ['opt-a', 'opt-b'],
    }
    expect(payload.method).toBe('select')
    expect(payload.options).toEqual(['opt-a', 'opt-b'])
  })

  it('ExtensionUIRequestPayload has correct shape for input', () => {
    const payload: ExtensionUIRequestPayload = {
      sessionId: 's1',
      requestId: 'r1',
      method: 'input',
      title: 'Enter value',
      default: 'placeholder',
    }
    expect(payload.method).toBe('input')
    expect(payload.default).toBe('placeholder')
  })

  it('ExtensionUIRequestPayload has correct shape for notify', () => {
    const payload: ExtensionUIRequestPayload = {
      sessionId: 's1',
      requestId: 'r1',
      method: 'notify',
      message: 'Something happened',
      level: 'warn',
    }
    expect(payload.method).toBe('notify')
    expect(payload.level).toBe('warn')
  })

  it('ExtensionUIResponsePayload has correct shape', () => {
    const payload: ExtensionUIResponsePayload = {
      sessionId: 's1',
      requestId: 'r1',
      result: true,
    }
    expect(payload.result).toBe(true)
  })

  it('ExtensionErrorPayload has correct shape', () => {
    const payload: ExtensionErrorPayload = {
      sessionId: 's1',
      extensionName: 'my-ext',
      error: 'something went wrong',
    }
    expect(payload.extensionName).toBe('my-ext')
  })

  it('ToolCallUpdatePayload has required and optional fields', () => {
    const minimal: ToolCallUpdatePayload = {
      sessionId: 's1',
      toolCallId: 'tc1',
    }
    expect(minimal.progress).toBeUndefined()
    expect(minimal.detail).toBeUndefined()

    const full: ToolCallUpdatePayload = {
      sessionId: 's1',
      toolCallId: 'tc1',
      progress: 75,
      detail: 'almost done',
    }
    expect(full.progress).toBe(75)
  })

  it('ClientMessage accepts extension.install type', () => {
    const msg: ClientMessage = {
      type: 'extension.install',
      payload: { source: 'npm:pi-ask-user' },
    }
    expect(msg.type).toBe('extension.install')
    expect((msg.payload as { source: string }).source).toBe('npm:pi-ask-user')
  })

  it('ClientMessage accepts extension.uninstall type', () => {
    const msg: ClientMessage = {
      type: 'extension.uninstall',
      payload: { name: 'pi-ask-user' },
    }
    expect(msg.type).toBe('extension.uninstall')
    expect((msg.payload as { name: string }).name).toBe('pi-ask-user')
  })

  it('ExtensionInfo has correct shape', () => {
    const info: ExtensionInfo = {
      name: 'my-extension',
      version: '1.0.0',
      description: 'A test extension',
      path: '/path/to/ext',
      enabled: true,
      source: 'built-in',
    }
    expect(info.name).toBe('my-extension')
    expect(info.enabled).toBe(true)
    expect(info.source).toBe('built-in')

    const userInfo: ExtensionInfo = {
      name: 'user-ext',
      version: '0.1.0',
      description: '',
      path: '/other/path',
      enabled: true,
      source: 'user-installed',
    }
    expect(userInfo.source).toBe('user-installed')
  })

  // ── New install flow types (Task 2) ──────────────────────────────

  describe('extension install flow messages', () => {
    it('ClientMessage accepts extension.installDir type', () => {
      const msg: ClientMessage = {
        type: 'extension.installDir',
        payload: { path: '/path/to/local/dir' },
      }
      expect(msg.type).toBe('extension.installDir')
      expect((msg.payload as { path: string }).path).toBe('/path/to/local/dir')
    })

    it('ClientMessage accepts extension.installGit type', () => {
      const msg: ClientMessage = {
        type: 'extension.installGit',
        payload: { url: 'https://github.com/user/repo.git' },
      }
      expect(msg.type).toBe('extension.installGit')
      expect((msg.payload as { url: string }).url).toBe('https://github.com/user/repo.git')
    })

    it('ClientMessage accepts extension.finishInstall type', () => {
      const msg: ClientMessage = {
        type: 'extension.finishInstall',
        payload: { tempDir: '/tmp/ext-scan-123', selected: ['ext-a', 'ext-b'] },
      }
      expect(msg.type).toBe('extension.finishInstall')
      const p = msg.payload as { tempDir: string; selected: string[] }
      expect(p.tempDir).toBe('/tmp/ext-scan-123')
      expect(p.selected).toEqual(['ext-a', 'ext-b'])
    })

    it('ServerMessage accepts extension.discovered type', () => {
      const msg: ServerMessage = {
        type: 'extension.discovered',
        payload: {
          tempDir: '/tmp/ext-scan-123',
          candidates: [
            { name: 'ext-a', version: '1.0.0', description: 'Test', path: '/tmp/a', enabled: true, source: 'built-in' as const },
          ],
        },
      }
      expect(msg.type).toBe('extension.discovered')
    })

    it('ServerMessage accepts extension.installProgress type', () => {
      const msg: ServerMessage = {
        type: 'extension.installProgress',
        payload: { phase: 'clone', status: 'running' },
      }
      expect(msg.type).toBe('extension.installProgress')
    })

    it('ServerMessage accepts extension.installError type', () => {
      const msg: ServerMessage = {
        type: 'extension.installError',
        payload: { code: 'not_found', message: 'Package not found' },
      }
      expect(msg.type).toBe('extension.installError')
    })

    it('ExtensionDiscoveredPayload has correct shape', () => {
      const payload: ExtensionDiscoveredPayload = {
        tempDir: '/tmp/ext-scan-123',
        candidates: [
          { name: 'ext-a', version: '1.0.0', description: 'Test', path: '/tmp/a', enabled: true, source: 'built-in' },
        ],
      }
      expect(payload.tempDir).toBe('/tmp/ext-scan-123')
      expect(payload.candidates).toHaveLength(1)
    })

    it('ExtensionInstallProgressPayload supports all phases and statuses', () => {
      const cloneRunning: ExtensionInstallProgressPayload = { phase: 'clone', status: 'running' }
      expect(cloneRunning.phase).toBe('clone')

      const scanDone: ExtensionInstallProgressPayload = { phase: 'scan', status: 'done', message: 'Found 3 extensions' }
      expect(scanDone.message).toBe('Found 3 extensions')

      const installError: ExtensionInstallProgressPayload = { phase: 'install', status: 'error', message: 'Failed' }
      expect(installError.status).toBe('error')
    })

    it('ExtensionInstallErrorPayload has required and optional fields', () => {
      const minimal: ExtensionInstallErrorPayload = {
        code: 'network',
        message: 'Connection timeout',
      }
      expect(minimal.hint).toBeUndefined()

      const withHint: ExtensionInstallErrorPayload = {
        code: 'not_found',
        message: 'Package not found',
        hint: 'Check the package name and registry',
      }
      expect(withHint.hint).toBe('Check the package name and registry')
    })
  })
})
