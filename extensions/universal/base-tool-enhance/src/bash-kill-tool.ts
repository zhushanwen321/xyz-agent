/**
 * bash_kill 工具（D9，§3.5「bash_kill 终态收尾的单点归属」）。
 *
 * 职责边界：只负责杀进程树 + kill 前把单例表与 registry **两侧**标 killing intent
 * （查询面立即可见——kill 返回后 bash_output 即显示 killing，无「已 kill 仍 running」
 * 倒挂窗口）。实际终态（exited, reason:"killed"）由轮询器 exit 边沿收尾写——
 * bash_kill 不直接写终态（单一终态归属），也不 sendMessage（kill 调用方就在当前
 * turn 内等结果，再发 steer 通知是双发噪音——那是 M3 的规则，此处先不实现通知）。
 */

import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { killProcessTree } from "./kill-tree.ts";
import { ensurePollerRunning } from "./background/poller.ts";
import { getRegistryPath, readRegistry, taskToRegistryEntry, writeRegistryEntry } from "./background/registry.ts";
import { getAllTasks, markKillingIntent } from "./background/task-store.ts";
import { isActiveState, isTerminalState, type BackgroundTask, type RegistryEntry } from "./background/types.ts";

const bashKillSchema = Type.Object({
	task_id: Type.String({ description: "Task id returned by the background bash tool." }),
});

const BASH_KILL_DESCRIPTION = [
	"Terminate a background bash task by killing its process tree (the task's whole process group).",
	"Returns immediately; poll bash_output {task_id} for the final exited state.",
].join("\n");

/** JSON 输出缩进（registry.ts 同款）。 */
const JSON_INDENT = 2;

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

/** 查找任务：单例表（本进程）→ 当前 session registry（终态历史）。 */
function findTask(taskId: string, sessionId: string): BackgroundTask | RegistryEntry | undefined {
	const fromStore = getAllTasks().find((t) => t.taskId === taskId);
	if (fromStore !== undefined) return fromStore;
	return readRegistry(getRegistryPath(getAgentDir(), sessionId)).get(taskId);
}

export function createBashKillToolDefinition() {
	return {
		name: "bash_kill",
		label: "bash_kill",
		description: BASH_KILL_DESCRIPTION,
		parameters: bashKillSchema,
		async execute(
			_toolCallId: string,
			args: { task_id: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const sessionId = ctx.sessionManager.getSessionId();
			const task = findTask(args.task_id, sessionId);
			if (task === undefined) {
				return textResult(
					JSON.stringify({ killed: false, reason: "no such task", hint: "use bash_output to list" }, null, JSON_INDENT),
				);
			}
			if (isTerminalState(task.state)) {
				return textResult(
					JSON.stringify(
						{
							killed: false,
							reason: `already exited${task.exitCode !== undefined && task.exitCode !== null ? ` (code ${task.exitCode})` : ""}`,
						},
						null,
						JSON_INDENT,
					),
				);
			}

			// 两侧标 killing intent（单例表内存标记 + registry 同步写盘）→ 再杀进程树。
			// intent 落盘在 kill 信号之前，查询面无倒挂窗口
			const marked = markKillingIntent(task.taskId, "killed");
			if (marked !== undefined) {
				writeRegistryEntry(marked.registryPath, taskToRegistryEntry(marked));
			}
			killProcessTree(task.pid);
			// 轮询器确保在跑：边沿收尾（写终态）依赖它
			ensurePollerRunning();
			return textResult(
				JSON.stringify(
					{
						killed: true,
						reason: isActiveState(task.state)
							? "kill signal sent; poll bash_output for the final state"
							: "kill signal re-sent; poll bash_output for the final state",
					},
					null,
					JSON_INDENT,
				),
			);
		},
	};
}
