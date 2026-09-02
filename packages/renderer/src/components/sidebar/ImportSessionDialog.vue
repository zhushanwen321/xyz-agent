<template>
  <Dialog :open="props.open" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-[620px]" data-testid="import-session-dialog">
      <DialogHeader>
        <DialogTitle>{{ t('importSession.title') }}</DialogTitle>
        <DialogDescription>{{ t('importSession.description') }}</DialogDescription>
      </DialogHeader>

      <!-- 搜索：名称 / Session ID / 短 ID / 绝对路径。'/' 或 '~' 开头切路径模式（D5 S7：
           renderer 切形态，runtime 无分支——sourcePath includes 匹配天然覆盖） -->
      <Input
        v-model="query"
        :placeholder="t('importSession.searchPlaceholder')"
        data-testid="import-search-input"
        autocomplete="off"
      />

      <!-- 目录 chip 行：全部目录 + 各一层子目录；tooltip 声明扫描深度假设（D3/S8）；右侧可见计数 -->
      <div class="flex items-center gap-2">
        <div class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-1">
          <Button
            variant="ghost"
            size="sm"
            data-testid="import-dir-chip"
            class="h-7 shrink-0 rounded-full border px-3 py-1 text-xs"
            :class="selectedDir === '' ? activeChipClass : idleChipClass"
            :title="t('importSession.dirScanHint')"
            @click="selectedDir = ''"
          >
            {{ t('importSession.allDirs') }}
          </Button>
          <Button
            v-for="d in dirs"
            :key="d.label"
            variant="ghost"
            size="sm"
            data-testid="import-dir-chip"
            class="h-7 shrink-0 rounded-full border px-3 py-1 text-xs"
            :class="selectedDir === d.label ? activeChipClass : idleChipClass"
            :title="t('importSession.dirScanHint')"
            @click="selectedDir = selectedDir === d.label ? '' : d.label"
          >
            {{ d.label }}
          </Button>
        </div>
        <!-- 「选择其他目录」（V8）：切扫描根重拉；虚线边框区分于筛选态 chip。
             自定义根时 title 展示根路径（观察者可见当前扫描位置） -->
        <Button
          variant="ghost"
          size="sm"
          data-testid="import-choose-dir-btn"
          class="h-7 shrink-0 rounded-full border border-dashed px-3 py-1 text-xs text-neutral-mid hover:text-neutral-fg"
          :title="rootDir ?? t('importSession.dirScanHint')"
          @click="chooseRootDir()"
        >
          {{ t('importSession.chooseDirBtn') }}
        </Button>
        <span
          v-if="rootDir"
          data-testid="import-root-dir"
          class="max-w-[140px] shrink-0 truncate font-mono text-[length:var(--text-3xs)] text-neutral-dim"
          :title="rootDir"
        >{{ rootDir }}</span>
        <span class="shrink-0 text-xs text-neutral-dim">
          {{ t('importSession.sessionCount', { count: filteredItems.length }) }}
        </span>
      </div>

      <!-- 路径模式（query 以 '/' 或 '~' 开头）：列表隐藏，路径行展示命中元信息 + 直达导入（demo 方案 A path-bar） -->
      <div
        v-if="isPathMode"
        data-testid="import-path-bar"
        class="flex items-center gap-2 rounded-md border border-border px-3 py-2"
      >
        <span class="min-w-0 flex-1 truncate font-mono text-[length:var(--text-3xs)] text-neutral-fg">
          {{ query.trim() }}
        </span>
        <span
          data-testid="import-path-meta"
          class="shrink-0 text-[length:var(--text-3xs)] text-neutral-dim"
        >
          {{ pathHit ? `${formatSize(pathHit.size)} · ${formatRelativeTime(pathHit.lastModified)}` : t('importSession.pathNoMatch') }}
        </span>
        <Button
          variant="ghost"
          size="sm"
          data-testid="import-path-import-btn"
          class="h-6 shrink-0 rounded-sm px-2 text-xs"
          :disabled="!pathHit || pathHit.alreadyImported || importing"
          @click="pathHit && importSession(pathHit)"
        >
          {{ t('importSession.pathImportBtn') }}
        </Button>
      </div>

      <!-- 候选列表：按 今天/昨天/更早 分组（分组头 + 条目行） -->
      <ScrollArea v-else class="h-[320px]">
        <div class="pr-2">
          <div
            v-if="loading"
            data-testid="import-loading"
            class="px-2 py-8 text-center text-sm text-neutral-mid"
          >
            {{ t('importSession.loading') }}
          </div>
          <div v-else-if="loadFailed" class="flex flex-col items-center gap-2 px-2 py-8">
            <p class="text-sm text-neutral-mid">{{ t('importSession.loadFailed') }}</p>
            <Button variant="ghost" size="sm" data-testid="import-retry-btn" @click="fetchCandidates">
              {{ t('importSession.retry') }}
            </Button>
          </div>
          <div
            v-else-if="groups.length === 0"
            data-testid="import-empty"
            class="px-2 py-8 text-center text-sm text-neutral-mid"
          >
            {{ t('importSession.emptyResult') }}
          </div>
          <template v-else v-for="group in groups" :key="group.key">
            <div class="px-1 pb-1 pt-3 text-xs font-medium text-neutral-dim">{{ group.label }}</div>
            <div
              v-for="item in group.items"
              :key="item.sessionId"
              data-testid="import-item"
              class="mb-1 cursor-pointer rounded-md border px-3 py-2 transition-colors"
              :class="[
                selectedId === item.sessionId
                  ? 'border-accent-ring bg-surface'
                  : 'border-transparent hover:bg-surface-hover',
                item.alreadyImported ? 'opacity-50' : '',
              ]"
              @click="select(item.sessionId)"
            >
              <div class="flex min-w-0 items-center gap-2">
                <span class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim">
                  {{ shortId(item) }}
                </span>
                <span class="min-w-0 flex-1 truncate text-sm text-neutral-fg">
                  {{ item.name || item.dirLabel }}
                </span>
                <span
                  v-if="item.alreadyImported"
                  data-testid="import-item-imported"
                  class="shrink-0 rounded-sm bg-accent-soft px-1 py-0.5 text-[length:var(--text-3xs)] leading-none text-accent"
                >{{ t('importSession.importedBadge') }}</span>
                <span class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim">
                  {{ formatSize(item.size) }} · {{ formatRelativeTime(item.lastModified) }}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="import-item-import-btn"
                  class="h-6 shrink-0 rounded-sm px-2 text-xs"
                  :disabled="item.alreadyImported || importing"
                  @click.stop="importSession(item)"
                >
                  {{ t('importSession.importBtn') }}
                </Button>
              </div>
              <div class="mt-1 flex min-w-0 items-center gap-2">
                <span class="min-w-0 flex-1 truncate font-mono text-[length:var(--text-3xs)] text-neutral-dim">
                  {{ item.sourcePath }}
                </span>
                <span
                  v-if="!item.cwdExists"
                  data-testid="import-item-cwd-missing"
                  class="shrink-0 text-[length:var(--text-3xs)] text-warn"
                >{{ t('importSession.cwdMissing') }}</span>
              </div>
            </div>
          </template>
        </div>
      </ScrollArea>

      <!-- 导入失败：内联恢复指引（error envelope code → 文案映射，不弹系统对话框） -->
      <p v-if="importErrorCode" data-testid="import-error" class="text-xs text-danger">
        {{ t(`importSession.errors.${importErrorCode}`) }}
      </p>

      <!-- 底部：导入目标 project（默认当前活跃）+ 取消 / 导入 -->
      <div class="flex items-center gap-2">
        <span class="shrink-0 text-sm text-neutral-mid">{{ t('importSession.importTo') }}</span>
        <Select v-model="selectedProjectId">
          <SelectTrigger class="h-8 w-[180px] px-2 text-xs" data-testid="import-project-select">
            <!-- SelectValue 自动 label 依赖 optionsSet（SelectItem 渲染时注册），初始未打开
                 下拉时为空——slot 覆盖为自算名，保证「默认当前激活 project」打开即可见 -->
            <SelectValue>{{ selectedProjectName }}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="p in projectStore.recentProjects"
              :key="p.id"
              :value="p.id"
            >
              {{ p.name || t('importSession.defaultProjectName') }}
            </SelectItem>
          </SelectContent>
        </Select>
        <div class="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" data-testid="import-cancel-btn" @click="onCancel">
            {{ t('importSession.cancel') }}
          </Button>
          <Button
            size="sm"
            :disabled="!canConfirm"
            data-testid="import-confirm-btn"
            @click="onConfirm"
          >
            {{ importing ? t('importSession.importing') : t('importSession.importBtn') }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { formatRelativeTime } from '@/composables/logic/formatTime'
import {
  useImportSession,
  type ImportSessionImportedPayload,
} from '@/composables/features/sidebar/useImportSession'
import { useProjectStore } from '@/stores/project'
import type { ImportCandidate } from '@xyz-agent/shared'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  imported: [payload: ImportSessionImportedPayload]
}>()

const { t } = useI18n()
const projectStore = useProjectStore()

const {
  open: dialogOpen,
  query,
  dirs,
  loading,
  loadFailed,
  selectedDir,
  rootDir,
  chooseRootDir,
  selectedProjectId,
  selectedProjectName,
  selectedId,
  importing,
  importErrorCode,
  filteredItems,
  isPathMode,
  pathHit,
  selectedItem,
  canConfirm,
  close,
  resetForOpen,
  select,
  importSession,
  fetchCandidates,
} = useImportSession({ onImported: (payload) => emit('imported', payload) })

const activeChipClass = 'border-accent-ring bg-accent-soft text-accent'
const idleChipClass = 'border-border text-neutral-mid hover:text-neutral-fg'

// prop → composable：父层打开时重置状态并首拉；关闭时同步收起 + 取消 pending debounce
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) resetForOpen()
    else close()
  },
  { immediate: true },
)

// composable → prop：导入成功后的 close() 需传导回父层（v-model:open 收口）
watch(dialogOpen, (isOpen) => {
  if (!isOpen && props.open) emit('update:open', false)
})

function onOpenChange(value: boolean): void {
  emit('update:open', value)
}

function onCancel(): void {
  emit('update:open', false)
  close()
}

/** 底部确认导入：作用于当前点选条目（按钮可用性由 canConfirm 保证） */
function onConfirm(): void {
  const item = selectedItem.value
  if (item) void importSession(item)
}

interface ImportGroup {
  key: 'today' | 'yesterday' | 'earlier'
  label: string
  items: ImportCandidate[]
}

const GROUP_KEYS = ['today', 'yesterday', 'earlier'] as const

/** 目录过滤后的可见候选按 lastModified 归入 今天/昨天/更早 三组（空组不渲染） */
const groups = computed<ImportGroup[]>(() => {
  const now = new Date()
  const today = now.toDateString()
  const yesterdayDate = new Date(now)
  yesterdayDate.setDate(now.getDate() - 1)
  const yesterday = yesterdayDate.toDateString()
  const buckets: Record<(typeof GROUP_KEYS)[number], ImportCandidate[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  }
  for (const item of filteredItems.value) {
    const dateKey = new Date(item.lastModified).toDateString()
    if (dateKey === today) buckets.today.push(item)
    else if (dateKey === yesterday) buckets.yesterday.push(item)
    else buckets.earlier.push(item)
  }
  return GROUP_KEYS.map((key) => ({
    key,
    label: t(`importSession.group.${key}`),
    items: buckets[key],
  })).filter((group) => group.items.length > 0)
})

/** 短 ID = uuid 前 6 位（等宽展示，D5 匹配语义同款截断） */
const SHORT_ID_LENGTH = 6

function shortId(item: ImportCandidate): string {
  return item.sessionId.slice(0, SHORT_ID_LENGTH)
}

/** 文件大小人类可读（B/KB/MB，一位小数） */
const BYTES_PER_KB = 1024
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB

function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} B`
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`
}
</script>
