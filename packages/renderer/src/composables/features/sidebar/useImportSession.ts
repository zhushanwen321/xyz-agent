/**
 * useImportSession —— 「导入会话」对话框状态编排（import-session U5）。
 *
 * 来源设计：docs/design/import-session.md §3.3 D5（RPC 契约）+ §3.1 终态交互样例。
 *
 * 职责边界：纯状态编排（query debounce 拉候选 / 目录过滤 / 选中 / 执行导入 /
 * 「选择其他目录」切扫描根重拉），不含 DOM 与 i18n 文案映射（错误码 → 恢复指引
 * 文案在组件层）。无 per-session 状态（ADR-0049 不适用：对话框是全局单例 UI，
 * 非 session 隔离域）。
 *
 * 竞态防护：快速连续输入时 debounce 触发的并发请求用递增 seq 守卫——仅最新
 * 一次请求允许写回 items/dirs/total，stale 响应静默丢弃（避免旧结果覆盖新结果）。
 */
import { computed, ref, watch } from 'vue'
import type {
  ImportCandidate,
  ImportCandidateDir,
  ImportErrorCode,
  ImportWarning,
} from '@xyz-agent/shared'
import { session as sessionApi } from '@/api'
import { useToast } from '@/composables/useToast'
import { useProjectStore } from '@/stores/project'
import { pickDirectory } from '@/lib/ipc'
import i18n from '@/i18n'

const t = i18n.global.t

/** 搜索输入到发起候选查询的防抖间隔（D5：renderer 侧 debounce 250ms） */
export const IMPORT_SEARCH_DEBOUNCE_MS = 250

/**
 * error envelope 透传到 Error.code 的合法值集合：ImportErrorCode 全集（不含
 * `import_sidecar_failed`——它走成功 reply 的 warning 通道，r4-INFO）+
 * transport 层唯一透传 code `timeout`（pending.ts）。
 * 归一化规则因通道而异：导入动作集合外归 `unknown`；候选加载集合外（含表外
 * 兜底码 import_unsupported/import_failed）归 null → 通用失败文案 + 重试
 * （设计 §3.3 表外兜底码说明：勿按表穷举，须有 default 分支）。
 */
const FAILURE_CODES: ReadonlySet<string> = new Set([
  'import_source_missing',
  'import_invalid_session',
  'import_marker_filename',
  'import_dir_unreadable',
  'import_already_imported',
  'import_target_conflict',
  'import_copy_failed',
  'import_project_invalid',
  'timeout',
])

/** 导入失败码（内联展示用；文案映射 key = `importSession.errors.<code>`） */
export type ImportFailureCode = ImportErrorCode | 'timeout' | 'unknown'

/** 导入成功回调载荷（消费方据此 toast / 刷新，runtime 侧已广播 session.list） */
export interface ImportSessionImportedPayload {
  sessionId: string
  /** 会话显示名（name 为空时回退所属目录名，与列表行一致） */
  sessionName: string
  /** 导入目标 project 显示名（默认 project 回退「默认项目」） */
  projectName: string
  /** 导入落地路径 */
  targetPath: string
  /** sidecar 写失败降级标记（文件已落地不回滚，消费方可选提示） */
  warning?: ImportWarning
}

export interface UseImportSessionOptions {
  /** 导入成功（reply 已返回、对话框即将关闭）后的回调 */
  onImported?: (payload: ImportSessionImportedPayload) => void
}

export function useImportSession(options: UseImportSessionOptions = {}) {
  const projectStore = useProjectStore()
  const toast = useToast()

  const open = ref(false)
  const query = ref('')
  const items = ref<ImportCandidate[]>([])
  const dirs = ref<ImportCandidateDir[]>([])
  /** 过滤前总数（reply.total，供统计展示） */
  const total = ref(0)
  const loading = ref(false)
  const loadFailed = ref(false)
  /**
   * 候选加载失败码（与导入失败 importErrorCode 同套 FAILURE_CODES 归一化）：
   * null = 无专属恢复指引（表外兜底码 / 未识别码），组件层显示通用失败文案。
   */
  const loadErrorCode = ref<ImportFailureCode | null>(null)
  /** 目录 chip 过滤（'' = 全部目录；客户端过滤，RPC query 不含目录维度） */
  const selectedDir = ref('')
  /**
   * 当前扫描根（null = 缺省 ~/.pi/agent/sessions，D5 rootDir 可选语义——
   * 缺省不传字段，runtime 侧动态推导，禁止 renderer 硬编码路径）。
   */
  const rootDir = ref<string | null>(null)
  /** 导入目标 project（resetForOpen 时默认当前活跃 project） */
  const selectedProjectId = ref('')
  /** 当前点选的候选（sessionId；列表行高亮 + 底部导入按钮的作用对象） */
  const selectedId = ref<string | null>(null)
  const importing = ref(false)
  const importErrorCode = ref<ImportFailureCode | null>(null)

  /** 请求序号：仅最新请求可写回（stale 响应丢弃） */
  let requestSeq = 0
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  /** 目录 chip 过滤后的可见候选（已按 lastModified 降序，runtime 保证） */
  const filteredItems = computed<ImportCandidate[]>(() => {
    if (selectedDir.value === '') return items.value
    return items.value.filter((item) => item.dirLabel === selectedDir.value)
  })

  /** 路径模式判定：query 以 '/' 或 '~' 开头（D5 S7 renderer 侧切换；runtime 无分支） */
  const isPathMode = computed<boolean>(() => /^[~/]/.test(query.value.trim()))

  /**
   * 路径模式命中条目：候选中 sourcePath includes query 的首条（items 已按
   * lastModified 降序）。runtime 的 includes 匹配天然覆盖路径输入，此处只在
   * renderer 侧收敛到「路径行」单一命中语义（demo 方案 A path-bar）。
   */
  const pathHit = computed<ImportCandidate | null>(() => {
    if (!isPathMode.value) return null
    const q = query.value.trim().toLowerCase()
    return items.value.find((item) => item.sourcePath.toLowerCase().includes(q)) ?? null
  })

  /**
   * 当前目标 project 显示名（trigger 常显 + imported payload 复用）。
   * 不用 SelectValue 自动 label：其依赖 optionsSet（SelectItem 渲染时注册），
   * 初始未打开过下拉时为空，用户看不到「默认当前激活 project」。
   */
  const selectedProjectName = computed<string>(() => {
    const project =
      projectStore.projects.find((p) => p.id === selectedProjectId.value) ?? projectStore.projects[0]
    return project ? project.name || t('importSession.defaultProjectName') : ''
  })

  const selectedItem = computed<ImportCandidate | null>(
    () => filteredItems.value.find((item) => item.sessionId === selectedId.value) ?? null,
  )

  /** 底部「导入」可用性：有选中 + 选中未导入过 + 不在导入中 */
  const canConfirm = computed<boolean>(() => {
    const item = selectedItem.value
    return item != null && !item.alreadyImported && !importing.value
  })

  function close(): void {
    open.value = false
  }

  /**
   * 拉取候选列表。query 为空 = 全量（limit 截断在 runtime）；rootDir 仅在
   * 「选择其他目录」切过根后携带（缺省根由 runtime 推导，payload 不含该字段）。
   */
  async function fetchCandidates(): Promise<void> {
    const seq = ++requestSeq
    loading.value = true
    loadFailed.value = false
    loadErrorCode.value = null
    try {
      const trimmed = query.value.trim()
      const payload: { rootDir?: string; query?: string } = {}
      if (rootDir.value) payload.rootDir = rootDir.value
      if (trimmed) payload.query = trimmed
      const reply = await sessionApi.importCandidates(payload)
      if (seq !== requestSeq) return
      items.value = reply.items
      dirs.value = reply.dirs
      total.value = reply.total
    } catch (e) {
      if (seq !== requestSeq) return
      // 与导入动作同套归一化：识别码按码展示恢复指引（V6 dir_unreadable 可达），
      // 表外/未识别码归 null → 通用失败 + 重试（default 分支）
      const code = (e as { code?: unknown }).code
      loadErrorCode.value =
        typeof code === 'string' && FAILURE_CODES.has(code) ? (code as ImportFailureCode) : null
      loadFailed.value = true
      items.value = []
      dirs.value = []
      total.value = 0
    } finally {
      if (seq === requestSeq) loading.value = false
    }
  }

  /** debounce 包装的拉取（搜索框输入抖动防护）；pending 期间再输入则重置计时 */
  function debouncedFetch(): void {
    if (debounceTimer != null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void fetchCandidates()
    }, IMPORT_SEARCH_DEBOUNCE_MS)
  }

  /** 取消 pending debounce（关闭对话框时；in-flight RPC 结果由 seq 守卫丢弃） */
  function cancelPendingFetch(): void {
    if (debounceTimer != null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  }

  // 搜索输入 → 查询：清空立即拉取（回到全量），非空 debounce 250ms（D5）
  watch(query, (value) => {
    if (value.trim()) debouncedFetch()
    else void fetchCandidates()
  })

  /** 打开对话框：重置全部状态 + 默认导入到当前活跃 project + 立即拉取 */
  function resetForOpen(): void {
    open.value = true
    cancelPendingFetch()
    requestSeq++
    const prevTrimmed = query.value.trim()
    query.value = ''
    selectedDir.value = ''
    rootDir.value = null
    selectedId.value = null
    importing.value = false
    importErrorCode.value = null
    loadFailed.value = false
    loadErrorCode.value = null
    items.value = []
    dirs.value = []
    total.value = 0
    selectedProjectId.value = projectStore.activeProjectId
    // query 非空 → 置空会触发上方 watch 的立即拉取；原本就为空则 watch 不触发，在此显式首拉
    if (!prevTrimmed) void fetchCandidates()
  }

  function select(sessionId: string): void {
    selectedId.value = sessionId
  }

  /**
   * 「选择其他目录」（V8）：OS 原生目录选择器 → 选中则切换扫描根并带新 rootDir
   * 重拉候选（D5：打开/搜索/切目录都走 importCandidates）；取消（canceled 或无
   * path）无任何操作。切根后目录过滤/选中/错误态回到初始（新根的 dirs 全新，
   * 旧 selectedDir 在其中无意义）；搜索词保留——跨根找同一目标的 V9 场景依赖。
   */
  async function chooseRootDir(): Promise<void> {
    const result = await pickDirectory({ title: t('importSession.chooseDirTitle') })
    if (result.canceled || !result.path) return
    rootDir.value = result.path
    selectedDir.value = ''
    selectedId.value = null
    importErrorCode.value = null
    void fetchCandidates()
  }

  /**
   * 执行导入（列表行按钮 / 底部确认共用）。
   * 成功：warning='sidecar_failed' 走降级 toast（文件已落地不回滚，引导手动归类）
   * → onImported 回调 → 关闭；失败：error envelope code 归一化后内联展示（组件层映射文案）。
   */
  async function importSession(candidate: ImportCandidate): Promise<void> {
    if (importing.value || candidate.alreadyImported) return
    importing.value = true
    importErrorCode.value = null
    try {
      const reply = await sessionApi.importSession({
        sourcePath: candidate.sourcePath,
        projectId: selectedProjectId.value,
      })
      if (reply.warning === 'sidecar_failed') {
        toast.warning(t('importSession.toastSidecarFailed'))
      }
      options.onImported?.({
        sessionId: reply.sessionId,
        sessionName: candidate.name || candidate.dirLabel,
        projectName: selectedProjectName.value,
        targetPath: reply.targetPath,
        warning: reply.warning,
      })
      close()
    } catch (e) {
      const code = (e as { code?: unknown }).code
      importErrorCode.value =
        typeof code === 'string' && FAILURE_CODES.has(code) ? (code as ImportFailureCode) : 'unknown'
    } finally {
      importing.value = false
    }
  }

  return {
    open,
    query,
    items,
    dirs,
    total,
    loading,
    loadFailed,
    loadErrorCode,
    selectedDir,
    rootDir,
    selectedProjectId,
    selectedProjectName,
    selectedId,
    importing,
    importErrorCode,
    filteredItems,
    isPathMode,
    pathHit,
    selectedItem,
    canConfirm,
    close,
    resetForOpen,
    select,
    chooseRootDir,
    importSession,
    fetchCandidates,
    debouncedFetch,
    cancelPendingFetch,
  }
}
