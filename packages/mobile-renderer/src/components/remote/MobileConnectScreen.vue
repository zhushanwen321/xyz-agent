<script setup lang="ts">
/**
 * MobileConnectScreen —— 移动端首屏连接粘贴框（spec P4 §四 D9 + C3）。
 *
 * 移动全屏布局（h-[100dvh] flex flex-col justify-center），含 Textarea 粘贴框 + 连接按钮。
 * 复用 P1 lib/remote/parse-connect-info（四格式解析）+ connection-config（saveProfile + activateRemote）。
 * 不 copy 桌面 RemoteConnectModal（modal 布局移动端不适用），UI 重写全屏。
 *
 * 连接成功流程：parse → saveProfile → activateRemote → emit 'connected'（App.vue 重 init useConnection）。
 * 解析失败：显示 hintUnrecognized（ES1 静默不抛）。
 *
 * 连接失败提示（spec §四 D9）：从 ws-client 读 failReason（与桌面 App.vue 同源——直接读 ws-client
 * 模块而非通过 props，保持单一数据源），显示对应 i18n 文案。auth（token 失效）/ network（断网）/
 * replaced（被挤占）三态分别对应 connection.failedAuth/failedRemoteNetwork/failedReplaced。
 * 用户开始重新输入/粘贴时清空错误提示（良好的 UX）。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, AlertCircle } from '@lucide/vue'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { parseConnectionInfo } from '@/lib/remote/parse-connect-info'
import { saveProfile, activateRemote } from '@/lib/remote/connection-config'
import { getFailReason } from '@/lib/ws-client'
import type { RemoteServerProfile } from '@/lib/remote/types'

const emit = defineEmits<{ connected: [profile: RemoteServerProfile] }>()
const { t } = useI18n()

const pasteInput = ref('')
const connecting = ref(false)
const parseError = ref(false)
// ws-client 单例只读 ref（与桌面 App.vue 同源，直接读模块——ws-client 是连接状态唯一权威数据源）
const failReason = getFailReason()
/** 用户主动重输时本地隐藏失败提示（failReason 仍由 ws-client 持有，重连后由 ws-client 复位） */
const hideFailure = ref(false)

/** 失败原因对应的 i18n key（null → 无提示） */
const failureText = computed(() => {
  switch (failReason.value) {
    case 'auth':
      return t('connection.failedAuth')
    case 'network':
      return t('connection.failedRemoteNetwork')
    case 'replaced':
      return t('connection.failedReplaced')
    default:
      return null
  }
})

const showFailure = computed(() => failureText.value !== null && !hideFailure.value)

const canConnect = computed(() => pasteInput.value.trim().length > 0 && !connecting.value)

/** 用户开始重新输入/粘贴时清掉解析错误 + 本地隐藏失败提示（良好的 UX） */
function onInputChange(): void {
  parseError.value = false
  hideFailure.value = true
}

function handleConnect(): void {
  const trimmed = pasteInput.value.trim()
  if (!trimmed || connecting.value) return

  const parsed = parseConnectionInfo(trimmed)
  if (parsed.error === 'unrecognized' || !parsed.url) {
    // ES1：解析失败显示提示，不清空输入（让用户编辑重试）
    parseError.value = true
    return
  }
  parseError.value = false
  connecting.value = true

  // saveProfile upsert by url（connection-config 内部处理 id 生成/复用）
  const profile = saveProfile({
    name: new URL(parsed.url).host,
    url: parsed.url,
    token: parsed.token ?? '',
    networkKind: parsed.networkKind ?? 'public',
  })
  activateRemote(profile.id)
  emit('connected', profile)
}
</script>

<template>
  <div
    class="mobile-connect-screen flex flex-col items-center justify-center gap-6 bg-bg px-6 text-fg"
    style="min-height: 100dvh"
    data-testid="mobile-connect-screen"
  >
    <div class="flex flex-col items-center gap-3">
      <span
        class="grid size-12 place-items-center rounded-xl bg-accent text-2xl font-bold text-white"
        data-testid="mobile-connect-logo"
      >x</span>
      <h1 class="text-base font-semibold">{{ t('mobile.connect.title') }}</h1>
    </div>

    <div class="flex w-full max-w-md flex-col gap-3">
      <Textarea
        v-model="pasteInput"
        :placeholder="t('mobile.connect.placeholder')"
        rows="4"
        data-testid="mobile-connect-input"
        class="resize-none bg-bg-input text-sm"
        :aria-invalid="parseError || showFailure"
        @update:model-value="onInputChange"
      />
      <!-- 连接失败提示（auth/network/replaced，spec §四 D9）—— 复用 parseError 同款一行文案样式 -->
      <div
        v-if="showFailure"
        class="flex items-center gap-1.5 text-xs text-danger"
        data-testid="mobile-connect-failure"
        role="alert"
      >
        <AlertCircle class="size-3.5 shrink-0" />
        <span>{{ failureText }}</span>
      </div>
      <!-- 解析格式错误提示（与连接失败并列但互斥：解析错误仅粘贴文本无法识别时触发） -->
      <p
        v-if="parseError"
        class="text-xs text-warning"
        data-testid="mobile-connect-hint"
      >
        {{ t('mobile.connect.hintUnrecognized') }}
      </p>
      <Button
        type="button"
        :disabled="!canConnect"
        data-testid="mobile-connect-button"
        class="w-full"
        @click="handleConnect"
      >
        <Loader2 v-if="connecting" class="size-4 animate-spin" />
        {{ t('mobile.connect.connect') }}
      </Button>
    </div>
  </div>
</template>
