<script setup lang="ts">
/**
 * 内置 Provider 快速配置面板（wave 3 · builtin-provider-ui）。
 *
 * Dialog 弹层：只读展示 template 元信息（name/baseUrl/api/内置模型数）+ 凭据二选一
 * （API Key 明文 / $ENV 环境变量引用）+ 取消/保存。保存时构造方案 B 占位 SetProviderData
 * （DM4：只写 {name, api, baseUrl, apiKey}，不写 models，pi 运行时用内置 catalog），
 * emit('save', { providerId, data }) 上抛，父调 config.setProvider。
 *
 * emit 上抛模式（DM2）：不 inject、不 import @/api，与 ProviderImportMenu 一致。
 * open 受控：父 v-model 风格传 open prop；任何关闭路径（X/ESC/遮罩/取消）统一 emit('cancel')。
 *
 * 凭据二选一无 RadioGroup，用两个互斥 Button（segmented 风格）切 credentialMode，
 * 与项目现有 Button 用法一致（DM4）。
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, EyeOff } from '@lucide/vue'
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

const props = defineProps<{
  template: BuiltinProviderTemplate
  open: boolean
}>()

const emit = defineEmits<{
  save: [payload: { providerId: string; data: SetProviderData }]
  cancel: []
}>()

const { t } = useI18n()

/** 凭据模式（envVars 为空时强制 plaintext，env 模式不可选） */
const credentialMode = ref<CredentialMode>('plaintext')
/** 明文 API Key 输入 */
const apiKeyInput = ref('')
/** 选中的环境变量名（默认预填 template.envVars[0]） */
const envVar = ref('')
/** 是否明文显示 API Key */
const showKey = ref(false)

/** template 是否支持环境变量方式（envVars 非空） */
const envSupported = computed(() => props.template.envVars.length > 0)

/** template 切换时重置表单（envVar 默认取首个，模式回 plaintext） */
watch(
  () => props.template,
  (tpl) => {
    envVar.value = tpl.envVars[0] ?? ''
    apiKeyInput.value = ''
    showKey.value = false
    credentialMode.value = 'plaintext'
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

/** 保存：构造方案 B 占位 data（无 models），emit 上抛 */
function onSave(): void {
  const apiKey =
    credentialMode.value === 'plaintext'
      ? apiKeyInput.value
      : envVar.value
        ? `$${envVar.value}`
        : ''
  const data: SetProviderData = {
    name: props.template.name,
    ...(props.template.api ? { api: props.template.api } : {}),
    ...(props.template.baseUrl ? { baseUrl: props.template.baseUrl } : {}),
    apiKey,
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
        <span class="text-neutral-fg">{{ t('settings.provider.builtinTemplate.modelsSuffix', { count: template.modelCount }) }}</span>
      </div>

      <!-- 凭据区 -->
      <div class="flex flex-col gap-2">
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

        <!-- env 模式：环境变量下拉 -->
        <Select
          v-else
          v-model="envVar"
        >
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
          </SelectContent>
        </Select>
      </div>

      <!-- 底部操作区 -->
      <div class="flex justify-end gap-2">
        <Button variant="secondary" size="dense" @click="emit('cancel')">
          {{ t('settings.providerEdit.cancel') }}
        </Button>
        <Button
          size="dense"
          data-testid="provider-quick-setup-save"
          :disabled="credentialMode === 'plaintext' && !apiKeyInput.trim()"
          @click="onSave"
        >
          {{ t('settings.provider.builtinTemplate.save') }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
