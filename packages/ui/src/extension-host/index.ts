/**
 * ui 包 extension-host 层导出面（W4 · T4）。
 *
 * 导出 PluginSettingsPage（插件管理页，IF7）+ 其数据源接口。
 * 真实 PluginSettingsDataSource 实现由壳（P5）provide（接 runtime config.plugins
 * 订阅 + S2 contribution-registry），本包只定义契约与组件本体。
 */
export { default as PluginSettingsPage } from './PluginSettingsPage.vue'
export {
  PluginSettingsDataSourceKey,
  type PluginSettingsDataSource,
  type ContributionInfo,
} from './plugin-settings-data-source'
