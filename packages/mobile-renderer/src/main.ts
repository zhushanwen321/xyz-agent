import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@fontsource-variable/inter'
import App from './App.vue'
import './style.css'

// mobile-renderer 入口（spec P4 D1）。
// 不注册 window.electronAPI（D8），无 local-file:// 协议注册。
// w1 暂不接 i18n（w2 copy i18n 目录后补 app.use(i18n)）。
const app = createApp(App)
app.use(createPinia())
app.mount('#app')
