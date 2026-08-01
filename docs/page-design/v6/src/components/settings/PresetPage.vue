<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { closeSettings, settingsOpen, settingsPage, type SettingsPage } from '@/composables/useStore'
import {
  AVAILABLE_EXTENSIONS,
  BUILTIN_EXTENSION_HINT,
  BUILTIN_TOOLS,
  DEFAULT_ENABLED_TOOLS,
  DEFAULT_PRESETS,
  FAIL_PRESET_ID,
  MODE_LABELS,
  modeSummary,
  presets as presetSeed,
  type ExtensionMode,
  type PiLaunchPreset,
  type ToolMode,
} from '@/mock/preset'
import GroupCard from './GroupCard.vue'
import UiInput from './UiInput.vue'

/** PresetPage：pi 启动预设管理（PiPresetsPage + PresetModeSection 的 v6 重画；编辑态 §4.3 快照 diff + save-bar + 离开守卫） */

/* ── 数据 + 快照（快照 = 已保存值，dirty = 当前值 diff 快照 → 净零翻转自动 clean） ── */
const presets = ref<PiLaunchPreset[]>(JSON.parse(JSON.stringify(presetSeed)) as PiLaunchPreset[])
const snapshots = ref<Record<string, string>>({})
function snapshot(p: PiLaunchPreset) { snapshots.value[p.id] = JSON.stringify(p) }
for (const p of presets.value) snapshot(p)
function isDirty(p: PiLaunchPreset): boolean { return snapshots.value[p.id] !== JSON.stringify(p) }
const anyDirty = computed(() => presets.value.some((p) => isDirty(p)))
const sorted = computed(() => [...presets.value].sort((a, b) => a.order - b.order))
function findPreset(id: string): PiLaunchPreset | undefined { return presets.value.find((x) => x.id === id) }
const defaultPresetId = ref('builtin:full')
/** 真实 PiPresetsPage 对非 builtin 预设默认展开（mock 种子第一个自定义 =「审查专用」） */
const expandedId = ref(presets.value.find((p) => !p.builtin)?.id ?? '')

/* ── 加载态（首次 500ms 骨架；demo 触发失败 + 重试） ── */
const loading = ref(true)
const loadError = ref('')
let loadTimer: ReturnType<typeof setTimeout> | undefined
function finishLoad() {
  loading.value = false
}
onMounted(() => { loadTimer = setTimeout(finishLoad, 500) })
function retryLoad() {
  loading.value = true
  loadError.value = ''
  clearTimeout(loadTimer)
  loadTimer = setTimeout(finishLoad, 600)
}
/** demo 状态机触发：模拟加载失败（正式版无此入口） */
function simulateLoadFail() {
  clearTimeout(loadTimer)
  loading.value = false
  loadError.value = '加载预设失败：无法连接 runtime 服务'
}

/* ── 页级反馈（成功 note 1.5s / 错误横幅） ── */
const successNote = ref('')
const pageError = ref('')
let noteTimer: ReturnType<typeof setTimeout> | undefined
function note(msg: string) {
  successNote.value = msg
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => {
    successNote.value = ''
  }, 1500)
}

/* ── 展开/折叠（dirty 时折叠或切换需确认） ── */
const pendingExpandId = ref('')
const pendingAdd = ref(false)
function toggleExpand(id: string) {
  const p = findPreset(id)
  if (expandedId.value === id) {
    if (p && isDirty(p)) { confirmState.value = { kind: 'collapse', id }; return }
    expandedId.value = ''
    return
  }
  if (anyDirty.value) { pendingExpandId.value = id; confirmState.value = { kind: 'switch', id }; return }
  expandedId.value = id
}

/* ── 编辑（内置只读：输入/按钮/勾选全部 disabled） ── */
const TOOL_MODES: ToolMode[] = ['all', 'allowlist', 'denylist', 'none']
const EXT_MODES: ExtensionMode[] = ['all', 'allowlist', 'denylist', 'none']
function setField(p: PiLaunchPreset, field: 'name' | 'description', v: string) {
  if (p.builtin) return
  if (field === 'name') p.name = v
  else p.description = v || undefined
}
function setToolMode(p: PiLaunchPreset, mode: ToolMode) { if (!p.builtin) p.toolMode = mode }
function setExtMode(p: PiLaunchPreset, mode: ExtensionMode) { if (!p.builtin) p.extensionMode = mode }
function isDefaultEnabled(tool: string): boolean {
  return DEFAULT_ENABLED_TOOLS.includes(tool)
}
function isToolChecked(p: PiLaunchPreset, tool: string): boolean {
  return p.toolMode === 'allowlist' ? (p.allowedTools ?? []).includes(tool) : !(p.deniedTools ?? []).includes(tool)
}
function isExtChecked(p: PiLaunchPreset, ext: string): boolean {
  return p.extensionMode === 'allowlist' ? (p.allowedExtensions ?? []).includes(ext) : !(p.deniedExtensions ?? []).includes(ext)
}
/** denylist 勾选语义相反：checked（启用）→ 从 deniedTools 移除；unchecked → 加入 */
function toggleTool(p: PiLaunchPreset, tool: string, checked: boolean) {
  if (p.builtin) return
  if (p.toolMode === 'allowlist') {
    const list = p.allowedTools ?? []
    p.allowedTools = checked ? [...list, tool] : list.filter((t) => t !== tool)
  } else {
    const list = p.deniedTools ?? []
    p.deniedTools = checked ? list.filter((t) => t !== tool) : [...list, tool]
  }
}
function toggleExt(p: PiLaunchPreset, ext: string, checked: boolean) {
  if (p.builtin) return
  if (p.extensionMode === 'allowlist') {
    const list = p.allowedExtensions ?? []
    p.allowedExtensions = checked ? [...list, ext] : list.filter((e) => e !== ext)
  } else {
    const list = p.deniedExtensions ?? []
    p.deniedExtensions = checked ? list.filter((e) => e !== ext) : [...list, ext]
  }
}
function summaryText(p: PiLaunchPreset): string {
  const toolList = p.toolMode === 'allowlist' ? (p.allowedTools ?? []) : (p.deniedTools ?? [])
  const extList = p.extensionMode === 'allowlist' ? (p.allowedExtensions ?? []) : (p.deniedExtensions ?? [])
  return '工具访问策略: ' + modeSummary(p.toolMode, toolList.length) + ' · 扩展访问策略: ' + modeSummary(p.extensionMode, extList.length)
}

/* ── 保存流（§4.3：450ms mock → 快照刷新 + 已保存反馈 / 失败错误条） ── */
const savingId = ref('')
const saveError = ref<Record<string, string>>({})
/** 演示失败分支：FAIL_PRESET_ID 首次保存失败、重试成功（demo 状态机） */
let failArmedSave = true
function savePreset(p: PiLaunchPreset) {
  if (savingId.value) return
  if (!p.name.trim()) { saveError.value[p.id] = '预设名称不能为空'; return }
  saveError.value[p.id] = ''
  savingId.value = p.id
  setTimeout(() => {
    savingId.value = ''
    if (p.id === FAIL_PRESET_ID && failArmedSave) { failArmedSave = false; saveError.value[p.id] = '保存失败：服务不可达，请稍后重试'; return }
    snapshot(p)
    note('预设「' + p.name + '」已保存')
  }, 450)
}
function cancelEdit(p: PiLaunchPreset) {
  restoreSnapshot(p)
}

/* ── 还原快照（保存值写回 → dirty 归零；丢弃改动/取消/折叠共用） ── */
function restoreSnapshot(p: PiLaunchPreset) {
  const saved = snapshots.value[p.id]
  if (saved === undefined) return
  const idx = presets.value.findIndex((x) => x.id === p.id)
  if (idx >= 0) presets.value[idx] = JSON.parse(saved) as PiLaunchPreset
  saveError.value[p.id] = ''
}

/* ── 列表操作：设为默认 / 恢复出厂 / 新建 / 删除 ── */
function setDefault(p: PiLaunchPreset) {
  if (p.id === defaultPresetId.value) return
  defaultPresetId.value = p.id
  note('已将「' + p.name + '」设为默认预设')
}
const restoringIds = ref<string[]>([])
function restorePreset(p: PiLaunchPreset) {
  const original = DEFAULT_PRESETS.find((d) => d.id === p.id)
  if (!original || restoringIds.value.includes(p.id)) return
  restoringIds.value = [...restoringIds.value, p.id]
  setTimeout(() => {
    restoringIds.value = restoringIds.value.filter((i) => i !== p.id)
    const idx = presets.value.findIndex((x) => x.id === p.id)
    if (idx < 0) return
    presets.value[idx] = JSON.parse(JSON.stringify({ ...original, order: presets.value[idx].order })) as PiLaunchPreset
    snapshot(presets.value[idx])
    saveError.value[p.id] = ''
    note('已恢复「' + original.name + '」出厂设置')
  }, 400)
}
/** 新建预设（镜像 ProviderPage addProvider）：已有未保存改动 → 先走 switch 确认，还原后 createAndExpand */
function createPreset() {
  const id = 'custom:' + (crypto?.randomUUID?.() ?? String(Date.now()))
  if (anyDirty.value) { pendingAdd.value = true; confirmState.value = { kind: 'switch', id }; return }
  createAndExpand(id)
}
function createAndExpand(id: string) {
  const p: PiLaunchPreset = { id, name: '新预设', builtin: false, order: presets.value.length, toolMode: 'all', extensionMode: 'all' }
  presets.value.push(p)
  snapshot(p)
  expandedId.value = p.id
  note('预设已创建，可编辑名称与访问策略')
}
const deletingId = ref('')
/** 演示失败分支：FAIL_PRESET_ID 首次删除失败、重试成功（demo 状态机） */
let failArmedDelete = true
function requestDelete(p: PiLaunchPreset) {
  confirmState.value = { kind: 'delete', id: p.id }
}
function doDelete(id: string) {
  deletingId.value = id
  setTimeout(() => {
    deletingId.value = ''
    confirmState.value = null
    if (id === FAIL_PRESET_ID && failArmedDelete) { failArmedDelete = false; pageError.value = '删除失败：该预设正在被会话使用 · 先关闭相关会话再删除'; return }
    if (expandedId.value === id) expandedId.value = ''
    if (defaultPresetId.value === id) defaultPresetId.value = 'builtin:full'
    pageError.value = ''
    presets.value = presets.value.filter((x) => x.id !== id)
    note('预设已删除')
  }, 450)
}

/* ── 确认弹窗（丢弃改动 leave/collapse/switch + 删除 delete；内联自建） ── */
type ConfirmKind = 'leave' | 'collapse' | 'switch' | 'delete'
const confirmState = ref<null | { kind: ConfirmKind; id: string }>(null)
const pendingLeave = ref<SettingsPage | 'close' | null>(null)
const confirmMeta = computed(() => {
  const st = confirmState.value
  if (!st) return { title: '', desc: '', isDelete: false }
  if (st.kind === 'delete') {
    return {
      title: '删除 ' + (findPreset(st.id)?.name ?? '') + '？',
      desc: '此操作不可撤销，自定义预设将被永久删除。',
      isDelete: true,
    }
  }
  const tail = st.kind === 'leave' ? '离开设置将丢弃这些改动。' : st.kind === 'switch' ? '切换到其他预设将丢弃这些改动。' : '收起将丢弃这些改动。'
  return { title: '放弃未保存的改动？', desc: '你正在编辑的预设有未保存的改动，' + tail + '此操作不可撤销。', isDelete: false }
})
function confirmCancel() {
  if (deletingId.value) return
  confirmState.value = null
  pendingAdd.value = false
  pendingLeave.value = null
}
function confirmDiscard() {
  const st = confirmState.value
  if (!st) return
  if (st.kind === 'delete') { doDelete(st.id); return }
  confirmState.value = null
  if (st.kind === 'leave') {
    for (const p of presets.value) restoreSnapshot(p) // 先还原（anyDirty 归零）再导航，防 sync watch 重入弹窗
    if (pendingLeave.value === 'close') closeSettings()
    else if (pendingLeave.value) settingsPage.value = pendingLeave.value
    return
  }
  if (st.kind === 'collapse') {
    const p = findPreset(st.id)
    if (p) restoreSnapshot(p)
    expandedId.value = ''
    return
  }
  // switch：还原 dirty 预设 → pendingAdd ? 新建并展开 : 展开目标
  const cur = presets.value.find((p) => isDirty(p))
  if (cur) restoreSnapshot(cur)
  if (pendingAdd.value) { pendingAdd.value = false; createAndExpand(st.id) }
  else expandedId.value = pendingExpandId.value
}
/* 确认弹窗聚焦安全按钮（btn-ghost = 继续编辑/取消；仿 SystemPage guardContinueRef） */
const guardContinueRef = ref<HTMLElement | null>(null)
watch(confirmState, (v) => {
  if (v) nextTick(() => guardContinueRef.value?.focus())
})

/* ── 离开守卫（§4.3：切页/关设置拦截 + beforeunload） ── */
watch(
  () => [settingsPage.value, settingsOpen.value] as const,
  ([page, open]) => {
    if (open && page === 'preset') return
    if (!anyDirty.value) return
    pendingLeave.value = page !== 'preset' ? page : 'close'
    settingsPage.value = 'preset'
    settingsOpen.value = true
    confirmState.value = { kind: 'leave', id: '' }
  },
  // flush: 'sync' —— closeSettings/nav select 同步栈内立即拦截，卸载不发生
  { flush: 'sync' },
)
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (anyDirty.value) { e.preventDefault(); e.returnValue = '' }
}
function onEsc(e: KeyboardEvent) { if (e.key === 'Escape' && confirmState.value) confirmCancel() }
onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('keydown', onEsc)
})
onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('keydown', onEsc)
  clearTimeout(loadTimer)
  clearTimeout(noteTimer)
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">预设</h1>
        <p class="desc">管理 Pi 启动预设，配置工具和扩展的访问策略。内置预设只读，可恢复出厂设置。</p>
      </div>
      <div class="head-actions">
        <button class="btn btn-default btn-md" :disabled="loading" @click="createPreset">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          新建预设
        </button>
      </div>
    </header>

    <!-- 页级反馈：错误横幅（常驻，可关闭）/ 成功 note（1.5s） -->
    <div v-if="pageError" class="inline-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span>{{ pageError }}</span>
      <span class="spacer"></span>
      <button class="banner-x" title="关闭" aria-label="关闭" @click="pageError = ''">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div v-if="successNote" class="success-note">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      {{ successNote }}
    </div>

    <!-- 加载失败（S-RN-7：错误条 + 重试） -->
    <div v-if="loadError" class="load-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-dense retry-btn" @click="retryLoad">重试</button>
    </div>

    <GroupCard title="启动预设">
      <!-- demo 状态机触发：模拟加载失败（正式版无此按钮） -->
      <template #actions>
        <button class="btn btn-ghost btn-icon-sm" title="模拟加载失败（demo）" aria-label="模拟加载失败（demo）" @click="simulateLoadFail">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </button>
      </template>

      <!-- 加载骨架（§4.4：shimmer） -->
      <div v-if="loading" class="skel-list">
        <div v-for="i in 3" :key="i" class="skel-row">
          <span class="skel-name"></span>
          <span class="skel-summary"></span>
        </div>
      </div>

      <!-- 空态（三要素：图标 + 说明 + Primary 新建） -->
      <div v-else-if="!presets.length" class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
        <p class="empty-title">暂无预设</p>
        <p class="empty-desc">新建第一个预设，配置 pi 启动时的工具与扩展访问策略。</p>
        <button class="btn btn-default btn-dense" @click="createPreset">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          新建预设
        </button>
      </div>

      <!-- 预设列表（每个预设一行头 + 展开编辑区） -->
      <div v-else class="preset-list">
        <section v-for="p in sorted" :key="p.id" class="preset-card">
          <div class="row-head">
            <button
              class="head-main"
              :aria-expanded="expandedId === p.id ? 'true' : 'false'"
              :title="(expandedId === p.id ? '收起' : '展开') + ' ' + p.name"
              @click="toggleExpand(p.id)"
            >
              <svg class="chev" :class="{ down: expandedId === p.id }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              <span class="p-name">{{ p.name }}</span>
              <span v-if="p.builtin" class="pill pill-builtin">内置</span>
              <span v-if="p.id === defaultPresetId" class="pill pill-default">默认</span>
              <span class="p-summary">{{ summaryText(p) }}</span>
            </button>
            <span v-if="isDirty(p)" class="dirty-badge"><span class="dot"></span>未保存</span>
            <div class="row-actions">
              <button v-if="p.id !== defaultPresetId" class="btn btn-ghost btn-dense" title="设为默认" @click="setDefault(p)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                设为默认
              </button>
              <button v-if="p.builtin" class="btn btn-ghost btn-dense" :disabled="restoringIds.includes(p.id)" @click="restorePreset(p)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                {{ restoringIds.includes(p.id) ? '恢复中…' : '恢复默认' }}
              </button>
              <button v-if="!p.builtin" class="btn btn-danger btn-icon-sm del-btn" title="删除预设" aria-label="删除预设" @click="requestDelete(p)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>
          </div>

          <!-- 编辑区（仅展开时渲染；内置只读：文本展示 + disabled 控件） -->
          <div v-if="expandedId === p.id" class="expand-body">
            <!-- 基本信息 -->
            <div class="field-grid">
              <div class="fld">
                <label class="field-label">名称</label>
                <template v-if="p.builtin">
                  <div class="fld-text">{{ p.name }}</div>
                </template>
                <UiInput v-else :model-value="p.name" :dense="true" :error="!!saveError[p.id]" placeholder="预设名称" @update:model-value="(v) => setField(p, 'name', v)" />
              </div>
              <div class="fld">
                <label class="field-label">ID</label>
                <div class="fld-text mono">{{ p.id }}</div>
              </div>
            </div>
            <div class="fld">
              <label class="field-label">描述</label>
              <template v-if="p.builtin">
                <div class="fld-text">{{ p.description ?? '' }}</div>
              </template>
              <UiInput v-else :model-value="p.description ?? ''" :dense="true" placeholder="预设描述（可选）" @update:model-value="(v) => setField(p, 'description', v)" />
            </div>

            <!-- 工具访问策略（PresetModeSection 配置项：4 mode + checkbox 列表） -->
            <div class="mode-block">
              <div class="mode-head">
                <span class="mode-label">工具访问策略</span>
                <span v-if="p.builtin" class="pill pill-readonly">只读</span>
              </div>
              <div class="mode-seg">
                <button
                  v-for="m in TOOL_MODES"
                  :key="m"
                  class="mode-btn"
                  :class="{ active: p.toolMode === m }"
                  :disabled="p.builtin"
                  @click="setToolMode(p, m)"
                >{{ MODE_LABELS[m] }}</button>
              </div>
              <template v-if="p.toolMode === 'allowlist' || p.toolMode === 'denylist'">
                <p class="mode-hint">{{ p.toolMode === 'allowlist' ? '勾选 = 允许使用（未勾选工具将不可用）' : '勾选 = 启用该工具（勾掉的工具将被禁用）' }}</p>
                <div class="check-list">
                  <label v-for="t in BUILTIN_TOOLS" :key="t" class="check-chip" :class="{ locked: p.builtin }">
                    <input
                      type="checkbox"
                      class="chip-check"
                      :checked="isToolChecked(p, t)"
                      :disabled="p.builtin"
                      :aria-label="'允许 ' + t"
                      @change="toggleTool(p, t, ($event.target as HTMLInputElement).checked)"
                    />
                    <span class="chip-name">{{ t }}</span>
                    <span class="chip-tag" :class="isDefaultEnabled(t) ? 'on' : 'off'">{{ isDefaultEnabled(t) ? '默认启用' : '默认禁用' }}</span>
                  </label>
                </div>
              </template>
              <p v-else class="mode-hint">{{ p.toolMode === 'all' ? '全部工具可用，适合大多数任务' : '无任何工具可用，仅保留对话交互' }}</p>
            </div>

            <!-- 扩展访问策略 -->
            <div class="mode-block">
              <div class="mode-head">
                <span class="mode-label">扩展访问策略</span>
                <span v-if="p.builtin" class="pill pill-readonly">只读</span>
              </div>
              <div class="mode-seg">
                <button
                  v-for="m in EXT_MODES"
                  :key="m"
                  class="mode-btn"
                  :class="{ active: p.extensionMode === m }"
                  :disabled="p.builtin"
                  @click="setExtMode(p, m)"
                >{{ MODE_LABELS[m] }}</button>
              </div>
              <template v-if="p.extensionMode === 'allowlist' || p.extensionMode === 'denylist'">
                <p class="mode-hint">{{ p.extensionMode === 'allowlist' ? '勾选 = 允许加载（未勾选扩展将不注入）' : '勾选 = 加载该扩展（勾掉的扩展将被排除）' }}</p>
                <div v-if="!AVAILABLE_EXTENSIONS.length" class="no-ext">暂无扩展</div>
                <div v-else class="check-list">
                  <label v-for="e in AVAILABLE_EXTENSIONS" :key="e.name" class="check-chip" :class="{ locked: p.builtin }">
                    <input
                      type="checkbox"
                      class="chip-check"
                      :checked="isExtChecked(p, e.name)"
                      :disabled="p.builtin"
                      :aria-label="'允许 ' + e.displayName"
                      @change="toggleExt(p, e.name, ($event.target as HTMLInputElement).checked)"
                    />
                    <span class="chip-name">{{ e.displayName }}</span>
                  </label>
                </div>
              </template>
              <p v-else class="mode-hint">{{ p.extensionMode === 'all' ? '全部扩展可用（3 个内置文件型扩展永远加载）' : '不加载任何扩展' }}</p>
            </div>

            <!-- save-bar（dirty 时出现） -->
            <div v-if="isDirty(p)" class="save-bar">
              <span class="bar-badge"><span class="dot"></span>未保存</span>
              <span v-if="saveError[p.id]" class="bar-error">{{ saveError[p.id] }}</span>
              <span class="spacer"></span>
              <button class="btn btn-ghost btn-md" :disabled="savingId === p.id" @click="cancelEdit(p)">取消</button>
              <button class="btn btn-default btn-md" :disabled="savingId === p.id" @click="savePreset(p)">{{ savingId === p.id ? '保存中…' : '保存' }}</button>
            </div>
          </div>
        </section>

        <p class="builtin-hint">{{ BUILTIN_EXTENSION_HINT }}</p>
      </div>
    </GroupCard>

    <!-- 确认弹窗（丢弃改动 leave/collapse/switch / 删除 delete；内联自建，ESC/backdrop 取消） -->
    <div v-if="confirmState" class="confirm-stage" @click.self="confirmCancel">
      <div class="confirm-card" role="dialog" aria-modal="true" :aria-label="confirmMeta.title">
        <div class="confirm-title">{{ confirmMeta.title }}</div>
        <p class="confirm-desc">{{ confirmMeta.desc }}</p>
        <div class="confirm-actions">
          <button ref="guardContinueRef" class="btn btn-ghost btn-dense" :disabled="deletingId !== ''" @click="confirmCancel">{{ confirmMeta.isDelete ? '取消' : '继续编辑' }}</button>
          <button class="btn btn-danger btn-dense" :disabled="deletingId !== ''" @click="confirmDiscard">
            {{ confirmMeta.isDelete ? (deletingId !== '' ? '删除中…' : '确认删除') : '放弃改动' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-6);
}
.head-text { min-width: 0; }
.title { font-size: 20px; font-weight: 600; color: var(--neutral-fg); letter-spacing: -0.01em; }
.desc { margin-top: var(--space-2); font-size: var(--text-sm); color: var(--neutral-mid); }
.head-actions { display: flex; gap: var(--space-2); flex-shrink: 0; }
.spacer { flex: 1; }

/* 页级横幅（错误常驻 + 成功临时） */
.inline-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--text-sm);
  margin-bottom: var(--space-3);
}
.inline-error > svg { width: 14px; height: 14px; flex-shrink: 0; }
.banner-x { color: var(--danger); display: inline-flex; padding: 2px; }
.banner-x svg { width: 14px; height: 14px; }
.success-note {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius);
  background: var(--success-soft);
  color: var(--success);
  font-size: var(--text-sm);
  margin-bottom: var(--space-3);
}
.success-note svg { width: 14px; height: 14px; flex-shrink: 0; }

/* 加载失败条 */
.load-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--text-sm);
  margin-bottom: var(--space-3);
}
.load-error > svg { width: 14px; height: 14px; flex-shrink: 0; }
.retry-btn { margin-left: auto; }

/* 加载骨架（shimmer 全局 keyframes） */
.skel-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-2);
}
.skel-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
}
.skel-name,
.skel-summary {
  height: 10px;
  border-radius: 999px;
  background-image: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-hover) 50%, var(--surface-2) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
}
.skel-name { width: 140px; flex-shrink: 0; }
.skel-summary { flex: 1; }
@media (prefers-reduced-motion: reduce) {
  .skel-name,
  .skel-summary {
    animation: none;
    background-image: none;
    background: var(--surface-2);
  }
}

/* 空态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-8) var(--space-4);
  text-align: center;
}
.empty-state > svg { width: 28px; height: 28px; color: var(--neutral-faint); }
.empty-title { font-size: var(--text-md); font-weight: 500; color: var(--neutral-fg); margin-top: var(--space-1); }
.empty-desc { font-size: var(--text-sm); color: var(--neutral-mid); max-width: 360px; }
.empty-state .btn { margin-top: var(--space-1); }

/* 预设列表 */
.preset-list { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-2); }
.preset-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  transition: border-color var(--duration-fast) var(--ease);
}
.preset-card:has(.expand-body) { border-color: var(--border-strong); }

/* 行头（全宽点击区 + 行尾操作） */
.row-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  min-height: 52px;
}
.head-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  padding: var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--neutral-fg);
  cursor: pointer;
  text-align: left;
  transition: background var(--duration-fast) var(--ease);
}
.head-main:hover { background: var(--surface); }
.chev {
  width: 12px;
  height: 12px;
  color: var(--neutral-dim);
  flex-shrink: 0;
  transition: transform var(--duration-fast) var(--ease);
  transform: rotate(-90deg);
}
.chev.down { transform: rotate(0deg); }
.p-name {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--neutral-fg);
  white-space: nowrap;
  flex-shrink: 0;
}
.p-summary {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pill {
  height: 18px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.pill-builtin { background: var(--surface); color: var(--neutral-dim); }
.pill-default { background: var(--accent-soft); color: var(--accent); }
.pill-readonly { background: var(--surface); color: var(--neutral-dim); font-weight: 500; }
.dirty-badge {
  height: 18px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.dirty-badge .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--warn); flex-shrink: 0; }
.row-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.row-actions .btn svg { width: 14px; height: 14px; }
.del-btn:hover { color: var(--danger); }

/* 展开编辑区 */
.expand-body {
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.fld { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
.field-label { font-size: var(--text-xs); color: var(--neutral-mid); font-weight: 500; }
.fld-text {
  height: 32px;
  display: flex;
  align-items: center;
  padding: 0 2px;
  font-size: var(--text-sm);
  color: var(--neutral-fg);
}
.fld-text.mono { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--neutral-dim); }

/* 模式配置块（4 mode 切换 + 勾选清单） */
.mode-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--surface-2);
  border-radius: var(--radius);
}
.mode-head { display: flex; align-items: center; gap: var(--space-2); }
.mode-label { font-size: var(--text-xs); font-weight: 600; color: var(--neutral-fg); }
.mode-seg { display: flex; align-items: center; gap: var(--space-1); }
.mode-btn {
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.mode-btn:hover { color: var(--neutral-fg); }
.mode-btn.active {
  background: var(--surface-hover);
  color: var(--neutral-fg);
  box-shadow: inset 0 0 0 1px var(--accent-ring);
}
.mode-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.mode-hint { font-size: var(--text-2xs); color: var(--neutral-dim); }
.check-list { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.check-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.check-chip:hover { background: var(--surface); }
.check-chip.locked { cursor: default; opacity: 0.65; }
.check-chip.locked:hover { background: transparent; }
.chip-check {
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  cursor: pointer;
  flex-shrink: 0;
  position: relative;
  transition: all var(--duration-fast) var(--ease);
}
.chip-check:checked { background: var(--accent); border-color: var(--accent); }
.chip-check:checked::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 1px;
  width: 5px;
  height: 9px;
  border: solid var(--accent-fg);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.chip-check:disabled { opacity: 0.5; cursor: not-allowed; }
.chip-name { font-size: var(--text-xs); color: var(--neutral-fg); font-family: var(--font-mono); }
.chip-tag { font-size: 9px; font-weight: 600; }
.chip-tag.on { color: var(--success); }
.chip-tag.off { color: var(--neutral-dim); }
.no-ext { font-size: var(--text-xs); color: var(--neutral-mid); padding: var(--space-1) 0; }

/* save-bar（sticky 底） */
.save-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  position: sticky;
  bottom: 0;
  background: var(--surface);
  margin: 0 calc(-1 * var(--space-4)) calc(-1 * var(--space-4));
  padding: var(--space-3) var(--space-4);
  z-index: var(--z-sticky);
}
.bar-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--warn);
  font-weight: 600;
}
.bar-badge .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--warn); }
.bar-error { font-size: var(--text-sm); color: var(--danger); }

.builtin-hint {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  padding: var(--space-1) var(--space-2) var(--space-2);
}

/* 确认弹窗（浮起 dialog 原语：bg-surface + border + shadow-2 + radius-lg） */
.confirm-stage {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(4px);
}
.confirm-card {
  position: relative;
  width: 100%;
  max-width: 420px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  padding: var(--space-4);
}
.confirm-title { font-size: var(--text-md); font-weight: 600; color: var(--neutral-fg); }
.confirm-desc {
  font-size: var(--text-base);
  line-height: 1.55;
  color: var(--neutral-mid);
  margin: var(--space-2) 0 var(--space-4);
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-1);
}
</style>
