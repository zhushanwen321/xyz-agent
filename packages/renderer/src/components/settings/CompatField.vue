<template>
  <!--
    CompatField —— compat 单字段渲染（switch / select / text 三种 type）。
    从 CompatEditor 抽出，保证父组件 template 不超 400 行。
    纯展示 + 受控 emit，状态由父组件管理。
  -->
  <div class="flex flex-col gap-0.5">
    <!-- switch 字段 -->
    <div v-if="meta.type === 'switch'" class="flex items-center justify-between">
      <Label class="text-[12px] text-fg">{{ t(meta.labelKey) }}</Label>
      <Switch
        :model-value="value === true"
        :aria-label="t(meta.labelKey)"
        @update:model-value="$emit('change', meta.field, $event)"
      />
    </div>
    <!-- select 字段 -->
    <div v-else-if="meta.type === 'select'" class="flex items-center justify-between gap-3">
      <Label class="min-w-0 flex-1 truncate text-[12px] text-fg">{{ t(meta.labelKey) }}</Label>
      <Select
        :model-value="typeof value === 'string' ? value : undefined"
        @update:model-value="$emit('change', meta.field, $event)"
      >
        <SelectTrigger class="h-7 w-[180px] shrink-0 px-2 text-[11px]">
          <SelectValue :placeholder="t('settings.compat.unset')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="o in meta.options ?? []"
            :key="o.value"
            :value="o.value"
          >{{ t(`${meta.optionsKeyPrefix ?? 'settings.compat.thinkingFormat.options'}.${o.labelKeySuffix}`) }}</SelectItem>
        </SelectContent>
      </Select>
    </div>
    <!-- text 字段：object 类高级字段（openRouterRouting / vercelGatewayRouting），
         UI 仅提示需手改 json，不提供细粒度编辑。 -->
    <div v-else class="flex items-center justify-between gap-3">
      <Label class="min-w-0 flex-1 truncate text-[12px] text-fg">{{ t(meta.labelKey) }}</Label>
      <span class="shrink-0 text-[10px] text-subtle">{{ t('settings.compat.advancedJsonHint') }}</span>
    </div>
    <!-- hint 注脚 -->
    <p class="text-[10px] text-subtle">{{ t(meta.hintKey) }}</p>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Switch } from '@/components/ui/switch'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import type { CompatFieldMeta } from './compat-fields'

/**
 * props.value 是 compat 对象里该字段的当前值（unknown），由父组件 getValue 透传。
 * emit('change', field, val) —— 父组件做 immutable 更新。
 */
defineProps<{
  meta: CompatFieldMeta
  value: unknown
}>()

defineEmits<{
  change: [field: string, value: unknown]
}>()

const { t } = useI18n()
</script>
