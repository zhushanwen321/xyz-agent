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
 * CR-fix WARNING4：
 * - 三态在线指示：probe pending 时显脉冲灰点（unknown 语义），避免 reactive<Map>.get 返 undefined
 *   视觉等同 offline（灰点）造成「未探测」与「离线」语义混淆。
 * - 列表项容器 Button 改 as="div"：重命名态 Input + 确认/取消 Button 嵌套在 Button 内
 *   违反 HTML 规范（button 不可嵌 interactive content），浏览器会强制重排 DOM。as="div" 底层
 *   渲染成 div，click/键盘仍可用（role=button + tabindex + keydown.enter/space）。
 *
 * 依赖：listProfiles/activateRemote（s1）+ probeOnline（s1）。
 * 约束：用 xyz-ui Button，禁原生元素/emoji/硬编码颜色；template≤400/script≤300。
 * 禁 Promise.all（用 Promise.allSettled）。
 */
import { ref, reactive, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Folder, Check, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listProfiles, activateRemote, saveProfile } from '@/lib/remote/connection-config'
import { probeOnline } from '@/lib/remote/probe'
import type { RemoteServerProfile } from '@/lib/remote/types'

const { t } = useI18n()

/** profile 列表快照（onMounted 一次性读，不做响应式 watch） */
const profiles = ref<RemoteServerProfile[]>([])
/**
 * 在线状态 Map（key=profile.id，value=在线 true/离线 false，probeOnline 后台探测填）。
 * reactive<Map>：probe 完成前 .has(id)===false（unknown 三态），完成后 .get(id) 返 true/false。
 */
const onlineMap = reactive<Map<string, boolean>>(new Map())
/** 激活中 profile id（点击后到 reload 前短暂态，防重点） */
const activatingId = ref<string | null>(null)
/** 正在重命名的 profile id（spec §7.4：双击名称行内编辑） */
const editingId = ref<string | null>(null)
/** 重命名草稿 label（编辑态 Input v-model 绑定） */
const draftName = ref('')

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
 * 单 profile 是否禁用交互（任意项激活中或当前编辑态）。
 * as="div" 后 Button 的 disabled prop 不再生效（div 无 disabled 属性），改为 class 控制视觉
 * + click handler 内 guard（activate 已判 editingId/activatingId）。
 */
function isItemDisabled(p: RemoteServerProfile): boolean {
  return (activatingId.value !== null && activatingId.value !== p.id) || editingId.value !== null
}

/**
 * 激活 profile：activateRemote + location.reload（不重 probe，已保存 token 可信）。
 * 防重入：activatingId 非空时 return；编辑态（editingId 非空）不激活（避免编辑中误点列表项触发 reload）。
 */
function activate(profile: RemoteServerProfile): void {
  if (activatingId.value !== null) return
  if (editingId.value !== null) return
  activatingId.value = profile.id
  activateRemote(profile.id)
  location.reload()
}

/**
 * 进入行内重命名（spec §7.4：双击名称 → inline Input + 确认/取消）。
 * 防御：editingId 非空时不重入（同时只编辑一个）。
 */
function startRename(profile: RemoteServerProfile): void {
  editingId.value = profile.id
  draftName.value = profile.name
}

/** 取消重命名：清编辑态（不写存储） */
function cancelRename(): void {
  editingId.value = null
  draftName.value = ''
}

/**
 * 确认重命名：saveProfile upsert by url（复用原 id，覆盖 name），更新本地快照 name 字段。
 * 空草稿视为取消。落库后刷新快照该项 name，使列表即时反映新名称。
 */
function confirmRename(profile: RemoteServerProfile): void {
  const name = draftName.value.trim()
  editingId.value = null
  draftName.value = ''
  if (!name || name === profile.name) return
  saveProfile({
    id: profile.id,
    name,
    url: profile.url,
    token: profile.token,
    networkKind: profile.networkKind,
    ...(profile.lastConnectedAt !== undefined ? { lastConnectedAt: profile.lastConnectedAt } : {}),
  })
  // 同步本地快照（避免重新读 localStorage + 重跑 probeOnline）
  profile.name = name
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

    <!-- profile 列表项（CR-fix WARNING4：Button as="div" 避重命名态 Input/Button 嵌套违反 HTML 规范） -->
    <Button
      v-for="p in profiles"
      :key="p.id"
      as="div"
      variant="ghost"
      role="button"
      tabindex="0"
      data-testid="saved-profile-item"
      :data-profile-id="p.id"
      :aria-disabled="isItemDisabled(p) || undefined"
      :class="[
        'h-auto flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-surface-hover',
        isItemDisabled(p) ? 'pointer-events-none opacity-50' : '',
      ]"
      @click="activate(p)"
      @keydown.enter.prevent="activate(p)"
      @keydown.space.prevent="activate(p)"
    >
      <!-- 在线/离线小圆点（三态：online=绿 / offline=灰稳态 / unknown=灰脉冲，CR-fix WARNING4 A） -->
      <span
        data-testid="profile-online-dot"
        :class="[
          'size-2 shrink-0 rounded-full',
          onlineMap.get(p.id) === true
            ? 'bg-success'
            : onlineMap.get(p.id) === false
              ? 'bg-subtle'
              : 'bg-subtle animate-pulse',
        ]"
      />
      <Folder class="size-4 shrink-0 text-subtle" />
      <span class="flex min-w-0 flex-1 flex-col items-start">
        <!-- 重命名态：inline Input + 确认/取消（spec §7.4 双击名称行内编辑） -->
        <span v-if="editingId === p.id" class="flex w-full items-center gap-1" @click.stop>
          <Input
            v-model="draftName"
            data-testid="rename-input"
            class="h-7 flex-1 bg-surface-2 text-[13px]"
            @click.stop
            @keydown.enter="confirmRename(p)"
            @keydown.esc="cancelRename"
          />
          <Button
            variant="ghost"
            size="sm"
            data-testid="rename-confirm"
            :aria-label="t('connection.remoteConnect.saved.renameConfirm')"
            class="h-7 w-7 shrink-0 p-0"
            @click.stop="confirmRename(p)"
          >
            <Check class="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="rename-cancel"
            :aria-label="t('connection.remoteConnect.saved.renameCancel')"
            class="h-7 w-7 shrink-0 p-0"
            @click.stop="cancelRename"
          >
            <X class="size-3.5" />
          </Button>
        </span>
        <!-- 默认态：名称（双击进重命名） + url -->
        <span v-else class="flex w-full flex-col items-start">
          <span
            class="truncate text-[13px] text-fg"
            data-testid="profile-name"
            :title="t('connection.remoteConnect.saved.rename')"
            @dblclick.stop="startRename(p)"
          >
            {{ p.name }}
          </span>
          <span class="truncate font-mono text-[11px] text-muted">{{ p.url }}</span>
        </span>
      </span>
      <span
        v-if="editingId !== p.id && onlineMap.has(p.id)"
        class="text-[11px] text-muted"
      >
        {{ onlineMap.get(p.id) ? t('connection.remoteConnect.saved.online') : t('connection.remoteConnect.saved.offline') }}
      </span>
    </Button>
  </div>
</template>
