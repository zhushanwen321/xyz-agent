/**
 * @zhushanwen/pi-base-tool-enhance 入口。
 *
 * M1：同名 override pi 内置 bash 工具 + 前台委托官方工厂 + 工具报错审计 hook（D11）。
 * M2：background 任务核心生命周期——bash background 分支（spawn 后台 + registry +
 * 轮询器单例任务表）、bash_output / bash_kill 工具、进程退出收殓、subagent 降级。
 * M3：pending-notifications 通知接入——load 时刷新轮询器通知通路的 pi 引用（D17
 * session 替换接管）+ 挂 exit 边沿通知回调（unregister emit + sendMessage steer）+
 * session_start 对账（reaper 先、对账后，appendEntry 权威路径兜底 pending 收尾）。
 * 白名单与配置体系（M4 已交付）经 bash-tool execute 读时加载接入。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		void runSessionStartMaintenance(pi, ctx);
	});
}

/**
 * session_start 维护链（M5 reaper + M3 对账，reaper 先、对账后）。
 *
 * 执行形态：fire-and-forget 而非 await——pi extension runner 对 session_start
 * handler 是顺序 await（runner.js emit：逐 handler await），若本 handler await
 * reaper，多进程锁竞争（reaper.lock 等待 + registry 写 busy-wait）会把秒级延迟
 * 累计进 session 启动链。reaper 是兜底机制，不要求启动时序内完成，扔后台跑、
 * 错误吞掉记 warn（孤儿保持原状，下一 session_start 幂等重试）。
 *
 * 对账同步毫秒级（readRegistry + kill(pid,0) + appendEntry），排在 reaper await
 * 之后同一 async 函数体内顺序执行——先处置孤儿/补写 registry 终态，对账随后读到
 * 正确终态；顺序颠倒也无静默错误（对账先见 running+pid 活则不动作，下一
 * session_start 兜底），按设计约定维持 reaper 先行。
 *
 * 不节流（同进程多次 session_start——CLI /fork /switch 均触发，每次都扫）：
 * 幂等性由三分支判定构造性保证（终态条目跳过、属主活跳过——二次扫描对已处置
 * 孤儿天然 no-op）；无孤儿时扫描成本 = 目录枚举 + 每目录一次 JSON 读 + 每
 * running 条目一次 kill(pid,0)，毫秒级且零子进程开销（ps 只在「属主死 + pid 活」
 * 的孤儿判定时才调用）。节流反而引入「最近扫描后的新孤儿延迟收殓」窗口，不抵。
 */
async function runSessionStartMaintenance(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const dataDir = getAgentDir();
	try {
		await reapOrphanedTasks(dataDir);
	} catch (err) {
		logger.warn("session_start reaper failed; orphans stay until next session start", {
			detail: { err: err instanceof Error ? err.message : String(err) },
		});
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
