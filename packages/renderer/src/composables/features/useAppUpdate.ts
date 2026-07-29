/**
 * useAppUpdate —— 自动升级的单例 composable（w4 update-frontend）。
 *
 * 职责：
 * - 维护 9 状态机（idle/checking/available/downloading/verifying/replacing/restarting/error/unsupported）
 * - checkForUpdate：经 ipc 检测新版，命中后异步渲染 releaseNotes 为 HTML
 * - performUpdate：触发 main 侧下载→校验→替换→重启全流程
 * - 订阅 onUpdateProgress（stage + percent）/ onUpdateError（错误 SSOT），onScopeDispose 退订
 * - initAutoCheck：30s 后自动检测一次（应用启动后延迟避开冷启动高峰）
 *
 * 单例范式：module-level state（全应用共享）+ refCount 引用计数管理订阅生命周期，
 * 对齐 usePlatformChrome.ts:34-52。UpdateButton 与 Sidebar 都读同一份 state。
 *
 * 订阅引用计数：每个消费者调 useAppUpdate() 时 refCount++，最后一个消费者 dispose 时才退订，
 * 避免「Sidebar 先于 UpdateButton 卸载→ listening=false 但 UpdateButton 仍在用 state → 进度/错误事件丢失」
 * 的多消费者竞争（旧 listening flag 只由首个调用者的 onScopeDispose 守护，有缺口）。
 *
 * 错误双通路去重：onUpdateError 为 SSOT（已收到则设 errorHandled=true），
 * performUpdate 的 catch 仅在 !errorHandled 时兜底置 error（避免覆盖更精确的 onUpdateError 信息）。
 *
 * 依赖方向：lib/ipc（renderer→main 唯一适配点）+ composables/logic/markdown（releaseNotes 渲染）。
 */
import { onScopeDispose, reactive } from 'vue'
import type { LatestReleaseInfo, UpdateState } from '@xyz-agent/shared'
import {
  checkForUpdate as ipcCheckForUpdate,
  performUpdate as ipcPerformUpdate,
  onUpdateProgress,
  onUpdateError,
  openUpdateFallbackUrl as ipcOpenUpdateFallbackUrl,
} from '@/lib/ipc'
import { renderMarkdown } from '@/composables/logic/markdown'

/** 不支持当前平台的错误码（main 侧 platform-updater 抛出，preload 透传） */
const UNSUPPORTED_ERROR_CODE = 'UPDATE_UNSUPPORTED_PLATFORM'

/** 自动检测延迟：应用启动后 30s（避开冷启动资源竞争） */
const AUTO_CHECK_DELAY_MS = 30_000

/**
 * module-level 单例 state：全应用共享（UpdateButton + Sidebar 读同一份）。
 * reactive 对象：state 状态机 + latestRelease（检测到的版本信息）+ errorMessage + percent + releaseNotesHtml。
 */
const state = reactive({
  /** 状态机当前态 */
  state: 'idle' as UpdateState,
  /** 最新版本信息（state=available 后填充） */
  latestRelease: null as LatestReleaseInfo | null,
  /** 错误信息（state=error 时填充） */
  errorMessage: '',
  /** 升级进度百分比（0-100，state=downloading/verifying/replacing 时填充） */
  percent: 0,
  /** release note 渲染后的 HTML（markdown-it + shiki，异步填充） */
  releaseNotesHtml: '',
})

/**
 * 订阅引用计数：每个消费者调 useAppUpdate() 时 ++，最后一个 dispose 时才退订。
 * 解决多消费者竞争：Sidebar 与 UpdateButton 各自的 onScopeDispose 独立守护，
 * 任何一个先卸载只减计数，不影响仍存活的消费者继续接收进度/错误事件。
 */
let refCount = 0

/** errorHandled flag：onUpdateError 已处理错误后置 true，performUpdate catch 据此去重兜底 */
let errorHandled = false

/**
 * 订阅 main 进程的进度 + 错误推送（引用计数管理生命周期）。
 * 首个消费者订阅，后续消费者只增计数；最后一个消费者 dispose 时退订。
 * onScopeDispose 注册在每个调用 useAppUpdate 的组件作用域上，随该作用域卸载而清理。
 */
function subscribeProgress(): void {
  refCount++
  if (refCount !== 1) return  // 已有订阅，只增计数
  // 首次订阅
  const offProgress = onUpdateProgress((p) => {
    // stage 映射 state：downloading/verifying/replacing（restarting 由 performUpdate resolve 后置）
    if (p.stage === 'downloading' || p.stage === 'verifying' || p.stage === 'replacing') {
      state.state = p.stage
    }
    state.percent = p.percent
  })
  const offError = onUpdateError((e) => {
    // onUpdateError 为 SSOT：优先处理错误信息
    if (e.errorCode === UNSUPPORTED_ERROR_CODE) {
      state.state = 'unsupported'
    } else {
      state.state = 'error'
      state.errorMessage = e.message
    }
    errorHandled = true
  })
  onScopeDispose(() => {
    refCount--
    if (refCount === 0) {
      offProgress()
      offError()
    }
  })
}

/**
 * 检测最新版本。命中新版 → state='available' + latestRelease 填充 + 异步渲染 releaseNotes；
 * 无新版/失败 → state='idle'。
 *
 * 请求令牌（renderToken）：用户快速连续点击检测时，旧请求的 ipc 返回/releaseNotes 渲染可能
 * 在状态已变后才 resolve，会覆盖更新（正确）的状态。用递增令牌丢弃陈旧解析：每次进入本次调用
 * 递增 renderToken，await 后若令牌已变（说明期间又发了新 checkForUpdate）则丢弃本次结果。
 *
 * @param force true 强制刷新缓存（默认走 1h 缓存）
 */
let renderToken = 0

async function checkForUpdate(force = false): Promise<void> {
  state.state = 'checking'
  const myToken = ++renderToken
  try {
    const info = await ipcCheckForUpdate({ force })
    // 防陈旧：若期间又发了新 checkForUpdate，丢弃本次结果
    if (myToken !== renderToken) return
    if (info) {
      state.latestRelease = info
      state.state = 'available'
      // releaseNotes 异步渲染（markdown-it + shiki WASM 首次加载），不阻塞 UI；
      // 防陈旧：渲染期间若又发了新 checkForUpdate，丢弃本次 html（避免覆盖更新版本的信息）
      void renderMarkdown(info.releaseNotes).then((html) => {
        if (myToken !== renderToken) return  // 丢弃陈旧解析
        state.releaseNotesHtml = html
      })
    } else {
      state.state = 'idle'
    }
  } catch (e) {
    // 防陈旧：丢弃陈旧的失败结果
    if (myToken !== renderToken) return
    // 检测失败不算升级流程错误（不打 error 态）。
    // 不设 errorMessage：idle 态 UpdateButton 隐藏，设了也看不到，且会残留到下次。
    // 失败信息仅 console.warn 便于诊断。
    state.state = 'idle'
    console.warn('[useAppUpdate] checkForUpdate failed:', e)
  }
}

/**
 * 执行升级流程。state='downloading' + errorHandled=false，调 ipc.performUpdate。
 * triggerRestart=true → state='restarting'（main 即将退出重启）。
 * catch：!errorHandled 时兜底置 error（onUpdateError 已处理则不覆盖）。
 */
async function performUpdate(): Promise<void> {
  const release = state.latestRelease
  if (!release) return
  state.state = 'downloading'
  state.percent = 0
  state.errorMessage = ''
  errorHandled = false
  try {
    const result = await ipcPerformUpdate(release)
    if (result.triggerRestart) {
      state.state = 'restarting'
    } else if (!errorHandled) {
      // 重新读取 state.state（await 期间 onUpdateProgress 回调可能已把它推进到 verifying/replacing）。
      // 未触发重启、无错误推送、且非终态（error/unsupported 由 onUpdateError 经 errorHandled=true 设置）→ 复位 idle。
      // 覆盖 progress 推到中间态后 performUpdate resolve 但无后续收口的卡死场景。
      const currentState = state.state
      if (currentState === 'downloading' || currentState === 'verifying' || currentState === 'replacing') {
        state.state = 'idle'
      }
    }
  } catch (e) {
    // 去重：onUpdateError 已置 errorHandled=true 则不覆盖（SSOT 优先）
    if (!errorHandled) {
      state.state = 'error'
      state.errorMessage = e instanceof Error ? e.message : String(e)
    }
  }
}

/** 不支持当前平台时，打开备用下载页（release 页面） */
async function openFallbackUrl(): Promise<void> {
  const release = state.latestRelease
  if (!release) return
  await ipcOpenUpdateFallbackUrl(release.htmlUrl)
}

/**
 * 启动 30s 自动检测（应用启动后延迟检测，避开冷启动高峰）。
 * 必须在活跃 effect scope 内调用，通常在组件 setup 顶层同步调用（onScopeDispose 依赖活跃 scope）；
 * 内部用 setTimeout 延迟 30s，不需要等 DOM 挂载，故不必放 onMounted。onScopeDispose 清理定时器避免泄漏。
 */
function initAutoCheck(): void {
  const timer = setTimeout(() => {
    void checkForUpdate(false)
  }, AUTO_CHECK_DELAY_MS)
  onScopeDispose(() => clearTimeout(timer))
}

/**
 * useAppUpdate：返回单例 state + 操作方法。
 * 必须在活跃 effect scope 内调用（subscribeProgress/initAutoCheck 依赖 onScopeDispose），
 * 通常在组件 setup 顶层同步调用。
 */
export function useAppUpdate() {
  subscribeProgress()
  return {
    state,
    checkForUpdate,
    performUpdate,
    openFallbackUrl,
    initAutoCheck,
  }
}

/**
 * 重置单例 state（仅供测试使用）。
 * module-level state 跨测试会残留，需在 beforeEach 显式重置以保证用例隔离。
 * refCount/renderToken/errorHandled 一并重置（module-level 闭包变量同样跨用例残留）。
 */
export function _resetForTest(): void {
  state.state = 'idle'
  state.latestRelease = null
  state.errorMessage = ''
  state.percent = 0
  state.releaseNotesHtml = ''
  errorHandled = false
  refCount = 0
  renderToken = 0
}
