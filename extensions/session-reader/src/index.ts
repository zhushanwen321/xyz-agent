import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { handleSessionRead, type SessionReadParams } from './tool-handler.js'
import { createHashAutocompleteProvider } from './tui/hash-provider.js'
import { createSessionCommand } from './tui/session-command.js'

/**
 * pi-session-reader extension 入口（M3 工具适配层）。
 *
 * 分层（同 scheduler/cw-tool）：
 * - tool-handler.ts：纯逻辑 handler，agentDir 注入，零 pi 依赖，可单测
 * - index.ts（本文件）：pi 依赖层，registerTool + getAgentDir() 调用 + execute 闭包
 *   （catch handler 抛的 Error 转 isError:true，execute 不向 pi 抛——pi 工具契约）
 *
 * M4 将在此 addAutocompleteProvider（TUI # 补全，ctx.mode === 'tui' 时）。
 */

// ---- TypeBox 参数 schema（design §3.4 14 字段）----

const SessionReadSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal('find'),
      Type.Literal('family'),
      Type.Literal('outline'),
      Type.Literal('expand'),
      Type.Literal('detail'),
      Type.Literal('search'),
      Type.Literal('export'),
    ],
    {
      description:
        'Action to perform: find (locate session), family (fork/subagent/workflow relations), outline (turn-level overview), expand (single-turn entries), detail (full text of turns), search (full-text grep), export (materialize to file).',
    },
  ),
  session: Type.Optional(
    Type.String({
      description:
        'Session id or uuid fragment (e.g. e6c96). Required for family/outline/expand/detail/search/export. # prefix auto-stripped.',
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        'find action: uuid fragment / filename / name keyword / "recent" (returns most recent N).',
    }),
  ),
  turns: Type.Optional(
    Type.String({
      description: 'detail action: turn range, "T013-T015" or "T013".',
    }),
  ),
  turn: Type.Optional(
    Type.String({ description: 'expand action: single turn, "T013".' }),
  ),
  pattern: Type.Optional(
    Type.String({ description: 'search action: substring or regex.' }),
  ),
  scope: Type.Optional(
    Type.Union(
      [Type.Literal('all'), Type.Literal('user'), Type.Literal('assistant'), Type.Literal('toolResult')],
      { description: 'search action: scope filter. Default all.' },
    ),
  ),
  format: Type.Optional(
    Type.Union(
      [Type.Literal('outline'), Type.Literal('full'), Type.Literal('family')],
      { description: 'export action: materialized form. Default outline.' },
    ),
  ),
  includeToolResult: Type.Optional(
    Type.Boolean({
      description: 'detail/export: include toolResult full text. Default false (omitted as noise).',
    }),
  ),
  includeThinking: Type.Optional(
    Type.Boolean({
      description: 'detail: include thinking blocks. Default false (omitted as noise).',
    }),
  ),
  allBranches: Type.Optional(
    Type.Boolean({
      description: 'outline/family: include abandoned side-branches. Default false.',
    }),
  ),
  granularity: Type.Optional(
    Type.Union([Type.Literal('turn'), Type.Literal('entry')], {
      description: 'outline: turn-level or entry-flat. Default turn.',
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: 'find: filter by cwd. Optional.' }),
  ),
  limit: Type.Optional(
    Type.Number({ description: 'find/search: max results. Default 20.' }),
  ),
})

// ---- guidelines（注入 LLM，design §3.4）----

const guidelines = [
  'Progressive reading: outline (~500 token overview) → expand (one turn) → detail (full text). Default omits toolResult/thinking noise.',
  'find first to locate a session by uuid fragment or name. TUI #references are uuid fragments.',
  'outline before detail. Never read raw .jsonl files—use this tool.',
  'family traces fork parents/children, subagent sessions, and workflow runs.',
  'Errors carry a 👉 recovery hint—follow it to retry in one step.',
]

// ---- 工具 description（design §3.4，照搬措辞）----

const description = `Read pi session files (conversation history) by semantic structure instead of raw bytes. Use when you need to review another session, trace a fork/subagent/workflow family, or locate a past decision. Seven actions: find (locate by name/uuid fragment), family (fork/subagent/workflow relations), outline (turn-level overview, ~500 token), expand (single-turn entry list), detail (full text of turns), search (full-text grep across a session), export (materialize to file). Progressive reading: outline → expand → detail. Do NOT use for the current session (use get_messages) or to edit sessions (pi has /resume /fork).`

/**
 * TUI provider/command 一次性注册标记。
 * addAutocompleteProvider 是 stack 模式（wrap on top of built-in），session_start 每个
 * session 触发，无 guard 会无限堆叠 provider。once-guard 确保整个进程生命周期只注册一次。
 */
let tuiRegistered = false

export default function sessionReaderExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'session_read',
    label: 'Session Reader',
    description,
    parameters: SessionReadSchema,
    promptGuidelines: guidelines,
    async execute(
      _toolCallId: string,
      params: SessionReadParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ) {
      try {
        return await handleSessionRead(params, getAgentDir())
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          content: [{ type: 'text' as const, text: msg }],
          details: {},
          isError: true,
        }
      }
    },
  })

  // ── M4 TUI 层（design §1 + §3.3 D-3/D-4 + 附录 P-hash-trigger）──────────
  // # 引用补全 provider + /session-pick 命令（命令名避开 pi 内置 /session 冲突）。仅 ctx.mode === 'tui' 注册：RPC 模式
  // （xyz-agent 子进程）不用 pi TUI editor / slash 命令，加载即跳过。
  //
  // addAutocompleteProvider 挂在 ctx.ui（非 ExtensionAPI），setup 入口无 ctx，
  // 只能在 event handler 里拿——session_start 是最早且每 session 触发的 event。
  // once-guard + ctx.mode 守卫 + typeof 运行时守卫三重防护。
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return
    if (tuiRegistered) return
    if (typeof ctx.ui.addAutocompleteProvider !== 'function') return
    tuiRegistered = true
    const agentDir = getAgentDir()
    pi.registerCommand('session-pick', createSessionCommand(agentDir))
    ctx.ui.addAutocompleteProvider((current) =>
      createHashAutocompleteProvider(agentDir, current),
    )
  })
}
