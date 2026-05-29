<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Dialog, Button, Input } from '../../design-system'
import { useExtensionUI } from '../../composables/useExtensionUI'

const { activeRequest, sendResponse } = useExtensionUI()

const inputValue = ref('')
const selectedOption = ref('')

const dialogOpen = computed(
  () => activeRequest.value !== null && activeRequest.value.method !== 'notify',
)

const dialogTitle = computed(() => {
  const prefix = activeRequest.value?.source === 'plugin' ? 'Plugin' : 'Extension'
  return activeRequest.value?.title ?? `${prefix} Request`
})


// 每次 dialog 打开时重置内部状态
watch(dialogOpen, (open) => {
  if (open && activeRequest.value) {
    inputValue.value = activeRequest.value.default ?? ''
    selectedOption.value = activeRequest.value.options?.[0] ?? ''
  }
})

function handleConfirm() {
  if (!activeRequest.value) return
  sendResponse(activeRequest.value.requestId, true, activeRequest.value.sessionId)
}

function handleCancel() {
  if (!activeRequest.value) return
  const method = activeRequest.value.method
  // confirm → false, select/input → null
  const cancelResult = method === 'confirm' ? false : null
  sendResponse(activeRequest.value.requestId, cancelResult, activeRequest.value.sessionId)
}

function handleSelect() {
  if (!activeRequest.value) return
  sendResponse(activeRequest.value.requestId, selectedOption.value, activeRequest.value.sessionId)
}

function handleInputSubmit() {
  if (!activeRequest.value) return
  sendResponse(activeRequest.value.requestId, inputValue.value || null, activeRequest.value.sessionId)
}

const method = computed(() => activeRequest.value?.method)
</script>

<template>
  <Dialog :open="dialogOpen" :title="dialogTitle" @update:open="handleCancel">
    <!-- confirm -->
    <template v-if="method === 'confirm'">
      <p v-if="activeRequest?.message" class="text-sm leading-relaxed mb-5" style="color: var(--muted)">
        {{ activeRequest.message }}
      </p>
      <div class="flex justify-end gap-2">
        <Button variant="outline" size="sm" @click="handleCancel">取消</Button>
        <Button variant="primary" size="sm" @click="handleConfirm">确认</Button>
      </div>
    </template>

    <!-- select -->
    <template v-else-if="method === 'select'">
      <p v-if="activeRequest?.message" class="text-sm leading-relaxed mb-4" style="color: var(--muted)">
        {{ activeRequest.message }}
      </p>
      <div class="flex flex-col gap-1.5 mb-5">
        <div
          v-for="opt in activeRequest?.options ?? []"
          :key="opt"
          role="button"
          tabindex="0"
          class="w-full text-left px-3 py-2 rounded-sm text-sm cursor-pointer transition-colors duration-150 border select-none"
          :class="[
            selectedOption === opt
              ? 'border-[var(--accent)] bg-[var(--accent-light)] text-[var(--fg)]'
              : 'border-[var(--border)] bg-transparent text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--fg)]',
          ]"
          @click="selectedOption = opt"
          @keydown.enter="selectedOption = opt"
        >
          {{ opt }}
        </div>
      </div>
      <div class="flex justify-end gap-2">
        <Button variant="outline" size="sm" @click="handleCancel">取消</Button>
        <Button variant="primary" size="sm" :disabled="!selectedOption" @click="handleSelect">选择</Button>
      </div>
    </template>

    <!-- input -->
    <template v-else-if="method === 'input'">
      <p v-if="activeRequest?.message" class="text-sm leading-relaxed mb-4" style="color: var(--muted)">
        {{ activeRequest.message }}
      </p>
      <Input
        v-model="inputValue"
        :placeholder="activeRequest?.default ?? ''"
        class="mb-5"
        @keydown.enter="handleInputSubmit"
      />
      <div class="flex justify-end gap-2">
        <Button variant="outline" size="sm" @click="handleCancel">取消</Button>
        <Button variant="primary" size="sm" @click="handleInputSubmit">提交</Button>
      </div>
    </template>
  </Dialog>
</template>
