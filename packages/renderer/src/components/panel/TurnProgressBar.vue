<!--
  展示组件 · turn 进展观测条（session-dead-structural-fixes §3.3 D6 C1 方案一 / §3.1 成功路径 C）。
  Composer 上方常驻条：本 turn 已 N 分钟 · 当前 write 已 M 分钟 · 已生成 X 字符。

  数据源 = core useTurnProgress（chat store 既有事件流投影纯本地派生，零协议改动）：
  turn 结束（agent_settled → occupancy idle）snapshot 归 null → v-if 自动消失；
  纯本地派生无持久化，reload 后天然无残留。

  超阈值（10min，P-3 实测后定值）渲染警示色 + 中性操作项（D7：不预置推荐，两个动作
  同权重）——「中止此 turn」emit abort 由父组件接既有 abort 链路（Panel.vue onProgressAbort → useChat.abort），
  本组件不直接触 RPC；「继续等待」= snoozeWarn（本 turn 内抑制警示，事实条照常）。

  ask_user 豁免态（D6）：等待用户输入期间只显示分型文案「在等待你的输入」，停滞警示
  不参与（core 侧已豁免 warn，本组件按 awaitingUser 切换分型渲染）。

  文案纪律（D7）：只陈述事实，禁止判断词（卡死/无响应/异常）——i18n key 见
  locales/*/sidebar.ts turnProgress 段，文案断言测试锁定。
-->
<template>
  <div
    v-if="snapshot"
    data-testid="turn-progress-bar"
    class="mb-1.5 flex items-center gap-2 rounded-md border px-3 py-1.5 text-[length:var(--text-xs)] text-neutral-fg"
    :class="snapshot.warn ? 'border-warn/35 bg-warn-soft' : 'border-border bg-surface'"
  >
    <Clock
      class="size-3 shrink-0"
      :class="snapshot.warn ? 'text-warn' : 'text-neutral-mid'"
    />
    <template v-if="snapshot.awaitingUser">
      <span data-testid="turn-progress-awaiting" class="font-medium">{{ t('sidebar.turnProgress.awaitingUser') }}</span>
    </template>
    <template v-else>
      <span data-testid="turn-progress-elapsed" class="font-medium">{{ t('sidebar.turnProgress.turnElapsed', { duration: formatDuration(snapshot.turnElapsedMs) }) }}</span>
      <span v-if="snapshot.toolName" data-testid="turn-progress-tool">{{ t('sidebar.turnProgress.toolElapsed', { tool: snapshot.toolName, duration: formatDuration(snapshot.toolElapsedMs ?? 0) }) }}</span>
      <span data-testid="turn-progress-chars">{{ t('sidebar.turnProgress.generatedChars', { chars: snapshot.generatedChars.toLocaleString() }) }}</span>
    </template>
    <span class="flex-1" />
    <template v-if="snapshot.warn">
      <Button variant="secondary" size="dense" data-testid="turn-progress-abort" @click="emit('abort')">
        {{ t('sidebar.turnProgress.abortTurn') }}
      </Button>
      <Button variant="secondary" size="dense" data-testid="turn-progress-keep-waiting" @click="snoozeWarn()">
        {{ t('sidebar.turnProgress.keepWaiting') }}
      </Button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clock } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useTurnProgress } from '@xyz-agent/core'
import { useChatStore } from '@/stores/chat'
import { useExtensionUIStore } from '@/stores/extension-ui'

const props = defineProps<{
  sessionId: string | null
}>()

const emit = defineEmits<{
  abort: []
}>()

const { t } = useI18n()
const chatStore = useChatStore()
// ask_user 豁免信号（D6）：extensionUIStore pending SSOT 的非响应式 getter（与
// deriveStatus 同模式）——每秒 tick 轮询，信号出现后 ≤1 tick 切换分型文案。
const extensionUIStore = useExtensionUIStore()

const { snapshot, snoozeWarn } = useTurnProgress(
  computed(() => props.sessionId),
  chatStore,
  { getAwaitingUser: (sid) => extensionUIStore.hasPendingAskUser(sid) },
)

/** 时长换算常量（no-magic-numbers：展示粒度秒/分/时的进率单一声明处）。 */
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60

/** 时长格式化：秒 → 分钟 → 小时+分（i18n 模板承载单位措辞，双语结构差异不进逻辑）。 */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / MS_PER_SECOND)
  if (totalSec < SECONDS_PER_MINUTE) return t('sidebar.turnProgress.durationSec', { sec: totalSec })
  const totalMin = Math.floor(totalSec / SECONDS_PER_MINUTE)
  if (totalMin < MINUTES_PER_HOUR) return t('sidebar.turnProgress.durationMin', { min: totalMin })
  return t('sidebar.turnProgress.durationHourMin', { h: Math.floor(totalMin / MINUTES_PER_HOUR), min: totalMin % MINUTES_PER_HOUR })
}
</script>
