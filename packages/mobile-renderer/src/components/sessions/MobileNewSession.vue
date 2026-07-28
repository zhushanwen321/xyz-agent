<script setup lang="ts">
/**
 * MobileNewSession —— 移动端新建会话（spec P4 §3.2 + D4 + 审查 M6 + C3）。
 *
 * prompt composer（Textarea）+ 手动路径 Input（placeholder「输入服务器路径，如 ~/projects/xyz-agent」）
 * + 确认按钮。提交走 sessionApi.create(cwd=路径) → emit created(sessionId)。
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

const emit = defineEmits<{
  created: [sessionId: string]
  cancel: []
}>()

const { t } = useI18n()
const { error } = useToast()

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
