/**
 * Search mock fixture —— 全局搜索浮层（⌘K）的预制数据。
 *
 * 数据源：移植自 SearchModal.vue 内联 MOCK/RECENTS/SUGGESTED。
 * 后端搜索（LSP / 命令注册表 / 会话库）就绪后接 real domain 替换。
 */
export type SearchType = 'command' | 'file' | 'symbol' | 'session'

export interface SearchItem {
  type: SearchType
  title: string
  sub: string
}

export const SEARCH_MOCK: Record<SearchType, SearchItem[]> = {
  command: [
    { type: 'command', title: '新建任务', sub: '创建一个新会话 · ⌘N' },
    { type: 'command', title: '切换分支', sub: 'git checkout' },
    { type: 'command', title: '收起侧栏', sub: 'toggle sidebar · ⌘B' },
    { type: 'command', title: '打开概览', sub: 'Mission Control' },
    { type: 'command', title: '提交并推送', sub: 'git commit && push' },
  ],
  file: [
    { type: 'file', title: 'auth/session.ts', sub: 'refactor-arch/src/auth' },
    { type: 'file', title: 'auth/token.ts', sub: 'refactor-arch/src/auth' },
    { type: 'file', title: 'use-auth.ts', sub: 'refactor-arch/src/composables' },
    { type: 'file', title: 'session-store.ts', sub: 'refactor-arch/src/stores' },
    { type: 'file', title: 'Sidebar.vue', sub: 'refactor-arch/src/components/sidebar' },
  ],
  symbol: [
    { type: 'symbol', title: 'authenticate()', sub: 'auth/session.ts:42' },
    { type: 'symbol', title: 'AuthToken', sub: 'auth/token.ts:8' },
    { type: 'symbol', title: 'SessionStore', sub: 'session-store.ts:12' },
    { type: 'symbol', title: 'useAuth()', sub: 'use-auth.ts:4' },
  ],
  session: [
    { type: 'session', title: 'Auth 重构 · token 轮转', sub: 'refactor-arch · main · 14:32' },
    { type: 'session', title: '搜索浮层设计', sub: 'refactor-arch · feat-search' },
    { type: 'session', title: 'Workspace 双 Panel', sub: 'agent-skeleton · main' },
    { type: 'session', title: 'git 工作流打磨', sub: 'feat-gitflow · dev' },
  ],
}

export const SEARCH_RECENTS: SearchItem[] = [
  { type: 'file', title: 'auth/session.ts', sub: 'refactor-arch/src/auth' },
  { type: 'session', title: 'Auth 重构 · token 轮转', sub: 'refactor-arch · main' },
  { type: 'command', title: '切换分支', sub: 'git checkout' },
]

export const SEARCH_SUGGESTED_COUNT = 3
