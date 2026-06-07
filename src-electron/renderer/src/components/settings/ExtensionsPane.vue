<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { on, off } from '../../lib/event-bus'
import { send } from '../../lib/ws-client'
import { Button, Dialog, Input } from '../../design-system'
import type { ServerMessage, ExtensionInfo } from '@xyz-agent/shared'
import ExtensionSection from './ExtensionSection.vue'

const { t } = useI18n()

const extensions = ref<ExtensionInfo[]>([])
const showInstall = ref(false)
const installSource = ref('')
const installing = ref(false)
const installError = ref('')
const uninstallTarget = ref<ExtensionInfo | null>(null)
const installTab = ref<'npm' | 'local' | 'git'>('npm')

const installTabs = [
  { key: 'npm' as const, label: 'npm' },
  { key: 'local' as const, label: 'Local Dir' },
  { key: 'git' as const, label: 'Git URL' },
]

function onExtensions(msg: ServerMessage) {
  const payload = msg.payload as { extensions?: ExtensionInfo[] }
  if (payload.extensions) {
    extensions.value = payload.extensions
  }
  installing.value = false
}

function onInstallError(msg: ServerMessage) {
  const payload = msg.payload as { code?: string; message?: string }
  if (payload.code === 'install_failed') {
    installError.value = payload.message ?? 'Install failed'
    installing.value = false
  }
}

function handleToggle(payload: { name: string; enabled: boolean }) {
  const { name, enabled } = payload
  const target = extensions.value.find(ext => ext.name === name)
  if (target) target.enabled = enabled
  send({ type: 'extension.toggle', payload: { name, enabled } })
}

function handleInstall() {
  const source = installSource.value.trim()
  if (!source) return
  installing.value = true
  installError.value = ''

  if (installTab.value === 'local') {
    send({ type: 'extension.installDir', payload: { path: source } })
  } else if (installTab.value === 'git') {
    send({ type: 'extension.installGit', payload: { url: source } })
  } else {
    send({ type: 'extension.install', payload: { source } })
  }
}

function confirmUninstall(ext: ExtensionInfo) {
  uninstallTarget.value = ext
}

function doUninstall() {
  if (!uninstallTarget.value) return
  send({ type: 'extension.uninstall', payload: { name: uninstallTarget.value.name } })
  uninstallTarget.value = null
}

function installButtonLabel(): string {
  if (!installing.value) return 'Install'
  if (installTab.value === 'git') return 'Cloning...'
  if (installTab.value === 'local') return 'Scanning...'
  return 'Installing...'
}

onMounted(() => {
  on('config.extensions', onExtensions)
  on('error', onInstallError)
  send({ type: 'extension.list', payload: {} })
})

onUnmounted(() => {
  off('config.extensions', onExtensions)
  off('error', onInstallError)
})
</script>

<template>
  <div class="max-w-[860px] mx-auto py-8 px-10">
    <div class="mb-7">
      <div class="font-display text-[22px] font-bold tracking-tight">{{ t('settings.extensionConfig') }}</div>
      <div class="text-[12px] text-muted mt-1">{{ t('settings.extensionConfigDesc') }}</div>
    </div>

    <!-- Install area -->
    <div class="border border-border rounded-sm overflow-hidden mb-3">
      <div
        class="flex items-center justify-between py-[10px] px-4 bg-[var(--section-bg)] border-b border-border min-h-[42px] cursor-pointer hover:bg-[var(--hover-bg)]"
        @click="showInstall = !showInstall"
      >
        <span class="text-[13px] font-semibold">Install Extension</span>
        <svg
          class="shrink-0 text-muted transition-transform duration-150"
          :class="{ 'rotate-180': showInstall }"
          width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2"
        >
          <path d="M2 4l3 3 3-3" />
        </svg>
      </div>
      <div v-if="showInstall" class="px-4 py-3 border-t border-[var(--divider)] bg-[var(--section-bg)]">
        <!-- Tab bar -->
        <div class="flex gap-1 mb-3">
          <button
            v-for="tab in installTabs"
            :key="tab.key"
            class="text-[11px] px-2.5 py-1 cursor-pointer transition-colors duration-100"
            :class="installTab === tab.key
              ? 'bg-[var(--section-bg)] border border-border rounded-sm font-medium text-[var(--fg)]'
              : 'text-muted hover:text-[var(--fg)]'"
            @click="installTab = tab.key"
          >
            {{ tab.label }}
          </button>
        </div>

        <!-- npm tab -->
        <template v-if="installTab === 'npm'">
          <div class="flex items-center gap-2">
            <Input
              v-model="installSource"
              type="text"
              placeholder="npm:pi-ask-user"
              class="flex-1"
              @keydown.enter="handleInstall"
            />
            <Button
              variant="primary"
              size="sm"
              :disabled="installing || !installSource.trim()"
              @click="handleInstall"
            >{{ installButtonLabel() }}</Button>
          </div>
          <div class="text-[10px] text-muted mt-1.5">
            Enter an npm package name. The <span class="font-mono">npm:</span> prefix is optional.
          </div>
        </template>

        <!-- Local Dir tab -->
        <template v-else-if="installTab === 'local'">
          <div class="flex items-center gap-2">
            <Input
              v-model="installSource"
              type="text"
              placeholder="/path/to/extension/directory"
              class="flex-1"
              @keydown.enter="handleInstall"
            />
            <Button
              variant="primary"
              size="sm"
              :disabled="installing || !installSource.trim()"
              @click="handleInstall"
            >{{ installButtonLabel() }}</Button>
          </div>
          <div class="text-[10px] text-muted mt-1.5">
            Path to a local directory containing pi extension(s).
          </div>
        </template>

        <!-- Git URL tab -->
        <template v-else>
          <div class="flex items-center gap-2">
            <Input
              v-model="installSource"
              type="text"
              placeholder="https://github.com/user/repo.git"
              class="flex-1"
              @keydown.enter="handleInstall"
            />
            <Button
              variant="primary"
              size="sm"
              :disabled="installing || !installSource.trim()"
              @click="handleInstall"
            >{{ installButtonLabel() }}</Button>
          </div>
          <div class="text-[10px] text-muted mt-1.5">
            Git repository URL containing pi extension(s).
          </div>
        </template>

        <!-- Error display -->
        <div v-if="installError" class="text-[11px] text-[var(--danger)] mt-1.5">{{ installError }}</div>
      </div>
    </div>

    <!-- Extension list -->
    <div v-if="extensions.length > 0" class="border border-border rounded-sm overflow-hidden mb-3">
      <div class="flex items-center justify-between py-[10px] px-4 bg-[var(--section-bg)] border-b border-border min-h-[42px]">
        <span class="text-[13px] font-semibold">{{ t('settings.installedExtensions') }}</span>
        <span class="text-[10px] text-muted font-medium bg-[var(--hover-bg)] py-[2px] px-[6px] rounded-sm">{{ extensions.length }}</span>
      </div>
      <div>
        <ExtensionSection
          v-for="ext in extensions"
          :key="ext.name"
          :extension="ext"
          @toggle-enabled="handleToggle"
          @uninstall="confirmUninstall"
        />
      </div>
    </div>

    <!-- Empty state -->
    <div
      v-else
      class="border border-border rounded-sm py-12 px-6 text-center"
    >
      <svg class="mx-auto mb-3 text-muted" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M9 12h6M12 9v6" />
      </svg>
      <div class="text-[13px] text-muted">{{ t('settings.noExtensions') }}</div>
    </div>

    <!-- Uninstall confirm dialog -->
    <Dialog
      :open="uninstallTarget !== null"
      :title="`Uninstall ${uninstallTarget?.name ?? ''}`"
      @update:open="() => { uninstallTarget = null }"
    >
      <p class="text-sm leading-relaxed mb-4" style="color: var(--muted)">
        Are you sure you want to uninstall "{{ uninstallTarget?.name }}"? This will remove the package and configuration.
      </p>
      <div class="flex justify-end gap-2">
        <Button variant="outline" size="sm" @click="uninstallTarget = null">Cancel</Button>
        <Button variant="danger" size="sm" @click="doUninstall">Uninstall</Button>
      </div>
    </Dialog>
  </div>
</template>
