/* eslint-disable no-magic-numbers */
/**
 * Mock fixture —— 最小但结构完整的预制数据（D7：严格镜像 shared 类型）。
 *
 * - 3 个 SessionSummary（active/idle 混合，含 git/worktree 字段证明全字段）
 * - s1 带完整消息回合（user + assistant + toolCall + contentBlocks，证明 Message 结构）
 * - fixtureMessages 供 selfcheck/test 验证结构；mock 运行时 chat.send 另起流式，不复用历史
 *
 * 内存介质（D7）：reload 重置，不写文件。
 */
import type { SessionSummary, Message } from '@xyz-agent/shared'

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
    label: 'Tauri GUI 设计',
    cwd: '/Users/zhushanwen/Code/xyz-agent',
    status: 'idle',
    lastActiveAt: NOW - DAY,
    modelId: 'claude-sonnet-4',
    tokenCount: 3_100,
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
]

/**
 * 按 sessionId 索引的初始消息。
 * s1 含一条带 toolCall 的 assistant 消息，证明 ToolCall/ContentBlock 结构完整。
 */
export const fixtureMessages: Record<string, Message[]> = {
  s1: [
    {
      id: 'm1',
      role: 'user',
      content: '帮我重构整个 auth 模块，包括接口定义和错误处理。',
      status: 'complete',
      timestamp: NOW - 10 * MINUTE,
    },
    {
      id: 'm2',
      role: 'assistant',
      content: '我先看一下现有的 auth 模块结构。',
      status: 'complete',
      timestamp: NOW - 9 * MINUTE,
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
      ],
      contentBlocks: [
        { type: 'toolCall', refId: 'tc1' },
        { type: 'text', refId: 'text' },
      ],
    },
  ],
  s2: [
    {
      id: 'm3',
      role: 'user',
      content: '设计一个 Tauri GUI 的侧边栏布局。',
      status: 'complete',
      timestamp: NOW - DAY,
    },
  ],
  s3: [],
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
