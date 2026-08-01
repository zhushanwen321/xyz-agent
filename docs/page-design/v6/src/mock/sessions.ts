/** Mock 数据层 — 所有区域的静态数据 */

// === Session 列表（sidebar sessions tab）===
export interface SessionItem {
  id: string
  title: string
  status: 'running' | 'waiting' | 'error' | 'done' | 'dead'
  branch?: string
  cwd?: string
  unread?: boolean
  forkLineage?: boolean
  /** fork 源会话标题（forkLineage 子行前缀「↑ fork 自 xxx」） */
  forkSource?: string
  elapsed?: string
}

export const sessions: SessionItem[] = [
  { id: 'session-1', title: '重构 composer 输入区', status: 'running', branch: 'visual-modernization', cwd: 'xyz-agent', elapsed: '3s', unread: false },
  { id: 'session-2', title: 'v6 视觉稿第二轮审查', status: 'waiting', branch: 'feat-optimize-ui', cwd: 'xyz-agent', elapsed: '12m' },
  { id: 'session-3', title: '修复 drawer 投影口径', status: 'done', branch: 'fix-drawer-shadow', cwd: 'xyz-agent', elapsed: '2h' },
  { id: 'session-4', title: 'plugin 渲染架构调研', status: 'error', branch: 'research/plugin', cwd: 'xyz-agent', elapsed: '5h', unread: true },
  { id: 'session-5', title: 'settings 拆分独立 spec', status: 'dead', branch: 'refactor/settings', cwd: 'xyz-agent' },
  { id: 'session-6', title: 'logo 概念稿设计', status: 'done', branch: 'design/logo', cwd: 'xyz-agent', forkLineage: true, forkSource: '重构 Sidebar 组件' },
]

// === 文件树（sidebar files tab）===
export interface FileNode {
  name: string
  type: 'dir' | 'file'
  depth: number
  gitStatus?: 'M' | 'A' | 'D' | 'U' | 'R'
  stats?: { add: number; del: number }
  /** untracked 文件大小占位（spec §6：~size dim） */
  size?: string
  ignored?: boolean
  expanded?: boolean
  childCount?: number
}

export const fileTree: FileNode[] = [
  { name: 'docs', type: 'dir', depth: 0, expanded: true, childCount: 3 },
  { name: 'page-design', type: 'dir', depth: 1, expanded: true, gitStatus: 'M', childCount: 18 },
  { name: 'v6-design.md', type: 'file', depth: 2, gitStatus: 'M', stats: { add: 24, del: 8 } },
  { name: 'v6-spec-shell.html', type: 'file', depth: 2, gitStatus: 'M', stats: { add: 12, del: 5 } },
  { name: 'v6-spec-drawer.html', type: 'file', depth: 2, gitStatus: 'A', stats: { add: 142, del: 0 } },
  { name: 'notes.md', type: 'file', depth: 2, gitStatus: 'A', size: '~2k' },
  { name: 'v6-app-demo.html', type: 'file', depth: 2, gitStatus: 'D', stats: { add: 0, del: 1909 } },
  { name: 'standards.md', type: 'file', depth: 2, ignored: true },
  { name: 'architecture', type: 'dir', depth: 1, childCount: 5 },
  { name: 'adr', type: 'dir', depth: 2, childCount: 12 },
  { name: 'packages', type: 'dir', depth: 0, expanded: false, childCount: 3 },
  { name: 'renderer', type: 'dir', depth: 1, childCount: 28 },
  { name: 'App.vue', type: 'file', depth: 2, gitStatus: 'M', stats: { add: 3, del: 1 } },
  { name: '.gitignore', type: 'file', depth: 0, ignored: true },
]

// === Subagent 列表（sidebar subagents tab）===
export interface SubagentItem {
  id: string
  name: string
  slug: string
  model: string
  thinking: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  elapsed?: string
  /** v6 spec §7：stats 显示 turns · tokens（替代 model·thinking） */
  turns: number
  tokens: string
}

export const subagents: SubagentItem[] = [
  { id: 'sa-1', name: 'researcher', slug: 'find-auth-flow', model: 'glm-5.2', thinking: 'medium', status: 'running', elapsed: '45s', turns: 8, tokens: '12.4k' },
  { id: 'sa-2', name: 'implementer', slug: 'fix-drawer-css', model: 'claude-4', thinking: 'max', status: 'done', elapsed: '2m18s', turns: 23, tokens: '38.1k' },
  { id: 'sa-3', name: 'reviewer', slug: 'audit-tokens', model: 'kimi-k2', thinking: 'high', status: 'failed', elapsed: '1m03s', turns: 5, tokens: '9.7k' },
  { id: 'sa-4', name: 'explorer', slug: 'map-sidebar', model: 'glm-5.2', thinking: 'low', status: 'cancelled', turns: 2, tokens: '4.2k' },
]

// === Workflow 列表（sidebar workflows tab）===
export type WorkflowCallStatus = 'running' | 'done' | 'failed'

export interface WorkflowCall {
  id: string
  name: string
  status: WorkflowCallStatus
  sessionId: string
}

export interface WorkflowItem {
  id: string
  name: string
  slug: string
  status: 'running' | 'done' | 'failed' | 'paused'
  progress: number
  /** v6 spec §7：agents 计数 = 完成数 / 总数（done ≤ total） */
  agentsDone: number
  agentsTotal: number
  /** 耗时 demo 值（spec §7 meta 行「· 4m」，paused 显示「· 暂停」） */
  elapsed?: string
  /** 详情视图 agent call 行（WorkflowDetail，spec §7 视图 2） */
  calls: WorkflowCall[]
}

export const workflows: WorkflowItem[] = [
  {
    id: 'wf-1', name: 'build-and-deploy', slug: 'release-v6', status: 'running', progress: 65, agentsDone: 3, agentsTotal: 5, elapsed: '4m',
    calls: [
      { id: 'c-1', name: 'code-review', status: 'done', sessionId: 'sess_a1b2' },
      { id: 'c-2', name: 'test-writer', status: 'running', sessionId: 'sess_c3d4' },
      { id: 'c-3', name: 'deploy-check', status: 'failed', sessionId: 'sess_e5f6' },
    ],
  },
  {
    id: 'wf-2', name: 'code-review', slug: 'pr-61-review', status: 'done', progress: 100, agentsDone: 5, agentsTotal: 5, elapsed: '6m',
    calls: [
      { id: 'c-1', name: 'reviewer', status: 'done', sessionId: 'sess_a1b2' },
      { id: 'c-2', name: 'oracle', status: 'done', sessionId: 'sess_c3d4' },
    ],
  },
  {
    id: 'wf-3', name: 'test-coverage', slug: 'audit-blocks', status: 'failed', progress: 40, agentsDone: 1, agentsTotal: 4, elapsed: '3m',
    calls: [
      { id: 'c-1', name: 'test-runner', status: 'done', sessionId: 'sess_f1g2' },
      { id: 'c-2', name: 'explorer', status: 'failed', sessionId: 'sess_h3i4' },
    ],
  },
  {
    id: 'wf-4', name: 'docs-update', slug: 'sync-specs', status: 'paused', progress: 30, agentsDone: 2, agentsTotal: 6,
    calls: [
      { id: 'c-1', name: 'writer', status: 'done', sessionId: 'sess_j5k6' },
      { id: 'c-2', name: 'researcher', status: 'running', sessionId: 'sess_l7m8' },
    ],
  },
]

// === 对话流消息（MessageStream）===
export interface ChatBlock {
  type: 'thinking' | 'bash' | 'tool' | 'changeset' | 'subagent' | 'workflow' | 'goal' | 'todo'
  state?: 'collapsed' | 'expanded' | 'running' | 'done' | 'failed'
  data: Record<string, unknown>
}

export interface ChatTurn {
  id: string
  userMessage: string
  blocks: ChatBlock[]
}

export const chatTurns: ChatTurn[] = [
  {
    id: 'turn-1',
    userMessage: '帮我看看现在对话流和侧栏的视觉，对照 Codex/Claude 的简洁感，主要差在哪里？',
    blocks: [
      {
        type: 'thinking',
        data: { state: 'expanded', preview: '对比维度主要看圆角尺度、分隔方式、灰度分布、列宽留白、彩色密度五个杠杆…' },
      },
      {
        type: 'bash',
        data: {
          state: 'done',
          cmd: 'git status --porcelain',
          output: '?? docs/page-design/v6-design.md\n?? docs/page-design/v6-spec-shell.html',
          exit: 0,
        },
      },
      {
        type: 'tool',
        data: {
          state: 'expanded',
          name: 'read',
          arg: 'docs/standards.md',
          exit: 0,
          meta: { lines: 126, chars: '3.4K', elapsed: '1.2s' },
          output: '## 前端编码规范\n\n### 核心规则\n1. 禁止原生 HTML 表单元素…',
        },
      },
      {
        type: 'changeset',
        data: {
          state: 'collapsed',
          status: 'accumulating',
          title: 'v6 视觉稿修复',
          count: 5,
          stats: { add: 142, del: 37 },
          files: [
            { name: 'v6-design.md', badge: 'M' as const, add: 24, del: 8 },
            { name: 'v6-spec-shell.html', badge: 'M' as const, add: 12, del: 5 },
            { name: 'v6-spec-drawer.html', badge: 'A' as const, add: 142, del: 0 },
          ],
        },
      },
    ],
  },
  {
    id: 'turn-2',
    userMessage: '把这些修复都做了，不用过问我',
    blocks: [
      {
        // running 态 bash：展示双环 loader + 取消按钮 + no-context tag
        type: 'bash',
        data: {
          state: 'running',
          cmd: 'pnpm install --ignore-workspace',
          excludeFromContext: true,
        },
      },
      {
        // tool-bash（§5B）：agent 调用，嵌 tool 块可折叠，bg-input 容器
        type: 'tool',
        data: {
          state: 'expanded',
          name: 'Bash',
          toolType: 'bash',
          arg: 'pnpm add lodash',
          cmd: 'pnpm add lodash',
          exit: 0,
          output: '+ lodash@4.17.21\nadded 1 package in 2s',
        },
      },
      {
        type: 'subagent',
        data: { state: 'done', name: 'researcher', slug: 'find-auth-flow', model: 'glm-5.2', thinking: 'medium' },
      },
      {
        type: 'workflow',
        data: { state: 'done', name: 'code-review', slug: 'pr-61-review' },
      },
    ],
  },
]

// === Git Panel 文件列表（drawer git tab）===
export interface GitFile {
  name: string
  badge: 'M' | 'A' | 'D' | 'U' | 'R'
  staged: boolean
  add: number
  del: number
}

export const gitFiles: GitFile[] = [
  { name: 'docs/page-design/v6-design.md', badge: 'M', staged: true, add: 24, del: 8 },
  { name: 'docs/page-design/v6-spec-shell.html', badge: 'M', staged: true, add: 12, del: 5 },
  { name: 'docs/page-design/v6-spec-drawer.html', badge: 'A', staged: false, add: 142, del: 0 },
  { name: 'docs/page-design/v6-spec-base.css', badge: 'M', staged: false, add: 18, del: 3 },
  { name: 'packages/renderer/src/App.vue', badge: 'M', staged: false, add: 3, del: 1 },
]

// === Provider 列表（settings provider page）===
export interface Provider {
  id: string
  name: string
  status: 'connected' | 'not_configured'
  enabled: boolean
  isDefault: boolean
  modelCount: number
  dirty: boolean
}

export const providers: Provider[] = [
  { id: 'p-1', name: 'Zhipu', status: 'connected', enabled: true, isDefault: true, modelCount: 4, dirty: false },
  { id: 'p-2', name: 'Anthropic', status: 'connected', enabled: true, isDefault: false, modelCount: 3, dirty: true },
  { id: 'p-3', name: 'OpenAI', status: 'not_configured', enabled: false, isDefault: false, modelCount: 0, dirty: false },
  { id: 'p-4', name: 'Kimi', status: 'connected', enabled: false, isDefault: false, modelCount: 2, dirty: false },
]

// === Extension 列表（settings extension page）===
export interface Extension {
  id: string
  name: string
  desc: string
  scope: 'mandatory' | 'user'
  source: 'user' | 'disc'
  tier: 'infrastructure' | 'feature'
  enabled: boolean
  autoUpgrade: boolean
}

export const extensions: Extension[] = [
  { id: 'e-1', name: 'pi-goal', desc: '目标管理与意图追踪', scope: 'mandatory', source: 'disc', tier: 'infrastructure', enabled: true, autoUpgrade: true },
  { id: 'e-2', name: 'pi-todo', desc: '任务清单与进度追踪', scope: 'mandatory', source: 'disc', tier: 'infrastructure', enabled: true, autoUpgrade: true },
  { id: 'e-3', name: 'pi-subagent-workflow', desc: '子 agent 工作流编排', scope: 'mandatory', source: 'disc', tier: 'infrastructure', enabled: true, autoUpgrade: true },
  { id: 'e-4', name: 'pi-permission', desc: '权限控制扩展', scope: 'mandatory', source: 'disc', tier: 'feature', enabled: true, autoUpgrade: true },
  { id: 'e-5', name: 'my-custom-tool', desc: '自定义工具扩展', scope: 'user', source: 'user', tier: 'feature', enabled: false, autoUpgrade: false },
]

// === 搜索命令（SearchModal）===
export interface SearchCommand {
  name: string
  desc: string
  group: string
  icon: string
}

export const searchCommands: SearchCommand[] = [
  { name: 'build', desc: '构建生产版本', group: '建议命令', icon: 'terminal' },
  { name: 'dev', desc: '启动开发服务器', group: '建议命令', icon: 'terminal' },
  { name: 'lint', desc: '运行 ESLint 检查', group: '建议命令', icon: 'terminal' },
  { name: 'v6-demo', desc: 'v6 视觉综合 demo', group: '最近打开', icon: 'file' },
  { name: 'v6-design.md', desc: 'docs/page-design/', group: '最近打开', icon: 'file' },
]
