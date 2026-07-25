<template>
  <!--
    CodingPlanSection —— ProviderEditModal 内「Coding Plan 额度查询」子组件。
    从 ProviderEditModal.vue 提取，保持主模板 ≤400 行。
    4 种 UI 状态：未启用 / API Key 类已配置 / Cookie 类已配置 / 查询失败。
    所有业务逻辑在父组件 useQuotaConfigure 中，本组件纯展示 + 事件转发。
  -->
  <div class="border-t border-border pt-4" data-testid="coding-plan-section">
    <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">
      {{ t('settings.providerEdit.quotaSection') }}
    </Label>

    <!-- 启用开关 -->
    <div class="flex items-center justify-between py-1.5">
      <span class="text-[12px] text-fg">
        {{ t('settings.providerEdit.quotaEnable') }}
        <span class="text-[10px] text-subtle">{{ t('settings.providerEdit.quotaEnableHint') }}</span>
      </span>
      <Switch
        :model-value="enabled"
        data-testid="quota-enabled-switch"
        :disabled="configuring"
        @update:model-value="$emit('toggleEnabled')"
      />
    </div>

    <!-- API Key 类：凭证状态 + 操作按钮 -->
    <template v-if="!isCookieAuth">
      <div class="flex items-center justify-between py-1">
        <span class="text-[11px] text-muted">{{ t('settings.providerEdit.quotaAuthMethod') }}</span>
        <span v-if="apiKeySet" class="flex items-center gap-1 text-[11px] text-success">
          <CheckCircle2 class="size-3" />
          {{ t('settings.providerEdit.quotaCredentialOk') }}
        </span>
        <span v-else class="text-[11px] text-danger">{{ t('settings.providerEdit.quotaCredentialMissing') }}</span>
      </div>

      <!-- 操作按钮（仅启用时显示） -->
      <div v-if="enabled" class="mt-2 flex gap-1.5">
        <Button
          variant="secondary"
          class="gap-1 px-2 py-1 text-[11px] text-muted [&_svg]:size-3"
          :disabled="testStatus === 'loading'"
          data-testid="quota-test-btn"
          @click="$emit('testQuery')"
        >
          <Loader2 v-if="testStatus === 'loading'" class="animate-spin" />
          <RefreshCw v-else class="size-3" />
          {{ t('settings.providerEdit.quotaTestQuery') }}
        </Button>
      </div>
    </template>

    <!-- Cookie 类：输入框 + 帮助链接 -->
    <template v-else>
      <div class="mt-2">
        <div class="mb-1 flex items-center justify-between">
          <span class="text-[11px] text-fg">Cookie</span>
          <span v-if="cookieSet" class="text-[10px] text-success">{{ t('settings.providerEdit.quotaCookieSet') }}</span>
          <span v-else class="text-[10px] text-subtle">{{ t('settings.providerEdit.quotaCookieNotSet') }}</span>
        </div>
        <Textarea
          :model-value="cookieInput"
          class="min-h-[56px] resize-y font-mono text-[11px]"
          :placeholder="t('settings.providerEdit.quotaCookiePlaceholder')"
          data-testid="quota-cookie-input"
          @update:model-value="$emit('update:cookieInput', String($event ?? ''))"
        />
      </div>
      <!-- 帮助链接 -->
      <p v-if="helpUrl" class="mt-1.5 flex items-start gap-1 text-[10px] text-subtle">
        <ExternalLink class="mt-0.5 size-3 shrink-0" />
        <span>{{ helpText || '' }}
          <a
            :href="helpUrl"
            target="_blank"
            rel="noopener"
            class="text-accent hover:underline"
          >{{ helpUrl }}</a>
        </span>
      </p>
      <!-- 操作按钮 -->
      <div class="mt-2 flex gap-1.5">
        <Button
          variant="secondary"
          class="gap-1 px-2 py-1 text-[11px] text-muted [&_svg]:size-3"
          :disabled="configuring || !cookieInput.trim()"
          data-testid="quota-save-cookie-btn"
          @click="$emit('saveCookie')"
        >
          <Loader2 v-if="configuring" class="animate-spin" />
          {{ t('settings.providerEdit.quotaSaveCookie') }}
        </Button>
        <Button
          v-if="enabled"
          variant="secondary"
          class="gap-1 px-2 py-1 text-[11px] text-muted [&_svg]:size-3"
          :disabled="testStatus === 'loading'"
          data-testid="quota-test-btn"
          @click="$emit('testQuery')"
        >
          <Loader2 v-if="testStatus === 'loading'" class="animate-spin" />
          <RefreshCw v-else class="size-3" />
          {{ t('settings.providerEdit.quotaTestQuery') }}
        </Button>
      </div>
    </template>

    <!-- 测试查询成功 + 内联额度预览 -->
    <div v-if="testStatus === 'success' && quotaRow" class="mt-2" data-testid="quota-result">
      <div class="flex items-center gap-1.5 text-[11px] text-success">
        <CheckCircle2 class="size-3" />
        {{ t('settings.providerEdit.quotaTestSuccess') }}
        <span v-if="lastFetchAt" class="text-subtle">· {{ formatTimeAgo(lastFetchAt) }}</span>
      </div>
      <div class="mt-2 rounded-sm border border-border bg-bg-input p-2.5">
        <div
          v-for="(win, idx) in quotaRow.wins"
          :key="idx"
          class="flex items-center justify-between py-0.5 text-[11px]"
        >
          <span class="font-mono text-[10px] uppercase tracking-wide text-muted">{{ WINDOW_LABELS[idx] }}</span>
          <span v-if="win.pct !== null" class="font-semibold tabular-nums text-fg">
            {{ Math.round(win.pct) }}%
            <span v-if="win.resetSec !== null" class="ml-1 font-normal text-subtle">· {{ formatResetSec(win.resetSec) }}</span>
          </span>
          <span v-else class="text-subtle">∞</span>
        </div>
      </div>
    </div>

    <!-- 测试查询失败 -->
    <div v-if="testStatus === 'error'" class="mt-2" data-testid="quota-error">
      <div class="flex items-center gap-1.5 text-[11px] text-danger">
        <AlertCircle class="size-3" />
        {{ testErrorMsg || t('settings.providerEdit.quotaTestFail') }}
      </div>
      <Button
        v-if="isCookieAuth"
        variant="ghost"
        class="mt-1 h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline"
        data-testid="quota-update-cookie-btn"
        @click="$emit('update:cookieInput', '')"
      >
        {{ t('settings.providerEdit.quotaUpdateCookie') }}
      </Button>
    </div>

    <!-- 配置错误 -->
    <p v-if="configureErrorMsg" class="mt-1 text-[11px] text-danger" data-testid="quota-configure-error">{{ configureErrorMsg }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * CodingPlanSection props/events 设计：
 * - 所有状态由父组件 useQuotaConfigure 管理，本组件纯展示
 * - 事件转发：toggleEnabled / testQuery / saveCookie / update:cookieInput
 */
import { Loader2, RefreshCw, CheckCircle2, AlertCircle, ExternalLink } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { NormalizedQuotaRow } from '@xyz-agent/shared'
import type { QuotaTestStatus } from '@/composables/features/useQuotaConfigure'

defineProps<{
  enabled: boolean
  cookieInput: string
  testStatus: QuotaTestStatus
  testErrorMsg: string
  quotaRow: NormalizedQuotaRow | null
  lastFetchAt: number | null
  isCookieAuth: boolean
  configuring: boolean
  configureErrorMsg: string
  apiKeySet: boolean
  cookieSet: boolean
  helpUrl?: string
  helpText?: string
}>()

defineEmits<{
  toggleEnabled: []
  testQuery: []
  saveCookie: []
  'update:cookieInput': [value: string]
}>()

const { t } = useI18n()

/** 三窗口标签（与 QuotaWins 顺序对齐：5h / 本周 / 本月） */
const WINDOW_LABELS = ['5h', '本周', '本月'] as const

// 时间单位常量
const MS_PER_SEC = 1000
const SEC_PER_MIN = 60
const MIN_PER_HOUR = 60
const HOUR_PER_DAY = 24
const SEC_PER_HOUR = SEC_PER_MIN * MIN_PER_HOUR

/** 格式化时间戳为相对时间（如 '2 分钟前'） */
function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / MS_PER_SEC)
  if (sec < SEC_PER_MIN) return `${sec}秒前`
  const min = Math.floor(sec / SEC_PER_MIN)
  if (min < MIN_PER_HOUR) return `${min}分钟前`
  const hr = Math.floor(min / MIN_PER_HOUR)
  if (hr < HOUR_PER_DAY) return `${hr}小时前`
  const day = Math.floor(hr / HOUR_PER_DAY)
  return `${day}天前`
}

/** 格式化剩余秒数为紧凑时间（如 '1h23m' / '3d12h'） */
function formatResetSec(sec: number): string {
  if (sec <= 0) return '--'
  const h = Math.floor(sec / SEC_PER_HOUR)
  if (h >= HOUR_PER_DAY) {
    const d = Math.floor(h / HOUR_PER_DAY)
    const rh = h % HOUR_PER_DAY
    return rh > 0 ? `${d}d${rh}h` : `${d}d`
  }
  const m = Math.floor((sec % SEC_PER_HOUR) / SEC_PER_MIN)
  return m > 0 ? `${h}h${m}m` : `${h}h`
}
</script>
