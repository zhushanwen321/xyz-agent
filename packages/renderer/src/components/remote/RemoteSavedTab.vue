<script setup lang="ts">
/**
 * RemoteSavedTab —— 已保存 profile 列表 tab（spec §七:159-216 + §7.4）。
 *
 * 流程：onMounted 调 listProfiles() 读 localStorage 快照 → 每个 profile 后台 probeOnline
 * 探测在线/离线（绿点/灰点，仅探活不鉴权，spec §7.4）→ 点击 profile 项 activateRemote +
 * location.reload()（不重 probe，已保存 token 可信）。
 *
 * 空列表显示提示（ES5 降级：probeOnline 全失败也只显灰点不阻塞点击）。
 *
 * 依赖：listProfiles/activateRemote（s1）+ probeOnline（s1）。
 * 约束：用 xyz-ui Button，禁原生元素/emoji/硬编码颜色；template≤400/script≤300。
 * 禁 Promise.all（用 Promise.allSettled）。
 */
import { ref, reactive, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Folder } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { listProfiles, activateRemote } from '@/lib/remote/connection-config'
import { probeOnline } from '@/lib/remote/probe'
import type { RemoteServerProfile } from '@/lib/remote/types'

defineEmits<{
  (e: 'connected'): void
}>()

const { t } = useI18n()

/** profile 列表快照（onMounted 一次性读，不做响应式 watch） */
const profiles = ref<RemoteServerProfile[]>([])
/** 在线状态 Map（key=profile.id，value=在线 true/离线 false，probeOnline 后台探测填） */
const onlineMap = reactive<Map<string, boolean>>(new Map())
/** 激活中 profile id（点击后到 reload 前短暂态，防重点） */
const activatingId = ref<string | null>(null)

onMounted(async () => {
  profiles.value = listProfiles()
  // 后台并发探测每个 profile（allSettled：单条失败不影响其他）
  const results = await Promise.allSettled(
    profiles.value.map(async (p) => {
      const online = await probeOnline(p.url)
      onlineMap.set(p.id, online)
    }),
  )
  // allSettled 永远 resolve，此处仅消费结果确保没 rejected 被吞（probeOnline 内部已 try/catch）
  void results
})

/**
 * 激活 profile：activateRemote + location.reload（不重 probe，已保存 token 可信）。
 * 防重入：activatingId 非空时 return。
 */
function activate(profile: RemoteServerProfile): void {
  if (activatingId.value !== null) return
  activatingId.value = profile.id
  activateRemote(profile.id)
  location.reload()
}
</script>

<template>
  <div data-testid="remote-saved-tab" class="flex flex-col gap-2 py-2">
    <!-- 空列表提示 -->
    <p
      v-if="profiles.length === 0"
      data-testid="saved-empty"
      class="px-2 py-6 text-center text-[12px] text-muted"
    >
      {{ t('connection.remoteConnect.saved.emptyHint') }}
    </p>

    <!-- profile 列表项（用 Button 组件，禁原生 button） -->
    <Button
      v-for="p in profiles"
      :key="p.id"
      variant="ghost"
      data-testid="saved-profile-item"
      :data-profile-id="p.id"
      :disabled="activatingId !== null && activatingId !== p.id"
      class="h-auto flex items-center gap-2 rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-surface-hover"
      @click="activate(p)"
    >
      <!-- 在线/离线小圆点（绿/灰语义色） -->
      <span
        data-testid="profile-online-dot"
        :class="[
          'size-2 shrink-0 rounded-full',
          onlineMap.get(p.id) === true ? 'bg-success' : 'bg-subtle',
        ]"
      />
      <Folder class="size-4 shrink-0 text-subtle" />
      <span class="flex min-w-0 flex-1 flex-col items-start">
        <span class="truncate text-[13px] text-fg">{{ p.name }}</span>
        <span class="truncate font-mono text-[11px] text-muted">{{ p.url }}</span>
      </span>
      <span
        v-if="onlineMap.has(p.id)"
        class="text-[11px] text-muted"
      >
        {{ onlineMap.get(p.id) ? t('connection.remoteConnect.saved.online') : t('connection.remoteConnect.saved.offline') }}
      </span>
    </Button>
  </div>
</template>
