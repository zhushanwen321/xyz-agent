<script setup lang="ts">
/**
 * Provider 导入预览对话框（W2 · cw-2026-07-26-migration-other-agents）。
 *
 * 展示 previewImportProviders 返回的脱敏 provider 列表（含冲突/key 缺失/警告），
 * 用户勾选后 emit('confirm', selectedIds) 给父组件驱动 applyImportProviders。
 *
 * 设计：
 * - selected 用 Set<id>：默认勾选 conflict='none' 的项，冲突项默认不勾。
 * - watch(preview) 重置 selected（每次新 preview 进来都重新初始化默认勾选）。
 * - 冲突项 Checkbox 禁用（已存在同名，导入必然 skipped）。
 * - credentialType 多态徽章：plaintext 不显 / env 蓝「$ENV」/ missing 橙「需手填」/ oauth 灰「OAuth·Phase2」/ command 红「!命令」；warnings 非空用 div toggle 展开。
 *
 * 复用 xyz-ui 的 Dialog/Checkbox/Button，禁止原生 form 元素。
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, Checkbox, Button } from '@xyz-agent/ui'
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CheckboxCheckedState as CheckedState } from 'reka-ui'
import { KeyRound, AlertTriangle, Loader2, ChevronRight, ChevronDown } from '@lucide/vue'

import type { ProviderImportPreview } from '@xyz-agent/shared'

const props = defineProps<{
  /** 受控开关（配合 v-model:open） */
  open: boolean
  /** preview 缓存 id（父透传，confirm 时父用此 id 调 apply） */
  importId?: string
  /** 预览数据（null 时按 loading/error 态处理） */
  preview?: ProviderImportPreview | null
  /** 加载中（preview 拉取中） */
  loading?: boolean
  /** 内联错误（preview/apply 失败时显示，允许重试） */
  error?: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  /** 用户确认导入，把选中的 provider id 传给父组件 */
  'confirm': [selectedIds: string[]]
}>()

const { t } = useI18n()

/** 选中的 provider id 集合（默认勾选 conflict='none' 的项） */
const selected = ref<Set<string>>(new Set())

/**
 * 初始化 selected：preview 变化时，把 conflict='none' 的项全部加入（默认勾选），
 * 冲突项（duplicate-id）默认不勾。立即触发（preview 由空 → 有数据时初始化默认勾选）。
 */
watch(
  () => props.preview,
  (pv) => {
    const next = new Set<string>()
    if (pv) {
      for (const p of pv.providers) {
        if (p.conflict === 'none') next.add(p.id)
      }
    }
    selected.value = next
  },
  { immediate: true },
)

function onToggle(id: string, value: CheckedState): void {
  const checked = value === true
  const next = new Set(selected.value)
  if (checked) next.add(id)
  else next.delete(id)
  selected.value = next
}

// ── warnings 折叠（按 provider id 索引）：用 div toggle 替代原生 <details>，
//    遵循禁原生交互元素规范（参考 MermaidRenderer.vue 的失败态源码折叠）。──
const expandedWarnings = ref<Set<string>>(new Set())

function toggleWarnings(id: string): void {
  const next = new Set(expandedWarnings.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedWarnings.value = next
}

// ── 统计（底部摘要）──
const statImportable = computed(() => props.preview?.providers.filter((p) => p.conflict === 'none').length ?? 0)
const statConflict = computed(() => props.preview?.providers.filter((p) => p.conflict === 'duplicate-id').length ?? 0)
const statKeyMissing = computed(() => props.preview?.providers.filter((p) => p.credentialType === 'missing').length ?? 0)
const statEnvCount = computed(() => props.preview?.providers.filter((p) => p.credentialType === 'env').length ?? 0)

/** 是否有可确认的勾选（≥1 选中且非 applying） */
const canConfirm = computed(() => selected.value.size > 0 && !props.loading)

function onCancel(): void {
  emit('update:open', false)
}

function onConfirm(): void {
  if (!canConfirm.value) return
  emit('confirm', Array.from(selected.value))
}

function sourceLabel(source: string): string {
  return t(`settings.loadPaths.sourceLabels.${source}`)
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent hide-close class="max-w-[520px]">
      <DialogHeader>
        <DialogTitle>{{ t('settings.provider.importPreview.title', { source: preview ? sourceLabel(preview.source) : '' }) }}</DialogTitle>
        <DialogDescription>{{ t('settings.provider.importPreview.description') }}</DialogDescription>
      </DialogHeader>

      <!-- 加载中 -->
      <div v-if="loading" class="flex items-center gap-2 py-8 text-[12px] text-neutral-mid">
        <Loader2 class="size-4 animate-spin" />
        {{ t('settings.loadPaths.importFromAgents.loading') }}
      </div>

      <!-- 内联错误（允许重试：保持对话框开） -->
      <div
        v-else-if="error"
        data-testid="preview-error"
        class="flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger"
      >
        <AlertTriangle class="size-4 shrink-0" />
        <span class="truncate">{{ error }}</span>
      </div>

      <template v-else-if="preview">
        <!-- B2：源配置解析错误横幅（部分损坏场景，providers 可能仍非空可导入） -->
        <div
          v-if="preview.parseError"
          data-testid="preview-parse-error"
          class="flex items-start gap-1.5 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[12px] text-warn"
        >
          <AlertTriangle class="size-4 shrink-0 mt-0.5" />
          <span>{{ t('settings.provider.importPreview.parseError', { message: preview.parseError }) }}</span>
        </div>

        <!-- S5：顶层丢弃警告横幅（如「N 个 provider 因协议不支持被跳过」） -->
        <div
          v-if="preview.warnings?.length"
          data-testid="preview-top-warnings"
          class="flex items-start gap-1.5 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[12px] text-warn"
        >
          <AlertTriangle class="size-4 shrink-0 mt-0.5" />
          <ul class="flex flex-col gap-0.5">
            <li v-for="(w, i) in preview.warnings" :key="i">{{ w }}</li>
          </ul>
        </div>

        <!-- 空列表（无 parseError 也无 providers） -->
        <div v-if="!preview.providers.length" class="py-8 text-center text-[12px] text-neutral-mid">
          {{ t('settings.providerEdit.noModels') }}
        </div>

        <!-- provider 列表 -->
        <div v-else class="flex flex-col gap-1.5">
        <div
          v-for="p in preview.providers"
          :key="p.id"
          data-testid="preview-provider-item"
          class="rounded-card bg-card px-3 py-2 text-[12px]"
          :class="{ 'opacity-70': p.conflict === 'duplicate-id' }"
        >
          <div class="flex items-center gap-2">
            <Checkbox
              :model-value="selected.has(p.id)"
              :disabled="p.conflict === 'duplicate-id' || loading"
              :aria-label="p.name"
              @update:model-value="onToggle(p.id, $event)"
            />
            <span class="font-mono text-neutral-fg">{{ p.id }}</span>
            <span class="rounded-sm bg-surface px-1.5 py-0.5 text-[10px] text-neutral-mid">{{ p.protocol }}</span>
            <span class="text-neutral-dim">{{ t('settings.provider.modelsCount', { count: p.modelCount }) }}</span>

            <!-- 凭据形态徽章（wave 4 import-credential-types）：plaintext 不渲染，其余四态多态徽章 -->
            <span
              v-if="p.credentialType === 'env'"
              data-testid="credential-badge-env"
              class="rounded-sm bg-info-soft px-1.5 py-0.5 text-[10px] text-info"
              :title="t('settings.provider.importPreview.credentialEnvHint', { var: p.envVarName })"
            >$ENV</span>
            <span
              v-else-if="p.credentialType === 'missing'"
              data-testid="credential-badge-missing"
              class="flex items-center gap-0.5 rounded-sm bg-warn-soft px-1.5 py-0.5 text-[10px] text-warn"
              :title="t('settings.provider.importPreview.keyNotExtracted')"
            >
              <KeyRound class="size-3" />
              {{ t('settings.provider.importPreview.credentialMissing') }}
            </span>
            <span
              v-else-if="p.credentialType === 'oauth'"
              data-testid="credential-badge-oauth"
              class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent-fg"
            >{{ t('settings.provider.importPreview.credentialOauth') }}</span>
            <span
              v-else-if="p.credentialType === 'command'"
              data-testid="credential-badge-command"
              class="rounded-sm bg-danger-soft px-1.5 py-0.5 text-[10px] text-danger"
              :title="t('settings.provider.importPreview.credentialCommandHint')"
            >{{ t('settings.provider.importPreview.credentialCommand') }}</span>

            <!-- 冲突标记 -->
            <span
              v-if="p.conflict === 'duplicate-id'"
              data-testid="conflict-badge"
              class="rounded-sm bg-warn-soft px-1.5 py-0.5 text-[10px] text-warn"
            >
              {{ t('settings.provider.importPreview.conflict') }}
            </span>
          </div>

          <!-- 警告（可展开）：用 div toggle 替代原生 <details>，遵循禁原生交互元素规范 -->
          <div v-if="p.warnings.length" class="mt-1 pl-6">
            <Button
              variant="ghost"
              size="dense"
              data-testid="warnings-toggle"
              class="h-5 px-1 text-[11px] text-neutral-mid hover:text-neutral-fg"
              @click="toggleWarnings(p.id)"
            >
              <component :is="expandedWarnings.has(p.id) ? ChevronDown : ChevronRight" class="size-3" />
              {{ t('settings.provider.importPreview.warnings') }} ({{ p.warnings.length }})
            </Button>
            <ul v-if="expandedWarnings.has(p.id)" class="mt-1 list-disc pl-4 text-[11px] text-warn">
              <li v-for="(w, i) in p.warnings" :key="i">{{ w }}</li>
            </ul>
          </div>
        </div>

        <!-- 底部统计 -->
        <div class="flex flex-wrap gap-3 pt-1 text-[11px] text-neutral-mid">
          <span>{{ t('settings.provider.importPreview.statImportable', { count: statImportable }) }}</span>
          <span>{{ t('settings.provider.importPreview.statConflict', { count: statConflict }) }}</span>
          <span>{{ t('settings.provider.importPreview.statKeyMissing', { count: statKeyMissing }) }}</span>
          <span v-if="statEnvCount > 0">{{ t('settings.provider.importPreview.statEnvCount', { count: statEnvCount }) }}</span>
        </div>
        </div>
      </template>

      <!-- 底部按钮 -->
      <div class="flex justify-end gap-2 pt-2">
        <Button variant="ghost" :disabled="loading" @click="onCancel">
          {{ t('settings.provider.importPreview.cancel') }}
        </Button>
        <Button data-testid="confirm-import-btn" :disabled="!canConfirm" @click="onConfirm">
          {{ t('settings.provider.importPreview.confirm') }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
