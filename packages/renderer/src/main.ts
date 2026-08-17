import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@fontsource-variable/inter' // Inter 字体（design-tokens SSOT，ADR-0019）—— npm 包随 bundle 打包，离线可用
import 'katex/dist/katex.min.css' // KaTeX 公式样式（第三方库 CSS，随 bundle 打包；math_inline/math_block 渲染产出 .katex/.katex-display 节点依赖此样式）
import i18n from './i18n'
import App from './App.vue'
import { provideDesktopPlatform } from './platform/desktop-platform'
import { createMockPlatform } from './mock/mock-ws'
import { providePlatform, provideDevMode } from '@xyz-agent/core'
import { initExtensionHostBridge, getExtensionBus } from './composables/shell/useExtensionHostBridge'
import { initPermissionRequest } from './composables/shell/usePermissionRequest'
import './style.css'

// dev 模式注入（core headless 化，audit §15.6）：core 不能读 import.meta.env，
// 由壳启动时注入 dev 标志（chat effects/store 诊断日志据此开关）
provideDevMode(Boolean(import.meta.env.DEV))

// [HISTORICAL] 2026-08-04 bootstrap 时序：platform 注入必须先于连接编排（useConnection.init）。
// 原注入点在 AppShell setup（useSettingsShell），但 AppShell 仅在连接成功后渲染（App.vue v-if）——
// core ws-client.connect 第一步 getPlatform() fail-fast 需要 platform → 死锁（永远「连接中」）。
// 对齐架构 §11.0.3：main.ts 挂载前注入，AppShell 内重复调用幂等无害。
// mock 模式（VITE_MOCK=true）注入 createMockPlatform（webSocket.create 返回 mock 桩，
// 否则 connect('mock://') 会因原生 WebSocket 不支持 mock scheme 抛错）。
if (import.meta.env.VITE_MOCK === 'true') {
  providePlatform(createMockPlatform())
} else {
  provideDesktopPlatform()
}

const app = createApp(App)
// ExtensionHost bridge 装配（audit §12.1）：WS plugin:* 消息 → bus → ViewHostStore/StatusBarController →
// app.provide 注入 ui 组件数据源。须在 mount 前（provide 全局生效）。
initExtensionHostBridge(app)
// permissionRequest 闭环（audit §12.1）：订阅 bus plugin-permission-request → 驱动 Dialog →
// app.provide 真实 PermissionTransport（转发 plugin.approvePermissions/revokePermissions WS 命令）。
// 须在 mount 前 provide（Dialog 经 inject 取 transport）；复用 ExtensionHost 同一 bus 单例。
initPermissionRequest(app, getExtensionBus())
app.use(createPinia())
app.use(i18n)
app.mount('#app')
