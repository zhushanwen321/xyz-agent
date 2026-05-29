<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { usePlugin } from '../../composables/usePlugin'
import { ToggleSwitch, MetaGrid } from './shared'
import { Button, Dialog } from '../../design-system'
import PluginSettingsForm from './PluginSettingsForm.vue'
import PluginPermissionDialog from '../plugin/PluginPermissionDialog.vue'
import type { PluginViewModel } from '../../types/plugin'

const { store } = usePlugin()

// ── State ──────────────────────────────────────────────────────

const expandedPluginId = ref<string | null>(null)
const uninstallTarget = ref<PluginViewModel | null>(null)
const trustConfirmTarget = ref<PluginViewModel | null>(null)

// ── Computed ───────────────────────────────────────────────────

const plugins = computed(() => store.pluginList)

const hasPlugins = computed(() => plugins.value.length > 0)

const pendingPermissionEntry = computed(() => {
  const entries = Array.from(store.permissionRequests.entries())
  if (entries.length === 0) return null
  const [pluginId, permissions] = entries[0]
  const plugin = store.pluginById(pluginId)
  return {
    id: pluginId,
    name: plugin?.displayName ?? pluginId,
    permissions,
  }
})

// ── Handlers ───────────────────────────────────────────────────

function handleToggle(payload: { id: string; enabled: boolean }) {
  store.togglePlugin(payload.id, payload.enabled)
}

function toggleExpand(pluginId: string) {
  expandedPluginId.value = expandedPluginId.value === pluginId ? null : pluginId
  // Fetch config when expanding
  if (expandedPluginId.value === pluginId) {
    store.getConfig(pluginId)
  }
}

function confirmUninstall(plugin: PluginViewModel) {
  uninstallTarget.value = plugin
}

function doUninstall() {
  if (!uninstallTarget.value) return
  store.uninstallPlugin(uninstallTarget.value.pluginId)
  if (expandedPluginId.value === uninstallTarget.value.pluginId) {
    expandedPluginId.value = null
  }
  uninstallTarget.value = null
}

function requestTrustUpgrade(plugin: PluginViewModel) {
  trustConfirmTarget.value = plugin
}

function doTrustUpgrade() {
  if (!trustConfirmTarget.value) return
  // Use togglePlugin to signal trust level change; backend may need dedicated WS type
  store.togglePlugin(trustConfirmTarget.value.pluginId, true)
  trustConfirmTarget.value = null
}

function handlePermissionConfirm(permissions: string[]) {
  if (!pendingPermissionEntry.value) return
  store.approvePermissions(pendingPermissionEntry.value.id, permissions)
}

function handlePermissionCancel() {
  if (!pendingPermissionEntry.value) return
  store.revokePermissions(pendingPermissionEntry.value.id)
}

function handleRevokePermissions(pluginId: string) {
  store.revokePermissions(pluginId)
}

// ── Badge helpers ──────────────────────────────────────────────

function statusBadgeClass(status: PluginViewModel['status']): string {
  switch (status) {
    case 'active': return 'bg-[var(--success-light)] text-[var(--success)]'
    case 'inactive': return 'bg-[var(--hover-bg)] text-[var(--muted)]'
    case 'crashed': return 'bg-[var(--danger-light)] text-[var(--danger)]'
    case 'discovered': return 'bg-[var(--accent-light)] text-[var(--accent)]'
    case 'loaded': return 'bg-[var(--warning-light)] text-[var(--warning)]'
  }
}

function statusLabel(status: PluginViewModel['status']): string {
  switch (status) {
    case 'active': return 'Active'
    case 'inactive': return 'Inactive'
    case 'crashed': return 'Crashed'
    case 'discovered': return 'Discovered'
    case 'loaded': return 'Loaded'
  }
}

function trustBadgeClass(level: PluginViewModel['trustLevel']): string {
  return level === 'trusted'
    ? 'bg-[var(--accent-light)] text-[var(--accent)]'
    : 'bg-[var(--warning-light)] text-[var(--warning)]'
}

function sourceBadgeClass(source: PluginViewModel['source']): string {
  return source === 'built-in'
    ? 'bg-[var(--accent-light)] text-[var(--accent)]'
    : 'bg-[var(--hover-bg)] text-[var(--muted)]'
}

// Reset expanded when plugin list changes significantly
watch(() => store.installedPlugins.length, () => {
  if (expandedPluginId.value) {
    const exists = store.pluginById(expandedPluginId.value)
    if (!exists) expandedPluginId.value = null
  }
})
</script>

<template>
  <div class="max-w-[860px] mx-auto py-8 px-10">
    <!-- Header -->
    <div class="mb-7">
      <div class="font-display text-[22px] font-bold tracking-tight">Plugins</div>
      <div class="text-[12px] text-muted mt-1">Manage installed plugins, permissions, and configuration</div>
    </div>

    <!-- Plugin list -->
    <div v-if="hasPlugins" class="border border-border rounded-sm overflow-hidden mb-3">
      <!-- List header -->
      <div
        class="flex items-center justify-between py-[10px] px-4 bg-[var(--section-bg)] border-b border-border min-h-[42px]"
      >
        <span class="text-[13px] font-semibold">Installed Plugins</span>
        <span class="text-[10px] text-muted font-medium bg-[var(--hover-bg)] py-[2px] px-[6px] rounded-sm">
          {{ plugins.length }}
        </span>
      </div>

      <!-- Plugin rows -->
      <div
        v-for="plugin in plugins"
        :key="plugin.pluginId"
        :class="[
          'border-b border-[var(--divider)] last:border-b-0 transition-colors',
          { 'opacity-50': !plugin.enabled },
        ]"
      >
        <!-- Row header -->
        <div
          class="flex items-center gap-3 py-[9px] px-4 min-h-[42px] cursor-pointer hover:bg-[var(--hover-bg)]"
          @click="toggleExpand(plugin.pluginId)"
        >
          <!-- Toggle -->
          <ToggleSwitch
            :model-value="plugin.enabled"
            :disabled="plugin.source === 'built-in'"
            @update:model-value="handleToggle({ id: plugin.pluginId, enabled: !plugin.enabled })"
            @click.stop
          />

          <!-- Name + meta -->
          <div class="flex-1 min-w-0">
            <div class="text-[13px] font-semibold flex items-center gap-2 flex-wrap">
              {{ plugin.displayName }}
              <span class="text-[10px] font-semibold py-[1px] px-1.5 rounded-sm bg-[var(--accent-light)] text-[var(--accent)]">
                {{ plugin.version }}
              </span>
              <span
                class="text-[10px] font-medium py-[1px] px-1.5 rounded-sm"
                :class="statusBadgeClass(plugin.status)"
              >{{ statusLabel(plugin.status) }}</span>
              <span
                class="text-[10px] font-medium py-[1px] px-1.5 rounded-sm cursor-pointer hover:opacity-80"
                :class="trustBadgeClass(plugin.trustLevel)"
                @click.stop="plugin.trustLevel === 'sandbox' && requestTrustUpgrade(plugin)"
              >{{ plugin.trustLevel }}</span>
              <span
                class="text-[10px] font-medium py-[1px] px-1.5 rounded-sm"
                :class="sourceBadgeClass(plugin.source)"
              >{{ plugin.source }}</span>
            </div>
            <div v-if="plugin.description" class="text-[11px] text-muted mt-px line-clamp-1">
              {{ plugin.description }}
            </div>
          </div>

          <!-- Expand chevron -->
          <svg
            class="shrink-0 text-muted transition-transform duration-150"
            :class="{ 'rotate-180': expandedPluginId === plugin.pluginId }"
            width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2"
          >
            <path d="M2 4l3 3 3-3" />
          </svg>
        </div>

        <!-- Expanded detail -->
        <div
          v-if="expandedPluginId === plugin.pluginId"
          class="px-4 py-3 border-t border-[var(--divider)] bg-[var(--section-bg)]"
        >
          <!-- Meta info -->
          <MetaGrid :items="[
            { key: 'ID', value: plugin.pluginId },
            { key: 'Version', value: plugin.version },
            { key: 'Source', value: plugin.source },
            { key: 'Trust', value: plugin.trustLevel },
          ]" />

          <!-- Error message (crashed) -->
          <div
            v-if="plugin.status === 'crashed' && plugin.errorMessage"
            class="text-[11px] text-[var(--danger)] bg-[var(--danger-light)] rounded-sm px-3 py-2 mb-3"
          >
            {{ plugin.errorMessage }}
          </div>

          <!-- Permissions -->
          <div v-if="plugin.permissions.length > 0" class="mb-3">
            <div class="text-[12px] font-semibold text-muted mb-1.5">Approved Permissions</div>
            <div class="flex flex-wrap items-center gap-1.5">
              <span
                v-for="perm in plugin.permissions"
                :key="perm"
                class="text-[10px] font-mono py-[2px] px-1.5 rounded-sm bg-[var(--hover-bg)] text-muted"
              >{{ perm }}</span>
              <Button
                v-if="plugin.source !== 'built-in'"
                variant="ghost"
                size="sm"
                class="text-[10px] text-[var(--danger)]"
                @click="handleRevokePermissions(plugin.pluginId)"
              >Revoke All</Button>
            </div>
          </div>

          <!-- Contributions summary -->
          <div v-if="plugin.contributes" class="mb-3">
            <div class="text-[12px] font-semibold text-muted mb-1.5">Contributions</div>
            <div class="text-[11px] text-muted flex flex-wrap gap-x-4 gap-y-1">
              <span v-if="plugin.contributes.slashCommands?.length">
                Commands: {{ plugin.contributes.slashCommands.length }}
              </span>
              <span v-if="plugin.contributes.tools?.length">
                Tools: {{ plugin.contributes.tools.length }}
              </span>
              <span v-if="plugin.contributes.hooks?.length">
                Hooks: {{ plugin.contributes.hooks.length }}
              </span>
              <span v-if="plugin.contributes.panels?.length">
                Panels: {{ plugin.contributes.panels.length }}
              </span>
            </div>
          </div>

          <!-- Settings form -->
          <PluginSettingsForm
            v-if="plugin.contributes?.settings?.length"
            :plugin-id="plugin.pluginId"
            :settings="plugin.contributes.settings"
            :disabled="!plugin.enabled"
          />

          <!-- Uninstall button (external only) -->
          <div v-if="plugin.source !== 'built-in'" class="mt-3 pt-3 border-t border-[var(--divider)]">
            <Button variant="danger" size="sm" @click="confirmUninstall(plugin)">
              Uninstall
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="!store.loading"
      class="border border-border rounded-sm py-12 px-6 text-center"
    >
      <svg class="mx-auto mb-3 text-muted" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M12 8v8M8 12h8" />
      </svg>
      <div class="text-[13px] text-muted mb-1">No plugins installed</div>
      <div class="text-[11px] text-muted">
        Place plugins in <span class="font-mono">~/.xyz-agent/plugins/</span> to auto-discover
      </div>
    </div>

    <!-- Loading state -->
    <div
      v-if="store.loading"
      class="border border-border rounded-sm py-8 px-6 text-center"
    >
      <div class="text-[13px] text-muted">Loading plugins...</div>
    </div>

    <!-- Install hint -->
    <div class="text-[11px] text-muted mt-3 px-1">
      Manual install: place plugins in ~/.xyz-agent/plugins/ directory
    </div>

    <!-- Uninstall confirm dialog -->
    <Dialog
      :open="uninstallTarget !== null"
      :title="`Uninstall ${uninstallTarget?.displayName ?? 'Plugin'}`"
      @update:open="() => { uninstallTarget = null }"
    >
      <p class="text-sm leading-relaxed mb-4" style="color: var(--muted)">
        Are you sure you want to uninstall "{{ uninstallTarget?.displayName }}"? This action cannot be undone.
      </p>
      <div class="flex justify-end gap-2">
        <Button variant="outline" size="sm" @click="uninstallTarget = null">Cancel</Button>
        <Button variant="danger" size="sm" @click="doUninstall">Uninstall</Button>
      </div>
    </Dialog>

    <!-- Trust upgrade confirm dialog -->
    <Dialog
      :open="trustConfirmTarget !== null"
      title="Upgrade Trust Level"
      @update:open="() => { trustConfirmTarget = null }"
    >
      <p class="text-sm leading-relaxed mb-4" style="color: var(--muted)">
        Upgrading "{{ trustConfirmTarget?.displayName }}" to <span class="font-semibold text-[var(--fg)]">trusted</span> will allow the plugin to access more system resources. Only do this if you trust the plugin author.
      </p>
      <div class="flex justify-end gap-2">
        <Button variant="outline" size="sm" @click="trustConfirmTarget = null">Cancel</Button>
        <Button variant="primary" size="sm" @click="doTrustUpgrade">Confirm</Button>
      </div>
    </Dialog>

    <!-- Permission dialog -->
    <PluginPermissionDialog
      v-if="pendingPermissionEntry"
      :plugin-id="pendingPermissionEntry.id"
      :plugin-name="pendingPermissionEntry.name"
      :requested-permissions="pendingPermissionEntry.permissions"
      :visible="true"
      @confirm="handlePermissionConfirm"
      @cancel="handlePermissionCancel"
    />
  </div>
</template>
