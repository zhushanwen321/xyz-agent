/**
 * ChatViewDeps —— ui 包 chat 组件消费壳层依赖的唯一契约（w6 chat-ui-and-shell）。
 *
 * ui 包展示组件不直接 import renderer store/composable（反向依赖禁令），
 * 所有跨层依赖（store 数据 / RPC 回调 / DOM 副作用编排）经此 inject token 注入。
 * renderer 壳层（MessageStream.vue）provide 真 renderer 实现。
 *
 * 设计依据：clarify Q3 inject token 裁决（避免 Turn→Block→MarkdownRenderer 三层 prop-drilling）。
 */
import type { InjectionKey } from 'vue'
import { inject } from 'vue'
import type { FileNode, Message } from '@xyz-agent/shared'

/**
 * ChatView 依赖端口（shell → ui 展示层注入）。
 *
 * 字段分三类：
 * - 数据获取器（读 store 派生状态）：getMessages/isActive/isHandingOff/getChangeSetStatus/isExpanded
 * - 操作回调（触发 RPC / store action）：toggleExpand/abortBash/editAndResend/onFork/onHandoff/openDrawer/onFileClick/onAmbiguousSelect
 * - 数据加载/渲染（纯函数经壳桥接）：loadFileCandidates/renderMarkdown
 */
export interface ChatViewDeps {
  // ── 数据获取器（读 chat/session store 派生状态）──
  /** 取当前 session 的消息列表（经 useChatStore 分区派生） */
  getMessages: (sessionId: string) => Message[]
  /** session 是否活跃（有 pi 子进程） */
  isActive: (sessionId: string) => boolean
  /** session 是否正在 handoff 中（TurnSummary fork/handoff 按钮态） */
  isHandingOff: (sessionId: string) => boolean
  /** 取 session 的 changeset 状态（ChangeSetCard 状态渲染） */
  getChangeSetStatus: (sessionId: string) => 'idle' | 'pending' | 'applied' | 'superseded' | undefined
  /** turn 是否展开（useTurnExpansion store 派生，Turn/TurnMeta 消费） */
  isExpanded: (turnId: string) => boolean

  // ── 操作回调（触发 RPC / store action）──
  /** 切换 turn 展开/折叠（useTurnExpansion store action） */
  toggleExpand: (turnId: string) => void
  /** 中止 bash 执行（useChat.abortBash 经壳桥接） */
  abortBash: (sessionId: string, messageId: string) => void
  /** 编辑并重发 user message（useChat.editAndResend 经壳桥接） */
  editAndResend: (sessionId: string, messageId: string, text: string) => void
  /** fork turn（useTurnActions.fork RPC） */
  onFork: (sessionId: string, turnId: string) => void
  /** handoff turn（useTurnActions.handoff RPC） */
  onHandoff: (sessionId: string, turnId: string) => void
  /** 打开 drawer tab（useSideDrawer.open 经壳桥接） */
  openDrawer: (tab: string) => void
  /** 点击文件路径（useFileTree.selectFile 经壳桥接） */
  onFileClick: (path: string) => void
  /** 歧义文件选择（AmbiguousFilePopover select 经壳桥接） */
  onAmbiguousSelect: (path: string) => void

  // ── 数据加载 / 渲染（纯函数经壳桥接）──
  /** 加载文件候选（MarkdownRenderer 歧义解析，useFileSearch 经壳桥接） */
  loadFileCandidates: (sessionId: string, basename: string) => Promise<FileNode[]>
  /** 渲染 markdown 为 HTML（renderMarkdownSegments 经壳桥接，MarkdownRenderer 消费） */
  renderMarkdown: (source: string, sessionId?: string) => string
}

/** ChatViewDeps inject token（InjectionKey 保类型安全） */
export const ChatViewDepsKey: InjectionKey<ChatViewDeps> = Symbol('ChatViewDeps')

/**
 * inject ChatViewDeps helper。token 缺失时抛错（防运行时 undefined 调用崩溃）。
 * ui 组件 setup 顶部调 const deps = useChatViewDeps()。
 */
export function useChatViewDeps(): ChatViewDeps {
  const deps = inject(ChatViewDepsKey)
  if (!deps) {
    throw new Error(
      '[ChatViewDeps] inject 缺失：组件必须在 <ChatView>（或 provide ChatViewDepsKey 的容器）内渲染。' +
        'renderer 壳层 MessageStream.vue 应 provide(ChatViewDepsKey, realDeps)。',
    )
  }
  return deps
}
