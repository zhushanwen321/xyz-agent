<template>
  <div class="app-root" :class="`is-${status}`">
    <div class="status-card">
      <span class="status-dot" />
      <span class="status-text">{{ statusText }}</span>
    </div>
    <p v-if="!isConnected" class="status-hint">{{ t('app.waiting') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConnection } from './composables/useConnection'

const { t } = useI18n()
const { state, init, teardown } = useConnection()

const status = computed(() => state.value)
const isConnected = computed(() => state.value === 'connected')
const statusText = computed(() => t(`connection.${state.value}`))

onMounted(() => {
  init()
})

onUnmounted(() => {
  teardown()
})
</script>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
  gap: 12px;
}

.status-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  transition: background 0.2s var(--ease);
}

.status-text {
  font-size: 13px;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}

.status-hint {
  font-size: 12px;
  color: var(--muted);
}

/* 状态颜色编码 */
.is-connected .status-dot { background: var(--success); }
.is-connecting .status-dot,
.is-reconnecting .status-dot {
  background: var(--warning);
  animation: pulse 1.2s ease-in-out infinite;
}
.is-disconnected .status-dot { background: var(--danger); }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
