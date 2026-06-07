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
const installHint = ref('')
const uninstallTarget = ref<ExtensionInfo | null>(null)
const installTab = ref<'npm' | 'local' | 'git'>('npm')

// Discovery flow state
const discoveredCandidates = ref<ExtensionInfo[]>([])
const discoveryTempDir = ref('')
const selectedCandidates = ref<string[]>([])
const installPhase = ref<'idle' | 'discovering' | 'selecting' | 'installing' | 'done'>('idle')

const installTabs = [
  { key: 'npm' as const, label: 'npm' },
  { key: 'local' as const, label: 'Local Dir' },
  { key: 'git' as const, label: 'Git URL' },
]

// ── Message handlers ────────────────────────────────────────────

function onExtensions(msg: ServerMessage) {
  const payload = msg.payload as { extensions?: ExtensionInfo[] }
  if (payload.extensions) {
    extensions.value = payload.extensions
  }
  // Reset all install state on extensions update
  installing.value = false
  installPhase.value = 'idle'
  discoveredCandidates.value = []
}

function onDiscovered(msg: ServerMessage) {
  const payload = msg.payload as { tempDir?: string; candidates?: ExtensionInfo[] }
  if (payload.candidates && payload.candidates.length > 0) {
    discoveredCandidates.value = payload.candidates
    discoveryTempDir.value = payload.tempDir ?? ''
    selectedCandidates.value = payload.candidates.map(c => c.name)
    installPhase.value = 'selecting'
  } else {
    installError.value = 'No pi extensions found in the provided source.'
    installPhase.value = 'idle'
  }
  installing.value = false
}

function onInstallError(msg: ServerMessage) {
  const payload = msg.payload as { code?: string; message?: string; hint?: string }
  installError.value = payload.message ?? 'Install failed'
  installHint.value = payload.hint ?? ''
  installing.value = false
  installPhase.value = 'idle'
}

// ── Actions ─────────────────────────────────────────────────────

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
  installHint.value = ''

  if (installTab.value === 'local') {
    installPhase.value = 'discovering'
    send({ type: 'extension.installDir', payload: { path: source } })
  } else if (installTab.value === 'git') {
    installPhase.value = 'discovering'
    send({ type: 'extension.installGit', payload: { url: source } })
  } else {
    // npm — existing direct flow
    installPhase.value = 'idle'
    send({ type: 'extension.install', payload: { source } })
  }
}

function confirmInstallSelected() {
  if (selectedCandidates.value.length === 0 || !discoveryTempDir.value) return
  installPhase.value = 'installing'
  send({
    type: 'extension.finishInstall',
    payload: { tempDir: discoveryTempDir.value, selected: selectedCandidates.value },
  })
}

function cancelInstallSelection() {
  installPhase.value = 'idle'
  discoveredCandidates.value = []
  discoveryTempDir.value = ''
  selectedCandidates.value = []
}

function toggleCandidate(name: string) {
  const idx = selectedCandidates.value.indexOf(name)
  if (idx === -1) {
    selectedCandidates.value.push(name)
  } else {
    selectedCandidates.value.splice(idx, 1)
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

// ── Lifecycle ───────────────────────────────────────────────────

onMounted(() => {
  on('config.extensions', onExtensions)
  on('extension.discovered', onDiscovered)
  on('extension.installError', onInstallError)
  // Keep backward compat with generic error channel
  on('error', onInstallError)
  send({ type: 'extension.list', payload: {} })
})

onUnmounted(() => {
  off('config.extensions', onExtensions)
  off('extension.discovered', onDiscovered)
  off('extension.installError', onInstallError)
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

        <!-- Error display with hint -->
        <div v-if="installError" class="mt-1.5">
          <div class="text-[11px] text-[var(--danger)]">{{ installError }}</div>
          <div v-if="installHint" class="text-[11px] text-muted italic mt-0.5">{{ installHint }}</div>
        </div>
      </div>
    </div>

    <!-- Discovery: candidate selection -->
    <div v-if="installPhase === 'selecting'" class="border border-border rounded-sm overflow-hidden mb-3">
      <div class="flex items-center justify-between py-[10px] px-4 bg-[var(--section-bg)] border-b border-border min-h-[42px]">
        <span class="text-[13px] font-semibold">Found {{ discoveredCandidates.length }} extension(s)</span>
      </div>
      <div>
        <div
          v-for="candidate in discoveredCandidates"
          :key="candidate.name"
          class="flex items-center gap-3 py-2 px-4 border-b border-[var(--divider)] last:border-b-0 cursor-pointer hover:bg-[var(--hover-bg)]"
          @click="toggleCandidate(candidate.name)"
        >
          <!-- Checkbox indicator -->
          <div
            class="w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 transition-colors duration-100"
            :class="selectedCandidates.includes(candidate.name)
              ? 'bg-[var(--accent)] border-[var(--accent)]'
              : 'border-[var(--border)]'"
          >
            <svg
              v-if="selectedCandidates.includes(candidate.name)"
              width="8" height="8" viewBox="0 0 10 10"
              fill="none" stroke="white" stroke-width="2"
            >
              <path d="M2 5l2.5 2.5L8 3" />
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-[13px] font-semibold flex items-center gap-2">
              {{ candidate.name }}
              <span class="text-[10px] font-semibold py-[1px] px-1.5 rounded-sm bg-[var(--accent-light)] text-[var(--accent)]">{{ candidate.version }}</span>
            </div>
            <div class="text-[11px] text-muted mt-px line-clamp-1">{{ candidate.description }}</div>
          </div>
        </div>
      </div>
      <div class="flex justify-end gap-2 py-2 px-4 border-t border-[var(--divider)] bg-[var(--section-bg)]">
        <Button variant="outline" size="sm" @click="cancelInstallSelection">Cancel</Button>
        <Button
          variant="primary"
          size="sm"
          :disabled="selectedCandidates.length === 0"
          @click="confirmInstallSelected"
        >
          Install Selected ({{ selectedCandidates.length }})
        </Button>
      </div>
    </div>

    <!-- Discovery: installing progress -->
    <div v-if="installPhase === 'installing'" class="border border-border rounded-sm overflow-hidden mb-3">
      <div class="flex items-center justify-center gap-2 py-4 px-4 bg-[var(--section-bg)]">
        <svg class="animate-spin text-[var(--accent)]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
        <span class="text-[12px] text-muted">Installing selected extensions...</span>
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
