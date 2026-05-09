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
      <template v-if="simple">
        <div class="inline-reply">
          <textarea
            v-model="replyText"
            class="inline-reply__field"
            placeholder="直接回复…"
            rows="1"
            @keydown.enter.prevent="sendReply"
          ></textarea>
          <button class="inline-reply__btn" @click="sendReply">回复</button>
        </div>
      </template>
      <template v-else>
        <span class="inline-reply__link" @click="$emit('view')">查看详情并回复 →</span>
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
