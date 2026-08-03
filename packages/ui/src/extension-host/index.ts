/**
 * ui 包 extension-host 层导出面（W4 · T4 + W3 · T2/T3）。
 *
 * 导出 PluginSettingsPage（插件管理页，IF7）+ 其数据源接口 + StatusBar/ViewHost
 * （W3：AC5 状态栏 + AC9 view 渲染侧，C3/C4 契约）及其注入接口。
 * 真实数据源实现由壳（P5）provide（接 runtime config.plugins 订阅 + S2
 * status-bar-controller/view-host-store/contribution-registry），本包只定义契约
 * 与组件本体。
 */
export { default as PluginSettingsPage } from './PluginSettingsPage.vue'
export {
  PluginSettingsDataSourceKey,
  type PluginSettingsDataSource,
  type ContributionInfo,
} from './plugin-settings-data-source'
export { default as StatusBar } from './StatusBar.vue'
export {
  STATUS_BAR_SOURCE_KEY,
  type StatusBarSource,
  type StatusBarEntry,
} from './status-bar-source'
export { default as ViewHost } from './ViewHost.vue'
export {
  VIEW_HOST_SOURCE_KEY,
  type ViewHostSource,
  type ViewCacheEntry,
} from './view-host-source'
