<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import GroupCard from './GroupCard.vue'
import UiInput from './UiInput.vue'

/**
 * InstallArea：安装新扩展（spec §4 npm 单步 + §5 dir/git 多步：发现→选择→安装）。
 * 无后端，全流程 setTimeout mock（1.2s 安装/发现，进度条步进模拟）。
 * npm 直装：格式校验（inline error）→ working（spinner + hint）→ 成功 emit installed / 失败错误条（可重试）。
 * dir/git：发现 → 候选内联（Checkbox 默认不勾 + 全选三态 + N/M 计数）→ 安装选中（进度条）→ 完成。
 * 错误类型（M4）：格式不合法 / 包不存在 404 / 已存在 / 版本冲突。
 */
export interface InstalledPayload {
  name: string
  desc: string
  version: string
  tools: string[]
}

const props = defineProps<{ installedNames: string[] }>()
const emit = defineEmits<{ (e: 'installed', ext: InstalledPayload): void }>()

type Tab = 'npm' | 'local' | 'git'
type Phase = 'idle' | 'working' | 'candidates' | 'installing'

const TABS: { id: Tab; label: string }[] = [
  { id: 'npm', label: 'npm' },
  { id: 'local', label: 'Local Dir' },
  { id: 'git', label: 'Git URL' },
]

interface Candidate {
  name: string
  version: string
  desc: string
  checked: boolean
}

/** dir/git 发现的 mock 候选（spec §5 示例数据） */
const CANDIDATE_POOL: Omit<Candidate, 'checked'>[] = [
  { name: 'chart-renderer', version: 'v1.2.0', desc: 'Markdown 内嵌图表渲染工具' },
  { name: 'data-fetch', version: 'v0.9.1', desc: 'HTTP 数据抓取与缓存' },
  { name: 'pdf-export', version: 'v2.0.0', desc: '对话导出为 PDF' },
]

const tab = ref<Tab>('npm')
const value = ref('')
const phase = ref<Phase>('idle')
const hint = ref('')
const error = ref('')
/** 成功反馈条（spec §8 Toast 的 demo 简化：install-ok 条 2s 消失） */
const notice = ref('')
const workingLabel = ref('安装中')
const candidates = ref<Candidate[]>([])
const progress = ref(0)
let timer: ReturnType<typeof setTimeout> | undefined
let timer2: ReturnType<typeof setTimeout> | undefined

const busy = computed(() => phase.value === 'working' || phase.value === 'installing')
const canSubmit = computed(() => !busy.value && value.value.trim().length > 0)
const selectedCount = computed(() => candidates.value.filter((c) => c.checked).length)
const allChecked = computed(
  () => candidates.value.length > 0 && selectedCount.value === candidates.value.length,
)
const someChecked = computed(() => selectedCount.value > 0 && !allChecked.value)
const placeholder = computed(() =>
  tab.value === 'npm'
    ? 'npm:package-name'
    : tab.value === 'local'
      ? '/path/to/extension 或 ./relative/dir'
      : 'https://github.com/org/repo.git',
)

/** npm 包名：可选 @scope/ 前缀 + 小写字母/数字/-/_/. */
const NPM_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const GIT_RE = /^(https?:\/\/|git@)/

function clearTimers() {
  clearTimeout(timer)
  clearTimeout(timer2)
}

function fail(msg: string) {
  error.value = msg
  phase.value = 'idle'
}

function startNpmInstall() {
  const name = value.value.trim()
  error.value = ''
  notice.value = ''
  if (!NPM_RE.test(name)) {
    fail('包名格式不合法：仅允许小写字母、数字、-、_、. 及可选的 @scope/ 前缀')
    return
  }
  if (props.installedNames.includes(name)) {
    fail(`已存在：${name} 已安装 · 如需更新请用卡片上的升级按钮`)
    return
  }
  workingLabel.value = '安装中'
  hint.value = '正在从 npm 拉取并安装…'
  phase.value = 'working'
  clearTimers()
  timer = setTimeout(() => {
    if (name.includes('missing')) {
      fail(`包不存在：404 Not found「${name}」· 检查包名或改用 Local Dir / Git URL`)
      return
    }
    if (name.includes('conflict')) {
      fail(`版本冲突：本地 ${name} 已有更高版本 · 若仍需安装请先卸载现有版本`)
      return
    }
    emit('installed', {
      name,
      desc: `通过 npm 安装的第三方扩展（${name}）`,
      version: 'v0.1.0',
      tools: [name.replace(/^@[^/]+\//, '').replace(/[^a-z0-9]/g, '_')],
    })
    value.value = ''
    notice.value = `安装成功：${name} 已加入用户安装`
    phase.value = 'idle'
    timer2 = setTimeout(() => (notice.value = ''), 2000)
  }, 1200)
}

function startDiscover() {
  const v = value.value.trim()
  error.value = ''
  notice.value = ''
  if (tab.value === 'git' && !GIT_RE.test(v)) {
    fail('URL 格式不合法：需为 https:// 或 git@ 开头的 Git 仓库地址')
    return
  }
  workingLabel.value = '发现中'
  hint.value = '扫描目录中的 extension 候选…'
  phase.value = 'working'
  clearTimers()
  timer = setTimeout(() => {
    candidates.value = CANDIDATE_POOL.map((c) => ({ ...c, checked: false }))
    phase.value = 'candidates'
  }, 1200)
}

function submit() {
  if (!canSubmit.value) return
  if (tab.value === 'npm') startNpmInstall()
  else startDiscover()
}

function switchTab(t: Tab) {
  if (t === tab.value) return
  tab.value = t
  value.value = ''
  error.value = ''
  notice.value = ''
  candidates.value = []
  progress.value = 0
  phase.value = 'idle'
  clearTimers()
}

function toggleCandidate(c: Candidate) {
  c.checked = !c.checked
}
function toggleAll() {
  const target = !allChecked.value
  candidates.value.forEach((c) => (c.checked = target))
}
function cancelCandidates() {
  candidates.value = []
  value.value = ''
  phase.value = 'idle'
  error.value = ''
}

function installSelected() {
  const sel = candidates.value.filter((c) => c.checked)
  if (!sel.length) return
  phase.value = 'installing'
  progress.value = 0
  clearTimers()
  timer = setTimeout(() => (progress.value = 45), 250)
  timer2 = setTimeout(() => (progress.value = 80), 600)
  timer = setTimeout(() => {
    sel.forEach((c) =>
      emit('installed', { name: c.name, desc: c.desc, version: c.version, tools: [] }),
    )
    notice.value = `安装成功：${sel.length} 个扩展已加入用户安装`
    candidates.value = []
    progress.value = 0
    phase.value = 'idle'
    timer2 = setTimeout(() => (notice.value = ''), 2000)
  }, 1150)
}

onBeforeUnmount(clearTimers)
</script>

<template>
  <GroupCard title="安装新扩展">
    <div class="install-tabs">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="install-tab"
        :class="{ active: tab === t.id }"
        @click="switchTab(t.id)"
      >
        {{ t.label }}
      </button>
    </div>

    <div class="install-row">
      <UiInput
        v-model="value"
        :placeholder="placeholder"
        :mono="true"
        :error="!!error"
        :dense="true"
        :disabled="busy"
        @keyup.enter="submit"
      />
      <button
        v-if="tab === 'npm'"
        class="btn btn-default btn-dense"
        :disabled="!canSubmit"
        @click="startNpmInstall"
      >
        <svg v-if="phase !== 'working'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
        <svg v-else class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        {{ phase === 'working' ? '安装中' : '安装' }}
      </button>
      <button
        v-else
        class="btn btn-default btn-dense"
        :disabled="!canSubmit"
        @click="startDiscover"
      >
        <svg v-if="phase !== 'working'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <svg v-else class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        {{ phase === 'working' ? '发现中' : '发现' }}
      </button>
    </div>

    <div v-if="phase === 'working'" class="install-hint">{{ hint }}</div>

    <!-- M4：错误条（border-top hairline · AlertCircle + danger 文案「原因 + 下一步」） -->
    <div v-if="error" class="install-err" data-testid="install-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
      <span>{{ error }}</span>
    </div>
    <!-- 成功反馈（spec §8 Toast 的 demo 替代） -->
    <div v-if="notice" class="install-ok">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <span>{{ notice }}</span>
    </div>

    <!-- step 2：候选选择 + 安装（local/git 多步，spec §5） -->
    <div v-if="phase === 'candidates' || phase === 'installing'" class="cand-block">
      <div class="cand-head">
        <span class="cand-title">发现 {{ candidates.length }} 个候选</span>
        <button v-if="phase === 'candidates'" class="btn btn-ghost btn-dense" @click="cancelCandidates">取消</button>
      </div>

      <label v-for="c in candidates" :key="c.name" class="cand-row" @click.prevent="toggleCandidate(c)">
        <span class="ui-checkbox" :class="{ checked: c.checked }">
          <svg v-if="c.checked" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        </span>
        <div class="cand-info">
          <div class="cand-name-row">
            <span class="cand-name">{{ c.name }}</span>
            <span class="cand-ver">{{ c.version }}</span>
          </div>
          <span class="cand-desc">{{ c.desc }}</span>
        </div>
      </label>

      <div class="cand-foot">
        <div class="cand-foot-left">
          <label v-if="phase === 'candidates'" class="cand-all" @click.prevent="toggleAll">
            <span class="ui-checkbox" :class="{ checked: allChecked, indeterminate: someChecked }">
              <svg v-if="allChecked" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
              <svg v-else-if="someChecked" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>
            </span>
            全选
          </label>
          <span v-if="phase === 'candidates'" class="cand-count">已选 {{ selectedCount }} / {{ candidates.length }}</span>
          <template v-else>
            <span class="cand-count">正在安装 {{ selectedCount }} 个候选…</span>
            <div class="prog"><div class="bar" :style="{ width: progress + '%' }"></div></div>
          </template>
        </div>
        <button
          v-if="phase === 'candidates'"
          class="btn btn-default btn-dense"
          :disabled="selectedCount === 0"
          @click="installSelected"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          安装选中
        </button>
        <button v-else class="btn btn-default btn-dense" disabled>
          <svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          安装中
        </button>
      </div>
    </div>
  </GroupCard>
</template>

<style scoped>
/* spec §4：ghost tab · active bg-surface-hover + neutral-fg */
.install-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 8px 10px;
}
.install-tab {
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  cursor: pointer;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-family: var(--font-sans);
  transition: background var(--duration-fast), color var(--duration-fast);
}
.install-tab:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.install-tab.active {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.install-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px 12px;
}
.install-row :deep(.ui-input) {
  flex: 1;
}
.install-hint {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  padding: 0 12px 10px;
  font-family: var(--font-mono);
}
/* M4：错误条（spec §4/§8：border-top hairline · AlertCircle + danger） */
.install-err {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  padding: 9px 14px;
  font-size: var(--text-xs);
  color: var(--danger);
  line-height: 1.5;
}
.install-err svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  margin-top: 1px;
}
/* 成功反馈条（spec §8 Toast 的 demo 简化，success 同形） */
.install-ok {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  padding: 9px 14px;
  font-size: var(--text-xs);
  color: var(--success);
  line-height: 1.5;
}
.install-ok svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  margin-top: 1px;
}

/* spec §5：候选区 */
.cand-block {
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}
.cand-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 14px 9px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.cand-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--neutral-fg);
}
.cand-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  cursor: pointer;
}
.cand-row:first-of-type {
  border-top: 0;
}
.cand-row:hover {
  background: var(--surface);
}
.cand-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.cand-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.cand-name {
  font-size: var(--text-xs);
  color: var(--neutral-fg);
}
.cand-ver {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  background: var(--surface-2);
  padding: 2px 7px;
  border-radius: 999px;
  flex-shrink: 0;
}
.cand-desc {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.cand-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--border-strong);
}
.cand-foot-left {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.cand-all {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}
.cand-count {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  font-family: var(--font-mono);
}
/* 进度条（spec §5：4px track · accent bar） */
.prog {
  height: 4px;
  background: var(--surface-2);
  border-radius: 999px;
  overflow: hidden;
  width: 100%;
  max-width: 320px;
}
.prog .bar {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width var(--duration) var(--ease);
}

/* spec §7 Checkbox：16×16 · radius-sm · checked bg-accent + 白勾 · indeterminate 横杠 */
.ui-checkbox {
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px solid var(--border-strong);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: pointer;
  color: var(--accent-fg);
  padding: 0;
  transition: background var(--duration-fast) var(--ease), border-color var(--duration-fast) var(--ease);
}
.ui-checkbox.checked,
.ui-checkbox.indeterminate {
  background: var(--accent);
  border-color: var(--accent);
}
.ui-checkbox svg {
  width: 11px;
  height: 11px;
}

.spin {
  animation: spin 0.9s linear infinite;
}
</style>
