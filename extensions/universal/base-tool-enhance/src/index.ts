/**
 * @zhushanwen/pi-base-tool-enhance 入口。
 *
 * M1：同名 override pi 内置 bash 工具 + 前台委托官方工厂 + 工具报错审计 hook（D11）。
 * M2：background 任务核心生命周期——bash background 分支（spawn 后台 + registry +
 * 轮询器单例任务表）、bash_output / bash_kill 工具、进程退出收殓、subagent 降级。
 * M3：pending-notifications 通知接入——load 时刷新轮询器通知通路的 pi 引用（D17
 * session 替换接管）+ 挂 exit 边沿通知回调（unregister emit + sendMessage steer）+
 * session_start 对账（reaper 先、对账后，appendEntry 权威路径兜底 pending 收尾）。
 * M5 幂等止血：session_start 维护链中 reaper 挂进程级 once flag（factory 二调
 * handler 累积下 reapOrphanedTasks 每进程至多一次；对账 session 级豁免不挂）。
 * 白名单与配置体系（M4 已交付）经 bash-tool execute 读时加载接入。
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { createBashOutputToolDefinition } from "./bash-output-tool.ts";
import { createBashKillToolDefinition } from "./bash-kill-tool.ts";
import { createBashOverrideToolDefinition } from "./bash-tool.ts";
import { handleTaskExit, refreshPiReference } from "./background/notify.ts";
import { installProcessExitGuard } from "./background/process-exit-guard.ts";
import { reconcilePendingEntries } from "./background/pending-reconcile.ts";
import { setOnTaskExit } from "./background/poller.ts";
import { reapOrphanedTasks } from "./reaper.ts";
import { setupToolErrorAudit } from "./tool-error-audit.ts";

const logger = getLogger("base-tool-enhance");

/**
 * reapOrphanedTasks 的进程级 once flag（幂等止血，设计 docs/design/
 * file-lock-unification-and-reaper-sink.md §3.2 D3「守卫粒度」/ §5 U1-4）。
 *
 * 背景：pi 的 extension 缓存按 cwd 失效——switch_session 时 cwd 不变则 factory
 * 二次调用、session_start handler 累积注册，同一 resume 事件被两组 handler 各跑
 * 一次维护链；reaper 双跑（async 文件锁 probe 二次读）曾在旧锁实现下崩掉 pi
 * 进程（2026-09-01 事故）。本 flag 保证 reaper 每进程至多执行一次，是批次 1 止血
 * （批次 2 reaper 下沉 runtime 后随调用点一起移除，见实施计划 u-bte-remove）。
 *
 * 语义边界（D3 判定准则）：flag 只包**跨 session 副作用**的 reapOrphanedTasks
 * （全局扫描 + 全局锁，正确频率就是每进程至多一次）。reconcilePendingEntries 是
 * session 级操作（读当前 session entries + 当前 session registry，appendEntry
 * 幂等），属豁免类**不挂 flag**，保持每 session_start 执行——桌面端每次激活是
 * startup+resume 双派发，若对账也挂进程级 flag，startup 消费后目标 session 的
 * 对账将永远被跳过（M3 对账在主链路被禁用，此处是唯一执行点）。
 *
 * 行为变化声明：置位先于调用（同步完成，双派发无竞态窗口），reap 抛错不重置——
 * 「下一 session_start 幂等重试」的旧兜底随之失效，孤儿保持原状至下一 pi 进程
 * （批次 2 runtime 启动期兜底扫描将承接此场景）。
 */
let reapExecutedThisProcess = false;

export default function baseToolEnhanceExtension(pi: ExtensionAPI): void {
	// D17 pi 引用刷新：同进程 session 替换（/fork、选择器切换、RPC session.*）→ 新
	// ResourceLoader/eventBus + extension 重新 load → 本调用把通知通路（notify.ts
	// 模块级引用）切到新 pi——任务发起于旧 session 而完成通知投递新 session。
	refreshPiReference(pi);
	// ⑧⑨ 轮询器 exit 边沿 → pending:unregister emit + sendMessage steer（kill 路径
	// 不 sendMessage，见 notify.ts 单点归属规则）。重复 load 幂等（覆盖同一回调）
	setOnTaskExit(handleTaskExit);
	// 同名 "bash" 覆盖内置工具（pi agent-session _refreshToolRegistry：custom 定义后注册者胜）
	pi.registerTool(createBashOverrideToolDefinition());
	// 查询 / 终止工具（D9：独立小工具，kill 与查询权限语义分离）
	pi.registerTool(createBashOutputToolDefinition());
	pi.registerTool(createBashKillToolDefinition());
	// 进程级收殓（D12）：只认 process 信号/退出，绝不在 session_shutdown / dispose 路径
	installProcessExitGuard();
	// unified-hooks 退役承接：工具报错审计（D11 落点）
	setupToolErrorAudit(pi);
	// 孤儿收殓（M5）+ pending 对账（M3）：任意 session 启动触发（startup/reload/new/resume/fork 全 reason）
	pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
		void runSessionStartMaintenance(pi, ctx, event.reason);
	});
}

/**
 * session_start 维护链（M5 reaper + M3 对账，reaper 先、对账后）。
 *
 * 执行形态：fire-and-forget 而非 await——pi extension runner 对 session_start
 * handler 是顺序 await（runner.js emit：逐 handler await），若本 handler await
 * reaper，多进程锁竞争（reaper.lock 等待 + registry 写 busy-wait）会把秒级延迟
 * 累计进 session 启动链。reaper 是兜底机制，不要求启动时序内完成，扔后台跑、
 * 错误吞掉记 warn。
 *
 * 对账同步毫秒级（readRegistry + kill(pid,0) + appendEntry），排在 reaper await
 * 之后同一 async 函数体内顺序执行——先处置孤儿/补写 registry 终态，对账随后读到
 * 正确终态；顺序颠倒也无静默错误（对账先见 running+pid 活则不动作，下一
 * session_start 兜底），按设计约定维持 reaper 先行。
 *
 * 频率语义（reaper 与对账刻意不同，D3 守卫粒度）：
 *  - reaper：进程级 once（reapExecutedThisProcess flag，见其注释）——首个派发
 *    独占执行，后续派发（factory 二调导致的 handler 累积 + startup/resume 双发）
 *    全部跳过。跳过本身无害：三分支判定对已处置孤儿本就幂等 no-op，一次全量
 *    扫描已覆盖进程生命期内的孤儿处置（批次 2 后整条链下沉 runtime）。
 *  - 对账：每 session_start 都跑（session 级豁免类，见 flag 注释）。
 *
 * 入口无条件 debug 日志（S6 观测通道）：每次 handler 派发都打，含 reason 与
 * reapSkipped——XYZ_AGENT_DEBUG=1 时落 extension 日志（默认 no-op），供
 * 「factory 二调下维护链单跑」验收直接观测派发次数与 flag 生效情况。
 */
async function runSessionStartMaintenance(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	reason: SessionStartEvent["reason"],
): Promise<void> {
	const dataDir = getAgentDir();
	const reapSkipped = reapExecutedThisProcess;
	logger.debug("session_start maintenance dispatch", {
		detail: { reason, reapSkipped },
	});
	if (!reapSkipped) {
		reapExecutedThisProcess = true;
		try {
			await reapOrphanedTasks(dataDir);
		} catch (err) {
			// flag 不重置：本进程不再重试，孤儿保持原状至下一 pi 进程
			// （批次 2 runtime 启动期兜底扫描承接）
			logger.warn("session_start reaper failed; no retry this process, orphans stay until next pi process", {
				detail: { err: err instanceof Error ? err.message : String(err) },
			});
		}
	}
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		reconcilePendingEntries(pi, dataDir, sessionId, ctx.sessionManager.getEntries());
	} catch (err) {
		// 对账失败无害：僵尸 register 停留差集，下一 session_start 幂等重查
		logger.warn("session_start pending reconcile failed; zombies retried next session start", {
			detail: { err: err instanceof Error ? err.message : String(err) },
		});
	}
}
