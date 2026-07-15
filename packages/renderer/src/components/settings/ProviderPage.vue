<template>
  <!--
    Settings · Provider 菜单页（draft-provider.html §1-§5）。
    行布局：启用开关(左) → 名称(点击展开) → 默认pill → 模型数 → 编辑 → 删除
    模型表格：输入类型 icon + 上下文 + thinking pill + 默认按钮
  -->
  <div class="flex flex-col gap-3">
    <!-- page-header -->
    <div class="flex items-center justify-between">
      <span />
      <Button
        class="gap-1.5 rounded-sm px-2.5 py-1.5 text-[12px] font-medium [&_svg]:size-3.5"
        @click="openAdd"
      >
        <Plus />
        {{ t('settings.provider.add') }}
      </Button>
    </div>

    <!-- 常驻 inline error：toggle enabled / 设默认 / 删除 等动作失败时报错可见。
         不再只在删除弹窗 slot 内渲染（弹窗关闭时用户看不到）。 -->
    <div
      v-if="actionError"
      data-testid="provider-action-error"
      class="flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger-soft px-3 py-1.5 text-[11px] text-danger"
    >
      <AlertCircle class="size-3.5 shrink-0" />
      <span class="truncate">{{ actionError }}</span>
    </div>

    <!-- 空状态 -->
    <div v-if="!providers.length" class="flex flex-col items-center gap-2 py-16 text-center">
      <div class="grid size-16 place-items-center rounded-full border-2 border-dashed border-border-strong">
        <Settings class="size-7 text-subtle" />
      </div>
      <p class="text-[14px] font-medium text-fg">{{ t('settings.provider.emptyTitle') }}</p>
      <p class="text-[12px] text-muted">{{ t('settings.provider.emptyDesc') }}</p>
    </div>

    <!-- 实体列表 -->
    <div v-for="p in providers" :key="p.id" class="overflow-hidden rounded-md border border-border bg-bg">
      <!-- 行头 -->
      <div class="flex items-center gap-3 px-4 py-3">
        <span class="size-[7px] shrink-0 rounded-full" :class="statusDot(p.status)" />

        <!-- 启用开关（名称左侧）：Switch 原语。乐观更新——点击立即改 store，API 失败回滚。 -->
        <Switch
          :model-value="p.enabled"
          class="shrink-0"
          :disabled="toggling.has(p.id)"
          :aria-label="`${p.name} ${t('settings.provider.colEnabled')}`"
          @click.stop
          @update:model-value="onToggleEnabled(p, $event)"
        />

        <!-- 供应商名称（点击展开/收起） -->
        <span
          class="flex-1 cursor-pointer truncate text-[13px] font-medium text-fg"
          @click="toggleExpand(p.id)"
        >{{ p.name }}</span>

        <!-- 默认供应商 pill：仅当某 model 是默认时，其所属 provider 标记「默认供应商」。
             provider 级默认派生自 model 级默认（defaultModel 复合串的 provider 段），无独立语义，
             故去掉 provider 级「设为默认」按钮——设默认只在 model 行操作。 -->
        <Button
          v-if="p.id === defaultProviderId"
          variant="ghost"
          class="h-auto shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent hover:bg-accent-soft"
        >{{ t('settings.provider.defaultPill') }}</Button>

        <span class="shrink-0 text-[11px] text-subtle">{{ t('settings.provider.modelsCount', { count: p.models.length }) }}</span>

        <!-- 编辑 + 删除按钮 -->
        <Button
          variant="ghost"
          class="size-6 shrink-0 rounded-sm p-0 text-subtle hover:bg-surface-hover hover:text-fg [&_svg]:size-[13px]"
          :title="t('settings.provider.editTitle')"
          @click.stop="openEdit(p)"
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          class="size-6 shrink-0 rounded-sm p-0 text-subtle hover:bg-danger-soft hover:text-danger [&_svg]:size-[13px]"
          :title="t('settings.provider.deleteTitle')"
          @click.stop="deleteTarget = p"
        >
          <Trash2 />
        </Button>
      </div>

      <!-- 展开详情：凭据与连接 + 模型清单 -->
      <div v-if="expanded.has(p.id)" class="border-t border-border">
        <!-- 凭据与连接 -->
        <div class="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 px-4 py-3 text-[12px]">
          <span class="text-muted">{{ t('settings.provider.apiType') }}</span>
          <span class="font-mono text-fg">{{ p.api ?? '-' }}</span>
          <span class="text-muted">{{ t('settings.provider.baseUrl') }}</span>
          <span class="font-mono text-fg">{{ p.baseUrl ?? '-' }}</span>
          <span class="text-muted">{{ t('settings.provider.apiKey') }}</span>
          <span class="text-fg">{{ p.apiKeySet ? t('settings.provider.apiKeyConfigured') : t('settings.provider.apiKeyNotConfigured') }}</span>
        </div>

        <!-- 模型清单表格 -->
        <div v-if="p.models.length" class="border-t border-border px-4 py-3">
          <p class="mb-2 text-[11px] uppercase tracking-wider text-muted">{{ t('settings.provider.modelList') }}</p>
          <Table class="text-[12px]">
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead class="pb-1.5">{{ t('settings.provider.colModel') }}</TableHead>
                <TableHead class="pb-1.5 text-center">{{ t('settings.provider.colInput') }}</TableHead>
                <TableHead class="pb-1.5 text-right">{{ t('settings.provider.colContext') }}</TableHead>
                <TableHead class="pb-1.5 text-right">{{ t('settings.provider.colThinking') }}</TableHead>
                <TableHead class="pb-1.5 text-center">{{ t('settings.provider.colEnabled') }}</TableHead>
                <TableHead class="pb-1.5 text-right">{{ t('settings.provider.colDefault') }}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="m in p.models" :key="m.id">
                <TableCell class="py-2 font-mono text-fg">{{ m.id }}</TableCell>
                <!-- 输入类型 icon -->
                <TableCell class="py-2 text-center">
                  <div class="flex justify-center gap-0.5">
                    <FileText
                      class="size-3"
                      :class="m.input?.includes('text') ? 'text-info' : 'text-subtle opacity-30'"
                    />
                    <ImageIcon
                      class="size-3"
                      :class="m.input?.includes('image') ? 'text-info' : 'text-subtle opacity-30'"
                    />
                  </div>
                </TableCell>
                <TableCell class="py-2 text-right tabular-nums text-subtle">{{ formatCtx(m.contextWindow) }}</TableCell>
                <TableCell class="py-2 text-right">
                  <!-- thinking 仅展示，编辑入口在 ProviderEditModal 行内 Select（pickStrategy）。
                       列表页此 pill 不可点击（删除原空函数 cycleThinking）。 -->
                  <Button
                    variant="ghost"
                    data-testid="thinking-pill"
                    disabled
                    :title="t('settings.provider.thinkingEditHint')"
                    class="h-auto cursor-default rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-semibold hover:bg-transparent"
                    :class="thinkingPillClass(m)"
                  >{{ thinkingLabel(m) }}</Button>
                </TableCell>
                <!-- model 级 enabled 开关（D6）：乐观改 store + config.setProvider 持久化。
                     runtime setProvider 整体替换 models 数组（每个 model 与 base merge），
                     故必须传完整 models 数组，目标 model 翻转 enabled，其余保持当前 enabled。 -->
                <TableCell class="py-2 text-center">
                  <Switch
                    :model-value="m.enabled !== false"
                    data-testid="model-enabled-switch"
                    class="shrink-0"
                    :aria-label="`${m.id} ${t('settings.provider.colEnabled')}`"
                    @click.stop
                    @update:model-value="onToggleModelEnabled(p.id, m.id, $event)"
                  />
                </TableCell>
                <TableCell class="py-2 text-right">
                  <Button
                    v-if="!(p.id + '/' + m.id === defaultModel)"
                    variant="secondary"
                    class="h-auto rounded-sm px-1.5 py-0.5 text-[10px] text-subtle hover:border-info hover:text-info"
                    @click.stop="setDefaultModel(p.id, m.id)"
                  >{{ t('settings.provider.setDefault') }}</Button>
                  <span v-else class="rounded-sm bg-info-soft px-1.5 py-0.5 text-[10px] text-info">{{ t('settings.provider.defaultModel') }}</span>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>
    </div>

    <!-- 编辑/添加弹窗。open 与 provider 解耦：open 控制开关，provider 区分新增(null)/编辑(对象) -->
    <ProviderEditModal
      :open="dialogOpen"
      :provider="editingProvider"
      @close="closeDialog"
    />

    <!-- 删除确认弹窗（ConfirmDialog 原语：标题+描述+取消/危险确认；actionError 经默认 slot 注入） -->
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
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Settings, Plus, Pencil, Trash2, FileText, ImageIcon, AlertCircle } from '@lucide/vue'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Switch } from '@/components/ui/switch'
import type { ProviderInfo } from '@xyz-agent/shared'
import { config } from '@/api'
import { useSettingsStore } from '@/stores/settings'
import ProviderEditModal from './ProviderEditModal.vue'

const props = defineProps<{ providers: ProviderInfo[] }>()

const { t } = useI18n()

/** toggle 中的 provider id 集合（防双击：API 期间 disable Switch） */
const toggling = ref<Set<string>>(new Set())

// 上下文窗口格式化用的单位换算常量
const CONTEXT_K = 1000
const CONTEXT_M = 1_000_000

// 默认模型从 settingsStore.defaultModel 派生（"provider/modelId" 复合串）。
// store.defaultModel 由 config.onDefaults 订阅推回（runtime setDefaultModel 后广播），
// 故设默认后状态自动回流，组件无需本地乐观更新。
const settingsStore = useSettingsStore()
/** 当前默认模型复合串（"provider/modelId"），与 defaultModel 同源便于模板直接比对 */
const defaultModel = computed(() => settingsStore.defaultModel)
/** 默认模型所属 provider id（取复合串的 provider 段），用于行头「默认供应商」pill 高亮 */
const defaultProviderId = computed(() => {
  const dm = settingsStore.defaultModel
  return dm ? dm.split('/')[0] : ''
})

const expanded = ref(new Set<string>())
// editingProvider 与 dialogOpen 解耦：null 既表示新增，也曾被当作关闭信号，导致新增按钮无效
const editingProvider = ref<ProviderInfo | null>(null)
const dialogOpen = ref(false)
const deleteTarget = ref<ProviderInfo | null>(null)
const deleting = ref(false)
/** 删除弹窗开关：派生自 deleteTarget（有目标即开），关闭时清空目标 */
const deleteDialogOpen = computed({
  get: () => deleteTarget.value !== null,
  set: (open: boolean) => {
    if (!open) deleteTarget.value = null
  },
})

/** 打开新增弹窗 */
function openAdd(): void {
  editingProvider.value = null
  dialogOpen.value = true
}

/** 打开编辑弹窗 */
function openEdit(p: ProviderInfo): void {
  editingProvider.value = p
  dialogOpen.value = true
}

/** 关闭弹窗并清空编辑目标 */
function closeDialog(): void {
  dialogOpen.value = false
  editingProvider.value = null
}
/** 动作错误（删除/启用失败时显示，非静默吞） */
const actionError = ref('')

function toggleExpand(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/** 启用开关 → 乐观更新 store（开关即时滑动）+ config.setProvider 持久化 enabled。
 * 乐观：先改 store，UI 立即反应；失败回滚 store + 报错。
 * 广播回来时权威值覆盖 store（幂等：若值一致无副作用）。 */
async function onToggleEnabled(p: ProviderInfo, enabled: boolean) {
  if (toggling.value.has(p.id)) return
  actionError.value = ''
  const next = new Set(toggling.value)
  next.add(p.id)
  toggling.value = next
  const old = settingsStore.setProviderEnabled(p.id, enabled)
  try {
    await config.setProvider(p.id, { enabled })
    // 兜底：禁用 defaultModel 归属 provider 时清空前端 defaultModel（runtime 也会广播修正，幂等覆盖）。
    if (!enabled && settingsStore.defaultModel.startsWith(`${p.id}/`)) {
      settingsStore.defaultModel = ''
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

/** 确认删除 → config.deleteProvider（状态经 onProviders 订阅推回）。
 * 失败时保留弹窗 + 显示错误，供用户重试/查看。 */
async function confirmDelete() {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  actionError.value = ''
  try {
    await config.deleteProvider(target.id)
    // 兜底：删除 defaultModel 归属 provider 时清空前端 defaultModel（runtime 也会广播修正，幂等覆盖）。
    if (settingsStore.defaultModel.startsWith(`${target.id}/`)) {
      settingsStore.defaultModel = ''
    }
    deleteTarget.value = null
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    deleting.value = false
  }
}

/** 设为默认模型（model 行触发）：调 config.setDefaultModel 持久化，
 *  状态经 onDefaults 订阅推回 settingsStore.defaultModel，无需本地乐观更新。 */
async function setDefaultModel(providerId: string, modelId: string) {
  actionError.value = ''
  try {
    await config.setDefaultModel(providerId, modelId)
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  }
}

/** model 级 enabled 开关（D6）：乐观改 store model.enabled + config.setProvider 持久化。
 *  runtime setProvider 整体替换 models 数组（每个 model 与 base merge），故传完整 models 数组。
 *  乐观更新后从 store 读取新鲜 models（闭包中的 p.models 在 setModelEnabled 后已过期），
 *  确保 API 请求反映最新状态。失败回滚 store + 报错。 */
async function onToggleModelEnabled(
  providerId: string,
  modelId: string,
  enabled: boolean,
) {
  actionError.value = ''
  const old = settingsStore.setModelEnabled(providerId, modelId, enabled)
  try {
    // 从 store 读取乐观更新后的新鲜 provider（闭包 p 已过期）。
    // fallback：store 未含该 provider 时（如 props 传入但 store 未同步）用 props 传入的 models。
    const fresh = settingsStore.providers.find((x) => x.id === providerId)
    const modelsToSend = fresh
      ? fresh.models.map((m) => ({
        id: m.id,
        name: m.name,
        api: m.api,
        baseUrl: m.baseUrl,
        contextWindow: m.contextWindow,
        input: m.input,
        thinkingLevelMap: m.thinkingLevelMap,
        enabled: m.enabled,
      }))
      : props.providers.find((x) => x.id === providerId)?.models.map((m) => ({
        id: m.id,
        name: m.name,
        api: m.api,
        baseUrl: m.baseUrl,
        contextWindow: m.contextWindow,
        input: m.input,
        thinkingLevelMap: m.thinkingLevelMap,
        enabled: m.id === modelId ? enabled : (m.enabled ?? true),
      })) ?? []
    await config.setProvider(providerId, { models: modelsToSend })
  } catch (e) {
    settingsStore.setModelEnabled(providerId, modelId, old)
    actionError.value = e instanceof Error ? e.message : String(e)
  }
}

function formatCtx(v?: number): string {
  if (!v) return '--'
  if (v >= CONTEXT_M) return `${(v / CONTEXT_M).toFixed(v % CONTEXT_M === 0 ? 0 : 1)}M`
  return `${Math.round(v / CONTEXT_K)}K`
}

/**
 * 思考策略语义分类（locale 无关的稳定 key）。
 * thinkingLevelMap 为空或首值 null → 'toggle'（仅开关）；
 * 含 high/xhigh → 'hightop'；其余 → 'all'（全档）。
 */
type ThinkingKind = 'toggle' | 'hightop' | 'all'

function thinkingKind(m: { thinkingLevelMap?: Record<string, string | null> }): ThinkingKind {
  if (!m.thinkingLevelMap) return 'toggle'
  const v = Object.values(m.thinkingLevelMap)[0]
  if (v === null || v === undefined) return 'toggle'
  if (v.includes('xhigh') || v.includes('high')) return 'hightop'
  return 'all'
}

function thinkingLabel(m: { thinkingLevelMap?: Record<string, string | null> }): string {
  const kind = thinkingKind(m)
  const key = kind === 'all' ? 'settings.provider.thinkingAll'
    : kind === 'hightop' ? 'settings.provider.thinkingHighTop'
      : 'settings.provider.thinkingToggle'
  return t(key)
}

function thinkingPillClass(m: { thinkingLevelMap?: Record<string, string | null> }): string {
  const kind = thinkingKind(m)
  if (kind === 'all') return 'bg-info-soft text-info'
  if (kind === 'hightop') return 'bg-accent-soft text-accent'
  return 'bg-surface text-muted'
}

function statusDot(status: ProviderInfo['status']): string {
  const map = { connected: 'bg-success', not_configured: 'bg-subtle', error: 'bg-danger' }
  return map[status]
}
</script>
