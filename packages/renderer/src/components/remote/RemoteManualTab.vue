<script setup lang="ts">
/**
 * RemoteManualTab —— 手填 host/port/token tab（spec §七:159-216）。
 *
 * 流程：三个 Input（host 文本 / port 数字 / token 文本）→ 点「连接」按 Q2 规则拼接 url
 * → probeConnect 预探测 → 成功 saveProfile + activateRemote + location.reload()；
 * 失败按三态显示红色错误。host 为空 → 连接按钮 disabled。
 *
 * url 拼接（Q2）：host 已含 ws://|wss:// 前缀 → 直接用 + 补 port；否则拼 `ws://${host}:${port}`。
 * port 默认 '8080'。token 空 → 不 disable（probeConnect 空短路返 auth，UI 显示 auth 错误，ES2）。
 *
 * 依赖：probeConnect（s1）+ saveProfile/activateRemote（s1）+ classifyNetworkKind（s1）。
 * 约束：用 xyz-ui Input/Button，禁原生元素/emoji/硬编码颜色；template≤400/script≤300。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, AlertCircle } from '@lucide/vue'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { probeConnect } from '@/lib/remote/probe'
import { classifyNetworkKind } from '@/lib/remote/parse-connect-info'
import { saveProfile, activateRemote, getDeviceName, setDeviceName } from '@/lib/remote/connection-config'
import type { NetworkKind } from '@/lib/remote/types'

defineEmits<{
  (e: 'connected'): void
}>()

const { t } = useI18n()

/**
 * 默认 port：对齐 runtime/server CLI 默认端口（packages/shared BASE_PORT=3210），
 * 避免连本地 dev server 时用户还得手改端口。
 */
const DEFAULT_PORT = '3210'

const host = ref('')
const port = ref(DEFAULT_PORT)
const token = ref('')
/**
 * 设备名（预填 getDeviceName，改动写回 xyz-agent:device-name，spec §7.3）。
 * probeConnect/useConnection 的 auth 握手经 getDeviceName() 读取此处已持久化的值。
 */
const deviceName = ref(getDeviceName())
/** probeConnect 进行中 */
const probing = ref(false)
/** 最近一次探测失败归一结果（auth/network/timeout），null=未失败 */
const probeError = ref<'auth' | 'network' | 'timeout' | null>(null)

/** host 非空才可点连接（Q2：host 为空 disabled） */
const canConnect = computed(() => host.value.trim().length > 0 && !probing.value)

/**
 * url 拼接（Q2）：
 * - host 已含 ws://|wss:// 前缀 → 直接用 host 原文（若已含 :port 则保留，否则补 :${port}）
 * - host 无前缀 → 拼 `ws://${host}:${port}`
 */
const url = computed<string>(() => {
  const h = host.value.trim()
  if (!h) return ''
  const p = port.value.trim() || DEFAULT_PORT
  if (/^wss?:\/\//i.test(h)) {
    // host 已含 scheme：检查是否已含 port（scheme://host:port 而非 scheme://host/path）
    try {
      const u = new URL(h)
      // URL.port 空字符串表示默认端口或无端口
      return u.port ? h : `${u.protocol}//${u.hostname}:${p}`
    } catch {
      return h
    }
  }
  return `ws://${h}:${p}`
})

/** host 经 classifyNetworkKind 推导网络类型（saveProfile 用） */
const networkKind = computed<NetworkKind>(() => {
  try {
    return classifyNetworkKind(new URL(url.value).hostname)
  } catch {
    return 'public'
  }
})

/** probeError 三态文案映射 */
const probeErrorText = computed<string>(() => {
  switch (probeError.value) {
    case 'auth':
      return t('connection.remoteConnect.probe.authFailed')
    case 'network':
      return t('connection.remoteConnect.probe.networkFailed')
    case 'timeout':
      return t('connection.remoteConnect.probe.timeout')
    default:
      return ''
  }
})

/**
 * 连接：probeConnect 预探测 → 成功 saveProfile + activateRemote + reload。
 * 防重入：probing 中再点 return。
 */
async function connect(): Promise<void> {
  if (probing.value) return
  const target = url.value
  if (!target) return
  // 持久化 deviceName 改动（probeConnect / useConnection 的 auth 握手经 getDeviceName() 读取，spec §7.3）
  setDeviceName(deviceName.value)
  probing.value = true
  probeError.value = null
  try {
    const result = await probeConnect(target, token.value)
    if (result.ok) {
      const profile = saveProfile({
        url: target,
        token: token.value,
        name: hostLabel(target),
        networkKind: networkKind.value,
        lastConnectedAt: Date.now(),
      })
      activateRemote(profile.id)
      location.reload()
      return
    }
    probeError.value = result.error
     
  } catch {
    probeError.value = 'network'
  } finally {
    probing.value = false
  }
}

/** 从 url 提取 host 用作 profile.name 默认显示名 */
function hostLabel(urlStr: string): string {
  try {
    return new URL(urlStr).hostname || host.value.trim()
  } catch {
    return host.value.trim()
  }
}
</script>

<template>
  <div data-testid="remote-manual-tab" class="flex flex-col gap-3 py-2">
    <!-- host -->
    <div class="flex flex-col gap-1">
      <Label class="text-[12px] font-normal text-muted">{{ t('connection.remoteConnect.manual.hostLabel') }}</Label>
      <Input
        v-model="host"
        data-testid="manual-host"
        :placeholder="t('connection.remoteConnect.manual.hostPlaceholder')"
        class="h-9 bg-surface-2 text-[13px]"
      />
    </div>

    <!-- port -->
    <div class="flex flex-col gap-1">
      <Label class="text-[12px] font-normal text-muted">{{ t('connection.remoteConnect.manual.portLabel') }}</Label>
      <Input
        v-model="port"
        data-testid="manual-port"
        class="h-9 bg-surface-2 text-[13px]"
      />
    </div>

    <!-- token -->
    <div class="flex flex-col gap-1">
      <Label class="text-[12px] font-normal text-muted">{{ t('connection.remoteConnect.manual.tokenLabel') }}</Label>
      <Input
        v-model="token"
        data-testid="manual-token"
        :placeholder="t('connection.remoteConnect.manual.tokenPlaceholder')"
        class="h-9 bg-surface-2 text-[13px]"
      />
    </div>

    <!-- deviceName（可选，预填 getDeviceName，提交时写回 xyz-agent:device-name） -->
    <div class="flex flex-col gap-1">
      <Label class="text-[12px] font-normal text-muted">{{ t('connection.remoteConnect.manual.deviceNameLabel') }}</Label>
      <Input
        v-model="deviceName"
        data-testid="manual-device-name"
        :placeholder="t('connection.remoteConnect.manual.deviceNamePlaceholder')"
        class="h-9 bg-surface-2 text-[13px]"
      />
    </div>

    <!-- url 预览（拼接结果，便于用户核对） -->
    <p v-if="url" data-testid="manual-url-preview" class="truncate font-mono text-[11px] text-muted">
      {{ url }}
    </p>

    <!-- 红色探测错误（三态） -->
    <p
      v-if="probeError"
      data-testid="probe-error"
      class="flex items-center gap-1.5 text-[12px] text-danger"
    >
      <AlertCircle class="size-3.5 shrink-0" />
      <span>{{ probeErrorText }}</span>
    </p>

    <Button
      data-testid="manual-connect-btn"
      :disabled="!canConnect"
      class="h-9 self-end gap-1.5"
      @click="connect"
    >
      <Loader2 v-if="probing" class="size-3.5 animate-spin" />
      {{ probing ? t('connection.remoteConnect.probe.probing') : t('connection.remoteConnect.manual.connect') }}
    </Button>
  </div>
</template>
