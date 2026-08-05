<template>
  <!--
    ProviderEditBody —— Provider 手风琴就地编辑体（R4 · 取代 ProviderEditModal 双层 modal）。
    由 ProviderPage 在展开行内渲染，承载原 ProviderEditModal 的全部表单字段：
    凭据（名称/类型/baseUrl/apiKey/authHeader/headers）+ Coding Plan 额度 + 测试/发现 +
    模型清单（ModelListSection）+ sticky save-bar（dirty 时出现，保存/放弃）。

    业务编排全在 useProviderEdit composable（core 域），本组件只做展示 + 事件绑定，
    与原 ProviderEditModal 同构，仅换 UI 载体（Dialog → 裸 div）。
    dirty 状态经 @dirty-change 上抛父组件做展开切换守卫；保存/取消经 @saved/@cancel 通知父收起。
  -->
  <div class="flex flex-col">
    <!-- 凭据 + 额度 + 验证（左侧区，垂直堆叠） -->
    <div class="flex flex-col gap-4 px-5 py-4">
      <!-- 名称 -->
      <div>
        <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">{{ t('settings.providerEdit.fieldName') }}</Label>
        <Input
          v-model="form.name"
          data-testid="provider-edit-name"
          :placeholder="t('settings.providerEdit.fieldNamePlaceholder')"
        />
      </div>

      <!-- 类型 -->
      <div>
        <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">
          {{ t('settings.providerEdit.fieldType') }}
          <span class="normal-case tracking-normal">{{ t('settings.providerEdit.fieldTypeHint') }}</span>
        </Label>
        <Select v-model="form.api">
          <SelectTrigger class="h-9">
            <SelectValue :placeholder="t('settings.providerEdit.selectTypePlaceholder')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="anthropic-messages">{{ t('settings.providerEdit.apiAnthropic') }}</SelectItem>
            <SelectItem value="openai-completions">{{ t('settings.providerEdit.apiOpenai') }}</SelectItem>
            <SelectItem value="openai-responses">{{ t('settings.providerEdit.apiOpenaiResponses') }}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <!-- Base URL -->
      <div>
        <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">{{ t('settings.providerEdit.fieldBaseUrl') }}</Label>
        <Input v-model="form.baseUrl" placeholder="https://api.anthropic.com" />
      </div>

      <!-- API Key -->
      <div>
        <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">
          {{ t('settings.providerEdit.fieldApiKey') }}
          <span class="normal-case tracking-normal">{{ t('settings.providerEdit.apiKeyHint') }}</span>
        </Label>
        <div class="flex items-center gap-2">
          <Input
            v-model="form.apiKey"
            :type="showKey ? 'text' : 'password'"
            :placeholder="provider?.apiKeySet ? t('settings.providerEdit.apiKeyPlaceholderSet') : t('settings.providerEdit.apiKeyPlaceholderEmpty')"
            class="flex-1"
          />
          <Button
            variant="ghost"
            class="size-8 shrink-0 rounded-sm p-0 text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg"
            :aria-label="showKey ? t('settings.providerEdit.hideKey') : t('settings.providerEdit.showKey')"
            @click="showKey = !showKey"
          >
            <EyeOff v-if="showKey" class="size-4" />
            <Eye v-else class="size-4" />
          </Button>
          <Button
            v-if="provider?.apiKeySet && form.apiKey !== '__CLEAR__'"
            variant="ghost"
            class="size-8 shrink-0 rounded-sm p-0 text-neutral-dim hover:bg-danger-soft hover:text-danger"
            :aria-label="t('settings.providerEdit.clearKey')"
            :title="t('settings.providerEdit.clearKey')"
            @click="clearApiKey"
          >
            <Trash2 class="size-4" />
          </Button>
        </div>
        <p class="mt-1 text-[10px] text-neutral-dim">
          {{ t('settings.providerEdit.apiKeyNoteKeep') }}{{ provider?.apiKeySet ? t('settings.providerEdit.apiKeyNoteClear') : '' }}
        </p>
      </div>

      <!-- authHeader 开关 -->
      <div class="flex items-center justify-between">
        <Label class="text-[11px] font-semibold text-neutral-mid">
          {{ t('settings.providerEdit.fieldAuthHeader') }}
          <span class="normal-case tracking-normal">{{ t('settings.providerEdit.authHeaderHint') }}</span>
        </Label>
        <Switch
          :model-value="form.authHeader"
          data-testid="auth-header-switch"
          :aria-label="t('settings.providerEdit.fieldAuthHeader')"
          @update:model-value="form.authHeader = $event as boolean"
        />
      </div>

      <!-- headers 行编辑 -->
      <div data-testid="headers-editor">
        <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">
          {{ t('settings.providerEdit.customHeaders') }}
          <span class="normal-case tracking-normal">{{ t('settings.providerEdit.customHeadersHint') }}</span>
        </Label>
        <div class="flex flex-col gap-1.5">
          <div
            v-for="(row, i) in headerRows"
            :key="i"
            class="flex items-center gap-1.5"
          >
            <Input
              v-model="row.key"
              :placeholder="t('settings.providerEdit.headerKeyPlaceholder')"
              class="h-8 flex-1 text-[12px]"
              @update:model-value="syncHeadersFromRows"
            />
            <Input
              v-model="row.value"
              :placeholder="t('settings.providerEdit.headerValuePlaceholder')"
              class="h-8 flex-1 text-[12px]"
              @update:model-value="syncHeadersFromRows"
            />
            <Button
              variant="ghost"
              class="size-8 shrink-0 rounded-sm p-0 text-neutral-dim hover:bg-transparent hover:text-danger [&_svg]:size-3.5"
              :aria-label="t('settings.providerEdit.removeHeader')"
              @click="removeHeader(i)"
            >
              <X />
            </Button>
          </div>
        </div>
        <Button
          variant="ghost"
          class="mt-1.5 h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline"
          @click="addHeader"
        >
          {{ t('settings.providerEdit.addHeader') }}
        </Button>
      </div>

      <!-- Coding Plan 额度查询 -->
      <CodingPlanSection
        :fetcher-id="quotaFetcherId"
        :fetcher-options="quotaFetcherOptions"
        :enabled="quotaEnabled"
        :cookie-input="quotaCookieInput"
        :api-key-input="quotaApiKeyInput"
        :api-key-configured="quotaApiKeyConfigured"
        :test-status="quotaTestStatus"
        :test-error-msg="quotaTestError"
        :quota-row="quotaData"
        :last-fetch-at="quotaLastFetchAt"
        :is-cookie-auth="quotaIsCookieAuth"
        :configuring="quotaConfiguring"
        :configure-error-msg="quotaConfigureError"
        :api-key-set="!!provider?.apiKeySet || !!provider?.quota?.apiKeySet"
        :cookie-set="!!provider?.quota?.cookieSet"
        :help-url="quotaHelpUrl"
        :help-text="quotaHelpText"
        @select-fetcher="quotaSelectFetcher"
        @toggle-enabled="quotaToggleEnabled"
        @test-query="quotaTestQuery"
        @save-cookie="quotaSaveCookie"
        @save-api-key="quotaSaveApiKey"
        @update:cookie-input="quotaCookieInput = $event"
        @update:api-key-input="quotaApiKeyInput = $event"
      />

      <!-- 测试连接 / 自动发现 -->
      <div class="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          class="gap-1.5 px-2.5 py-1.5 text-[12px] text-neutral-mid [&_svg]:size-3.5"
          :disabled="testing || discovering"
          @click="testConnection"
        >
          <Loader2 v-if="testing" class="animate-spin" />
          <Wifi v-else />
          {{ testing ? t('settings.providerEdit.testing') : t('settings.providerEdit.testConnection') }}
        </Button>
        <Button
          variant="secondary"
          class="gap-1.5 px-2.5 py-1.5 text-[12px] text-neutral-mid [&_svg]:size-3.5"
          :disabled="discovering || testing"
          @click="autoDiscover"
        >
          <Loader2 v-if="discovering" class="animate-spin" />
          <RefreshCw v-else />
          {{ discovering ? t('settings.providerEdit.discovering') : t('settings.providerEdit.autoDiscover') }}
        </Button>
      </div>

      <div v-if="testResult" class="flex items-center gap-1.5 text-[12px]" :class="testResult === 'ok' ? 'text-success' : 'text-danger'">
        <CheckCircle2 v-if="testResult === 'ok'" class="size-3.5" />
        <AlertCircle v-else class="size-3.5" />
        {{ testResult === 'ok' ? t('settings.providerEdit.testOk', { count: localModels.length }) : t('settings.providerEdit.testFail') }}
      </div>
      <div v-if="discoverResult" class="text-[12px] text-neutral-mid">{{ discoverResult }}</div>
    </div>

    <!-- 模型清单（ModelListSection：复用 ProviderEditModal 右侧子组件） -->
    <div class="border-t border-border">
      <ModelListSection
        v-model:show-add-model="showAddModel"
        @add-model="onAddModel"
      />
    </div>

    <!-- sticky save-bar：dirty 时出现（spec §4.3）。负 margin 撑满 expand-body padding。 -->
    <div
      v-if="isDirty"
      data-testid="provider-save-bar"
      class="sticky bottom-0 flex items-center gap-2 border-t border-border bg-surface px-5 py-3"
    >
      <span class="flex items-center gap-1.5 text-[12px] font-semibold text-warn">
        <span class="size-1.5 rounded-full bg-warn" />
        {{ t('settings.provider.unsavedBadge') }}
      </span>
      <span v-if="actionError" class="flex-1 truncate text-[12px] text-danger">{{ actionError }}</span>
      <span v-else class="flex-1" />
      <Button
        variant="ghost"
        data-testid="provider-cancel-btn"
        :disabled="saving"
        @click="emit('cancel')"
      >
        {{ t('settings.providerEdit.cancel') }}
      </Button>
      <Button
        data-testid="provider-save-btn"
        :disabled="saving"
        @click="onSave"
      >
        {{ saving ? t('settings.providerEdit.saving') : t('settings.providerEdit.save') }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Switch, Label } from '@xyz-agent/ui'
import { provide, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { computed, toRef } from 'vue'
import {
  Eye, EyeOff, Loader2, Wifi, RefreshCw, CheckCircle2, AlertCircle,
  X, Trash2,
} from '@lucide/vue'
import { matchQuotaPreset } from '@xyz-agent/shared'

import type { ProviderInfo } from '@xyz-agent/shared'
import {
  useProviderEdit,
} from '@xyz-agent/core'
import { useQuotaConfigureFactory as useQuotaConfigure } from './injection-keys'
import CodingPlanSection from './CodingPlanSection.vue'
import ModelListSection from './ModelListSection.vue'
import { useSettingsToast as useToast } from './injection-keys'

const props = defineProps<{ provider: ProviderInfo | null }>()
const emit = defineEmits<{
  saved: []
  cancel: []
  /** dirty 状态变化（true=有未保存改动）。父组件用于展开切换守卫 */
  dirtyChange: [value: boolean]
}>()

const { t } = useI18n()
const { info: toastInfo } = useToast()

// ── Coding Plan 额度查询：自动关联 + 配置 ──
const matchedPreset = computed(() => {
  const p = props.provider
  return matchQuotaPreset({ baseUrl: p?.baseUrl, name: p?.name })
})

const quotaFactory = useQuotaConfigure()

const {
  fetcherId: quotaFetcherId,
  fetcherOptions: quotaFetcherOptions,
  enabled: quotaEnabled,
  cookieInput: quotaCookieInput,
  apiKeyInput: quotaApiKeyInput,
  apiKeyConfigured: quotaApiKeyConfigured,
  testStatus: quotaTestStatus,
  testError: quotaTestError,
  quotaData,
  lastFetchAt: quotaLastFetchAt,
  isCookieAuth: quotaIsCookieAuth,
  helpUrl: quotaHelpUrl,
  helpText: quotaHelpText,
  configuring: quotaConfiguring,
  configureError: quotaConfigureError,
  toggleEnabled: quotaToggleEnabled,
  selectFetcher: quotaSelectFetcher,
  saveCookie: quotaSaveCookie,
  saveApiKey: quotaSaveApiKey,
  testQuery: quotaTestQuery,
} = quotaFactory(matchedPreset, toRef(props, 'provider'))

// 业务编排全在 composable
const {
  form,
  newModel,
  localModels,
  headerRows,
  showKey,
  testing,
  discovering,
  testResult,
  discoverResult,
  showAddModel,
  saving,
  actionError,
  isDirty,
  expandedCompat,
  getStrategyFromMap,
  testConnection,
  autoDiscover,
  save,
  clearApiKey,
  toggleInput,
  toggleNewInput,
  updateCtx,
  pickStrategy,
  addModel,
  removeModel,
  toggleCompatExpand,
  addHeader,
  removeHeader,
  syncHeadersFromRows,
} = useProviderEdit(toRef(props, 'provider'), { t })

// ModelListSection 经 provide('modelListDeps') 拿到状态/方法（与原 ProviderEditModal 同构）
provide('modelListDeps', {
  newModel,
  localModels,
  toggleNewInput,
  toggleInput,
  updateCtx,
  pickStrategy,
  getStrategyFromMap,
  removeModel,
  expandedCompat,
  toggleCompatExpand,
  providerApi: computed(() => form.api),
})

// dirty 上抛父组件（展开切换守卫）。immediate 让父组件初始即知当前 dirty 态
watch(isDirty, (v) => emit('dirtyChange', v), { immediate: true })

/** 添加模型：捕获 addModel 校验错填到 actionError（save-bar 显示） */
function onAddModel(): void {
  actionError.value = ''
  try {
    addModel()
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  }
}

/** 保存成功 → toast 反馈 + 上抛 @saved（父组件收起展开行；状态经 onProviders 订阅推回） */
async function onSave(): Promise<void> {
  const ok = await save()
  if (ok) {
    toastInfo(t('settings.saved'))
    emit('saved')
  }
}
</script>
