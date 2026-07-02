/**
 * useDetailPane —— 文件预览编排（#6，UC-6 点文件落地预览）。
 *
 * 职责（单一变化轴「文件预览内容加载」）：
 * - watch fileTreeStore.selectedPath + sessionId → openPreview
 * - openPreview：git 改动文件 → git.getDiff（patch）；未改动 → file.read（content）
 * - viewMode 切换（diff/preview），当文件既有 git 改动又是普通文件可手动切换
 *
 * 数据流（code-architecture §4 功能3）：
 *   点文件 → store.selectFile → DetailPane 挂载 → useDetailPane.openPreview →
 *   (gitOverlay 判定: 改动→git.getDiff / 未改动→file.read) → 渲染（禁 v-html，文本插值/<pre>）
 *
 * 依赖方向：useDetailPane → fileTreeStore + api/domains（file/git）。不直接 import chat store。
 *
 * [NFR-AC-S4] 禁 v-html：本 composable 只负责取数据，渲染层 DetailPane.vue 用文本插值/<pre>，
 * 不用 v-html（T6.10 XSS 断言——含 <script> 的内容被转义不执行）。
 */
import { ref, watch, type Ref } from 'vue'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSessionStore } from '@/stores/session'
import { file as fileApi, git as gitApi } from '@/api'
import { detectFileKind, type FileKind } from '@/composables/logic/file-type'

/** 预览加载态 */
export type PreviewStatus = 'idle' | 'loading' | 'content' | 'error'

/** 预览视图模式（diff=显示 git patch，preview=显示文件原始内容） */
export type DetailViewMode = 'diff' | 'preview'

export interface DetailPaneState {
  status: PreviewStatus
  /** 文件内容（preview 模式）或 diff patch（diff 模式） */
  content: string
  /** 是否截断（>1MB，file.read 返回） */
  truncated: boolean
  /** 是否二进制文件（git.diff 返回 binary=true） */
  binary: boolean
  /** 错误信息（status='error' 时） */
  error: string
  /** 当前视图模式 */
  viewMode: DetailViewMode
  /** 当前预览的文件路径 */
  path: string | null
  /** 该文件是否有 git 改动（决定默认 viewMode：改动→diff，未改动→preview） */
  hasGitChange: boolean
  /**
   * 文件渲染类别（preview 模式下由 detectFileKind 判定，决定 DetailPane 选哪个渲染器）。
   * diff 模式下渲染层用 DiffView（统一），kind 仅供兜底参考。
   */
  kind: FileKind
}

function initialState(): DetailPaneState {
  return {
    status: 'idle',
    content: '',
    truncated: false,
    binary: false,
    error: '',
    viewMode: 'preview',
    path: null,
    hasGitChange: false,
    kind: 'text',
  }
}

export function useDetailPane(sessionId: Ref<string | null>) {
  const store = useFileTreeStore()
  const sessionStore = useSessionStore()
  const state = ref<DetailPaneState>(initialState())

  /**
   * 取当前 session 的 cwd 绝对路径（图片渲染拼 local-file:// URL 用）。
   * sessionStore.list 按 id 查 SessionSummary.cwd；无 session 返回 null。
   */
  function sessionCwd(sid: string | null): string | null {
    if (!sid) return null
    return sessionStore.list.find((s) => s.id === sid)?.cwd ?? null
  }

  /**
   * 加载文件预览（code-architecture §4 功能3 时序）。
   * - git 改动文件（gitOverlay 有记录）→ git.getDiff，默认 viewMode='diff'
   * - 未改动文件 → file.read(sessionId, path) cwd 守门，默认 viewMode='preview'
   * - 加载在途 → status='loading'（DetailPane 显骨架态，AC-6.6/T6.7）
   * - 失败 → status='error'（AC-6.4/T6.4）
   *
   * 调用方负责定 viewMode 并设 status='loading'，再委托 loadContent 取数据。
   */
  async function loadContent(sid: string, path: string, mode: DetailViewMode): Promise<void> {
    try {
      if (mode === 'diff') {
        const result = await gitApi.getDiff(sid, path)
        state.value.binary = result.binary
        state.value.content = result.patch
      } else {
        const result = await fileApi.read(path, sid)
        state.value.content = result.content
        state.value.truncated = result.truncated
      }
      state.value.status = 'content'
    } catch (e) {
      state.value.status = 'error'
      state.value.error = (e as Error)?.message ?? '加载失败'
    }
  }

  async function openPreview(sid: string, path: string): Promise<void> {
    state.value = { ...initialState(), status: 'loading', path, viewMode: state.value.viewMode }
    // 判断 git 改动：gitOverlay per-session 查（含 untracked，T2.8b untracked 也算改动可 diff）
    const gitStatus = store.getGitStatus(sid, path)?.status
    state.value.hasGitChange = !!gitStatus
    // 默认 viewMode：有 git 改动 → diff；无 → preview（首次加载时定，不覆盖用户手动切换）
    const mode: DetailViewMode = gitStatus ? 'diff' : 'preview'
    state.value.viewMode = mode
    // 文件渲染类别（preview 模式渲染器选择依据；diff 模式统一走 DiffView）
    state.value.kind = detectFileKind(path)

    await loadContent(sid, path, mode)
  }

  /**
   * 切换视图模式（diff ↔ preview）。切换后重新加载对应内容。
   * 仅当文件同时有 git 改动（可 diff）且可读（可 preview）时有效。
   */
  async function toggleView(mode: DetailViewMode): Promise<void> {
    const sid = sessionId.value
    const path = state.value.path
    if (!sid || !path || state.value.viewMode === mode) return
    state.value.viewMode = mode
    state.value.status = 'loading'
    state.value.error = ''
    await loadContent(sid, path, mode)
  }

  /** 清空预览（关闭 drawer / 取消选中时） */
  function clearPreview(): void {
    state.value = initialState()
  }

  /**
   * watch selectedPath + sessionId：选中文件变化 → 自动 openPreview。
   * selectedPath 由 FileTreeRow.onSelectFile 经 useFileTree.selectFile 设置。
   * sessionId 为 null（无 active session）→ 清空预览。
   */
  watch(
    [() => store.selectedPath, sessionId],
    ([path, sid]) => {
      if (!sid || !path) {
        clearPreview()
        return
      }
      void openPreview(sid, path)
    },
    { immediate: true },
  )

  return {
    state,
    openPreview,
    toggleView,
    clearPreview,
    sessionCwd,
  }
}
