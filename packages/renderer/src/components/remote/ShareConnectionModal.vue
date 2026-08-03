<script setup lang="ts">
/**
 * ShareConnectionModal —— 远程分享 modal（wave 远程分享 UI 层）。
 *
 * 职责：onMounted 发 config.getConnectionInfo RPC 拉 token + detectUrls 探测的可达 URL 列表，
 * 挑 lan（手机可连）→ fallback localhost 的 url，拼三种格式展示：
 *   1. 移动端浏览器直达：`${httpUrl}/#token=${token}`（参考 bootstrap.ts:78 tokenHash 拼法）
 *   2. 桌面端手动：wsUrl + token 分两行（各有复制按钮）
 *   3. APP deep link：`xyz-agent://connect?url=${encodeURIComponent(wsUrl)}&token=${token}`
 *
 * 复制复用 useCopy（图标 Copy↔Check 反馈）。RPC 走 api/config.getConnectionInfo（command 原语）。
 *
 * 约束：xyz-ui Dialog/Button + lucide 图标，禁原生元素/emoji/硬编码颜色；template≤400/script≤300。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Copy, Check, AlertCircle } from '@lucide/vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { config as configApi } from '@/api'
import type { ConnectionInfo } from '@/api/domains/config'
import { useCopy } from '@/composables/effects/useCopy'

defineEmits<{
  (e: 'close'): void
}>()

const { t } = useI18n()

/** 加载态：null=未完成，ConnectionInfo=成功，Error=失败（窄化判别）。 */
const info = ref<ConnectionInfo | null>(null)
const loadError = ref(false)

/** 挑展示用 url：优先 lan（手机可达 LAN IP），fallback localhost。 */
const pickedUrl = computed(() => {
  const urls = info.value?.urls ?? []
  return urls.find((u) => u.kind === 'lan') ?? urls.find((u) => u.kind === 'localhost') ?? urls[0]
})

const token = computed(() => info.value?.token ?? '')

/** 移动端直达：httpUrl + /#token=xxx（httpUrl 末尾去尾斜杠再拼，避免双斜杠）。 */
const mobileUrl = computed(() => {
  const base = pickedUrl.value?.httpUrl ?? ''
  if (!base) return ''
  const trimmed = base.replace(/\/+$/, '')
  return token.value ? `${trimmed}/#token=${token.value}` : `${trimmed}/`
})

const wsUrl = computed(() => pickedUrl.value?.wsUrl ?? '')

/** APP deep link：参考 bootstrap.ts:80 拼法。token 为空时省略 tokenQuery（开放模式）。 */
const deepLink = computed(() => {
  const ws = wsUrl.value
  if (!ws) return ''
  const tokenQuery = token.value ? `&token=${token.value}` : ''
  return `xyz-agent://connect?url=${encodeURIComponent(ws)}${tokenQuery}`
})

/** useCopy 各行独立 copied 反馈（key 区分）。 */
const { copied: copiedMobile, copy: copyMobile } = useCopy()
const { copied: copiedWs, copy: copyWs } = useCopy()
const { copied: copiedToken, copy: copyToken } = useCopy()
const { copied: copiedDeep, copy: copyDeep } = useCopy()

onMounted(async () => {
  try {
    info.value = await configApi.getConnectionInfo()
  } catch {
    loadError.value = true
  }
})
</script>

<template>
  <Dialog :open="true" @update:open="(v) => { if (!v) $emit('close') }">
    <DialogContent class="max-w-[480px]" data-testid="share-connection-modal">
      <DialogHeader>
        <DialogTitle>{{ t('connection.share.title') }}</DialogTitle>
        <DialogDescription>{{ t('connection.share.subtitle') }}</DialogDescription>
      </DialogHeader>

      <!-- 加载态 -->
      <div v-if="!info && !loadError" class="flex items-center justify-center gap-2 py-10 text-muted">
        <Loader2 class="size-4 animate-spin" />
        <span class="text-[12px]">{{ t('common.loading') }}</span>
      </div>

      <!-- 失败态 -->
      <div v-else-if="loadError" class="flex items-center justify-center gap-2 py-10 text-danger">
        <AlertCircle class="size-4" />
        <span class="text-[12px]">{{ t('connection.share.loadFailed') }}</span>
      </div>

      <!-- 三种格式 -->
      <div v-else class="flex flex-col gap-4">
        <!-- 1. 移动端直达 -->
        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between">
            <span class="text-[12px] font-medium text-fg">{{ t('connection.share.mobileUrl') }}</span>
            <span class="text-[11px] text-neutral-dim">{{ t('connection.share.mobileUrlHint') }}</span>
          </div>
          <div class="flex items-center gap-2">
            <code
              data-testid="share-mobile-url"
              class="flex-1 truncate rounded-md bg-surface-2 px-2.5 py-1.5 text-[11px] text-fg"
            >{{ mobileUrl }}</code>
            <Button
              data-testid="copy-mobile-url-btn"
              variant="ghost"
              class="grid size-7 shrink-0 place-items-center rounded-md p-0 text-neutral-mid hover:bg-surface-hover hover:text-fg"
              :title="t('connection.share.copied')"
              @click="copyMobile(mobileUrl, 'mobile-url')"
            >
              <Check v-if="copiedMobile === 'mobile-url'" class="size-3.5 text-success" />
              <Copy v-else class="size-3.5" />
            </Button>
          </div>
        </div>

        <!-- 2. 桌面端手动：wsUrl + token 分两行 -->
        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between">
            <span class="text-[12px] font-medium text-fg">{{ t('connection.share.desktopUrl') }}</span>
            <span class="text-[11px] text-neutral-dim">{{ t('connection.share.desktopUrlHint') }}</span>
          </div>
          <div class="flex items-center gap-2">
            <code
              data-testid="share-desktop-wsurl"
              class="flex-1 truncate rounded-md bg-surface-2 px-2.5 py-1.5 text-[11px] text-fg"
            >{{ wsUrl }}</code>
            <Button
              data-testid="copy-wsurl-btn"
              variant="ghost"
              class="grid size-7 shrink-0 place-items-center rounded-md p-0 text-neutral-mid hover:bg-surface-hover hover:text-fg"
              @click="copyWs(wsUrl, 'wsurl')"
            >
              <Check v-if="copiedWs === 'wsurl'" class="size-3.5 text-success" />
              <Copy v-else class="size-3.5" />
            </Button>
          </div>
          <div class="flex items-center gap-2">
            <code
              data-testid="share-token"
              class="flex-1 truncate rounded-md bg-surface-2 px-2.5 py-1.5 text-[11px] text-fg"
            >{{ token || t('connection.share.openMode') }}</code>
            <Button
              data-testid="copy-token-btn"
              variant="ghost"
              class="grid size-7 shrink-0 place-items-center rounded-md p-0 text-neutral-mid hover:bg-surface-hover hover:text-fg"
              :disabled="!token"
              @click="copyToken(token, 'token')"
            >
              <Check v-if="copiedToken === 'token'" class="size-3.5 text-success" />
              <Copy v-else class="size-3.5" />
            </Button>
          </div>
        </div>

        <!-- 3. APP deep link -->
        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between">
            <span class="text-[12px] font-medium text-fg">{{ t('connection.share.deepLink') }}</span>
            <span class="text-[11px] text-neutral-dim">{{ t('connection.share.deepLinkHint') }}</span>
          </div>
          <div class="flex items-center gap-2">
            <code
              data-testid="share-deep-link"
              class="flex-1 truncate rounded-md bg-surface-2 px-2.5 py-1.5 text-[11px] text-fg"
            >{{ deepLink }}</code>
            <Button
              data-testid="copy-deep-link-btn"
              variant="ghost"
              class="grid size-7 shrink-0 place-items-center rounded-md p-0 text-neutral-mid hover:bg-surface-hover hover:text-fg"
              @click="copyDeep(deepLink, 'deep-link')"
            >
              <Check v-if="copiedDeep === 'deep-link'" class="size-3.5 text-success" />
              <Copy v-else class="size-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" data-testid="share-close-btn" @click="$emit('close')">
          {{ t('common.close') }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
