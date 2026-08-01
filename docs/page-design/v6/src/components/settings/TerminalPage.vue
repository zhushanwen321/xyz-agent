<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import GroupCard from './GroupCard.vue'
import SettingRow from './SettingRow.vue'
import UiInput from './UiInput.vue'
import UiSwitch from './UiSwitch.vue'
import { settingsOpen, settingsPage, closeSettings, type SettingsPage } from '@/composables/useStore'
import {
  DEFAULT_TERMINAL_CONFIG,
  fetchTerminalConfig,
  saveTerminalConfig,
  type TerminalConfig,
} from '@/mock/terminal'

/** TerminalPage：终端配置（Shell / 外观 / 终端行为 三组，单表单整体保存）。
 * 数据层对齐真实组件 config.getTerminalConfig / setTerminalConfig：shellArgs 逗号分隔编辑、
 * 存储为 string[]；保存为显式按钮触发（非自动保存）。交互状态机：dirty 快照 diff +
 * sticky save-bar + 离开守卫（设计上下文 §4.3）。*/

// === 数据状态 ===
const loading = ref(true) // 初始加载（skeleton 显式呈现，§4.4）
const corrupted = ref(false) // 磁盘配置损坏提示条（真实由 getTerminalConfig.corrupted 驱动）
const saving = ref(false) // 保存中（Save disabled + spinner）
const saveError = ref('') // 保存失败行内错误条（save-bar 内）
const savedFlash = ref(false) // 保存成功「已保存」反馈（1.5s）

// 编辑态（UiInput 均以字符串承载，buildConfig 时转 number）
const shell = ref('')
const shellArgsInput = ref('')
const fontSize = ref('14')
const fontFamily = ref('')
const scrollback = ref('1000')
const cursorStyle = ref<TerminalConfig['cursorStyle']>('block')
const bell = ref(false)

/** 已保存快照（初始 = mock 初值；保存成功后刷新）。dirty = 快照 diff，净零翻转自动回 clean。 */
const snapshot = ref<TerminalConfig>({ ...DEFAULT_TERMINAL_CONFIG })

/** 从编辑态组装 TerminalConfig（shellArgs 逗号分隔串 → string[]，对齐真实组件 buildConfig） */
function buildConfig(): TerminalConfig {
  return {
    version: 1,
    shell: shell.value,
    shellArgs: shellArgsInput.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    fontSize: Number(fontSize.value),
    fontFamily: fontFamily.value,
    scrollback: Number(scrollback.value),
    cursorStyle: cursorStyle.value,
    bell: bell.value,
  }
}

/** dirty：按组装后的 config 与快照逐字段 diff（空串→空白输入等净零翻转自动回 clean） */
const dirty = computed(() => {
  const c = buildConfig()
  return (
    c.shell !== snapshot.value.shell ||
    c.shellArgs.join('\u0000') !== snapshot.value.shellArgs.join('\u0000') ||
    c.fontSize !== snapshot.value.fontSize ||
    c.fontFamily !== snapshot.value.fontFamily ||
    c.scrollback !== snapshot.value.scrollback ||
    c.cursorStyle !== snapshot.value.cursorStyle ||
    c.bell !== snapshot.value.bell
  )
})

/** save-bar 可见性：dirty / 保存中 / 已保存反馈 / 错误条任一存在即显示 */
const barVisible = computed(() => dirty.value || saving.value || savedFlash.value || !!saveError.value)

/** 客户端输入完整性校验（空/非数字 → 行内错误）；范围越界走服务端 mock 校验分支（真实组件无客户端范围校验） */
function validate(): string {
  if (fontSize.value.trim() === '' || Number.isNaN(Number(fontSize.value))) return '请输入有效的字号'
  if (scrollback.value.trim() === '' || Number.isNaN(Number(scrollback.value))) return '请输入有效的回滚行数'
  return ''
}

/** 编辑任一字段即清除行内错误（错误只在保存流中复现） */
watch([shell, shellArgsInput, fontSize, fontFamily, scrollback, cursorStyle, bell], () => {
  saveError.value = ''
})

// === 加载 / 保存 / 放弃 ===
async function load() {
  loading.value = true
  try {
    const res = await fetchTerminalConfig()
    corrupted.value = res.corrupted
    shell.value = res.config.shell
    shellArgsInput.value = res.config.shellArgs.join(',')
    fontSize.value = String(res.config.fontSize)
    fontFamily.value = res.config.fontFamily
    scrollback.value = String(res.config.scrollback)
    cursorStyle.value = res.config.cursorStyle
    bell.value = res.config.bell
    snapshot.value = { ...res.config }
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : '加载配置失败'
  } finally {
    loading.value = false
  }
}

let flashTimer: ReturnType<typeof setTimeout> | undefined

/** 整体保存（mock 500ms saving → 成功刷新快照 + 「已保存」1.5s 反馈；失败进 save-bar 错误条） */
async function save() {
  if (!dirty.value || saving.value) return
  const msg = validate()
  if (msg) {
    saveError.value = msg
    return
  }
  saveError.value = ''
  saving.value = true
  savedFlash.value = false
  try {
    const cfg = await saveTerminalConfig(buildConfig())
    snapshot.value = { ...cfg }
    savedFlash.value = true
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      savedFlash.value = false
    }, 1500)
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}

/** 放弃：还原快照（编辑态回已保存值），dirty 自动归零 */
function discard() {
  shell.value = snapshot.value.shell
  shellArgsInput.value = snapshot.value.shellArgs.join(',')
  fontSize.value = String(snapshot.value.fontSize)
  fontFamily.value = snapshot.value.fontFamily
  scrollback.value = String(snapshot.value.scrollback)
  cursorStyle.value = snapshot.value.cursorStyle
  bell.value = snapshot.value.bell
  saveError.value = ''
  savedFlash.value = false
}

// === 离开守卫（§4.3：nav 切页 / 关闭拦截 + beforeunload；放弃 = 先还原快照再导航，防 sync watch 重入）===
const guardOpen = ref(false)
const pendingLeave = ref<SettingsPage | 'close' | null>(null)
watch(
  () => [settingsPage.value, settingsOpen.value] as const,
  ([page, open]) => {
    if (open && page === 'terminal') return
    if (!dirty.value) return
    pendingLeave.value = page !== 'terminal' ? page : 'close'
    settingsPage.value = 'terminal'
    settingsOpen.value = true
    guardOpen.value = true
  },
  // flush: 'sync' —— 在 closeSettings/nav select 的同步调用栈内立即拦截，父组件卸载不发生
  { flush: 'sync' },
)
function confirmDiscard() {
  if (!guardOpen.value) return
  guardOpen.value = false
  discard() // 先还原快照 → dirty 归零 → sync watch 重入时守卫放行导航
  if (pendingLeave.value === 'close') closeSettings()
  else if (pendingLeave.value) settingsPage.value = pendingLeave.value
}
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}

/** 确认弹窗焦点初始落在「继续编辑」（default · 安全选择） */
const guardContinueRef = ref<HTMLElement | null>(null)
watch(guardOpen, (v) => {
  if (v) nextTick(() => guardContinueRef.value?.focus())
})

onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload)
  void load()
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  clearTimeout(flashTimer)
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">终端配置</h1>
        <p class="desc">Shell、字体与终端偏好。修改仅对新启动的终端会话生效，已启动的终端不动态切换。</p>
      </div>
    </header>

    <!-- corrupted 提示条（真实：getTerminalConfig.corrupted=true，已回退默认配置） -->
    <div v-if="corrupted" class="corrupted">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <span>终端配置文件已损坏，已回退默认配置</span>
    </div>

    <!-- 初始加载 skeleton（§4.4：显式 skeleton，@keyframes shimmer 全局可用） -->
    <template v-if="loading">
      <div v-for="i in 3" :key="i" class="skeleton-card">
        <div class="sk-head shimmer"></div>
        <div class="sk-row shimmer"></div>
        <div class="sk-row shimmer"></div>
      </div>
    </template>

    <template v-else>
      <!-- Shell 组 -->
      <GroupCard title="Shell">
        <SettingRow label="默认 Shell" desc="终端启动时使用的 shell 命令，留空使用 $SHELL 默认。">
          <UiInput v-model="shell" mono placeholder="留空使用 $SHELL 默认" aria-label="默认 Shell" />
        </SettingRow>
        <SettingRow label="Shell 参数" desc="传递给 shell 的启动参数，逗号分隔（如 -l,-i）。">
          <UiInput v-model="shellArgsInput" mono placeholder="逗号分隔，如 -l,-i" aria-label="Shell 参数" />
        </SettingRow>
      </GroupCard>

      <!-- 外观组 -->
      <GroupCard title="外观">
        <SettingRow label="字号" desc="终端字体大小，范围 6-72。">
          <UiInput v-model="fontSize" type="number" class="num-input" aria-label="字号" />
        </SettingRow>
        <SettingRow label="字体" desc="终端字体族，留空使用默认（如 Menlo, monospace）。">
          <UiInput v-model="fontFamily" mono placeholder="留空使用默认字体，如 Menlo, monospace" aria-label="字体" />
        </SettingRow>
        <SettingRow label="光标样式" desc="终端光标的显示形态：方块 / 下划线 / 竖线。">
          <div class="sel-wrap">
            <select v-model="cursorStyle" class="sel" aria-label="光标样式">
              <option value="block">方块</option>
              <option value="underline">下划线</option>
              <option value="bar">竖线</option>
            </select>
            <svg class="sel-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
        </SettingRow>
      </GroupCard>

      <!-- 终端行为组 -->
      <GroupCard title="终端行为">
        <SettingRow label="回滚行数上限" desc="终端回滚缓冲区保留的最大行数，范围 0-100000。">
          <UiInput v-model="scrollback" type="number" class="num-input num-input--wide" aria-label="回滚行数上限" />
        </SettingRow>
        <SettingRow label="响铃" desc="收到响铃控制序列（BEL）时发出提示音。">
          <UiSwitch v-model:checked="bell" aria-label="响铃" />
        </SettingRow>
      </GroupCard>

      <!-- save-bar（§4.3：dirty 联动 · saving 禁用 · 成功「已保存」反馈 · 失败行内错误条） -->
      <div v-if="barVisible" class="save-bar" data-testid="terminal-save-bar">
        <span v-if="savedFlash" class="bar-saved">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          已保存
        </span>
        <span v-else class="bar-dirty-badge"><span class="dot"></span>未保存</span>
        <span v-if="saveError" class="sb-error" data-testid="terminal-save-error">{{ saveError }}</span>
        <span class="spacer"></span>
        <template v-if="!savedFlash">
          <button class="btn btn-ghost btn-dense" :disabled="saving" @click="discard">放弃</button>
          <button class="btn btn-default btn-dense" :disabled="saving" @click="save" data-testid="terminal-save">
            <svg v-if="saving" class="btn-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </template>
      </div>
    </template>

    <!-- 离开确认弹窗（§4.3 C2：nav 切页 / 关闭设置拦截 · 内联自建） -->
    <div v-if="guardOpen" class="guard-mask" role="alertdialog" aria-modal="true" aria-labelledby="term-guard-title" @click.self="guardOpen = false" @keydown.esc="guardOpen = false">
      <div class="guard-dialog">
        <div class="guard-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="guard-title" id="term-guard-title">放弃未保存的改动？</div>
        <div class="guard-desc">终端配置有未保存的修改，离开后会丢失。可以先保存再离开，或直接放弃。</div>
        <div class="guard-actions">
          <button ref="guardContinueRef" class="btn btn-default btn-dense" @click="guardOpen = false">继续编辑</button>
          <button class="btn btn-danger btn-dense" @click="confirmDiscard">放弃改动</button>
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

/* corrupted 提示条（warn 语义：warn-soft 底 + warn 字，对齐 ProviderPage inline-error 范式） */
.corrupted {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--text-sm);
  margin-bottom: var(--space-3);
}
.corrupted svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

/* 加载 skeleton（§4.4：bg-card 卡片 + shimmer 扫光） */
.skeleton-card {
  background: var(--bg-card);
  border-radius: 10px;
  padding: 10px;
  overflow: hidden;
}
.skeleton-card + .skeleton-card {
  margin-top: var(--space-4);
}
.sk-head {
  height: 20px;
  width: 40%;
  margin: 6px 16px 12px;
  border-radius: var(--radius-sm);
}
.sk-row {
  height: 48px;
  margin: 0 6px 6px;
  border-radius: var(--radius-sm);
}
.shimmer {
  background: linear-gradient(90deg, var(--surface) 25%, var(--surface-hover) 50%, var(--surface) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s ease infinite;
}

/* 数字输入宽度（对齐真实组件 w-[120px] / w-[160px]，控件宽度非间距 token） */
.num-input {
  width: 120px;
}
.num-input--wide {
  width: 160px;
}

/* 光标样式下拉（对齐 ProviderPage .type-select 范式：surface-2 + border + appearance none） */
.sel-wrap {
  position: relative;
  width: 160px;
}
.sel {
  width: 100%;
  height: 40px;
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 0 28px 0 12px;
  font-size: var(--text-base);
  color: var(--neutral-fg);
  outline: none;
  cursor: pointer;
  appearance: none;
  transition: box-shadow var(--duration-fast) var(--ease);
}
.sel:focus-visible {
  border-color: transparent;
  box-shadow: 0 0 0 1px var(--accent-ring) inset;
}
.sel-chev {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  color: var(--neutral-mid);
  pointer-events: none;
}

/* save-bar（sticky 底部 · bg-surface · 顶部 hairline，对齐 ProviderPage .save-bar 范式） */
.save-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  position: sticky;
  bottom: 0;
  background: var(--surface);
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-radius: 0 0 10px 10px;
}
.bar-dirty-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--warn);
  font-weight: 600;
}
.bar-dirty-badge .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.bar-saved {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  color: var(--success);
  font-weight: 600;
}
.bar-saved svg {
  width: 14px;
  height: 14px;
}
.sb-error {
  font-size: var(--text-sm);
  color: var(--danger);
}
.spacer {
  flex: 1;
}
.btn-spin {
  width: 13px;
  height: 13px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

/* 离开确认弹窗（§4.3 C2：mask + bg-card dialog + warn icon + 继续编辑/放弃改动） */
.guard-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: 24px;
}
.guard-dialog {
  width: 360px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.guard-icon {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--radius);
  background: var(--warn-soft);
  color: var(--warn);
}
.guard-icon svg {
  width: 16px;
  height: 16px;
}
.guard-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--neutral-fg);
}
.guard-desc {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  line-height: 1.6;
}
.guard-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
