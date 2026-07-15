<template>
  <!--
    已附上下文 chip 行（draft-composer-states §2f）。
    输入区上方：每条已附上下文（@ 引用 / # 文件 / 图片）一个小徽章，每条都带直接删除按钮。
    真实数据源：runtime 未提供「已附上下文」推送，items 暂为空 → 整行 v-if 自隐藏，不渲染假数据。
  -->
  <div v-if="items.length" class="flex flex-wrap items-center gap-1.5 overflow-hidden px-3.5 pt-[7px]">
    <span
      v-for="item in items"
      :key="item.id"
      class="group inline-flex max-w-[180px] shrink-0 items-center gap-1 rounded-sm bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted"
      :class="item.type === 'image' ? 'text-reasoning' : ''"
    >
      <component :is="iconFor(item)" class="size-3 shrink-0" :class="item.type === 'image' ? 'text-reasoning' : 'text-subtle'" />
      <span class="truncate">{{ item.name }}</span>
      <Button
        variant="ghost"
        class="ml-0.5 grid size-4 shrink-0 place-items-center rounded-sm p-0 text-subtle transition-colors hover:bg-danger-soft hover:text-danger"
        :title="t('panel.contextChips.removeFromContext')"
        @click.stop="onRemove(item.id)"
      >
        <X class="size-3" />
      </Button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { markRaw, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileText, Image as ImageIcon, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'

/** 单条已附上下文（runtime 接入后由真实 store/props 驱动） */
interface AttachedContextItem {
  id: string
  name: string
  type: '@' | '#' | 'image'
}

/**
 * 已附上下文列表。runtime 未提供数据源前为空数组 → 整行 v-if="items.length" 自隐藏。
 * 接入点：runtime 下发已附上下文后，改为由 store/props 填充。
 */
const { t } = useI18n()
const items = ref<AttachedContextItem[]>([])

function iconFor(item: AttachedContextItem) {
  return item.type === 'image' ? markRaw(ImageIcon) : markRaw(FileText)
}

/** 移除某条已附上下文（runtime 接入后对接真实移除） */
function onRemove(id: string): void {
  void id
  // TODO: 对接 runtime 上下文移除
}
</script>
