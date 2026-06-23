import { createApp, ref } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.js'
import App from './App.js'
import ChatView from './ChatView.js'
import SettingsView from './SettingsView.js'

createApp({
  components: { AppShell: App, ChatView, SettingsView },
  setup() {
    const view = ref('chat')
    return { view }
  },
  template: `
    <app-shell v-model:view="view">
      <chat-view v-if="view==='chat'" />
      <settings-view v-else />
    </app-shell>`
}).mount('#app')
