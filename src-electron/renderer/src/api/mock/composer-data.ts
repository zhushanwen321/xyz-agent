/**
 * Composer 工具区浮层 + progress-zone 的纯内存 fixture。
 *
 * 对应设计稿：
 * - draft-composer-states.html §2a–§2f（上下文容量 / 模型分组 / 思考 6 级 /
 *   @ 引用 / # 文件 / / 命令 / 已附上下文条目）
 * - draft-companion-zones.html §1（progress-zone idle / running / done 三态）
 *
 * 纯数据：不依赖 vue/runtime，无副作用。全部 named export，无 default export。
 * token 数用原始数值（如 69000），不用字符串。
 */

// ── 1. 模型列表（provider 分组，平铺单层） ──────────────────────────────
export interface MockModel {
  id: string
  name: string
  provider: string
  providerColor: string
  tag?: string
}

export const MOCK_MODELS: MockModel[] = [
  // Anthropic
  { id: 'claude-sonnet-4.5', name: 'claude-sonnet-4.5', provider: 'Anthropic', providerColor: '#d97757', tag: '推荐' },
  { id: 'claude-opus-4.1', name: 'claude-opus-4.1', provider: 'Anthropic', providerColor: '#d97757' },
  { id: 'claude-haiku-4.5', name: 'claude-haiku-4.5', provider: 'Anthropic', providerColor: '#d97757' },
  // OpenAI
  { id: 'gpt-5', name: 'gpt-5', provider: 'OpenAI', providerColor: '#10a37f' },
  { id: 'gpt-5-mini', name: 'gpt-5-mini', provider: 'OpenAI', providerColor: '#10a37f' },
  // Google
  { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro', provider: 'Google', providerColor: '#4285f4' },
]

// ── 2. 思考等级 6 级 ───────────────────────────────────────────────────
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface MockThinkingLevel {
  level: ThinkingLevel
  label: string
  en: string
  desc: string
  available: boolean
}

export const MOCK_THINKING_LEVELS: MockThinkingLevel[] = [
  { level: 'off', label: '关', en: 'off', desc: '不思考', available: true },
  { level: 'low', label: '低', en: 'low', desc: '轻量', available: true },
  { level: 'medium', label: '中', en: 'medium', desc: '柔紫', available: true },
  { level: 'high', label: '高', en: 'high', desc: '实色紫', available: true },
  { level: 'xhigh', label: '极高', en: 'xhigh', desc: '紫 + 光晕', available: true },
  { level: 'max', label: '最高', en: 'max', desc: '默认 · 实色块', available: true },
]

// ── 3. 上下文容量统计（§2a） ────────────────────────────────────────────
export interface MockContextStats {
  used: number
  total: number
  percent: number
  cacheHit: number
  modelId: string
}

export const MOCK_CONTEXT_STATS: MockContextStats = {
  used: 69000,
  total: 1000000,
  percent: 6.9,
  cacheHit: 98.7,
  modelId: 'claude-sonnet-4.5',
}

// ── 4. @ 引用候选（文件 / 符号 / 技能）（§2d @） ────────────────────────
export interface MockMentionItem {
  id: string
  name: string
  kind: '文件' | '符号' | '技能'
  icon: 'file' | 'symbol' | 'skill'
  path?: string
}

export const MOCK_MENTIONS: MockMentionItem[] = [
  { id: 'mention-auth-service', name: 'AuthService.ts', kind: '文件', icon: 'file', path: 'src/auth/AuthService.ts' },
  { id: 'mention-token-validator', name: 'TokenValidator', kind: '符号', icon: 'symbol' },
  { id: 'mention-form-validation', name: '表单校验规范', kind: '技能', icon: 'skill' },
  { id: 'mention-token-file', name: 'token.ts', kind: '文件', icon: 'file', path: 'src/auth/token.ts' },
]

// ── 5. # 文件候选（文件 / 目录）（§2d #） ───────────────────────────────
export interface MockFileItem {
  id: string
  name: string
  kind: '文件' | '目录'
  path?: string
}

export const MOCK_FILES: MockFileItem[] = [
  { id: 'file-src-auth', name: 'src/auth/', kind: '目录', path: 'src/auth/' },
  { id: 'file-auth-service', name: 'AuthService.ts', kind: '文件', path: 'src/auth/AuthService.ts' },
  { id: 'file-token', name: 'token.ts', kind: '文件', path: 'src/auth/token.ts' },
]

// ── 6. / 斜杠命令候选（§2d /） ──────────────────────────────────────────
export interface MockSlashCommand {
  id: string
  name: string
  kind: string
  icon: 'terminal' | 'star' | 'wrench'
}

export const MOCK_SLASH_COMMANDS: MockSlashCommand[] = [
  { id: 'cmd-commit', name: '/commit', kind: '提交', icon: 'terminal' },
  { id: 'cmd-review', name: '/review', kind: '审查', icon: 'star' },
  { id: 'cmd-fix', name: '/fix', kind: '修复', icon: 'wrench' },
]

// ── 7. 已附上下文条目（§2f） ───────────────────────────────────────────
export interface MockAttachedContext {
  id: string
  name: string
  type: '@' | '#' | 'image'
  meta: string
  icon: 'file' | 'image'
}

export const MOCK_ATTACHED_CONTEXT: MockAttachedContext[] = [
  { id: 'ctx-auth-service', name: 'AuthService.ts', type: '@', meta: '1.2万', icon: 'file' },
  { id: 'ctx-token', name: 'src/auth/token.ts', type: '#', meta: '0.8万', icon: 'file' },
  { id: 'ctx-login-flow', name: 'login-flow.png', type: 'image', meta: '4.9万', icon: 'image' },
]

// ── 8. progress-zone todo 列表（三态各一份，draft-companion-zones §1） ─
export type TodoStatus = 'pending' | 'active' | 'done'

export interface MockTodo {
  id: string
  label: string
  status: TodoStatus
  pct?: number
}

export interface MockProgressState {
  phase: 'idle' | 'running' | 'done'
  title: string
  step: string
  summaryPct: number
  todos: MockTodo[]
}

const PROGRESS_TITLE = '重构 auth 模块'

export const MOCK_PROGRESS_STATES: {
  idle: MockProgressState
  running: MockProgressState
  done: MockProgressState
} = {
  idle: {
    phase: 'idle',
    title: PROGRESS_TITLE,
    step: '待开始 · 0/5 步',
    summaryPct: 0,
    todos: [
      { id: 'todo-1', label: '抽离 UserRepository', status: 'pending' },
      { id: 'todo-2', label: '拆分 TokenValidator', status: 'pending' },
      { id: 'todo-3', label: '重构 token 验证逻辑', status: 'pending' },
    ],
  },
  running: {
    phase: 'running',
    title: PROGRESS_TITLE,
    step: '第 3/5 步',
    summaryPct: 60,
    todos: [
      { id: 'todo-1', label: '抽离 UserRepository', status: 'done' },
      { id: 'todo-2', label: '重构 token 验证逻辑', status: 'active', pct: 60 },
      { id: 'todo-3', label: '更新所有调用方', status: 'pending' },
    ],
  },
  done: {
    phase: 'done',
    title: PROGRESS_TITLE,
    step: '已完成 · 5/5 步',
    summaryPct: 100,
    todos: [
      { id: 'todo-1', label: '抽离 UserRepository', status: 'done' },
      { id: 'todo-2', label: '重构 token 验证逻辑', status: 'done' },
      { id: 'todo-3', label: '跑全量测试', status: 'done' },
    ],
  },
}
