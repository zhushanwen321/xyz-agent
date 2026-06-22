<template>
  <!--
    已附上下文 chip 行 + hover 列表（draft-composer-states §2f）。
    输入区上方：每条已附上下文（@ 引用 / # 文件 / 图片）一个小徽章；整行 hover 出详情列表。
    §2a（容量统计）与 §2f（条目清单）边界：此处是条目清单，可逐条移除。
    mock 期用 MOCK_ATTACHED_CONTEXT 静态展示；runtime 后由 ComposerInput 的 chip 变更驱动。
  -->
  <HoverCard :open-delay="150" :close-delay="100">
    <HoverCardTrigger as-child>
      <div
        class="flex items-center gap-1 overflow-hidden px-3.5 pt-[7px]"
        title="已附上下文（hover 查看详情）"
      >
        <span
          v-for="item in MOCK_ATTACHED_CONTEXT"
          :key="item.id"
          class="inline-flex max-w-[140px] shrink-0 items-center gap-1 rounded-sm bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted"
        >
          <component :is="iconFor(item)" class="size-3 shrink-0" :class="item.type === 'image' ? 'text-reasoning' : 'text-subtle'" />
          <span class="truncate">{{ item.name }}</span>
        </span>
      </div>
    </HoverCardTrigger>
    <HoverCardContent side="top" align="start" class="w-[280px] p-0">
      <!-- head -->
      <div class="flex items-center justify-between border-b border-border px-2.5 py-2">
        <span class="text-[11px] font-semibold text-fg">已附上下文</span>
        <span class="font-mono text-[10px] text-subtle">{{ MOCK_ATTACHED_CONTEXT.length }} 项 · 6.9万</span>
      </div>
      <!-- items -->
      <div class="py-1">
        <div
          v-for="item in MOCK_ATTACHED_CONTEXT"
          :key="item.id"
          class="group flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-muted"
        >
          <component
            :is="iconFor(item)"
            class="size-3.5 shrink-0"
            :class="item.type === 'image' ? 'text-reasoning' : 'text-subtle'"
          />
          <span class="flex-1 truncate">{{ item.name }}</span>
          <span class="font-mono text-[10px] text-subtle">{{ item.meta }}</span>
          <Button
            variant="ghost"
            class="grid size-[15px] shrink-0 place-items-center rounded-sm text-subtle transition-colors hover:bg-[rgba(239,68,68,0.12)] hover:text-danger"
            title="从上下文移除"
            @click.stop="onRemove(item.id)"
          >
            <X class="size-3" />
          </Button>
        </div>
      </div>
      <!-- foot -->
      <div class="flex justify-between border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-subtle">
        <span>点 × 从上下文移除</span>
        <span>hover</span>
      </div>
    </HoverCardContent>
  </HoverCard>
</template>

<script setup lang="ts">
import { markRaw } from 'vue'
import { FileText, Image as ImageIcon, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
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
