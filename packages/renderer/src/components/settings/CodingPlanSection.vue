<template>
  <!--
    CodingPlanSection —— ProviderEditModal 内「Coding Plan 额度查询」子组件。
    从 ProviderEditModal.vue 提取，保持主模板 ≤400 行。
    4 种 UI 状态：未启用 / API Key 类已配置 / Cookie 类已配置 / 查询失败。
    所有业务逻辑在父组件 useQuotaConfigure 中，本组件纯展示 + 事件转发。
  -->
  <div class="border-t border-border pt-4" data-testid="coding-plan-section">
    <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-neutral-mid">
      {{ t('settings.providerEdit.quotaSection') }}
    </Label>

    <!-- 类型选择下拉框（始终显示：手动指定 Coding Plan 类型，不再完全依赖自动匹配） -->
    <div class="mb-2">
      <Label class="mb-1 block text-[10px] text-neutral-mid">
        {{ t('settings.providerEdit.quotaType') }}
        <span class="normal-case text-neutral-dim">{{ t('settings.providerEdit.quotaTypeHint') }}</span>
      </Label>
      <Select
        :model-value="fetcherId"
        @update:model-value="$emit('selectFetcher', String($event))"
      >
        <SelectTrigger class="h-8 text-[12px]" data-testid="quota-type-select">
          <SelectValue :placeholder="t('settings.providerEdit.quotaTypePlaceholder')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="opt in fetcherOptions"
            :key="opt.value"
            :value="opt.value"
          >{{ opt.label }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <!-- 启用开关 -->
    <div class="flex items-center justify-between py-1.5">
      <span class="text-[12px] text-neutral-fg">
        {{ t('settings.providerEdit.quotaEnable') }}
        <span class="text-[10px] text-neutral-dim">{{ t('settings.providerEdit.quotaEnableHint') }}</span>
      </span>
      <Switch
        :model-value="enabled"
        data-testid="quota-enabled-switch"
        :disabled="configuring"
        @update:model-value="$emit('toggleEnabled')"
      />
    </div>

    <!-- API Key 类：凭证状态 + 专属 API Key 输入（可选）+ 操作按钮 -->
    <template v-if="!isCookieAuth">
      <div class="flex items-center justify-between py-1">
        <span class="text-[11px] text-neutral-mid">{{ t('settings.providerEdit.quotaAuthMethod') }}</span>
        <span v-if="apiKeySet" class="flex items-center gap-1 text-[11px] text-success">
          <CheckCircle2 class="size-3" />
          {{ t('settings.providerEdit.quotaCredentialOk') }}
        </span>
        <span v-else class="text-[11px] text-danger">{{ t('settings.providerEdit.quotaCredentialMissing') }}</span>
      </div>

      <!--
        专属 API Key（可选）：适配 router/反代场景。
        provider 的 baseUrl 可能指向本地 router，provider.apiKey 是 router 的 key，
        而 Coding Plan 平台（bigmodel.cn 等）需要平台专属 key。
        留空 = 复用上方填写的 provider API Key。
      -->
      <div class="mt-1.5">
        <Label class="mb-1 block text-[10px] text-neutral-mid">
          {{ t('settings.providerEdit.quotaApiKey') }}
          <span class="normal-case text-neutral-dim">{{ t('settings.providerEdit.quotaApiKeyHint') }}</span>
        </Label>
        <div class="flex gap-1.5">
          <Input
            :model-value="apiKeyInput"
            type="password"
            class="h-8 flex-1 font-mono text-[11px]"
            :placeholder="apiKeyConfigured ? t('settings.providerEdit.quotaApiKeySetPlaceholder') : t('settings.providerEdit.quotaApiKeyPlaceholder')"
            data-testid="quota-apikey-input"
            @update:model-value="$emit('update:apiKeyInput', String($event ?? ''))"
          />
          <Button
            variant="secondary"
            class="gap-1 px-2 py-1 text-[11px] text-neutral-mid"
            :disabled="configuring"
            data-testid="quota-save-apikey-btn"
            @click="$emit('saveApiKey')"
          >
            <Loader2 v-if="configuring" class="animate-spin" />
            {{ t('settings.providerEdit.quotaSaveApiKey') }}
          </Button>
        </div>
      </div>

      <!-- 操作按钮（仅启用时显示） -->
      <div v-if="enabled" class="mt-2 flex gap-1.5">
        <Button
          variant="secondary"
          class="gap-1 px-2 py-1 text-[11px] text-neutral-mid [&_svg]:size-3"
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
          <span class="text-[11px] text-neutral-fg">Cookie</span>
          <span v-if="cookieSet" class="text-[10px] text-success">{{ t('settings.providerEdit.quotaCookieSet') }}</span>
          <span v-else class="text-[10px] text-neutral-dim">{{ t('settings.providerEdit.quotaCookieNotSet') }}</span>
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
      <p v-if="helpUrl" class="mt-1.5 flex items-start gap-1 text-[10px] text-neutral-dim">
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
          class="gap-1 px-2 py-1 text-[11px] text-neutral-mid [&_svg]:size-3"
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
          class="gap-1 px-2 py-1 text-[11px] text-neutral-mid [&_svg]:size-3"
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

    <!-- 测试查询成功 + 内联额度预览（3 窗口行） -->
    <div v-if="testStatus === 'success' && quotaRow" class="mt-2" data-testid="quota-result">
      <div class="flex items-center gap-1.5 text-[11px] text-success">
        <CheckCircle2 class="size-3" />
        {{ t('settings.providerEdit.quotaTestSuccess') }}
        <span v-if="lastFetchAt" class="text-neutral-dim">· {{ formatTimeAgo(lastFetchAt) }}</span>
      </div>
      <div class="mt-2 rounded-sm border border-border bg-bg-input p-2.5">
        <div
          v-for="(win, idx) in visibleWindows"
          :key="idx"
          class="flex items-center justify-between py-0.5 text-[11px]"
        >
          <span class="font-mono text-[10px] uppercase tracking-wide text-neutral-mid">{{ windowLabels[idx] }}</span>
          <span v-if="win.pct !== null" class="font-semibold tabular-nums text-neutral-fg">
            {{ Math.round(win.pct) }}%
            <span v-if="win.resetSec !== null" class="ml-1 font-normal text-neutral-dim">· {{ formatResetSec(win.resetSec) }}</span>
          </span>
          <span v-else class="text-neutral-dim">∞</span>
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
import { computed } from 'vue'
import { Loader2, RefreshCw, CheckCircle2, AlertCircle, ExternalLink } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import type { NormalizedQuotaRow } from '@xyz-agent/shared'
import { QUOTA_PRESETS } from '@xyz-agent/shared'
import type { QuotaTestStatus } from '@/composables/features/useQuotaConfigure'

const props = withDefaults(defineProps<{
  /** 当前选中的 fetcher id（未选择 = undefined） */
  fetcherId?: string
  /** 下拉框选项列表（value=fetcher id, label=显示名）。默认 QUOTA_PRESETS。 */
  fetcherOptions?: Array<{ value: string; label: string }>
  enabled: boolean
  cookieInput: string
  /** Coding Plan 专属 API Key 输入值（api-key 类，留空 = 复用 provider.apiKey） */
  apiKeyInput?: string
  /** 是否已配置专属 API Key（控制占位符提示） */
  apiKeyConfigured?: boolean
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
}>(), {
  // fetcherId 默认 undefined（未选择任何类型）
  fetcherId: undefined,
  apiKeyInput: '',
  apiKeyConfigured: false,
  // 默认选项 = QUOTA_PRESETS（5 个内置类型），调用方一般无需传
  fetcherOptions: () => QUOTA_PRESETS.map((p) => ({ value: p.fetcher, label: p.label })),
})

defineEmits<{
  /** 选择 fetcher 类型（父组件更新 quota.fetcher） */
  selectFetcher: [value: string]
  toggleEnabled: []
  testQuery: []
  saveCookie: []
  /** 保存专属 API Key（api-key 类） */
  saveApiKey: []
  'update:cookieInput': [value: string]
  'update:apiKeyInput': [value: string]
}>()

const { t } = useI18n()

// ── 时间换算常量 ──
const MS_PER_SEC = 1000
const SEC_PER_MIN = 60
const MIN_PER_HOUR = 60
const HOUR_PER_DAY = 24
const SEC_PER_HOUR = SEC_PER_MIN * MIN_PER_HOUR

/** 三窗口标签（i18n 化，与 QuotaWins 顺序对齐：5h / 本周 / 本月）。 */
const windowLabels = [
  t('settings.providerEdit.quotaWindow5h'),
  t('settings.providerEdit.quotaWindowWeek'),
  t('settings.providerEdit.quotaWindowMonth'),
]

/** 可见窗口项（过滤 pct=null 的 ∞ 窗口）。 */
interface VisibleWindow {
  idx: number
  pct: number | null
  resetSec: number | null
}

const visibleWindows = computed<VisibleWindow[]>(() => {
  const row = props.quotaRow
  if (!row) return []
  return row.wins.map((w, i) => ({ idx: i, pct: w.pct, resetSec: w.resetSec }))
})

/** 格式化时间戳为相对时间（i18n 化）。 */
function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / MS_PER_SEC)
  if (sec < SEC_PER_MIN) return t('settings.providerEdit.quotaTimeAgoSeconds', { n: sec })
  const min = Math.floor(sec / SEC_PER_MIN)
  if (min < MIN_PER_HOUR) return t('settings.providerEdit.quotaTimeAgoMinutes', { n: min })
  const hr = Math.floor(min / MIN_PER_HOUR)
  if (hr < HOUR_PER_DAY) return t('settings.providerEdit.quotaTimeAgoHours', { n: hr })
  const day = Math.floor(hr / HOUR_PER_DAY)
  return t('settings.providerEdit.quotaTimeAgoDays', { n: day })
}

/** 格式化剩余秒数为紧凑时间（i18n 化，如 '1h23m' / '3d12h'）。 */
function formatResetSec(sec: number): string {
  if (sec <= 0) return t('settings.providerEdit.quotaResetEmpty')
  const h = Math.floor(sec / SEC_PER_HOUR)
  if (h >= HOUR_PER_DAY) {
    const d = Math.floor(h / HOUR_PER_DAY)
    const rh = h % HOUR_PER_DAY
    return rh > 0
      ? t('settings.providerEdit.quotaResetDays', { d, h: rh })
      : t('settings.providerEdit.quotaResetDays', { d, h: 0 })
  }
  const m = Math.floor((sec % SEC_PER_HOUR) / SEC_PER_MIN)
  return m > 0
    ? t('settings.providerEdit.quotaResetHours', { h, m })
    : t('settings.providerEdit.quotaResetHours', { h, m: 0 })
}
</script>
