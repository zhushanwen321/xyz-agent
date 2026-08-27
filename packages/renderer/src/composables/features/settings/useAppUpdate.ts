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
import { compare } from 'compare-versions'
import {
  checkForUpdate as ipcCheckForUpdate,
  // [NOTE] update:perform IPC 仍在 main 侧（update-handlers.ts 标 DEPRECATED）。
  // renderer 当前走两阶段 update:download/update:install。切回一键模式时重新 import performUpdate。
  updateDownload as ipcUpdateDownload,
  updateInstall as ipcUpdateInstall,
  getPreloaded as ipcGetPreloaded,
  getPendingUpdate,
  onUpdateProgress,
  onUpdateError,
  getLaunchResult as ipcGetLaunchResult,
  openUpdateFallbackUrl as ipcOpenUpdateFallbackUrl,
} from '@/lib/ipc'
import { renderMarkdown } from '@/composables/logic/markdown'
import { useToast } from '@/composables/useToast'
import i18n, { getLocale } from '@/i18n'

// 模块级 t：checkLaunchResult 是 initAutoCheck 内 fire-and-forget 的异步函数，非 setup
// 同步上下文用不了 useI18n()，照抄同目录 useProviderImport.ts 的 global.t 模式（B2 review）
const t = i18n.global.t

/** 不支持当前平台的错误码（main 侧 platform-updater 抛出，preload 透传） */
const UNSUPPORTED_ERROR_CODE = 'UPDATE_UNSUPPORTED_PLATFORM'

/** 自动检测首次延迟：应用启动后 30s（避开冷启动资源竞争） */
const AUTO_CHECK_DELAY_MS = 30_000

/**
 * 自动检测周期：每 20 分钟联网检测一次。
 *
 * GitHub API 未认证限额 60 次/小时，20min 一次 = 3 次/小时，配额安全。
 * 用递归 setTimeout 而非 setInterval：checkForUpdate 是 async，setInterval 会在
 * 上一次未完成时排下一次，可能堆积并发请求；递归 setTimeout 保证「上一次完成后才排下一次」。
 */
const CHECK_INTERVAL_MINUTES = 20
const SECONDS_PER_MINUTE = 60
const MS_PER_SECOND = 1000
const AUTO_CHECK_INTERVAL_MS = CHECK_INTERVAL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND // 20min

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
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：应用更新检查状态（下载进度/错误提示 UI，12 类未覆盖）
const state = reactive({
  /** 状态机当前态 */
  state: 'idle' as UpdateState,
  /** 最新版本信息（state=available 后填充） */
  latestRelease: null as LatestReleaseInfo | null,
  /** 错误信息（state=error 时填充） */
  errorMessage: '',
  /** 错误解决建议（state=error 时填充，用于展示恢复指引） */
  errorSuggestion: '',
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
 * 自动检测定时器 id（递归 setTimeout）。
 *
 * 用模块级变量存当前 pending timer，onScopeDispose 时 clearTimeout 避免泄漏
 * （scope 卸载后定时器不应再触发）。runAutoCheck 每次触发后先置 null 再排下一次。
 */
let autoCheckTimer: ReturnType<typeof setTimeout> | null = null

/**
 * visibility 守卫（Q1-6）：hidden 期间被跳过的周期联网检测标记。
 * 恢复可见时据此立即补查一次，不必等下一个 20min 周期（应用隐藏一整天后回来，
 * 最多再等 20min 才检测到新版是不可接受的延迟）。
 */
let skippedWhileHidden = false

/** visibilitychange listener 挂载标记（initAutoCheck 可能被多消费者多次调用，幂等挂载防叠加） */
let visibilityListenerAttached = false

/**
 * dispose 标志（W05 review）：onScopeDispose / _resetForTest 置位，initAutoCheck 复位。
 * runAutoCheck 在 await checkForUpdate 期间无 pending timer（autoCheckTimer 已置 null、
 * 下一周期尚未排）——此窗口内 scope dispose 后 clearAutoCheckTimer 无 timer 可清，
 * await 恢复仍会排上 20min timer → 卸载后继续联网。runAutoCheck 排下一周期前检查
 * 本标志，已 dispose 则直接返回。
 */
let disposed = false

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
      state.errorSuggestion = e.suggestion ?? ''
      // D4：失败 toast 触发点在 useAppUpdate 单例的 onUpdateError 回调
      // toast 只弹摘要（message），suggestion 太长不进 toast，留在 hover 浮层/设置页
      const { error: toastError } = useToast()
      toastError(e.message)
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
      // 状态守卫 ES4：downloaded/replacing/restarting 不被覆盖（除非检测到更新版本=ES5）
      const currentVersion = state.latestRelease?.version
      const isUpgrading = info.version !== currentVersion // 检测到不同（更新）版本
      if (
        state.state === 'downloaded' ||
        state.state === 'replacing' ||
        state.state === 'restarting'
      ) {
        if (state.state === 'downloaded' && isUpgrading) {
          // ES5：downloaded 态检测到更新版本 → 退回 available（追新版，旧 preloaded 由 main 侧下次 download 时自动清）
          console.log(
            `[useAppUpdate] newer version ${info.version} detected during downloaded, rolling back to available`,
          )
          // 继续走下面的 available 设置（不 return）
        } else {
          // ES4：正在替换/重启 或 downloaded 同版本 → 不覆盖当前态
          // 但更新 state.latestRelease（刷新 release info，如 releaseNotes 可能有变化）
          state.latestRelease = info
          return
        }
      }
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
 * 执行下载阶段。state='downloading' + errorHandled=false，调 ipc.updateDownload。
 * downloaded=true → state='downloaded'（产物已下载并校验通过，等待 performInstall 触发替换重启）。
 * 下载止于 downloaded，不触发替换/重启（那是 performInstall 的职责）。
 * catch：!errorHandled 时兜底置 error（onUpdateError 已处理则不覆盖）。
 */
async function performDownload(): Promise<void> {
  const release = state.latestRelease
  if (!release) return
  state.state = 'downloading'
  state.percent = 0
  state.errorMessage = ''
  errorHandled = false
  try {
    // [HISTORICAL] toRaw 解包 reactive proxy 后再传 IPC。
    // state 是 reactive，state.latestRelease 读取时 Vue 返回 proxy（含按需代理的嵌套
    // assets.*）。ipcUpdateDownload → ipcRenderer.invoke('update:download', { release })
    // 经 Electron structured clone 序列化，Proxy 不可克隆 → 抛 "an object could not
    // be cloned" → invoke reject 被 catch 吞成 errorMessage，用户在 UpdateButton hover
    // 看到英文 clone 报错（而非中文错误体系文案）。
    // toRaw 拿回 reactive target 的原始 plain 引用（嵌套层也是原始引用，Vue 3 惰性代理
    // 不改写 target 内部），structured clone 可正常序列化。不能用 JSON.parse(JSON.stringify)
    // 做源头深拷贝替代——赋值给 reactive state 后读取仍会重新代理化（实测无效）。
    const result = await ipcUpdateDownload(toRaw(release))
    if (result.downloaded) {
      state.state = 'downloaded'
    }
  } catch (e) {
    // 去重：onUpdateError 已置 errorHandled=true 则不覆盖（SSOT 优先）
    if (!errorHandled) {
      state.state = 'error'
      state.errorMessage = e instanceof Error ? e.message : String(e)
    }
  }
}

/**
 * 执行安装阶段（替换 + 重启）。依赖已下载产物（performDownload 成功后调用）。
 * 乐观置 replacing（漏洞6修复）：IPC 往返延迟内 state 立即变 replacing，堵二次点击竞态。
 * triggerRestart=true → state='restarting'（main 即将退出重启）。
 * catch：!errorHandled 时兜底置 error（onUpdateError 已处理则不覆盖）。
 */
async function performInstall(): Promise<void> {
  // 乐观置 replacing（漏洞6修复）：IPC 往返延迟内 state 立即变 replacing，堵二次点击竞态
  state.state = 'replacing'
  errorHandled = false
  try {
    const result = await ipcUpdateInstall()
    if (result.triggerRestart) {
      state.state = 'restarting'
    } else if (!errorHandled) {
      // 未触发重启且无错误 → 复位（极少见，install 无 triggerRestart 通常伴随 error 事件）
      state.state = 'idle'
    }
  } catch (e) {
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
 * 从 main 侧预下载产物恢复 downloaded 态（功能 2：预下载）。
 *
 * app 启动时调用（经 initAutoCheck 触发，优先级高于 restorePendingUpdate）：读取 main 侧
 * 预下载产物（getPreloaded），若有效 → 置 state.state='downloaded' + 填充 latestRelease +
 * 异步渲染 releaseNotes，并设 pendingRestored=true 启用防覆盖守卫（防 30s 联网检测回退）。
 *
 * @returns true 表示已恢复（initAutoCheck 据此跳过 restorePendingUpdate）
 */
async function restorePreloadedUpdate(): Promise<boolean> {
  try {
    const preloaded = await ipcGetPreloaded()
    if (!preloaded) return false
    // 版本守卫：current >= preloaded.version 说明已升级/更旧，产物过期 → return false 回退 pending。
    // 非 semver 版本号 catch+继续恢复（信任 preloaded，对齐后端 readPreloadedUpdateRaw 的 keep 语义）。
    try {
      if (compare(__APP_VERSION__, preloaded.release.version, '>=')) return false
    } catch (e) {
      // best-effort 降级：版本号非 semver 无法比较 → 信任 preloaded 继续恢复
      // （对齐后端 readPreloadedUpdateRaw 的 keep 语义，不阻断用户正常升级流程）
      console.warn('[useAppUpdate] preloaded version compare failed, keeping:', e)
    }
    // 有效预下载产物 → 恢复 downloaded 态
    state.latestRelease = preloaded.release
    state.state = 'downloaded'
    pendingRestored = true
    // 异步渲染 releaseNotes（与 restorePendingUpdate/checkForUpdate 命中分支一致）
    const localizedNotes = extractLocalizedNotes(preloaded.release.releaseNotes)
    void renderMarkdown(localizedNotes).then((html) => {
      state.releaseNotesHtml = html
    })
    console.log(`[useAppUpdate] restored downloaded state for v${preloaded.release.version}`)
    return true
  } catch (e) {
    console.warn('[useAppUpdate] restorePreloadedUpdate failed:', e)
    return false
  }
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
 * 清理自动检测定时器（防泄漏）。onScopeDispose 与 _resetForTest 都调它。
 */
function clearAutoCheckTimer(): void {
  if (autoCheckTimer !== null) {
    clearTimeout(autoCheckTimer)
    autoCheckTimer = null
  }
}

/**
 * visibilitychange 补查（Q1-6）：hidden 期间被跳过的联网检测，恢复可见时立即补一次。
 * 清掉已排定的周期 timer 再跑 runAutoCheck（其内部会重排下一周期），避免补查 + 周期双跑。
 */
function onVisibilityChange(): void {
  if (document.visibilityState !== 'visible' || !skippedWhileHidden) return
  skippedWhileHidden = false
  clearAutoCheckTimer()
  void runAutoCheck()
}

/** 幂等挂载/卸载 visibilitychange listener（initAutoCheck 多次调用防叠加） */
function attachVisibilityListener(): void {
  if (visibilityListenerAttached) return
  document.addEventListener('visibilitychange', onVisibilityChange)
  visibilityListenerAttached = true
}

function detachVisibilityListener(): void {
  if (!visibilityListenerAttached) return
  document.removeEventListener('visibilitychange', onVisibilityChange)
  visibilityListenerAttached = false
}

/**
 * 自动检测单次执行：守卫检查 → 检测（force=true 绕过缓存）→ 排下一个周期定时器。
 *
 * 守卫：仅在 idle/available/error/unsupported 态调 checkForUpdate；downloading/verifying/
 * replacing/restarting/downloaded 态跳过本次检查（不打断升级流程），但仍排下一次定时器，
 * 保证升级完成后能继续周期检测。
 *
 * visibility 守卫（Q1-6）：document.hidden 时跳过联网检测（后台隐藏期间不发 20min 请求，
 * 省 GitHub API 配额），置 skippedWhileHidden 标记，恢复可见时由 onVisibilityChange 补查。
 *
 * force=true：绕过 release-checker 的 1h 缓存，确保每次周期真正联网（避免缓存未命中新版）。
 */
async function runAutoCheck(): Promise<void> {
  autoCheckTimer = null // 当前 timer 已触发
  const canCheck =
    state.state === 'idle' ||
    state.state === 'available' ||
    state.state === 'error' ||
    state.state === 'unsupported'
  if (canCheck && document.hidden) {
    // 后台隐藏期间不联网，恢复可见时补查
    skippedWhileHidden = true
  } else if (canCheck) {
    skippedWhileHidden = false
    await checkForUpdate(true)
  }
  // await 期间 scope 可能已 dispose（此时无 pending timer 可清）：
  // 已 dispose 则不排下一周期，防卸载后 20min 仍联网（W05 review）
  if (disposed) return
  // 无论本次是否检查，都排下一次周期（保证升级完成后继续周期检测）
  autoCheckTimer = setTimeout(runAutoCheck, AUTO_CHECK_INTERVAL_MS)
}

/**
 * 读取启动结果并显示 toast 通知（D5 决策）。
 *
 * main 侧 cleanupCompletedUpdate 在 bootstrapMainWindow 之前运行，返回值缓存在进程级变量。
 * renderer 启动时 invoke 一次 update:getLaunchResult（consumed 一次性，main 清缓存）：
 * - done → info toast sidebar.update.upgradedToast
 * - failed → warning toast sidebar.update.upgradeFailed
 * - rolled-back → warning toast sidebar.update.rolledBack
 *
 * 调用时机：initAutoCheck 内（Sidebar 挂载即触发，早于 30s 自动检查）。
 */
async function checkLaunchResult(): Promise<void> {
  try {
    const result = await ipcGetLaunchResult()
    if (!result) return
    const { info, warning } = useToast()
    if (result.status === 'done') {
      info(t('sidebar.update.upgradedToast', { version: result.version }))
    } else if (result.status === 'rolled-back') {
      warning(t('sidebar.update.rolledBack', { version: result.version }))
    } else if (result.status === 'failed') {
      warning(t('sidebar.update.upgradeFailed'))
    }
  } catch (e) {
    // best-effort：启动结果通知失败不影响升级流程，用户下次启动仍可重试读取（main 侧缓存未 consumed）
    console.warn('[useAppUpdate] checkLaunchResult failed:', e)
  }
}

/**
 * 启动自动检测：先恢复持久化提醒（立即），再 30s 首次检测，之后每 20min 周期检测。
 *
 * 必须在活跃 effect scope 内调用，通常在组件 setup 顶层同步调用（onScopeDispose 依赖活跃 scope）；
 * 定时器不需要等 DOM 挂载，故不必放 onMounted。onScopeDispose 清理定时器避免泄漏。
 *
 * 周期机制：30s 首次 → 首次完成（await）→ 20min 周期（递归 setTimeout）。详见 runAutoCheck。
 */
function initAutoCheck(): void {
  // 防重复 init：先清已有 timer（多消费者场景只保留最新周期，避免泄漏）
  clearAutoCheckTimer()
  skippedWhileHidden = false
  disposed = false // 新 init 复活周期检测（此前 scope dispose 置位过则清除）
  attachVisibilityListener()
  // 先恢复 preloaded（downloaded 态，优先级高于 pending）
  void restorePreloadedUpdate().then((restored) => {
    if (!restored) {
      // preloaded 无效 → 回退 restorePendingUpdate（available 态）
      void restorePendingUpdate()
    }
  })
  // 读取启动结果（升级成功/失败/回滚），consumed 一次性：首次调用返回结果并清空
  void checkLaunchResult()
  // 30s 后首次联网检测（避开冷启动高峰 + 刷新 release info），首次完成后转 20min 周期
  autoCheckTimer = setTimeout(runAutoCheck, AUTO_CHECK_DELAY_MS)
  onScopeDispose(() => {
    clearAutoCheckTimer()
    detachVisibilityListener()
    disposed = true // 标记已卸载：在跑的 runAutoCheck await 恢复后不再排下一周期
  })
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
    performDownload,
    performInstall,
    openFallbackUrl,
    initAutoCheck,
    // restorePendingUpdate/restorePreloadedUpdate 暴露供测试直接调用（绕过 initAutoCheck 的 30s 定时器），
    // 运行时由 initAutoCheck 内部触发，组件通常不需要直接调。
    restorePendingUpdate,
    restorePreloadedUpdate,
  }
}

/**
 * 重置单例 state（仅供测试使用）。
 * module-level state 跨测试会残留，需在 beforeEach 显式重置以保证用例隔离。
 * refCount/renderToken/errorHandled 一并重置（module-level 闭包变量同样跨用例残留）。
 */
export function _resetForTest(): void {
  clearAutoCheckTimer()
  detachVisibilityListener()
  state.state = 'idle'
  state.latestRelease = null
  state.errorMessage = ''
  state.errorSuggestion = ''
  state.percent = 0
  state.releaseNotesHtml = ''
  errorHandled = false
  refCount = 0
  renderToken = 0
  pendingRestored = false
  skippedWhileHidden = false
  disposed = false
}
