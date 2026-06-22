/* eslint-disable no-magic-numbers */
/**
 * Mock fixture —— 最小但结构完整的预制数据（D7：严格镜像 shared 类型）。
 *
 * - 5 个 SessionSummary，覆盖 D6 派生 5 态（error/waiting/done/running/stopped 各一）
 * - s1 多回合（error）：user / assistant text / tool_call(成功+失败) / thinking，
 *   末条 assistant status:error → error 态；覆盖 G2-006 契约所有块类型让 UC-2 可验收（回合折叠 pill 可验）
 * - s2 单回合（waiting）：末条 assistant 含 status:running 的 toolCall → waiting 脉冲
 * - s3 空会话（done）：验证空态欢迎语
 * - s4 流式中（running）：末条 assistant status:streaming → running 脉冲
 * - s5 已中断（stopped）：末条 assistant isInterrupted → stopped 灰态
 * - S3/S4 相关块（@/#// 命令、附件）不造（G2-002 DEFERRED）
 * - fixtureMessages 供 getHistory 回填；mock 运行时 chat.send 另起流式，不复用历史
 *
 * 内存介质（D7）：reload 重置，不写文件。
 */
import type { SessionSummary, Message, FileChange } from '@xyz-agent/shared'

const HOUR = 3_600_000
const DAY = 86_400_000
const MINUTE = 60_000
const NOW = Date.now()

export const fixtureSessions: SessionSummary[] = [
  {
    id: 's1',
    label: '重构 auth 模块',
    cwd: '/Users/zhushanwen/Code/xyz-agent',
    gitBranch: 'refactor-auth',
    gitIsWorktree: true,
    status: 'active',
    lastActiveAt: NOW - 2 * HOUR,
    modelId: 'claude-sonnet-4',
    thinkingLevel: 'medium',
    tokenCount: 12_300,
  },
  {
    id: 's2',
    label: 'Lint 排查中',
    cwd: '/Users/zhushanwen/Code/xyz-agent',
    gitBranch: 'refactor-auth',
    gitIsWorktree: true,
    status: 'active',
    lastActiveAt: NOW - 30 * MINUTE,
    modelId: 'claude-sonnet-4',
    tokenCount: 5_400,
  },
  {
    id: 's3',
    label: 'API 性能优化',
    cwd: '/Users/zhushanwen/Code/work-project',
    gitBranch: 'main',
    status: 'idle',
    lastActiveAt: NOW - 5 * DAY,
    modelId: 'deepseek-v3',
    tokenCount: 8_700,
  },
  {
    id: 's4',
    label: 'Promise 代码评审',
    cwd: '/Users/zhushanwen/Code/work-project',
    status: 'active',
    lastActiveAt: NOW - 4 * MINUTE,
    modelId: 'claude-sonnet-4',
    tokenCount: 820,
  },
  {
    id: 's5',
    label: '状态机重构（已废弃）',
    cwd: '/Users/zhushanwen/Code/xyz-agent',
    gitBranch: 'feat-fsm',
    gitIsWorktree: true,
    status: 'idle',
    lastActiveAt: NOW - 60 * MINUTE,
    modelId: 'claude-sonnet-4',
    tokenCount: 2_400,
  },
]

/**
 * 按 sessionId 索引的初始消息。
 * s1：2 个完整回合 —— 回合1（user + assistant 含 thinking + tool_call 成功 + 收尾 summary），
 *     回合2（user + assistant 含 tool_call 失败 + 错误块）。
 * s2：1 个纯文字回合（无工具无思考，验证无折叠条 turn）。
 * s3：空（验证空态）。
 */
export const fixtureMessages: Record<string, Message[]> = {
  s1: [
    // ── 回合 1：完整回合（思考 + 工具成功 + 总结）──
    {
      id: 'u1',
      role: 'user',
      content: '帮我看一下 auth 模块的结构，把登录校验改成 async。'
      ,
      status: 'complete',
      timestamp: NOW - 10 * MINUTE,
    },
    {
      id: 'a1',
      role: 'assistant',
      content:
        '已将 AuthService.login 改为 async，返回 Promise<Token>。字段校验下沉到 schema 层，API 失败回退 toast。',
      status: 'complete',
      timestamp: NOW - 9 * MINUTE,
      thinking: [
        {
          id: 'th1',
          content:
            '先确认字段范围（username / password），再建 schema 文件，最后改 Login.vue 接 toTypedSchema。',
          collapsed: true,
        },
      ],
      toolCalls: [
        {
          id: 'tc1',
          toolName: 'read_file',
          input: { path: 'src/auth/index.ts' },
          output: 'export function login() {}',
          status: 'completed',
          startTime: NOW - 9 * MINUTE,
          endTime: NOW - 9 * MINUTE + 200,
        },
        {
          id: 'tc2',
          toolName: 'edit_file',
          input: { path: 'src/auth/index.ts' },
          output: 'async login(): Promise<Token>',
          status: 'completed',
          startTime: NOW - 9 * MINUTE + 300,
          endTime: NOW - 9 * MINUTE + 800,
        },
      ],
      contentBlocks: [
        { type: 'thinking', refId: 'th1' },
        { type: 'toolCall', refId: 'tc1' },
        { type: 'toolCall', refId: 'tc2' },
        { type: 'text', refId: 'text' },
      ],
    },
    // ── 回合 2：含 tool_call 失败（整块红框，错误是 tool 属性）──
    {
      id: 'u2',
      role: 'user',
      content: '把改动提交一下',
      status: 'complete',
      timestamp: NOW - 3 * MINUTE,
    },
    {
      id: 'a2',
      role: 'assistant',
      content: '提交时遇到文件锁，写入失败。请确认没有外部进程占用后重试。',
      status: 'error',
      timestamp: NOW - 2 * MINUTE,
      toolCalls: [
        {
          id: 'tc3',
          toolName: 'bash',
          input: { command: 'git commit -m "refactor auth"' },
          output: 'EBUSY: 文件被外部进程占用，写入失败',
          status: 'error',
          startTime: NOW - 2 * MINUTE,
          endTime: NOW - 2 * MINUTE + 120,
        },
      ],
      contentBlocks: [
        { type: 'toolCall', refId: 'tc3' },
        { type: 'text', refId: 'text' },
      ],
    },
  ],
  s2: [
    // ── 回合 1：末条 assistant 含 status:running 的 toolCall → waiting 脉冲态 ──
    {
      id: 'u3',
      role: 'user',
      content: '跑一下 lint 看看还有没有问题',
      status: 'complete',
      timestamp: NOW - 30 * MINUTE,
    },
    {
      id: 'a3',
      role: 'assistant',
      content: '',
      status: 'streaming',
      timestamp: NOW - 29 * MINUTE,
      toolCalls: [
        {
          id: 'tc4',
          toolName: 'bash',
          input: { command: 'npm run lint' },
          status: 'running',
          startTime: NOW - 29 * MINUTE,
        },
      ],
      contentBlocks: [{ type: 'toolCall', refId: 'tc4' }],
    },
  ],
  s3: [],
  s4: [
    // ── 回合 1：末条 assistant status:streaming（流式文本中）→ running 脉冲态 ──
    {
      id: 'u4',
      role: 'user',
      content: '解释一下 Promise.allSettled 和 Promise.all 的区别',
      status: 'complete',
      timestamp: NOW - 5 * MINUTE,
    },
    {
      id: 'a4',
      role: 'assistant',
      content: 'Promise.allSettled 会等所有 promise 完成（不短路），每个返回 {status, value/reason}…',
      status: 'streaming',
      timestamp: NOW - 4 * MINUTE,
    },
  ],
  s5: [
    // ── 回合 1：末条 assistant isInterrupted（用户 abort）→ stopped 灰态 ──
    {
      id: 'u5',
      role: 'user',
      content: '把整个状态机重构一遍',
      status: 'complete',
      timestamp: NOW - 60 * MINUTE,
    },
    {
      id: 'a5',
      role: 'assistant',
      content: '我先看一下现有的状态机实现，然后画一张状态转换图…',
      status: 'complete',
      isInterrupted: true,
      timestamp: NOW - 59 * MINUTE,
    },
  ],
}

let createSeq = 0

/** 创建新 session（内存 push，返回深拷贝避免外部突变 fixture） */
export function createSession(label?: string): SessionSummary {
  createSeq += 1
  const session: SessionSummary = {
    id: `mock-${NOW + createSeq}`,
    label: label ?? `新会话 ${createSeq}`,
    cwd: '/Users/zhushanwen/Code/xyz-agent',
    status: 'active',
    lastActiveAt: Date.now(),
    modelId: 'claude-sonnet-4',
    tokenCount: 0,
  }
  return session
}

/**
 * 按 sessionId 索引的文件改动 mock（sidebar 文件视图 draft-five-states §B）。
 * 用扁平 FileChange[]，组件内构建树。只有有改动的 session 造数据。
 */
export const fixtureFileChanges: Record<string, FileChange[]> = {
  s1: [
    { filePath: 'src/auth/index.ts', status: 'modified' },
    { filePath: 'src/auth/schema.ts', status: 'added' },
    { filePath: 'src/components/Login.vue', status: 'modified' },
    { filePath: 'package.json', status: 'modified' },
  ],
  s2: [
    { filePath: '.eslintrc.cjs', status: 'modified' },
  ],
  s5: [
    { filePath: 'src/fsm/state-machine.ts', status: 'modified' },
    { filePath: 'src/fsm/transitions.ts', status: 'deleted' },
  ],
}
