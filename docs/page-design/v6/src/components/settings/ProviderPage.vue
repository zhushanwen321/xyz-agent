<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  providers as initialProviders,
  discoveredProviders as discoveredMock,
  type DiscoveredProvider,
  type Provider,
  type ProviderHeader,
  type ProviderQuotaWindow,
} from '@/mock/sessions'
import { settingsOpen, settingsPage, closeSettings, type SettingsPage } from '@/composables/useStore'
import UiSwitch from './UiSwitch.vue'
import UiInput from './UiInput.vue'
import ProviderAdvancedSection from './ProviderAdvancedSection.vue'
import ProviderUnsavedDialog from './ProviderUnsavedDialog.vue'
import ProviderImportDialog from './ProviderImportDialog.vue'

/** ProviderPage：模型供应商管理。row-head + 展开就地编辑（凭据/模型/验证/高级 4 子区）+ save-bar。
 * 交互状态机：M2 未保存保护 / M8 自动发现 / M9 额度 / M10 headers 行编辑 / M11 save-bar / M13 Switch 乐观更新 / M14 错误反馈。*/
const providers = ref<Provider[]>(JSON.parse(JSON.stringify(initialProviders)))
const expandedId = ref(initialProviders.find((p) => p.status === 'connected')?.id ?? initialProviders[0]?.id ?? '')
const showKey = ref<Record<string, boolean>>({})
const advOpen = ref<Record<string, boolean>>({})
const apiKey = ref<Record<string, string>>({ 'p-1': 'sk-zhipu-••••••••••••3f2a', 'p-2': 'sk-ant-••••••••••••8b1c' })

// 编辑态（draft refs + dirty flag；保存时提交到 provider，快照记录已保存值）
const nameDraft = ref<Record<string, string>>({})
const baseUrlDraft = ref<Record<string, string>>({})
const headers = ref<Record<string, ProviderHeader[]>>({})
const quota = ref<Record<string, ProviderQuotaWindow[]>>({})
function snapshot(p: Provider) {
  nameDraft.value[p.id] = p.name
  baseUrlDraft.value[p.id] = p.baseUrl ?? ''
  headers.value[p.id] = JSON.parse(JSON.stringify(p.headers ?? []))
  quota.value[p.id] = JSON.parse(JSON.stringify(p.quota ?? []))
  testState.value[p.id] = { busy: false, ok: false, msg: '' }
  quotaError.value[p.id] = ''; quotaOk.value[p.id] = false
}
function markDirty(p: Provider) { p.dirty = true }
function restoreSnapshot(p: Provider) {
  p.name = nameDraft.value[p.id] ?? p.name
  p.baseUrl = baseUrlDraft.value[p.id] ?? ''
  headers.value[p.id] = JSON.parse(JSON.stringify(p.headers ?? []))
  quota.value[p.id] = JSON.parse(JSON.stringify(p.quota ?? []))
  p.dirty = false
  saveError.value[p.id] = ''
  testState.value[p.id] = { busy: false, ok: false, msg: '' }
}
const anyDirty = computed(() => providers.value.some((x) => x.dirty))

// M2 未保存保护（ConfirmDialog）
const confirmState = ref<null | { kind: 'leave' | 'collapse' | 'switch' | 'delete' | 'confirm-delete'; id?: string }>(null)
const pendingLeave = ref<SettingsPage | 'close' | null>(null)
const pendingAdd = ref(false)
const nameInputEl = ref<HTMLInputElement | null>(null)
// 函数 ref：v-for 内组件 ref 会被数组化，用回调直接取 $el
function setNameInputRef(el: unknown) { nameInputEl.value = (el as { $el?: HTMLInputElement } | null)?.$el ?? null }
const confirmMeta = computed(() => {
  const st = confirmState.value
  const kind = st?.kind
  if (kind === 'confirm-delete' && st) {
    return { title: '删除 ' + (providers.value.find((x) => x.id === st.id)?.name ?? '') + '？', desc: '将移除其下所有模型，不可撤销。', kind: 'danger' as const }
  }
  const tail = kind === 'leave' ? '离开设置将丢弃这些改动。' : kind === 'switch' ? '切换到其他供应商将丢弃这些改动。' : kind === 'delete' ? '删除将丢弃这些改动。' : '收起将丢弃这些改动。'
  return { title: '放弃未保存的改动？', desc: '你正在编辑的供应商有未保存的改动，' + tail + '此操作不可撤销。', kind: 'warn' as const }
})
function toggleExpand(id: string) {
  const p = providers.value.find((x) => x.id === id)
  if (expandedId.value === id) {
    if (p?.dirty) { confirmState.value = { kind: 'collapse', id }; return }
    expandedId.value = ''
  } else if (anyDirty.value) {
    confirmState.value = { kind: 'switch', id }
  } else {
    expandedId.value = id
    if (p) snapshot(p)
  }
}
function confirmDiscard() {
  const st = confirmState.value
  confirmState.value = null
  if (!st) return
  if (st.kind === 'leave') {
    // 放弃 = 丢弃编辑态：先还原快照 → anyDirty 归零 → sync watch 重入时守卫放行导航。
    // 不还原会导致守卫拦截自己的导航（弹窗永久重开，无法离开设置）。
    for (const pp of providers.value) restoreSnapshot(pp)
    if (pendingLeave.value === 'close') closeSettings()
    else if (pendingLeave.value) settingsPage.value = pendingLeave.value
    return
  }
  const p = providers.value.find((x) => x.id === st.id)
  if (st.kind === 'collapse') {
    if (p) restoreSnapshot(p)
    expandedId.value = ''
  } else if (st.kind === 'switch') {
    const cur = providers.value.find((x) => x.id === expandedId.value)
    if (cur) restoreSnapshot(cur)
    if (pendingAdd.value) { pendingAdd.value = false; createAndExpand(st.id ?? '') }
    else { expandedId.value = st.id ?? ''; if (p) snapshot(p) }
  } else if (st.kind === 'delete' || st.kind === 'confirm-delete') {
    if (p) restoreSnapshot(p)
    if (expandedId.value === st.id) expandedId.value = ''
    providers.value = providers.value.filter((x) => x.id !== st.id)
  }
}
function confirmContinue() { pendingAdd.value = false; confirmState.value = null }
/** 新建空白 provider 并直接展开编辑态（spec §9 旅程 A1：不弹窗；已有未保存改动时先走 M2 确认） */
function addProvider() {
  const id = 'new-' + Date.now()
  if (anyDirty.value) { pendingAdd.value = true; confirmState.value = { kind: 'switch', id }; return }
  createAndExpand(id)
}
function createAndExpand(id: string) {
  const p: Provider = { id, name: '', status: 'not_configured', enabled: false, isDefault: false, modelCount: 0, dirty: true, baseUrl: '' }
  providers.value.push(p)
  providerType.value[id] = 'anthropic-messages'
  apiKey.value[id] = ''
  expandedId.value = id
  snapshot(p)
  nextTick(() => nameInputEl.value?.focus())
}
/** 离开页面拦截：nav 切页 / 关闭设置 → 还原 + 弹确认（watch flush pre，先于 v-if 卸载） */
watch(
  () => [settingsPage.value, settingsOpen.value] as const,
  ([page, open]) => {
    if (open && page === 'provider') return
    if (!anyDirty.value) return
    pendingLeave.value = page !== 'provider' ? page : 'close'
    settingsPage.value = 'provider'
    settingsOpen.value = true
    confirmState.value = { kind: 'leave' }
  },
  // flush: 'sync' —— closeSettings/nav select 同步栈内立即拦截，卸载不发生。
  { flush: 'sync' },
)
function onBeforeUnload(e: BeforeUnloadEvent) { if (anyDirty.value) { e.preventDefault(); e.returnValue = '' } }
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onUnmounted(() => window.removeEventListener('beforeunload', onBeforeUnload))

// M13 Switch 乐观更新（provider 级 + model 级，300-600ms mock 延迟）
const togglingIds = ref<string[]>([])
const rollbackIds = ref<string[]>([])
function toggleEnabled(p: Provider) {
  if (togglingIds.value.includes(p.id)) return
  const old = p.enabled
  togglingIds.value = [...togglingIds.value, p.id]
  p.enabled = !old
  if (!p.enabled && defaultModel.value[p.id]) defaultModel.value[p.id] = ''
  actionError.value = ''
  setTimeout(() => {
    if (p.id === 'p-4') {
      p.enabled = old
      rollbackIds.value = [...rollbackIds.value, p.id]
      actionError.value = '切换失败：无法连接 Kimi 服务，已恢复原状'
      setTimeout(() => { rollbackIds.value = rollbackIds.value.filter((i) => i !== p.id) }, 900)
    }
    togglingIds.value = togglingIds.value.filter((i) => i !== p.id)
  }, 450)
}
const modelEnabled = ref<Record<string, Record<string, boolean>>>({ 'p-1': { 'glm-4.6': true, 'glm-4.5-air': true, 'glm-4-flash': true }, 'p-2': { 'claude-sonnet-4.5': true, 'claude-haiku-4': true } })
const modelToggling = ref<Record<string, boolean>>({})
function toggleModelEnabled(p: Provider, m: string) {
  const key = p.id + m
  if (modelToggling.value[key]) return
  modelToggling.value[key] = true
  modelEnabled.value[p.id] = { ...(modelEnabled.value[p.id] ?? {}), [m]: !(modelEnabled.value[p.id]?.[m] ?? true) }
  setTimeout(() => { modelToggling.value[key] = false }, 400)
}

// M8 自动发现（mock 探测结果，带「发现」来源标识，采纳/忽略）
const discovering = ref(false)
const discovered = ref<DiscoveredProvider[]>([])
function runDiscover() {
  if (discovering.value || Object.values(testState.value).some((t) => t.busy)) return
  discovering.value = true
  discovered.value = []
  setTimeout(() => {
    discovering.value = false
    discovered.value = JSON.parse(JSON.stringify(discoveredMock))
  }, 500)
}
function adoptDiscovered(d: DiscoveredProvider) {
  providers.value.push({ id: 'new-' + d.id, name: d.name, status: 'connected', enabled: true, isDefault: false, modelCount: d.modelCount, dirty: true, baseUrl: '' })
  discovered.value = discovered.value.filter((x) => x.id !== d.id)
}
function ignoreDiscovered(id: string) { discovered.value = discovered.value.filter((x) => x.id !== id) }

// 验证子区：测试连接（与自动发现互斥）
const testState = ref<Record<string, { busy: boolean; ok: boolean; msg: string }>>({})
function runTest(p: Provider) {
  if (testState.value[p.id]?.busy || discovering.value) return
  testState.value[p.id] = { busy: true, ok: false, msg: '' }
  setTimeout(() => {
    const msg = p.id === 'p-4' ? '连接失败：无法访问 https://api.moonshot.cn/v1/models（UNREACHABLE）'
      : p.id === 'p-3' ? '请求失败：Base URL 或 API Key 包含 HTTP 不支持的字符（INVALID_AUTH_CHARS）'
        : '连接成功，找到 ' + (models.value[p.id]?.length ?? 0) + ' 个模型'
    testState.value[p.id] = { busy: false, ok: p.id !== 'p-4' && p.id !== 'p-3', msg }
  }, 450)
}

// M9 额度（mock 刷新：p-2 固定失败演示凭证无效）
const quotaBusy = ref<Record<string, boolean>>({})
const quotaError = ref<Record<string, string>>({})
const quotaOk = ref<Record<string, boolean>>({})
function refreshQuota(p: Provider) {
  if (quotaBusy.value[p.id]) return
  quotaBusy.value[p.id] = true
  quotaError.value[p.id] = ''
  quotaOk.value[p.id] = false
  setTimeout(() => {
    quotaBusy.value[p.id] = false
    if (p.id === 'p-2') { quotaError.value[p.id] = '额度查询失败：凭证无效，请检查 API Key'; return }
    quota.value[p.id] = (quota.value[p.id] ?? []).map((w, i) => ({ ...w, pct: Math.min(100, w.pct + (i === 0 ? 2 : 1)) }))
    quotaOk.value[p.id] = true
  }, 500)
}

// M10 headers 行编辑
function addHeader(p: Provider) { headers.value[p.id] = [...(headers.value[p.id] ?? []), { key: '', value: '' }]; markDirty(p) }
function removeHeader(p: Provider, i: number) { headers.value[p.id] = (headers.value[p.id] ?? []).filter((_, idx) => idx !== i); markDirty(p) }
function changeHeader(p: Provider, i: number, field: 'key' | 'value', v: string) {
  const arr = headers.value[p.id] ?? []
  if (arr[i]) { arr[i][field] = v; markDirty(p) }
}

// M11 save-bar（保存/放弃 + 验证错误 + 保存失败）
const saving = ref(false)
const saveError = ref<Record<string, string>>({})
function saveEdit(p: Provider) {
  const name = (nameDraft.value[p.id] ?? '').trim()
  if (!name) { saveError.value[p.id] = '供应商名称不能为空'; return }
  const seen = new Set<string>()
  for (const h of headers.value[p.id] ?? []) {
    const key = h.key.trim()
    if (key && seen.has(key)) { saveError.value[p.id] = 'Header key 重复：' + key; return }
    if (key) seen.add(key)
  }
  if (saving.value) return
  saving.value = true
  saveError.value[p.id] = ''
  setTimeout(() => {
    saving.value = false
    if (p.id === 'p-4') { saveError.value[p.id] = '保存失败：服务不可达，请稍后重试'; return }
    p.name = name
    p.baseUrl = baseUrlDraft.value[p.id]
    p.headers = JSON.parse(JSON.stringify(headers.value[p.id] ?? []))
    p.quota = JSON.parse(JSON.stringify(quota.value[p.id] ?? []))
    snapshot(p)
    p.dirty = false
  }, 600)
}
function cancelEdit(p: Provider) { restoreSnapshot(p) }

// M14 页级动作错误横幅 + 删除
const actionError = ref('')
const successNote = ref('')
function removeProvider(p: Provider) {
  if (p.id === 'p-4') { actionError.value = '删除失败：Kimi 正在被会话使用 · 先关闭相关会话再删除'; return }
  confirmState.value = { kind: p.dirty ? 'delete' : 'confirm-delete', id: p.id }
}
function onImported(count: number) {
  successNote.value = '导入 ' + count + ' 个 provider'
  setTimeout(() => { successNote.value = '' }, 3000)
}

// M5 模型列表 / M7 默认模型 / M6 thinking pill
const models = ref<Record<string, string[]>>({ 'p-1': ['glm-4.6', 'glm-4.5-air', 'glm-4-flash'], 'p-2': ['claude-sonnet-4.5', 'claude-haiku-4'] })
const defaultModel = ref<Record<string, string>>({ 'p-1': 'glm-4.6' })
const newModelName = ref('')
const newModelInputType = ref<'text' | 'image'>('text')
function addModel(p: Provider) {
  const name = newModelName.value.trim()
  if (!name) return
  models.value[p.id] = [...(models.value[p.id] ?? []), name]
  newModelName.value = ''
  markDirty(p)
}
function removeModel(p: Provider, m: string) {
  models.value[p.id] = (models.value[p.id] ?? []).filter((x) => x !== m)
  if (defaultModel.value[p.id] === m) defaultModel.value[p.id] = ''
  markDirty(p)
}
function setDefaultModel(p: Provider, m: string) { defaultModel.value[p.id] = m; markDirty(p) }
const THINKING_PRESETS: Record<string, { label: string; cls: string }> = {
  'glm-4.6': { label: '全档', cls: 'tp-all' },
  'glm-4.5-air': { label: '开关', cls: 'tp-toggle' },
  'glm-4-flash': { label: '开关', cls: 'tp-toggle' },
  'claude-sonnet-4.5': { label: '高/顶', cls: 'tp-hightop' },
  'claude-haiku-4': { label: '开关', cls: 'tp-toggle' },
}
function thinkingPreset(m: string) { return THINKING_PRESETS[m] ?? { label: '开关', cls: 'tp-toggle' } }
const authHeader = ref<Record<string, boolean>>({ 'p-1': true, 'p-2': true })
const providerType = ref<Record<string, string>>({ 'p-1': 'openai-completions', 'p-2': 'anthropic-messages', 'p-3': 'openai-completions', 'p-4': 'openai-completions' })
const TYPE_OPTIONS = ['anthropic-messages', 'openai-completions', 'openai-responses']
const importOpen = ref(false)
function clearApiKey(p: Provider) { apiKey.value[p.id] = ''; markDirty(p) }
const bootP = providers.value.find((x) => x.id === expandedId.value)
if (bootP) snapshot(bootP)
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">供应商</h1>
        <p class="desc">管理模型供应商的连接、凭据与可用模型。</p>
      </div>
      <div class="head-actions">
        <button class="btn btn-secondary btn-sm" data-testid="import-provider-btn" @click="importOpen = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          从其他 Agent 导入
        </button>
        <button class="btn btn-default btn-md" @click="addProvider">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          添加供应商
        </button>
      </div>
    </header>

    <!-- M14：页级动作错误横幅（展开区收起后仍可见） -->
    <div v-if="actionError" class="inline-error" data-testid="action-error-banner">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span class="spacer"></span>
      <button class="banner-x" title="关闭" @click="actionError = ''"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div v-if="successNote" class="success-note">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      {{ successNote }}
    </div>

    <!-- 空态（spec §7 三要素） -->
    <div v-if="providers.length === 0" class="empty-state">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </div>
      <p class="empty-title">还没有供应商</p>
      <p class="empty-desc">添加第一个供应商，连接 AI 模型开始对话。</p>
    </div>

    <div v-else class="provider-list">
      <section v-for="p in providers" :key="p.id" class="provider-card">
        <div class="row-head">
          <span class="status-dot" :class="p.status === 'connected' ? 'ok' : 'neutral'" :title="p.status === 'connected' ? '已连接' : '未配置'"></span>
          <div class="switch-opt" :class="{ 'switch-pending': togglingIds.includes(p.id), 'switch-rollback': rollbackIds.includes(p.id) }">
            <UiSwitch :checked="p.enabled" :disabled="togglingIds.includes(p.id)" :aria-label="'启用 ' + p.name" @update:checked="toggleEnabled(p)" />
          </div>
          <span class="name" role="button" :aria-expanded="expandedId === p.id" :aria-label="'展开 ' + p.name + ' 详情'" @click="toggleExpand(p.id)">{{ p.name }}
            <svg class="name-chevron" :class="{ down: expandedId === p.id }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </span>
          <span v-if="p.isDefault" class="default-pill">默认供应商</span>
          <span class="model-count">{{ p.modelCount }} 模型</span>
          <span v-if="p.dirty" class="dirty-badge"><span class="dot"></span>未保存</span>
          <span class="spacer"></span>
          <button class="btn btn-danger btn-icon-sm del-btn" title="删除供应商" :aria-label="'删除 ' + p.name" @click="removeProvider(p)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        </div>

        <div v-if="expandedId === p.id" class="expand-body">
          <!-- 凭据子区 -->
          <div class="sub-section">
            <div class="sub-label">凭据</div>
            <div class="cred-grid">
              <div class="cred-field">
                <label class="field-label">名称</label>
                <UiInput :ref="setNameInputRef" :model-value="nameDraft[p.id]" :error="!!saveError[p.id]" placeholder="供应商名称" @update:model-value="(v) => { nameDraft[p.id] = v; saveError[p.id] = ''; markDirty(p) }" />
              </div>
              <div class="cred-field">
                <label class="field-label">类型</label>
                <div class="select-wrap">
                  <select v-model="providerType[p.id]" class="type-select" @change="markDirty(p)">
                    <option v-for="t in TYPE_OPTIONS" :key="t" :value="t">{{ t }}</option>
                  </select>
                  <svg class="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
              </div>
              <div class="cred-field cred-field-wide">
                <label class="field-label">Base URL</label>
                <UiInput :model-value="baseUrlDraft[p.id]" :mono="true" placeholder="https://api.example.com/v1" @update:model-value="(v) => { baseUrlDraft[p.id] = v; markDirty(p) }" />
              </div>
              <div class="cred-field cred-field-wide">
                <label class="field-label">API Key</label>
                <div class="cred-row">
                  <UiInput :model-value="showKey[p.id] ? apiKey[p.id] : (apiKey[p.id] ? '••••••••••••••••' : '')" placeholder="留空保存则保持不变" :mono="true" class="key-input" @update:model-value="(v) => { apiKey[p.id] = v; markDirty(p) }" />
                  <button class="btn btn-ghost btn-md eye-btn" :title="showKey[p.id] ? '隐藏密钥' : '显示密钥'" :aria-label="showKey[p.id] ? '隐藏密钥' : '显示密钥'" :aria-pressed="showKey[p.id] ? 'true' : 'false'" @click="showKey[p.id] = !showKey[p.id]">
                    <svg v-if="!showKey[p.id]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  </button>
                  <button v-if="apiKey[p.id]" class="btn btn-ghost btn-md clear-btn" title="清除密钥" aria-label="清除密钥" @click="clearApiKey(p)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
                </div>
              </div>
              <div class="cred-field cred-field-wide">
                <div class="auth-header-row">
                  <span class="auth-header-label">Auth Header</span>
                  <span class="auth-header-desc">把 API Key 写入 Authorization 头</span>
                  <span class="spacer"></span>
                  <UiSwitch :checked="!!authHeader[p.id]" aria-label="把 API Key 写入 Authorization 头" @update:checked="(v) => { authHeader[p.id] = v; markDirty(p) }" />
                </div>
              </div>
            </div>
          </div>

          <!-- 模型清单 -->
          <div class="sub-section">
            <div class="sub-label">模型清单</div>
            <div class="model-list">
              <div v-for="m in models[p.id] ?? []" :key="m" class="model-row">
                <div class="switch-opt" :class="{ 'switch-pending': modelToggling[p.id + m] }">
                  <UiSwitch :checked="!!(modelEnabled[p.id]?.[m] ?? true)" :disabled="!!modelToggling[p.id + m]" :aria-label="'启用 ' + m" @update:checked="toggleModelEnabled(p, m)" />
                </div>
                <UiInput :model-value="m" :mono="true" class="model-name-input" />
                <span v-if="defaultModel[p.id] === m" class="default-dot" title="默认模型"></span>
                <span class="thinking-pill" :class="thinkingPreset(m).cls" :title="'思考策略：' + thinkingPreset(m).label">{{ thinkingPreset(m).label }}</span>
                <span class="spacer-tag"></span>
                <button class="btn btn-ghost btn-icon adv-chevron" :class="{ down: advOpen[p.id + m] }" :title="'高级 ' + m" @click="advOpen[p.id + m] = !advOpen[p.id + m]"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
                <button class="btn btn-ghost btn-icon" title="移除模型" @click="removeModel(p, m)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                <div v-if="advOpen[p.id + m]" class="model-adv-drawer">
                  <div class="cred-grid">
                    <div class="cred-field">
                      <label class="field-label">输入类型</label>
                      <select class="type-select"><option>text</option><option>multimodal</option></select>
                    </div>
                    <div class="cred-field">
                      <label class="field-label">上下文窗口</label>
                      <UiInput model-value="128000" :mono="true" />
                    </div>
                    <div class="cred-field">
                      <label class="field-label">思考</label>
                      <select class="type-select"><option>auto</option><option>on</option><option>off</option></select>
                    </div>
                    <div class="cred-field">
                      <label class="field-label">兼容性</label>
                      <UiInput model-value="openai" :mono="true" />
                    </div>
                  </div>
                  <button v-if="defaultModel[p.id] !== m" class="btn btn-ghost btn-sm set-default-btn" @click="setDefaultModel(p, m)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                    设为默认
                  </button>
                </div>
              </div>
            </div>
            <div class="model-add-row">
              <UiInput v-model="newModelName" placeholder="模型名称" :mono="true" class="model-add-input" />
              <div class="input-seg" role="group" aria-label="输入类型">
                <button type="button" class="input-seg__btn" :class="{ 'input-seg__btn--active': newModelInputType === 'text' }" @click="newModelInputType = 'text'">文本</button>
                <button type="button" class="input-seg__btn" :class="{ 'input-seg__btn--active': newModelInputType === 'image' }" @click="newModelInputType = 'image'">图片</button>
              </div>
              <button class="btn btn-default btn-dense" @click="addModel(p)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                添加
              </button>
            </div>
          </div>

          <!-- 验证（测试连接 + 自动发现 + 结果反馈 + discovered 列表） -->
          <div class="sub-section">
            <div class="sub-label">验证</div>
            <div class="verify-row">
              <button class="btn btn-secondary btn-md" :disabled="testState[p.id]?.busy" @click="runTest(p)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
                {{ testState[p.id]?.busy ? '测试中…' : '测试连接' }}
              </button>
              <button class="btn btn-secondary btn-md" :disabled="discovering" @click="runDiscover">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                {{ discovering ? '发现中…' : '自动发现' }}
              </button>
            </div>
            <div v-if="testState[p.id]?.msg" class="test-result" :class="testState[p.id].ok ? 'ok' : 'fail'">
              <svg v-if="testState[p.id].ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {{ testState[p.id].msg }}
            </div>
            <div v-else class="verify-result">点击「测试连接」验证凭据与可达性。</div>
            <div v-if="discovered.length" class="discovered-box">
              <div class="disc-label">发现的 provider（mock 探测 · 局域网）</div>
              <div v-for="d in discovered" :key="d.id" class="disc-item">
                <span class="status-dot ok"></span>
                <span class="disc-name">{{ d.name }}</span>
                <span class="disc-proto">{{ d.proto }}</span>
                <span class="disc-count">{{ d.modelCount }} 模型</span>
                <span class="src-badge">发现</span>
                <span class="spacer"></span>
                <button class="btn btn-secondary btn-dense" @click="adoptDiscovered(d)">采纳</button>
                <button class="btn btn-ghost btn-dense" @click="ignoreDiscovered(d.id)">忽略</button>
              </div>
            </div>
          </div>

          <!-- 高级（默认折叠 · headers + Coding Plan 额度） -->
          <details class="adv-details">
            <summary class="adv-summary">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              高级
            </summary>
            <ProviderAdvancedSection
              :headers="headers[p.id] ?? []"
              :quota="quota[p.id] ?? []"
              :busy="!!quotaBusy[p.id]"
              :error="quotaError[p.id] ?? ''"
              :quota-ok="!!quotaOk[p.id]"
              @add-header="addHeader(p)"
              @remove-header="(i) => removeHeader(p, i)"
              @header-change="(i, f, v) => changeHeader(p, i, f, v)"
              @refresh-quota="refreshQuota(p)"
            />
          </details>

          <!-- M11 save-bar：编辑期间出现，与 dirty 联动 -->
          <div v-if="p.dirty" class="save-bar">
            <span class="bar-dirty-badge"><span class="dot"></span>未保存</span>
            <span v-if="saveError[p.id]" class="sb-error">{{ saveError[p.id] }}</span>
            <span class="spacer"></span>
            <button class="btn btn-ghost btn-md" :disabled="saving" @click="cancelEdit(p)">取消</button>
            <button class="btn btn-default btn-md" data-testid="provider-save-btn" :disabled="saving || !!saveError[p.id]" @click="saveEdit(p)">{{ saving ? '保存中…' : '保存' }}</button>
          </div>
        </div>
      </section>
    </div>

    <ProviderUnsavedDialog v-if="confirmState" :title="confirmMeta.title" :desc="confirmMeta.desc" :kind="confirmMeta.kind" @continue="confirmContinue" @discard="confirmDiscard" />
    <ProviderImportDialog v-if="importOpen" @close="importOpen = false" @imported="onImported" />
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-6);
  position: sticky;
  top: 0;
  background: var(--bg-elevated);
  z-index: var(--z-sticky);
}
.head-text { min-width: 0; }
.title { font-size: 20px; font-weight: 600; color: var(--neutral-fg); letter-spacing: -0.01em; }
.desc { margin-top: var(--space-2); font-size: var(--text-sm); color: var(--neutral-mid); }
.head-actions { display: flex; gap: var(--space-2); flex-shrink: 0; }

/* M14 页级横幅（错误常驻 + 成功临时） */
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
.inline-error svg { width: 14px; height: 14px; flex-shrink: 0; }
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

.provider-list { display: flex; flex-direction: column; gap: var(--space-4); }
.provider-card { background: var(--bg-card); border-radius: var(--radius); overflow: hidden; }
.row-head { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-4); min-height: 48px; }
.status-dot { width: 7px; height: 7px; border-radius: 999px; flex-shrink: 0; }
.status-dot.ok { background: var(--success); }
.status-dot.neutral { background: var(--neutral-dim); }
.name { font-size: var(--text-md); font-weight: 600; color: var(--neutral-fg); cursor: pointer; }
.name-chevron { width: 12px; height: 12px; color: var(--neutral-dim); vertical-align: -1px; transition: transform var(--duration-fast) var(--ease); }
.name-chevron.down { transform: rotate(90deg); }
.default-pill {
  height: 18px; padding: 2px 6px; display: inline-flex; align-items: center; border-radius: 999px;
  background: var(--accent-soft); color: var(--accent); font-size: var(--text-2xs); font-weight: 500; flex-shrink: 0;
}
.model-count { font-size: var(--text-sm); color: var(--neutral-mid); }
.dirty-badge {
  height: 18px; padding: 0 8px; display: inline-flex; align-items: center; gap: var(--space-2); border-radius: 999px;
  background: var(--warn-soft); color: var(--warn); font-size: var(--text-2xs); font-weight: 600; flex-shrink: 0;
}
.dirty-badge .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--warn); flex-shrink: 0; }
.spacer { flex: 1; }
.del-btn:hover { color: var(--danger); }

/* M13 乐观更新三态：pending（脉冲 + 禁用） / rollback（danger 外环） */
.switch-opt { display: inline-flex; flex-shrink: 0; border-radius: 999px; }
.switch-pending { animation: switch-pulse 1s ease-in-out infinite; }
.switch-rollback { box-shadow: 0 0 0 2px var(--danger-soft); }
@keyframes switch-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
@media (prefers-reduced-motion: reduce) {
  .switch-pending { animation: none; opacity: 0.55; }
}

.expand-body {
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.sub-section { display: flex; flex-direction: column; gap: var(--space-3); }
.sub-label { font-size: var(--text-xs); font-weight: 600; color: var(--neutral-fg); }
.cred-row { display: flex; gap: var(--space-2); align-items: center; }
.key-input { flex: 1; }
.cred-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.cred-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.cred-field-wide { grid-column: 1 / -1; }
.field-label { font-size: var(--text-xs); color: var(--neutral-mid); font-weight: 500; }
.fld-hint { font-size: var(--text-2xs); color: var(--neutral-dim); font-weight: 400; }
.select-wrap { position: relative; }
.select-chevron {
  position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
  width: 12px; height: 12px; pointer-events: none; color: var(--neutral-dim); opacity: 0.5;
}
.type-select {
  height: 40px; border-radius: var(--radius); background: var(--surface-2); border: 1px solid var(--border);
  padding: 0 28px 0 12px; font-size: var(--text-base); color: var(--neutral-fg); outline: none; cursor: pointer; appearance: none;
}

.model-list { display: flex; flex-direction: column; gap: var(--space-2); }
.model-row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); }
.model-name-input { flex: 1; }
.thinking-pill {
  height: 22px; padding: 0 8px; display: inline-flex; align-items: center; border-radius: 999px;
  font-size: var(--text-2xs); font-weight: 600; flex-shrink: 0;
}
.thinking-pill.tp-all { background: var(--info-soft); color: var(--info); }
.thinking-pill.tp-hightop { background: var(--accent-soft); color: var(--accent); }
.thinking-pill.tp-toggle { background: var(--surface); color: var(--neutral-mid); }
.spacer-tag { width: 44px; flex-shrink: 0; }
.default-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--info); flex-shrink: 0; }
.adv-chevron svg { width: 14px; height: 14px; transition: transform var(--duration-fast) var(--ease); transform: rotate(-90deg); }
.adv-chevron.down svg { transform: rotate(0deg); }
.model-adv-drawer {
  grid-column: 1 / -1; width: 100%; margin-top: var(--space-2); padding: var(--space-3);
  background: var(--surface-2); border-radius: var(--radius);
}
.verify-row { display: flex; align-items: center; gap: var(--space-3); }
.verify-row .btn svg { width: 14px; height: 14px; }
.verify-result { font-size: var(--text-sm); color: var(--neutral-dim); }
.test-result { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
.test-result.ok { color: var(--success); }
.test-result.fail { color: var(--danger); }

/* M8 自动发现列表 */
.discovered-box {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-3); background: var(--surface-2); border-radius: var(--radius);
}
.disc-label { font-size: var(--text-xs); color: var(--neutral-mid); font-weight: 500; }
.disc-item { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.disc-name { font-size: var(--text-sm); font-weight: 600; color: var(--neutral-fg); }
.disc-proto { font-size: var(--text-2xs); color: var(--neutral-mid); font-family: var(--font-mono); background: var(--bg-input); padding: 1px 6px; border-radius: var(--radius-sm); }
.disc-count { font-size: var(--text-xs); color: var(--neutral-mid); }
.src-badge {
  height: 18px; padding: 0 8px; display: inline-flex; align-items: center; border-radius: 999px;
  background: var(--info-soft); color: var(--info); font-size: var(--text-2xs); font-weight: 600;
}

.auth-header-row {
  display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3);
  background: var(--surface-2); border-radius: var(--radius);
}
.auth-header-label { font-size: var(--text-sm); font-weight: 600; color: var(--neutral-fg); }
.auth-header-desc { font-size: var(--text-sm); color: var(--neutral-mid); }

.model-add-row {
  display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); padding: var(--space-2);
  background: var(--surface-2); border-radius: var(--radius);
}
.model-add-input { flex: 1; min-width: 0; }
.input-seg { display: flex; gap: 2px; padding: 3px; background: var(--bg-input); border-radius: var(--radius); flex-shrink: 0; }
.input-seg__btn {
  height: 26px; padding: 0 10px; border-radius: var(--radius-sm); border: 0; background: transparent;
  font-size: var(--text-xs); color: var(--neutral-mid); cursor: pointer;
  transition: background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.input-seg__btn:hover { color: var(--neutral-fg); }
.input-seg__btn--active { background: var(--surface-hover); color: var(--neutral-fg); }

.set-default-btn { margin-top: var(--space-3); }
.set-default-btn svg { width: 14px; height: 14px; }

.empty-state { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); padding: 64px 0; text-align: center; }
.empty-icon {
  width: 64px; height: 64px; display: grid; place-items: center; border-radius: 999px;
  border: 2px dashed var(--border-strong); margin-bottom: var(--space-2);
}
.empty-icon svg { width: 28px; height: 28px; color: var(--neutral-dim); }
.empty-title { font-size: var(--text-md); font-weight: 500; color: var(--neutral-fg); }
.empty-desc { font-size: var(--text-sm); color: var(--neutral-mid); max-width: 360px; }

.adv-summary { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); color: var(--neutral-mid); cursor: pointer; list-style: none; user-select: none; }
.adv-summary::-webkit-details-marker { display: none; }
.adv-summary svg { width: 14px; height: 14px; transition: transform var(--duration-fast) var(--ease); }
.adv-details[open] .adv-summary svg { transform: rotate(180deg); }
.adv-body { padding-top: var(--space-3); }

.save-bar {
  display: flex; align-items: center; gap: var(--space-2);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  position: sticky; bottom: 0; background: var(--surface);
  margin: 0 calc(-1 * var(--space-4)) calc(-1 * var(--space-4));
  padding: var(--space-3) var(--space-4);
}
.bar-dirty-badge { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); color: var(--warn); font-weight: 600; }
.bar-dirty-badge .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--warn); }
.sb-error { font-size: var(--text-sm); color: var(--danger); }
</style>
