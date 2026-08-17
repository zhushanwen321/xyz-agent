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
    **宽度**：w 取 --reka-popper-anchor-width（= composer-box 宽），严格对齐 composer 宽度；
    max-w calc(100vw-16px) 兜底防极窄视口溢出。提示词列 truncate 在固定宽度内截断。
    右侧提示词列透传 slash 命令 description（skill 描述等），无则退显 kind 标签。
    无 header 行（去掉「命令 / · xx 项」），列表直接展示，提示列更宽（max-w-[520px]）。

    **v6 视觉范式（B3 问题 14，对齐 demo .cmd-row）**：
    - 行用纯 div（非 Button variant=ghost），避免 button 的 font-medium/ring-offset 噪音
    - 选中态 bg-surface（实色）——D8 特例，不复用 popover-styles.ts 的 SELECTED_ITEM_CLASS（bg-accent-soft）
    - skill 类命令未选中时图标 text-reasoning（紫，demo .cmd-ico.skill）；选中统一 text-accent
    - 命令名 font-semibold（非 mono）+ middot · 分隔符（命令名与描述间）
    - 容器投影走 PopoverContent 默认 shadow-2（demo .cmd-pop box-shadow）
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
      class="w-[var(--reka-popper-anchor-width)] max-w-[calc(100vw-16px)] overflow-hidden p-0"
      @open-auto-focus.prevent
    >
      <!-- list · 行用纯 div（对齐 demo .cmd-row：避免 Button variant=ghost 的 font-medium/ring-offset 噪音）。
           选中态 bg-surface（实色）是 D8 特例——不复用 popover-styles.ts 的 SELECTED_ITEM_CLASS
           （该 class 是 bg-accent-soft，供 ModelSelect/ThinkingLevel 用）；CommandPopover 按 D8 用实色。 -->
      <div class="max-h-[180px] overflow-y-auto py-1">
        <div
          v-for="(item, i) in items"
          :key="item.id"
          class="cmd-row flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] leading-[1.4] transition-colors"
          :class="i === activeIndex ? 'bg-surface text-accent' : 'text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg'"
          @click="onSelect(item)"
          @mouseenter="activeIndex = i"
        >
          <component
            :is="iconFor(item)"
            :class="['size-[15px] shrink-0', iconClass(item, i === activeIndex)]"
          />
          <!-- file 类型：两行（basename 主 + 父目录路径暗色小字），区分同名文件 + 知道文件位置。
               file basename 保留 font-mono（路径/文件名等宽对齐是常见范式，与 slash 命令名 sans 区分）。 -->
          <div v-if="props.type === 'file'" class="min-w-0 flex-1">
            <div class="truncate font-mono text-[12px]" :class="i === activeIndex ? 'text-accent' : 'text-neutral-fg'">{{ item.name }}</div>
            <div v-if="item.dirPath" class="truncate font-mono text-[10px] leading-tight text-neutral-dim">{{ item.dirPath }}</div>
          </div>
          <!-- slash 类型：单行（命令名加粗 sans + middot + description/kind 提示词）。
               skill 只显名字（icon+紫色已传达类型，/skill: 前缀对用户冗余）；
               普通 slash 保留 / 前缀（命令调用语义）。item.name 是完整路由名（含前缀），
               item.displayName 是显示名（skill 去前缀）——onSelect 传 name 保证路由正确。
               middot · 与 demo .cmd-mid 对齐（命令名与描述间的视觉分隔）。 -->
          <template v-else>
            <span class="shrink-0 font-semibold" :class="i === activeIndex ? 'text-accent' : 'text-neutral-fg'">{{ item.displayName ?? item.name }}</span>
            <span v-if="item.description" class="shrink-0 text-neutral-faint">·</span>
            <span v-if="item.description" class="ml-auto shrink-0 truncate max-w-[520px] text-neutral-dim">{{ item.description }}</span>
            <span v-else class="ml-auto shrink-0 text-[10px] text-neutral-dim">{{ item.kind }}</span>
          </template>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { iconKeyForCommand, type RawCommand } from '@xyz-agent/core'
import { SLASH_COMMAND_SOURCE_KEY } from './command-popover-source'
import { useFileSearch } from '@/composables/features/search/useFileSearch'
import { isInternalSkillName, isInternalSlashName } from '@/lib/internal-command-filter'
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents'
import { toFileCandidates, filterAndSortFileCandidates } from '@xyz-agent/core'
import type { SkillInfo } from '@xyz-agent/shared'

type CmdType = 'file' | 'slash'

type ComposerVariant = 'panel' | 'landing'

const props = defineProps<{
  open: boolean
  type: CmdType
  /** session 通道订阅键（D8：session.commands 带 sessionId，走 events.on(sessionId)） */
  sessionId?: string
  /** composer 形态：landing（新建任务空态）vs panel（对话态）。ADR-0050：slash 命令源按 variant 分支。
   *  landing 合并 globalSkills + projectSkills；panel 用 commandStore + compact。默认 'panel'。 */
  variant?: ComposerVariant
  /** 过滤 query（输入区 / 或 # 后的内容，空串/缺省=不过滤；file 按 name+path 过滤，slash 按命令名过滤） */
  query?: string
  /** landing 态全局 skill（useGlobalSkills → skillRegistry globalCache，W4 FR-5）。默认空。 */
  globalSkills?: SkillInfo[]
  /** landing 态当前 cwd 的项目 skill（useProjectSkills 按 cwd key 缓存，W3 ADR-0051）。默认空。 */
  projectSkills?: SkillInfo[]
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

const { t } = useI18n()
const commandStore = useCommandStore()
const { load: loadFileCandidates } = useFileSearch()

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

/** composer 形态归一化（默认 panel，兼容未透传 variant 的旧调用） */
const variant = computed<ComposerVariant>(() => props.variant ?? 'panel')

/** slash 命令源（W3 收编后：merged 源 = registry 声明 ∪ commandStore pi 真源，ADR-0050 按 variant 分支）。
 * landing：merged（无 session 真源时声明即显示——slice TC2）+ globalSkills ∪ projectSkills 合并。
 * panel：compact + merged（pi 真源存在性交叉校验）。
 * __ 前缀命令过滤（W5 内部命令不可见）；无注入源（独立使用/测试）时降级 pi-only（现状行为兼容）。 */
const slashSource = inject(SLASH_COMMAND_SOURCE_KEY, null)
const slashCommands = computed(() => {
  const piCmds = props.sessionId ? commandStore.getCommands(props.sessionId) : []
  // merged：registry 声明 ∪ pi 真源（resolveSlashCommands 纯函数，壳注入；无注入时退化 pi 真源）
  const merged = slashSource ? slashSource.resolveSlashCommands(piCmds) : piCmds
  if (variant.value === 'landing') {
    const extCmds = merged
    const seen = new Set<string>()
    extCmds.forEach((c) => seen.add(normalizedSlashName(c.name)))
    // SkillInfo[] → slash 项（/skill:<name> 归一化），跳过 seen 同名 + __ 前缀
    const mapSkillInfo = (skills: SkillInfo[]) =>
      skills
        .filter((s) => !isInternalSkillName(s.name))
        .filter((s) => !seen.has(`/skill:${s.name}`))
        .map((s) => {
          seen.add(`/skill:${s.name}`)
          return {
            id: `skill-${s.name}`,
            name: `/skill:${s.name}`,
            kind: 'skill',
            icon: 'star',
            description: s.description,
          }
        })
    // 优先级：merged 源已在 seen，全局次之（globalSkills），项目最后（projectSkills 补独有项）
    const globalSkillCmds = mapSkillInfo(props.globalSkills ?? [])
    const projectSkillCmds = mapSkillInfo(props.projectSkills ?? [])
    return [...extCmds, ...globalSkillCmds, ...projectSkillCmds]
  }
  // panel 态：compact + merged（pi 真源存在性交叉校验），不并入 globalSkills
  const compactCmd = { id: 'compact', name: 'compact', kind: 'builtin', icon: 'compact', description: t('panel.command.compactDesc') }
  return [compactCmd, ...merged.filter((c) => !isInternalSlashName(c.name))]
})

/** 订阅 session.commands（D8 走 session 通道）→ 写 commandStore（跨组件重建持久化）。重订归 useSessionEvents。 */
const onMessage = useSessionEvents(toRef(props, 'sessionId'))
onMessage('session.commands', (msg) => {
  const cmds = msg.payload.commands as RawCommand[]
  const sid = props.sessionId
  if (sid) commandStore.applyCommands(sid, cmds)
})

/** 统一候选项视图（file/slash 两路归一为 { id, name, kind, icon, isSkill, description? }） */
const items = computed(() => {
  if (props.type === 'file') {
    const fq = (props.query ?? '').trim()
    const sorted = filterAndSortFileCandidates(fileCandidates.value, fq)
    return sorted.map((f) => {
      // dirPath：path 去 basename 段的父目录（供第二行展示）；根目录文件 → ''
      const path = f.path ?? ''
      const slashIdx = path.lastIndexOf('/')
      const dirPath = slashIdx >= 0 ? path.slice(0, slashIdx + 1) : ''
      return {
        id: f.id,
        name: f.name,
        displayName: f.name,
        kind: f.kind,
        icon: f.kind === '目录' ? 'folder' : 'file',
        isSkill: false,
        description: undefined,
        dirPath,
      }
    })
  }
  const all = slashCommands.value
  const q = (props.query ?? '').trim().toLowerCase()
  const filtered = q ? all.filter((c) => normalizedSlashName(c.name).toLowerCase().includes(q)) : all
  return filtered.map((c) => {
    // 归一化补 / 前缀：pi 返回无前缀（如 'goal'），显示/chip/pi 路由都需 / 前缀
    const name = normalizedSlashName(c.name)
    return {
      id: c.id,
      name,
      // skill 去 /skill: 前缀显名（icon 已表示类型）；displayName 仅用于模板，onSelect 传完整 name
      displayName: c.kind === 'skill' ? skillDisplayName(c.name) : name,
      kind: c.kind,
      // 声明侧无 icon（schema v2 无 icon 字段）——iconKeyForCommand 按 name/source 推断（builtin 命中 / skill→star / extension→terminal）
      icon: c.icon ?? iconKeyForCommand(c.name, c.kind),
      isSkill: c.kind === 'skill' || name.startsWith('/skill:'),
      description: c.description,
      dirPath: undefined,
    }
  })
})

/** slash 名归一化：补 / 前缀（pi 返回 'goal' → '/goal'，含路由前缀供 onSelect → pi 路由）。 */
function normalizedSlashName(name: string): string {
  return name.startsWith('/') ? name : `/${name}`
}

/** skill 显示名：剥离 /skill: 或 / 前缀，只留 skill 名（icon 已表示类型）。 */
function skillDisplayName(name: string): string {
  if (name.startsWith('/skill:')) return name.slice('/skill:'.length)
  if (name.startsWith('/')) return name.slice(1)
  return name
}

const ICONS = SLASH_ICON_COMPONENTS
function iconFor(item: { icon: string }) {
  return ICONS[item.icon] ?? ICONS.file
}

/** 图标色 class：选中→text-accent；未选中 skill→text-reasoning；其他→text-neutral-dim */
function iconClass(item: { isSkill?: boolean }, isSelected: boolean): string {
  if (isSelected) return 'text-accent'
  return item.isSkill ? 'text-reasoning' : 'text-neutral-dim'
}

function onSelect(item: { name: string; icon?: string; description?: string }): void {
  emit('select', { type: props.type, name: item.name, icon: item.icon, description: item.description })
}

/** ComposerInput keydown 路由：浮层 open 时处理 ↑↓ ⏎ Esc，返回 true 表示已消费。
 * 幂等守卫 defaultPrevented：window capture 与 contenteditable 冒泡两条入口命中同一事件，
 * 不守卫 ↑↓ 会跳两项。① preventDefault，② 见 defaultPrevented 直接 return。 */
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

/** window keydown capture 监听：键盘导航唯一入口，先于组件 keydown 保证稳定命中。 */
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
