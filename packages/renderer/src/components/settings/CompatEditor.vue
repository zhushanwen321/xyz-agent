<template>
  <!--
    CompatEditor —— Provider 兼容性配置编辑器。
    v-model 绑定 compat: Record<string, unknown> | undefined；prop `api` 决定显示哪组字段。
    字段定义从 compat-fields.ts SSOT 取，按 essential / advanced 分组渲染。
    单字段渲染抽到 CompatField.vue，本组件只负责分组、折叠、清空等编排。
  -->
  <div class="compat-editor flex flex-col gap-3 py-2">
    <!-- 无字段兜底（理论上不会触发，所有 api 类型都有字段）-->
    <p v-if="!essentialFields.length && !advancedFields.length" class="text-[11px] text-muted">
      {{ t('settings.compat.noEssential') }}
    </p>

    <!-- 关键字段区（essential，始终露出）-->
    <div v-if="essentialFields.length" class="flex flex-col gap-2">
      <span class="text-[11px] font-semibold uppercase tracking-wider text-muted">{{ t('settings.compat.essential') }}</span>
      <CompatField
        v-for="f in essentialFields"
        :key="f.field"
        :meta="f"
        :value="getValue(f.field)"
        @change="setValue"
      />
    </div>

    <!-- 高级字段区（advanced，默认折叠）-->
    <div v-if="advancedFields.length">
      <Button
        variant="ghost"
        class="h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline"
        :aria-expanded="showAdvanced"
        @click="showAdvanced = !showAdvanced"
      >
        <ChevronRight class="size-3 transition-transform" :class="showAdvanced ? 'rotate-90' : ''" />
        {{ showAdvanced ? t('settings.compat.collapseAdvanced') : t('settings.compat.showAdvanced') }}
      </Button>
      <div v-if="showAdvanced" class="mt-2 flex flex-col gap-2">
        <CompatField
          v-for="f in advancedFields"
          :key="f.field"
          :meta="f"
          :value="getValue(f.field)"
          @change="setValue"
        />
      </div>
    </div>

    <!-- 清空按钮 -->
    <Button
      v-if="hasValue"
      variant="ghost"
      class="h-auto p-0 text-[11px] text-danger hover:bg-transparent hover:underline"
      @click="clearAll"
    >
      {{ t('settings.compat.clearAll') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { getCompatFields } from './compat-fields'
import CompatField from './CompatField.vue'

/**
 * props.api: model 的 api 类型（'openai-completions' | 'openai-responses' | 'anthropic-messages'）。
 * props.modelValue: 当前 compat 对象；undefined 表示未配置（所有字段回落默认）。
 */
const props = defineProps<{
  api?: string
  modelValue?: Record<string, unknown>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: Record<string, unknown> | undefined]
}>()

const { t } = useI18n()

// 高级区折叠态：默认收起，避免一次性堆 16 个字段压垮嵌入区。
const showAdvanced = ref(false)

const allFields = computed(() => getCompatFields(props.api))
const essentialFields = computed(() => allFields.value.filter(f => f.group === 'essential'))
const advancedFields = computed(() => allFields.value.filter(f => f.group === 'advanced'))

/** 是否有任意已配置字段（驱动「清除所有」按钮显隐）。 */
const hasValue = computed(() => props.modelValue !== undefined && Object.keys(props.modelValue).length > 0)

function getValue(field: string): unknown {
  return props.modelValue?.[field]
}

/**
 * immutable 更新单个字段。switch/select 写入新值；text 字段（openRouterRouting 等）
 * CompatField 不 emit change，因此不会进这里。
 */
function setValue(field: string, value: unknown): void {
  emit('update:modelValue', { ...props.modelValue, [field]: value })
}

/** 清空 compat：emit undefined。 */
function clearAll(): void {
  emit('update:modelValue', undefined)
}
</script>
