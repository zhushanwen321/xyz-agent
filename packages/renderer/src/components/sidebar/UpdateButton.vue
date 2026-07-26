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
      <HoverCardContent side="top" class="max-h-[320px] w-[320px] overflow-auto p-3 text-[12px] text-fg">
        <div class="mb-1.5 text-[11px] font-semibold text-accent">{{ t('sidebar.update.newVersion') }}</div>
        <!--
          不复用 MarkdownRenderer 组件：该组件位于 panel/message-stream 下，强依赖 fileSearch/fileTree/
          sideDrawer/AmbiguousFilePopover/MermaidRenderer 等 panel 上下文（sessionId 在此无值，文件路径识别/
          代码复制交互无意义且会拖入 shiki WASM）。HoverCard 内 release note 是只读展示，复制/链接交互非必需；
          如需交互可后续抽取一个轻量只读 MarkdownView 组件再迁移。排版用浏览器默认样式。
        -->
        <!-- eslint-disable-next-line vue/no-v-html -- release note 经 markdown-it 渲染（html:false 默认禁裸 HTML + scheme 白名单过滤），与 MarkdownRenderer 同论证 XSS-safe。受控注入点。 -->
        <div data-testid="update-release-notes" v-html="state.releaseNotesHtml" />
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
