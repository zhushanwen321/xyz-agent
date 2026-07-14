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
        添加供应商
      </Button>
    </div>

    <!-- 空状态 -->
    <div v-if="!providers.length" class="flex flex-col items-center gap-2 py-16 text-center">
      <div class="grid size-16 place-items-center rounded-full border-2 border-dashed border-border-strong">
        <Settings class="size-7 text-subtle" />
      </div>
      <p class="text-[14px] font-medium text-fg">还没有供应商</p>
      <p class="text-[12px] text-muted">添加第一个供应商，连接 AI 模型开始对话。</p>
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
          :aria-label="`${p.name} 启用开关`"
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
        >默认供应商</Button>

        <span class="shrink-0 text-[11px] text-subtle">{{ p.models.length }} 模型</span>

        <!-- 编辑 + 删除按钮 -->
        <Button
          variant="ghost"
          class="size-6 shrink-0 rounded-sm p-0 text-subtle hover:bg-surface-hover hover:text-fg [&_svg]:size-[13px]"
          title="编辑供应商"
          @click.stop="openEdit(p)"
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          class="size-6 shrink-0 rounded-sm p-0 text-subtle hover:bg-[rgba(239,68,68,0.12)] hover:text-danger [&_svg]:size-[13px]"
          title="删除供应商"
          @click.stop="deleteTarget = p"
        >
          <Trash2 />
        </Button>
      </div>

      <!-- 展开详情：凭据与连接 + 模型清单 -->
      <div v-if="expanded.has(p.id)" class="border-t border-border">
        <!-- 凭据与连接 -->
        <div class="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 px-4 py-3 text-[12px]">
          <span class="text-muted">API 类型</span>
          <span class="font-mono text-fg">{{ p.api ?? '-' }}</span>
          <span class="text-muted">Base URL</span>
          <span class="font-mono text-fg">{{ p.baseUrl ?? '-' }}</span>
          <span class="text-muted">API Key</span>
          <span class="text-fg">{{ p.apiKeySet ? '已配置' : '未配置' }}</span>
        </div>

        <!-- 模型清单表格 -->
        <div v-if="p.models.length" class="border-t border-border px-4 py-3">
          <p class="mb-2 text-[11px] uppercase tracking-wider text-muted">模型清单</p>
          <Table class="text-[12px]">
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead class="pb-1.5">模型</TableHead>
                <TableHead class="pb-1.5 text-center">输入</TableHead>
                <TableHead class="pb-1.5 text-right">上下文</TableHead>
                <TableHead class="pb-1.5 text-right">思考</TableHead>
                <TableHead class="pb-1.5 text-right">默认</TableHead>
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
                  <Button
                    variant="ghost"
                    class="h-auto rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-semibold hover:bg-transparent"
                    :class="thinkingPillClass(m)"
                    @click.stop="cycleThinking(p.id, m.id)"
                  >{{ thinkingLabel(m) }}</Button>
                </TableCell>
                <TableCell class="py-2 text-right">
                  <Button
                    v-if="!(p.id + '/' + m.id === defaultModel)"
                    variant="secondary"
                    class="h-auto rounded-sm px-1.5 py-0.5 text-[10px] text-subtle hover:border-info hover:text-info"
                    @click.stop="setDefaultModel(p.id, m.id)"
                  >设为默认</Button>
                  <span v-else class="rounded-sm bg-info/10 px-1.5 py-0.5 text-[10px] text-info">默认模型</span>
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
      :title="`删除 ${deleteTarget?.name ?? ''}？`"
      description="将移除其下所有模型配置。此操作不可撤销。"
      confirm-text="确认删除"
      cancel-text="取消"
      :loading="deleting"
      @confirm="confirmDelete"
    >
      <p v-if="actionError" class="pt-2 text-[12px] text-danger">{{ actionError }}</p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Settings, Plus, Pencil, Trash2, FileText, ImageIcon } from '@lucide/vue'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Switch } from '@/components/ui/switch'
import type { ProviderInfo } from '@xyz-agent/shared'
import { config } from '@/api'
import { useSettingsStore } from '@/stores/settings'
import ProviderEditModal from './ProviderEditModal.vue'

defineProps<{ providers: ProviderInfo[] }>()

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
function cycleThinking(_pid: string, _mid: string) { /* mock */ }

function formatCtx(v?: number): string {
  if (!v) return '--'
  if (v >= CONTEXT_M) return `${(v / CONTEXT_M).toFixed(v % CONTEXT_M === 0 ? 0 : 1)}M`
  return `${Math.round(v / CONTEXT_K)}K`
}

function thinkingLabel(m: { thinkingLevelMap?: Record<string, string | null> }): string {
  if (!m.thinkingLevelMap) return '开关'
  const v = Object.values(m.thinkingLevelMap)[0]
  if (v === null || v === undefined) return '开关'
  if (v.includes('xhigh') || v.includes('high')) return '高/顶'
  return '全档'
}

function thinkingPillClass(m: { thinkingLevelMap?: Record<string, string | null> }): string {
  const label = thinkingLabel(m)
  if (label === '全档') return 'bg-info/10 text-info'
  if (label === '高/顶') return 'bg-accent-soft text-accent'
  return 'bg-surface text-muted'
}

function statusDot(status: ProviderInfo['status']): string {
  const map = { connected: 'bg-success', not_configured: 'bg-subtle', error: 'bg-danger' }
  return map[status]
}
</script>
