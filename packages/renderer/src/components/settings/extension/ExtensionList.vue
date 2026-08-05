<template>
  <!-- 已安装列表 -->
  <section>
    <div class="mb-2 flex items-center gap-2">
      <h3 class="text-[12px] font-medium text-neutral-fg">{{ t('settings.extension.installedTitle') }}</h3>
      <span class="rounded-sm bg-surface px-1.5 py-0.5 text-[10px] text-neutral-dim">{{ extensions.length }}</span>
    </div>

    <div v-if="!extensions.length" class="py-8 text-center text-[12px] text-neutral-mid">{{ t('settings.extension.noExtensions') }}</div>

    <div v-for="ext in extensions" :key="ext.name" class="flex items-center gap-3 rounded-card bg-card px-3 py-2.5">
      <ExtensionDetail :ext="ext" />
      <ExtensionActions :ext="ext" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { ExtensionItem } from '@xyz-agent/core'
import ExtensionDetail from './ExtensionDetail.vue'
import ExtensionActions from './ExtensionActions.vue'

defineProps<{ extensions: ExtensionItem[] }>()

const { t } = useI18n()
</script>
