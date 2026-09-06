<template>
  <!--
    ProviderTestDiscoverSection —— 「测试连接 / 自动发现」按钮行 + 结果反馈。
    从 ProviderEditBody 抽出的独立模板块（纯展示 + 事件上抛，零内部状态）：
    RPC 编排与结果状态（testing/discovering/testResult/discoverResult）由父组件
    的 useProviderEdit 持有，本组件经 @test/@discover 通知父组件发起。
  -->
  <div>
    <div class="flex flex-wrap gap-2">
      <Button
        variant="secondary"
        class="gap-1.5 px-2.5 py-1.5 text-[12px] text-neutral-mid [&_svg]:size-3.5"
        :disabled="testing || discovering"
        @click="emit('test')"
      >
        <Loader2 v-if="testing" class="animate-spin" />
        <Wifi v-else />
        {{ testing ? t('settings.providerEdit.testing') : t('settings.providerEdit.testConnection') }}
      </Button>
      <Button
        variant="secondary"
        class="gap-1.5 px-2.5 py-1.5 text-[12px] text-neutral-mid [&_svg]:size-3.5"
        :disabled="discovering || testing"
        @click="emit('discover')"
      >
        <Loader2 v-if="discovering" class="animate-spin" />
        <RefreshCw v-else />
        {{ discovering ? t('settings.providerEdit.discovering') : t('settings.providerEdit.autoDiscover') }}
      </Button>
    </div>

    <div v-if="testResult" class="flex items-center gap-1.5 text-[12px]" :class="testResult === 'ok' ? 'text-success' : 'text-danger'">
      <CheckCircle2 v-if="testResult === 'ok'" class="size-3.5" />
      <AlertCircle v-else class="size-3.5" />
      {{ testResult === 'ok' ? t('settings.providerEdit.testOk', { count: modelCount }) : t('settings.providerEdit.testFail') }}
    </div>
    <div v-if="discoverResult" class="text-[12px] text-neutral-mid">{{ discoverResult }}</div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@xyz-agent/ui'
import { useI18n } from 'vue-i18n'
import { Loader2, Wifi, RefreshCw, CheckCircle2, AlertCircle } from '@lucide/vue'

defineProps<{
  /** 测试连接进行中（spinner + 按钮互斥 disabled） */
  testing: boolean
  /** 自动发现进行中 */
  discovering: boolean
  /** 测试连接结果（null = 未测试；ok/error 决定成功/失败反馈行） */
  testResult: 'ok' | 'error' | null
  /** 自动发现结果文案（空 = 未发现） */
  discoverResult: string
  /** 测试成功文案的模型数（t 的 {count} 命名参数） */
  modelCount: number
}>()

const emit = defineEmits<{
  /** 发起测试连接（RPC 编排在父组件 useProviderEdit.testConnection） */
  test: []
  /** 发起自动发现 */
  discover: []
}>()

const { t } = useI18n()
</script>
