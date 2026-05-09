import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import i18n from './i18n'
import { registerBuiltinToolRenderers } from './lib/register-tool-renderers'
import App from './App.vue'
import './style.css'

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

const app = createApp(App)
app.use(pinia)
app.use(i18n)
registerBuiltinToolRenderers()
app.mount('#app')
