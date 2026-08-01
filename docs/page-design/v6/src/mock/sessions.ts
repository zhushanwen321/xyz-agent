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
/** 注意：block 状态一律放 data.state（组件只读 data），顶层不设 state */
export interface ChatBlock {
  type: 'thinking' | 'bash' | 'tool' | 'changeset' | 'subagent' | 'workflow'
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
          count: 3, // spec §7「count = fileChanges.length」：files 只有 3 条
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
        // streaming 帧 think pill 数据源（spec §3 streaming 帧「think · N」）
        type: 'thinking',
        data: { state: 'expanded', preview: '…' },
      },
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
  {
    id: 'turn-3',
    userMessage: '并行调研一下 xyz-agent 的 v3 迁移成本',
    blocks: [
      {
        // 帧⑦ subagent 差异帧：done 态 subagent block → turnVariant 命中 'subagent' → TurnSummary 仅 copy（无 fork/handoff）
        type: 'subagent',
        data: { state: 'done', name: 'researcher', slug: 'find-migration-cost', model: 'glm-5.2', thinking: 'high' },
      },
      {
        type: 'workflow',
        data: { state: 'done', name: 'cost-analysis', slug: 'v3-migration' },
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
export interface ProviderQuotaWindow {
  label: string
  /** 用量百分比（0-100），视觉等级：high=warn / full=danger */
  pct: number
  reset: string
  level?: 'normal' | 'high' | 'full'
}

export interface ProviderHeader {
  key: string
  value: string
}

export interface Provider {
  id: string
  name: string
  status: 'connected' | 'not_configured'
  enabled: boolean
  isDefault: boolean
  modelCount: number
  dirty: boolean
  /** spec §0：provider 配置字段（demo 展开区可直接编辑） */
  baseUrl?: string
  /** M10：自定义 headers（key-value 行编辑） */
  headers?: ProviderHeader[]
  /** M9：Coding Plan 三窗口额度（5h 滚动 / 本周 / 本月） */
  quota?: ProviderQuotaWindow[]
}

export const providers: Provider[] = [
  {
    id: 'p-1', name: 'Zhipu', status: 'connected', enabled: true, isDefault: true, modelCount: 4, dirty: false,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    headers: [{ key: 'X-Request-Source', value: 'xyz-agent' }],
    quota: [
      { label: '5h 滚动', pct: 23, reset: '1h 42m 后重置' },
      { label: '本周', pct: 51, reset: '3d 12h 后重置' },
      { label: '本月', pct: 78, reset: '12d 后重置', level: 'high' },
    ],
  },
  {
    id: 'p-2', name: 'Anthropic', status: 'connected', enabled: true, isDefault: false, modelCount: 3, dirty: false,
    baseUrl: 'https://api.anthropic.com',
    quota: [
      { label: '5h 滚动', pct: 100, reset: '已用尽', level: 'full' },
      { label: '本周', pct: 82, reset: '2d 4h 后重置', level: 'high' },
      { label: '本月', pct: 95, reset: '9d 后重置', level: 'high' },
    ],
  },
  { id: 'p-3', name: 'OpenAI', status: 'not_configured', enabled: false, isDefault: false, modelCount: 0, dirty: false, baseUrl: 'https://api.openai.com/v1' },
  { id: 'p-4', name: 'Kimi', status: 'connected', enabled: false, isDefault: false, modelCount: 2, dirty: false, baseUrl: 'https://api.moonshot.cn/v1' },
]

// === M8 自动发现（验证子区 · mock 探测结果，带「发现」来源标识）===
export interface DiscoveredProvider {
  id: string
  name: string
  proto: string
  modelCount: number
}

export const discoveredProviders: DiscoveredProvider[] = [
  { id: 'd-1', name: 'DeepSeek', proto: 'openai-completions', modelCount: 3 },
  { id: 'd-2', name: 'OpenRouter', proto: 'openai-completions', modelCount: 12 },
  { id: 'd-3', name: 'Groq', proto: 'openai-completions', modelCount: 6 },
]

// === M12 导入流程（spec §4 · 4 源解析预览 mock）===
export type ImportSource = 'pi' | 'zcode' | 'codex' | 'claude'

export interface ImportPreviewItem {
  id: string
  name: string
  proto: string
  modelCount: number
  /** 预览只透出布尔，不含 key 值（spec §4 安全红线） */
  apiKeyExtracted: boolean
  /** 与现有 provider 同名 → 默认不勾选 + 禁用 */
  conflict: boolean
  warnings?: string[]
}

export interface ImportSourcePreview {
  source: ImportSource
  title: string
  items: ImportPreviewItem[]
  /** 顶层警告（协议不支持被丢弃等，preview 顶部横幅） */
  topWarnings?: string[]
  /** 源配置解析错误（不阻断已解析 providers 导入） */
  parseError?: string
}

export const importPreviews: ImportSourcePreview[] = [
  {
    source: 'pi', title: 'Pi',
    topWarnings: ['2 个 provider 因协议不支持等原因被跳过'],
    items: [
      { id: 'i-1', name: 'openai-main', proto: 'openai-completions', modelCount: 5, apiKeyExtracted: true, conflict: false },
      { id: 'i-2', name: 'anthropic-prod', proto: 'anthropic-messages', modelCount: 3, apiKeyExtracted: true, conflict: false },
      { id: 'i-3', name: 'openai-compatible', proto: 'openai-completions', modelCount: 8, apiKeyExtracted: true, conflict: true },
      {
        id: 'i-4', name: 'ollama-local', proto: 'openai-completions', modelCount: 2, apiKeyExtracted: false, conflict: false,
        warnings: ['contextWindow 字段缺失，使用默认值 8K'],
      },
    ],
  },
  {
    source: 'zcode', title: 'ZCode',
    items: [
      { id: 'i-1', name: 'zhipu-coder', proto: 'openai-completions', modelCount: 4, apiKeyExtracted: true, conflict: false },
      { id: 'i-2', name: 'kimi-prod', proto: 'openai-completions', modelCount: 2, apiKeyExtracted: true, conflict: false },
    ],
  },
  {
    source: 'codex', title: 'Codex',
    parseError: '源配置解析出错（部分 provider 可能仍可导入）：JSON 第 12 行语法错误',
    items: [
      {
        id: 'i-1', name: 'codex-main', proto: 'openai-responses', modelCount: 1, apiKeyExtracted: false, conflict: false,
        warnings: ['model 列表需手动补', 'wire_api=chat 已废弃'],
      },
    ],
  },
  {
    source: 'claude', title: 'Claude Code',
    items: [
      {
        id: 'i-1', name: 'claude-prod', proto: 'anthropic-messages', modelCount: 1, apiKeyExtracted: false, conflict: false,
        warnings: ['key 存于 OS keychain，导入后需手动补'],
      },
    ],
  },
]

// === Extension 列表（settings extension page）===
export interface Extension {
  id: string
  name: string
  desc: string
  version?: string
  tools?: string[]
  scope: 'mandatory' | 'user'
  source: 'user' | 'disc'
  tier: 'infrastructure' | 'feature'
  enabled: boolean
  autoUpgrade: boolean
}

export const extensions: Extension[] = [
  { id: 'e-1', name: 'pi-goal', desc: '目标管理与意图追踪', version: 'v1.4.2', tools: ['goal_control'], scope: 'mandatory', source: 'disc', tier: 'infrastructure', enabled: true, autoUpgrade: true },
  { id: 'e-2', name: 'pi-todo', desc: '任务清单与进度追踪', version: 'v2.1.0', tools: ['todo_create', 'todo_update', 'todo_complete', 'todo_list'], scope: 'mandatory', source: 'disc', tier: 'infrastructure', enabled: true, autoUpgrade: true },
  { id: 'e-3', name: 'pi-subagent-workflow', desc: '子 agent 工作流编排', version: 'v1.0.8', tools: ['workflow_run', 'workflow_script'], scope: 'mandatory', source: 'disc', tier: 'infrastructure', enabled: true, autoUpgrade: true },
  { id: 'e-4', name: 'pi-permission', desc: '权限控制扩展', version: 'v0.9.3', tools: ['permission_check'], scope: 'mandatory', source: 'disc', tier: 'feature', enabled: true, autoUpgrade: true },
  { id: 'e-5', name: 'my-custom-tool', desc: '自定义工具扩展', version: 'v0.3.1', tools: ['my_tool_a', 'my_tool_b'], scope: 'user', source: 'user', tier: 'feature', enabled: false, autoUpgrade: false },
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
