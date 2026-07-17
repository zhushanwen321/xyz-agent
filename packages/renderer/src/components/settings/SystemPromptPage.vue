<!--
  Settings · SystemPrompt 菜单页（FR-4/FR-5）。
  三卡片：替换系统提示词 / 注入额外提示词 / 当前生效提示词快照。
  数据层由 W6 提供：config.getSystemPrompt / setSystemPrompt / getSystemPromptSnapshot。
  保存为显式按钮触发（不自动保存），失败走 toast error，成功走 toast info。
-->
<template>
  <div data-testid="system-prompt-page" class="flex max-w-[860px] flex-col gap-3">
    <!-- corrupted 提示条：getSystemPrompt 返回 corrupted=true 时显示 -->
    <div
      v-if="corrupted"
      class="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[12px] text-fg"
    >
      <AlertTriangle class="mt-px size-4 flex-shrink-0 text-warning" />
      <span>{{ t('settings.systemPrompt.corruptedHint') }}</span>
    </div>

    <!-- 卡 1：替换系统提示词 -->
    <div class="rounded-md border border-border bg-bg">
      <div class="flex items-center justify-between px-4 pb-3 pt-3">
        <div class="min-w-0">
          <h3 class="text-[13px] font-medium text-fg">{{ t('settings.systemPrompt.replaceTitle') }}</h3>
          <p class="mt-0.5 text-[11px] text-subtle">{{ t('settings.systemPrompt.replaceSubtitle') }}</p>
        </div>
        <Switch
          :data-testid="'system-prompt-replace-switch'"
          :model-value="replaceEnabled"
          @update:model-value="replaceEnabled = $event === true"
        />
      </div>
      <div class="border-t border-border px-4 py-3">
        <p class="mb-2 text-[11px] leading-relaxed text-muted">{{ t('settings.systemPrompt.replaceWarning') }}</p>
        <Label class="mb-1 block text-[11px] text-subtle" for="system-prompt-replace-input">
          {{ t('settings.systemPrompt.replaceLabel') }}
        </Label>
        <Textarea
          id="system-prompt-replace-input"
          data-testid="system-prompt-replace-input"
          :model-value="replacePrompt"
          @update:model-value="replacePrompt = String($event)"
          :placeholder="t('settings.systemPrompt.replacePlaceholder')"
          :disabled="!replaceEnabled"
          class="min-h-[120px] resize-y font-mono text-[12px]"
        />
        <div class="mt-1 flex items-center justify-between">
          <span class="font-mono text-[10px] text-subtle">{{ replacePrompt.length }}/{{ maxLength }}</span>
          <Button
            data-testid="system-prompt-replace-save"
            size="dense"
            :disabled="!replaceEnabled"
            @click="saveReplace"
          >
            {{ t('settings.systemPrompt.save') }}
          </Button>
        </div>

        <!-- 可折叠：查看 pi 默认提示词参考 -->
        <div class="mt-3 border-t border-border pt-3">
          <Button
            data-testid="system-prompt-default-toggle"
            variant="ghost"
            size="sm"
            class="h-auto w-full justify-start gap-1 px-0 py-0 text-[11px] font-normal text-subtle hover:bg-transparent hover:text-fg [&_svg]:size-3"
            @click="showDefaultPrompt = !showDefaultPrompt"
          >
            <ChevronRight class="transition-transform" :class="{ 'rotate-90': showDefaultPrompt }" />
            {{ t('settings.systemPrompt.defaultToggle') }}
          </Button>
          <div v-if="showDefaultPrompt" class="mt-2">
            <p class="mb-2 text-[10px] leading-relaxed text-subtle">
              {{ t('settings.systemPrompt.defaultHint') }}
            </p>
            <pre
              data-testid="system-prompt-default-content"
              class="max-h-[240px] select-text overflow-auto whitespace-pre-wrap break-words rounded-sm bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-fg"
            >{{ DEFAULT_PI_SYSTEM_PROMPT }}</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- 卡 2：注入额外提示词 -->
    <div class="rounded-md border border-border bg-bg">
      <div class="flex items-center justify-between px-4 pb-3 pt-3">
        <div class="min-w-0">
          <h3 class="text-[13px] font-medium text-fg">{{ t('settings.systemPrompt.appendTitle') }}</h3>
          <p class="mt-0.5 text-[11px] text-subtle">{{ t('settings.systemPrompt.appendSubtitle') }}</p>
        </div>
        <Switch
          :data-testid="'system-prompt-append-switch'"
          :model-value="appendEnabled"
          @update:model-value="appendEnabled = $event === true"
        />
      </div>
      <div class="border-t border-border px-4 py-3">
        <p class="mb-2 text-[11px] leading-relaxed text-muted">{{ t('settings.systemPrompt.appendHint') }}</p>
        <Label class="mb-1 block text-[11px] text-subtle" for="system-prompt-append-input">
          {{ t('settings.systemPrompt.appendLabel') }}
        </Label>
        <Textarea
          id="system-prompt-append-input"
          data-testid="system-prompt-append-input"
          :model-value="appendPrompt"
          @update:model-value="appendPrompt = String($event)"
          :placeholder="t('settings.systemPrompt.appendPlaceholder')"
          :disabled="!appendEnabled"
          class="min-h-[120px] resize-y font-mono text-[12px]"
        />
        <div class="mt-1 flex items-center justify-between">
          <!-- append 走 hook 不经 argv，无 32k/16000 硬上限约束，故只显示字符数不显示上限（R3）。 -->
          <span class="font-mono text-[10px] text-subtle">{{ appendPrompt.length }} {{ t('settings.systemPrompt.charCount') }}</span>
          <Button
            data-testid="system-prompt-append-save"
            size="dense"
            :disabled="!appendEnabled"
            @click="saveAppend"
          >
            {{ t('settings.systemPrompt.save') }}
          </Button>
        </div>
      </div>
    </div>

    <!-- 卡 3：当前生效提示词快照 -->
    <div class="rounded-md border border-border bg-bg">
      <div class="flex items-center justify-between px-4 pb-3 pt-3">
        <div class="min-w-0">
          <h3 class="text-[13px] font-medium text-fg">{{ t('settings.systemPrompt.snapshotTitle') }}</h3>
          <p class="mt-0.5 text-[11px] text-subtle">{{ t('settings.systemPrompt.snapshotSubtitle') }}</p>
        </div>
        <Button
          data-testid="system-prompt-snapshot-refresh"
          variant="secondary"
          size="dense"
          :disabled="snapshotRefreshing"
          @click="refreshSnapshot"
        >
          <RefreshCw class="size-3.5" :class="{ 'animate-spin': snapshotRefreshing }" />
          {{ t('settings.systemPrompt.refresh') }}
        </Button>
      </div>
      <div class="border-t border-border px-4 py-3">
        <div
          data-testid="system-prompt-snapshot-content"
          class="max-h-[280px] min-h-[80px] overflow-auto whitespace-pre-wrap break-words rounded-sm bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-fg"
        >
          <span v-if="snapshot && snapshot.exists && snapshot.content">{{ snapshot.content }}</span>
          <span v-else class="text-subtle">{{ t('settings.systemPrompt.snapshotEmpty') }}</span>
        </div>
        <div class="mt-2 flex items-center gap-1.5 text-[10px] text-subtle">
          <Clock class="size-3" />
          <span data-testid="system-prompt-snapshot-updated-at">
            {{ snapshot && snapshot.exists && snapshot.updatedAt ? formatTime(snapshot.updatedAt) : t('settings.systemPrompt.snapshotNoTime') }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, RefreshCw, Clock, ChevronRight } from '@lucide/vue'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { config } from '@/api'
import { useToast } from '@/composables/useToast'
import { SYSTEM_PROMPT_MAX_LENGTH, DEFAULT_PI_SYSTEM_PROMPT } from '@xyz-agent/shared'
import type { SystemPromptConfig, SystemPromptSnapshot } from '@xyz-agent/shared'

const { t } = useI18n()
const { info, error } = useToast()

const maxLength = SYSTEM_PROMPT_MAX_LENGTH

/** 当前加载的配置（getSystemPrompt 返回）。corrupted=true 表示磁盘损坏已回退默认。 */
const corrupted = ref(false)
const replaceEnabled = ref(false)
const replacePrompt = ref('')
const appendEnabled = ref(false)
const appendPrompt = ref('')

/** 参考区展开态（默认折叠）。 */
const showDefaultPrompt = ref(false)

/** 快照（getSystemPromptSnapshot 返回）。null=尚未加载。 */
const snapshot = ref<SystemPromptSnapshot | null>(null)
const snapshotRefreshing = ref(false)

/** 构造完整 SystemPromptConfig（替换卡与追加卡当前编辑值的快照）。 */
function buildConfig(): SystemPromptConfig {
  return {
    version: 1,
    replace: { enabled: replaceEnabled.value, prompt: replacePrompt.value },
    append: { enabled: appendEnabled.value, prompt: appendPrompt.value },
  }
}

/** 加载系统提示词配置到本地编辑态。 */
async function loadConfig(): Promise<void> {
  try {
    const res = await config.getSystemPrompt()
    corrupted.value = res.corrupted
    replaceEnabled.value = res.config.replace.enabled
    replacePrompt.value = res.config.replace.prompt
    appendEnabled.value = res.config.append.enabled
    appendPrompt.value = res.config.append.prompt
  } catch (e) {
    error(e instanceof Error ? e.message : String(e))
  }
}

/** 加载快照。 */
async function loadSnapshot(): Promise<void> {
  try {
    snapshot.value = await config.getSystemPromptSnapshot()
  } catch (e) {
    error(e instanceof Error ? e.message : String(e))
  }
}

/** 保存替换卡：以当前编辑态写回 config。 */
async function saveReplace(): Promise<void> {
  try {
    await config.setSystemPrompt(buildConfig())
    info(t('settings.systemPrompt.savedToast'))
  } catch (e) {
    error(e instanceof Error ? e.message : String(e))
  }
}

/** 保存追加卡：以当前编辑态写回 config。 */
async function saveAppend(): Promise<void> {
  try {
    await config.setSystemPrompt(buildConfig())
    info(t('settings.systemPrompt.savedToast'))
  } catch (e) {
    error(e instanceof Error ? e.message : String(e))
  }
}

/** 刷新快照（点击刷新按钮）。 */
async function refreshSnapshot(): Promise<void> {
  snapshotRefreshing.value = true
  try {
    await loadSnapshot()
  } finally {
    snapshotRefreshing.value = false
  }
}

/** ISO 时间字符串格式化为本地可读时间。输入为空时返回占位符。 */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString()
  } catch {
    return iso
  }
}

onMounted(() => {
  void loadConfig()
  void loadSnapshot()
})
</script>
