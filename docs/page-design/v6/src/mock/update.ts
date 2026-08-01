/** Mock 数据层 — 更新设置页（UpdatePage）静态数据。
 * 页面语义来源：真实项目 i18n `settings.updateDesc` = 「配置自动升级与代理设置」；
 * 代理字段/交互来源：真实组件 UpdatePage.vue（proxyMode / httpProxy / httpsProxy / 测试 / 保存）。*/

/** 当前安装版本（真实项目 package.json version） */
export const CURRENT_VERSION = '0.8.40'

/** 更新渠道（真实项目 stable 发布线） */
export const UPDATE_CHANNEL = 'stable'

/** mock 检测到的新版本号 */
export const NEW_VERSION = '0.9.0'

/** 新版本发布日期 */
export const NEW_VERSION_DATE = '2026-08-10'

/** 新版本发布说明（Release Notes，中英双语标记已提取为纯中文 demo 文案） */
export const RELEASE_NOTES: string[] = [
  '设置页视觉升级：冷蓝暗色设计系统，分组卡片化布局',
  '新增代理配置：支持系统代理 / 手动配置 / 禁用三种模式',
  '修复：会话隔离状态泄漏、pi 事件适配偶发丢消息',
]

/** 代理模式选项（与真实组件 SelectItem value 一一对应） */
export const PROXY_MODE_OPTIONS: { value: 'system' | 'manual' | 'disabled'; label: string; desc: string }[] = [
  { value: 'system', label: '系统代理（自动检测）', desc: '跟随系统网络代理设置，自动检测生效' },
  { value: 'manual', label: '手动配置', desc: '手动填写 HTTP / HTTPS 代理地址' },
  { value: 'disabled', label: '禁用代理', desc: '直连网络，不经过任何代理' },
]

/** 代理字段文案（真实组件 i18n zh-CN 语义保留） */
export const PROXY_TEXT = {
  httpPlaceholder: '如 http://127.0.0.1:7890',
  httpsPlaceholder: '如 http://127.0.0.1:7890',
  testSuccess: '代理连接成功',
  testFailed: '代理连接失败',
  testDisabled: '代理已禁用，无法测试',
  httpRequired: '请填写 HTTP 代理地址',
  invalidUrl: '代理地址格式无效（示例：http://127.0.0.1:7890）',
  saved: '代理配置已保存',
  saveFailed: '保存失败：无法连接到代理服务，请检查地址',
} as const

/** 检查更新 / 下载失败文案（对齐真实组件 i18n 语义，仿 PROXY_TEXT 模式） */
export const UPDATE_TEXT = {
  checkFailed: '检查更新失败：无法连接更新服务，请检查网络后重试',
  downloadInterrupted: '下载中断：网络连接不稳定，请重试',
} as const

/** mock 失败演示地址：HTTP 代理填写该地址时，测试/保存模拟失败（demo 状态机触发，正式版无此约定） */
export const FAIL_PROXY_ADDR = 'http://127.0.0.1:9999'

/** 检查更新 / 下载 的 mock 延迟（ms） */
export const CHECK_DELAY = 900
export const DOWNLOAD_DELAY = 1400
export const SAVE_DELAY = 500
export const TEST_DELAY = 600
