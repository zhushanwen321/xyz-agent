<script setup lang="ts">
/**
 * RemotePasteTab —— 粘贴连接字符串 tab（spec §七:159-216）。
 *
 * 流程：textarea 接收任意文本 → parseConnectionInfo 实时识别（命中显示 networkKind chip，
 * 未命中显示橙色提示，ES1 静默）→ 点「连接」probeConnect 预探测 → 成功 saveProfile +
 * activateRemote + location.reload()；失败按三态（auth/network/timeout）显示红色错误。
 *
 * onMounted 读 navigator.clipboard.readText() 预填：命中 ws 格式则填入 textarea + 解析，
 * 失败静默（spec 剪贴板探测同 parseConnectionInfo 静默规则）。
 *
 * 依赖：parseConnectionInfo（s1）+ probeConnect（s1）+ saveProfile/activateRemote（s1）。
 * 约束：用 xyz-ui Textarea/Button，禁原生元素/emoji/硬编码颜色；template≤400/script≤300。
 */
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, AlertCircle } from '@lucide/vue'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { parseConnectionInfo } from '@/lib/remote/parse-connect-info'
import { probeConnect } from '@/lib/remote/probe'
import { saveProfile, activateRemote } from '@/lib/remote/connection-config'
import type { NetworkKind } from '@/lib/remote/types'

defineEmits<{
  (e: 'connected'): void
}>()

const { t } = useI18n()

/** textarea 值（任意文本，由 parseConnectionInfo 实时识别） */
const raw = ref('')
/** probeConnect 进行中（连接按钮 spinner + disabled） */
const probing = ref(false)
/** 最近一次探测失败归一结果（auth/network/timeout），null=未失败 */
const probeError = ref<'auth' | 'network' | 'timeout' | null>(null)
/** onMounted 剪贴板探测已执行（避免重复） */
const clipboardChecked = ref(false)
/** 剪贴板命中预填的提示可见性 */
const clipboardDetected = ref(false)

/** 实时解析 textarea（ES1 静默，unrecognized 不抛只返 error 字段） */
const parsed = computed(() => parseConnectionInfo(raw.value))

/** 命中格式（非 unrecognized）才显示 chip + 连接按钮可点 */
const isRecognized = computed(() => parsed.value.error === undefined)

/** networkKind chip 文案（命中时显示网络类型） */
const networkKindLabel = computed<string>(() => {
  const map: Record<NetworkKind, string> = {
    tailscale: 'Tailscale',
    public: 'Public',
    lan: 'LAN',
    localhost: 'Local',
  }
  const kind = parsed.value.networkKind
  return kind ? map[kind] : ''
})

/** probeError 三态文案映射（auth/network/timeout 对应不同 i18n key） */
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
 * onMounted 剪贴板探测：读 navigator.clipboard.readText()，命中 ws 格式则预填。
 * 失败静默（Permissions API 拒绝 / 非 HTTPS / SSR 无 navigator）。
 */
onMounted(async () => {
  clipboardChecked.value = true
  try {
    const nav = globalThis.navigator as Navigator & { clipboard?: { readText?: () => Promise<string> } }
    const readText = nav?.clipboard?.readText
    if (typeof readText !== 'function') return
    const text = await readText.call(nav.clipboard)
    const result = parseConnectionInfo(text)
    if (result.error === undefined && result.url) {
      raw.value = text.trim()
      clipboardDetected.value = true
    }
    // eslint-disable-next-line taste/no-silent-catch -- 剪贴板探测失败静默（spec 同 parseConnectionInfo 规则）
  } catch {
    // Permissions 拒绝 / 非 HTTPS / 取消选择 → 静默
  }
})

/**
 * 连接：probeConnect 预探测 → 成功 saveProfile + activateRemote + reload。
 * 防重入：probing 中再点 return。
 */
async function connect(): Promise<void> {
  if (probing.value) return
  // 未识别不阻塞（让用户看到 probe 返的 auth 错误，ES2 语义），但 url 缺失无法 probe
  const url = parsed.value.url
  if (!url) return
  probing.value = true
  probeError.value = null
  try {
    const token = parsed.value.token ?? ''
    const result = await probeConnect(url, token)
    if (result.ok) {
      const profile = saveProfile({
        url,
        token,
        name: hostOf(url),
        networkKind: parsed.value.networkKind ?? 'public',
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

/** 从 ws url 提取 host（用作 profile.name 默认显示名） */
function hostOf(urlStr: string): string {
  try {
    return new URL(urlStr).hostname || urlStr
  } catch {
    return urlStr
  }
}
</script>

<template>
  <div data-testid="remote-paste-tab" class="flex flex-col gap-3 py-2">
    <!-- 剪贴板命中提示 -->
    <p
      v-if="clipboardDetected"
      data-testid="clipboard-detected-hint"
      class="text-[12px] text-accent"
    >
      {{ t('connection.remoteConnect.paste.clipboardDetected') }}
    </p>

    <Textarea
      v-model="raw"
      data-testid="paste-textarea"
      :placeholder="t('connection.remoteConnect.paste.placeholder')"
      class="min-h-[96px] bg-surface-2 text-[13px]"
    />

    <!-- 实时解析 chip（命中格式时显示 networkKind + url 预览） -->
    <div v-if="isRecognized && parsed.url" data-testid="parse-result" class="flex flex-wrap items-center gap-2">
      <span class="inline-flex items-center rounded-sm bg-surface-hover px-2 py-0.5 text-[11px] text-muted">
        {{ networkKindLabel }}
      </span>
      <span class="truncate font-mono text-[11px] text-muted">{{ parsed.url }}</span>
    </div>

    <!-- 橙色未识别提示（不清空 textarea，不阻塞按钮） -->
    <p
      v-else-if="raw.trim() && !isRecognized"
      data-testid="unrecognized-hint"
      class="text-[12px] text-warning"
    >
      {{ t('connection.remoteConnect.paste.hintUnrecognized') }}
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
      data-testid="paste-connect-btn"
      :disabled="probing || !parsed.url"
      class="h-9 self-end gap-1.5"
      @click="connect"
    >
      <Loader2 v-if="probing" class="size-3.5 animate-spin" />
      {{ probing ? t('connection.remoteConnect.probe.probing') : t('connection.remoteConnect.paste.connect') }}
    </Button>
  </div>
</template>
