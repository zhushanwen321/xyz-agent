import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'katex/dist/katex.min.css' // KaTeX 公式样式（第三方库 CSS，随 bundle 打包；math_inline/math_block 渲染产出 .katex/.katex-display 节点依赖此样式）
import i18n from './i18n'
import App from './App.vue'
import { provideDevMode } from '@xyz-agent/core'
import { resolvePlatform } from './platform/resolve-platform'
import { initExtensionHostBridge, getExtensionBus } from './composables/shell/useExtensionHostBridge'
import { initPermissionRequest } from './composables/shell/usePermissionRequest'
import './style.css'

// dev 模式注入（core headless 化，audit §15.6）：core 不能读 import.meta.env，
// 由壳启动时注入 dev 标志（chat effects/store 诊断日志据此开关）
provideDevMode(Boolean(import.meta.env.DEV))

// [HISTORICAL] 2026-08-04 bootstrap 时序：platform 注入必须先于连接编排（useConnection.init）。
// 原注入点在 AppShell setup（useSettingsShell），但 AppShell 仅在连接成功后渲染（App.vue v-if）——
// core ws-client.connect 第一步 getPlatform() fail-fast 需要 platform → 死锁（永远「连接中」）。
// 时序约束现由 bootstrap await 链结构化保证（首步 providePlatform 先于第 2 步 initConnection，
// App.vue onMounted 触发）；main.ts 早期注入保留是 setup 期消费点防线：App.vue setup 的
// settings init（settings-lifecycle getSystem(getPlatform().storage)）先于 onMounted 执行，
// HMR 场景也依赖 platform 已注入。分叉唯一装配点 = resolvePlatform()（VITE_MOCK 三元，memoized）。
resolvePlatform()

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
