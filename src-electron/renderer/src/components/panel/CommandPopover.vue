<template>
  <!--
    命令浮层（draft-composer-states §2d：@ 引用 / # 文件 / / 命令 三路共享容器）。
    由 Composer 受控打开（v-model:open）。用 reka-ui Popover portal 到 body，
    不受 composer-box 父容器 overflow/stacking context 限制（修复 D5 定位 bug）。
    **anchor 是 slot 传入的 composer-box**：composer-box 内任何 focus 都算 inside，
    不触发 onFocusOutside dismiss（修复 focus-outside 误关 bug）。
    键盘事件（↑↓ ⏎ Esc）由 Composer 在 ComposerInput keydown 时调 handleKeydown 路由进来。
    **@open-auto-focus.prevent**：禁掉 reka-ui PopoverContent 的 FocusScope 自动聚焦——
    否则浮层打开会把焦点抢到首个命令按钮，contenteditable 不再收键，导致
    「敲 / 后无法继续输入做实时筛选」（query 实时过滤依赖焦点留在输入区）。
    键盘导航走 window capture 监听，与焦点位置无关，故禁自动聚焦不影响 ↑↓⏎Esc。
    **宽度**：min-w 取 --reka-popper-anchor-width（= composer-box 宽），覆盖 composer；
    右侧提示词列透传 slash 命令 description（skill 描述等），无则退显 kind 标签。
    无 header 行（去掉「命令 / · xx 项」），列表直接展示，提示列更宽（max-w-[520px]）。
  -->
  <Popover v-model:open="controlledOpen">
    <!-- anchor：composer-box 本身（由调用方通过 slot 传入），DOM contains 成立 →
         composer-box 内任何 focus 都算 inside，不触发 onFocusOutside dismiss -->
    <PopoverAnchor as-child>
      <slot />
    </PopoverAnchor>
    <PopoverContent
      v-if="open && items.length > 0"
      side="top"
      align="start"
      :side-offset="6"
      :collision-padding="8"
      class="min-w-[var(--reka-popper-anchor-width)] max-w-[820px] overflow-hidden p-0"
      @open-auto-focus.prevent
    >
      <!-- list -->
      <div class="max-h-[180px] overflow-y-auto py-1">
        <Button
          v-for="(item, i) in items"
          :key="item.id"
          variant="ghost"
          class="flex w-full items-center gap-2 rounded-none px-2.5 py-1.5 text-left text-[12px] leading-[1.4] transition-colors"
          :class="i === activeIndex ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-fg'"
          @click="onSelect(item)"
          @mouseenter="activeIndex = i"
        >
          <component
            :is="iconFor(item)"
            class="size-[15px] shrink-0"
            :class="i === activeIndex ? 'text-accent' : 'text-subtle'"
          />
          <!-- file 类型：两行（basename 主 + 父目录路径暗色小字），区分同名文件 + 知道文件位置 -->
          <div v-if="props.type === 'file'" class="min-w-0 flex-1">
            <div class="truncate font-mono text-[12px]" :class="i === activeIndex ? 'text-accent' : 'text-fg'">{{ item.name }}</div>
            <div v-if="item.dirPath" class="truncate font-mono text-[10px] leading-tight text-subtle">{{ item.dirPath }}</div>
          </div>
          <!-- slash 类型：保持单行（命令名 + 右侧 description/kind 提示词） -->
          <template v-else>
            <span class="shrink-0 font-mono" :class="i === activeIndex ? 'text-accent' : 'text-fg'">{{ item.name }}</span>
            <span v-if="item.description" class="ml-auto shrink-0 truncate max-w-[520px] text-subtle">{{ item.description }}</span>
            <span v-else class="ml-auto shrink-0 font-mono text-[10px] text-subtle">{{ item.kind }}</span>
          </template>
        </Button>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons'
import { useCommandStore, type RawCommand } from '@/stores/command'
import { useSettingsStore } from '@/stores/settings'
import { useFileSearch } from '@/composables/features/useFileSearch'
import { useSessionEvents } from '@/composables/features/useSessionEvents'
import { toFileCandidates } from '@/lib/file-candidates'
import { filterAndSortFileCandidates } from '@/lib/file-match'

type CmdType = 'file' | 'slash'

const props = defineProps<{
  open: boolean
  type: CmdType
  /** session 通道订阅键（D8：session.commands 带 sessionId，走 events.on(sessionId)） */
  sessionId?: string
  /** 过滤 query（输入区 / 或 # 后的内容，空串/缺省=不过滤；file 按 name+path 过滤，slash 按命令名过滤） */
  query?: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [payload: { type: CmdType; name: string; icon?: string; description?: string }]
}>()

/** 受控 open：双向同步 props.open ↔ emit update:open */
const controlledOpen = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v),
})

const activeIndex = ref(0)

const commandStore = useCommandStore()
const settingsStore = useSettingsStore()
const { load: loadFileCandidates } = useFileSearch()

// slash 命令：从 commandStore 读取（session-scoped，组件 v-if 重建不丢数据）。
// # 文件候选：经 useFileSearch（session 级缓存）拉 file.search 结果 → toFileCandidates 映射。
const fileCandidates = ref<ReturnType<typeof toFileCandidates>>([])

// 异步加载 # 文件候选（session 级缓存命中则不重拉；无 session 时不加载）
let loaded = false
async function loadCandidates(): Promise<void> {
  if (loaded) return
  loaded = true
  if (!props.sessionId) return // landing 态无 cwd，不加载文件候选
  const nodes = await loadFileCandidates(props.sessionId)
  fileCandidates.value = toFileCandidates(nodes)
}
onMounted(() => { void loadCandidates() })
// sessionId 变化时重新加载（切 session，loaded 复位触发重拉新 session 缓存）
watch(() => props.sessionId, () => { loaded = false; void loadCandidates() })

/**
 * slash 命令源（双源，按 session 有无切换）：
 * - session 态：commandStore（pi get_commands 真实命令，含 builtin/extension）。
 * - landing 态（无 session）：settingsStore.skills（config.skills 全局扫描结果）。
 *   landing 无 pi 子进程，get_commands 不可达；skills 扫描目录集（discovery.json +
 *   强制目录）与 pi 实际加载目录集同源，create session 后 fetchAndBroadcastCommands
 *   刷新 commandStore，切回 session 源时失效 skill 自然消失。
 *   builtin/extension 命令（/compact 等）在 landing 无意义，故不含。
 *
 * SkillInfo.name（无 / 前缀，如 "code-review"）→ 补 "/" 前缀（如 "/code-review"），
 *   与 runtime get_commands 返回格式对齐——chip label 显示与 draft 检测（如 /compact）
 *   都依赖 / 前缀。icon 统一 'star'（与 iconKeyForSource('skill')='star' 一致）。
 */
const slashCommands = computed(() => {
  if (props.sessionId) return commandStore.getCommands(props.sessionId)
  return settingsStore.skills.map((s) => ({
    id: s.name,
    name: `/${s.name}`,
    kind: 'skill',
    icon: 'star',
    description: s.description,
  }))
})

/**
 * 订阅 session.commands（D8：走 session 通道，非 onGlobalType）。
 * 收到后写入 commandStore（持久化，跨组件重建）而非局部 ref。
 * sessionId 变化时重订（Composer 切 session）。
 *
 * 订阅编排（重订 / 退订）归 useSessionEvents（features 层），本组件只声明 type + handler。
 */
const onMessage = useSessionEvents(toRef(props, 'sessionId'))
onMessage('session.commands', (msg) => {
  // 单 type handler：msg 已收窄为 ServerMessage<'session.commands'>，payload.commands 精确可用
  const cmds = msg.payload.commands as RawCommand[]
  const sid = props.sessionId
  if (sid) commandStore.applyCommands(sid, cmds)
})

/** 统一候选项视图（file/slash 两路归一为 { id, name, kind, icon, description? }） */
const items = computed(() => {
  if (props.type === 'file') {
    // file 路径：filterAndSortFileCandidates 按匹配度分级排序（basename 前缀 > path 子串）+
    // 文件优先 + 路径浅优先。无 query 走全量（次级排序）。
    const fq = (props.query ?? '').trim()
    const sorted = filterAndSortFileCandidates(fileCandidates.value, fq)
    return sorted.map((f) => {
      // dirPath：path 去掉 basename 段的父目录路径（供两行展示第二行）。
      // 'src/auth/token.ts' → 'src/auth/'；'AGENTS.md'（根目录）→ ''（不显第二行）
      const path = f.path ?? ''
      const slashIdx = path.lastIndexOf('/')
      const dirPath = slashIdx >= 0 ? path.slice(0, slashIdx + 1) : ''
      return {
        id: f.id,
        name: f.name,
        kind: f.kind,
        icon: f.kind === '目录' ? 'folder' : 'file',
        description: undefined,
        dirPath,
      }
    })
  }
  const all = slashCommands.value
  // slash 路径按 query 过滤（命令名子串匹配）
  const q = (props.query ?? '').trim().toLowerCase()
  const filtered = q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all
  return filtered.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    icon: c.icon,
    description: c.description,
    dirPath: undefined,
  }))
})

/** icon 字段 → lucide 组件（slash chip 复用同一映射，保证选择框/内联 chip 图标一致） */
const ICONS = SLASH_ICON_COMPONENTS
function iconFor(item: { icon: string }) {
  return ICONS[item.icon as keyof typeof ICONS] ?? ICONS.file
}

function onSelect(item: { name: string; icon?: string; description?: string }): void {
  emit('select', { type: props.type, name: item.name, icon: item.icon, description: item.description })
}

/**
 * Composer 在 ComposerInput keydown 时调用：浮层 open 则处理 ↑↓ ⏎ Esc。
 * 返回 true 表示已消费（Composer 不再走发送逻辑）。
 *
 * 幂等守卫（defaultPrevented）：浮层 open 时键盘导航有两条入口都会触达本函数——
 *   ① window capture（onWindowKeydown，目标阶段前先到）
 *   ② 事件冒泡到 contenteditable → Composer.onKeydown → 本函数
 * 焦点留在输入区时两条都命中同一个 KeyboardEvent，若不守卫 ↑↓ 会增减两次（跳两项）。
 * 用 e.defaultPrevented 做幂等闸：① 先 preventDefault，② 看到 defaultPrevented 直接 return false。
 */
function handleKeydown(e: KeyboardEvent): boolean {
  if (!props.open) return false
  if (e.defaultPrevented) return false // 幂等守卫：① 已消费则 ② 不再重复处理
  const list = items.value
  if (list.length === 0) return false
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % list.length
    return true
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + list.length) % list.length
    return true
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    onSelect(list[activeIndex.value])
    return true
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    controlledOpen.value = false
    return true
  }
  return false
}

/**
 * window keydown 监听（capture 阶段）：键盘导航的唯一入口。
 * capture 在目标阶段前触发，先于任何组件的 keydown，保证浮层 open 时
 * 方向键/Enter/Esc/Tab 稳定命中（不依赖焦点在哪、不依赖 PopoverContent 透传 keydown）。
 */
function onWindowKeydown(e: KeyboardEvent): void {
  if (!props.open) return
  handleKeydown(e)
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onWindowKeydown, true)
  onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown, true))
}

// 浮层打开时重置高亮到第一项；type 切换也重置
watch(
  () => [props.open, props.type, props.query],
  () => {
    activeIndex.value = 0
  },
)

defineExpose({ handleKeydown })
</script>
