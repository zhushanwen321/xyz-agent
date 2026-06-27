<template>
  <!--
    Provider 编辑/添加弹窗（draft-provider.html §1 pmodal）。
    左右布局：左 = 凭据配置，右 = 模型清单。
    所有表单控件使用 ui 基础组件（Input / Select / Button），无原生 select/button。
  -->
  <Dialog :open="!!provider" @update:open="emit('close')">
    <!-- hide-close：标题栏已自绘关闭 X，隐藏 DialogContent 默认右上角 X，避免双 X（同 SettingsModal） -->
    <DialogContent hide-close class="flex max-w-[780px] flex-col overflow-hidden p-0">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between border-b border-border px-5 py-4">
        <span class="text-[15px] font-semibold text-fg">{{ provider ? '编辑供应商' : '添加供应商' }}</span>
        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0 text-muted hover:bg-surface-hover hover:text-fg"
          aria-label="关闭"
          @click="emit('close')"
        >
          <X class="size-4" />
        </Button>
      </div>

      <div v-if="provider" class="flex min-h-0 flex-1 overflow-hidden">
        <!-- 左：凭据配置 -->
        <div class="flex w-[340px] shrink-0 flex-col gap-4 border-r border-border p-5">
          <!-- 名称 -->
          <div>
            <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">名称</Label>
            <Input v-model="form.name" placeholder="My Provider" />
          </div>

          <!-- 类型 -->
          <div>
            <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">
              类型 <span class="normal-case tracking-normal">决定 baseUrl 默认值与是否需要 API Key</span>
            </Label>
            <Select v-model="form.api">
              <SelectTrigger class="h-9">
                <SelectValue placeholder="选择类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anthropic-messages">Anthropic Messages</SelectItem>
                <SelectItem value="openai-completions">OpenAI Compatible</SelectItem>
                <SelectItem value="ollama">Ollama · 本地（无需 Key）</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <!-- Base URL -->
          <div>
            <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">Base URL</Label>
            <Input v-model="form.baseUrl" placeholder="https://api.anthropic.com" />
          </div>

          <!-- API Key -->
          <div>
            <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">
              API Key <span class="normal-case tracking-normal">仅本地加密存储</span>
            </Label>
            <div class="flex items-center gap-2">
              <Input
                v-model="form.apiKey"
                :type="showKey ? 'text' : 'password'"
                :placeholder="provider.apiKeySet ? '••••••••（已设置）' : 'sk-...'"
                class="flex-1"
              />
              <Button
                variant="ghost"
                class="size-8 shrink-0 rounded-sm p-0 text-subtle hover:bg-surface-hover hover:text-fg"
                :aria-label="showKey ? '隐藏密钥' : '显示密钥'"
                @click="showKey = !showKey"
              >
                <EyeOff v-if="showKey" class="size-4" />
                <Eye v-else class="size-4" />
              </Button>
            </div>
          </div>

          <!-- 操作按钮 -->
          <div class="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              class="gap-1.5 px-2.5 py-1.5 text-[12px] text-muted [&_svg]:size-3.5"
              :disabled="testing"
              @click="testConnection"
            >
              <Loader2 v-if="testing" class="animate-spin" />
              <Wifi v-else />
              {{ testing ? '测试中...' : '测试连接' }}
            </Button>
            <Button
              variant="secondary"
              class="gap-1.5 px-2.5 py-1.5 text-[12px] text-muted [&_svg]:size-3.5"
              :disabled="discovering"
              @click="autoDiscover"
            >
              <Loader2 v-if="discovering" class="animate-spin" />
              <RefreshCw v-else />
              {{ discovering ? '发现中...' : '自动发现模型' }}
            </Button>
          </div>

          <!-- 测试/发现结果 -->
          <div v-if="testResult" class="flex items-center gap-1.5 text-[12px]" :class="testResult === 'ok' ? 'text-success' : 'text-danger'">
            <CheckCircle2 v-if="testResult === 'ok'" class="size-3.5" />
            <AlertCircle v-else class="size-3.5" />
            {{ testResult === 'ok' ? `连接成功，找到 ${localModels.length} 个模型` : '连接失败，请检查 API Key' }}
          </div>
          <div v-if="discoverResult" class="text-[12px] text-muted">{{ discoverResult }}</div>
        </div>

        <!-- 右：模型清单 -->
        <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div class="flex items-center justify-between border-b border-border px-5 py-3">
            <span class="text-[13px] font-semibold text-fg">模型清单</span>
            <Button variant="ghost" class="h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline" @click="showAddModel = !showAddModel">
              {{ showAddModel ? '收起' : '+ 手动添加' }}
            </Button>
          </div>

          <!-- 手动添加模型表单（两行：模型名 + 输入类型 / 上下文 + 思考 + 添加）。
               原单行把名称列挤到过窄、输入类型按钮占宽过大；改两行给名称留足空间。 -->
          <div v-if="showAddModel" class="border-b border-border bg-surface px-5 py-3">
            <!-- 第 1 行：模型名称（占满）+ 输入类型分段 -->
            <div class="flex items-end gap-3">
              <div class="min-w-0 flex-1">
                <Label class="mb-1 block text-[10px] text-muted">模型名称</Label>
                <Input v-model="newModel.name" placeholder="gpt-4o" class="h-8 text-[12px]" />
              </div>
              <div>
                <Label class="mb-1 block text-[10px] text-muted">输入类型</Label>
                <div class="flex h-8 gap-0.5 rounded-md border border-border bg-surface-2 p-0.5">
                  <Button
                    variant="ghost"
                    class="h-full gap-1 rounded-sm px-2 text-[10px] hover:bg-transparent [&_svg]:size-3"
                    :class="newModel.inputType === 'text' ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'"
                    @click="newModel.inputType = 'text'"
                  ><FileText /> 文本</Button>
                  <Button
                    variant="ghost"
                    class="h-full gap-1 rounded-sm px-2 text-[10px] hover:bg-transparent [&_svg]:size-3"
                    :class="newModel.inputType === 'image' ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'"
                    @click="newModel.inputType = 'image'"
                  ><ImageIcon /> 图片</Button>
                </div>
              </div>
            </div>
            <!-- 第 2 行：上下文 + 思考 + 添加 -->
            <div class="mt-3 flex items-end gap-3">
              <div>
                <Label class="mb-1 block text-[10px] text-muted">上下文</Label>
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
                <Label class="mb-1 block text-[10px] text-muted">思考</Label>
                <Select v-model="newModel.thinking">
                  <SelectTrigger class="h-8 w-[130px] px-2 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="s in thinkingStrategies" :key="s.key" :value="s.key">{{ s.fullLabel }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button class="h-8 shrink-0 px-3 text-[12px]" @click="addModel">添加</Button>
            </div>
          </div>

          <!-- 模型列表 -->
          <div class="min-h-0 flex-1 overflow-y-auto">
            <div v-if="!localModels.length" class="py-8 text-center text-[12px] text-muted">暂无模型</div>

            <!-- 表头。非名称列统一 text-center，与下方行 value 单元格对齐方式一致，
                 解决 head(text-right) 与 value(icon 居中 / select 左对齐) 错位。
                 列宽收窄：右三列原 80/96/112=288 → 56/80/96=232，给「模型」名列腾出 56px，
                 避免 glm-5-turbo / claude-sonnet-4-5 等较长 id 被 truncate。 -->
            <div v-if="localModels.length" class="flex items-center border-b border-border bg-surface px-5 py-2 text-center text-[10px] uppercase tracking-wider text-subtle">
              <span class="flex-1 text-left">模型</span>
              <span class="w-14">输入</span>
              <span class="w-[80px]">上下文</span>
              <span class="w-24">思考</span>
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
                  title="文本输入"
                  @click.stop="toggleInput(m, 'text')"
                ><FileText /></Button>
                <Button
                  variant="ghost"
                  class="h-auto shrink-0 rounded-sm border p-1 hover:bg-transparent [&_svg]:size-3.5"
                  :class="m.input?.includes('image') ? 'border-accent bg-accent-soft text-accent' : 'border-border text-subtle opacity-60 hover:opacity-100'"
                  title="图片输入"
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
                    <SelectItem v-for="s in thinkingStrategies" :key="s.key" :value="s.key">{{ s.fullLabel }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <!-- 移除 -->
              <Button
                variant="ghost"
                class="size-5 w-8 shrink-0 rounded-sm p-0 text-subtle hover:bg-transparent hover:text-danger [&_svg]:size-3"
                aria-label="移除模型"
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
        <Button variant="ghost" @click="emit('close')">取消</Button>
        <Button :disabled="saving" @click="onSave">
          {{ saving ? '保存中…' : '保存' }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import {
  Eye, EyeOff, Loader2, Wifi, RefreshCw, CheckCircle2, AlertCircle,
  X, FileText, ImageIcon,
} from '@lucide/vue'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import type { ProviderInfo } from '@xyz-agent/shared'
import { config } from '@/api'

const props = defineProps<{ provider: ProviderInfo | null }>()
const emit = defineEmits<{ close: [] }>()

// ── Types ──

interface LocalModel {
  id: string
  name?: string
  reasoning?: boolean
  contextWindow?: number
  input?: Array<'text' | 'image'>
  thinkingLevelMap?: Record<string, string | null>
}

type ThinkingStrategy = 'all-levels' | 'on-off' | 'high-max'

// ── Constants ──

const ctxOptions = [
  { label: '128K', value: 128_000 },
  { label: '200K', value: 200_000 },
  { label: '256K', value: 256_000 },
  { label: '512K', value: 512_000 },
  { label: '1M', value: 1_000_000 },
]

const THINKING_PRESETS: Record<ThinkingStrategy, Record<string, string | null> | undefined> = {
  'all-levels': undefined,
  'on-off': { minimal: null, low: null, medium: null, high: null, xhigh: 'xhigh' },
  'high-max': { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: 'max' },
}

const thinkingStrategies: Array<{ key: ThinkingStrategy; fullLabel: string }> = [
  { key: 'all-levels', fullLabel: 'All Levels' },
  { key: 'on-off', fullLabel: 'On / Off' },
  { key: 'high-max', fullLabel: 'High / Max' },
]

// ── State ──

const showKey = ref(false)
const testing = ref(false)
const discovering = ref(false)
const testResult = ref<'ok' | 'error' | null>(null)
const discoverResult = ref('')
const showAddModel = ref(false)
const localModels = ref<LocalModel[]>([])
const saving = ref(false)
/** 动作错误（保存/测试/发现失败时显示在底栏，非静默吞） */
const actionError = ref('')

const form = reactive({ name: '', api: 'anthropic-messages', baseUrl: '', apiKey: '' })
const newModel = reactive({ name: '', contextWindow: 200_000, inputType: 'text' as 'text' | 'image', thinking: 'on-off' as ThinkingStrategy })

// ── Helpers ──

function getStrategyFromMap(map?: Record<string, string | null>): ThinkingStrategy {
  if (!map) return 'all-levels'
  if (map.xhigh === 'max') return 'high-max'
  return 'on-off'
}

// ── Actions ──

watch(() => props.provider, (p) => {
  if (p) {
    form.name = p.name
    form.api = p.api ?? 'anthropic-messages'
    form.baseUrl = p.baseUrl ?? ''
    form.apiKey = ''
    showKey.value = false
    testResult.value = null
    discoverResult.value = ''
    showAddModel.value = false
    actionError.value = ''
    localModels.value = p.models.map((m) => ({ ...m }))
  }
})

/**
 * 测试连接：复用 discoverModels 探活（W08 决策——domain 无独立 testConnection 协议）。
 * 成功（success:true）= 连接可达；失败显示错误。
 */
async function testConnection() {
  testing.value = true
  testResult.value = null
  actionError.value = ''
  try {
    const res = await config.discoverModels({
      baseUrl: form.baseUrl,
      apiKey: form.apiKey || undefined,
      providerType: form.api,
      providerId: props.provider?.id,
    })
    testResult.value = res.success ? 'ok' : 'error'
    if (!res.success && res.error) actionError.value = res.error
  } catch (e) {
    testResult.value = 'error'
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    testing.value = false
  }
}

/**
 * 自动发现模型：调 config.discoverModels，成功后合并结果到 localModels。
 * 运行时通过 discoverModelsFromApi 探活目标 baseUrl，返回可用模型清单。
 */
async function autoDiscover() {
  discovering.value = true
  discoverResult.value = ''
  actionError.value = ''
  try {
    const res = await config.discoverModels({
      baseUrl: form.baseUrl,
      apiKey: form.apiKey || undefined,
      providerType: form.api,
      providerId: props.provider?.id,
    })
    if (res.success) {
      // 合并发现的模型（去重：已存在的 id 跳过）
      const existing = new Set(localModels.value.map((m) => m.id))
      const merged = res.models.filter((m) => !existing.has(m.id))
      localModels.value.push(...merged.map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
      })))
      discoverResult.value = `已发现 ${res.models.length} 个模型，${merged.length > 0 ? `新增 ${merged.length} 个已合并` : '均已存在'}`
    } else {
      actionError.value = res.error ?? '发现失败'
    }
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    discovering.value = false
  }
}

/**
 * 保存：调 config.setProvider（新建用 providerId=form.name，编辑用原 id）。
 * 状态经 onProviders 订阅推回（单一数据源，避免竞态）。
 */
async function onSave() {
  saving.value = true
  actionError.value = ''
  const providerId = props.provider?.id ?? form.name
  try {
    await config.setProvider(providerId, {
      name: form.name,
      type: form.api,
      baseUrl: form.baseUrl,
      apiKey: form.apiKey || undefined,
      models: localModels.value.map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        thinkingLevelMap: m.thinkingLevelMap,
      })),
    })
    emit('close')
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

function toggleInput(m: LocalModel, type: 'text' | 'image') {
  if (!m.input) m.input = []
  const idx = m.input.indexOf(type)
  if (idx >= 0) m.input.splice(idx, 1)
  else m.input.push(type)
}

function updateCtx(m: LocalModel, value: number) {
  m.contextWindow = value
}

function pickStrategy(m: LocalModel, strategy: ThinkingStrategy) {
  m.thinkingLevelMap = THINKING_PRESETS[strategy] ? structuredClone(THINKING_PRESETS[strategy]) : undefined
}

function addModel() {
  const name = newModel.name.trim()
  if (!name) return
  localModels.value.push({
    id: name,
    name,
    contextWindow: newModel.contextWindow,
    input: [newModel.inputType],
    thinkingLevelMap: THINKING_PRESETS[newModel.thinking] ? structuredClone(THINKING_PRESETS[newModel.thinking]) : undefined,
  })
  newModel.name = ''
}

function removeModel(index: number) {
  localModels.value.splice(index, 1)
}
</script>
