<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import {
  CANDIDATE_DIRS,
  INITIAL_DRAFT,
  LOAD_DELAY,
  SAVE_DELAY,
  SAVED_NOTE_DURATION,
  TEXT,
  type CandidateDir,
  type WorktreeDraft,
} from '@/mock/worktree'
import { closeSettings, settingsOpen, settingsPage, type SettingsPage } from '@/composables/useStore'
import GroupCard from './GroupCard.vue'
import SettingRow from './SettingRow.vue'
import UiInput from './UiInput.vue'

/** WorktreePage：工作区设置（worktree 目录配置）。
 * 真实组件字段：worktreeRootDir / setupScript / bareSetupScript / timeout / defaultBaseBranch。
 * 交互状态机（设计上下文 §4.3）：dirty 快照 diff（净零翻转恢复 clean）+ save-bar + 离开守卫 + beforeunload。*/

// ── 表单草案 + 已保存快照（dirty = 逐字段 diff）──
const draft = reactive<WorktreeDraft>({ ...INITIAL_DRAFT })
const saved = ref<WorktreeDraft>({ ...INITIAL_DRAFT })
const dirty = computed(() =>
  (Object.keys(draft) as (keyof WorktreeDraft)[]).some((k) => draft[k] !== saved.value[k]),
)

// ── 加载态（mock 拉取，skeleton 展示）──
const loading = ref(true)

// ── 保存流：mock 延迟 → 成功（快照刷新 + 1.5s 已保存）/ 失败（save-bar 错误条）──
const saving = ref(false)
const saveError = ref('')
const timeoutError = ref(false)
const savedNote = ref('')
let savedNoteTimer: ReturnType<typeof setTimeout> | undefined

function onField(k: keyof WorktreeDraft, v: string) {
  draft[k] = v
  saveError.value = ''
  // 任一字段编辑即清 timeoutError（不只是 timeout 字段，否则跨字段编辑残留错误态）
  timeoutError.value = false
}

function save() {
  if (saving.value) return
  const t = Number(draft.timeout)
  if (!Number.isInteger(t) || t < 1) {
    timeoutError.value = true
    saveError.value = TEXT.errTimeout
    return
  }
  timeoutError.value = false
  saveError.value = ''
  saving.value = true
  setTimeout(() => {
    saving.value = false
    // mock 失败分支：根目录含非法字符（演示错误条，快照不刷新，dirty 保持）
    if (draft.worktreeRootDir.includes('*')) {
      saveError.value = TEXT.errSaveFailed
      return
    }
    saved.value = { ...draft }
    // timeout 归一化：'060' → '60'（快照与草案同步归一，字符串态净零翻转不回 dirty）
    const t = String(Number(draft.timeout))
    saved.value.timeout = t
    draft.timeout = t
    savedNote.value = TEXT.saved
    clearTimeout(savedNoteTimer)
    savedNoteTimer = setTimeout(() => { savedNote.value = '' }, SAVED_NOTE_DURATION)
  }, SAVE_DELAY)
}

/** 放弃 = 还原快照 → dirty 归零（离开守卫依赖此序，否则 sync watch 重入弹窗永久重开） */
function cancel() {
  Object.assign(draft, saved.value)
  saveError.value = ''
  timeoutError.value = false
}

// ── 浏览（mock 目录选择，替代真实组件 disabled 的 Browse——无死按钮）──
const browseOpen = ref(false)
function pickDir(c: CandidateDir) {
  draft.worktreeRootDir = c.path
  browseOpen.value = false
  saveError.value = ''
}

// ── 离开守卫：切页/关闭设置时拦截 + 内联确认弹窗 ──
const confirmState = ref(false)
const pendingLeave = ref<SettingsPage | 'close' | null>(null)
watch(
  () => [settingsPage.value, settingsOpen.value] as const,
  ([page, open]) => {
    if (open && page === 'worktree') return
    if (!dirty.value) return
    pendingLeave.value = page !== 'worktree' ? page : 'close'
    settingsPage.value = 'worktree'
    settingsOpen.value = true
    confirmState.value = true
  },
  { flush: 'sync' },
)
function confirmContinue() { confirmState.value = false }
function confirmDiscard() {
  confirmState.value = false
  cancel()
  if (pendingLeave.value === 'close') closeSettings()
  else if (pendingLeave.value) settingsPage.value = pendingLeave.value
}
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value) { e.preventDefault(); e.returnValue = '' }
}

// ── 弹窗焦点管理（安全选择 = default 按钮 / 首项）──
const guardEl = ref<HTMLElement | null>(null)
const browseEl = ref<HTMLElement | null>(null)
watch(confirmState, (v) => {
  if (v) nextTick(() => guardEl.value?.querySelector<HTMLButtonElement>('button.btn-default')?.focus())
})
watch(browseOpen, (v) => {
  if (v) nextTick(() => browseEl.value?.querySelector<HTMLButtonElement>('button.dir-item')?.focus())
})

let loadTimer: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload)
  loadTimer = setTimeout(() => { loading.value = false }, LOAD_DELAY)
})
onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  clearTimeout(loadTimer)
  clearTimeout(savedNoteTimer)
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">工作区</h1>
        <p class="desc">{{ TEXT.pageDesc }}</p>
      </div>
    </header>

    <!-- 保存成功反馈（1.5s） -->
    <div v-if="savedNote" class="success-note" data-testid="worktree-saved-note">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      {{ savedNote }}
    </div>

    <!-- 加载骨架（shimmer） -->
    <div v-if="loading" class="skel-wrap" data-testid="worktree-loading">
      <div v-for="n in 3" :key="n" class="skel-card">
        <div class="skel skel-head"></div>
        <div class="skel-row">
          <div class="skel skel-label"></div>
          <div class="skel skel-input"></div>
        </div>
        <div class="skel-row">
          <div class="skel skel-label"></div>
          <div class="skel skel-input"></div>
        </div>
      </div>
    </div>

    <template v-else>
      <!-- Section 1：普通 git 仓库 -->
      <GroupCard>
        <template #head>
          <div class="gh">
            <h3 class="gh-title">{{ TEXT.groupPlainRepo }}</h3>
            <p class="gh-desc">{{ TEXT.groupPlainRepoDesc }}</p>
          </div>
        </template>
        <SettingRow :label="TEXT.worktreeRootDir" :desc="TEXT.worktreeRootDirHint">
          <div class="ctl-wide">
          <UiInput
            :model-value="draft.worktreeRootDir"
            :placeholder="TEXT.worktreeRootDirPlaceholder"
            data-testid="worktree-root-dir"
            @update:model-value="onField('worktreeRootDir', $event)"
          />
          </div>
          <button class="btn btn-secondary btn-dense" data-testid="worktree-browse-btn" @click="browseOpen = true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            {{ TEXT.browse }}
          </button>
        </SettingRow>
        <SettingRow :label="TEXT.setupScript" :desc="TEXT.setupScriptHint">
          <div class="ctl-wide">
          <UiInput
            :model-value="draft.setupScript"
            :mono="true"
            :placeholder="TEXT.setupScriptPlaceholder"
            data-testid="worktree-setup-script"
            @update:model-value="onField('setupScript', $event)"
          />
          </div>
        </SettingRow>
      </GroupCard>

      <!-- Section 2：bare-workspace -->
      <GroupCard>
        <template #head>
          <div class="gh">
            <h3 class="gh-title">{{ TEXT.groupBare }}</h3>
            <p class="gh-desc">{{ TEXT.groupBareDesc }}</p>
          </div>
        </template>
        <SettingRow :label="TEXT.bareSetupScript" :desc="TEXT.bareSetupScriptHint">
          <div class="ctl-wide">
          <UiInput
            :model-value="draft.bareSetupScript"
            :mono="true"
            :placeholder="TEXT.bareSetupScriptPlaceholder"
            data-testid="worktree-bare-script"
            @update:model-value="onField('bareSetupScript', $event)"
          />
          </div>
        </SettingRow>
        <SettingRow :label="TEXT.timeout" :desc="TEXT.timeoutHint">
          <div class="ctl-narrow">
          <UiInput
            type="number"
            :model-value="draft.timeout"
            :error="timeoutError"
            :placeholder="TEXT.timeoutPlaceholder"
            data-testid="worktree-timeout"
            @update:model-value="onField('timeout', $event)"
          />
          </div>
        </SettingRow>
      </GroupCard>

      <!-- Section 3：通用 -->
      <GroupCard>
        <template #head>
          <div class="gh">
            <h3 class="gh-title">{{ TEXT.groupGeneral }}</h3>
            <p class="gh-desc">{{ TEXT.groupGeneralDesc }}</p>
          </div>
        </template>
        <SettingRow :label="TEXT.defaultBaseBranch" :desc="TEXT.defaultBaseBranchHint">
          <div class="ctl-mid">
          <UiInput
            :model-value="draft.defaultBaseBranch"
            :mono="true"
            :placeholder="TEXT.defaultBaseBranchPlaceholder"
            data-testid="worktree-base-branch"
            @update:model-value="onField('defaultBaseBranch', $event)"
          />
          </div>
        </SettingRow>
      </GroupCard>

      <!-- save-bar：dirty 时出现，与 dirty 联动 -->
      <div v-if="dirty" class="save-bar" data-testid="worktree-save-bar">
        <span class="bar-dirty-badge"><span class="dot"></span>{{ TEXT.unsaved }}</span>
        <span v-if="saveError" class="sb-error">{{ saveError }}</span>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-md" :disabled="saving" data-testid="worktree-cancel-btn" @click="cancel">{{ TEXT.cancel }}</button>
        <button class="btn btn-default btn-md" :disabled="saving" data-testid="worktree-save-btn" @click="save">{{ saving ? TEXT.saving : TEXT.save }}</button>
      </div>
    </template>

    <!-- 浏览目录（mock dialog，各页自持） -->
    <div
      v-if="browseOpen"
      ref="browseEl"
      class="dialog-mask"
      role="dialog"
      aria-modal="true"
      aria-label="选择 worktree 根目录"
      @click.self="browseOpen = false"
      @keydown.esc="browseOpen = false"
    >
      <div class="confirm-dialog">
        <div class="confirm-title">{{ TEXT.browseTitle }}</div>
        <div class="confirm-desc">{{ TEXT.browseDesc }}</div>
        <div class="dir-list">
          <button v-for="c in CANDIDATE_DIRS" :key="c.path" class="dir-item" @click="pickDir(c)">
            <span class="dir-path">{{ c.path }}</span>
            <span class="dir-kind">{{ c.kind }}</span>
          </button>
        </div>
        <div class="confirm-foot">
          <button class="btn btn-ghost btn-md" data-testid="worktree-browse-cancel" @click="browseOpen = false">{{ TEXT.cancel }}</button>
        </div>
      </div>
    </div>

    <!-- 离开守卫确认（内联自建，§4.3） -->
    <div
      v-if="confirmState"
      ref="guardEl"
      class="dialog-mask"
      role="alertdialog"
      aria-modal="true"
      aria-label="放弃未保存的改动"
      @click.self="confirmContinue"
      @keydown.esc="confirmContinue"
    >
      <div class="confirm-dialog">
        <div class="confirm-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="confirm-title">{{ TEXT.leaveTitle }}</div>
        <div class="confirm-desc">{{ TEXT.leaveDesc }}</div>
        <div class="confirm-foot">
          <button class="btn btn-default btn-md" data-testid="worktree-guard-continue" @click="confirmContinue">{{ TEXT.continueEdit }}</button>
          <button class="btn btn-danger btn-md" data-testid="worktree-guard-discard" @click="confirmDiscard">{{ TEXT.discard }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; }
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

/* GroupCard head slot（title + desc） */
.gh { display: flex; flex-direction: column; gap: 2px; }
.gh-title { font-size: var(--text-base); font-weight: 600; color: var(--neutral-fg); }
.gh-desc { font-size: var(--text-xs); color: var(--neutral-mid); }

/* 输入容器宽度（对齐真实组件 280/200/120px；UiInput 100% 撑满容器） */
.ctl-wide { width: 280px; max-width: 100%; }
.ctl-mid { width: 200px; max-width: 100%; }
.ctl-narrow { width: 120px; max-width: 100%; }

/* 保存成功反馈 */
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

/* 加载骨架（shimmer 全局 keyframes） */
.skel-wrap { display: flex; flex-direction: column; gap: var(--space-4); }
.skel-card {
  background: var(--bg-card);
  border-radius: 10px;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.skel {
  background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-hover) 50%, var(--surface-2) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
  border-radius: var(--radius-sm);
}
.skel-head { width: 120px; height: 14px; }
.skel-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); }
.skel-label { width: 160px; height: 12px; }
.skel-input { width: 240px; height: 32px; border-radius: var(--radius); }

/* save-bar（sticky 于 .fs-content 滚动容器） */
.save-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  position: sticky;
  bottom: 0;
  background: var(--surface);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  margin-top: var(--space-6);
  padding: var(--space-3) var(--space-4);
}
.bar-dirty-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--warn);
  font-weight: 600;
}
.bar-dirty-badge .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--warn); }
.sb-error { font-size: var(--text-sm); color: var(--danger); }
.spacer { flex: 1; }

/* 内联 dialog（fixed mask + 居中卡片，§4.3 各页自持） */
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: 24px;
}
.confirm-dialog {
  width: 100%;
  max-width: 420px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.confirm-icon {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
}
.confirm-icon svg { width: 20px; height: 20px; }
.confirm-title { font-size: var(--text-md); font-weight: 600; color: var(--neutral-fg); }
.confirm-desc { font-size: var(--text-sm); color: var(--neutral-mid); line-height: 1.6; }
.confirm-foot { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); }
.dir-list { display: flex; flex-direction: column; gap: var(--space-1); margin-top: var(--space-2); }
.dir-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  text-align: left;
  transition: background var(--duration-fast) var(--ease);
}
.dir-item:hover { background: var(--surface-hover); }
.dir-item:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
.dir-path { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--neutral-fg); }
.dir-kind { font-size: var(--text-2xs); color: var(--neutral-mid); flex-shrink: 0; }
</style>
