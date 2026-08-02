<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import UiInput from './UiInput.vue'
import {
  projectPaths as projectPathsData,
  globalPaths as globalPathsData,
  rpItems as rpItemsData,
  IMPORT_SOURCES,
  type LoadPath,
  type RpItem,
  type RpSource,
  type ImportSource,
} from '@/mock/agent'

/** AgentPage：加载路径管理（Layer A）+ 资源预览（Layer B）——与 ResourcesPage（skill 版）同构，kind=agent。
 * Layer A（spec §1）：单一 lp-card 内按作用域分两组——项目目录（projectPaths，含系统锁定目录）+
 * 全局目录（globalPaths），各组独立管理（↑↓ 组内排序 + 移除）+ 独立添加行（spec §3 校验链：
 * 非空 → 绝对路径格式 → 去重，错误 inline 提示）。
 * 系统锁定目录（~/.xyz-agent/agents）checked + disabled + lock，无 ↑↓ 不可排序（spec §8 状态矩阵）。
 * Layer B（spec §6/§7/§8）：来源 badge 状态链 6 种（pi=accent / claude=warn / agents=success /
 * piinstall=info / effective=accent+ring / muted 兜底；多来源链首项 effective + 余项 faded，
 * piinstall 归一化到 pi tab），刷新按钮（secondary dense + spin + 1.5s 骨架），空态三要素
 * （图标 28px neutral-faint + 说明 + Primary 刷新），区分「全空」与「筛选空」。
 * M5（spec §4）：SourceImport 导入流五步——① 检测（spinner）→ ② 选择（Checkbox 多选，
 * 共享池行禁选 + info 胶囊 / 空目录行禁选）→ ③ 确认弹窗（显式 source/target/dedup bullet，
 * ESC/backdrop 取消）→ ④ 进度（spinner + 文案 + 进度条）→ ⑤ 成功（success 反馈，
 * 路径 append 到项目目录组）；检测失败 danger soft 错误条 + 重试。*/
const projectPaths = ref<LoadPath[]>(JSON.parse(JSON.stringify(projectPathsData)))
const globalPaths = ref<LoadPath[]>(JSON.parse(JSON.stringify(globalPathsData)))
const manualProjectPath = ref('')
const manualGlobalPath = ref('')
/** M4 添加路径校验（spec §3：非空 → 格式 → 去重；空则不操作不报错） */
const projectPathError = ref('')
const globalPathError = ref('')
const PATH_RE = /^(\/|~\/|[A-Za-z]:\\)/

function addPath(list: LoadPath[], input: { value: string }, err: { value: string }) {
  const v = input.value.trim()
  if (!v) {
    err.value = ''
    return
  }
  if (!PATH_RE.test(v)) {
    err.value = '路径格式不合法：需为绝对路径（如 /Users/... 或 ~/...）'
    return
  }
  const all = [...projectPaths.value, ...globalPaths.value]
  if (all.some((p) => p.path === v)) {
    err.value = `路径已存在：${v} 已在列表中`
    return
  }
  list.push({ id: 'lp-' + Date.now(), path: v, enabled: true })
  input.value = ''
  err.value = ''
}
/** 模板中 ref 自动解包，包装为脚本侧 handler 以便传 Ref 本体 */
function addProjectPath() {
  addPath(projectPaths.value, manualProjectPath, projectPathError)
}
function addGlobalPath() {
  addPath(globalPaths.value, manualGlobalPath, globalPathError)
}

/** 移除路径（spec §1：非锁定行可移除） */
function removePath(list: LoadPath[], i: number) {
  list.splice(i, 1)
}

function moveUp(list: LoadPath[], i: number) {
  if (i <= 0) return
  ;[list[i - 1], list[i]] = [list[i], list[i - 1]]
}
function moveDown(list: LoadPath[], i: number) {
  if (i >= list.length - 1) return
  ;[list[i + 1], list[i]] = [list[i], list[i + 1]]
}

/** 选择目录（spec §3：dialog mock 返回固定路径 → 直接 push 到组末尾 + 「已添加」反馈；demo 不调真实 IPC） */
const dirPickedGroup = ref<'' | 'project' | 'global'>('')
let dirPickTimer: ReturnType<typeof setTimeout> | undefined
function chooseDir(list: LoadPath[], group: 'project' | 'global') {
  const dir = '~/projects/selected-dir'
  const all = [...projectPaths.value, ...globalPaths.value]
  if (!all.some((p) => p.path === dir)) {
    list.push({ id: 'lp-' + Date.now(), path: dir, enabled: true })
  }
  dirPickedGroup.value = group
  clearTimeout(dirPickTimer)
  dirPickTimer = setTimeout(() => {
    dirPickedGroup.value = ''
  }, 1200)
}

/** M8：来源 badge 状态链（spec §6/§8：6 种 badge，R17 中性底 + 彩色小点） */
type RpTab = 'all' | 'pi' | 'claude' | 'agents'
const sourceTab = ref<RpTab>('all')
const SOURCE_LABEL: Record<RpSource, string> = {
  pi: '太极',
  claude: 'Claude',
  agents: 'Agents',
  piinstall: 'pi-install',
  muted: '未知',
}
const TAB_LABEL: Record<RpTab, string> = {
  all: '全部',
  pi: '太极',
  claude: 'Claude',
  agents: 'Agents',
}
/** mock 覆盖 6 种 badge 状态（spec §8）：pi / claude / agents / piinstall / effective（多来源链）/ muted */
const rpItems = ref<RpItem[]>(JSON.parse(JSON.stringify(rpItemsData)))
/** badge 链：首项 effective（accent + inset ring），余项 faded（opacity .6），单项为普通 badge */
function badgeClass(item: RpItem, s: RpSource, i: number) {
  if (i === 0 && item.sources.length > 1) return 'effective'
  return s + (i > 0 ? ' faded' : '')
}
function badgeText(item: RpItem, s: RpSource, i: number) {
  return i === 0 && item.sources.length > 1 ? `生效·${SOURCE_LABEL[s]}` : SOURCE_LABEL[s]
}
/** tab 过滤：piinstall 归一化到 pi tab（spec §6）· muted 仅「全部」可见 */
const filteredRp = computed(() => {
  if (sourceTab.value === 'all') return rpItems.value
  if (sourceTab.value === 'pi') {
    return rpItems.value.filter((r) => r.sources.includes('pi') || r.sources.includes('piinstall'))
  }
  return rpItems.value.filter((r) => r.sources.includes(sourceTab.value as RpSource))
})

/** M10：刷新（demo：1.5s 骨架后恢复；failNextScan 置位 → 900ms 后错误条，重试成功） */
const scanning = ref(false)
const scanError = ref('')
let scanTimer: ReturnType<typeof setTimeout> | undefined
let failNextScan = false
function refresh() {
  if (scanning.value) return
  scanning.value = true
  scanError.value = ''
  clearTimeout(scanTimer)
  scanTimer = setTimeout(() => {
    scanning.value = false
    if (failNextScan) {
      failNextScan = false
      scanError.value = '扫描失败：无法访问加载路径，请检查目录或稍后重试'
    }
  }, failNextScan ? 900 : 1500)
}
/** 重试 = 重新扫描（failNextScan 已被失败分支消费，重试必然成功） */
function retryScan() {
  if (scanning.value) return
  refresh()
}
/** demo 状态机触发：置位后下一次刷新失败（spec §7 错误态；正式版无此入口） */
function simulateScanFail() {
  failNextScan = true
  refresh()
}

/* ══════════ M5：SourceImport 导入流（spec §4：检测 → 选择 → 确认弹窗 → 进度 → 成功/失败） ══════════ */
type ImportStep = 'detecting' | 'select' | 'confirm' | 'importing' | 'done' | 'failed'

const importOpen = ref(false)
const importStep = ref<ImportStep>('detecting')
const importSources = ref<ImportSource[]>([])
const selectedSources = ref(new Set<string>())
const importError = ref('')
const importDonePaths = ref<string[]>([])
/** demo 触发器：置位后下一次检测失败（spec §4 错误态，正常使用不触发） */
let failNextDetect = false
let importTimer: ReturnType<typeof setTimeout> | undefined

/** 共享池判定（spec §4）：候选 dir 与现有加载路径 normalize 相等 → 已生效禁选 + info 胶囊；
 * 不依赖静态标记（~/.pi/agents 曾静态标 shared 但不在现有路径 → 判定失真） */
function normalizePath(p: string) {
  return p.replace(/\/+$/, '')
}
function isSharedSource(s: ImportSource) {
  const dir = normalizePath(s.dir)
  return [...projectPaths.value, ...globalPaths.value].some((p) => normalizePath(p.path) === dir)
}
const importableCount = computed(() => importSources.value.filter((s) => !isSharedSource(s) && !s.empty).length)
const selectedCount = computed(() => selectedSources.value.size)
const selectedDirs = computed(() =>
  importSources.value.filter((s) => selectedSources.value.has(s.id)).map((s) => s.dir),
)

function detectSources() {
  importStep.value = 'detecting'
  importError.value = ''
  clearTimeout(importTimer)
  importTimer = setTimeout(() => {
    if (failNextDetect) {
      failNextDetect = false
      importError.value = '检测本机 Agent 失败，请稍后重试或手动添加路径'
      importStep.value = 'failed'
    } else {
      importSources.value = IMPORT_SOURCES
      importStep.value = 'select'
    }
  }, 800)
}
function openImport() {
  importOpen.value = true
  selectedSources.value = new Set()
  importDonePaths.value = []
  detectSources()
}
function closeImport() {
  importOpen.value = false
  importStep.value = 'detecting'
  clearTimeout(importTimer)
}
function toggleSource(id: string) {
  const s = importSources.value.find((x) => x.id === id)
  if (!s || isSharedSource(s) || s.empty) return
  const next = new Set(selectedSources.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedSources.value = next
}
/** ② → ③：打开确认弹窗（spec §4：显式 source/target/dedup bullet） */
function openConfirm() {
  importStep.value = 'confirm'
}
function cancelConfirm() {
  importStep.value = 'select'
}
/** ③ → ④ → ⑤：确认后 append 到 projectPaths（去重），mock 1.2s 进度 */
function confirmImport() {
  const dirs = selectedDirs.value
  importStep.value = 'importing'
  clearTimeout(importTimer)
  importTimer = setTimeout(() => {
    const all = [...projectPaths.value, ...globalPaths.value]
    for (const [i, dir] of dirs.entries()) {
      if (!all.some((p) => p.path === dir)) {
        projectPaths.value.push({ id: 'lp-imp-' + Date.now() + '-' + i, path: dir, enabled: true })
      }
    }
    importDonePaths.value = dirs
    importStep.value = 'done'
  }, 1200)
}
/** demo 状态机触发：模拟检测失败（spec §4 错误态） */
function simulateDetectFail() {
  failNextDetect = true
  detectSources()
}
/** ESC 关确认弹窗（spec §4：弹窗开时 ESC 取消导入，非关 settings） */
watch(importStep, (step) => {
  if (step === 'confirm') window.addEventListener('keydown', onEsc)
  else window.removeEventListener('keydown', onEsc)
})
function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && importStep.value === 'confirm') cancelConfirm()
}
/** 引用到 composer（spec §5）：demo mock —— 点击后短暂显示「已引用」note */
const quotedName = ref('')
let quoteTimer: ReturnType<typeof setTimeout> | undefined
function quoteToComposer(name: string) {
  quotedName.value = name
  clearTimeout(quoteTimer)
  quoteTimer = setTimeout(() => {
    quotedName.value = ''
  }, 1500)
}
onBeforeUnmount(() => {
  clearTimeout(importTimer)
  clearTimeout(dirPickTimer)
  clearTimeout(quoteTimer)
  clearTimeout(scanTimer)
  window.removeEventListener('keydown', onEsc)
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1 class="title">代理</h1>
      <p class="desc">管理 pi agent 启动时可加载的代理。项目目录仅当前项目生效，全局目录所有项目共享。</p>
    </header>

    <section class="lp-card">
      <div class="lp-head">
        <span class="lp-title">加载路径</span>
        <span class="lp-hint">靠前 = 高优先级 · 项目目录 &gt; 全局目录</span>
      </div>

      <!-- ===== 项目目录组（含系统锁定目录） ===== -->
      <div class="lp-group-head">
        <span class="lp-group-name">项目目录</span>
        <span class="lp-group-scope project">仅当前项目</span>
        <span class="lp-group-hint">projectPaths</span>
      </div>

      <div v-for="(lp, i) in projectPaths" :key="lp.id" class="lp-row">
        <input
          type="checkbox"
          class="lp-check"
          :class="{ locked: lp.locked }"
          v-model="lp.enabled"
          :disabled="lp.locked"
          :aria-label="'启用 ' + lp.path"
        />
        <svg v-if="lp.locked" class="lp-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span class="lp-path" :class="{ forced: lp.locked }">{{ lp.path }}</span>
        <span v-if="lp.locked" class="lp-tag forced">系统</span>
        <span class="spacer"></span>
        <div v-if="!lp.locked" class="lp-actions">
          <button class="btn btn-ghost btn-icon move-btn" title="上移" aria-label="上移" :disabled="i === 0" @click="moveUp(projectPaths, i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon move-btn" title="下移" aria-label="下移" :disabled="i === projectPaths.length - 1" @click="moveDown(projectPaths, i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button class="btn btn-danger btn-icon rm-btn" title="移除" aria-label="移除" @click="removePath(projectPaths, i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>

      <!-- 项目目录：添加行（spec §3 双方式：手动填写校验 + 选择目录；顺序 Input → 选择目录 → 添加） -->
      <div class="lp-add-row">
        <UiInput
          v-model="manualProjectPath"
          placeholder="/absolute/path/to/project-dir"
          :mono="true"
          class="manual-input"
          :error="!!projectPathError"
          @keydown.enter="addProjectPath"
        />
        <button class="btn btn-secondary btn-dense dir-btn" aria-label="选择目录" title="选择目录" @click="chooseDir(projectPaths, 'project')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          {{ dirPickedGroup === 'project' ? '已添加' : '选择目录' }}
        </button>
        <button class="btn btn-default btn-dense" @click="addProjectPath">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          添加
        </button>
      </div>
      <div v-if="projectPathError" class="lp-add-error">
        <svg class="lp-add-error__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>{{ projectPathError }}</span>
      </div>

      <!-- ===== 全局目录组 ===== -->
      <div class="lp-group-head">
        <span class="lp-group-name">全局目录</span>
        <span class="lp-group-scope global">所有项目共享</span>
        <span class="lp-group-hint">globalPaths</span>
      </div>

      <div v-for="(lp, i) in globalPaths" :key="lp.id" class="lp-row">
        <input type="checkbox" class="lp-check" v-model="lp.enabled" :aria-label="'启用 ' + lp.path" />
        <span class="lp-path">{{ lp.path }}</span>
        <span class="spacer"></span>
        <div class="lp-actions">
          <button class="btn btn-ghost btn-icon move-btn" title="上移" aria-label="上移" :disabled="i === 0" @click="moveUp(globalPaths, i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon move-btn" title="下移" aria-label="下移" :disabled="i === globalPaths.length - 1" @click="moveDown(globalPaths, i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button class="btn btn-danger btn-icon rm-btn" title="移除" aria-label="移除" @click="removePath(globalPaths, i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>

      <!-- 全局目录：添加行（spec §3 双方式，顺序 Input → 选择目录 → 添加） -->
      <div class="lp-add-row">
        <UiInput
          v-model="manualGlobalPath"
          placeholder="/absolute/path/to/global-dir"
          :mono="true"
          class="manual-input"
          :error="!!globalPathError"
          @keydown.enter="addGlobalPath"
        />
        <button class="btn btn-secondary btn-dense dir-btn" aria-label="选择目录" title="选择目录" @click="chooseDir(globalPaths, 'global')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          {{ dirPickedGroup === 'global' ? '已添加' : '选择目录' }}
        </button>
        <button class="btn btn-default btn-dense" @click="addGlobalPath">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          添加
        </button>
      </div>
      <div v-if="globalPathError" class="lp-add-error">
        <svg class="lp-add-error__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>{{ globalPathError }}</span>
      </div>

      <!-- M5：SourceImport 入口（spec §1 底部 + §4 五步流） -->
      <div class="lp-section-label">从其他 Agent 导入</div>
      <div class="lp-import-actions">
        <button v-if="!importOpen" class="btn btn-secondary btn-dense" @click="openImport">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
          从其他 Agent 导入目录
        </button>
        <button v-else class="btn btn-secondary btn-dense" :disabled="importStep === 'importing'" @click="closeImport">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="7" x2="7" y2="17"/><polyline points="8 7 17 7 17 16"/></svg>
          收起导入
        </button>
        <span v-if="!importOpen" class="lp-import-hint">导入的是其他 Agent 的目录配置，写入当前 太极</span>
      </div>

      <!-- 导入面板：① 检测中 / 检测失败 / ② 选择 / ④ 导入中 / ⑤ 成功 -->
      <div v-if="importOpen" class="imp-panel">
        <!-- ① 检测中 -->
        <div v-if="importStep === 'detecting'" class="lp-row imp-row">
          <svg class="imp-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          <span class="imp-text">正在检测已安装的 Agent...</span>
        </div>

        <!-- 检测失败（spec §4：danger soft 条 + 原因 + 下一步 重试） -->
        <div v-else-if="importStep === 'failed'" class="rp-err">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
          <span>{{ importError }}</span>
          <button class="btn btn-secondary btn-dense imp-retry" @click="detectSources">重试</button>
        </div>

        <!-- ② 选择：Checkbox 多选；共享池/空目录行禁选 -->
        <template v-else-if="importStep === 'select'">
          <div v-for="s in importSources" :key="s.id" class="lp-row">
            <input
              type="checkbox"
              class="lp-check"
              :checked="selectedSources.has(s.id)"
              :disabled="isSharedSource(s) || s.empty"
              :aria-label="'导入 ' + s.name"
              @change="toggleSource(s.id)"
            />
            <span class="lp-src-label" :class="{ dim: isSharedSource(s) || s.empty }">{{ s.name }}</span>
            <span class="lp-src-path" :class="{ dim: isSharedSource(s) || s.empty }">{{ s.dir }}</span>
            <span class="lp-count">{{ s.count }} agents</span>
            <span v-if="isSharedSource(s)" class="lp-tag shared">共享池已生效</span>
            <span v-else-if="s.empty" class="lp-tag">无资源</span>
          </div>
          <div class="lp-import-actions">
            <button class="btn btn-secondary btn-dense" :disabled="selectedCount === 0" @click="openConfirm">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
              导入选中
            </button>
            <span class="lp-import-hint">已选 {{ selectedCount }} / {{ importableCount }} 可导入 · 将写入 太极</span>
            <span class="spacer"></span>
            <!-- demo 状态机触发：模拟检测失败（spec §4 错误态；正式版无此按钮） -->
            <button class="btn btn-ghost btn-icon-sm" title="模拟检测失败（demo）" aria-label="模拟检测失败" @click="simulateDetectFail">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>
            </button>
          </div>
        </template>

        <!-- ④ 导入中：spinner + 文案 + 进度条 -->
        <div v-else-if="importStep === 'importing'" class="imp-progress">
          <svg class="imp-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          <span>正在追加 {{ selectedDirs.join('、') }} 到 太极 的 projectPaths...</span>
          <div class="imp-progress-bar"><div class="imp-progress-fill"></div></div>
        </div>

        <!-- ⑤ 成功：success 反馈 + 行已出现在项目目录组 -->
        <div v-else-if="importStep === 'done'" class="imp-done">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          <span>已导入 {{ importDonePaths.length }} 个目录到 太极：{{ importDonePaths.join('、') }}（已在「项目目录」组，可 ↑↓ 调整优先级）</span>
        </div>
      </div>
    </section>

    <!-- ③ 确认弹窗（spec §4：浮起 dialog，显式 source/target/dedup；ESC/backdrop 取消） -->
    <div v-if="importStep === 'confirm'" class="imp-confirm-stage" @click.self="cancelConfirm">
      <div class="imp-confirm" role="dialog" aria-modal="true" aria-label="导入目录到 太极？">
        <div class="imp-confirm-head">
          <svg class="imp-confirm-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
          <div class="imp-confirm-title">导入目录到 太极？</div>
        </div>
        <p class="imp-confirm-desc">将把<b>其他 Agent 的目录配置</b>导入为<b>当前 太极</b>的加载路径（不会导出到其他 Agent，也不会修改其他 Agent 的配置）。</p>
        <ul class="imp-confirm-bullets">
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span><b>来源：</b>其他 Agent 的 agent 目录配置（<code>{{ selectedDirs.join('、') }}</code>）</span></li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span><b>去向：</b>写入当前 太极 的 <code>projectPaths</code>（项目目录组）</span></li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span><b>去重：</b>已存在的路径会自动跳过</span></li>
        </ul>
        <div class="imp-confirm-actions">
          <button class="btn btn-ghost btn-dense" @click="cancelConfirm">取消</button>
          <button class="btn btn-default btn-dense" @click="confirmImport">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            确认导入
          </button>
        </div>
      </div>
    </div>

    <!-- Layer B：已发现的 Agent（spec §5 资源预览） -->
    <section class="rp-card">
      <div class="rp-toolbar">
        <span class="rp-title">已发现的 Agent</span>
        <span class="rp-count-pill">{{ filteredRp.length }}</span>
        <!-- M10：刷新按钮（secondary dense + RefreshCw · scanning 时 spin + 「刷新中」+ disabled） -->
        <button class="btn btn-secondary btn-dense rp-refresh" :disabled="scanning" @click="refresh">
          <svg class="rp-refresh-icon" :class="{ spin: scanning }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          {{ scanning ? '刷新中' : '刷新' }}
        </button>
        <!-- demo 状态机触发：模拟扫描失败（spec §7 错误态；正式版无此按钮） -->
        <button class="btn btn-ghost btn-icon-sm" title="模拟扫描失败（demo）" aria-label="模拟扫描失败" :disabled="scanning" @click="simulateScanFail">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>
        </button>
        <span class="spacer"></span>
        <div class="rp-tabs">
          <button
            v-for="(label, key) in TAB_LABEL"
            :key="key"
            class="rp-tab"
            :class="{ active: sourceTab === key }"
            @click="sourceTab = key as RpTab"
          >{{ label }}</button>
        </div>
      </div>

      <!-- M10：扫描失败（spec §7：danger-soft 错误条 + 重试，仿 import 检测失败 .rp-err 结构） -->
      <div v-if="scanError" class="rp-err">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
        <span>{{ scanError }}</span>
        <button class="btn btn-secondary btn-dense imp-retry" :disabled="scanning" @click="retryScan">重试</button>
      </div>

      <!-- M10：扫描中骨架（3 行 shimmer） -->
      <div v-if="scanning" class="rp-skeleton">
        <div v-for="i in 3" :key="i" class="rp-skel-row">
          <span class="rp-skel-name"></span>
          <span class="rp-skel-badge"></span>
          <span class="rp-skel-desc"></span>
        </div>
      </div>
      <template v-else>
        <div class="rp-list">
          <div v-for="(r, i) in filteredRp" :key="r.name + i" class="rp-item">
            <span class="rp-name">{{ r.name }}</span>
            <!-- M8：来源 badge 链（首项 effective + 余项 faded；单项为普通 badge） -->
            <span
              v-for="(s, si) in r.sources"
              :key="s + '-' + si"
              class="rp-badge"
              :class="badgeClass(r, s, si)"
            >{{ badgeText(r, s, si) }}</span>
            <p class="rp-desc" :title="r.desc">{{ r.desc }}</p>
            <span class="spacer"></span>
            <!-- M12：hover 显「引用到 composer」ghost icon（opacity 0→1 · 120ms），点击短暂显示已引用 note -->
            <span class="rp-item-actions">
              <button class="btn btn-ghost btn-icon-sm rp-quote" title="引用到 composer" aria-label="引用到 composer" @click="quoteToComposer(r.name)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>
              </button>
              <span v-if="quotedName === r.name" class="rp-quoted-note">已引用</span>
            </span>
          </div>
        </div>

        <!-- M10：空态三要素（图标 28px neutral-faint + 说明 + Primary 刷新）；区分全空 / 筛选空 -->
        <div v-if="filteredRp.length === 0" class="rp-empty">
          <template v-if="rpItems.length === 0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>
            <span class="rp-empty-text">未发现任何 Agent</span>
            <span class="rp-empty-hint">勾选加载路径中的目录，或刷新重新扫描</span>
            <button class="btn btn-secondary btn-dense" :disabled="scanning" @click="refresh">
              <svg :class="{ spin: scanning }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
              刷新
            </button>
          </template>
          <template v-else>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <span class="rp-empty-text">{{ TAB_LABEL[sourceTab] }} 来源下暂无 Agent</span>
            <span class="rp-empty-hint">切换到「全部」查看其他来源，或导入 Claude 目录</span>
          </template>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.page-head {
  margin-bottom: var(--space-6);
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

.lp-card {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.lp-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  min-height: 44px;
}
.lp-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--neutral-fg);
}
.lp-hint {
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  margin-left: auto;
}
.spacer {
  flex: 1;
}

/* M1/M2：分组头（项目 / 全局两组，spec §1） */
.lp-group-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--surface-2);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.lp-group-head:first-child {
  border-top: 0;
}
.lp-group-name {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--neutral-fg);
}
.lp-group-scope {
  height: 20px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  font-size: var(--text-2xs);
  font-weight: 600;
  font-family: var(--font-mono);
  flex-shrink: 0;
}
.lp-group-scope.project {
  background: var(--accent-soft);
  color: var(--accent);
}
.lp-group-scope.global {
  background: var(--surface);
  color: var(--neutral-mid);
}
.lp-group-hint {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  margin-left: auto;
  font-family: var(--font-mono);
}

.lp-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.lp-check {
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
.lp-check:checked {
  background: var(--accent);
  border-color: var(--accent);
}
.lp-check:checked::after {
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
/* M11：系统锁定态（disabled + lock 图标，spec 三态：checked / disabled+lock） */
.lp-check:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.lp-check:disabled:checked {
  background: var(--accent);
  border-color: var(--accent);
  opacity: 0.55;
}
.lp-lock {
  width: 14px;
  height: 14px;
  color: var(--neutral-dim);
  flex-shrink: 0;
  margin-left: calc(-1 * var(--space-1));
}
.lp-path {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--neutral-fg);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lp-path.forced {
  opacity: 0.55;
}
.lp-tag {
  height: 18px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--neutral-mid);
  font-size: var(--text-2xs);
  font-weight: 600;
  font-family: var(--font-mono);
  flex-shrink: 0;
}
.lp-tag.forced {
  background: var(--surface-2);
  color: var(--neutral-dim);
}
.lp-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease);
}
.lp-row:hover .lp-actions,
.lp-row:focus-within .lp-actions {
  opacity: 1;
}
.move-btn,
.rm-btn {
  width: 28px;
  height: 28px;
}
.move-btn svg,
.rm-btn svg {
  width: 14px;
  height: 14px;
}
.move-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.lp-add-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.manual-input {
  flex: 1;
}

/* M4 添加路径错误文案（spec §3：neutral-mid 配 AlertCircle 12px danger） */
.lp-add-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 var(--space-4) var(--space-3);
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.lp-add-error__icon {
  width: 12px;
  height: 12px;
  color: var(--danger);
  flex-shrink: 0;
}

/* M5：SourceImport 入口 + 面板（spec §1 底部 + §4 五步） */
.lp-section-label {
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  padding: var(--space-2) var(--space-4) 6px;
  letter-spacing: 0.01em;
}
.lp-import-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-4) var(--space-3);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  flex-wrap: wrap;
}
.lp-import-hint {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  font-family: var(--font-mono);
  flex-shrink: 0;
}
.imp-row .imp-text {
  font-size: var(--text-xs);
  color: var(--neutral-mid);
}
.imp-spinner {
  width: 13px;
  height: 13px;
  color: var(--accent);
  flex-shrink: 0;
  animation: spin 1s linear infinite;
}
.lp-src-label {
  font-size: var(--text-xs);
  color: var(--neutral-fg);
  flex-shrink: 0;
  min-width: 56px;
}
.lp-src-label.dim,
.lp-src-path.dim {
  opacity: 0.6;
}
.lp-src-path {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lp-count {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  font-family: var(--font-mono);
  flex-shrink: 0;
}
.lp-tag.shared {
  background: var(--info-soft);
  color: var(--info);
}
/* 检测失败 / 错误条（spec §4/§7：danger-soft 底 + danger 字 + 原因 + 下一步） */
.rp-err {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--danger-soft);
  border-radius: var(--radius);
  font-size: var(--text-xs);
  color: var(--danger);
  margin: 0 var(--space-4) var(--space-3);
}
.rp-err svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.rp-err .imp-retry {
  margin-left: auto;
}
/* ④ 导入进度（accent spinner + 文案 + 进度条） */
.imp-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  font-size: var(--text-xs);
  color: var(--neutral-mid);
}
.imp-progress-bar {
  flex: 1;
  height: 4px;
  border-radius: 999px;
  background: var(--surface-2);
  overflow: hidden;
}
.imp-progress-fill {
  height: 100%;
  width: 100%;
  background: var(--accent);
  border-radius: 999px;
  transform-origin: left;
  animation: imp-fill 1.2s ease-out forwards;
}
@keyframes imp-fill {
  from {
    transform: scaleX(0);
  }
  to {
    transform: scaleX(1);
  }
}
/* ⑤ 成功反馈 */
.imp-done {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  font-size: var(--text-xs);
  color: var(--success);
}
.imp-done svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}
/* ③ 确认弹窗（浮起 dialog 原语：bg-surface + border + shadow-2 + radius-lg；ESC/backdrop 取消） */
.imp-confirm-stage {
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
.imp-confirm {
  position: relative;
  width: 100%;
  max-width: 420px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  padding: 20px;
}
.imp-confirm-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.imp-confirm-ico {
  width: 16px;
  height: 16px;
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 2px;
}
.imp-confirm-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--neutral-fg);
}
.imp-confirm-desc {
  font-size: var(--text-base);
  line-height: 1.55;
  color: var(--neutral-mid);
  margin: 8px 0 12px;
}
.imp-confirm-bullets {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.imp-confirm-bullets li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.imp-confirm-bullets li svg {
  width: 13px;
  height: 13px;
  color: var(--neutral-dim);
  flex-shrink: 0;
  margin-top: 2px;
}
.imp-confirm-bullets b {
  color: var(--neutral-fg);
  font-weight: 500;
}
.imp-confirm-bullets code {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--accent);
  background: var(--accent-soft);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
}
.imp-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

/* Layer B：资源预览 */
.rp-card {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  overflow: hidden;
  margin-top: var(--space-4);
}
.rp-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  min-height: 44px;
}
.rp-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--neutral-fg);
}
.rp-count-pill {
  height: 18px;
  min-width: 18px;
  padding: 0 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--neutral-mid);
  font-size: var(--text-2xs);
  font-weight: 600;
  font-family: var(--font-mono);
}
.rp-refresh {
  color: var(--neutral-mid);
  font-size: var(--text-sm);
}
.rp-refresh:hover {
  color: var(--neutral-fg);
}
.rp-refresh-icon {
  width: 16px;
  height: 16px;
}
.rp-refresh-icon.spin {
  animation: spin 0.9s linear infinite;
}
/* M10 骨架行：shimmer（全局 @keyframes shimmer 渐变扫动）· 尺寸对齐 spec：height 10px + radius 999px */
.rp-skeleton {
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.rp-skel-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.rp-skel-name,
.rp-skel-badge,
.rp-skel-desc {
  height: 10px;
  border-radius: 999px;
  background-image: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-hover) 50%, var(--surface-2) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
}
.rp-skel-name {
  width: 140px;
  flex-shrink: 0;
}
.rp-skel-badge {
  width: 60px;
  flex-shrink: 0;
}
.rp-skel-desc {
  flex: 1;
}
@media (prefers-reduced-motion: reduce) {
  .rp-skel-name,
  .rp-skel-badge,
  .rp-skel-desc {
    animation: none;
    background-image: none;
    background: var(--surface-2);
  }
}
.rp-tabs {
  display: flex;
  gap: 2px;
  background: var(--bg-input);
  border-radius: var(--radius);
  padding: 3px;
}
.rp-tab {
  height: 28px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--neutral-mid);
  font-size: var(--text-sm);
  font-weight: 500;
  font-family: var(--font-sans);
  transition: all var(--duration-fast) var(--ease);
}
.rp-tab:hover {
  color: var(--neutral-fg);
}
.rp-tab.active {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}

.rp-list {
  display: flex;
  flex-direction: column;
}
/* 资源项（spec §5）：单行 flex —— name + badge 链 + desc（max-width 220px 省略）+ 行尾引用操作；
 * hover 行背景 rgba(255,255,255,.02) + 引用 ghost icon opacity 0→1 · 120ms */
.rp-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  transition: background var(--duration-fast) var(--ease);
}
.rp-item:hover {
  background: rgba(255, 255, 255, 0.02);
}
.rp-item-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  opacity: 0;
  transition: opacity 120ms var(--ease);
}
.rp-item:hover .rp-item-actions,
.rp-item:focus-within .rp-item-actions {
  opacity: 1;
}
.rp-quote svg {
  width: 15px;
  height: 15px;
}
.rp-quoted-note {
  font-size: var(--text-2xs);
  font-weight: 600;
  color: var(--success);
  flex-shrink: 0;
}
.rp-name {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--neutral-fg);
  flex-shrink: 0;
}
/* M8：来源 badge（R17：统一中性底 + 彩色小点；effective = accent + inset ring；faded = 次级源） */
.rp-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--text-2xs);
  padding: 2px 7px 2px 5px;
  border-radius: 999px;
  font-family: var(--font-mono);
  flex-shrink: 0;
  letter-spacing: 0.02em;
  background: var(--surface-2);
  color: var(--neutral-mid);
  font-weight: 600;
}
.rp-badge::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--neutral-dim);
}
.rp-badge.effective::before {
  background: var(--accent);
}
.rp-badge.pi::before {
  background: var(--accent);
}
.rp-badge.claude::before {
  background: var(--warn);
}
.rp-badge.agents::before {
  background: var(--success);
}
.rp-badge.piinstall::before {
  background: var(--info);
}
.rp-badge.muted::before {
  background: var(--neutral-dim);
}
.rp-badge.faded {
  opacity: 0.6;
}
.rp-badge.effective {
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent-ring);
}
.rp-desc {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}
/* M10：空态（图标 28px neutral-faint + 主文 + 辅文 + Primary 刷新） */
.rp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-8) var(--space-4);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  text-align: center;
}
.rp-empty svg {
  width: 28px;
  height: 28px;
  color: var(--neutral-faint);
}
.rp-empty-text {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  margin-top: var(--space-1);
}
.rp-empty-hint {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}
.rp-empty .btn {
  margin-top: var(--space-1);
}
</style>
