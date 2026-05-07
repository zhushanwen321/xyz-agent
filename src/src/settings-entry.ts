import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { createI18n } from 'vue-i18n'
import SettingsView from './components/layout/SettingsView.vue'
import zhCN from './i18n/locales/zh-CN'
import enUS from './i18n/locales/en-US'

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
  },
})

const app = createApp(SettingsView)
app.use(pinia)
app.use(i18n)
app.mount('#app')
