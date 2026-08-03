// mobile-renderer 入口（W1 scaffolding）：createApp + pinia 最小 bootstrap。
//
// AC1 依赖边：import @xyz-agent/core + @xyz-agent/ui（workspace:* 同源产物，
// 非 sync-copy 副本）——W1 仅引用符号建立物理依赖边：
//   - providePlatform：core PlatformPort 注入点（P0 已落地）。真实 adapter
//     注入归 W2（src/platform/mobile-platform-adapter.ts），此处不调用。
//   - UI_PACKAGE_NAME：ui 包占位常量，console 打印消费。
// App.vue 归 W2（layout-shell-and-stubs），W1 用内联占位渲染。
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { providePlatform } from '@xyz-agent/core'
import { UI_PACKAGE_NAME } from '@xyz-agent/ui'

// W1 仅确认注入点可达（编译期符号引用），不注入真实 adapter（W2）。
void providePlatform

// eslint-disable-next-line no-console
console.log(`[mobile-renderer] boot: ui=${UI_PACKAGE_NAME}`)

createApp({
  render: () => h('div', { 'data-testid': 'mobile-root' }, 'xyz-agent mobile'),
}).use(createPinia()).mount('#app')
