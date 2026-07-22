<template>
  <!--
    展示组件 · 命令/skill 文档（drawer Doc tab 内容）。
    数据源：
    - SessionCommand（commandStore，按 sessionId + selectedCommandName 查）：name/source/icon/description
    - SKILL.md content（file.read RPC 读 sourceInfo.path，W2 透传）：skill 命令渲染完整文档
    skill 路径优先用 command.sourceInfo.path（W2 透传，含项目级 skill）；
    /skill:xxx 格式无 sourceInfo 时兜底从 settings.skills 查 sourcePath。
    非 skill 命令（extension/builtin）：仅有 description，退化为信息卡。
    selectedCommandName 由 useSideDrawer 单例持有（用户气泡 slash chip 点击时设置）。
  -->
  <section v-if="command" class="flex h-full flex-col">
    <!-- 元信息头：icon + 命令名 + source 标签 + skill 命令的 sourcePath -->
    <header class="flex items-center gap-2 border-b border-border px-3 py-2.5">
      <component :is="iconComponent" class="size-4 shrink-0 text-reasoning" />
      <span class="font-mono text-[13px] font-medium text-fg">{{ command.name }}</span>
      <span class="ml-auto rounded-sm bg-surface-hover px-1.5 py-0.5 text-[10px] text-muted">{{ sourceLabel }}</span>
    </header>
    <!-- 文档体：skill 命令渲染完整 SKILL.md；非 skill 渲染 description 信息卡 -->
    <div class="min-h-0 flex-1 overflow-auto p-3">
      <template v-if="skill">
        <!-- skill 完整文档（SKILL.md 经 markdown 渲染） -->
        <div v-if="skill.description" class="mb-3 text-[13px] text-muted">{{ skill.description }}</div>
        <MarkdownRenderer v-if="skill.content" :content="skill.content" :session-id="sessionId ?? undefined" />
        <div v-else class="py-6 text-center text-[12px] text-subtle">{{ t('panel.command.noDocBody') }}</div>
        <!-- skill 元信息：sourcePath / tools / triggers -->
        <div v-if="skill.sourcePath" class="mt-4 border-t border-border pt-3">
          <p class="text-[11px] text-subtle">{{ t('panel.command.path') }}</p>
          <p class="mt-0.5 break-all font-mono text-[11px] text-muted">{{ skill.sourcePath }}</p>
        </div>
      </template>
      <!-- 非 skill 命令：信息卡 -->
      <div v-else class="flex h-full flex-col items-start gap-2 py-2">
        <p v-if="command.description" class="text-[13px] leading-[1.6] text-fg">{{ command.description }}</p>
        <p v-else class="text-[12px] text-subtle">{{ t('panel.command.noDescription') }}</p>
        <p class="mt-1 text-[11px] text-subtle">
          {{ command.kind === 'extension' ? t('panel.command.commandType') : command.kind === 'builtin' ? t('panel.command.builtinCommand') : t('panel.command.title') }}，
          {{ t('panel.command.noFullDoc') }}。
        </p>
      </div>
    </div>
  </section>
  <!-- 无选中命令 → 空态（SideDrawer v-else 兜底，此处理论上不达，但防御性保留） -->
  <div v-else class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
    <p class="text-[12px] text-subtle">{{ t('panel.sideDrawer.noDoc') }}</p>
    <p class="text-[11px] text-subtle opacity-50">{{ t('panel.sideDrawer.docHint') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Wrench } from '@lucide/vue'
import type { Component } from 'vue'
import { useCommandStore } from '@/stores/command'
import { useSettingsStore } from '@/stores/settings'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons'
import * as fileApi from '@/api/domains/file'
import MarkdownRenderer from './message-stream/MarkdownRenderer.vue'

const { t } = useI18n()

const props = defineProps<{
  /** drawer 所属 panel 的 session（查 commandStore + file.read cwd 守门用） */
  sessionId: string | null
}>()

const commandStore = useCommandStore()
const settings = useSettingsStore()
const { selectedCommandName } = useSideDrawer()

/** 当前选中的 SessionCommand（从 commandStore 查） */
const command = computed(() => {
  const name = selectedCommandName.value
  const sid = props.sessionId
  if (!name || !sid) return null
  // 如果是 /skill:xxx 格式，构造虚拟命令对象（无 sourceInfo，走 settings.skills 兜底）
  if (name.startsWith('/skill:')) {
    const skillName = name.replace('/skill:', '')
    return {
      name: `/${skillName}`,
      kind: 'skill' as const,
      icon: 'star',
      description: undefined,
      sourceInfo: undefined,
    }
  }
  return commandStore.findCommandByName(sid, name) ?? null
})

/**
 * skill 命令判定 + SKILL.md 路径来源：
 * - source=skill 且 command.sourceInfo.path 存在 → 直接用（W2 透传，主路径）
 * - /skill:xxx 格式无 sourceInfo → 兜底从 settings.skills 查 sourcePath（向后兼容）
 * 非 skill 命令返回 null → 走信息卡分支。
 */
const skillPath = computed<string | null>(() => {
  const cmd = command.value
  if (!cmd || cmd.kind !== 'skill') return null
  // 优先用 pi 透传的 sourceInfo.path（含项目级 skill，解决 cwd 错位扫不到的问题）
  if (cmd.sourceInfo?.path) return cmd.sourceInfo.path
  // /skill:xxx 兜底：从 settings.skills 查（旧路径，sourceInfo 不可用时降级）
  const name = selectedCommandName.value
  if (name?.startsWith('/skill:')) {
    const skillName = name.replace('/skill:', '')
    return settings.skills.find((s) => s.name === skillName)?.sourcePath ?? null
  }
  const bareName = cmd.name.replace(/^\//, '')
  return settings.skills.find((s) => s.name === bareName)?.sourcePath ?? null
})

/** skill 描述：/skill:xxx 从 settings.skills 查，其余用 command.description */
const skillDescription = computed<string | undefined>(() => {
  const name = selectedCommandName.value
  if (name?.startsWith('/skill:')) {
    const skillName = name.replace('/skill:', '')
    return settings.skills.find((s) => s.name === skillName)?.description
  }
  return command.value?.description
})

/** skill content（异步从 SKILL.md 加载）。null = 未加载/加载失败。 */
const skillContent = ref<string | null>(null)
/** 防重入标记：避免 watch 多次触发时并发发请求（竞态导致旧请求覆盖新结果） */
let loadingPath: string | null = null

/**
 * 读 SKILL.md：先带 sessionId 走 cwd 守门（项目级 skill 在 cwd 下），
 * 失败（out_of_cwd）再不带 sessionId 走白名单（全局 skill 如 ~/.agents/skills）。
 * 两条守门都不绕过，任一通过即读到。
 */
async function loadSkillContent(path: string): Promise<void> {
  if (!path || loadingPath === path) {
    if (!path) skillContent.value = null
    return
  }
  loadingPath = path
  try {
    const sid = props.sessionId ?? undefined
    const result = sid
      ? await fileApi.read(path, sid).catch(() => fileApi.read(path))
      : await fileApi.read(path)
    // 防竞态：异步期间用户已切到别的命令，丢弃本次结果
    if (loadingPath === path) skillContent.value = result.content
  } catch {
    // 两路守门均拒绝（路径既不在 cwd 下也不在白名单）→ 退化为无文档体
    if (loadingPath === path) skillContent.value = null
  } finally {
    if (loadingPath === path) loadingPath = null
  }
}

// skillPath 变化（切换命令）重新加载 SKILL.md
watch(
  skillPath,
  (path) => {
    if (path) void loadSkillContent(path)
    else skillContent.value = null
  },
  { immediate: true },
)

/** skill 渲染对象（合并 sourcePath / content / description 供模板用） */
const skill = computed(() => {
  if (!skillPath.value) return null
  return {
    sourcePath: skillPath.value,
    content: skillContent.value,
    description: skillDescription.value,
  }
})

/** source 标签：skill→「Skill」、extension→「Extension」、builtin→「内置」 */
const sourceLabel = computed(() => {
  const kind = command.value?.kind
  if (kind === 'skill') return 'Skill'
  if (kind === 'extension') return 'Extension'
  if (kind === 'builtin') return t('panel.command.builtin')
  return kind ?? ''
})

/** chip/命令 icon → lucide 组件（复用 SLASH_ICON_COMPONENTS，与选择框/chip 同源） */
const iconComponent = computed<Component>(() => {
  const iconKey = command.value?.icon
  return (
    (iconKey ? SLASH_ICON_COMPONENTS[iconKey as keyof typeof SLASH_ICON_COMPONENTS] : undefined) ??
    Wrench
  )
})
</script>
