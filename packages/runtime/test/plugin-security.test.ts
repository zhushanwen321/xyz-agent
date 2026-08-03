import { describe, it, expect, vi } from 'vitest'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import {
  EXTERNAL_PLUGIN_ENABLED,
  EXTERNAL_PLUGIN_DISABLED,
  EXTERNAL_PLUGIN_DISABLED_MESSAGE,
} from '../src/services/plugin-service/plugin-security.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { IPluginInstaller, InstallResult } from '../src/services/ports/plugin-installer.js'

function createMockBroker(): IMessageBroker {
  return {
    broadcast: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  } as unknown as IMessageBroker
}

function createService(installer: IPluginInstaller): PluginService {
  const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
  return new PluginService(registry, createMockBroker(), { pluginInstaller: installer })
}

describe('external plugin install hard lock（§6.6 排期硬锁）', () => {
  it('TC-1: EXTERNAL_PLUGIN_ENABLED=false 时 installPlugin 短路返回 success:false 且 installer 零调用', async () => {
    const installer: IPluginInstaller = {
      install: vi.fn().mockResolvedValue({ success: true, pluginId: 'pkg', path: '/tmp' }),
      uninstall: vi.fn().mockResolvedValue(undefined),
    }
    const service = createService(installer)

    const result: InstallResult = await service.installPlugin('any-npm-pkg')

    // 用户可见契约：安装被拒
    expect(result.success).toBe(false)
    expect(result.error).toContain(EXTERNAL_PLUGIN_DISABLED)
    // 短路在 installer port 之前：installer mock 零调用
    expect(installer.install).not.toHaveBeenCalled()
  })

  it('TC-2: 常量契约 —— EXTERNAL_PLUGIN_ENABLED 默认 false、错误码与文案常量导出', () => {
    expect(EXTERNAL_PLUGIN_ENABLED).toBe(false)
    expect(EXTERNAL_PLUGIN_DISABLED).toBe('EXTERNAL_PLUGIN_DISABLED')
    expect(EXTERNAL_PLUGIN_DISABLED_MESSAGE).toContain(EXTERNAL_PLUGIN_DISABLED)
    expect(EXTERNAL_PLUGIN_DISABLED_MESSAGE).toContain('sandbox isolation')
  })
})
