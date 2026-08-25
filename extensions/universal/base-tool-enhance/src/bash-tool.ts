/**
 * bash 工具同名 override 定义（设计文档 docs/design/base-tool-enhance.md §3.2 方案 B / §3.5）。
 *
 * 前台行为 100% 委托 pi 官方工厂 createBashToolDefinition——override 后工具的全部
 * 行为归本包负责，前台语义必须跟随 pi 版本升级而不是自研复刻（自研 spawn 会与
 * pi 升级双向漂移，截断规则 / shellPath / PI_* env / stdin transport 细节遗漏即回归）。
 * 本模块真正的增量只有两处：
 *  1. input schema 新增 background?: boolean（D2：工具名保持 bash，只扩 schema）
 *  2. description 重写——官方文案不含 background 用法，不重写则模型永远发现不了
 *     新参数，「模型主动要求后台」的路径不可达
 *
 * M1 范围：execute 收到 background:true 也先走前台（background 核心是 M2 单元交付，
 * schema 先行是为了冻结接口形态）。白名单强制转后台（D3/D13）同样是后续单元。
 */

import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * override 后的 bash input schema。
 *
 * 在官方 schema（bash.js bashSchema：command + timeout?）基础上只追加 background。
 * timeout 单位与官方一致 = 秒；background 缺省 false（不传 = 前台，等价官方行为）。
 */
const enhancedBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run in background: returns a task_id immediately instead of waiting for the command to finish. Default false.",
		}),
	),
});

/**
 * 重写的 bash description（给 LLM 的，英文，风格对齐官方文案 bash.js:233）。
 *
 * 覆盖设计文档 §3.5 要求的三个要点：
 *  1. background:true 语义（立即返回 task_id，bash_output 查询 / bash_kill 终止）
 *  2. 白名单命中命令自动转后台（即使未要求 background）
 *  3. timeout 单位秒、显式填写会被尊重（唯一例外：白名单强转后台时忽略，D13）
 *
 * bash_output / bash_kill 工具由 M2 单元注册，description 先行提及（D2/§3.5 要求）。
 */
const ENHANCED_BASH_DESCRIPTION = [
	"Execute a bash command in the current working directory. Returns stdout and stderr.",
	"Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file.",
	"Optionally provide a timeout in seconds; an explicit timeout is respected, except when a whitelisted long-running command is force-routed to background.",
	"",
	"Background mode: set background: true to start the command without waiting for it. The tool returns immediately with a task_id, the pid, and an output file path, and you can continue other work while it runs.",
	"Poll progress and fetch output with bash_output {task_id} (omit task_id to list all background tasks); terminate a task with bash_kill {task_id}.",
	"",
	"Commands matching the force-background whitelist (test suites, dev servers, watch jobs and similar long-running commands) are automatically routed to background even when background was not requested; in that case the result carries a task_id to poll.",
].join("\n");

/**
 * 构建 bash override 的 ToolDefinition。
 *
 * cwd 处理：官方工厂在调用时固化 cwd（execute 闭包捕获），而 extension load 时机
 * 早于会话 cwd 确定。因此以 execute 时 ctx.cwd 为权威：cwd 变化（cd / session 切换）
 * 就地重建 delegate；同 cwd 复用（工厂是纯函数，重建仅多创建 ops 闭包，单槽缓存
 * 防止每次工具调用重复构建）。promptSnippet / promptGuidelines 从官方 delegate
 * 透传——override 掉整个 definition 后不透传会丢掉系统提示里的工具片段（types.d.ts
 * ToolDefinition：无 promptSnippet 的 custom tool 会被 Available tools 段省略）。
 */
export function createBashOverrideToolDefinition() {
	let cachedCwd: string | undefined;
	// 官方工厂返回值的形状 = ToolDefinition（bash.js createBashToolDefinition），
	// 类型交由 pi 公开导出推断，不在本地重复声明（防与 pi 升级漂移）。
	type OfficialBashTool = ReturnType<typeof createBashToolDefinition>;
	let cachedDelegate: OfficialBashTool | undefined;

	const getDelegate = (cwd: string): OfficialBashTool => {
		if (cachedDelegate === undefined || cachedCwd !== cwd) {
			cachedDelegate = createBashToolDefinition(cwd);
			cachedCwd = cwd;
		}
		return cachedDelegate;
	};

	// registerTool 发生在 extension load 时（无 execute ctx），初始 delegate 用
	// 进程 cwd 建立——name/label/promptSnippet 等静态字段与 cwd 无关，execute 路径
	// 会被 getDelegate(ctx.cwd) 纠正。
	const initial = getDelegate(process.cwd());

	return {
		name: initial.name, // "bash"：同名覆盖内置工具（agent-session _refreshToolRegistry 后注册者胜）
		label: initial.label,
		description: ENHANCED_BASH_DESCRIPTION,
		promptSnippet: initial.promptSnippet,
		promptGuidelines: initial.promptGuidelines,
		parameters: enhancedBashSchema,
		async execute(
			toolCallId: string,
			args: { command: string; timeout?: number; background?: boolean },
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		) {
			const delegate = getDelegate(ctx.cwd);
			// 前台委托：只转发官方 schema 已识别的字段（command/timeout），background
			// 是本包增量，官方 execute 不认识（其解构也只取这两个键，显式构造让
			// 「本层转发面」在代码上自解释）。M1 阶段 background 一律走前台。
			return delegate.execute(toolCallId, { command: args.command, timeout: args.timeout }, signal, onUpdate, ctx);
		},
	};
}
