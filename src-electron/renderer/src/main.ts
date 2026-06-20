import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@fontsource-variable/inter' // Inter 字体（design-tokens SSOT，ADR-0018）—— npm 包随 bundle 打包，离线可用
import i18n from './i18n'
import App from './App.vue'
import './style.css'

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
app.mount('#app')
