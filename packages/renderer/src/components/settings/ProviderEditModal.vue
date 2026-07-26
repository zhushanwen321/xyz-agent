<template>
  <!--
    Provider 编辑/添加弹窗（draft-provider.html §1 pmodel）。
    左右布局：左 = 凭据配置，右 = 模型清单。
    所有表单控件使用 ui 基础组件（Input / Select / Button），无原生 select/button。

    受控表单：业务编排（test/discover/save + 模型 CRUD）下沉 useProviderEdit，
    本组件只做展示 + 事件绑定（F1 拆分）。
  -->
  <Dialog :open="open" @update:open="requestClose">
    <!-- hide-close：标题栏已自绘关闭 X，隐藏 DialogContent 默认右上角 X，避免双 X（同 SettingsModal） -->
    <DialogContent hide-close class="flex max-h-[85vh] max-w-[780px] flex-col overflow-hidden p-0">
      <!-- 标题栏。DialogTitle/DialogDescription 给 reka-ui a11y context（视觉用自绘 span） -->
      <div class="flex items-center justify-between border-b border-border px-5 py-4">
        <DialogTitle class="text-[15px] font-semibold text-fg">{{ provider ? t('settings.providerEdit.editTitle') : t('settings.providerEdit.addTitle') }}</DialogTitle>
        <DialogDescription class="sr-only">{{ t('settings.providerEdit.dialogDescription') }}</DialogDescription>
        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0 text-muted hover:bg-surface-hover hover:text-fg"
          :aria-label="t('settings.close')"
          @click="requestClose"
        >
          <X class="size-4" />
        </Button>
      </div>

      <div class="flex min-h-0 flex-1 overflow-hidden">
        <!-- 左：凭据配置 -->
        <div class="flex w-[340px] shrink-0 flex-col gap-4 border-r border-border p-5">
          <!-- 名称 -->
          <div>
            <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">{{ t('settings.providerEdit.fieldName') }}</Label>
            <Input v-model="form.name" :placeholder="t('settings.providerEdit.fieldNamePlaceholder')" />
          </div>

          <!-- 类型 -->
          <div>
            <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">
              {{ t('settings.providerEdit.fieldType') }} <span class="normal-case tracking-normal">{{ t('settings.providerEdit.fieldTypeHint') }}</span>
            </Label>
            <Select v-model="form.api">
              <SelectTrigger class="h-9">
                <SelectValue :placeholder="t('settings.providerEdit.selectTypePlaceholder')" />
              </SelectTrigger>
              <SelectContent>
                <!-- value 严格对齐 PROVIDER_API_TYPES（pi 终值，runtime 不再翻译别名）。
                     pi 不支持 ollama 作为 api 标识：本地 ollama 用 OpenAI Compatible + baseUrl=http://localhost:11434 即可。 -->
                <SelectItem value="anthropic-messages">Anthropic Messages</SelectItem>
                <SelectItem value="openai-completions">OpenAI Compatible</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <!-- Base URL -->
          <div>
            <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">{{ t('settings.providerEdit.fieldBaseUrl') }}</Label>
            <Input v-model="form.baseUrl" placeholder="https://api.anthropic.com" />
          </div>

          <!-- API Key -->
          <div>
            <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">
              {{ t('settings.providerEdit.fieldApiKey') }} <span class="normal-case tracking-normal">{{ t('settings.providerEdit.apiKeyHint') }}</span>
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
                class="size-8 shrink-0 rounded-sm p-0 text-subtle hover:bg-surface-hover hover:text-fg"
                :aria-label="showKey ? t('settings.providerEdit.hideKey') : t('settings.providerEdit.showKey')"
                @click="showKey = !showKey"
              >
                <EyeOff v-if="showKey" class="size-4" />
                <Eye v-else class="size-4" />
              </Button>
              <!-- 清除已配置的 key（D18）：置哨兵，save 时发空串清空 -->
              <Button
                v-if="provider?.apiKeySet && form.apiKey !== '__CLEAR__'"
                variant="ghost"
                class="size-8 shrink-0 rounded-sm p-0 text-subtle hover:bg-danger-soft hover:text-danger"
                :aria-label="t('settings.providerEdit.clearKey')"
                :title="t('settings.providerEdit.clearKey')"
                @click="clearApiKey"
              >
                <Trash2 class="size-4" />
              </Button>
            </div>
            <!-- apiKey 编辑语义说明（D18）：留空保存=不改；已配置时提示清除按钮的作用 -->
            <p class="mt-1 text-[10px] text-subtle">
              {{ t('settings.providerEdit.apiKeyNoteKeep') }}{{ provider?.apiKeySet ? t('settings.providerEdit.apiKeyNoteClear') : '' }}
            </p>
          </div>

          <!-- authHeader 开关（W3 D7）：是否把 apiKey 写入 Authorization header -->
          <div class="flex items-center justify-between">
            <Label class="text-[11px] font-semibold uppercase tracking-wider text-muted">
              {{ t('settings.providerEdit.fieldAuthHeader') }} <span class="normal-case tracking-normal">{{ t('settings.providerEdit.authHeaderHint') }}</span>
            </Label>
            <Switch
              :model-value="form.authHeader"
              data-testid="auth-header-switch"
              :aria-label="t('settings.providerEdit.fieldAuthHeader')"
              @update:model-value="form.authHeader = $event as boolean"
            />
          </div>

          <!-- headers 编辑区（W3 D7）：key-value 行编辑 + 添加/删除 -->
          <div data-testid="headers-editor">
            <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">
              {{ t('settings.providerEdit.customHeaders') }} <span class="normal-case tracking-normal">{{ t('settings.providerEdit.customHeadersHint') }}</span>
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
                  class="size-8 shrink-0 rounded-sm p-0 text-subtle hover:bg-transparent hover:text-danger [&_svg]:size-3.5"
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

          <!-- Coding Plan 额度查询 Section（始终显示：手动选择类型，不再依赖自动匹配） -->
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

          <!-- 操作按钮 -->
          <div class="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              class="gap-1.5 px-2.5 py-1.5 text-[12px] text-muted [&_svg]:size-3.5"
              :disabled="testing || discovering"
              @click="testConnection"
            >
              <Loader2 v-if="testing" class="animate-spin" />
              <Wifi v-else />
              {{ testing ? t('settings.providerEdit.testing') : t('settings.providerEdit.testConnection') }}
            </Button>
            <Button
              variant="secondary"
              class="gap-1.5 px-2.5 py-1.5 text-[12px] text-muted [&_svg]:size-3.5"
              :disabled="discovering || testing"
              @click="autoDiscover"
            >
              <Loader2 v-if="discovering" class="animate-spin" />
              <RefreshCw v-else />
              {{ discovering ? t('settings.providerEdit.discovering') : t('settings.providerEdit.autoDiscover') }}
            </Button>
          </div>

          <!-- 测试/发现结果 -->
          <div v-if="testResult" class="flex items-center gap-1.5 text-[12px]" :class="testResult === 'ok' ? 'text-success' : 'text-danger'">
            <CheckCircle2 v-if="testResult === 'ok'" class="size-3.5" />
            <AlertCircle v-else class="size-3.5" />
            {{ testResult === 'ok' ? t('settings.providerEdit.testOk', { count: localModels.length }) : t('settings.providerEdit.testFail') }}
          </div>
          <div v-if="discoverResult" class="text-[12px] text-muted">{{ discoverResult }}</div>
        </div>

        <!-- 右：模型清单（抽到 ModelListSection 子组件，保持主模板 ≤400 行） -->
        <ModelListSection
          v-model:show-add-model="showAddModel"
          @add-model="onAddModel"
        />
      </div>

      <!-- 底栏 -->
      <div class="flex items-center gap-2 border-t border-border px-5 py-3.5">
        <span v-if="actionError" class="flex-1 text-[12px] text-danger">{{ actionError }}</span>
        <span v-else class="flex-1" />
        <Button variant="ghost" data-testid="provider-cancel-btn" @click="requestClose">{{ t('settings.providerEdit.cancel') }}</Button>
        <Button data-testid="provider-save-btn" :disabled="saving" @click="onSave">
          {{ saving ? t('settings.providerEdit.saving') : t('settings.providerEdit.save') }}
        </Button>
      </div>
    </DialogContent>

    <!-- 取消确认弹窗（D13）：有未保存改动时点取消/X/Esc → 二次确认 -->
    <ConfirmDialog
      v-model:open="confirmCloseOpen"
      variant="default"
      :title="t('settings.providerEdit.unsavedTitle')"
      :description="t('settings.providerEdit.unsavedDesc')"
      :confirm-text="t('settings.providerEdit.unsavedConfirm')"
      :cancel-text="t('settings.providerEdit.unsavedCancel')"
      @confirm="emit('close')"
    />
  </Dialog>
</template>

<script setup lang="ts">
import { ref, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { computed, toRef } from 'vue'
import {
  Eye, EyeOff, Loader2, Wifi, RefreshCw, CheckCircle2, AlertCircle,
  X, Trash2,
} from '@lucide/vue'
import { matchQuotaPreset } from '@xyz-agent/shared'
import { Dialog, DialogContent, DialogTitle, DialogDescription, ConfirmDialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import type { ProviderInfo } from '@xyz-agent/shared'
import {
  useProviderEdit,
} from '@/composables/features/useProviderEdit'
import { useQuotaConfigure } from '@/composables/features/useQuotaConfigure'
import CodingPlanSection from '@/components/settings/CodingPlanSection.vue'
import ModelListSection from '@/components/settings/ModelListSection.vue'
import { useToast } from '@/composables/useToast'

const props = defineProps<{ open: boolean; provider: ProviderInfo | null }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()

const { info: toastInfo } = useToast()

// ── Coding Plan 额度查询：自动关联 + 配置 ──

/**
 * 按 provider baseUrl/name 匹配内置预设，作为下拉框的自动推荐默认值。
 * 不再控制 Section 是否显示（始终显示），仅用于计算 fetcherId 的默认值。
 */
const matchedPreset = computed(() => {
  const p = props.provider
  return matchQuotaPreset({ baseUrl: p?.baseUrl, name: p?.name })
})

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
} = useQuotaConfigure(matchedPreset, toRef(props, 'provider'))

// 业务编排全在 composable：本组件只做 props/emit + 调用（受控表单，F1 拆分）
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
  // W3 D7：headers CRUD
  addHeader,
  removeHeader,
  syncHeadersFromRows,
} = useProviderEdit(toRef(props, 'provider'))

// ── 模型清单区注入：ModelListSection 经 provide('modelListDeps') 拿到这些状态/方法，避免 prop 传 newModel 触发 no-mutating-props
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
})

// ── D13：取消/关闭统一入口，有未保存改动时二次确认 ──

/** 取消确认弹窗开关（true=显示「未保存」确认） */
const confirmCloseOpen = ref(false)

/**
 * 关闭请求入口（X / 取消 / Dialog @update:open=false 统一走这里）。
 * - 保存进行中（saving=true）→ 直接关（save 自己处理反馈，不应被确认弹窗阻塞）
 * - 有未保存改动（isDirty=true）→ 弹确认，确认后才 close
 * - 无改动 → 直接 close
 * 注意：Dialog 的 @update:open 在 open=true 时也会触发（reka-ui 行为），
 * 此时 value=true 不是关闭请求，忽略。
 */
function requestClose(value?: boolean): void {
  // @update:open 传 boolean：仅 false 是关闭请求；true 忽略
  if (value === true) return
  if (saving.value) {
    emit('close')
    return
  }
  if (isDirty.value) {
    confirmCloseOpen.value = true
    return
  }
  emit('close')
}

/** 添加模型（D15a）：捕获 addModel 抛的校验错，填到 actionError（底栏显示） */
function onAddModel(): void {
  actionError.value = ''
  try {
    addModel()
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  }
}

/** 保存成功则 toastInfo 反馈 + 关闭弹窗（状态经 onProviders 订阅推回，避免竞态） */
async function onSave(): Promise<void> {
  const ok = await save()
  if (ok) {
    toastInfo(t('settings.saved'))
    emit('close')
  }
}
</script>
