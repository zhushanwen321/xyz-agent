/**
 * useNewTaskFlow —— 新建任务流程编排（壳适配版，new-task-search 域 w5）。
 *
 * [归位] w2 core flow.ts 迁入 core 域后，本文件改写为壳：构造 NewTaskFlowDeps
 * （12 端口适配 renderer api/stores/composables，与旧实现逐条对齐）+ 模块级单例缓存
 * core useNewTaskFlow 实例。Landing.vue 与 useSidebarNew 都调本壳拿同一 core 实例
 * （core flow-state 是 core 包模块级单例，renderer 旧 useNewTaskFlowState 是 renderer 包
 * 模块级单例，两套互不相通——双状态机会断裂，故必须统一实例）。
 *
 * 端口适配映射（C-NT-2 / C-SS-2 / D8 裁决）：
 * - createSessionFlow：core domain/session createSessionFlow(ctx, input) 包一层
 *   （ctx 的 store/api/defaultCwd/onCwdFallback/applyModel 由本壳组装）
 * - chat：useChat().send / sendBash
 * - navigation：useSessionStore().activeId + usePanelStore().loadSession +
 *   useNavigationStore().push + useWorkspaceStore().defaultCwd
 * - toast：useToast().error / warning
 * - fileTree：useFileTree().loadTree + useFileTreeStore().selectFile
 * - t：i18n.global.t
 * - migrateImage：sessionApi.migrateImage
 * - gitApi：@/api git domain（checkout/checkoutByCwd/createBranch）
 * - directoryPicker：lib/ipc pickDirectory
 * - workspaceApi：@/api workspace.detect + worktreeApi.list
 * - workspaceState：useWorkspaceStore().defaultCwd / record
 *
 * 公共 API 兼容：useNewTaskFlow() 返回类型与旧版逐字段对齐（core flow 返回面一致）；
 * resetNewTaskFlow / NewTaskFlowState / GitInfo 重导出改从 @xyz-agent/core（旧消费方
 * 与测试 import 路径不变即获得 core 版）。
 */
import { session as sessionApi, git as gitApi, workspace as workspaceApi } from '@/api'
import * as events from '@/api/events'
import { createSessionFlow, useNewTaskFlow as useCoreNewTaskFlow } from '@xyz-agent/core'
import type { CreateSessionFlowCtx, SessionApiPort } from '@xyz-agent/core'
import { useSessionStore } from '@/stores/session'
import { useWorkspaceStore } from '@/stores/workspace'
import { usePanelStore } from '@/stores/panel'
import { useNavigationStore } from '@/stores/navigation'
import { useChat } from '@/composables/features/chat/useChat'
import { useModel } from '@/composables/features/model/useModel'
import { useFileTree } from '@/composables/features/file-tree/useFileTree'
import { useFileTreeStore } from '@/stores/fileTree'
import { useToast } from '@/composables/useToast'
import { worktreeApi } from '@/api/domains/worktree'
import { pickDirectory } from '@/lib/ipc'
import i18n from '@/i18n'

const t = i18n.global.t

// 重导出供既有 import 消费（types + reset 原从本模块导入，改从 core 获得）
export type { NewTaskFlowState, GitInfo } from '@xyz-agent/core'
export { resetNewTaskFlow } from '@xyz-agent/core'

/**
 * 构建 SessionApiPort 适配（createSessionFlow ctx.api 注入用）。
 *
 * 与 useSidebarNew.buildSessionApiPort 同一套适配——createSessionFlow 运行时只调
 * create + migrateImage，但 SessionApiPort 类型要求全方法，故全量代理（零转换透传
 * 现 api/domains/session）。
 */
function buildCreateFlowApiPort(): SessionApiPort {
  return {
    list: () => sessionApi.list(),
    switchSession: (id) => sessionApi.switchSession(id),
    create: (cwd, label, presetId) => sessionApi.create(cwd, label, presetId),
    rename: (id, label) => sessionApi.rename(id, label),
    remove: (id) => sessionApi.remove(id),
    removeByCwd: (cwd) => sessionApi.removeByCwd(cwd),
    migrateImage: (p) => sessionApi.migrateImage(p),
    onConfigSessions: (handler) =>
      events.onGlobalType('config.sessions', (msg) => handler(msg.payload.groups)),
  }
}

/** 模块级单例（Landing 与 useSidebarNew 共享同一 core flow 实例）。 */
let cachedFlow: ReturnType<typeof useCoreNewTaskFlow> | null = null

/** 仅测试用：重置单例（pinia 重建后旧实例捕获的 store 引用失效，beforeEach 调；对齐 core reset 先例）。 */
export function __resetNewTaskFlowForTesting(): void {
  cachedFlow = null
}

/**
 * 新建任务流程编排器（壳）。返回 core useNewTaskFlow 实例（单例缓存）。
 */
export function useNewTaskFlow() {
  if (cachedFlow) return cachedFlow
  const session = useSessionStore()
  const workspaceStore = useWorkspaceStore()
  const panel = usePanelStore()
  const navigation = useNavigationStore()
  const chat = useChat()
  const { error: toastError, warning: toastWarning } = useToast()
  // 模型切换 + 思考等级设置的 RPC + 乐观更新编排（features 层，ADR-0028）。
  const { switchModel, setThinkingLevel } = useModel()

  cachedFlow = useCoreNewTaskFlow({
    ports: {
      createSessionFlow: {
        // 会话创建编排（guard→cwd 兜底→label→create→INV-7 降级→appendSession→applyModel→migrateImages）
        createSession: async (input) => {
          const ctx: CreateSessionFlowCtx = {
            // pinia useSessionStore cast——createSessionFlow 只调 store.appendSession
            // （方法调用，pinia proxy 方法调用正常），不碰 ref，故 cast 可行。
            store: session as unknown as CreateSessionFlowCtx['store'],
            api: buildCreateFlowApiPort(),
            defaultCwd: workspaceStore.defaultCwd ?? '',
            // INV-7 cwd 降级比对：runtime create 内部可能降级 homedir，比对不一致 toast 通知。
            onCwdFallback: (reqCwd) => toastError(t('composable.dirNotExist', { dir: reqCwd })),
            // apply landing 态选定模型（pendingModel 为 "provider/modelId" 复合串；空跳过）。
            applyModel: async (sid, pending) => {
              const slashIdx = pending.indexOf('/')
              if (slashIdx > 0) {
                await switchModel(sid, pending.slice(0, slashIdx), pending.slice(slashIdx + 1))
              }
            },
          }
          const result = await createSessionFlow(ctx, input)
          return result
        },
        setThinkingLevel: (sid, level) => setThinkingLevel(sid, level),
      },
      chat: {
        send: (sid, segments) => chat.send(sid, segments),
        sendBash: (sid, command, excludeFromContext) =>
          chat.sendBash(sid, command, excludeFromContext),
      },
      navigation: {
        activePanelId: () => panel.activePanelId,
        loadPanel: (panelId, sid) => {
          if (!panelId) return // 无活跃 panel 时 noop（core 契约）
          panel.loadSession(panelId, sid)
        },
        clearActiveSession: () => {
          session.activeId = null
        },
        setActiveSession: (sid) => {
          session.activeId = sid
        },
        pushChat: (sid) => navigation.push({ view: 'chat', sessionId: sid }),
        defaultCwd: () => workspaceStore.defaultCwd ?? null,
      },
      toast: {
        error: (msg) => toastError(msg),
        warning: (msg) => toastWarning(msg),
      },
      fileTree: {
        loadTree: (sid) => useFileTree().loadTree(sid),
        selectFile: (path) => useFileTreeStore().selectFile(path),
      },
      t,
      migrateImage: {
        migrateImage: (p) => sessionApi.migrateImage(p),
      },
    },
    gitApi: {
      checkout: (sid, name) => gitApi.checkout(sid, name),
      checkoutByCwd: (cwd, name) => gitApi.checkoutByCwd(cwd, name),
      createBranch: (sid, name) => gitApi.createBranch(sid, name),
    },
    directoryPicker: {
      pickDirectory: (p) => pickDirectory(p),
    },
    workspaceApi: {
      detect: (cwd) => workspaceApi.detect(cwd),
      listWorktrees: (cwd) => worktreeApi.list(cwd),
    },
    workspaceState: {
      defaultCwd: () => workspaceStore.defaultCwd ?? null,
      record: (cwd) => workspaceStore.record(cwd),
    },
  })
  return cachedFlow
}
