<template>
  <!--
    升级状态指示器 · 嵌入 Sidebar 版本号 span（兄弟元素）。
    按 state 分支渲染：idle/checking 不渲染；available 显可升级角标 + release note 浮层；
    downloading/verifying/replacing 显 spinner + 进度条；restarting 显成功态；
    error 显错误图标 + 完整错误浮层；unsupported 显「前往下载」按钮。

    单例：useAppUpdate 的 state 全应用共享（Sidebar initAutoCheck 检测，UpdateButton 消费）。
  -->
  <span v-if="visible" class="update-button inline-flex items-center" data-testid="update-button">
    <!-- available：可升级，hover 显 release note，click 触发 performUpdate -->
    <HoverCard v-if="state.state === 'available'">
      <HoverCardTrigger as-child>
        <Button
          variant="ghost"
          size="sm"
          class="relative h-auto gap-0.5 px-1 py-0 text-[10px] text-accent hover:text-accent"
          data-testid="update-available"
          :title="t('sidebar.update.newVersion')"
          @click="onPerformUpdate"
        >
          <ArrowUp class="size-3" />
          <!-- 红点角标（与 SegmentedTab.vue:27-30 同范式） -->
          <span class="absolute right-0 top-0 size-[5px] rounded-full bg-danger" data-testid="update-badge" />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent side="top" class="release-notes-content max-h-[360px] w-[360px] overflow-auto p-4 text-[12px] text-fg">
        <div class="mb-2 text-[13px] font-semibold text-accent">{{ t('sidebar.update.newVersion') }}</div>
        <!--
          不复用 MarkdownRenderer 组件：该组件位于 panel/message-stream 下，强依赖 fileSearch/fileTree/
          sideDrawer/AmbiguousFilePopover/MermaidRenderer 等 panel 上下文（sessionId 在此无值，文件路径识别/
          代码复制交互无意义且会拖入 shiki WASM）。HoverCard 内 release note 是只读展示，复制/链接交互非必需；
          如需交互可后续抽取一个轻量只读 MarkdownView 组件再迁移。
        -->
        <!-- eslint-disable-next-line vue/no-v-html -- release note 经 markdown-it 渲染（html:false 默认禁裸 HTML + scheme 白名单过滤），与 MarkdownRenderer 同论证 XSS-safe。受控注入点。 -->
        <div class="release-notes-markdown" data-testid="update-release-notes" v-html="state.releaseNotesHtml" />
      </HoverCardContent>
    </HoverCard>

    <!-- downloading / verifying：spinner + 进度条 + 百分比 -->
    <span
      v-else-if="state.state === 'downloading' || state.state === 'verifying'"
      class="inline-flex items-center gap-1 text-[10px] text-muted"
      data-testid="update-progress"
    >
      <Loader2 class="size-3 animate-spin" />
      <span class="tabular-nums">{{ t('sidebar.update.downloading', { percent: state.percent }) }}</span>
      <!-- 进度条（与 ContextCapacityPopover.vue:42-47 同范式：div 拼，bg-surface-2 容器 + bg-accent 子条） -->
      <span
        class="h-1 w-10 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        :aria-valuenow="state.percent"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="t('sidebar.update.downloading', { percent: state.percent })"
      >
        <span
          class="block h-full rounded-full bg-accent transition-all"
          :style="{ width: `${state.percent}%` }"
        />
      </span>
    </span>

    <!-- replacing：spinner（替换文件阶段，无百分比） -->
    <span
      v-else-if="state.state === 'replacing'"
      class="inline-flex items-center gap-1 text-[10px] text-muted"
      data-testid="update-replacing"
    >
      <Loader2 class="size-3 animate-spin" />
      <span>{{ t('sidebar.update.replacing') }}</span>
    </span>

    <!-- restarting：升级完成、即将重启 -->
    <span
      v-else-if="state.state === 'restarting'"
      class="inline-flex items-center gap-1 text-[10px] text-success"
      data-testid="update-restarting"
    >
      <CheckCircle2 class="size-3" />
      <span>{{ t('sidebar.update.restarting') }}</span>
    </span>

    <!-- error：升级失败，hover 显完整错误信息 -->
    <HoverCard v-else-if="state.state === 'error'">
      <HoverCardTrigger as-child>
        <Button
          variant="ghost"
          size="sm"
          class="h-auto gap-0.5 px-1 py-0 text-[10px] text-danger hover:text-danger"
          data-testid="update-error"
          :title="t('sidebar.update.error')"
        >
          <AlertCircle class="size-3" />
          <span>{{ t('sidebar.update.error') }}</span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent side="top" class="w-[280px] p-3 text-[11px] text-muted">
        {{ state.errorMessage }}
      </HoverCardContent>
    </HoverCard>

    <!-- unsupported：当前平台不支持自动升级，提供「前往下载」备用入口 -->
    <Button
      v-else-if="state.state === 'unsupported'"
      variant="ghost"
      size="sm"
      class="h-auto gap-0.5 px-1 py-0 text-[10px] text-accent hover:text-accent"
      data-testid="update-unsupported"
      @click="onOpenFallbackUrl"
    >
      <ArrowUp class="size-3" />
      <span>{{ t('sidebar.update.goToDownload') }}</span>
    </Button>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUp, Loader2, CheckCircle2, AlertCircle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useAppUpdate } from '@/composables/features/useAppUpdate'

const { t } = useI18n()
const { state, performUpdate, openFallbackUrl } = useAppUpdate()

/** idle/checking 不渲染（无可展示信息） */
const visible = computed(
  () => state.state !== 'idle' && state.state !== 'checking',
)

/** available click：触发完整升级流程 */
async function onPerformUpdate(): Promise<void> {
  await performUpdate()
}

/** unsupported click：打开备用下载页 */
async function onOpenFallbackUrl(): Promise<void> {
  await openFallbackUrl()
}
</script>

<style scoped>
/* ── Release Notes Markdown 样式 ──
   只读展示，不需要代码块复制/文件路径交互等重功能。
   复用 MarkdownRenderer 的核心排版样式，保持视觉一致性。 */

.release-notes-content {
  scrollbar-width: thin;
  scrollbar-color: var(--surface-hover) transparent;
}

.release-notes-markdown :deep(h1),
.release-notes-markdown :deep(h2),
.release-notes-markdown :deep(h3),
.release-notes-markdown :deep(h4) {
  font-weight: 600;
  line-height: 1.35;
  margin: 0.8em 0 0.4em;
  color: var(--fg);
}
.release-notes-markdown :deep(h1) { font-size: 1.25em; }
.release-notes-markdown :deep(h2) { font-size: 1.15em; }
.release-notes-markdown :deep(h3) { font-size: 1.05em; }

.release-notes-markdown :deep(p) {
  margin: 0.4em 0;
  line-height: 1.65;
}

.release-notes-markdown :deep(ul),
.release-notes-markdown :deep(ol) {
  margin: 0.4em 0;
  padding-left: 1.3em;
}
.release-notes-markdown :deep(ul) {
  list-style-type: disc;
}
.release-notes-markdown :deep(ol) {
  list-style-type: decimal;
}
.release-notes-markdown :deep(li) {
  margin: 0.15em 0;
  line-height: 1.65;
}
.release-notes-markdown :deep(li)::marker {
  color: var(--fg);
}

.release-notes-markdown :deep(blockquote) {
  border-left: 2px solid var(--border-strong);
  padding-left: 0.8em;
  margin: 0.5em 0;
  color: var(--muted);
}

.release-notes-markdown :deep(a) {
  color: var(--accent);
  text-decoration: none;
}
.release-notes-markdown :deep(a:hover) {
  text-decoration: underline;
}

/* 行内代码 */
.release-notes-markdown :deep(code:not(pre code)) {
  font-family: var(--font-mono);
  font-size: 0.88em;
  background: var(--surface-2);
  padding: 0.1em 0.35em;
  border-radius: var(--radius-sm);
  color: var(--fg);
}

/* 代码块：简化版（无复制按钮/语言标签，只读展示） */
.release-notes-markdown :deep(.md-codeblock) {
  margin: 0.6em 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.release-notes-markdown :deep(.md-codeblock__header) {
  display: flex;
  align-items: center;
  padding: 0.2em 0.6em;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.release-notes-markdown :deep(.md-codeblock__lang) {
  font-family: var(--font-mono);
  font-size: 0.72em;
  color: var(--subtle);
  text-transform: lowercase;
}
/* 隐藏复制按钮（只读展示不需要） */
.release-notes-markdown :deep(.md-codeblock__copy) {
  display: none;
}
.release-notes-markdown :deep(.md-codeblock pre.shiki) {
  margin: 0;
  padding: 0.7em 0.9em;
  border-radius: 0;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.82em;
  line-height: 1.55;
}
.release-notes-markdown :deep(.md-codeblock pre.shiki code) {
  font-family: inherit;
  background: transparent;
  padding: 0;
}

/* 表格 */
.release-notes-markdown :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.6em 0;
  font-size: 0.9em;
}
.release-notes-markdown :deep(th),
.release-notes-markdown :deep(td) {
  border: 1px solid var(--border);
  padding: 0.3em 0.5em;
  text-align: left;
}
.release-notes-markdown :deep(th) {
  background: var(--surface-2);
  font-weight: 600;
  color: var(--fg);
}

.release-notes-markdown :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 0.8em 0;
}

/* shiki 双主题切换（与 MarkdownRenderer 一致） */
.release-notes-markdown :deep(.shiki) {
  background-color: var(--shiki-dark-bg) !important;
}
.release-notes-markdown :deep(.shiki span) {
  color: var(--shiki-dark);
}

:global([data-theme="light"]) .release-notes-markdown :deep(.shiki) {
  background-color: var(--shiki-light-bg) !important;
}
:global([data-theme="light"]) .release-notes-markdown :deep(.shiki span) {
  color: var(--shiki-light);
}
</style>
