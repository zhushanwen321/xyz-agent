/**
 * W6 D2 · settings 全量 i18n 接入测试（U10）。
 *
 * 验证目标：settings locale namespace 在 zh-CN/en-US 均完整定义，
 * t() 按 locale 返回对应文案。降级为直接测 locale 结构 + t() 函数
 * （mount SettingsModal 依赖 store/api/toast，太重）。
 *
 * 独立文件：避免 system-theme.test.ts 的 vi.doMock('@/i18n') 污染本文件
 * （doMock 在文件内提升，会覆盖真实 i18n 实例）。
 */
import { describe, it, expect } from 'vitest'
import i18n, { setLocale } from '@/i18n'

describe('U10: settings UI 文案经 i18n 渲染', () => {
  it('zh-CN locale 含完整 settings namespace 且 t() 返回中文', () => {
    setLocale('zh-CN')
    // 菜单标题/描述
    expect(i18n.global.t('settings.title')).toBe('设置')
    expect(i18n.global.t('settings.menu.providerDesc')).toBe('配置模型供应商与 API Key')
    expect(i18n.global.t('settings.menu.systemDesc')).toBe('外观、语言与快捷键偏好')
    // provider 页
    expect(i18n.global.t('settings.provider.add')).toBe('添加供应商')
    expect(i18n.global.t('settings.provider.modelsCount', { count: 5 })).toBe('5 模型')
    expect(i18n.global.t('settings.provider.deleteConfirmTitle', { name: 'OpenAI' })).toBe('删除 OpenAI？')
    // providerEdit
    expect(i18n.global.t('settings.providerEdit.addTitle')).toBe('添加供应商')
    expect(i18n.global.t('settings.providerEdit.testOk', { count: 3 })).toBe('连接成功，找到 3 个模型')
    // extension
    expect(i18n.global.t('settings.extension.recommendedTitle')).toBe('推荐扩展')
    expect(i18n.global.t('settings.extension.discoverResultTitle', { count: 2 })).toBe('发现 2 个候选')
    // system 页（含字体大小新增 key）
    expect(i18n.global.t('settings.system.fontLarge')).toBe('大')
    expect(i18n.global.t('settings.system.shortcutTitle')).toBe('快捷键')
    // resource
    expect(i18n.global.t('settings.resource.discovered', { label: 'Skill' })).toBe('已发现的 Skill')
    // loadPaths
    expect(i18n.global.t('settings.loadPaths.title')).toBe('加载路径')
    // 命令名（快捷键展示用）
    expect(i18n.global.t('settings.command.new-session')).toBe('新建任务')
    expect(i18n.global.t('settings.command.toggle-sidebar')).toBe('收起侧栏')
  })

  it('en-US locale 含完整 settings namespace 且 t() 返回英文', () => {
    setLocale('en-US')
    expect(i18n.global.t('settings.title')).toBe('Settings')
    expect(i18n.global.t('settings.menu.providerDesc')).toBe('Configure model providers and API keys')
    expect(i18n.global.t('settings.menu.systemDesc')).toBe('Appearance, language and shortcut preferences')
    expect(i18n.global.t('settings.provider.add')).toBe('Add Provider')
    expect(i18n.global.t('settings.provider.modelsCount', { count: 5 })).toBe('5 models')
    expect(i18n.global.t('settings.provider.deleteConfirmTitle', { name: 'OpenAI' })).toBe('Delete OpenAI?')
    expect(i18n.global.t('settings.providerEdit.addTitle')).toBe('Add Provider')
    expect(i18n.global.t('settings.providerEdit.testOk', { count: 3 })).toBe('Connection successful, found 3 models')
    expect(i18n.global.t('settings.extension.recommendedTitle')).toBe('Recommended')
    expect(i18n.global.t('settings.extension.discoverResultTitle', { count: 2 })).toBe('Found 2 candidates')
    expect(i18n.global.t('settings.system.fontLarge')).toBe('Large')
    expect(i18n.global.t('settings.system.shortcutTitle')).toBe('Shortcuts')
    expect(i18n.global.t('settings.resource.discovered', { label: 'Skill' })).toBe('Discovered Skill')
    expect(i18n.global.t('settings.loadPaths.title')).toBe('Load paths')
    expect(i18n.global.t('settings.command.new-session')).toBe('New session')
    expect(i18n.global.t('settings.command.toggle-sidebar')).toBe('Toggle sidebar')
  })

  it('切换 locale 后同一 key 返回不同文案（响应式切换生效）', () => {
    setLocale('zh-CN')
    expect(i18n.global.t('settings.title')).toBe('设置')
    setLocale('en-US')
    expect(i18n.global.t('settings.title')).toBe('Settings')
  })

  it('missing key 回退到 key 本身（非 undefined，便于发现遗漏）', () => {
    setLocale('en-US')
    // 用一个不存在的 key 验证 fallback 行为（vue-i18n 默认返回 key 字符串）
    expect(i18n.global.t('settings.nonexistent.key')).toBe('settings.nonexistent.key')
  })
})
