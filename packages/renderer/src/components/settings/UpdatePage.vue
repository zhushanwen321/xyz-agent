<!--
  Settings · 更新代理配置页。
  代理模式选择 + 手动模式下 HTTP/HTTPS 代理输入 + 测试代理连接。
-->
<template>
  <div class="flex max-w-[860px] flex-col gap-3">
    <!-- 卡 1：代理配置 -->
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
            @update:model-value="onModeChange"
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
          :disabled="testing"
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
          :class="testResult.success ? 'text-success' : 'text-danger'"
          data-testid="test-proxy-result"
        >
          {{ testResult.success
            ? t('settings.update.testSuccess')
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
          <span>{{ saving ? t('settings.update.save') + '...' : t('settings.update.save') }}</span>
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getProxyConfig, setProxyConfig, testProxy } from '@/api/domains/settings'
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
const testResult = ref<{ success: boolean; message?: string } | null>(null)

// ── Lifecycle ──

/** 加载当前配置 */
async function loadConfig() {
  try {
    const config = await getProxyConfig()
    localConfig.mode = config.mode
    localConfig.httpProxy = config.httpProxy ?? ''
    localConfig.httpsProxy = config.httpsProxy ?? ''
  } catch (err) {
    // best-effort：加载失败时使用默认配置（system mode），不影响页面渲染
    console.error('[UpdatePage] loadConfig failed:', err)
  }
}

onMounted(loadConfig)

// ── Actions ──

/** 模式切换 */
function onModeChange(value: unknown) {
  const mode = value as IProxyConfig['mode']
  if (!mode || !['system', 'manual', 'disabled'].includes(mode)) return
  localConfig.mode = mode
  // 切换到非手动模式时清空手动配置
  if (mode !== 'manual') {
    localConfig.httpProxy = ''
    localConfig.httpsProxy = ''
  }
  // 清空测试结果
  testResult.value = null
}

/** 测试代理 */
async function onTestProxy() {
  testing.value = true
  testResult.value = null

  try {
    const config: IProxyConfig = {
      mode: localConfig.mode,
      httpProxy: localConfig.httpProxy || undefined,
      httpsProxy: localConfig.httpsProxy || undefined,
    }
    testResult.value = await testProxy(config)
  } catch (err) {
    testResult.value = {
      success: false,
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
      toastError(t('settings.update.httpProxy') + ' is required')
      return
    }
    // 验证 URL 格式
    try {
      new URL(localConfig.httpProxy)
      if (localConfig.httpsProxy) new URL(localConfig.httpsProxy)
    } catch {
      toastError(t('settings.update.testFailed', { msg: 'Invalid URL format' }))
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
