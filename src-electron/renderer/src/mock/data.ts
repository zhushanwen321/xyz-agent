/* eslint-disable no-magic-numbers */
/* eslint-disable max-lines */
/**
 * Static mock data covering ALL design scenarios.
 *
 * Data source: docs/designs/index.html + task spec MOCK-1.
 * Types:      @xyz-agent/shared (SessionGroup, Message, ProviderInfo, ModelInfo …)
 */

import type {
  SessionGroup,
  SessionSummary,
  Message,
  ProviderInfo,
  ModelInfo,
} from '@xyz-agent/shared'

// ─── Helpers ───────────────────────────────────────────────────────

/** Shorthand epoch (ms) for relative timestamps. */
const now = Date.now()
const hour = 3_600_000
const day  = 86_400_000

// ═══════════════════════════════════════════════════════════════════
// 1. Session Groups (3 groups, 6 sessions total)
// ═══════════════════════════════════════════════════════════════════

export const DEFAULT_SESSION_ID = 's1' // "重构 auth 模块"

export const mockSessionGroups: SessionGroup[] = [
  {
    cwd: '/Users/zhushanwen/Code/xyz-agent',
    sessions: [
      {
        id: 's1',
        label: '重构 auth 模块',
        cwd: '/Users/zhushanwen/Code/xyz-agent',
        status: 'active',
        lastActiveAt: now - 2 * hour,
        modelId: 'claude-sonnet',
        tokenCount: 12_300,
      },
      {
        id: 's2',
        label: 'Tauri GUI 设计',
        cwd: '/Users/zhushanwen/Code/xyz-agent',
        status: 'idle',
        lastActiveAt: now - 1 * day,
        modelId: 'claude-sonnet',
        tokenCount: 3_100,
      },
    ],
  },
  {
    cwd: '/Users/zhushanwen/Code/work-project',
    sessions: [
      {
        id: 's3',
        label: 'API 性能优化',
        cwd: '/Users/zhushanwen/Code/work-project',
        status: 'active',
        lastActiveAt: now - 5 * day,
        modelId: 'claude-sonnet',
        tokenCount: 8_700,
      },
      {
        id: 's4',
        label: '数据库迁移',
        cwd: '/Users/zhushanwen/Code/work-project',
        status: 'idle',
        lastActiveAt: now - 6 * day,
        modelId: 'claude-sonnet',
        tokenCount: 1_200,
      },
    ],
  },
  {
    cwd: '/Users/zhushanwen/Code/diy-pc',
    sessions: [
      {
        id: 's5',
        label: '价格预测分析',
        cwd: '/Users/zhushanwen/Code/diy-pc',
        status: 'idle',
        lastActiveAt: now - 7 * day,
        modelId: 'deepseek-r1',
        tokenCount: 5_400,
      },
      {
        id: 's6',
        label: '4090 比价',
        cwd: '/Users/zhushanwen/Code/diy-pc',
        status: 'active',
        lastActiveAt: now - 1 * hour,
        modelId: 'claude-sonnet',
        tokenCount: 2_100,
      },
    ],
  },
]

/** Flat lookup for convenience. */
export const mockSessionMap = new Map<string, SessionSummary>(
  mockSessionGroups.flatMap(g => g.sessions.map(s => [s.id, s])),
)

// ═══════════════════════════════════════════════════════════════════
// 2. Main Session Messages (s1 — 重构 auth 模块)
// ═══════════════════════════════════════════════════════════════════
// Matches the design HTML's agent-view[data-agent="main"] exactly.

export const mockMessages: Message[] = [
  // ── User message ──
  {
    id: 'm1',
    role: 'user',
    content: '帮我重构整个 auth 模块，包括接口定义、错误处理和单元测试。',
    status: 'complete',
    timestamp: now - 10 * 60_000,
  },

  // ── Bot message (plan) ──
  {
    id: 'm2',
    role: 'assistant',
    content:
      '好的，这个任务比较复杂，我分解成几个子任务并行执行：\n\n' +
      '1. **分析 auth 模块结构** → SubAgent-1（已完成）\n' +
      '2. **重构核心接口** → SubAgent-2（运行中）\n' +
      '3. **重构子模块 A1** → SubAgent-3（等待确认）\n' +
      '4. **编写单元测试** → SubAgent-4（等待中）',
    status: 'complete',
    timestamp: now - 9.5 * 60_000,
  },

  // ── System message: done ──
  {
    id: 'm3',
    role: 'assistant',
    content:
      'SubAgent「分析代码结构」已完成\n' +
      '耗时 2m 34s · 消耗 1.2k tokens · 发现 3 个主要问题',
    status: 'complete',
    timestamp: now - 7 * 60_000,
    thinking: [
      {
        id: 'th1',
        content: '__system_done__',
        collapsed: true,
      },
    ],
  },

  // ── System message: alert ──
  {
    id: 'm4',
    role: 'assistant',
    content:
      'SubAgent「重构子模块A1」需要确认\n' +
      '检测到 3 处循环依赖，需要决定处理策略',
    status: 'complete',
    timestamp: now - 5 * 60_000,
    thinking: [
      {
        id: 'th2',
        content: '__system_alert__',
        collapsed: true,
      },
    ],
  },

  // ── Bot message: progress + tool call ──
  {
    id: 'm5',
    role: 'assistant',
    content: 'SubAgent-2 正在重构核心接口，进度 67%：',
    status: 'streaming',
    timestamp: now - 3 * 60_000,
    toolCalls: [
      {
        id: 'tc1',
        toolName: 'edit',
        input: { file: 'src/auth/interfaces.ts' },
        output:
          '统一了 IAuthResponse、ITokenPayload、ISession 接口定义，新增 IAuthModule 聚合接口。',
        status: 'completed',
        startTime: now - 3 * 60_000,
        endTime: now - 2.5 * 60_000,
      },
    ],
  },
]

// ═══════════════════════════════════════════════════════════════════
// 3. Providers (5)
// ═══════════════════════════════════════════════════════════════════

export interface MockProvider extends ProviderInfo {
  baseUrl: string
  icon: string // Single letter for avatar
}

export const mockProviders: MockProvider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic-messages',
    status: 'connected',
    models: [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200000 },
      { id: 'claude-opus-4', name: 'Claude Opus 4', contextWindow: 200000 },
      { id: 'claude-haiku-4', name: 'Claude Haiku 4', contextWindow: 200000 },
    ],
    apiKeySet: true,
    baseUrl: 'https://api.anthropic.com',
    icon: 'A',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    api: 'openai-completions',
    status: 'connected',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000 },
      { id: 'o3', name: 'o3', contextWindow: 200000 },
      { id: 'o4-mini', name: 'o4-mini', contextWindow: 200000 },
    ],
    apiKeySet: true,
    baseUrl: 'https://api.openai.com',
    icon: 'O',
  },
  {
    id: 'google',
    name: 'Google',
    api: 'openai-completions',
    status: 'connected',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1000000 },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1000000 },
    ],
    apiKeySet: true,
    baseUrl: 'https://generativelanguage.googleapis.com',
    icon: 'G',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    api: 'openai-completions',
    status: 'connected',
    models: [
      { id: 'deepseek-v4', name: 'DeepSeek V4', contextWindow: 1000000, reasoning: true },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1000000, reasoning: true },
    ],
    apiKeySet: true,
    baseUrl: 'https://api.deepseek.com',
    icon: 'D',
  },
  {
    id: 'ollama',
    name: '本地 Ollama',
    api: 'openai-completions',
    status: 'not_configured',
    models: [
      { id: 'qwen3-32b', name: 'Qwen3 32B', contextWindow: 128000 },
    ],
    apiKeySet: false,
    baseUrl: 'http://localhost:11434',
    icon: 'L',
  },
]

// ═══════════════════════════════════════════════════════════════════
// 4. Models (10)
// ═══════════════════════════════════════════════════════════════════

export interface MockModel extends ModelInfo {
  contextWindow: number
  enabled: boolean
}

export const mockModels: MockModel[] = [
  // Anthropic
  { id: 'claude-sonnet-4', name: 'claude-sonnet-4', providerId: 'anthropic', providerName: 'Anthropic', contextWindow: 128_000, enabled: true },
  { id: 'claude-haiku-4', name: 'claude-haiku-4', providerId: 'anthropic', providerName: 'Anthropic', contextWindow: 128_000, enabled: true },
  { id: 'claude-opus-4', name: 'claude-opus-4', providerId: 'anthropic', providerName: 'Anthropic', contextWindow: 200_000, enabled: true },
  // OpenAI
  { id: 'gpt-4o', name: 'gpt-4o', providerId: 'openai', providerName: 'OpenAI', contextWindow: 128_000, enabled: true },
  { id: 'gpt-4o-mini', name: 'gpt-4o-mini', providerId: 'openai', providerName: 'OpenAI', contextWindow: 128_000, enabled: true },
  { id: 'o3', name: 'o3', providerId: 'openai', providerName: 'OpenAI', contextWindow: 200_000, enabled: true },
  { id: 'o4-mini', name: 'o4-mini', providerId: 'openai', providerName: 'OpenAI', contextWindow: 200_000, enabled: true },
  // DeepSeek
  { id: 'deepseek-v4', name: 'deepseek-v4', providerId: 'deepseek', providerName: 'DeepSeek', contextWindow: 128_000, enabled: true },
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', providerId: 'deepseek', providerName: 'DeepSeek', contextWindow: 128_000, enabled: true },
  // Ollama
  { id: 'qwen3-32b', name: 'qwen3:32b', providerId: 'ollama', providerName: '本地 Ollama', contextWindow: 32_000, enabled: true },
]

/** Map model id → MockModel for quick lookup. */
export const mockModelMap = new Map(mockModels.map(m => [m.id, m]))

// ═══════════════════════════════════════════════════════════════════
// 5. Skills (6)
// ═══════════════════════════════════════════════════════════════════

export interface MockSkill {
  name: string
  description: string
  enabled: boolean
  source: string         // 'pi' | 'claude' | 'agents'
  sourceIcon: string     // 'P' | 'C' | 'A'
  sourcePath: string     // '~/.pi/agent/skills/code-trace/SKILL.md'
  triggers: string[]     // ['分析链路', 'trace code', ...]
  fileSize: string       // '4.2 KB'
  tools: string[]        // ['read', 'bash', 'grep']
  content: string        // full SKILL.md content
  tag: string            // 'pi' | 'claude' | 'agents'
}

export const mockSkills: MockSkill[] = [
  {
    name: 'code-trace',
    description: '分析代码文件的完整调用链路和数据流，找出上下游调用关系和数据生产源头，审查链路正确性并评分。',
    enabled: true,
    source: 'pi',
    sourceIcon: 'P',
    sourcePath: '~/.pi/agent/skills/code-trace/SKILL.md',
    triggers: ['分析链路', 'trace code', 'code-trace', '链路分析'],
    fileSize: '4.2 KB',
    tools: ['read', 'bash', 'grep'],
    tag: 'pi',
    content: `---\nname: code-trace\ndescription: 分析代码文件的完整调用链路和数据流\ntriggers: ["分析链路", "trace code", "code-trace", "链路分析"]\ntools: [read, bash, grep]\n---\n\n# Code Trace\n\n分析代码文件的完整调用链路和数据流。`,
  },
  {
    name: 'issue-trace',
    description: '分析用户发现的问题，通过构建调用链路和数据链路来验证问题是否真实存在，并对问题严重程度进行评分。',
    enabled: true,
    source: 'pi',
    sourceIcon: 'P',
    sourcePath: '~/.pi/agent/skills/issue-trace/SKILL.md',
    triggers: ['分析问题', 'issue-trace', '问题链路', '审查问题'],
    fileSize: '3.8 KB',
    tools: ['read', 'bash', 'grep'],
    tag: 'pi',
    content: `---\nname: issue-trace\ndescription: 分析用户发现的问题，验证问题真实性\ntriggers: ["分析问题", "issue-trace", "问题链路", "审查问题"]\ntools: [read, bash, grep]\n---\n\n# Issue Trace\n\n分析用户发现的问题，通过构建调用链路和数据链路来验证问题是否真实存在。`,
  },
  {
    name: 'review-tracer',
    description: '审查代码审查工具的输出质量，对审查结果进行评分和评估。',
    enabled: true,
    source: 'pi',
    sourceIcon: 'P',
    sourcePath: '~/.pi/agent/skills/review-tracer/SKILL.md',
    triggers: ['审查审查者', 'review-tracer', '评估审查质量'],
    fileSize: '2.9 KB',
    tools: ['read', 'bash'],
    tag: 'pi',
    content: `---\nname: review-tracer\ndescription: 审查代码审查工具的输出质量\ntriggers: ["审查审查者", "review-tracer", "评估审查质量"]\ntools: [read, bash]\n---\n\n# Review Tracer\n\n审查代码审查工具的输出质量，对审查结果进行评分和评估。`,
  },
  {
    name: 'batch-tracer',
    description: '批量代码分析调度器。对指定目录下的所有源代码文件执行完整的三阶段分析链路。',
    enabled: true,
    source: 'pi',
    sourceIcon: 'P',
    sourcePath: '~/.pi/agent/skills/batch-tracer/SKILL.md',
    triggers: ['批量分析', 'batch-tracer', '全量分析'],
    fileSize: '5.1 KB',
    tools: ['read', 'bash', 'grep'],
    tag: 'pi',
    content: `---\nname: batch-tracer\ndescription: 批量代码分析调度器\ntriggers: ["批量分析", "batch-tracer", "全量分析"]\ntools: [read, bash, grep]\n---\n\n# Batch Tracer\n\n批量代码分析调度器。对指定目录下的所有源代码文件执行完整的三阶段分析链路。`,
  },
  {
    name: 'ts-taste-check',
    description: '参照代码品味指导文件，审查并重构 TypeScript / Vue 代码。',
    enabled: false,
    source: 'pi',
    sourceIcon: 'P',
    sourcePath: '~/.pi/agent/skills/ts-taste-check/SKILL.md',
    triggers: ['品味检查', 'ts-taste-check', '审查ts代码质量'],
    fileSize: '6.3 KB',
    tools: ['read', 'bash', 'edit'],
    tag: 'pi',
    content: `---\nname: ts-taste-check\ndescription: 参照代码品味指导文件审查TS代码\ntriggers: ["品味检查", "ts-taste-check", "审查ts代码质量"]\ntools: [read, bash, edit]\n---\n\n# TS Taste Check\n\n参照代码品味指导文件，审查并重构 TypeScript / Vue 代码。`,
  },
  {
    name: 'zcommit',
    description: '执行 git commit 操作，智能分析变更并创建规范的提交信息。',
    enabled: true,
    source: 'pi',
    sourceIcon: 'P',
    sourcePath: '~/.pi/agent/skills/zcommit/SKILL.md',
    triggers: ['zcommit', '提交', 'commit', '提交代码'],
    fileSize: '1.8 KB',
    tools: ['bash', 'read', 'edit'],
    tag: 'pi',
    content: `---\nname: zcommit\ndescription: 执行git commit操作\ntriggers: ["zcommit", "提交", "commit", "提交代码"]\ntools: [bash, read, edit]\n---\n\n# ZCommit\n\n执行 git commit 操作，智能分析变更并创建规范的提交信息。`,
  },
]

// ═══════════════════════════════════════════════════════════════════
// 6. Agents (4)
// ═══════════════════════════════════════════════════════════════════

export interface MockAgent {
  name: string
  description: string
  active: boolean
  source: string       // '内置 Agent' | 'pi · ~/.pi/agent/agents/...'
  sourceType: string   // 'builtin' | 'pi' | 'agents'
  icon: string         // 'D' | 'R' | 'O' | 'A'
  iconBg: string       // 'accent' | 'success' | 'warning' | 'danger'
  type: string         // 'builtin' | 'custom'
  tools: string[]      // ['read', 'bash', 'edit', 'write', 'grep']
  modelStrategy: 'auto' | 'tag' | 'bind'  // model selection strategy
  modelBind?: string   // bound model id (when strategy='bind')
  modelTags?: { power: string; efficient: string; fast: string }  // model ids per tag
  overrideParams: boolean  // whether to override global SubAgent params
  params: { depth: number; width: number; tokens: number; rounds: number }
  content: string      // agent.md content
}

export const mockAgents: MockAgent[] = [
  {
    name: '默认编程助手',
    description: '默认的通用编程助手，处理各种编码任务。',
    active: true,
    source: '内置 Agent',
    sourceType: 'builtin',
    icon: 'D',
    iconBg: 'accent',
    type: 'builtin',
    tools: ['read', 'bash', 'edit', 'write', 'grep'],
    modelStrategy: 'auto',
    overrideParams: false,
    params: { depth: 20, width: 10, tokens: 100_000, rounds: 50 },
    content: `---\nname: 默认编程助手\ntype: builtin\nstrategy: auto\n---\n\n# 默认编程助手\n\n默认的通用编程助手，处理各种编码任务。`,
  },
  {
    name: '代码审查员',
    description: '专注于代码审查和质量评估的 Agent。',
    active: true,
    source: 'pi · ~/.pi/agent/agents/reviewer/',
    sourceType: 'pi',
    icon: 'R',
    iconBg: 'success',
    type: 'custom',
    tools: ['read', 'bash', 'grep'],
    modelStrategy: 'tag',
    modelTags: { power: 'claude-sonnet-4', efficient: 'claude-sonnet-4', fast: 'claude-haiku-4' },
    overrideParams: true,
    params: { depth: 5, width: 3, tokens: 50_000, rounds: 20 },
    content: `---\nname: 代码审查员\ntype: custom\nstrategy: tag\nmodelTags:\n  power: claude-sonnet-4\n  efficient: claude-sonnet-4\n  fast: claude-haiku-4\n---\n\n# 代码审查员\n\n专注于代码审查和质量评估的 Agent。`,
  },
  {
    name: '任务编排器',
    description: '负责复杂任务的分解和子任务编排调度。',
    active: true,
    source: 'pi · ~/.pi/agent/agents/orchestrator/',
    sourceType: 'pi',
    icon: 'O',
    iconBg: 'warning',
    type: 'custom',
    tools: ['read', 'bash', 'grep', 'feedback'],
    modelStrategy: 'bind',
    modelBind: 'claude-sonnet-4',
    overrideParams: true,
    params: { depth: 20, width: 10, tokens: 200_000, rounds: 100 },
    content: `---\nname: 任务编排器\ntype: custom\nstrategy: bind\nmodelBind: claude-sonnet-4\n---\n\n# 任务编排器\n\n负责复杂任务的分解和子任务编排调度。`,
  },
  {
    name: '数据分析员',
    description: '专注于数据分析和市场数据处理的 Agent。',
    active: false,
    source: 'agents · ~/.agents/agents/analyst/',
    sourceType: 'agents',
    icon: 'A',
    iconBg: 'danger',
    type: 'custom',
    tools: ['bash', 'read', 'write', 'market-api', 'indicators'],
    modelStrategy: 'tag',
    modelTags: { power: 'o3', efficient: 'deepseek-v4', fast: 'deepseek-v4-flash' },
    overrideParams: false,
    params: { depth: 20, width: 10, tokens: 100_000, rounds: 50 },
    content: `---\nname: 数据分析员\ntype: custom\nstrategy: tag\nmodelTags:\n  power: o3\n  efficient: deepseek-v4\n  fast: deepseek-v4-flash\n---\n\n# 数据分析员\n\n专注于数据分析和市场数据处理的 Agent。`,
  },
]

// ═══════════════════════════════════════════════════════════════════
// 7. Agent Config Rows
// ═══════════════════════════════════════════════════════════════════

export interface ConfigRow {
  label: string
  value: string
}

export const mockGlobalParams = {
  depth: 20,
  width: 10,
  tokens: 100_000,
  rounds: 50,
}

export const mockAgentConfig: ConfigRow[] = [
  { label: '最大 SubAgent 深度', value: '20'      },
  { label: '最大并行宽度',       value: '10'      },
  { label: 'Token 预算',        value: '100,000' },
  { label: '最大轮次',          value: '50'      },
]

// ═══════════════════════════════════════════════════════════════════
// 8. Default Provider Config Rows
// ═══════════════════════════════════════════════════════════════════

export const mockProviderConfig: ConfigRow[] = [
  { label: '默认模型', value: 'claude-sonnet @ anthropic' },
  { label: '思考模式', value: 'high'                      },
  { label: '温度',    value: '0.7'                        },
]

// ═══════════════════════════════════════════════════════════════════
// 9. SubAgent Tree Nodes (drawer)
// ═══════════════════════════════════════════════════════════════════

export type TreeNodeStatus = 'run' | 'pause' | 'idle'

export interface SubAgentTreeNode {
  id: string
  label: string
  status: TreeNodeStatus
  meta: string
  children?: SubAgentTreeNode[]
}

export const mockSubAgentTree: SubAgentTreeNode = {
  id: 'main',
  label: '重构 auth 模块',
  status: 'run',
  meta: 'coordinator',
  children: [
    { id: 'sub1', label: '分析代码结构',   status: 'idle',  meta: '1.2k tok' },
    {
      id: 'sub2',
      label: '重构核心接口',
      status: 'run',
      meta: '2.3k tok',
      children: [
        { id: 'sub3', label: '重构子模块 A1', status: 'pause', meta: '等待确认' },
      ],
    },
    { id: 'sub4', label: '编写测试', status: 'idle', meta: 'pending' },
  ],
}

// ═══════════════════════════════════════════════════════════════════
// 10. Done Items (drawer "已完成" tab)
// ═══════════════════════════════════════════════════════════════════

export interface DoneItem {
  id: string
  name: string
  summary: string
  meta: string       // HTML-safe, e.g. "2m 34s<br>1.2k tok"
}

export const mockDoneItems: DoneItem[] = [
  {
    id: 'd1',
    name: '分析代码结构',
    summary: '发现 3 个主要问题：接口散落、错误类重复、Session 耦合',
    meta: '2m 34s<br>1.2k tok',
  },
  {
    id: 'd2',
    name: '数据模型分析',
    summary: '完成 auth 模块数据流图',
    meta: '45s<br>0.8k tok',
  },
]

// ═══════════════════════════════════════════════════════════════════
// 11. Alert Items (drawer "请求回应" tab)
// ═══════════════════════════════════════════════════════════════════

export interface AlertItem {
  id: string
  name: string
  question: string
  session: string       // "xyz-agent / 重构 auth 模块"
  time: string          // "2m 前"
  simple: boolean       // simple → inline-reply; not simple → link-only
}

export const mockAlertItems: AlertItem[] = [
  {
    id: 'al1',
    name: '重构子模块A1',
    question: '检测到 3 处循环依赖，需要决定处理策略',
    session: '重构 auth 模块',
    time: '2m 前',
    simple: false,
  },
  {
    id: 'al2',
    name: '数据库备份',
    question: '是否在迁移前创建自动备份？',
    session: '数据库迁移',
    time: '5m 前',
    simple: true,
  },
]

// ═══════════════════════════════════════════════════════════════════
// 12. PanelGrid Cards (6 — one per session)
// ═══════════════════════════════════════════════════════════════════

export type PanelGridBadge = 'run' | 'pause' | 'idle'

export interface PreviewLine {
  text: string
  type: 'user' | 'bot' | 'system_done' | 'system_alert'
}

export interface PanelGridCard {
  sessionId: string
  badge: PanelGridBadge
  title: string
  project: string        // "xyz-agent · feat/tree-engine"
  previewLines: PreviewLine[]
  meta: string[]         // ["sonnet:high", "12.3k tok", "完成 2 · 回应 1"]
}

// ═══════════════════════════════════════════════════════════════════
// 13. Conversion Helpers
// ═══════════════════════════════════════════════════════════════════

export function toModelInfos(models: MockModel[]): import('@xyz-agent/shared').ModelInfo[] {
  return models.map(m => ({
    id: m.id,
    name: m.name,
    providerId: m.providerId,
    providerName: m.providerName,
    contextWindow: m.contextWindow,
    enabled: m.enabled,
  }))
}

export const mockPanelGridCards: PanelGridCard[] = [
  {
    sessionId: 's1',
    badge: 'run',
    title: '重构 auth 模块',
    project: 'xyz-agent · feat/tree-engine',
    previewLines: [
      { text: '用户: 帮我重构整个 auth 模块', type: 'user' },
      { text: '助手: 分解成 4 个子任务并行执行…', type: 'bot' },
      { text: 'SubAgent「分析代码结构」已完成', type: 'system_done' },
      { text: 'SubAgent「重构子模块A1」需要确认', type: 'system_alert' },
    ],
    meta: ['sonnet:high', '12.3k tok', '完成 2 · 回应 1'],
  },
  {
    sessionId: 's2',
    badge: 'idle',
    title: 'Tauri GUI 设计',
    project: 'xyz-agent · main',
    previewLines: [
      { text: '用户: 讨论 Tauri GUI 的三栏布局', type: 'user' },
      { text: '助手: 建议左侧 240px 会话列表…', type: 'bot' },
      { text: '用户: 右侧面板太占空间了', type: 'user' },
      { text: '助手: 改为右侧抽屉，按需展开…', type: 'bot' },
    ],
    meta: ['sonnet:high', '3.1k tok'],
  },
  {
    sessionId: 's3',
    badge: 'run',
    title: 'API 性能优化',
    project: 'work-project · main',
    previewLines: [
      { text: '用户: 优化 API 性能，当前 1.2s', type: 'user' },
      { text: '助手: 发现 N+1 查询和缺少缓存…', type: 'bot' },
      { text: 'SubAgent「N+1 查询修复」需要确认', type: 'system_alert' },
    ],
    meta: ['sonnet:high', '8.7k tok', '完成 1 · 回应 1'],
  },
  {
    sessionId: 's4',
    badge: 'idle',
    title: '数据库迁移',
    project: 'work-project · feat/migrate',
    previewLines: [
      { text: '用户: 把数据库从 MySQL 迁到 PG', type: 'user' },
      { text: '助手: 分析了 47 张表的迁移方案…', type: 'bot' },
      { text: '用户: 先迁移核心的 12 张表', type: 'user' },
    ],
    meta: ['sonnet', '1.2k tok'],
  },
  {
    sessionId: 's5',
    badge: 'pause',
    title: '价格预测分析',
    project: 'diy-pc · main',
    previewLines: [
      { text: '用户: 预测 4090 下半年价格走势', type: 'user' },
      { text: '助手: 基于历史数据构建了预测模型…', type: 'bot' },
      { text: '模型准确率: 87.3%', type: 'bot' },
    ],
    meta: ['deepseek-r1', '5.4k tok'],
  },
  {
    sessionId: 's6',
    badge: 'run',
    title: '4090 比价',
    project: 'diy-pc · feat/price',
    previewLines: [
      { text: '用户: 对比 4090 各平台价格', type: 'user' },
      { text: '助手: 已抓取京东、淘宝、拼多多价格…', type: 'bot' },
      { text: '当前最低价: 12,499 (拼多多)', type: 'bot' },
    ],
    meta: ['sonnet', '2.1k tok'],
  },
]
