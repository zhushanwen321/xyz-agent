import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerAutoRenameCommand } from "./commands.js";
import { callRenameLLM, isSubagentSession } from "./llm.js";
import { countSuccessfulAssistantReplies, loadRenameConfig } from "./pure.js";

/**
 * turn_end 事件的宽松类型（参考 pi extensions/types.ts 的 TurnEndEvent）。
 * message 收紧为带 stopReason 的宽松结构（D2 快速路径读取），不依赖 pi 类型导出。
 * 注意交叉目标用 `& object` 而非 `& Record<string, unknown>`：pi 的 AgentMessage 联合成员是
 * interface（无隐式 index signature），后者会导致 handler 注册 on("turn_end") 时参数逆变校验
 * 失败（tsc 实测重载匹配崩掉）；`& object` 同样表达「是对象 + 可选 stopReason」且可编译。
 */
interface TurnEndLikeEvent {
	type: "turn_end";
	turnIndex: number;
	message: { stopReason?: string } & object;
	toolResults: unknown[];
}

/** debug 开关 live 读（每次调用查 process.env，非模块加载时读——vi.stubEnv 可测 + 运行时可切换，D9）。 */
function isRenameDebugEnabled(): boolean {
	return process.env.PI_RENAME_DEBUG === "1";
}

/**
 * pi-rename-session extension 工厂函数。
 * 新 session 首个成功 turn 完成后，用独立模型生成会话标题并 setSessionName 落库。
 */
export default function renameSessionExtension(pi: ExtensionAPI): void {
	registerAutoRenameCommand(pi);

	pi.on("turn_end", async (event: TurnEndLikeEvent, ctx: ExtensionContext) => {
		// handler 侧 debug 日志（C3）：skip 文案 + t=<ISO> + turnIndex=<n>
		// （turnIndex 只在此侧输出——该字段只在 handler 作用域可达，不为日志字段扩 callRenameLLM 签名）
		const debugLog = (message: string): void => {
			if (isRenameDebugEnabled()) {
				console.warn(
					`[rename-session] t=${new Date().toISOString()} turnIndex=${event.turnIndex} ${message}`,
				);
			}
		};
		try {
			// 1. 开关检查（loadRenameConfig：flag 文件 live 覆盖 + config.enabled 回落，见 pure.ts [COMPAT] 契约）
			const config = loadRenameConfig();
			if (!config.enabled) return;

			// 2. 排除 subagent 子进程 session（子 session 是临时产物，rename 产生噪音）
			if (isSubagentSession(ctx.sessionManager.getSessionDir())) return;

			// 3. O(1) 快速路径（D2）：turn_end 每个 iteration 发一次，只有 stopReason==='stop' 的
			// 最终 turn 才触发（过滤 toolUse 中间轮与 error/aborted/length 异常轮）
			if (event.message.stopReason !== "stop") {
				debugLog(`skip: stopReason=${event.message.stopReason}`);
				return;
			}

			// 4. 首 turn 判定（D6）：成功（stop）assistant 回复数 === 1。触发时刻的 turn_end 必然是
			// round 的最终 turn，其 event.message 即最终 assistant message（final text 零遍历可得）
			const entries = ctx.sessionManager.getEntries();
			const successCount = countSuccessfulAssistantReplies(entries);
			if (successCount !== 1) {
				debugLog(`skip: count=${successCount}`);
				return;
			}

			// 5. LLM 生成标题并落库。pi 运行时的事件链是 await 的（runner.emit → await handler），
			// 若 await callRenameLLM 会阻塞 agent 进入下一次迭代。这里用 detached promise 脱离 await 链，
			// 真正实现 fire-and-forget：handler 立即 resolve，LLM 调用与 setSessionName 在后台异步完成。
			void callRenameLLM(ctx, config, event.message)
				.then((title) => {
					if (!title) return;
					// 防覆盖（D5）：落库前重查——LLM 调用窗口（2-30s）内用户手动命名的竞态由此兜住
					// （发起前查没有意义，那时查不能防竞态；skip 文案是 E2E 硬契约）
					if (pi.getSessionName()) {
						debugLog("skip: name exists");
						return;
					}
					pi.setSessionName(title);
				})
				.catch((e) => console.error("[pi-rename-session] rename LLM failed:", e));
			// rename 是 best-effort，任何 LLM 失败（网络/提取/auth/model 不可用）都静默跳过保留原 label，
			// 不进 session history。
		} catch (e) {
			// best-effort 降级：turn_end handler 同步部分（开关/subagent/判定）抛错时记录但不阻断
			// agent 循环——rename 是非关键副作用，任何失败不得干扰主对话。
			console.error("[pi-rename-session] failed:", e);
		}
	});
}
