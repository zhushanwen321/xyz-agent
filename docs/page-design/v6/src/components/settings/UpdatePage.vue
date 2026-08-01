<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { settingsOpen, settingsPage, closeSettings, type SettingsPage } from '@/composables/useStore'
import UiInput from './UiInput.vue'
import UiSwitch from './UiSwitch.vue'
import SettingRow from './SettingRow.vue'
import GroupCard from './GroupCard.vue'
import {
  CURRENT_VERSION,
  UPDATE_CHANNEL,
  NEW_VERSION,
  NEW_VERSION_DATE,
  RELEASE_NOTES,
  PROXY_MODE_OPTIONS,
  PROXY_TEXT,
  FAIL_PROXY_ADDR,
  CHECK_DELAY,
  DOWNLOAD_DELAY,
  SAVE_DELAY,
  TEST_DELAY,
} from '@/mock/update'

/** UpdatePage：更新设置页（自动更新 + 代理配置）。
 * 自动更新区块：开关（参与编辑态）+ 版本信息 + 检查更新状态机
 * （idle → checking → latest / available / check-failed；available 卡内 下载 → 首败重试成功）。
 * 代理配置区块：字段/交互抄真实组件 UpdatePage.vue —— 代理模式 select + HTTP/HTTPS 代理
 * + 测试代理（disabled 模式 skipped 提示）+ 保存（URL 校验）。
 * 编辑态状态机（§4.3）：快照 diff → dirty（净零翻转恢复 clean）→ save-bar 保存/放弃
 * + 离开守卫（sync watch 拦截切页/关闭，放弃先还原再导航）。*/

type ProxyMode = 'system' | 'manual' | 'disabled'

/** 模式切换：旧测试结果失效（真实组件语义）；手动地址保留不丢（demo 裁剪项：真实组件会清空） */
function onModeChange() {
  testResult.value = null
  saveError.value = ''
}

// ── 编辑表单 + 快照 diff（初值不 dirty；改回快照值即净零恢复 clean） ──
const autoUpdate = ref(true)
const proxy = reactive<{ mode: ProxyMode; httpProxy: string; httpsProxy: string }>({
  mode: 'system',
  httpProxy: '',
  httpsProxy: '',
})
/** 快照必须是响应式：snapshot() 替换后 computed 依赖变化才能重算（否则保存后 dirty 卡 true） */
const saved = ref({ autoUpdate: true, mode: 'system' as ProxyMode, httpProxy: '', httpsProxy: '' })
function snapshot() {
  saved.value = { autoUpdate: autoUpdate.value, mode: proxy.mode, httpProxy: proxy.httpProxy, httpsProxy: proxy.httpsProxy }
}
/** 放弃编辑：还原快照 + 清错误/测试结果（查询流 checkPhase 不还原，与编辑态独立） */
function restore() {
  autoUpdate.value = saved.value.autoUpdate
  proxy.mode = saved.value.mode
  proxy.httpProxy = saved.value.httpProxy
  proxy.httpsProxy = saved.value.httpsProxy
  saveError.value = ''
  testResult.value = null
}
snapshot()
const dirty = computed(
  () =>
    autoUpdate.value !== saved.value.autoUpdate ||
    proxy.mode !== saved.value.mode ||
    proxy.httpProxy !== saved.value.httpProxy ||
    proxy.httpsProxy !== saved.value.httpsProxy,
)

// ── 检查更新状态机：idle → checking → latest / available / check-failed ──
type CheckPhase = 'idle' | 'checking' | 'latest' | 'available' | 'check-failed'
const checkPhase = ref<CheckPhase>('idle')
const checkError = ref('')
const lastCheckedAt = ref('')
/** 已发现的新版本号：发现后未安装 → 再查仍 available；安装完成 → 再查 latest */
let discoveredVersion = ''
/** demo 状态机触发：置位后下一次检查失败（正式版无此约定） */
let failNextCheck = false
const installedVersion = ref(CURRENT_VERSION)
let checkTimer: ReturnType<typeof setTimeout> | undefined
function checkForUpdates() {
  if (checkPhase.value === 'checking' || updating.value) return
  checkPhase.value = 'checking'
  checkError.value = ''
  clearTimeout(checkTimer)
  checkTimer = setTimeout(() => {
    lastCheckedAt.value = new Date().toLocaleString('zh-CN', { hour12: false })
    if (failNextCheck) {
      failNextCheck = false
      checkError.value = '检查更新失败：无法连接更新服务，请检查网络后重试'
      checkPhase.value = 'check-failed'
      return
    }
    if (discoveredVersion === '') {
      discoveredVersion = NEW_VERSION
      checkPhase.value = 'available'
    } else if (installedVersion.value !== discoveredVersion) {
      checkPhase.value = 'available'
    } else {
      checkPhase.value = 'latest'
    }
  }, CHECK_DELAY)
}

// ── 更新流：available 卡内 下载 → 首次失败（下载中断）→ 重试成功（demo 两分支可复现） ──
const updating = ref(false)
const updateFailed = ref(false)
const updateError = ref('')
/** 已下载完成待重启生效（版本行显示「重启后生效」pill） */
const updatePending = ref(false)
let updateAttempt = 0
let updateTimer: ReturnType<typeof setTimeout> | undefined
function startUpdate() {
  if (updating.value) return
  updating.value = true
  updateFailed.value = false
  updateError.value = ''
  clearTimeout(updateTimer)
  updateTimer = setTimeout(() => {
    updating.value = false
    updateAttempt++
    if (updateAttempt === 1) {
      updateFailed.value = true
      updateError.value = '下载中断：网络连接不稳定，请重试'
      return
    }
    installedVersion.value = NEW_VERSION
    updatePending.value = true
    checkPhase.value = 'idle'
  }, DOWNLOAD_DELAY)
}
function dismissUpdate() {
  updatePending.value = false
}

// ── 测试代理（独立操作流，不参与 dirty；disabled 模式 skipped；9999 地址模拟失败） ──
type TestResult =
  | { status: 'success' }
  | { status: 'failed'; message: string }
  | { status: 'skipped'; message: string }
const testing = ref(false)
const testResult = ref<TestResult | null>(null)
let testTimer: ReturnType<typeof setTimeout> | undefined
function testProxy() {
  if (testing.value) return
  if (proxy.mode === 'disabled') {
    testResult.value = { status: 'skipped', message: PROXY_TEXT.testDisabled }
    return
  }
  testing.value = true
  testResult.value = null
  clearTimeout(testTimer)
  testTimer = setTimeout(() => {
    testing.value = false
    if (proxy.mode === 'manual' && !proxy.httpProxy.trim()) {
      testResult.value = { status: 'failed', message: PROXY_TEXT.httpRequired }
    } else if (proxy.httpProxy.includes(FAIL_PROXY_ADDR)) {
      testResult.value = { status: 'failed', message: PROXY_TEXT.testFailed + '：连接超时，无法访问代理服务' }
    } else {
      testResult.value = { status: 'success' }
    }
  }, TEST_DELAY)
}

// ── 保存流：校验 → saving → 成功（快照刷新 + 1.5s「已保存」）/ 失败（save-bar 错误条） ──
const saving = ref(false)
const saveError = ref('')
const savedNote = ref('')
let saveTimer: ReturnType<typeof setTimeout> | undefined
let noteTimer: ReturnType<typeof setTimeout> | undefined
function save() {
  if (saving.value) return
  if (proxy.mode === 'manual') {
    if (!proxy.httpProxy.trim()) {
      saveError.value = PROXY_TEXT.httpRequired
      return
    }
    try {
      new URL(proxy.httpProxy)
      if (proxy.httpsProxy.trim()) new URL(proxy.httpsProxy)
    } catch {
      saveError.value = PROXY_TEXT.invalidUrl
      return
    }
  }
  saveError.value = ''
  saving.value = true
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saving.value = false
    if (proxy.httpProxy.includes(FAIL_PROXY_ADDR)) {
      saveError.value = PROXY_TEXT.saveFailed
      return
    }
    snapshot()
    testResult.value = null
    savedNote.value = PROXY_TEXT.saved
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => {
      savedNote.value = ''
    }, 1500)
  }, SAVE_DELAY)
}

// ── 离开守卫（§4.3：dirty 拦截切页/关闭；放弃必须先还原快照再导航，防 sync watch 重入弹窗永久重开） ──
const confirmOpen = ref(false)
const pendingLeave = ref<SettingsPage | 'close' | null>(null)
watch(
  () => [settingsPage.value, settingsOpen.value] as const,
  ([page, open]) => {
    if (open && page === 'update') return
    if (!dirty.value) return
    pendingLeave.value = page !== 'update' ? page : 'close'
    settingsPage.value = 'update'
    settingsOpen.value = true
    confirmOpen.value = true
  },
  { flush: 'sync' },
)
function keepEditing() {
  confirmOpen.value = false
}
function discardAndLeave() {
  confirmOpen.value = false
  restore()
  if (pendingLeave.value === 'close') closeSettings()
  else if (pendingLeave.value) settingsPage.value = pendingLeave.value
}
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onUnmounted(() => window.removeEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => {
  clearTimeout(checkTimer)
  clearTimeout(updateTimer)
  clearTimeout(testTimer)
  clearTimeout(saveTimer)
  clearTimeout(noteTimer)
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">更新</h1>
        <p class="desc">配置自动升级与代理设置。自动更新保持应用为最新版本，代理配置用于访问 GitHub 服务。</p>
      </div>
    </header>

    <!-- 保存成功临时反馈（1.5s） -->
    <div v-if="savedNote" class="success-note">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      {{ savedNote }}
    </div>

    <!-- ══ 自动更新 ══ -->
    <GroupCard title="自动更新">
      <SettingRow label="自动更新" desc="启动时自动检查更新，发现新版本后提示下载安装">
        <UiSwitch :checked="autoUpdate" aria-label="自动更新" @update:checked="(v) => (autoUpdate = v)" />
      </SettingRow>

      <SettingRow label="当前版本" :desc="`${UPDATE_CHANNEL} 渠道 · 更新完成后需重启应用生效`">
        <span class="ver-pill">{{ installedVersion }}</span>
        <span v-if="updatePending" class="ver-pill pending">重启后生效</span>
      </SettingRow>

      <SettingRow label="检查更新" :desc="lastCheckedAt ? `上次检查：${lastCheckedAt}` : '手动检查是否有新版本'">
        <button
          class="btn btn-secondary btn-dense"
          :disabled="checkPhase === 'checking' || updating"
          @click="checkForUpdates"
        >
          <svg class="check-icon" :class="{ spin: checkPhase === 'checking' }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><polyline points="21 3 21 9 15 9"/></svg>
          {{ checkPhase === 'checking' ? '检查中…' : '检查更新' }}
        </button>
        <!-- demo 状态机触发：模拟检查更新失败（正式版无此按钮） -->
        <button class="btn btn-ghost btn-icon-sm" title="模拟检查更新失败（demo）" aria-label="模拟检查更新失败" @click="failNextCheck = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>
        </button>
      </SettingRow>

      <!-- 检查结果区 -->
      <div v-if="checkPhase === 'checking'" class="status-row">
        <svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        <span class="status-text">正在检查更新…</span>
      </div>

      <div v-else-if="checkPhase === 'check-failed'" class="err-bar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>{{ checkError }}</span>
        <button class="btn btn-secondary btn-dense err-retry" @click="checkForUpdates">重试</button>
      </div>

      <div v-else-if="checkPhase === 'latest'" class="status-row">
        <span class="dot ok"></span>
        <span class="status-text">已是最新版本 {{ installedVersion }}</span>
        <span class="status-hint">你正在使用最新版本</span>
      </div>

      <div v-else-if="checkPhase === 'available'" class="release-card">
        <div v-if="updateFailed" class="err-bar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>{{ updateError }}</span>
        </div>
        <div class="rel-head">
          <div class="rel-meta">
            <div class="rel-version">发现新版本 {{ NEW_VERSION }}</div>
            <div class="rel-date">发布于 {{ NEW_VERSION_DATE }}</div>
          </div>
          <span class="spacer"></span>
          <span class="rel-current">当前 {{ installedVersion }}</span>
        </div>
        <ul class="rel-notes">
          <li v-for="n in RELEASE_NOTES" :key="n">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <span>{{ n }}</span>
          </li>
        </ul>
        <div class="rel-actions">
          <span class="rel-hint">更新完成后重启应用生效</span>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-dense" :disabled="updating" @click="checkPhase = 'idle'">忽略</button>
          <button class="btn btn-default btn-dense" :disabled="updating" @click="startUpdate">
            <svg v-if="!updating" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
            <svg v-else class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            {{ updating ? '下载中…' : '立即更新' }}
          </button>
        </div>
      </div>

      <!-- 更新完成（待重启） -->
      <div v-else-if="updatePending" class="status-row">
        <span class="dot ok"></span>
        <span class="status-text">更新完成：{{ installedVersion }} 已下载</span>
        <span class="status-hint">重启应用后生效</span>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-dense" @click="dismissUpdate">知道了</button>
      </div>
    </GroupCard>

    <!-- ══ 代理配置 ══ -->
    <GroupCard title="代理配置">
      <SettingRow label="代理模式" :desc="PROXY_MODE_OPTIONS.find((o) => o.value === proxy.mode)?.desc ?? ''">
        <div class="select-wrap">
          <select v-model="proxy.mode" class="mode-select" aria-label="代理模式" @change="onModeChange">
            <option v-for="o in PROXY_MODE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <svg class="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </SettingRow>

      <template v-if="proxy.mode === 'manual'">
        <SettingRow label="HTTP 代理" desc="必填。GitHub 请求走该地址">
          <UiInput
            :model-value="proxy.httpProxy"
            :mono="true"
            placeholder="如 http://127.0.0.1:7890"
            class="proxy-input"
            :error="!!saveError"
            @update:model-value="(v) => {
              proxy.httpProxy = v
              saveError = ''
            }"
          />
        </SettingRow>
        <SettingRow label="HTTPS 代理" desc="可选。留空则复用 HTTP 代理">
          <UiInput
            :model-value="proxy.httpsProxy"
            :mono="true"
            placeholder="如 http://127.0.0.1:7890"
            class="proxy-input"
            :error="!!saveError"
            @update:model-value="(v) => {
              proxy.httpsProxy = v
              saveError = ''
            }"
          />
        </SettingRow>
      </template>

      <SettingRow label="测试代理" desc="验证代理连通性，结果仅供参考">
        <span v-if="testResult" class="test-result" :class="testResult.status">
          {{ testResult.status === 'success' ? PROXY_TEXT.testSuccess : testResult.message }}
        </span>
        <button
          class="btn btn-secondary btn-dense"
          :disabled="testing || proxy.mode === 'disabled'"
          :title="proxy.mode === 'disabled' ? PROXY_TEXT.testDisabled : undefined"
          @click="testProxy"
        >
          <svg v-if="!testing" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          <svg v-else class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          {{ testing ? '测试中…' : '测试代理' }}
        </button>
      </SettingRow>
    </GroupCard>

    <!-- 编辑态 save-bar：dirty 时出现，sticky 底部 -->
    <div v-if="dirty" class="save-bar">
      <span class="bar-dirty"><span class="dot warn"></span>未保存</span>
      <span v-if="saveError" class="sb-error">{{ saveError }}</span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-md" :disabled="saving" @click="restore">放弃</button>
      <button class="btn btn-default btn-md" :disabled="saving || !!saveError" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
    </div>

    <!-- 离开守卫确认弹窗（§4.3 内联自建） -->
    <div v-if="confirmOpen" class="guard-stage" @click.self="keepEditing">
      <div class="guard-card" role="dialog" aria-modal="true" aria-label="放弃未保存的改动？">
        <div class="guard-title">放弃未保存的改动？</div>
        <p class="guard-desc">自动更新与代理配置有未保存的改动，离开设置将丢弃这些改动，此操作不可撤销。</p>
        <div class="guard-actions">
          <button class="btn btn-default btn-dense" @click="keepEditing">继续编辑</button>
          <button class="btn btn-danger btn-dense" @click="discardAndLeave">放弃改动</button>
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
.head-text {
  min-width: 0;
}
.title {
  font-size: 20px;
  font-weight: 600;
  color: var(--neutral-fg);
  letter-spacing: -0.01em;
}
.desc {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}

/* 保存成功临时反馈（ProviderPage success-note 范式） */
.success-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: var(--space-3);
  font-size: var(--text-xs);
  color: var(--success);
}

/* 版本 pill（mono bg-input；pending = accent-soft） */
.ver-pill {
  height: 22px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--neutral-mid);
  font-size: var(--text-xs);
  font-weight: 600;
  font-family: var(--font-mono);
  flex-shrink: 0;
}
.ver-pill.pending {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 状态行（对齐 SettingRow 内边距 + hairline 分隔） */
.status-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 10px 6px;
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  min-height: 48px;
  font-size: var(--text-base);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex-shrink: 0;
}
.dot.ok {
  background: var(--success);
  opacity: 0.9;
}
.dot.warn {
  background: var(--warn);
}
.status-text {
  color: var(--neutral-fg);
}
.status-hint {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  margin-left: auto;
}
.spinner {
  width: 13px;
  height: 13px;
  color: var(--accent);
  flex-shrink: 0;
  animation: spin 1s linear infinite;
}
.check-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.check-icon.spin {
  animation: spin 0.9s linear infinite;
}

/* 错误条（danger-soft 底 + danger 字 + 可选重试） */
.err-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin: 0 6px var(--space-3);
  background: var(--danger-soft);
  border-radius: var(--radius);
  font-size: var(--text-xs);
  color: var(--danger);
}
.err-bar svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.err-bar .err-retry {
  margin-left: auto;
  color: var(--danger);
  border-color: color-mix(in oklch, var(--danger) 35%, transparent);
}
.err-bar .err-retry:hover {
  background: color-mix(in oklch, var(--danger) 14%, transparent);
}

/* 发现新版本卡（bg-input 层级代替边框） */
.release-card {
  margin: 0 6px var(--space-3);
  background: var(--bg-input);
  border-radius: var(--radius);
  padding: var(--space-4);
}
.release-card .err-bar {
  margin: 0 0 var(--space-3);
}
.rel-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}
.rel-version {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--accent);
}
.rel-date {
  margin-top: 2px;
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}
.rel-current {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  font-family: var(--font-mono);
  flex-shrink: 0;
}
.rel-notes {
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rel-notes li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.rel-notes li svg {
  width: 13px;
  height: 13px;
  color: var(--success);
  flex-shrink: 0;
  margin-top: 2px;
}
.rel-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.rel-hint {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}

/* 代理模式 select（dense 32px 变体，ProviderPage type-select 范式） */
.select-wrap {
  position: relative;
}
.mode-select {
  height: 32px;
  min-width: 180px;
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 0 28px 0 12px;
  font-size: var(--text-sm);
  color: var(--neutral-fg);
  outline: none;
  cursor: pointer;
  appearance: none;
}
.mode-select:focus-visible {
  box-shadow: 0 0 0 1px var(--accent-ring);
}
.select-chevron {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  width: 12px;
  height: 12px;
  pointer-events: none;
  color: var(--neutral-dim);
  opacity: 0.5;
}
.proxy-input {
  width: 260px;
}

/* 测试代理结果文字 */
.test-result {
  font-size: var(--text-xs);
  flex-shrink: 0;
}
.test-result.success {
  color: var(--success);
}
.test-result.failed {
  color: var(--danger);
}
.test-result.skipped {
  color: var(--neutral-mid);
}

/* save-bar：dirty 时 sticky 底部（surface 底 + hairline 顶） */
.save-bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  position: sticky;
  bottom: 0;
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  background: var(--surface);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  border-radius: var(--radius);
}
.bar-dirty {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--neutral-mid);
  flex-shrink: 0;
}
.sb-error {
  font-size: var(--text-xs);
  color: var(--danger);
  min-width: 0;
}

/* 离开守卫弹窗（§4.3 内联自建：fixed inset-0 遮罩 + 居中卡片） */
.guard-stage {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(4px);
}
.guard-card {
  width: 100%;
  max-width: 400px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  padding: 20px;
}
.guard-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--neutral-fg);
}
.guard-desc {
  font-size: var(--text-base);
  line-height: 1.55;
  color: var(--neutral-mid);
  margin: 8px 0 16px;
}
.guard-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
