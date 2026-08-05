<template>
  <!--
    Settings · Provider 菜单页（v6 spec §6.4 R4：手风琴就地编辑，取代 ProviderEditModal 双层 modal）。
    行布局：状态点 → 启用开关 → 名称(点击展开就地编辑) → 默认pill → 模型数 → dirty 徽章 → 删除。
    展开体：ProviderEditBody（凭据/模型/验证/额度 + sticky save-bar）。
    dirty 守卫：展开行有未保存改动时，切换/收起/新建 → ConfirmDialog 二次确认。
  -->
  <div class="flex flex-col gap-3">
    <header class="mb-3 flex items-start justify-between gap-4">
      <div class="min-w-0">
        <h1 class="text-[20px] font-semibold tracking-[-0.01em] text-neutral-fg">{{ t('settings.menu.provider') }}</h1>
        <p class="mt-2 text-sm text-neutral-mid">{{ t('settings.menu.providerDesc') }}</p>
      </div>
      <div class="flex shrink-0 gap-2">
        <ProviderImportMenu :disabled="importState !== 'idle'" @select="onImportSelect" />
        <Button
          class="gap-1.5 rounded-sm px-2.5 py-1.5 text-[12px] font-medium [&_svg]:size-3.5"
          @click="createAndExpand"
        >
          <Plus />
          {{ t('settings.provider.add') }}
        </Button>
      </div>
    </header>

    <!-- 常驻 inline error：toggle enabled / 设默认 / 删除 等动作失败时报错可见 -->
    <div
      v-if="actionError"
      data-testid="provider-action-error"
      class="flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger-soft px-3 py-1.5 text-[11px] text-danger"
    >
      <AlertCircle class="size-3.5 shrink-0" />
      <span class="truncate">{{ actionError }}</span>
    </div>

    <!-- 空状态 -->
    <div v-if="!providers.length && expandedId !== NEW_ID" class="flex flex-col items-center gap-2 py-16 text-center">
      <div class="grid size-16 place-items-center rounded-full border-2 border-dashed border-border-strong">
        <Settings class="size-7 text-neutral-dim" />
      </div>
      <p class="text-[14px] font-medium text-neutral-fg">{{ t('settings.provider.emptyTitle') }}</p>
      <p class="text-[12px] text-neutral-mid">{{ t('settings.provider.emptyDesc') }}</p>
    </div>

    <!-- 实体列表（含新建态合成行） -->
    <div
      v-for="p in renderList"
      :key="p.id"
      data-testid="provider-card"
      class="overflow-hidden rounded-card bg-card"
    >
      <!-- 行头 -->
      <div class="flex min-w-0 items-center gap-3 px-4 py-3">
        <span
          v-if="p.id !== NEW_ID"
          class="size-[7px] shrink-0 rounded-full"
          :class="statusDot(p.status)"
        />

        <!-- 启用开关（名称左侧）。新建态无开关 -->
        <Switch
          v-if="p.id !== NEW_ID"
          :model-value="p.enabled"
          class="shrink-0"
          :disabled="toggling.has(p.id)"
          :aria-label="`${p.name} ${t('settings.provider.colEnabled')}`"
          @click.stop
          @update:model-value="onToggleEnabled(p, $event)"
        />

        <!-- 供应商名称（点击展开/收起就地编辑） -->
        <span
          class="flex-1 cursor-pointer truncate text-[13px] font-medium text-neutral-fg"
          role="button"
          :aria-expanded="expandedId === p.id"
          @click="toggleExpand(p.id)"
        >{{ p.id === NEW_ID ? t('settings.provider.newProvider') : p.name }}</span>

        <!-- 默认供应商 pill -->
        <Button
          v-if="p.id !== NEW_ID && p.id === defaultProviderId"
          variant="ghost"
          class="h-auto shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent hover:bg-accent-soft"
        >{{ t('settings.provider.defaultPill') }}</Button>

        <span v-if="p.id !== NEW_ID" class="shrink-0 text-[11px] text-neutral-dim">{{ t('settings.provider.modelsCount', { count: p.models.length }) }}</span>

        <!-- dirty 徽章（展开编辑且有未保存改动时） -->
        <span
          v-if="expandedId === p.id && currentBodyDirty"
          data-testid="provider-dirty-badge"
          class="flex shrink-0 items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-[10px] font-semibold text-warn"
        >
          <span class="size-1.5 rounded-full bg-warn" />
          {{ t('settings.provider.unsavedBadge') }}
        </span>

        <span class="flex-1" />

        <!-- 删除按钮 -->
        <Button
          v-if="p.id !== NEW_ID"
          variant="ghost"
          class="size-6 shrink-0 rounded-sm p-0 text-neutral-dim hover:bg-danger-soft hover:text-danger [&_svg]:size-[13px]"
          :title="t('settings.provider.deleteTitle')"
          @click.stop="deleteTarget = p"
        >
          <Trash2 />
        </Button>
      </div>

      <!-- 展开就地编辑体（R4） -->
      <div v-if="expandedId === p.id" class="border-t border-border" data-testid="provider-expand-body">
        <ProviderEditBody
          :provider="p.id === NEW_ID ? null : p"
          @dirty-change="onBodyDirtyChange"
          @saved="onBodySaved"
          @cancel="onBodyCancel"
        />
      </div>
    </div>

    <!-- dirty 守卫确认弹窗（切换/收起/新建时拦截未保存改动） -->
    <ConfirmDialog
      v-model:open="guardDialogOpen"
      variant="default"
      :title="t('settings.provider.discardTitle')"
      :description="t('settings.provider.discardDesc')"
      :confirm-text="t('settings.provider.discardConfirm')"
      :cancel-text="t('settings.provider.discardCancel')"
      @confirm="confirmDiscard"
    />

    <!-- 删除确认弹窗 -->
    <ConfirmDialog
      v-model:open="deleteDialogOpen"
      variant="danger"
      :title="t('settings.provider.deleteConfirmTitle', { name: deleteTarget?.name ?? '' })"
      :description="t('settings.provider.deleteConfirmDesc')"
      :confirm-text="t('settings.provider.deleteConfirmBtn')"
      :cancel-text="t('settings.providerEdit.cancel')"
      :loading="deleting"
      @confirm="confirmDelete"
    >
      <p v-if="actionError" class="pt-2 text-[12px] text-danger">{{ actionError }}</p>
    </ConfirmDialog>

    <!-- 导入预览弹窗（W2） -->
    <ProviderImportPreviewDialog
      :open="importState === 'previewing' || importState === 'applying'"
      :import-id="importId ?? undefined"
      :preview="importPreview"
      :loading="importState === 'applying'"
      :error="importError"
      @update:open="onPreviewDialogToggle"
      @confirm="onImportConfirm"
    />
    <!-- R4 手风琴就地编辑 -->
  </div>
</template>

<script setup lang="ts">
import { computed, ref, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { Settings, Plus, Trash2, AlertCircle } from '@lucide/vue'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import type { ProviderInfo, ProviderStatus } from '@xyz-agent/shared'
import { config } from '@/api'
import { getSettingsStore } from '@xyz-agent/core'
import { useQuotaStore } from '@/stores/quota'
import { useProviderImport } from '@/composables/features/useProviderImport'
import { useQuotaConfigure } from '@/composables/features/useQuotaConfigure'
import { useToast } from '@/composables/useToast'
import {
  ProviderEditBody,
  ProviderImportMenu,
  ProviderImportPreviewDialog,
  SETTINGS_TOAST_KEY,
  USE_QUOTA_CONFIGURE_KEY,
} from '@xyz-agent/ui/features/settings'

// ProviderEditBody 迁入 ui 包，其 renderer 侧依赖（useQuotaConfigure/useToast）经
// provide/inject 注入（ui 零 renderer import 铁律）。ProviderEditBody 内部调用工厂。
provide(USE_QUOTA_CONFIGURE_KEY, useQuotaConfigure)
provide(SETTINGS_TOAST_KEY, useToast())

const props = defineProps<{ providers: ProviderInfo[] }>()

const { t } = useI18n()
const {
  importState,
  importId,
  importPreview,
  importError,
  onImportSelect,
  onImportConfirm,
  onPreviewDialogToggle,
} = useProviderImport()

/** toggle 中的 provider id 集合（防双击：API 期间 disable Switch） */
const toggling = ref<Set<string>>(new Set())

const settingsStore = getSettingsStore()
const defaultProviderId = computed(() => {
  const dm = settingsStore.defaultModel.value
  return dm ? dm.split('/')[0] : ''
})

/** 新建态 sentinel id（与真实 provider id 区分，渲染合成行 + null provider 进 ProviderEditBody） */
const NEW_ID = '__new__'

/** 当前展开的 provider id（单展开：null=无，NEW_ID=新建态，其它=编辑该 provider） */
const expandedId = ref<string | null>(null)
/** 当前展开 body 的 dirty 态（经 @dirty-change 上抛，用于切换守卫） */
const currentBodyDirty = ref(false)

/** 删除目标 + 删除中 */
const deleteTarget = ref<ProviderInfo | null>(null)
const deleting = ref(false)
const deleteDialogOpen = computed({
  get: () => deleteTarget.value !== null,
  set: (open: boolean) => {
    if (!open) deleteTarget.value = null
  },
})

/** 动作错误（删除/启用失败时显示，非静默吞） */
const actionError = ref('')

// ── dirty 守卫：切换/收起/新建前拦截 ──

/** 待执行的展开动作（confirmDiscard 后执行） */
type PendingAction =
  | { kind: 'collapse' }
  | { kind: 'switch'; id: string }
  | { kind: 'add' }
const pendingAction = ref<PendingAction | null>(null)
const guardDialogOpen = computed({
  get: () => pendingAction.value !== null,
  set: (open: boolean) => {
    if (!open) pendingAction.value = null
  },
})

/**
 * 展开切换入口（行头名称点击）：dirty 时拦截 → 确认后丢弃改动并执行目标动作。
 * - 点已展开行 → 收起（dirty 时先确认）
 * - 点未展开行 → 切换到该行（当前展开行 dirty 时先确认）
 */
function toggleExpand(id: string): void {
  if (expandedId.value === id) {
    // 收起
    if (currentBodyDirty.value) {
      pendingAction.value = { kind: 'collapse' }
      return
    }
    expandedId.value = null
    currentBodyDirty.value = false
    return
  }
  // 切换到其它行
  if (currentBodyDirty.value) {
    pendingAction.value = { kind: 'switch', id }
    return
  }
  expandedId.value = id
  currentBodyDirty.value = false
}

/**
 * 新建并展开（spec §9 旅程 A1：不弹窗；已有未保存改动时先走守卫）。
 * 列表底部追加合成行（id=NEW_ID），ProviderEditBody 收到 null provider → 新增态空表单。
 */
function createAndExpand(): void {
  if (expandedId.value !== null) {
    if (currentBodyDirty.value) {
      pendingAction.value = { kind: 'add' }
      return
    }
  }
  expandedId.value = NEW_ID
  currentBodyDirty.value = false
}

/** dirty 守卫确认 → 执行待定动作（展开体卸载即丢弃表单态，无需显式 reset） */
function confirmDiscard(): void {
  const action = pendingAction.value
  pendingAction.value = null
  if (!action) return
  currentBodyDirty.value = false
  if (action.kind === 'collapse') {
    expandedId.value = null
  } else if (action.kind === 'switch') {
    expandedId.value = action.id
  } else if (action.kind === 'add') {
    expandedId.value = NEW_ID
  }
}

// ── ProviderEditBody 事件处理 ──

function onBodyDirtyChange(v: boolean): void {
  currentBodyDirty.value = v
}

/** 保存成功 → 收起展开行（store 广播 onProviders 推回最新 provider 列表） */
function onBodySaved(): void {
  expandedId.value = null
  currentBodyDirty.value = false
}

/** 取消 → 收起（展开体卸载，表单态自然丢弃） */
function onBodyCancel(): void {
  expandedId.value = null
  currentBodyDirty.value = false
}

// ── 渲染列表：真实 providers + 新建态合成行 ──

const NEW_PROVIDER_SENTINEL: ProviderInfo = {
  id: NEW_ID,
  name: '',
  apiKeySet: false,
  status: 'not_configured',
  models: [],
}

const renderList = computed<ProviderInfo[]>(() => {
  return expandedId.value === NEW_ID
    ? [...props.providers, NEW_PROVIDER_SENTINEL]
    : props.providers
})

// ── 启用开关：乐观更新 store + config.setProvider 持久化 ──

async function onToggleEnabled(p: ProviderInfo, enabled: boolean) {
  if (toggling.value.has(p.id)) return
  actionError.value = ''
  const next = new Set(toggling.value)
  next.add(p.id)
  toggling.value = next
  const old = settingsStore.setProviderEnabled(p.id, enabled)
  try {
    await config.setProvider(p.id, { enabled })
    if (!enabled && settingsStore.defaultModel.value.startsWith(`${p.id}/`)) {
      settingsStore.defaultModel.value = ''
    }
  } catch (e) {
    settingsStore.setProviderEnabled(p.id, old)
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    const after = new Set(toggling.value)
    after.delete(p.id)
    toggling.value = after
  }
}

// ── 删除 ──

async function confirmDelete() {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  actionError.value = ''
  try {
    await config.deleteProvider(target.id)
    if (settingsStore.defaultModel.value.startsWith(`${target.id}/`)) {
      settingsStore.defaultModel.value = ''
    }
    useQuotaStore().clearCache(target.id)
    deleteTarget.value = null
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    deleting.value = false
  }
}

function statusDot(status: ProviderStatus): string {
  const map = { connected: 'bg-success', not_configured: 'bg-neutral-dim', error: 'bg-danger' }
  return map[status]
}
</script>

