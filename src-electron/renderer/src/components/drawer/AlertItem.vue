<template>
  <div class="border border-[oklch(80%_0.02_25)] rounded-sm mb-[10px] overflow-hidden bg-[oklch(97%_0.015_25)]" :class="{ 'border-l-warning': simple }">
    <div class="py-[10px] px-3 flex items-center gap-2">
      <span class="w-[7px] h-[7px] rounded-full shrink-0" :class="simple ? 'bg-warning' : 'bg-danger'"></span>
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-semibold">{{ name }}</div>
        <div v-if="session" class="text-[11px] text-muted">{{ session }}</div>
      </div>
      <div v-if="time" class="text-[10px] text-muted whitespace-nowrap">{{ time }}</div>
    </div>
    <div class="px-3 pb-[10px]">
      <div class="text-[13px] leading-relaxed mb-2">{{ question }}</div>
      <template v-if="simple">
        <div class="flex gap-1.5 items-end">
          <textarea
            v-model="replyText"
            class="flex-1 py-1.5 px-[10px] border border-border rounded-sm bg-bg text-fg font-body text-xs resize-none outline-none min-h-8 max-h-20 transition-colors duration-150 ease-ease focus:border-accent"
            placeholder="直接回复…"
            rows="1"
            @keydown.enter.prevent="sendReply"
          ></textarea>
          <button class="py-1.5 px-3 border-none rounded-sm bg-accent text-white text-[11px] font-semibold cursor-pointer whitespace-nowrap font-body transition-opacity duration-150 ease-ease hover:opacity-[0.88]" @click="sendReply">回复</button>
        </div>
      </template>
      <template v-else>
        <span class="text-xs text-accent font-semibold cursor-pointer inline-flex items-center gap-[3px] hover:underline" @click="$emit('view')">查看详情并回复 →</span>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  id: string
  name: string
  session?: string
  time?: string
  question: string
  simple?: boolean
}>()

const emit = defineEmits<{
  reply: [payload: { id: string; message: string }]
  view: []
}>()

const replyText = ref('')

function sendReply() {
  const msg = replyText.value.trim()
  if (!msg) return
  emit('reply', { id: props.id, message: msg })
  replyText.value = ''
}
</script>
