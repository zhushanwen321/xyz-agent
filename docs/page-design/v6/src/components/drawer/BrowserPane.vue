<script setup lang="ts">
/**
 * BrowserPane · browser tab（嵌入式浏览器面板）
 * L2 多页面 tab + bp-guide banner（plugin 注册占位）+ bp-nav 工具栏 + bp-viewport
 * 三处 border-b 全去，靠各自 bg 分层（§3.4 统一）
 */
import { computed, ref } from 'vue'
import { browserPageTab } from '@/composables/useStore'

/** 浏览器页面 tab */
interface BrowserPage {
  id: string
  label: string
  url: string
  secure: boolean
  state: 'content' | 'loading' | 'empty'
}

const pages: BrowserPage[] = [
  {
    id: 'pg-1',
    label: 'example.com/docs',
    url: 'https://example.com/docs',
    secure: true,
    state: 'content',
  },
  {
    id: 'pg-2',
    label: 'api.reference',
    url: 'https://api.reference.dev/v1',
    secure: true,
    state: 'content',
  },
]

const current = computed<BrowserPage>(() => pages[browserPageTab.value] ?? pages[0])

/** guide banner 关闭态 */
const guideDismissed = ref(false)
</script>

<template>
  <div class="bp-v6">
    <!-- L2 多页面 tab + 新增按钮 -->
    <div class="b-l2">
      <div
        v-for="(p, i) in pages"
        :key="p.id"
        class="b-l2-tab"
        :class="{ on: browserPageTab === i }"
        @click="browserPageTab = i"
      >
        <svg class="tt-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        <span class="tt-name">{{ p.label }}</span>
        <span class="tt-close" title="关闭页面">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </span>
      </div>

      <div class="b-l2-newtab" title="新开页面（输入 URL 或默认页）">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>新页面</span>
      </div>
    </div>

    <!-- guide banner：中性 bg-surface-2，去 border-b（plugin 注册占位）-->
    <div v-if="!guideDismissed" class="bp-guide">
      <svg class="bp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
      <span class="bp-text">点击链接在抽屉内打开，主进程安全渲染</span>
      <span class="bp-x" title="不再提示" @click="guideDismissed = true">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </span>
    </div>

    <!-- nav 工具栏：bg-surface-2 浮起，去 border-b -->
    <div class="bp-nav">
      <button class="bp-btn disabled" title="后退（无历史）" disabled>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
        </svg>
      </button>
      <button class="bp-btn disabled" title="前进（无历史）" disabled>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
        </svg>
      </button>
      <button class="bp-btn" title="重载">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      </button>

      <div class="bp-urlbar">
        <svg v-if="current.secure" class="bp-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span class="bp-url" :class="{ insecure: !current.secure }">{{ current.url }}</span>
      </div>

      <button class="bp-btn" title="复制链接">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
      <button class="bp-btn" title="系统浏览器打开">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </button>
    </div>

    <!-- viewport：内容占位（bg 画布底）-->
    <div class="bp-viewport">
      <div class="bp-content">
        <div class="bp-page-title">Example Docs</div>
        <div class="bp-page-sub">安全渲染区域 · 主进程 WebContentsView 覆盖</div>
        <div class="bp-page-block">
          <div class="bp-block-title">Getting Started</div>
          <div class="bp-page-p">页面内容由主进程 view 真实渲染，本面板仅承载位置与状态覆盖层。</div>
        </div>
        <div class="bp-page-p">三层明度：stage(#131316) → drawer(bg) → nav/guide(surface-2) 浮起分层。</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bp-v6 {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  min-height: 0;
  overflow: hidden;
}

/* L2 二级 tab 栏 */
.b-l2 {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  background: var(--surface-2);
  min-height: 36px;
  flex-shrink: 0;
}
.b-l2-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 160px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  transition: all var(--duration-fast) var(--ease);
}
.b-l2-tab:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.b-l2-tab.on {
  background: var(--bg-elevated);
  color: var(--neutral-fg);
}
.b-l2-tab.on:hover {
  background: var(--bg-elevated);
  color: var(--neutral-fg);
}
.b-l2-tab .tt-ico {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
  opacity: 0.7;
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
.b-l2-newtab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  transition: all var(--duration-fast) var(--ease);
}
.b-l2-newtab:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}

/* guide banner：中性 bg-surface-2 */
.bp-guide {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--surface-2);
  flex-shrink: 0;
}
.bp-guide .bp-ico {
  width: 14px;
  height: 14px;
  color: var(--neutral-mid);
  flex-shrink: 0;
}
.bp-guide .bp-text {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--neutral-fg);
}
.bp-guide .bp-x {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--neutral-dim);
  cursor: pointer;
  flex-shrink: 0;
  transition: all var(--duration-fast) var(--ease);
}
.bp-guide .bp-x:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}

/* nav 工具栏：bg-surface-2 浮起 */
.bp-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: var(--surface-2);
  flex-shrink: 0;
}
.bp-btn {
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  border: 0;
  cursor: pointer;
  background: transparent;
  color: var(--neutral-mid);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-fast) var(--ease);
  flex-shrink: 0;
}
.bp-btn:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.bp-btn.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.bp-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
.bp-urlbar {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: var(--bg-input);
  border-radius: 999px;
  margin: 0 4px;
}
.bp-urlbar .bp-lock {
  width: 11px;
  height: 11px;
  color: var(--success);
  flex-shrink: 0;
}
.bp-urlbar .bp-url {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bp-urlbar .bp-url.insecure {
  color: var(--neutral-mid);
}

/* viewport：bg 画布底 */
.bp-viewport {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--bg);
  overflow: hidden;
}
/* 内容展示态（模拟已加载页面，浅色内容模拟真实网页） */
.bp-content {
  position: absolute;
  inset: 0;
  background: #f4f5f7;
  padding: 20px 24px;
  overflow: auto;
  color: #1f2937;
  font-size: 14px;
  line-height: 1.6;
}
.bp-content .bp-page-title {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 8px;
  color: #111827;
}
.bp-content .bp-page-sub {
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 12px;
}
.bp-content .bp-page-p {
  margin-bottom: 8px;
  color: #374151;
}
.bp-content .bp-page-block {
  background: #fff;
  border-radius: var(--radius-sm);
  padding: 12px;
  margin-bottom: 8px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.bp-content .bp-block-title {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
  margin-bottom: 4px;
}
</style>
