<script setup lang="ts">
/**
 * 内置 Provider 模板选择器 + 「添加供应商」入口（wave 3 · builtin-provider-ui，F2/F5）。
 *
 * Popover 两级入口（F2 · design §6.1）：
 *  trigger「+ 添加供应商 ▾」→ 菜单视图（从内置模板（推荐，默认高亮）/ 自定义（手填））
 *  → 点「从内置模板」进入选择器视图（搜索 + provider 列表）；点「自定义」emit('custom')，
 *  父走原 ProviderEditBody 全手填流程（§7：手填流程不替代）。
 *
 * 每次打开 Popover 都重置回菜单视图（入口聚合，选择器是二级）。
 *
 * 列表项不用 PopoverActionItem——其内部 <span> 包裹限制多列布局（name+badge+count 横向均分），
 * 改用 Button 自定义（仍 xyz-ui 组件，合规）。trigger 仍用 PopoverTriggerButton（与 ProviderImportMenu 一致）。
 *
 * F5（design §6.2）：卡片含图标，首期用首字母色块占位。色块颜色用预定义语义 Tailwind 类集合
 * 按 provider id hash 稳定映射（禁止硬编码颜色值，hashed 映射到现有语义色）。
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Library, Pencil, Plus } from '@lucide/vue'
import {
  Popover,
  PopoverContent,
  PopoverTriggerButton,
  Input,
  Button,
} from '@xyz-agent/ui'
import type { BuiltinProviderTemplate } from '@xyz-agent/shared'

const props = defineProps<{ providers: BuiltinProviderTemplate[] }>()

const emit = defineEmits<{
  select: [template: BuiltinProviderTemplate]
  /** 菜单「自定义」条目 → 父走原手填流程（createAndExpand） */
  custom: []
}>()

const { t } = useI18n()

/** Popover 受控开关：选中后立即关闭 */
const open = ref(false)
/** 搜索词（按 name/id 模糊匹配，大小写不敏感） */
const search = ref('')
/** 两级视图：menu（入口菜单）→ picker（模板选择器）。每次打开重置回 menu */
const view = ref<'menu' | 'picker'>('menu')

watch(open, (v) => {
  if (v) {
    view.value = 'menu'
    search.value = ''
  }
})

const filtered = computed<BuiltinProviderTemplate[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.providers
  return props.providers.filter(
    (p) =>
      p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
  )
})

/** authMode 徽章文案（i18n 驱动，避免硬编码重复） */
function authBadge(mode: BuiltinProviderTemplate['authMode']): string {
  return t(`settings.provider.builtinTemplate.authMode.${mode}`)
}

/**
 * F5：首字母色块背景类。预定义语义 Tailwind 色块集合（accent/success/warn/danger/info 五色循环），
 * 按 provider id 字符串 hash 稳定映射——同 id 恒同色，避免硬编码颜色值。
 */
const AVATAR_CLASSES = [
  'bg-accent-soft text-accent',
  'bg-success-soft text-success',
  'bg-warn-soft text-warn',
  'bg-danger-soft text-danger',
  'bg-info-soft text-info',
] as const

/** 字符串 hash 乘数（F5 色块稳定映射用） */
const HASH_MULTIPLIER = 31

function avatarClass(p: BuiltinProviderTemplate): string {
  let h = 0
  for (let i = 0; i < p.id.length; i++) h = (h * HASH_MULTIPLIER + p.id.charCodeAt(i)) >>> 0
  return AVATAR_CLASSES[h % AVATAR_CLASSES.length]
}

/** 首字母（name 缺省回退 id 首字符） */
function avatarChar(p: BuiltinProviderTemplate): string {
  return (p.name || p.id).charAt(0).toUpperCase()
}

/** 菜单：从内置模板 → 选择器视图 */
function onMenuBuiltin(): void {
  view.value = 'picker'
}

/** 菜单：自定义 → 关闭 + emit('custom')，父走原手填流程 */
function onMenuCustom(): void {
  open.value = false
  emit('custom')
}

function onSelect(tpl: BuiltinProviderTemplate): void {
  open.value = false
  emit('select', tpl)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTriggerButton
      data-testid="provider-template-picker"
      :title="t('settings.provider.builtinTemplate.trigger')"
    >
      <Plus class="size-3.5" />
      {{ t('settings.provider.builtinTemplate.trigger') }}
    </PopoverTriggerButton>
    <PopoverContent class="w-72 p-1">
      <!-- 一级：入口菜单（F2 · design §6.1：内置模板（推荐，默认高亮）+ 自定义） -->
      <template v-if="view === 'menu'">
        <Button
          variant="ghost"
          data-testid="add-menu-builtin"
          class="flex h-auto w-full items-center gap-2 rounded-sm bg-surface-2 px-2.5 py-2 text-[13px] text-neutral-fg ring-1 ring-inset ring-accent-ring hover:bg-surface-2"
          @click="onMenuBuiltin"
        >
          <Library class="size-4 shrink-0 text-accent" />
          <span class="flex-1 truncate text-left font-medium">{{ t('settings.provider.builtinTemplate.menuBuiltin') }}</span>
          <span class="shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">{{ t('settings.provider.builtinTemplate.menuRecommended') }}</span>
        </Button>
        <Button
          variant="ghost"
          data-testid="add-menu-custom"
          class="flex h-auto w-full items-center gap-2 rounded-sm px-2.5 py-2 text-[13px] text-neutral-fg hover:bg-surface-hover"
          @click="onMenuCustom"
        >
          <Pencil class="size-4 shrink-0 text-neutral-dim" />
          <span class="flex-1 truncate text-left font-medium">{{ t('settings.provider.builtinTemplate.menuCustom') }}</span>
        </Button>
      </template>

      <!-- 二级：模板选择器（搜索 + 列表，F5 加首字母色块） -->
      <template v-else>
        <div class="border-b border-border p-2">
          <Input
            v-model="search"
            data-testid="provider-template-search"
            :placeholder="t('settings.provider.builtinTemplate.searchPlaceholder')"
            class="h-8"
          />
        </div>
        <div class="max-h-80 overflow-y-auto p-1">
          <Button
            v-for="p in filtered"
            :key="p.id"
            variant="ghost"
            :data-testid="`provider-template-${p.id}`"
            class="h-auto w-full justify-start gap-2 rounded-sm px-2.5 py-1.5 text-[13px] text-neutral-fg hover:bg-surface-hover"
            @click="onSelect(p)"
          >
            <!-- F5：首字母色块（预定义语义色集合 hash 映射） -->
            <span
              class="grid size-6 shrink-0 place-items-center rounded-sm text-[10px] font-semibold"
              :class="avatarClass(p)"
            >{{ avatarChar(p) }}</span>
            <span class="flex w-full items-center gap-2">
              <span class="flex-1 truncate text-left font-medium">{{ p.name }}</span>
              <span
                class="shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent"
              >{{ authBadge(p.authMode) }}</span>
              <span class="shrink-0 text-[11px] text-neutral-dim">
                {{ t('settings.provider.builtinTemplate.modelsSuffix', { count: p.modelCount }) }}
              </span>
            </span>
          </Button>
          <p
            v-if="!filtered.length"
            class="px-2 py-4 text-center text-[12px] text-neutral-mid"
          >
            {{ t('settings.provider.builtinTemplate.noResult') }}
          </p>
        </div>
      </template>
    </PopoverContent>
  </Popover>
</template>
