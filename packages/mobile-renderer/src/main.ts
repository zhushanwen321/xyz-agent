import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@fontsource-variable/inter'
import i18n from './i18n'
import App from './App.vue'
import './style.css'

// mobile-renderer 入口（spec P4 D1）。
// 不注册 window.electronAPI（D8），无 local-file:// 协议注册。
const app = createApp(App)
app.use(createPinia())
app.use(i18n)
app.mount('#app')
