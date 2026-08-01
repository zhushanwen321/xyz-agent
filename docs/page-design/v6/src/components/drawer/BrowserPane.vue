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
  /** spec §6 viewport 三态 + v6 登录墙（'login' 为 v6 新增态：warn 收敛单点） */
  state: 'content' | 'loading' | 'empty' | 'login'
}

const pages = ref<BrowserPage[]>([
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
])

const current = computed<BrowserPage | undefined>(() => pages.value[browserPageTab.value] ?? pages.value[0])

/** 关闭页面（移除 + 校正选中 index；全部关闭后 current 为 undefined 进空态） */
function closePage(i: number) {
  pages.value.splice(i, 1)
  if (i < browserPageTab.value) browserPageTab.value -= 1
  else if (browserPageTab.value >= pages.value.length) browserPageTab.value = Math.max(0, pages.value.length - 1)
}

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
        <span class="tt-close" title="关闭页面" @click.stop="closePage(i)">
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
        <svg v-if="current?.secure" class="bp-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span class="bp-url" :class="{ insecure: !current?.secure }">{{ current?.url ?? '' }}</span>
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

    <!-- 登录墙（v6：warn 收敛单点提示，bg-warn-soft 整块；仅 state==='login' 渲染，默认 content 不触发）-->
    <div v-if="current?.state === 'login'" class="bp-login">
      <svg class="bp-warn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" />
      </svg>
      <div class="bp-login-text">
        <div class="bp-login-title">需要登录</div>
        <div class="bp-login-hint">{{ current.url }} 需要认证，请在系统浏览器中完成登录</div>
      </div>
      <button class="bp-ext" title="在系统浏览器中打开">在系统浏览器中打开</button>
    </div>

    <!-- viewport：内容占位（bg 画布底）-->
    <div class="bp-viewport">
      <!-- 无页面（全部关闭）-->
      <div v-if="!current" class="bp-empty">
        <svg class="bp-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        <span class="bp-empty-text">无打开页面</span>
      </div>
      <!-- 加载态：spinner + URL（spec §6 三态之一）-->
      <div v-else-if="current.state === 'loading'" class="bp-loading">
        <div class="bp-spinner"></div>
        <span class="bp-load-url">{{ current.url }}</span>
      </div>
      <!-- 空态：globe + 提示文（spec §6 三态之一）-->
      <div v-else-if="current.state === 'empty'" class="bp-empty">
        <svg class="bp-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        <span class="bp-empty-text">点击 agent 输出的链接打开</span>
      </div>
      <!-- 内容态（默认）-->
      <div v-else class="bp-content">
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

/* L2 二级 tab 栏：surface + hairline（方案 G） */
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
  flex-shrink: 0;
}
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
  justify-content: center;
  gap: 4px;
  height: 20px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  transition: all var(--duration-fast) var(--ease);
  flex-shrink: 0;
}
.b-l2-newtab:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}

/* guide banner：surface + hairline（方案 G） */
.bp-guide {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--hairline);
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

/* nav 工具栏：surface + hairline（方案 G） */
.bp-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: var(--surface);
  border-bottom: 1px solid var(--hairline);
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
/* 加载态（spec §6）：spinner 14px accent + URL */
.bp-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.bp-loading .bp-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: bp-spin 0.8s linear infinite;
}
@keyframes bp-spin {
  to {
    transform: rotate(360deg);
  }
}
.bp-loading .bp-load-url {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-mid);
}
/* 空态（spec §6）：globe 28px neutral-dim + 提示 */
.bp-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--neutral-dim);
}
.bp-empty .bp-globe {
  width: 28px;
  height: 28px;
  opacity: 0.4;
}
.bp-empty .bp-empty-text {
  font-size: var(--text-sm);
}
/* 登录墙（v6：warn 收敛单点，bg-warn-soft 整块 + rounded，去 border-b）*/
.bp-login {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 8px;
  padding: 8px 12px;
  background: var(--warn-soft);
  border-radius: var(--radius);
  flex-shrink: 0;
}
.bp-login .bp-warn-ico {
  width: 16px;
  height: 16px;
  color: var(--warn);
  flex-shrink: 0;
}
.bp-login .bp-login-text {
  flex: 1;
  min-width: 0;
}
.bp-login .bp-login-text .bp-login-title {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--warn);
}
.bp-login .bp-login-text .bp-login-hint {
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bp-login .bp-ext {
  flex-shrink: 0;
  padding: 4px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--warn);
  font-size: var(--text-xs);
  font-family: inherit;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.bp-login .bp-ext:hover {
  background: var(--surface-hover);
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
