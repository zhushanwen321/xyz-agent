/**
 * W3 验收测试 - i18n keys
 *
 * 覆盖验收场景：
 * - W3-A7-i18n-keys-vitest: i18n zh-CN/en 双语 keys 存在
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/i18n/w3-i18n-keys.test.ts
 */
import { describe, it, expect } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN/sidebar'
import enUS from '@/i18n/locales/en-US/sidebar'
import zhCNSettings from '@/i18n/locales/zh-CN/settings'
import enUSSettings from '@/i18n/locales/en-US/settings'

describe('W3-A7-i18n-keys-vitest', () => {
  it('W3-A7-i18n-keys-vitest: sidebar.update 新增 keys 中英双语存在', () => {
    // newVersionWithVersion
    expect(zhCN.update.newVersionWithVersion).toBeDefined()
    expect(enUS.update.newVersionWithVersion).toBeDefined()
    expect(zhCN.update.newVersionWithVersion).toContain('{version}')
    expect(enUS.update.newVersionWithVersion).toContain('{version}')

    // versionTransition
    expect(zhCN.update.versionTransition).toBeDefined()
    expect(enUS.update.versionTransition).toBeDefined()
    expect(zhCN.update.versionTransition).toContain('{from}')
    expect(zhCN.update.versionTransition).toContain('{to}')
    expect(enUS.update.versionTransition).toContain('{from}')
    expect(enUS.update.versionTransition).toContain('{to}')
  })

  it('W3-A7-i18n-keys-vitest: sidebar.update 原有 keys 仍存在', () => {
    // 验证原有 keys 未被破坏
    expect(zhCN.update.newVersion).toBeDefined()
    expect(enUS.update.newVersion).toBeDefined()
    expect(zhCN.update.downloading).toBeDefined()
    expect(enUS.update.downloading).toBeDefined()
    expect(zhCN.update.error).toBeDefined()
    expect(enUS.update.error).toBeDefined()
    expect(zhCN.update.retry).toBeDefined()
    expect(enUS.update.retry).toBeDefined()
  })

  it('W3-A7-i18n-keys-vitest: settings.update testProxy 相关 keys 存在', () => {
    // 验证 testProxy 相关 keys（虽然这些是旧的，但确保完整性）
    expect(zhCNSettings.update.testProxy).toBeDefined()
    expect(enUSSettings.update.testProxy).toBeDefined()
    expect(zhCNSettings.update.testSuccess).toBeDefined()
    expect(enUSSettings.update.testSuccess).toBeDefined()
    expect(zhCNSettings.update.testFailed).toBeDefined()
    expect(enUSSettings.update.testFailed).toBeDefined()
  })
})
