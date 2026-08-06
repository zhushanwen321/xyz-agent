/**
 * cw 子进程执行抽象。
 *
 * 设计为可注入（CwSpawner），使核心逻辑（cw-runner.ts）可在测试中用 fake
 * spawner 替换，避免真调 cw。默认实现 {@link defaultCwSpawner} 走 child_process。
 *
 * cw 路径解析：spawn 裸命令名 `cw`，由 OS execvp 语义在 `process.env.PATH` 中
 * 查找（架构约定 #16：禁止写死绝对路径）。env 继承自 process.env，确保 PATH 可用。
 */
import { spawn } from "node:child_process";

/** cw 子进程执行结果。 */
export interface CwSpawnResult {
	/** stdout 内容（cw action 通常把结果 JSON 输出到 stdout）。 */
	stdout: string;
	/** stderr 内容（cw 的错误/诊断信息）。 */
	stderr: string;
	/** 进程退出码；null 表示被信号终止未产出退出码（视为异常）。 */
	exitCode: number | null;
}

/**
 * spawn cw 的可注入抽象。
 *
 * @param args  传给 cw 的参数（不含 `cw` 本身，由实现补上）。
 * @param input 要写入子进程 stdin 的内容；undefined 表示不写（cw 不读 stdin）。
 * @param cwd   子进程工作目录。
 */
export type CwSpawner = (args: string[], input: string | undefined, cwd: string) => Promise<CwSpawnResult>;

/**
 * 默认 cw spawner：用 child_process.spawn 执行 PATH 中的 `cw`。
 *
 * - stdout/stderr 设 utf8 编码后全量捕获（data 回调收 string，无需 Buffer 处理）。
 * - input（若提供）写入 stdin 后关闭；未提供则直接 end（cw 不阻塞等待 stdin）。
 * - spawn 自身失败（如 cw 不在 PATH）走 'error' 事件，拼进 stderr、exitCode=-1 标记异常。
 */
export const defaultCwSpawner: CwSpawner = (args, input, cwd) =>
	new Promise<CwSpawnResult>((resolve) => {
		const child = spawn("cw", args, {
			cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		if (input !== undefined) {
			child.stdin.write(input, "utf8");
		}
		child.stdin.end();

		child.on("error", (err: NodeJS.ErrnoException) => {
			// spawn 失败（cw 不在 PATH / 无执行权限等）。exitCode=-1 区分于正常退出码。
			resolve({ stdout, stderr: `${stderr}\n[spawn error] ${err.message}`, exitCode: -1 });
		});
		child.on("close", (code: number | null) => {
			resolve({ stdout, stderr, exitCode: code });
		});
	});
