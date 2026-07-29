<script setup lang="ts">
/**
 * MobileNewSession —— 移动端新建会话（spec P4 §3.2 + D4 + 审查 M6 + C3）。
 *
 * prompt composer（Textarea）+ 手动路径 Input（placeholder「输入服务器路径，如 ~/projects/xyz-agent」）
 * + 确认按钮。提交走 sessionApi.create(cwd=路径) → emit created(sessionId)。
 *
 * [MAJOR-3] create 后发送首条消息（prompt）—— 对齐 renderer useNewTaskFlow.submitFirstMessage
 *   （create 后 chat.send(newSid, textToSegments(trimmed))）。原实现只 create 不 send，
 *   用户输入的 prompt 丢失，session 是空壳。create 成功后 appendSession 到 store 刷新列表。
 *
 * 不调 dir.list RPC（spec D4/审查 M6，dir.list 在 P9）。~ 由服务端 expand。
 * 复用 P1 手动路径输入语义（input + 确认，与 DirSelectPopover 远程模式手动输入同语义）。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, Loader2 } from '@lucide/vue'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import * as sessionApi from '@/api/domains/session'
import { useToast } from '@/composables/useToast'
import { useSidebar } from '@/composables/features/useSidebar'
import { useChat } from '@/composables/features/useChat'
import { useSessionStore } from '@/stores/session'
import { textToSegments } from '@xyz-agent/shared'

const emit = defineEmits<{
  created: [sessionId: string]
  cancel: []
}>()

const { t } = useI18n()
const { error } = useToast()
const { loadSessions } = useSidebar()
const { send } = useChat()
const sessionStore = useSessionStore()

const prompt = ref('')
const cwd = ref('')
const creating = ref(false)
const canSubmit = computed(() => prompt.value.trim().length > 0 && cwd.value.trim().length > 0 && !creating.value)

async function handleSubmit(): Promise<void> {
  const promptTrimmed = prompt.value.trim()
  const cwdTrimmed = cwd.value.trim()
  if (!promptTrimmed || !cwdTrimmed || creating.value) return

  creating.value = true
  try {
    // sessionApi.create(cwd) —— #1 cwd 透传，~ 由服务端 expand（spec D4）
    const session = await sessionApi.create(cwdTrimmed)
    // [MAJOR-3] create 成功后立即 appendSession 到 store，让列表即时显示新 session
    sessionStore.appendSession(session)
    // [MAJOR-3] 发送首条消息（prompt）—— 对齐 renderer useNewTaskFlow.submitFirstMessage。
    // sessionApi.create 只建 session（签名 create(cwd?, label?) 不含 prompt），prompt 必须
    // 显式 send 才能进入对话流，否则 session 是空壳。失败不阻断进 chat 态（用户可重发）。
    try {
      await send(session.id, textToSegments(promptTrimmed))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      error(t('mobile.newSession.errorSend', { msg }))
    }
    // loadSessions 刷新列表（runtime 广播权威分组 + label 回填）—— fire-and-forget
    void loadSessions()
    emit('created', session.id)
  } catch (e) {
    // ES2：create 失败（cwd 不存在/无权限）显示错误，不 emit created，用户可改路径重试
    const msg = e instanceof Error ? e.message : String(e)
    error(t('mobile.newSession.errorCreate', { msg }))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="mobile-new-session flex h-full flex-col" data-testid="mobile-new-session">
    <!-- header：返回 + 标题 -->
    <header class="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-3 py-3">
      <button
        type="button"
        class="flex items-center justify-center rounded-md p-1 text-muted"
        data-testid="mobile-new-session-cancel"
        :aria-label="t('mobile.newSession.cancel')"
        @click="emit('cancel')"
      >
        <ArrowLeft :size="20" />
      </button>
      <span class="text-sm font-semibold">{{ t('mobile.newSession.title') }}</span>
    </header>

    <!-- 表单 -->
    <div class="flex-1 overflow-y-auto p-4">
      <div class="flex flex-col gap-4">
        <!-- prompt -->
        <div class="flex flex-col gap-2">
          <label class="text-xs font-medium text-muted" for="mobile-new-session-prompt">Prompt</label>
          <Textarea
            id="mobile-new-session-prompt"
            v-model="prompt"
            :placeholder="t('mobile.newSession.promptPlaceholder')"
            rows="4"
            class="resize-none bg-bg-input text-sm"
            data-testid="mobile-new-session-prompt"
          />
        </div>

        <!-- 手动路径输入（spec D4：不走 dir.list，~ 服务端 expand） -->
        <div class="flex flex-col gap-2">
          <label class="text-xs font-medium text-muted" for="mobile-new-session-cwd">
            {{ t('mobile.newSession.cwdLabel') }}
          </label>
          <Input
            id="mobile-new-session-cwd"
            v-model="cwd"
            :placeholder="t('mobile.newSession.cwdPlaceholder')"
            class="bg-bg-input text-sm"
            data-testid="mobile-new-session-cwd"
          />
        </div>
      </div>
    </div>

    <!-- 确认按钮 -->
    <div class="shrink-0 border-t border-border bg-surface p-3">
      <Button
        type="button"
        :disabled="!canSubmit"
        data-testid="mobile-new-session-submit"
        class="w-full"
        @click="handleSubmit"
      >
        <Loader2 v-if="creating" class="size-4 animate-spin" />
        {{ t('mobile.newSession.submit') }}
      </Button>
    </div>
  </div>
</template>
