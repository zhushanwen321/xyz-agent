<!--
  DiffView —— git diff patch 结构化着色渲染（detail-renderers 系列）。

  把 git.getDiff 返回的 unified diff patch 文本（裸 string）解析为 hunks/lines，
  行级着色：+ 行 success 背景（/12）、− 行 danger 背景（/12）、hunk 头 surface 背景 + 行号槽。
  字符级 diff：配对的 del+add 行经 LCS 计算出 segments，差异片段用 /30 背景叠加，
  与行级 /12 形成"双重颜色"层次，单字符变更也能精确定位。

  代码内容经 shiki 整体高亮（每 hunk 拼接代码体一次性 codeToHtml，再按行拆回 +/- 行），
  兼得语法高亮与 diff 语义着色。有 segments 的行跳过 shiki，改用纯文本 segment 渲染
  （牺牲语法高亮换取字符级 diff 精度，与 GitHub PR 内联 diff 行为一致）。

  v-html 受控点：仅 shiki 高亮片段（codeLines）经 v-html 注入，shiki 转义所有非 token 文本，
  XSS 安全（与 MarkdownRenderer/CodeBlock 同论证）。行号、+/- 符号、meta 行、segments 均用文本插值。

  首次 shiki 加载异步：未就绪时降级为纯文本行（无语法高亮，仍有 +/- 语义色）。
-->
<template>
  <div v-if="parsed.hunks.length" class="diff-view font-mono text-[12px] leading-[1.5]">
    <div v-for="(hunk, hi) in parsed.hunks" :key="hi" class="diff-hunk">
      <!-- hunk 头：@@ -a,b +c,d @@ -->
      <div class="diff-hunk-header bg-surface-2 px-2 py-0.5 text-subtle">
        {{ hunk.lines[0]?.content }}
      </div>
      <!-- 行列表 -->
      <div v-for="(line, li) in codeLines(hunk, hi)" :key="li" class="flex" :class="lineRowClass(line)">
        <!-- 行号槽：oldNo / newNo -->
        <span class="w-10 shrink-0 select-none px-1 text-right text-subtle/60">{{ line.oldNo ?? '' }}</span>
        <span class="w-10 shrink-0 select-none px-1 text-right text-subtle/60">{{ line.newNo ?? '' }}</span>
        <!-- +/- 符号槽 -->
        <span class="w-4 shrink-0 select-none text-center" :class="signClass(line)">{{ sign(line) }}</span>
        <!-- 代码内容：shiki 高亮片段 v-html，降级纯文本。
             eslint vue/no-v-html 块级禁用：shiki codeToHtml 转义所有非 token 文本（只发 scoped span），
             输出 XSS 安全，与 MarkdownRenderer/CodeBlock 同论证。 -->
        <!-- eslint-disable vue/no-v-html -->
        <span
          v-if="line.html"
          class="diff-code min-w-0 flex-1 whitespace-pre-wrap break-all"
          :class="line.type === 'context' ? 'text-fg/80' : ''"
          v-html="line.html"
        />
        <!-- eslint-enable vue/no-v-html -->
        <!-- 字符级 diff：配对的 del/add 行有 segments，按 segment 渲染纯文本 + 字符级背景 -->
        <span
          v-else-if="line.segments"
          class="diff-code min-w-0 flex-1 whitespace-pre-wrap break-all"
          :class="textContentClass(line)"
        >
          <span
            v-for="(seg, si) in line.segments"
            :key="si"
            :class="segmentClass(seg.kind, line.type)"
          >{{ seg.text }}</span>
        </span>
        <span v-else class="min-w-0 flex-1 whitespace-pre-wrap break-all" :class="textContentClass(line)">{{ line.content }}</span>
      </div>
    </div>
  </div>
  <!-- 空 patch（无 hunk） -->
  <div v-else class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
    <GitCompare class="size-6 text-subtle opacity-40" />
    <p class="text-[11.5px] text-subtle opacity-55">{{ t('panel.detail.noDiff') }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * diff 着色渲染器。
 * - parseDiff 解析 patch → hunks（纯函数，logic/parseDiff.ts）
 * - 每 hunk 的代码体（context/add/del 行 content）拼接后整体 shiki 高亮，按行拆回
 *   （shiki 单行高亮无上下文效果差且性能差；整体高亮是 diff2html 等标准做法）
 * - 高亮未就绪时降级纯文本（仍有 +/- 语义色背景）
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { GitCompare } from '@lucide/vue'
import { parseDiff, type ParsedDiff, type DiffHunk, type DiffLine, type DiffSegment } from '@/composables/logic/parseDiff'
import { highlightCode } from '@/composables/logic/markdown'
import { extToLang } from '@/composables/logic/file-type'

const { t } = useI18n()

const props = defineProps<{
  /** unified diff patch 文本（git.getDiff 返回） */
  patch: string
  /** 文件路径（用于推断 shiki 语言；从 patch 内 +++ b/xxx 也可，但 path 更可靠） */
  path?: string
}>()

const parsed = ref<ParsedDiff>({ hunks: [] })

/** 扩展 DiffLine：带高亮后的 html（shiki 拆行结果） */
interface RenderedLine extends DiffLine {
  html: string
}

/** 每个 hunk 的渲染行缓存（高亮后），按 hunk 索引存 */
const renderedHunks = ref<RenderedLine[][]>([])

/**
 * 模板取第 hi 个 hunk 的渲染行。
 * 高亮未就绪时 renderedHunks[hi] 为空，模板走 line.html='' 的纯文本降级分支。
 */
function codeLines(hunk: DiffHunk, hi: number): RenderedLine[] {
  const rendered = renderedHunks.value[hi]
  if (rendered && rendered.length === hunk.lines.length) return rendered
  // 降级：未高亮，用原始 line 补 html='' 走纯文本
  return hunk.lines.map((l) => ({ ...l, html: '' }))
}

function sign(line: RenderedLine): string {
  return line.type === 'add' ? '+' : line.type === 'del' ? '−' : line.type === 'meta' ? '' : ''
}
function signClass(line: RenderedLine): string {
  if (line.type === 'add') return 'text-success'
  if (line.type === 'del') return 'text-danger'
  return 'text-subtle/40'
}
function lineRowClass(line: RenderedLine): string {
  if (line.type === 'add') return 'bg-success/12'
  if (line.type === 'del') return 'bg-danger/12'
  if (line.type === 'hunk') return 'bg-surface-2'
  return ''
}
function textContentClass(line: RenderedLine): string {
  if (line.type === 'add') return 'text-success/90'
  if (line.type === 'del') return 'text-danger/90'
  return 'text-fg/80'
}
/**
 * 字符级 diff segment 着色：
 * - add 行的 add 片段：bg-success/30（比行级 /12 更深，叠加后双重颜色显眼）
 * - del 行的 del 片段：bg-danger/30
 * - normal 片段：无额外背景（继承行级背景）
 */
function segmentClass(kind: DiffSegment['kind'], lineType: DiffLine['type']): string {
  if (kind === 'add' && lineType === 'add') return 'bg-success/30'
  if (kind === 'del' && lineType === 'del') return 'bg-danger/30'
  return ''
}

/**
 * 逐 hunk 高亮：把 hunk 内 context/add/del 行的 content 拼成一段代码，
 * shiki codeToHtml 整体高亮，再按 <span class="line"> 拆回各行 html。
 *
 * shiki codeToHtml 默认每行包一个 <span class="line">（lineOptions 之外的行为），
 * 用 DOMParser-free 的字符串拆分：取 <span class="line">...</span> 序列。
 * 简化实现：shiki 产出的每行是独立 <span class="line">，按 \n 拆 codeToHtml 输出不可靠
 * （含跨行 span），改用：对每行单独 codeToHtml 但传相同 lang（牺牲跨行 token，但 +/- 行本就是
 * 代码片段，单行高亮可接受）。最终选「单行 codeToHtml」——简单、可靠、性能可控（千行千次同步调用，
 * shiki 单例建好后纯 CPU 字符串处理，实测可接受）。
 */
async function highlightHunk(hunk: DiffHunk, lang: string): Promise<RenderedLine[]> {
  const out: RenderedLine[] = []
  for (const line of hunk.lines) {
    if (line.type === 'hunk' || line.type === 'meta') {
      out.push({ ...line, html: '' })
      continue
    }
    // 配对的 del/add 行有 segments：跳过 shiki 高亮，模板走字符级 diff 渲染分支
    if (line.segments) {
      out.push({ ...line, html: '' })
      continue
    }
    // context/未配对的 add/del 行：对 content 单行高亮
    const html = line.content ? await highlightCode(line.content, lang) : ''
    out.push({ ...line, html })
  }
  return out
}

watch(
  () => props.patch,
  async (patch) => {
    parsed.value = parseDiff(patch)
    renderedHunks.value = parsed.value.hunks.map(() => [])
    if (!parsed.value.hunks.length) return
    const lang = extToLang(props.path ?? '')
    // 逐 hunk 高亮（串行，避免并发触发多次 shiki 调用栈）
    for (let i = 0; i < parsed.value.hunks.length; i++) {
      renderedHunks.value[i] = await highlightHunk(parsed.value.hunks[i], lang)
    }
  },
  { immediate: true },
)
</script>

<style scoped>
/* shiki 高亮 span 双主题切换（与 CodeBlock/MarkdownRenderer 同机制）。
   Tailwind 无法表达跨 :deep + [data-theme] 的 CSS 变量切换，属 escape hatch。 */
.diff-code :deep(span) {
  color: var(--shiki-dark);
}
:global([data-theme="light"]) .diff-code :deep(span) {
  color: var(--shiki-light);
}
</style>
