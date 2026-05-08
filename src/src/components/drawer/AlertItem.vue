<template>
  <div class="alert-item" :class="{ 'alert-item--simple': simple }">
    <div class="alert-item__hd">
      <span class="alert-item__dot"></span>
      <div class="alert-item__info">
        <div class="alert-item__name">{{ name }}</div>
        <div v-if="session" class="alert-item__session">{{ session }}</div>
      </div>
      <div v-if="time" class="alert-item__time">{{ time }}</div>
    </div>
    <div class="alert-item__bd">
      <div class="alert-item__question">{{ question }}</div>
      <div class="inline-reply">
        <Textarea
          v-model="replyText"
          class="inline-reply__field"
          placeholder="输入回复…"
          :rows="1"
          :style="{ border: 'none', background: 'transparent' }"
          @keydown.enter.prevent="sendReply"
        />
        <Button variant="primary" class="inline-reply__btn" @click="sendReply">发送</Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Textarea, Button } from '../../design-system'

defineProps<{
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
  emit('reply', { id: '', message: msg })
  replyText.value = ''
}
</script>
