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
import { onScopeDispose, reactive, toRaw } from 'vue'
import type { LatestReleaseInfo, UpdateState } from '@xyz-agent/shared'
import {
  checkForUpdate as ipcCheckForUpdate,
  performUpdate as ipcPerformUpdate,
  getPendingUpdate,
  onUpdateProgress,
  onUpdateError,
  openUpdateFallbackUrl as ipcOpenUpdateFallbackUrl,
} from '@/lib/ipc'
import { renderMarkdown } from '@/composables/logic/markdown'
import { getLocale } from '@/i18n'

/** 不支持当前平台的错误码（main 侧 platform-updater 抛出，preload 透传） */
const UNSUPPORTED_ERROR_CODE = 'UPDATE_UNSUPPORTED_PLATFORM'

/** 自动检测延迟：应用启动后 30s（避开冷启动资源竞争） */
const AUTO_CHECK_DELAY_MS = 30_000

/**
 * 多语言 release notes 分隔标记。
 *
 * GitHub Release body 中使用此标记分隔不同语言的内容。
 * 格式示例：
 * ```markdown
 * ## English
 * <!-- LANG:en -->
 * - Fix bug X
 * - Add feature Y
 *
 * <!-- LANG:zh -->
 * ## 中文
 * - 修复 bug X
 * - 添加功能 Y
 * ```
 *
 * 前端根据用户语言偏好提取对应部分。未找到对应语言标记时，
 * 返回整个 body（向后兼容无标记的 release）。
 */
const LANG_MARKER_RE = /<!--\s*LANG:(\w+)\s*-->/g

/**
 * 从多语言 release notes 中提取当前用户语言对应的部分。
 *
 * 支持两种格式：
 * 1. 带标记格式：`<!-- LANG:zh -->中文内容<!-- LANG:en -->English content`
 * 2. 无标记格式：直接返回原文（向后兼容）
 *
 * @param releaseNotes 原始 release notes（可能包含多语言标记）
 * @returns 提取后的 release notes（当前语言对应的部分）
 */
function extractLocalizedNotes(releaseNotes: string): string {
  // 无标记：直接返回原文（向后兼容旧 release）
  if (!releaseNotes.includes('<!-- LANG:')) {
    return releaseNotes
  }

  const locale = getLocale() // 'zh-CN' 或 'en-US'
  // 提取语言代码（zh-CN → zh，en-US → en）
  const langCode = locale.split('-')[0].toLowerCase()

  // 按标记分段
  const sections: Array<{ lang: string; content: string }> = []
  let lastIndex = 0
  let currentLang = ''

  // 重置正则状态
  LANG_MARKER_RE.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = LANG_MARKER_RE.exec(releaseNotes)) !== null) {
    // 标记前的内容归入上一段
    if (currentLang && match.index > lastIndex) {
      sections.push({
        lang: currentLang,
        content: releaseNotes.slice(lastIndex, match.index).trim(),
      })
    }
    currentLang = match[1].toLowerCase()
    lastIndex = match.index + match[0].length
  }

  // 最后一段
  if (currentLang && lastIndex < releaseNotes.length) {
    sections.push({
      lang: currentLang,
      content: releaseNotes.slice(lastIndex).trim(),
    })
  }

  // 查找当前语言对应的段落
  const targetSection = sections.find((s) => s.lang === langCode)
  if (targetSection) {
    return targetSection.content
  }

  // 找不到当前语言：优先回退英文，否则取第一段
  const enSection = sections.find((s) => s.lang === 'en')
  return enSection?.content ?? sections[0]?.content ?? releaseNotes
}

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
 * pendingRestored flag：restorePendingUpdate 成功恢复「可升级」提醒后置 true。
 *
 * 防覆盖守卫：恢复 pending 后若 30s 联网检测失败/无新版（断网等），checkForUpdate 的
 * 默认逻辑会把 state 从 available 回退到 idle，丢失已恢复的提醒。此 flag 让 checkForUpdate
 * 在 !info 分支判断：若已从 pending 恢复，不回退 idle（pending 标志证明曾检测到更新，
 * 除非版本比较已清否则应保持 available）。联网检测确认有更新时正常更新 state。
 */
let pendingRestored = false

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
  const myToken = ++renderToken
  // 防覆盖守卫：若已从 pending 恢复 available 态，联网检测不进入 checking 态
  // （否则 available→checking→idle 会短暂隐藏提醒，且失败/无更新会丢失已恢复的提醒）。
  // 仅当未恢复 pending（首次检测 / 正常流程）时才进入 checking 态。
  if (!pendingRestored) {
    state.state = 'checking'
  }
  try {
    const info = await ipcCheckForUpdate({ force })
    // 防陈旧：若期间又发了新 checkForUpdate，丢弃本次结果
    if (myToken !== renderToken) return
    if (info) {
      state.latestRelease = info
      state.state = 'available'
      // releaseNotes 异步渲染（markdown-it + shiki WASM 首次加载），不阻塞 UI；
      // 防陈旧：渲染期间若又发了新 checkForUpdate，丢弃本次 html（避免覆盖更新版本的信息）
      // 提取当前语言对应的 release notes（支持多语言标记格式）
      const localizedNotes = extractLocalizedNotes(info.releaseNotes)
      void renderMarkdown(localizedNotes).then((html) => {
        if (myToken !== renderToken) return  // 丢弃陈旧解析
        state.releaseNotesHtml = html
      })
    } else if (!pendingRestored) {
      // 无新版：回退 idle。但若已从 pending 恢复（pendingRestored=true），保持 available——
      // pending 标志证明曾检测到更新，联网检测此刻未发现可能是缓存/网络问题，不应丢失提醒。
      state.state = 'idle'
    }
  } catch (e) {
    // 防陈旧：丢弃陈旧的失败结果
    if (myToken !== renderToken) return
    // 检测失败不算升级流程错误（不打 error 态）。
    // 不设 errorMessage：idle 态 UpdateButton 隐藏，设了也看不到，且会残留到下次。
    // 失败信息仅 console.warn 便于诊断。
    // 防覆盖守卫：pendingRestored 时不回退 idle（见上文理由）。
    if (!pendingRestored) {
      state.state = 'idle'
    }
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
    // [HISTORICAL] toRaw 解包 reactive proxy 后再传 IPC。
    // state 是 reactive，state.latestRelease 读取时 Vue 返回 proxy（含按需代理的嵌套
    // assets.*）。ipcPerformUpdate → ipcRenderer.invoke('update:perform', { release })
    // 经 Electron structured clone 序列化，Proxy 不可克隆 → 抛 "an object could not
    // be cloned" → invoke reject 被 catch 吞成 errorMessage，用户在 UpdateButton hover
    // 看到英文 clone 报错（而非中文错误体系文案）。
    // toRaw 拿回 reactive target 的原始 plain 引用（嵌套层也是原始引用，Vue 3 惰性代理
    // 不改写 target 内部），structured clone 可正常序列化。不能用 JSON.parse(JSON.stringify)
    // 做源头深拷贝替代——赋值给 reactive state 后读取仍会重新代理化（实测无效）。
    const result = await ipcPerformUpdate(toRaw(release))
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
 * 从持久化标志恢复「可升级」提醒（功能 1：常驻提醒）。
 *
 * app 启动时调用（经 initAutoCheck 触发）：读取 main 侧 pending-update.json，
 * 若有有效 pending release（版本仍 > 当前版本）→ 置 state.state='available' + 填充
 * latestRelease + 异步渲染 releaseNotes，并设 pendingRestored=true 启用防覆盖守卫。
 *
 * 离线也能恢复（pending 存完整 release info，不依赖网络）。恢复后仍跑 30s 联网检测
 * 作为刷新（修正 release 被编辑等不一致），但防覆盖守卫保证联网检测失败不丢失提醒。
 */
async function restorePendingUpdate(): Promise<void> {
  try {
    const pending = await getPendingUpdate()
    if (!pending) return
    // 版本比较已在 main 侧 readPendingUpdate 完成（currentVersion >= pending.version → 清除返回 null），
    // 此处拿到的 pending 必然是仍有效的「有待升级版本」。
    state.latestRelease = pending
    state.state = 'available'
    pendingRestored = true
    // 异步渲染 releaseNotes（与 checkForUpdate 命中分支一致）
    const localizedNotes = extractLocalizedNotes(pending.releaseNotes)
    void renderMarkdown(localizedNotes).then((html) => {
      state.releaseNotesHtml = html
    })
    console.log(`[useAppUpdate] restored pending update reminder for v${pending.version}`)
  } catch (e) {
    // best-effort：恢复失败不影响后续联网检测，仅 warn
    console.warn('[useAppUpdate] restorePendingUpdate failed:', e)
  }
}

/**
 * 启动自动检测：先恢复持久化提醒（立即），再延迟 30s 联网检测（避开冷启动高峰 + 刷新 release info）。
 * 必须在活跃 effect scope 内调用，通常在组件 setup 顶层同步调用（onScopeDispose 依赖活跃 scope）；
 * 30s 定时器不需要等 DOM 挂载，故不必放 onMounted。onScopeDispose 清理定时器避免泄漏。
 */
function initAutoCheck(): void {
  // 先恢复持久化提醒（立即，不等 30s），让用户一启动就看到「可升级」红点
  void restorePendingUpdate()
  // 30s 后联网检测：刷新 release info（修正不一致）+ 首次无 pending 时正常检测新版
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
    // restorePendingUpdate 暴露供测试直接调用（绕过 initAutoCheck 的 30s 定时器），
    // 运行时由 initAutoCheck 内部触发，组件通常不需要直接调。
    restorePendingUpdate,
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
  pendingRestored = false
}
