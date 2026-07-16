<template>
  <!--
    DetailPane —— 文件预览面板（#6，UC-6，对齐 draft-detail-pane.html）。
    文件内容 / diff 预览，挂在 SideDrawer detail tab。

    [NFR-AC-S4] 禁 v-html：内容用 <pre> + {{ }} 文本插值渲染，XSS 安全（T6.10）。
    data-testid 标注供 E2E 选择器。

    数据来源：useDetailPane（watch selectedPath → openPreview → git.getDiff / file.read）。
  -->
  <div class="flex h-full flex-col" data-testid="detail-pane">
    <!-- header：文件名（hover 显绝对路径 + 复制文件名）+ 复制绝对路径按钮 + view toggle -->
    <div class="flex items-center gap-2 border-b border-border px-2 py-1.5">
      <FileText class="size-3.5 shrink-0 text-subtle" />
      <HoverCard :open-delay="0">
        <HoverCardTrigger as-child>
          <span
            data-testid="detail-filename"
            class="flex-1 cursor-default truncate font-mono text-[11px] text-fg"
          >{{ fileName }}</span>
        </HoverCardTrigger>
        <HoverCardContent class="w-auto max-w-md p-2" side="bottom">
          <div data-testid="detail-path-tooltip" class="flex flex-col gap-1.5">
            <div class="flex items-center gap-2">
              <span class="font-mono text-[11px] text-fg">{{ fileName }}</span>
              <Button
                variant="ghost"
                data-testid="detail-copy-filename"
                class="h-5 w-5 rounded-sm p-0"
                :title="t('panel.detail.copyFileName')"
                :disabled="!fileName || fileName === t('panel.sideDrawer.noFileSelected')"
                @click="copy(fileName, 'filename')"
              >
                <Check v-if="copied === 'filename'" class="size-3 text-accent" />
                <Copy v-else class="size-3 text-subtle" />
              </Button>
            </div>
            <div class="flex items-center gap-2">
              <span class="break-all font-mono text-[10px] text-muted">{{ absolutePath }}</span>
              <Button
                variant="ghost"
                data-testid="detail-copy-path"
                class="h-5 w-5 rounded-sm p-0"
                :title="t('panel.detail.copyFilePath')"
                :disabled="!absolutePath"
                @click="copy(absolutePath, 'path')"
              >
                <Check v-if="copied === 'path'" class="size-3 text-accent" />
                <Copy v-else class="size-3 text-subtle" />
              </Button>
            </div>
          </div>
        </HoverCardContent>
      </HoverCard>
      <Button
        variant="ghost"
        data-testid="detail-copy-path"
        class="h-6 w-6 rounded-sm p-0"
        :title="t('panel.detail.copyFilePath')"
        :disabled="!absolutePath"
        @click="copy(absolutePath, 'path')"
      >
        <Check v-if="copied === 'path'" class="size-3.5 text-accent" />
        <Copy v-else class="size-3.5 text-subtle" />
      </Button>
      <!-- FR-3: 加入文件引用到 composer（无行范围，target=current） -->
      <Button
        variant="ghost"
        data-testid="detail-inject-file"
        class="h-6 w-6 rounded-sm p-0"
        :title="t('panel.detail.injectFileRef')"
        :disabled="!state.path"
        @click="injectFileRef()"
      >
        <Quote class="size-3.5 text-subtle" />
      </Button>
      <!-- view toggle：有 git 改动时可切换 diff/preview -->
      <div v-if="state.hasGitChange" class="flex gap-0.5" data-testid="detail-view-toggle">
        <Button
          variant="ghost"
          class="h-6 rounded-sm px-1.5 text-[10px]"
          :class="state.viewMode === 'diff' ? 'bg-accent-soft text-accent' : 'text-muted'"
          :title="t('panel.detail.showDiff')"
          @click="onToggleView('diff')"
        >{{ t('panel.detail.tabDiff') }}</Button>
        <Button
          variant="ghost"
          class="h-6 rounded-sm px-1.5 text-[10px]"
          :class="state.viewMode === 'preview' ? 'bg-accent-soft text-accent' : 'text-muted'"
          :title="t('panel.detail.showPreview')"
          @click="onToggleView('preview')"
        >{{ t('panel.detail.preview') }}</Button>
      </div>
    </div>

    <!-- 加载态（骨架，AC-6.6/T6.7：异步返回前非空白） -->
    <div
      v-if="state.status === 'loading'"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-4"
      data-testid="detail-loading"
    >
      <Loader2 class="size-4 animate-spin text-subtle opacity-60" />
      <p class="text-[11px] text-subtle opacity-60">{{ t('panel.detail.loading') }}</p>
    </div>

    <!-- 错误态（AC-6.4/T6.4：权限/不存在 → 错误态） -->
    <div
      v-else-if="state.status === 'error'"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="detail-error"
    >
      <AlertCircle class="size-5 text-danger opacity-60" />
      <p class="text-[11px] text-muted">{{ t('panel.detail.cannotPreview') }}</p>
      <p class="font-mono text-[10px] text-subtle opacity-70">{{ state.error }}</p>
    </div>

    <!-- 空态（无选中文件） -->
    <div
      v-else-if="state.status === 'idle' || !state.path"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="detail-empty"
    >
      <FileText class="size-6 text-subtle opacity-40" />
      <p class="text-[11px] text-subtle opacity-55">{{ t('panel.detail.clickFilePreview') }}</p>
    </div>

    <!-- 二进制文件占位（AC-6.5/T6.6：binary=true） -->
    <div
      v-else-if="state.binary"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="detail-binary"
    >
      <ImageIcon class="size-6 text-subtle opacity-50" />
      <p class="text-[11px] text-muted">{{ t('panel.detail.binaryFile') }}</p>
      <p class="font-mono text-[10px] text-subtle opacity-60">{{ t('panel.detail.cannotShowDiff') }}</p>
    </div>

    <!-- 内容区：按 viewMode + kind 分发渲染（禁 v-html，<pre> + 文本插值，XSS 安全；
         markdown/code/diff 经各自渲染器的受控 v-html 点处理，论证 XSS 安全）。
         @mouseup 检测选区（FR-4）：选中文本后弹引用 bubble。 -->
    <div
      v-else
      ref="contentRef"
      class="relative min-h-0 flex-1 overflow-auto"
      data-testid="detail-content"
      @mouseup="onContentMouseup"
    >
      <!-- 截断提示（>1MB，AC-6.5/T6.5） -->
      <div
        v-if="state.truncated"
        class="border-b border-warning/30 bg-warning-soft px-2 py-1 text-[10px] text-warning"
        data-testid="detail-truncated"
      >
        {{ t('panel.detail.truncated') }}
      </div>

      <!-- FR-4: 选区引用 bubble。选中文本后 mouseup 触发，提供引用到当前/新对话。
           absolute 定位在内容区右上（首版不跟随 range，简化定位）。 -->
      <div
        v-if="selectionRange"
        class="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-sm border border-border bg-surface p-1 shadow-md"
        data-testid="detail-selection-bubble"
      >
        <Button
          variant="ghost"
          size="sm"
          data-testid="bubble-inject-current"
          class="h-6 rounded-sm px-2 text-[11px]"
          @mousedown.prevent
          @click="injectSelectionToCurrent"
        >{{ t('panel.detail.injectFileRef') }}</Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid="bubble-inject-new"
          class="h-6 rounded-sm px-2 text-[11px]"
          @mousedown.prevent
          @click="injectSelectionToNew"
        >{{ t('panel.detail.injectToNew') }}</Button>
      </div>

      <!-- ── diff 模式：所有文件类型统一走 DiffView（parseDiff 着色）── -->
      <DiffView
        v-if="state.viewMode === 'diff'"
        :patch="state.content"
        :path="state.path ?? undefined"
        data-testid="detail-diff"
        @line-inject="injectFileRef($event.lineNo, $event.lineNo)"
      />

      <!-- ── preview 模式：按 kind 分发 ── -->
      <template v-else>
        <!-- markdown：复用 MarkdownRenderer（shiki + markdown-it）。
             text-[12px] 约束基础字号——MarkdownRenderer 的 .md-render 无基础 font-size，
             在对话流里靠气泡 text-[13.5px] 拉低；此处不约束会继承浏览器默认 16px 整体偏大。
             统一到 12px 与 DetailPane 其他渲染路径（code/text/diff）一致。 -->
        <MarkdownRenderer
          v-if="state.kind === 'markdown'"
          :content="state.content"
          :session-id="sessionId ?? undefined"
          class="detail-md p-2 text-[12px] leading-[1.5]"
          data-testid="detail-markdown"
        />
        <!-- image：local-file:// 协议直载（main.ts:142 注册，绕过 file.read 的 utf8 损坏） -->
        <div
          v-else-if="state.kind === 'image'"
          class="flex items-center justify-center p-2"
          data-testid="detail-image"
        >
          <img
            v-if="imageUrl"
            :src="imageUrl"
            :alt="fileName"
            class="max-h-full max-w-full object-contain"
            @error="onImageError"
          />
          <!-- 图片加载失败（403 白名单/文件损坏）降级占位 -->
          <div v-else class="flex flex-col items-center gap-1 text-center">
            <ImageIcon class="size-6 text-subtle opacity-50" />
            <p class="text-[11px] text-muted">{{ t('panel.detail.loadFailed') }}</p>
            <p class="font-mono text-[10px] text-subtle opacity-60">{{ state.path }}</p>
          </div>
        </div>
        <!-- code：CodeBlock shiki 高亮 -->
        <div
          v-else-if="state.kind === 'code'"
          class="p-2"
          data-testid="detail-code"
        >
          <CodeBlock :code="state.content" :lang="lang" />
        </div>
        <!-- text（兜底）：纯文本插值 -->
        <pre
          v-else
          class="whitespace-pre-wrap break-all p-2 font-mono text-[12px] leading-[1.5] text-fg/90"
          data-testid="detail-text"
        >{{ state.content }}</pre>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileText, Loader2, AlertCircle, Image as ImageIcon, Copy, Check, Quote } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useDetailPane, type DetailViewMode } from '@/composables/features/useDetailPane'
import { useCopy } from '@/composables/effects/useCopy'
import { useComposerInjectionStore } from '@/stores/composer-injection'
import { extToLang } from '@/composables/logic/file-type'
import { resolvePreviewPath } from '@/lib/path-utils'
import MarkdownRenderer from '@/components/panel/message-stream/MarkdownRenderer.vue'
import CodeBlock from '@/components/panel/detail-renderers/CodeBlock.vue'
import DiffView from '@/components/panel/detail-renderers/DiffView.vue'

const { t } = useI18n()

const { copied, copy } = useCopy()
const composerInjection = useComposerInjectionStore()

/** 内容区 ref（FR-4 选区检测用） */
const contentRef = ref<HTMLElement | null>(null)
/** 当前选区的行范围（FR-4 bubble 显隐驱动）。null=无选区/bubble 隐藏 */
const selectionRange = ref<{ lineStart: number; lineEnd: number } | null>(null)

const props = defineProps<{
  /** widget 订阅的 session 标识（与 SideDrawer sessionId 一致，useDetailPane watch 用） */
  sessionId: string | null
}>()

const { state, toggleView, sessionCwd } = useDetailPane(
  computed(() => props.sessionId),
)

/** 文件名（basename，从 state.path 取） */
const fileName = computed(() => {
  if (!state.value.path) return t('panel.sideDrawer.noFileSelected')
  const parts = state.value.path.split('/')
  return parts[parts.length - 1] ?? state.value.path
})

/** 绝对路径：session cwd + 相对路径；若 path 已是绝对路径则直接使用。 */
const absolutePath = computed(() => {
  const cwd = sessionCwd(props.sessionId)
  if (!cwd || !state.value.path) return ''
  return resolvePreviewPath(cwd, state.value.path).absolute
})

/** shiki 语言名（code 类文件高亮用） */
const lang = computed(() => extToLang(state.value.path ?? ''))

/**
 * 图片加载失败标志（local-file:// 403 白名单/文件损坏时 onerror 置 true，降级占位）。
 * 切文件时重置。
 */
const imageLoadFailed = ref(false)

/**
 * 图片 URL：按路径类型解析为绝对路径后拼成 local-file:// 协议 URL。
 * - main.ts:142 的 protocol.handle('local-file') 拦截，白名单含 homedir()（cwd 通常在其下）
 * - encodeURIComponent 处理中文/空格路径（main.ts:143 decodeURIComponent 还原）
 * - 无 cwd 或加载失败 → null（模板走占位分支）
 */
const imageUrl = computed(() => {
  if (imageLoadFailed.value) return null
  const cwd = sessionCwd(props.sessionId)
  if (!cwd || !state.value.path) return null
  const absPath = resolvePreviewPath(cwd, state.value.path).absolute
  return `local-file:///${encodeURIComponent(absPath)}`
})

/** img onerror：白名单 403 / 文件损坏 → 标记失败降级占位 */
function onImageError(): void {
  imageLoadFailed.value = true
}

// 切文件时重置图片失败标志（新文件应重新尝试加载）
watch(
  () => state.value.path,
  () => {
    imageLoadFailed.value = false
  },
)

function onToggleView(mode: DetailViewMode): void {
  void toggleView(mode)
}

/**
 * 注入当前预览文件的 file chip 到 composer（FR-3 header 按钮）。
 * 无行范围，target=current（当前 session 的 composer）。
 * DiffView 行级点击（FR-5）也经此函数，带 lineStart/lineEnd。
 */
function injectFileRef(lineStart?: number, lineEnd?: number): void {
  if (!state.value.path) return
  composerInjection.requestInjection({
    target: 'current',
    path: state.value.path,
    lineStart,
    lineEnd,
    sessionId: props.sessionId,
  })
}

/**
 * 注入选区到新对话（FR-4 bubble "新对话" 按钮）。
 * target=new：触发 useNewTaskFlow 进 landing 后注入。
 */
function injectSelectionToNew(): void {
  if (!state.value.path || !selectionRange.value) return
  composerInjection.requestInjection({
    target: 'new',
    path: state.value.path,
    lineStart: selectionRange.value.lineStart,
    lineEnd: selectionRange.value.lineEnd,
    sessionId: props.sessionId,
  })
  selectionRange.value = null
}

/**
 * 内容区 mouseup：检测选区，非空且在内容区内时计算行范围显 bubble（FR-4）。
 * 行范围反推：取选中文本首行/末行在 state.content 的行索引近似（首版精度限制见 outOfScope）。
 */
function onContentMouseup(): void {
  // diff 模式 state.content 是 patch 文本，选中行（如 +new line）匹配不到 patch 原始行，
  // 行范围反推失效（review m1）。首版 diff 模式禁用 bubble，仅 preview/code 模式支持。
  if (state.value.viewMode === 'diff') {
    selectionRange.value = null
    return
  }
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    selectionRange.value = null
    return
  }
  // 选区必须在内容区内
  const range = sel.getRangeAt(0)
  if (!contentRef.value || !contentRef.value.contains(range.commonAncestorContainer)) {
    selectionRange.value = null
    return
  }
  const selectedText = sel.toString()
  if (!selectedText.trim()) {
    selectionRange.value = null
    return
  }
  // 行范围近似：选中文本首行在 content 的行号（1-based）
  const lines = state.value.content.split('\n')
  const firstLine = selectedText.split('\n')[0] ?? ''
  const idx = lines.findIndex((l) => l.trim() === firstLine.trim())
  if (idx < 0) {
    selectionRange.value = null
    return
  }
  const lineCount = selectedText.split('\n').length
  selectionRange.value = { lineStart: idx + 1, lineEnd: idx + lineCount }
}

/** bubble 引用到当前对话（FR-4）：用 selectionRange 行范围注入 */
function injectSelectionToCurrent(): void {
  if (!selectionRange.value) return
  injectFileRef(selectionRange.value.lineStart, selectionRange.value.lineEnd)
  selectionRange.value = null
}
</script>
