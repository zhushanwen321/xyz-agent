<script setup lang="ts">
/**
 * 内置 Provider 模板选择器（wave 3 · builtin-provider-ui）。
 *
 * Popover 下拉：顶部搜索框按 name/id 模糊过滤，下方渲染匹配的内置 provider 模板，
 * 选中后 emit('select', template) 上抛给父（ProviderPage）驱动 QuickSetup 流程。
 *
 * emit 上抛模式（DM1）：不 inject SETTINGS_CONFIG_API_KEY、不 import @/api。
 * 数据由父经 props.providers 注入（父调 config.listBuiltinProviders），与 ProviderImportMenu 一致。
 *
 * 列表项不用 PopoverActionItem——其内部 <span> 包裹限制多列布局（name+badge+count 横向均分），
 * 改用 Button 自定义（仍 xyz-ui 组件，合规）。trigger 仍用 PopoverTriggerButton（与 ProviderImportMenu 一致）。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Library } from '@lucide/vue'
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
}>()

const { t } = useI18n()

/** Popover 受控开关：选中后立即关闭 */
const open = ref(false)
/** 搜索词（按 name/id 模糊匹配，大小写不敏感） */
const search = ref('')

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
      <Library class="size-3.5" />
      {{ t('settings.provider.builtinTemplate.trigger') }}
    </PopoverTriggerButton>
    <PopoverContent class="w-72 p-0">
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
    </PopoverContent>
  </Popover>
</template>
