<template>
  <!--
    已附上下文 chip 行（draft-composer-states §2f）。
    输入区上方：每条已附上下文（@ 引用 / # 文件 / 图片）一个小徽章，每条都带直接删除按钮。
    mock 期用 MOCK_ATTACHED_CONTEXT 静态展示；runtime 后由 ComposerInput 的 chip 变更驱动。
  -->
  <div class="flex flex-wrap items-center gap-1.5 overflow-hidden px-3.5 pt-[7px]">
    <span
      v-for="item in MOCK_ATTACHED_CONTEXT"
      :key="item.id"
      class="group inline-flex max-w-[180px] shrink-0 items-center gap-1 rounded-sm bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted"
      :class="item.type === 'image' ? 'text-reasoning' : ''"
    >
      <component :is="iconFor(item)" class="size-3 shrink-0" :class="item.type === 'image' ? 'text-reasoning' : 'text-subtle'" />
      <span class="truncate">{{ item.name }}</span>
      <Button
        variant="ghost"
        class="ml-0.5 grid size-4 shrink-0 place-items-center rounded-sm p-0 text-subtle transition-colors hover:bg-[rgba(239,68,68,0.12)] hover:text-danger"
        title="从上下文移除"
        @click.stop="onRemove(item.id)"
      >
        <X class="size-3" />
      </Button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { markRaw } from 'vue'
import { FileText, Image as ImageIcon, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { MOCK_ATTACHED_CONTEXT, type MockAttachedContext } from '@/api/mock/composer-data'

function iconFor(item: MockAttachedContext) {
  return item.type === 'image' ? markRaw(ImageIcon) : markRaw(FileText)
}

/** 移除某条已附上下文（mock 期只占位，runtime 后对接真实移除） */
function onRemove(id: string): void {
  void id
  // TODO: 对接 runtime 上下文移除
}
</script>
