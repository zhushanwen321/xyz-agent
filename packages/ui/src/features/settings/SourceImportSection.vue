<template>
  <!--
    从其他 Agent 导入（W1 · cw-2026-07-26-migration-other-agents）。
    检测本机已安装的源 agent（claude/codex/pi/zcode），把其 skill/agent 目录
    一键追加到 discovery 列表，免去用户手输绝对路径。

    - kind='skill'：显示全部 4 源（取 skillCount）
    - kind='agent'：只显示 claude（优先取 agentCount，未提供时回退 skillCount）
    - kind='extension'：W1 不处理（显示提示，无候选）
    共享池检测：候选 dir 与 existingDirs normalize 后相等 → 标「已通过共享池生效」，默认不勾选。
  -->
  <section data-testid="import-from-agents" class="rounded-md border border-border bg-bg">
    <h4 class="px-3 py-2 text-[12px] font-medium text-neutral-fg">
      {{ t('settings.loadPaths.importFromAgents.title') }}
    </h4>

    <div v-if="loading" class="border-t border-border px-3 py-2 text-[11px] text-neutral-mid">
      {{ t('settings.loadPaths.importFromAgents.loading') }}
    </div>

    <div
      v-else-if="error"
      data-testid="detect-error"
      class="border-t border-border px-3 py-2 text-[11px] text-danger"
    >
      {{ t('settings.loadPaths.importFromAgents.detectError') }}
    </div>

    <template v-else>
      <p
        v-if="kind === 'agent'"
        class="border-t border-border px-3 py-1.5 text-[11px] text-neutral-dim"
      >
        {{ t('settings.loadPaths.importFromAgents.agentOnlyClaudeHint') }}
      </p>

      <div
        v-for="item in candidates"
        :key="item.source"
        data-testid="import-candidate"
        class="flex items-center gap-2 border-t border-border px-3 py-2 text-[12px]"
        :class="{ 'opacity-60': !item.installed || isShared(item.dir) }"
      >
        <Checkbox
          :model-value="selected.has(item.source)"
          :disabled="!item.installed || isShared(item.dir) || disabled"
          :aria-label="t('settings.loadPaths.enableDir', { path: item.dir })"
          @update:model-value="onToggle(item.source, $event)"
        />
        <span class="text-neutral-fg">{{ sourceLabel(item.source) }}</span>
        <span class="font-mono text-neutral-mid">{{ item.dir }}</span>
        <span v-if="!item.installed" class="text-neutral-dim">
          {{ t('settings.loadPaths.importFromAgents.notInstalled') }}
        </span>
        <span v-else class="text-neutral-mid">{{ countLabel(item) }}</span>
        <span v-if="isShared(item.dir)" class="text-neutral-dim">
          {{ t('settings.loadPaths.importFromAgents.sharedPoolActive') }}
        </span>
      </div>

      <div v-if="hasInstalledCandidate" class="border-t border-border px-3 py-2">
        <Button
          variant="secondary"
          size="dense"
          data-testid="import-selected-btn"
          :disabled="!hasSelection || disabled"
          @click="onImport"
        >
          {{ t('settings.loadPaths.importFromAgents.importSelected') }}
        </Button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { Checkbox, Button } from '@xyz-agent/ui'
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CheckboxCheckedState as CheckedState } from 'reka-ui'

import { useSettingsConfigApi } from './injection-keys'
import type { SourceDetectResult, ProviderSource, AgentSource } from '@xyz-agent/shared'

const configApi = useSettingsConfigApi()

const props = defineProps<{
  /** 资源类型，决定渲染哪些候选源 */
  kind: 'skill' | 'agent' | 'extension'
  /** 当前已配置的目录路径（共享池检测，去重用） */
  existingDirs: string[]
  /** 操作禁用 */
  disabled?: boolean
}>()

const emit = defineEmits<{
  /** 用户确认导入，把选中的路径传给父组件 */
  'import': [paths: string[]]
}>()

const { t } = useI18n()

// ── 检测状态 ──
const detectedSources = ref<SourceDetectResult[]>([])
const loading = ref(true)
const error = ref(false)

onMounted(async () => {
  try {
    detectedSources.value = await (configApi.detectSources() as Promise<SourceDetectResult[]>)
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
})

// ── 候选过滤 ──
// kind='skill' 全部 4 源；kind='agent' 仅 claude（取 agentCount，未提供时回退 skillCount）；extension 本 wave 不处理。
const candidates = computed<SourceDetectResult[]>(() => {
  if (props.kind === 'skill') {
    return detectedSources.value
  }
  if (props.kind === 'agent') {
    return detectedSources.value.filter((s) => s.source === 'claude')
  }
  return []
})

const hasInstalledCandidate = computed(() =>
  candidates.value.some((s) => s.installed && !isShared(s.dir)),
)

// ── 选中状态 ──
// 用 Set<source> 而非 Set<dir>：source 唯一标识一行候选，避免 dir 冲突。
const selected = ref<Set<ProviderSource | AgentSource>>(new Set())

function onToggle(source: ProviderSource | AgentSource, value: CheckedState): void {
  const checked = value === true
  const next = new Set(selected.value)
  if (checked) next.add(source)
  else next.delete(source)
  selected.value = next
}

const hasSelection = computed(() => {
  for (const s of selected.value) {
    const item = candidates.value.find((c) => c.source === s)
    if (item && !isShared(item.dir)) return true
  }
  return false
})

// ── 共享池检测 ──
// normalize：去尾斜杠（前端无 homedir，后端已返回绝对路径，~ 不展开）。
function normalizeDir(dir: string): string {
  return dir.replace(/\/+$/, '')
}

function isShared(dir: string): boolean {
  const norm = normalizeDir(dir)
  return props.existingDirs.some((d) => normalizeDir(d) === norm)
}

// ── 文案 ──
function sourceLabel(source: ProviderSource | AgentSource): string {
  return t(`settings.loadPaths.sourceLabels.${source}`)
}

function countLabel(item: SourceDetectResult): string {
  if (props.kind === 'agent' && item.agentCount !== undefined) {
    return t('settings.loadPaths.importFromAgents.agentCount', { count: item.agentCount })
  }
  if (item.skillCount !== undefined) {
    return t('settings.loadPaths.importFromAgents.skillCount', { count: item.skillCount })
  }
  return ''
}

// ── 导入 ──
// 收集勾选且非共享池已生效的路径，emit 给父组件（父负责去重 + append）。
function onImport(): void {
  const paths: string[] = []
  for (const item of candidates.value) {
    if (selected.value.has(item.source) && item.installed && !isShared(item.dir)) {
      paths.push(item.dir)
    }
  }
  if (paths.length === 0) return
  emit('import', paths)
}
</script>
