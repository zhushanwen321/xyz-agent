<template>
  <!--
    ProviderEditBody —— Provider 手风琴就地编辑体（R4 · 取代 ProviderEditModal 双层 modal）。
    由 ProviderPage 在展开行内渲染，承载原 ProviderEditModal 的全部表单字段：
    凭据（名称/类型/baseUrl/凭证区[OAuth 状态 | apiKey]/authHeader/headers）+ Coding Plan 额度 +
    测试/发现 + 模型清单（custom=ModelListSection / catalog=混合列表）+ sticky save-bar。

    业务编排全在 useProviderEdit composable（core 域），本组件只做展示 + 事件绑定。
    OAuth 状态机不在此组件（ui 零 renderer import 铁律）：凭证区登录/切换按钮经
    @oauth-login 上抛父组件（ProviderPage 共享单实例 useProviderOAuth，无双 listener）。
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

      <!-- 凭证区（B-1：按 authMethod 条件化——oauth → OAuth 状态区 + 形态切换；
           api_key / env_var / ambient → 现有 API Key 输入不变。切换经确认弹窗，I9 双凭据互斥） -->
      <div v-if="isOauthForm" data-testid="provider-credential-oauth">
        <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">
          {{ t('settings.providerEdit.credentialLabel') }}
        </Label>
        <div class="flex flex-wrap items-center gap-2">
          <span
            v-if="oauthPresent"
            data-testid="oauth-status-loggedin"
            class="flex items-center gap-1.5 text-[12px] font-medium text-success"
          >
            <span class="size-1.5 rounded-full bg-success" />
            {{ t('settings.providerEdit.credentialOauthLoggedIn') }}
          </span>
          <span
            v-else
            data-testid="oauth-status-not-loggedin"
            class="text-[12px] font-medium text-warn"
          >{{ t('settings.providerEdit.credentialOauthNotLoggedIn') }}</span>
          <span class="flex-1" />
          <Button
            variant="secondary"
            class="h-7 px-2.5 text-[11px] text-neutral-mid"
            data-testid="oauth-relogin-btn"
            @click="emit('oauthLogin')"
          >
            {{ oauthPresent ? t('settings.providerEdit.credentialOauthRelogin') : t('settings.providerEdit.credentialOauthLogin') }}
          </Button>
          <!-- B-1 场景 C：退出登录（runtime config.oauthLogout 移除 auth.json 凭证）。
               RPC 编排在父组件（ui 零 renderer import），经 @oauth-logout 上抛。 -->
          <Button
            variant="ghost"
            class="h-7 px-2.5 text-[11px] text-neutral-dim"
            data-testid="oauth-logout-btn"
            @click="emit('oauthLogout')"
          >
            {{ t('settings.providerEdit.credentialOauthLogout') }}
          </Button>
        </div>
        <p class="mt-1 text-[10px] text-neutral-dim">{{ t('settings.providerEdit.credentialOauthHint') }}</p>
        <Button
          variant="ghost"
          class="mt-1.5 h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline"
          data-testid="auth-switch-to-apikey"
          @click="requestAuthSwitch('api_key')"
        >
          {{ t('settings.providerEdit.switchToApiKey') }}
        </Button>
      </div>
      <div v-else data-testid="provider-credential-apikey">
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
            data-testid="provider-edit-apikey"
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
        <Button
          v-if="oauthSupported"
          variant="ghost"
          class="mt-1.5 h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline"
          data-testid="auth-switch-to-oauth"
          @click="requestAuthSwitch('oauth')"
        >
          {{ t('settings.providerEdit.switchToOauth') }}
        </Button>
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
        :auth-kinds="quotaAuthKinds"
        :oauth-ready="oauthPresent"
        :test-fail-reason="quotaTestFailReason"
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

    <!--
      模型区（B-2 混合列表）。
      wave4 C4 决策边界修订（design §3.6 UI 决策 1，非推翻）：C4 禁止的是「修改内置模型定义」
      ——builtin 条目保持只读（pi 升级自动覆盖编辑无意义）；「追加自定义模型」与「对内置条目做
      参数 override」是 pi 原生支持的合法操作（D1 探针：builtin ∪ override 并集合并），非 C4
      禁止场景——故 catalog provider 开放自定义模型增删，保存只回传 override 条目。
    -->
    <div class="border-t border-border" :data-testid="isCatalog ? 'provider-models-mixed' : 'provider-models-editable'">
      <template v-if="isCatalog">
        <!-- builtin 只读列表（徽章「内置」；编辑/删除按钮刻意缺席——C4 边界） -->
        <div class="px-5 py-4" data-testid="provider-models-builtin">
          <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">
            {{ t('settings.providerEdit.builtinModelsLabel') }}
          </Label>
          <p class="mb-2 text-[10px] text-neutral-dim">{{ t('settings.providerEdit.catalogModelsMixedHint') }}</p>
          <ul v-if="builtinModels.length" class="flex flex-col gap-1">
            <li
              v-for="m in builtinModels"
              :key="m.id"
              data-testid="builtin-model-row"
              class="flex items-center gap-1.5 rounded-sm bg-surface px-2.5 py-1 text-[12px] text-neutral-mid"
            >
              <span class="font-medium text-neutral-fg">{{ m.name || m.id }}</span>
              <span class="text-[10px] text-neutral-dim">{{ m.id }}</span>
              <span
                data-testid="model-badge-builtin"
                class="ml-auto shrink-0 rounded-sm bg-surface-hover px-1.5 py-0.5 text-[9px] font-medium text-neutral-mid"
              >{{ t('settings.providerEdit.modelSourceBuiltin') }}</span>
            </li>
          </ul>
        </div>
        <!-- override 条目（徽章「自定义」）：复用 ModelListSection 行编辑能力 + 手动添加入口 -->
        <ModelListSection
          v-model:show-add-model="showAddModel"
          title-key="settings.providerEdit.customModelsLabel"
          :badge-text="t('settings.providerEdit.modelSourceOverride')"
          @add-model="onAddModel"
        />
      </template>
      <ModelListSection
        v-else
        v-model:show-add-model="showAddModel"
        @add-model="onAddModel"
      />
    </div>

    <!-- 形态切换确认弹窗（B-1：I9 双凭据互斥，双向切换均显式确认；取消不动凭证） -->
    <Dialog v-model:open="authSwitchDialogOpen">
      <DialogContent hide-close class="max-w-[360px]" data-testid="auth-switch-confirm-dialog">
        <DialogHeader>
          <DialogTitle>{{ authSwitchDialogTitle }}</DialogTitle>
          <DialogDescription>{{ authSwitchDialogDesc }}</DialogDescription>
        </DialogHeader>
        <div class="flex justify-end gap-2 pt-4">
          <Button
            variant="ghost"
            data-testid="auth-switch-cancel-btn"
            @click="authSwitchDialogOpen = false"
          >
            {{ t('settings.providerEdit.cancel') }}
          </Button>
          <Button data-testid="auth-switch-confirm-btn" @click="confirmAuthSwitch">
            {{ t('settings.providerEdit.switchConfirmBtn') }}
          </Button>
        </div>
      </DialogContent>
    </Dialog>

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
import { Button, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Switch, Label, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@xyz-agent/ui'
import { provide, watch, ref, computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Eye, EyeOff, Loader2, Wifi, RefreshCw, CheckCircle2, AlertCircle,
  X, Trash2,
} from '@lucide/vue'
import { matchQuotaPreset } from '@xyz-agent/shared'

import type { ProviderInfo } from '@xyz-agent/shared'
import {
  useProviderEdit,
} from '@xyz-agent/core'
import { useQuotaConfigureFactory as useQuotaConfigure } from '../injection-keys'
import CodingPlanSection from '../coding-plan/CodingPlanSection.vue'
import ModelListSection from '../common/ModelListSection.vue'
import { useSettingsToast as useToast } from '../injection-keys'

const props = defineProps<{
  provider: ProviderInfo | null
  /** auth.json 已有该 provider 的 OAuth 凭据（父组件 useProviderOAuth.oauthPresent，展开时刷新） */
  oauthPresent?: boolean
  /** 该 provider 支持 OAuth 登录（父组件按 builtinProviders 模板 oauthSupported 判定） */
  oauthSupported?: boolean
}>()
const emit = defineEmits<{
  saved: []
  cancel: []
  /** dirty 状态变化（true=有未保存改动）。父组件用于展开切换守卫 */
  dirtyChange: [value: boolean]
  /** OAuth 登录/重新登录（B-1：父组件驱动共享 useProviderOAuth 状态机 + OAuthDialog，单实例无双 listener） */
  oauthLogin: []
  /** OAuth 退出登录（B-1 场景 C：父组件调 config.oauthLogout 移除 auth.json 凭证并刷新 presence） */
  oauthLogout: []
}>()

const { t } = useI18n()
const { info: toastInfo } = useToast()

// wave4 C4 边界修订（B-2）：catalog provider 的 builtin 条目只读，override 条目开放增删
// （追加自定义模型是 pi 原生支持的合法操作，见模板区注释）。kind 缺失当作 custom（向后兼容）。
const isCatalog = computed(() => props.provider?.kind === 'catalog')

/** builtin 只读条目（B-2 徽章「内置」；override 条目在 localModels 内经 ModelListSection 编辑） */
const builtinModels = computed(() => props.provider?.models.filter((m) => m.source === 'builtin') ?? [])

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
  testFailReason: quotaTestFailReason,
  quotaData,
  lastFetchAt: quotaLastFetchAt,
  isCookieAuth: quotaIsCookieAuth,
  authKinds: quotaAuthKinds,
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

// ── B-1 凭证区条件化（需 form 已就绪，故置于 useProviderEdit 之后） ──

/** oauth 形态 → OAuth 状态区；api_key / env_var / ambient → 现有 API Key 输入（现状不动） */
const isOauthForm = computed(() => form.authMethod === 'oauth')

/** 形态切换目标（非 null = 确认弹窗打开） */
const pendingAuthSwitch = ref<'api_key' | 'oauth' | null>(null)
const authSwitchDialogOpen = computed({
  get: () => pendingAuthSwitch.value !== null,
  set: (open: boolean) => { if (!open) pendingAuthSwitch.value = null },
})
const authSwitchDialogTitle = computed(() => pendingAuthSwitch.value === 'oauth'
  ? t('settings.providerEdit.switchToOauthConfirmTitle')
  : t('settings.providerEdit.switchToApiKeyConfirmTitle'))
const authSwitchDialogDesc = computed(() => pendingAuthSwitch.value === 'oauth'
  ? t('settings.providerEdit.switchToOauthConfirmDesc')
  : t('settings.providerEdit.switchToApiKeyConfirmDesc'))

/** 发起形态切换（I9 双凭据互斥——确认后才动凭证形态） */
function requestAuthSwitch(target: 'api_key' | 'oauth'): void {
  pendingAuthSwitch.value = target
}

/** 确认切换：oauth→api_key 改本地形态（保存时 apiKey 覆写 auth.json OAuth 凭证，catalog 原生 I9）；
 *  api_key→oauth 上抛 oauthLogin（父驱动 flow，成功后 authMethod='oauth' 持久化并广播回推） */
function confirmAuthSwitch(): void {
  const target = pendingAuthSwitch.value
  pendingAuthSwitch.value = null
  if (target === 'api_key') {
    form.authMethod = 'api_key'
  } else if (target === 'oauth') {
    emit('oauthLogin')
  }
}

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
