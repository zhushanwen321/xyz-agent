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
    <DialogContent hide-close class="flex max-w-[780px] flex-col overflow-hidden p-0">
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
                class="size-8 shrink-0 rounded-sm p-0 text-subtle hover:bg-[rgba(239,68,68,0.12)] hover:text-danger"
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

        <!-- 右：模型清单 -->
        <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div class="flex items-center justify-between border-b border-border px-5 py-3">
            <span class="text-[13px] font-semibold text-fg">{{ t('settings.providerEdit.modelList') }}</span>
            <Button variant="ghost" class="h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline" @click="showAddModel = !showAddModel">
              {{ showAddModel ? t('settings.providerEdit.collapse') : t('settings.providerEdit.manualAdd') }}
            </Button>
          </div>

          <!-- 手动添加模型表单（两行：模型名 + 输入类型 / 上下文 + 思考 + 添加）。
               原单行把名称列挤到过窄、输入类型按钮占宽过大；改两行给名称留足空间。 -->
          <div v-if="showAddModel" class="border-b border-border bg-surface px-5 py-3">
            <!-- 第 1 行：模型名称（占满）+ 输入类型分段 -->
            <div class="flex items-end gap-3">
              <div class="min-w-0 flex-1">
                <Label class="mb-1 block text-[10px] text-muted">{{ t('settings.providerEdit.modelNameLabel') }}</Label>
                <Input v-model="newModel.name" :placeholder="t('settings.providerEdit.modelNamePlaceholder')" class="h-8 text-[12px]" />
              </div>
              <div>
                <Label class="mb-1 block text-[10px] text-muted">{{ t('settings.providerEdit.inputTypeLabel') }}</Label>
                <div class="flex h-8 gap-0.5 rounded-md border border-border bg-surface-2 p-0.5">
                  <Button
                    variant="ghost"
                    class="h-full gap-1 rounded-sm px-2 text-[10px] hover:bg-transparent [&_svg]:size-3"
                    :class="newModel.inputTypes.includes('text') ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'"
                    @click="toggleNewInput('text')"
                  ><FileText /> {{ t('settings.providerEdit.inputText') }}</Button>
                  <Button
                    variant="ghost"
                    class="h-full gap-1 rounded-sm px-2 text-[10px] hover:bg-transparent [&_svg]:size-3"
                    :class="newModel.inputTypes.includes('image') ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'"
                    @click="toggleNewInput('image')"
                  ><ImageIcon /> {{ t('settings.providerEdit.inputImage') }}</Button>
                </div>
              </div>
            </div>
            <!-- 第 2 行：上下文 + 思考 + 添加 -->
            <div class="mt-3 flex items-end gap-3">
              <div>
                <Label class="mb-1 block text-[10px] text-muted">{{ t('settings.providerEdit.contextLabel') }}</Label>
                <Select v-model="newModel.contextWindow">
                  <SelectTrigger class="h-8 w-[110px] px-2 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="o in ctxOptions" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label class="mb-1 block text-[10px] text-muted">{{ t('settings.providerEdit.thinkingLabel') }}</Label>
                <Select v-model="newModel.thinking">
                  <SelectTrigger class="h-8 w-[130px] px-1.5 py-0 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="s in thinkingStrategies" :key="s.key" :value="s.key">{{ t(s.labelKey) }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button class="h-8 shrink-0 px-3 text-[12px]" @click="onAddModel">{{ t('settings.providerEdit.addBtn') }}</Button>
            </div>
          </div>

          <!-- 模型列表 -->
          <div class="min-h-0 flex-1 overflow-y-auto">
            <div v-if="!localModels.length" class="py-8 text-center text-[12px] text-muted">{{ t('settings.providerEdit.noModels') }}</div>

            <!-- 表头。非名称列统一 text-center，与下方行 value 单元格对齐方式一致，
                 解决 head(text-right) 与 value(icon 居中 / select 左对齐) 错位。
                 列宽收窄：右三列原 80/96/112=288 → 56/80/96=232，给「模型」名列腾出 56px，
                 避免 glm-5-turbo / claude-sonnet-4-5 等较长 id 被 truncate。 -->
            <div v-if="localModels.length" class="flex items-center border-b border-border bg-surface px-5 py-2 text-center text-[10px] uppercase tracking-wider text-subtle">
              <span class="flex-1 text-left">{{ t('settings.providerEdit.modelLabel') }}</span>
              <span class="w-14">{{ t('settings.providerEdit.headInput') }}</span>
              <span class="w-[80px]">{{ t('settings.providerEdit.headContext') }}</span>
              <span class="w-24">{{ t('settings.providerEdit.headThinking') }}</span>
              <span class="w-8" />
            </div>

            <div
              v-for="(m, i) in localModels"
              :key="m.id"
              class="flex items-center border-b border-border px-5 py-2 text-[12px]"
            >
              <span class="flex-1 truncate font-mono text-fg">{{ m.id }}</span>
              <!-- 输入类型 icon 按钮：紧贴 icon，不撑满整行高。
                   Button 默认 h-9 撑满行高，显式 h-auto + p-1 让按钮贴合 icon（约 20px 见方）。 -->
              <div class="flex w-14 items-center justify-center gap-1">
                <Button
                  variant="ghost"
                  class="h-auto shrink-0 rounded-sm border p-1 hover:bg-transparent [&_svg]:size-3.5"
                  :class="m.input?.includes('text') ? 'border-accent bg-accent-soft text-accent' : 'border-border text-subtle opacity-60 hover:opacity-100'"
                  :title="t('settings.providerEdit.textInputTitle')"
                  @click.stop="toggleInput(m, 'text')"
                ><FileText /></Button>
                <Button
                  variant="ghost"
                  class="h-auto shrink-0 rounded-sm border p-1 hover:bg-transparent [&_svg]:size-3.5"
                  :class="m.input?.includes('image') ? 'border-accent bg-accent-soft text-accent' : 'border-border text-subtle opacity-60 hover:opacity-100'"
                  :title="t('settings.providerEdit.imageInputTitle')"
                  @click.stop="toggleInput(m, 'image')"
                ><ImageIcon /></Button>
              </div>
              <!-- 上下文（弹出 select）。placeholder 兜底 contextWindow=undefined（发现来的模型），
                   否则 SelectValue 无值时留空，触发器看起来「没文字」。 -->
              <div class="flex w-[80px] justify-center">
                <Select
                  :model-value="m.contextWindow"
                  @update:model-value="updateCtx(m, $event as number)"
                >
                  <SelectTrigger class="h-7 w-[72px] px-1.5 py-0 text-[11px]">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="o in ctxOptions" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <!-- 思考策略（弹出 select） -->
              <div class="flex w-24 justify-center">
                <Select
                  :model-value="getStrategyFromMap(m.thinkingLevelMap)"
                  @update:model-value="pickStrategy(m, $event as ThinkingStrategy)"
                >
                  <SelectTrigger class="h-7 w-[88px] px-1.5 py-0 text-[11px]">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="s in thinkingStrategies" :key="s.key" :value="s.key">{{ t(s.labelKey) }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <!-- 移除 -->
              <Button
                variant="ghost"
                class="size-5 w-8 shrink-0 rounded-sm p-0 text-subtle hover:bg-transparent hover:text-danger [&_svg]:size-3"
                :aria-label="t('settings.providerEdit.removeModel')"
                @click.stop="removeModel(i)"
              >
                <X />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <!-- 底栏 -->
      <div class="flex items-center gap-2 border-t border-border px-5 py-3.5">
        <span v-if="actionError" class="flex-1 text-[12px] text-danger">{{ actionError }}</span>
        <span v-else class="flex-1" />
        <Button variant="ghost" @click="requestClose">{{ t('settings.providerEdit.cancel') }}</Button>
        <Button :disabled="saving" @click="onSave">
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
import { ref, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Eye, EyeOff, Loader2, Wifi, RefreshCw, CheckCircle2, AlertCircle,
  X, FileText, ImageIcon, Trash2,
} from '@lucide/vue'
import { Dialog, DialogContent, DialogTitle, DialogDescription, ConfirmDialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import type { ProviderInfo } from '@xyz-agent/shared'
import {
  useProviderEdit,
  CONTEXT_OPTIONS,
  THINKING_STRATEGIES,
  type ThinkingStrategy,
} from '@/composables/features/useProviderEdit'
import { useToast } from '@/composables/useToast'

const props = defineProps<{ open: boolean; provider: ProviderInfo | null }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()

// 模板用的常量（composable 导出的纯数据）
const ctxOptions = CONTEXT_OPTIONS
const thinkingStrategies = THINKING_STRATEGIES

const { info: toastInfo } = useToast()

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
  // W3 D7：headers CRUD
  addHeader,
  removeHeader,
  syncHeadersFromRows,
} = useProviderEdit(toRef(props, 'provider'))

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
