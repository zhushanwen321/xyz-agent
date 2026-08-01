<script setup lang="ts">
/**
 * DetailPane · detail tab（文件预览）
 * L2 多文件 tab + 预览/变更 toggle（当前 tab 视图切换，非全局）
 * header：文件名 + 复制/引用按钮（surface + hairline（方案 G），去 border-b）
 */
import { ref, computed } from 'vue'
import { detailFileTab } from '@/composables/useStore'
import { gitFiles, type GitFile } from '@/mock/sessions'
import DiffView from './DiffView.vue'

/** 多文件 tab（取自 git 改动文件，demo 用前 3 个；响应式数组支持关闭移除） */
interface TabFile extends GitFile {
  /** 是否有 git 变更（spec §3：预览/变更 toggle 仅 hasGitChange 时显；demo 全为 git 文件恒 true） */
  gitChange: boolean
}

const fileTabs = ref<TabFile[]>(
  gitFiles.slice(0, 3).map((f) => ({ ...f, gitChange: true })),
)

/** 当前视图模式（预览/变更），demo 默认变更 */
const viewMode = ref<'preview' | 'diff'>('diff')

/** 当前 tab 文件（绑 detailFileTab，越界/空数组回退 undefined） */
const currentFile = computed<TabFile | undefined>(() => fileTabs.value[detailFileTab.value] ?? fileTabs.value[0])

/** 关闭 tab（移除 + 校正选中 index） */
function closeFile(i: number) {
  fileTabs.value.splice(i, 1)
  if (i < detailFileTab.value) detailFileTab.value -= 1
  else if (detailFileTab.value >= fileTabs.value.length) detailFileTab.value = Math.max(0, fileTabs.value.length - 1)
}

/** 仅取文件名（去路径前缀） */
function basename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

/** 复制路径（demo 占位） */
function copyPath() {
  if (!currentFile.value) return
  navigator.clipboard?.writeText(currentFile.value.name).catch(() => {})
}
</script>

<template>
  <div class="dp-v6">
    <!-- L2 多文件 tab 栏（bg-surface-2 浮起；全部关闭后隐藏，进空态）-->
    <div v-if="fileTabs.length > 0" class="b-l2">
      <div
        v-for="(f, i) in fileTabs"
        :key="f.name"
        class="b-l2-tab"
        :class="{ on: detailFileTab === i }"
        @click="detailFileTab = i"
      >
        <span class="tt-name">{{ basename(f.name) }}</span>
        <span class="tt-close" title="关闭 tab" @click.stop="closeFile(i)">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </span>
      </div>

      <span class="spacer"></span>

      <!-- 预览/变更 toggle（SegmentedTab：bg-input p-3px，on bg-elevated；仅 hasGitChange 时显，spec §3）-->
      <div v-if="currentFile?.gitChange" class="l2-view" title="当前 tab 视图切换">
        <button class="lv-btn" :class="{ on: viewMode === 'preview' }" @click="viewMode = 'preview'">预览</button>
        <button class="lv-btn" :class="{ on: viewMode === 'diff' }" @click="viewMode = 'diff'">变更</button>
      </div>
    </div>

    <!-- header：文件名 + 复制/引用（无 tab 时隐藏）-->
    <div v-if="currentFile" class="dp-header">
      <svg class="dp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
      </svg>
      <span class="dp-name" :title="currentFile.name">{{ basename(currentFile.name) }}</span>
      <button class="dp-btn" title="复制文件路径" @click="copyPath">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
      <button class="dp-btn" title="引用文件到 composer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" /><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z" />
        </svg>
      </button>
    </div>

    <!-- 内容区（无 tab 时不渲染）-->
    <div v-if="currentFile" class="dp-content">
      <!-- 预览模式 -->
      <div v-if="viewMode === 'preview'" class="dp-preview">
        <div><span class="kw">export</span> <span class="kw">default</span> {</div>
        <div>&nbsp;&nbsp;name: <span class="str">'TurnMeta'</span>,</div>
        <div>&nbsp;&nbsp;<span class="com">// 文件预览（无 diff 着色）</span></div>
        <div>&nbsp;&nbsp;props: { file: <span class="str">String</span> },</div>
        <div>}</div>
      </div>
      <!-- 变更模式：DiffView -->
      <DiffView v-else :file="currentFile" />
    </div>

    <!-- 空态（全部 tab 关闭）：无二级栏 · FileText icon 24px + 提示文（spec §3 空态变体）-->
    <div v-else class="dp-empty">
      <svg class="dp-empty-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
        <path d="M10 9H8" />
        <path d="M16 13H8" />
        <path d="M16 17H8" />
      </svg>
      <span class="dp-empty-text">无打开的文件</span>
    </div>
  </div>
</template>

<style scoped>
.dp-v6 {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  min-height: 0;
  overflow: hidden;
}

/* L2 二级 tab 栏：surface + hairline（方案 G），去 border-b */
.b-l2 {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  background: var(--surface);
  border-bottom: 1px solid var(--hairline);
  min-height: 34px;
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none; /* 隐藏滚动条（Firefox）*/
  flex-shrink: 0;
}
.b-l2::-webkit-scrollbar { display: none; } /* 隐藏滚动条（Chrome/Safari）*/
.b-l2-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 150px;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  transition: all var(--duration-fast) var(--ease);
}
.b-l2-tab:hover {
  color: var(--neutral-fg);
}
.b-l2-tab.on {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.b-l2-tab.on:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.b-l2-tab .tt-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}
.b-l2-tab .tt-close {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  flex-shrink: 0;
  opacity: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity var(--duration-fast) var(--ease);
}
.b-l2-tab:hover .tt-close,
.b-l2-tab.on .tt-close {
  opacity: 0.6;
}
.b-l2-tab .tt-close:hover {
  opacity: 1;
  background: var(--surface-2);
}

.b-l2 .spacer {
  flex: 1;
}

/* SegmentedTab toggle：bg-input p-3px，on bg-elevated */
.l2-view {
  display: flex;
  gap: 2px;
  align-items: center;
  background: var(--bg-input);
  border-radius: var(--radius);
  padding: 3px;
  height: 22px;
  flex-shrink: 0;
}
.l2-view .lv-btn {
  border: 0;
  cursor: pointer;
  font: inherit;
  font-size: var(--text-2xs);
  line-height: 1;
  padding: 3px 9px;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--neutral-mid);
  transition: all var(--duration-fast) var(--ease);
}
.l2-view .lv-btn.on {
  background: var(--bg-elevated);
  color: var(--neutral-fg);
}

/* header：surface + hairline（方案 G） */
.dp-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--surface);
  border-bottom: 1px solid var(--hairline);
  flex-shrink: 0;
}
.dp-header .dp-ico {
  width: 14px;
  height: 14px;
  color: var(--neutral-dim);
  flex-shrink: 0;
}
.dp-header .dp-name {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dp-btn {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  border: 0;
  cursor: pointer;
  background: transparent;
  color: var(--neutral-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-fast) var(--ease);
  flex-shrink: 0;
}
.dp-btn:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.dp-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}

/* 内容区 */
.dp-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px;
  background: var(--bg-input);
}

/* 空态（全部 tab 关闭）：FileText 24px + 提示文，无二级栏 */
.dp-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--bg);
}
.dp-empty .dp-empty-ico {
  width: 24px;
  height: 24px;
  color: var(--neutral-dim);
}
.dp-empty .dp-empty-text {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}

/* 预览模式：mono + 语法高亮占位 */
.dp-preview {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.6;
  color: var(--neutral-mid);
  padding: 12px 16px;
}
.dp-preview .kw {
  color: var(--accent);
}
.dp-preview .str {
  color: var(--success);
}
.dp-preview .com {
  color: var(--neutral-dim);
}
</style>
