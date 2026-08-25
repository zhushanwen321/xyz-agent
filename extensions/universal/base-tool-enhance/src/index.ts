/**
 * @zhushanwen/pi-base-tool-enhance 入口。
 *
 * M1：同名 override pi 内置 bash 工具 + 前台委托官方工厂 + 工具报错审计 hook（D11）。
 * M2：background 任务核心生命周期——bash background 分支（spawn 后台 + registry +
 * 轮询器单例任务表）、bash_output / bash_kill 工具、进程退出收殓、subagent 降级。
 * M5：reaper 孤儿收殓（session_start 接线，属主判定 + start-time 防复用）。
 * 通知接入（M3）/ 白名单与配置体系（M4）由后续单元增量交付。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { createBashOutputToolDefinition } from "./bash-output-tool.ts";
import { createBashKillToolDefinition } from "./bash-kill-tool.ts";
import { createBashOverrideToolDefinition } from "./bash-tool.ts";
import { installProcessExitGuard } from "./background/process-exit-guard.ts";
import { reapOrphanedTasks } from "./reaper.ts";
import { setupToolErrorAudit } from "./tool-error-audit.ts";

const logger = getLogger("base-tool-enhance");

export default function baseToolEnhanceExtension(pi: ExtensionAPI): void {
	// 同名 "bash" 覆盖内置工具（pi agent-session _refreshToolRegistry：custom 定义后注册者胜）
	pi.registerTool(createBashOverrideToolDefinition());
	// 查询 / 终止工具（D9：独立小工具，kill 与查询权限语义分离）
	pi.registerTool(createBashOutputToolDefinition());
	pi.registerTool(createBashKillToolDefinition());
	// 进程级收殓（D12）：只认 process 信号/退出，绝不在 session_shutdown / dispose 路径
	installProcessExitGuard();
	// unified-hooks 退役承接：工具报错审计（D11 落点）
	setupToolErrorAudit(pi);
	// 孤儿收殓（M5）：任意 session 启动触发（startup/reload/new/resume/fork 全 reason）
	pi.on("session_start", () => {
		void runSessionStartMaintenance();
	});
}

/**
 * session_start 维护链（当前仅 reaper）。
 *
 * 执行形态：fire-and-forget 而非 await——pi extension runner 对 session_start
 * handler 是顺序 await（runner.js emit：逐 handler await），若本 handler await
 * reaper，多进程锁竞争（reaper.lock 等待 + registry 写 busy-wait）会把秒级延迟
 * 累计进 session 启动链。reaper 是兜底机制，不要求启动时序内完成，扔后台跑、
 * 错误吞掉记 warn（孤儿保持原状，下一 session_start 幂等重试）。
 *
 * 不节流（同进程多次 session_start——CLI /fork /switch 均触发，每次都扫）：
 * 幂等性由三分支判定构造性保证（终态条目跳过、属主活跳过——二次扫描对已处置
 * 孤儿天然 no-op）；无孤儿时扫描成本 = 目录枚举 + 每目录一次 JSON 读 + 每
 * running 条目一次 kill(pid,0)，毫秒级且零子进程开销（ps 只在「属主死 + pid 活」
 * 的孤儿判定时才调用）。节流反而引入「最近扫描后的新孤儿延迟收殓」窗口，不抵。
 *
 * ── M3 对账接入位（Wave4，未接入）──
 * 设计 §3.5 接入细则 4 要求同一 session_start 处理链内「reaper 先、对账后」：
 * pending unregister 对账 handler（appendEntry 兜底）必须加在下方 reaper await
 * 之后（同一 async 函数体内顺序执行），不得另注册独立的 session_start handler
 * 与 reaper 竞争顺序（即使颠倒也无静默错误——设计原文：最坏 S5 断言推迟一个
 * session 周期；但按约定维持 reaper 先行）。
 */
async function runSessionStartMaintenance(): Promise<void> {
	try {
		await reapOrphanedTasks(getAgentDir());
	} catch (err) {
		logger.warn("session_start reaper failed; orphans stay until next session start", {
			detail: { err: err instanceof Error ? err.message : String(err) },
		});
	}
}
