/**
 * useSearchModalDeps —— SearchDeps 壳组装（new-task-search 域 w5）。
 *
 * ui 包 SearchModal（w4 迁入）经 props.deps 消费 search 编排依赖（SearchDeps）。
 * 本 composable 把 renderer 真实现适配组装：
 * - ports 7 项：isMock（VITE_MOCK）/ isMac（navigator.platform，D8 收编）/ searchMock
 *   （mockApi.search.query）/ fileRead（api/domains/file.read，AC-6.9 不经吞错层）/
 *   fileCandidates（api/domains/composer.getFileCandidates）/ sessionList（api/domains/session.list）/
 *   selectSession（壳传入 useSidebarNew().selectSession，C-W3-2）/ watchFileChanges
 *   （useFileChangeInvalidation.watchFileChangesForInvalidation，C-W3-3）/ t（i18n）
 * - commandStore：壳单例 useCommandStore()（core createCommandStore 实例，须在
 *   providePlatform 之后——AppShell 时序保证）
 * - fileSearchStore：createFileSearchStore() 模块级单例（Sidebar/Composer 共享缓存）
 * - storage：getPlatform().storage（recents 持久化，C-W3-4）
 * - fileTree：fileTreeStore.selectFile + useFileTree().loadTree（FileTreePort）
 * - appCommandActions：newSession/goOverview（壳传入）+ toggleSidebar（useSidebarStore）
 *   + requestPresetOpen（usePresetStore）（C-W3-5）
 *
 * 参数注入（与 useAppCommands 的 actions 注入破环同模式）：selectSession/newSession/
 * goOverview 是 useSidebarNew 实例方法（Sidebar 已实例化），由调用方传入避免重复实例化。
 */
import { ref } from 'vue'
import { createFileSearchStore, getPlatform } from '@xyz-agent/core'
import type { SearchDeps } from '@xyz-agent/core'
import * as fileApi from '@/api/domains/file'
import * as composerApi from '@/api/domains/composer'
import * as sessionApi from '@/api/domains/session'
import * as mockApi from '@xyz-agent/core/transport/mock'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { useFileTree } from '@/composables/features/file-tree/useFileTree'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSidebarStore } from '@/stores/sidebar'
import { usePresetStore } from '@/stores/preset'
import { watchFileChangesForInvalidation } from '@/composables/features/file-tree/useFileChangeInvalidation'
import i18n from '@/i18n'

/** file search store 单例（Sidebar SearchModal 与 CommandPopover 共享 session 级缓存）。 */
let fileSearchStoreInstance: ReturnType<typeof createFileSearchStore> | null = null

export interface SearchModalShellDeps {
  selectSession: (id: string) => Promise<void>
  newSession: () => void
  goOverview: () => void
}

export function useSearchModalDeps(shell: SearchModalShellDeps): SearchDeps {
  const commandStore = useCommandStore()
  if (!fileSearchStoreInstance) fileSearchStoreInstance = createFileSearchStore()
  const sidebarStore = useSidebarStore()
  const presetStore = usePresetStore()
  const fileTreeStore = useFileTreeStore()

  // [tc-transport-consolidation D4-②] isMock 构建期常量：searchMock 引用点整体条件化——
  // 生产构建（VITE_MOCK 非 true）下 mockApi.search 属性引用随死分支 DCE，mock 模块链
  // 摇除（A7 探针门）；mock 构建下注入 core mock fixture（SearchPorts.searchMock 可选）。
  const isMock = import.meta.env.VITE_MOCK === 'true'

  return {
    ports: {
      isMock,
      isMac: navigator.platform.includes('Mac'),
      searchMock: isMock ? mockApi.search.query : undefined,
      fileRead: (path, sessionId) => fileApi.read(path, sessionId).then(() => {}),
      fileCandidates: composerApi.getFileCandidates,
      sessionList: sessionApi.list,
      // C-W3-2：SessionSelectPort 接收点归实现域（useSidebarNew().selectSession）
      selectSession: shell.selectSession,
      // C-W3-3：FileChangeWatchPort 替代 chatStore.messages watch（stale cache 防护；
      // W19/D-9 后 helper 内部为 ready 帧驱动——ready 清单到达时回调）
      watchFileChanges: (sid, cb) =>
        watchFileChangesForInvalidation(ref(sid), (s) => cb(s)),
      t: i18n.global.t,
    },
    commandStore,
    fileSearchStore: fileSearchStoreInstance,
    storage: getPlatform().storage,
    fileTree: {
      loadTree: (sid) => useFileTree().loadTree(sid),
      selectFile: (path) => fileTreeStore.selectFile(path),
    },
    appCommandActions: {
      newSession: shell.newSession,
      goOverview: shell.goOverview,
      toggleSidebar: () => sidebarStore.toggleCollapsed(),
      requestPresetOpen: () => presetStore.requestOpen(),
    },
  }
}
