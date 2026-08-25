/**
 * bash_output 工具（D9：独立小工具，查询与 kill 权限语义分离）。
 *
 * 规格（§3.5）：{task_id?}。
 *  - 省略 = list：单例表与 registry 终态条目合并（同 task_id 以单例表为准——它的
 *    状态更新），返回 {tasks:[...]}，按 startedAt 升序
 *  - 指定 = 详情：{state, exitCode?, reason?, durationMs?, output(tail 2000 行/50KB
 *    截断，同内置规则), outputFile, truncated}；输出文件被删后返回
 *    {output:"<lost>", state} 不崩溃（§3.6）
 *
 * 查询归属边界（§3.5 跨进程边界）：单例表 = 本进程全部任务（含同进程 session 替换
 * 前发起的）；registry 侧只读当前 sessionId 目录。他进程任务查不到（回发起 session）。
 */

import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { readOutputTail } from "./background/output-tail.ts";
import { getRegistryPath, readRegistry } from "./background/registry.ts";
import { truncateCommand } from "./background/spawn-background.ts";
import { getAllTasks } from "./background/task-store.ts";
import { isTerminalState, type BackgroundTask, type RegistryEntry } from "./background/types.ts";

const bashOutputSchema = Type.Object({
	task_id: Type.Optional(Type.String({ description: "Task id returned by the background bash tool. Omit to list all background tasks." })),
});

/** JSON 输出缩进（registry.ts 同款）。 */
const JSON_INDENT = 2;

const BASH_OUTPUT_DESCRIPTION = [
	"Fetch output and status of a background bash task started with bash {background:true}.",
	"Provide task_id to get task detail: state (running|killing|exited|orphaned), exitCode, reason, duration and tail output (last 2000 lines / 50KB).",
	"Omit task_id to list all background tasks of this session.",
].join("\n");

/** list 视图条目（§3.5：command 前 80 字符）。 */
function toListRow(source: BackgroundTask | RegistryEntry) {
	return {
		task_id: source.taskId,
		command: truncateCommand(source.command),
		state: source.state,
		...(source.exitCode !== undefined ? { exitCode: source.exitCode } : {}),
		...(source.reason !== undefined ? { reason: source.reason } : {}),
		startedAt: source.startedAt,
		...(source.durationMs !== undefined ? { durationMs: source.durationMs } : {}),
	};
}

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

export function createBashOutputToolDefinition() {
	return {
		name: "bash_output",
		label: "bash_output",
		description: BASH_OUTPUT_DESCRIPTION,
		parameters: bashOutputSchema,
		async execute(
			_toolCallId: string,
			args: { task_id?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const sessionId = ctx.sessionManager.getSessionId();
			const registry = readRegistry(getRegistryPath(getAgentDir(), sessionId));

			if (args.task_id === undefined) {
				// list：单例表优先，registry 终态条目补差（同 id 已在单例表则跳过）。
				// registry 侧只并入终态（exited/orphaned）——running/killing 条目属他进程
				// 任务（本进程活跃任务必在单例表），并入会显示幻影 running 行（§3.5
				// 「单例表与 registry 终态条目合并」）
				const rows = new Map<string, ReturnType<typeof toListRow>>();
				for (const task of getAllTasks()) rows.set(task.taskId, toListRow(task));
				for (const entry of registry.values()) {
					if (!isTerminalState(entry.state)) continue;
					if (!rows.has(entry.taskId)) rows.set(entry.taskId, toListRow(entry));
				}
				const tasks = [...rows.values()].sort((a, b) => a.startedAt - b.startedAt);
				return textResult(JSON.stringify({ tasks }, null, JSON_INDENT));
			}

			// 详情：单例表 → 当前 session registry（回落限定终态条目——他进程 running
			// 条目不可查，§3.5 跨进程边界）→ 都没有
			const registryEntry = registry.get(args.task_id);
			const task =
				getAllTasks().find((t) => t.taskId === args.task_id) ??
				(registryEntry !== undefined && isTerminalState(registryEntry.state) ? registryEntry : undefined);
			if (task === undefined) {
				throw new Error(
					`No such task: ${args.task_id}. Use bash_output without task_id to list all background tasks.`,
				);
			}
			const tail = readOutputTail(task.outputFile);
			const detail = {
				task_id: task.taskId,
				state: task.state,
				...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
				...(task.reason !== undefined ? { reason: task.reason } : {}),
				startedAt: task.startedAt,
				...(task.durationMs !== undefined ? { durationMs: task.durationMs } : {}),
				output: tail?.output ?? "<lost>",
				truncated: tail?.truncated ?? false,
				outputFile: task.outputFile,
			};
			return textResult(JSON.stringify(detail, null, JSON_INDENT));
		},
	};
}
