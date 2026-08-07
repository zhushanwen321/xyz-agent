<script setup lang="ts">
/**
 * 内置 Provider 快速配置面板（wave 3 · builtin-provider-ui）。
 *
 * Dialog 弹层：只读展示 template 元信息（name/baseUrl/api/内置模型数）+ 凭据区 + 取消/保存。
 * 保存时构造方案 B 占位 SetProviderData（DM4：只写 {name, api, baseUrl, apiKey}，不写 models，
 * pi 运行时用内置 catalog），emit('save', { providerId, data }) 上抛，父调 config.setProvider。
 *
 * 凭据区按 template.authMode 条件渲染（F1 · design §6.3「认证方式只展示该 provider 支持的」）：
 *  - api_key：明文 + 环境变量（纯 key provider，如 openai）
 *  - both：   明文 + 环境变量 + OAuth 提示（Phase 2 禁用，如 anthropic/github-copilot）
 *  - oauth：  OAuth-only，无 key 输入，保存禁用（如 openai-codex）
 *  - ambient：云凭证说明文案，无 key 输入，保存放行但不带 apiKey（google-vertex/amazon-bedrock）
 *
 * emit 上抛模式（DM2）：不 inject、不 import @/api，与 ProviderImportMenu 一致。
 * open 受控：父 v-model 风格传 open prop；任何关闭路径（X/ESC/遮罩/取消）统一 emit('cancel')。
 *
 * 凭据二选一无 RadioGroup，用两个互斥 Button（segmented 风格）切 credentialMode，
 * 与项目现有 Button 用法一致（DM4）。
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, EyeOff, Lock, Cloud } from '@lucide/vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Button,
  Label,
} from '@xyz-agent/ui'
import type { BuiltinProviderTemplate, SetProviderData } from '@xyz-agent/shared'

type CredentialMode = 'plaintext' | 'env'

/** 「自定义变量名」Select sentinel value（F4 · §6.4：下拉含常见 env var + 自定义入口） */
const CUSTOM_ENV_VALUE = '__custom__'

const props = defineProps<{
  template: BuiltinProviderTemplate
  open: boolean
}>()

const emit = defineEmits<{
  save: [payload: { providerId: string; data: SetProviderData }]
  cancel: []
}>()

const { t } = useI18n()

/** 凭据模式（envVars 非空时默认 env，空回退 plaintext——F3 §6.3 mockup 环境变量是默认推荐） */
const credentialMode = ref<CredentialMode>('plaintext')
/** 明文 API Key 输入 */
const apiKeyInput = ref('')
/** 选中的环境变量名（默认预填 template.envVars[0]，或 CUSTOM_ENV_VALUE 走自定义输入） */
const envVar = ref('')
/** 自定义环境变量名输入（F4：选中「自定义变量名」后出现） */
const customEnvVar = ref('')
/** 是否明文显示 API Key */
const showKey = ref(false)

/** template 是否支持环境变量方式（envVars 非空） */
const envSupported = computed(() => props.template.envVars.length > 0)

// ── F1 认证方式分支（design §6.3）──
/** 展示明文/环境变量凭据区的模式（api_key 纯 key / both 双支持） */
const showKeyCredentials = computed(
  () => props.template.authMode === 'api_key' || props.template.authMode === 'both',
)
/** oauth-only：Phase 2 提示 + 保存禁用 */
const isOauthOnly = computed(() => props.template.authMode === 'oauth')
/** ambient：云凭证说明，无 key 输入，保存放行 */
const isAmbient = computed(() => props.template.authMode === 'ambient')
/** both：追加「支持 OAuth（Phase 2）」提示行 */
const showOauthHint = computed(() => props.template.authMode === 'both')

/** 当前生效的 env var 名（自定义 sentinel 时取输入框值） */
const resolvedEnvVar = computed(() =>
  envVar.value === CUSTOM_ENV_VALUE ? customEnvVar.value.trim() : envVar.value,
)

/** 保存禁用：oauth-only 恒禁用；api_key/both 明文模式空 key 禁用 */
const saveDisabled = computed(
  () =>
    isOauthOnly.value ||
    (showKeyCredentials.value &&
      credentialMode.value === 'plaintext' &&
      !apiKeyInput.value.trim()),
)

/** template 切换时重置表单（envVar 默认取首个，模式按 envVars 非空取 env） */
watch(
  () => props.template,
  (tpl) => {
    envVar.value = tpl.envVars[0] ?? ''
    customEnvVar.value = ''
    apiKeyInput.value = ''
    showKey.value = false
    credentialMode.value = tpl.envVars.length > 0 ? 'env' : 'plaintext'
  },
  { immediate: true },
)

/** open 受控代理：关闭（X/ESC/遮罩）即上抛 cancel，由父决定后续状态 */
const openProxy = computed<boolean>({
  get: () => props.open,
  set: (v) => {
    if (!v) emit('cancel')
  },
})

/** 切换凭据模式（env 模式在 envVars 为空时禁用） */
function setMode(mode: CredentialMode): void {
  if (mode === 'env' && !envSupported.value) return
  credentialMode.value = mode
}

/** 保存：构造方案 B 占位 data（无 models），oauth/ambient 不塞 apiKey（F1），emit 上抛 */
function onSave(): void {
  const data: SetProviderData = {
    name: props.template.name,
    ...(props.template.api ? { api: props.template.api } : {}),
    ...(props.template.baseUrl ? { baseUrl: props.template.baseUrl } : {}),
  }
  if (showKeyCredentials.value) {
    data.apiKey =
      credentialMode.value === 'plaintext'
        ? apiKeyInput.value
        : resolvedEnvVar.value
          ? `$${resolvedEnvVar.value}`
          : ''
  }
  emit('save', { providerId: props.template.id, data })
}
</script>

<template>
  <Dialog v-model:open="openProxy">
    <DialogContent
      data-testid="provider-quick-setup"
      class="max-w-md"
    >
      <DialogHeader>
        <DialogTitle>{{ t('settings.provider.builtinTemplate.setupTitle', { name: template.name }) }}</DialogTitle>
      </DialogHeader>

      <!-- 只读信息区 -->
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-[12px]">
        <span class="text-neutral-dim">{{ t('settings.provider.builtinTemplate.infoApi') }}</span>
        <span class="truncate text-neutral-fg">{{ template.api || '—' }}</span>
        <span class="text-neutral-dim">{{ t('settings.provider.builtinTemplate.infoBaseUrl') }}</span>
        <span class="truncate text-neutral-fg">{{ template.baseUrl || '—' }}</span>
        <span class="text-neutral-dim">{{ t('settings.provider.builtinTemplate.infoModels') }}</span>
        <!-- F7b：模型数带「保存后自动可用」说明（B4 override-only 落盘后行内 models.length=0 是预期的） -->
        <span class="text-neutral-fg">{{ t('settings.provider.builtinTemplate.modelsAutoHint', { count: template.modelCount }) }}</span>
      </div>

      <!-- 凭据区（F1：按 authMode 分支渲染） -->
      <div class="flex flex-col gap-2">
        <!-- api_key / both：明文 + 环境变量 -->
        <template v-if="showKeyCredentials">
          <Label class="text-[11px] font-semibold text-neutral-mid">
            {{ t('settings.provider.builtinTemplate.credentialModeLabel') }}
          </Label>
          <!-- 凭据模式切换（segmented） -->
          <div class="flex gap-1.5">
            <Button
              :variant="credentialMode === 'plaintext' ? 'default' : 'secondary'"
              size="dense"
              data-testid="credential-mode-plaintext"
              @click="setMode('plaintext')"
            >
              {{ t('settings.provider.builtinTemplate.credentialModePlaintext') }}
            </Button>
            <Button
              :variant="credentialMode === 'env' ? 'default' : 'secondary'"
              size="dense"
              :disabled="!envSupported"
              :title="envSupported ? '' : t('settings.provider.builtinTemplate.envUnsupported')"
              data-testid="credential-mode-env"
              @click="setMode('env')"
            >
              {{ t('settings.provider.builtinTemplate.credentialModeEnv') }}
            </Button>
          </div>

          <!-- 明文模式：API Key 输入 + 显示切换 -->
          <div v-if="credentialMode === 'plaintext'" class="flex items-center gap-2">
            <Input
              v-model="apiKeyInput"
              :type="showKey ? 'text' : 'password'"
              :placeholder="t('settings.providerEdit.apiKeyPlaceholderEmpty')"
              class="flex-1"
              data-testid="credential-apikey-input"
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
          </div>

          <!-- env 模式：环境变量下拉（常见 env var + 自定义变量名，F4 §6.4） -->
          <template v-else>
            <Select v-model="envVar">
              <SelectTrigger data-testid="credential-envvar-select">
                <SelectValue :placeholder="t('settings.provider.builtinTemplate.envVarPlaceholder')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="ev in template.envVars"
                  :key="ev"
                  :value="ev"
                >
                  {{ ev }}
                </SelectItem>
                <SelectItem :value="CUSTOM_ENV_VALUE">
                  {{ t('settings.provider.builtinTemplate.envVarCustom') }}
                </SelectItem>
              </SelectContent>
            </Select>
            <!-- 选中「自定义变量名」后出现手动输入框 -->
            <Input
              v-if="envVar === CUSTOM_ENV_VALUE"
              v-model="customEnvVar"
              :placeholder="t('settings.provider.builtinTemplate.envVarCustomPlaceholder')"
              class="h-8"
              data-testid="credential-envvar-custom"
            />
          </template>

          <!-- both：OAuth 提示（Phase 2 禁用按钮占位，design §6.3） -->
          <p
            v-if="showOauthHint"
            data-testid="credential-oauth-hint"
            class="flex items-center gap-1.5 rounded-sm bg-surface-2 px-2.5 py-1.5 text-[11px] text-neutral-mid"
          >
            <Lock class="size-3.5 shrink-0 text-neutral-dim" />
            {{ t('settings.provider.builtinTemplate.oauthSupportedHint') }}
          </p>
        </template>

        <!-- oauth-only：Phase 2 提示，保存禁用（避免添加 pi 永不消费 key 的 provider） -->
        <div
          v-else-if="isOauthOnly"
          data-testid="credential-oauth-only"
          class="flex items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-3 py-2.5 text-[12px] text-neutral-mid"
        >
          <Lock class="size-4 shrink-0 text-neutral-dim" />
          {{ t('settings.provider.builtinTemplate.oauthOnlyHint') }}
        </div>

        <!-- ambient：云凭证说明（ADC / AWS），无 key 输入 -->
        <div
          v-else-if="isAmbient"
          data-testid="credential-ambient"
          class="flex items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-3 py-2.5 text-[12px] text-neutral-mid"
        >
          <Cloud class="size-4 shrink-0 text-neutral-dim" />
          {{ t('settings.provider.builtinTemplate.ambientHint') }}
        </div>
      </div>

      <!-- 底部操作区 -->
      <div class="flex justify-end gap-2">
        <Button variant="secondary" size="dense" @click="emit('cancel')">
          {{ t('settings.providerEdit.cancel') }}
        </Button>
        <Button
          size="dense"
          data-testid="provider-quick-setup-save"
          :disabled="saveDisabled"
          @click="onSave"
        >
          {{ t('settings.provider.builtinTemplate.save') }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
