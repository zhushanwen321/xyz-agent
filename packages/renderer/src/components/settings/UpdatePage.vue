<!--
  Settings · 更新代理配置页。
  代理模式选择 + 手动模式下 HTTP/HTTPS 代理输入 + 测试代理连接。
-->
<template>
  <div class="flex max-w-[860px] flex-col gap-3">
    <!-- 卡 1：预下载设置 -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">{{ t('settings.update.preDownloadTitle') }}</h3>
        <p class="mt-0.5 text-[11px] text-muted">{{ t('settings.update.preDownloadDesc') }}</p>
      </div>
      <div class="border-t border-border">
        <div class="flex items-center justify-between px-4 py-3">
          <Label class="text-[12px] text-fg">{{ t('settings.update.preDownloadLabel') }}</Label>
          <Switch
            data-testid="switch-pre-download"
            :model-value="preDownload"
            :disabled="preDownloadSaving"
            @update:model-value="onTogglePreDownload"
          />
        </div>
      </div>
    </div>

    <!-- 卡 2：代理配置 -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">{{ t('settings.update.sectionTitle') }}</h3>
        <p class="mt-0.5 text-[11px] text-muted">{{ t('settings.update.sectionDesc') }}</p>
      </div>
      <div class="border-t border-border">
        <!-- 代理模式 -->
        <div class="flex items-center justify-between px-4 py-3">
          <Label class="text-[12px] text-fg">{{ t('settings.update.proxyMode') }}</Label>
          <Select
            :model-value="localConfig.mode"
            @update:model-value="(v) => onModeChange(String(v))"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{{ t('settings.update.proxyModeSystem') }}</SelectItem>
              <SelectItem value="manual">{{ t('settings.update.proxyModeManual') }}</SelectItem>
              <SelectItem value="disabled">{{ t('settings.update.proxyModeDisabled') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- HTTP 代理（手动模式） -->
        <div v-if="localConfig.mode === 'manual'" class="border-t border-border px-4 py-3">
          <Label class="mb-2 block text-[12px] text-fg">{{ t('settings.update.httpProxy') }}</Label>
          <Input
            v-model="localConfig.httpProxy"
            :placeholder="t('settings.update.httpProxyPlaceholder')"
            class="h-8 text-[12px]"
            data-testid="input-http-proxy"
          />
        </div>

        <!-- HTTPS 代理（手动模式） -->
        <div v-if="localConfig.mode === 'manual'" class="border-t border-border px-4 py-3">
          <Label class="mb-2 block text-[12px] text-fg">{{ t('settings.update.httpsProxy') }}</Label>
          <Input
            v-model="localConfig.httpsProxy"
            :placeholder="t('settings.update.httpsProxyPlaceholder')"
            class="h-8 text-[12px]"
            data-testid="input-https-proxy"
          />
        </div>
      </div>
    </div>

    <!-- 操作栏 -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <!-- 测试代理按钮 -->
        <Button
          variant="ghost"
          size="sm"
          :disabled="testing || localConfig.mode === 'disabled'"
          :title="localConfig.mode === 'disabled' ? t('settings.update.testProxyTooltipDisabled') : undefined"
          class="gap-1.5 text-[12px]"
          data-testid="btn-test-proxy"
          @click="onTestProxy"
        >
          <Zap v-if="!testing" class="size-3.5" />
          <Loader2 v-else class="size-3.5 animate-spin" />
          <span>{{ testing ? t('settings.update.testing') : t('settings.update.testProxy') }}</span>
        </Button>
      </div>

      <div class="flex items-center gap-2">
        <!-- 测试结果 -->
        <span
          v-if="testResult !== null"
          class="text-[11px]"
          :class="{
            'text-success': testResult.status === 'success',
            'text-danger': testResult.status === 'failed',
            'text-muted': testResult.status === 'skipped',
          }"
          data-testid="test-proxy-result"
        >
          {{ testResult.status === 'success'
            ? t('settings.update.testSuccess')
            : testResult.status === 'skipped'
              ? (testResult.message ?? '')
              : t('settings.update.testFailed', { msg: testResult.message ?? '' })
          }}
        </span>

        <!-- 保存按钮 -->
        <Button
          size="sm"
          :disabled="saving"
          class="gap-1.5 text-[12px]"
          data-testid="btn-save-proxy"
          @click="onSave"
        >
          <Save v-if="!saving" class="size-3.5" />
          <Loader2 v-else class="size-3.5 animate-spin" />
          <span>{{ saving ? t('settings.update.saving') : t('settings.update.save') }}</span>
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { Zap, Save, Loader2 } from '@lucide/vue'
import type { IProxyConfig } from '@xyz-agent/shared'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getProxyConfig, setProxyConfig, testProxy, getUpdateSettings, setUpdateSettings } from '@/api/domains/settings'
import { useToast } from '@/composables/useToast'

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

// ── State ──

/** 本地代理配置（双向绑定，保存时写入 main 进程） */
const localConfig = reactive<IProxyConfig>({
  mode: 'system',
  httpProxy: '',
  httpsProxy: '',
})

/** 测试中 */
const testing = ref(false)
/** 保存中 */
const saving = ref(false)
/** 测试结果（null=未测试） */
type TestResult = { status: 'success' } | { status: 'failed'; message?: string } | { status: 'skipped'; message?: string }
const testResult = ref<TestResult | null>(null)

/** 预下载开关（从 main 进程加载，切换时立即持久化） */
const preDownload = ref(false)
/** 预下载开关持久化中（切换时短暂 disable 控件） */
const preDownloadSaving = ref(false)

// ── Lifecycle ──

/** 加载当前配置 */
async function loadConfig() {
  // 代理配置与预下载设置并行加载（独立数据源）
  const results = await Promise.allSettled([
    getProxyConfig(),
    getUpdateSettings(),
  ])
  // 代理配置
  if (results[0].status === 'fulfilled') {
    const config = results[0].value
    localConfig.mode = config.mode
    localConfig.httpProxy = config.httpProxy ?? ''
    localConfig.httpsProxy = config.httpsProxy ?? ''
  } else {
    // best-effort：加载失败时使用默认配置（system mode），不影响页面渲染
    console.error('[UpdatePage] load proxy config failed:', results[0].reason)
  }
  // 预下载设置
  if (results[1].status === 'fulfilled') {
    preDownload.value = results[1].value.preDownload
  } else {
    console.error('[UpdatePage] load update settings failed:', results[1].reason)
  }
}

onMounted(loadConfig)

/** 切换预下载开关（立即持久化到 main 进程） */
async function onTogglePreDownload(value: boolean | string): Promise<void> {
  const enabled = value === true
  preDownloadSaving.value = true
  try {
    await setUpdateSettings({ preDownload: enabled })
    preDownload.value = enabled
  } catch (err) {
    // 持久化失败：恢复控件到原值，toast 提示
    toastError(err instanceof Error ? err.message : String(err))
  } finally {
    preDownloadSaving.value = false
  }
}

// ── Actions ──

/** 代理模式枚举（与 SelectItem value 一一对应）。 */
const PROXY_MODES = ['system', 'manual', 'disabled'] as const
type ProxyMode = (typeof PROXY_MODES)[number]

/** 运行时守卫：把 Select 的字符串 value 收敛为 ProxyMode 字面量联合（无需 as 断言）。 */
function isProxyMode(value: string): value is ProxyMode {
  return (PROXY_MODES as readonly string[]).includes(value)
}

/**
 * 模式切换。
 * Select 的 SelectItem value 恒为字符串，但 reka-ui 事件载荷是 AcceptableValue，
 * 故在绑定处 String() 收敛为 string；这里再用 isProxyMode 守卫收敛为字面量联合。
 */
function onModeChange(value: string) {
  if (!isProxyMode(value)) return
  localConfig.mode = value
  // 切换到非手动模式时清空手动配置
  if (value !== 'manual') {
    localConfig.httpProxy = ''
    localConfig.httpsProxy = ''
  }
  // 清空测试结果
  testResult.value = null
}

/** 测试代理 */
async function onTestProxy() {
  // disabled 模式不发起测试：代理未启用，测试无意义，直接给出提示而非误导性的成功
  if (localConfig.mode === 'disabled') {
    testResult.value = { status: 'skipped', message: t('settings.update.testDisabled') }
    return
  }

  testing.value = true
  testResult.value = null

  try {
    const config: IProxyConfig = {
      mode: localConfig.mode,
      httpProxy: localConfig.httpProxy || undefined,
      httpsProxy: localConfig.httpsProxy || undefined,
    }
    const res = await testProxy(config)
    testResult.value = res.success
      ? { status: 'success' }
      : { status: 'failed', message: res.message }
  } catch (err) {
    testResult.value = {
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
    }
  } finally {
    testing.value = false
  }
}

/** 保存配置 */
async function onSave() {
  // 基本前端校验
  if (localConfig.mode === 'manual') {
    if (!localConfig.httpProxy) {
      toastError(t('settings.update.httpProxyRequired'))
      return
    }
    // 验证 URL 格式
    try {
      new URL(localConfig.httpProxy)
      if (localConfig.httpsProxy) new URL(localConfig.httpsProxy)
    } catch {
      toastError(t('settings.update.invalidUrl'))
      return
    }
  }

  saving.value = true

  try {
    const config: IProxyConfig = {
      mode: localConfig.mode,
      httpProxy: localConfig.httpProxy || undefined,
      httpsProxy: localConfig.httpsProxy || undefined,
    }
    await setProxyConfig(config)
    toastInfo(t('settings.update.saved'))
  } catch (err) {
    toastError(t('settings.update.saveFailed', { msg: err instanceof Error ? err.message : String(err) }))
  } finally {
    saving.value = false
  }
}
</script>
