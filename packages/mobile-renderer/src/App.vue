<script setup lang="ts">
/**
 * App.vue —— mobile-renderer 根组件（spec P4 §四 D9 + C2）。
 *
 * 连接态门控（useConnection.state ref）：
 *  - 'connected' → MobileShell（已连远程 server，进入主界面）
 *  - 其他 → MobileConnectScreen（未连接 / 连接中失败 / 无 token）
 *
 * 连接流程：
 *  1. onMounted 读 location.hash：命中连接信息（#token= 或 ws:// 等）→ parse-connect-info 解析
 *     → saveProfile + activateRemote → init（useConnection 走远程分支 connect）
 *  2. 无 hash token：检查 isRemoteMode（已有存档 profile）→ init（直接连存档）
 *  3. 无存档：渲染 MobileConnectScreen，用户粘贴连接信息 → MobileConnectScreen emit connected → init
 *
 * token 失效（4001 close code）：ws-client 转 failed 态（failReason=auth），App 渲染 MobileConnectScreen，
 * 用户重新粘贴（connection-config 仍保留 profile，可重新 activateRemote 覆盖 token）。
 *
 * 失败态存档保留策略（spec §四）：
 *  - auth 失败（failReason='auth'，token 失效 4001 / 握手失败）→ 清存档（deactivateRemote），
 *    让用户重新粘贴（旧 token 已无效）。
 *  - network/replaced 失败 → 保留存档（用户可手动重连，避免网络抖动后重新粘贴连接信息）。
 */
import { onMounted, ref, watch } from 'vue'
import { useConnection } from '@/composables/useConnection'
import { parseConnectionInfo } from '@/lib/remote/parse-connect-info'
import { saveProfile, activateRemote, isRemoteMode, deactivateRemote } from '@/lib/remote/connection-config'
import { getFailReason } from '@/lib/ws-client'
import type { RemoteServerProfile } from '@/lib/remote/types'
import MobileShell from '@/components/shell/MobileShell.vue'
import MobileConnectScreen from '@/components/remote/MobileConnectScreen.vue'

const { state, init } = useConnection()

/** 是否已尝试自动连接（防止 onMounted + watch 重复 init） */
const initAttempted = ref(false)

/** 从 location.hash 或粘贴文本解析连接信息并激活远程模式 */
function parseAndActivate(raw: string): RemoteServerProfile | null {
  const parsed = parseConnectionInfo(raw)
  if (parsed.error === 'unrecognized' || !parsed.url) return null
  const profile = saveProfile({
    name: hostOf(parsed.url),
    url: parsed.url,
    token: parsed.token ?? '',
    networkKind: parsed.networkKind ?? 'public',
  })
  activateRemote(profile.id)
  return profile
}

/** 从 url 提取 host（name 用），失败回退 url 原文 */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

onMounted(async () => {
  // 1. location.hash 直达（spec D9：浏览器访问 #token=... 自动连接）
  //    注意：parseConnectionInfo 只识别 4 种格式（deep-link/http-url/ws-url/url-token-lines），
  //    纯 #token=abc 不在其中。因此这里传 window.location.href（完整 URL，含真实 host），
  //    让 parseConnectionInfo 走 http-url 分支：host 取页面所在 host、token 取 hash 参数。
  //    即连「托管本页的服务器」——符合移动端「页面与 WS 同源托管」的部署模型（spec D10）。
  //    「推导成 ws://localhost:1421」仅在 dev 服务器本就监听 localhost 时发生，属正确行为。
  const hash = window.location.hash.replace(/^#/, '')
  if (hash.length > 0) {
    const profile = parseAndActivate(window.location.href)
    if (profile) {
      initAttempted.value = true
      await init()
      return
    }
  }

  // 2. 无 hash token：检查是否已有远程存档（isRemoteMode）
  if (isRemoteMode()) {
    initAttempted.value = true
    await init()
    return
  }

  // 3. 无存档：渲染 MobileConnectScreen（initAttempted 保持 false，state=disconnected）
})

/** MobileConnectScreen 连接成功回调 */
async function onConnected(): Promise<void> {
  initAttempted.value = true
  await init()
}

// 失败态存档保留策略（spec §四）：
//  - auth 失败（failReason='auth'，token 失效 4001 / 握手失败）→ 清存档（deactivateRemote），
//    让用户重新粘贴（旧 token 已无效，保留无意义）。
//  - network/replaced 失败 → 保留存档（用户可手动重连，避免网络抖动后重新粘贴连接信息）。
//    state='failed' 时 App 渲染 MobileConnectScreen，connection-config 仍保留 profile 供重连。
watch(state, (newState) => {
  if (newState === 'failed') {
    // 仅 auth 失败清存档；network/replaced 保留存档以便用户手动重连（spec §四）
    if (getFailReason().value === 'auth') {
      deactivateRemote()
    }
  }
})
</script>

<template>
  <!-- 连接门控：connected → MobileShell，否则 → MobileConnectScreen -->
  <MobileShell v-if="state === 'connected'" />
  <MobileConnectScreen v-else @connected="onConnected" />
</template>
