<template>
  <!--
    展示组件 · trace-list-item（列表项分发：台账行 / context 分界行）。
    独立组件的原因：virtua <Virtualizer> slot 要求恰好 1 个 vnode（MessageStream M5 教训），
    行 vs 分界的 v-if 分支收在本组件内，Virtualizer 与 v-for 两路径共用。
  -->
  <TraceRowItem
    v-if="item.kind === 'row'"
    :row="item.row"
    :selected="!!selected"
    @select="(row) => emit('select', row)"
    @jump-parent="(row) => emit('jump-parent', row)"
  />
  <!-- context 分界行（demo .tr-divider：info 色两侧渐变线 + 说明文案；contextOnly 态由父级隐藏） -->
  <div
    v-else
    class="flex items-center gap-2.5 px-2 py-2.5 text-[11px] text-info"
    data-testid="trace-context-divider"
  >
    <span aria-hidden="true" class="h-px flex-1 bg-gradient-to-r from-transparent via-info-soft to-transparent" />
    <span>{{ t('panel.trace.divider') }}</span>
    <span aria-hidden="true" class="h-px flex-1 bg-gradient-to-r from-transparent via-info-soft to-transparent" />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { TraceRow } from '@xyz-agent/core/domain/session-trace'
import TraceRowItem from './TraceRowItem.vue'

defineProps<{
  item: { kind: 'row'; row: TraceRow } | { kind: 'divider' }
  selected?: boolean
}>()

const emit = defineEmits<{ select: [row: TraceRow]; 'jump-parent': [row: TraceRow] }>()

const { t } = useI18n()
</script>
