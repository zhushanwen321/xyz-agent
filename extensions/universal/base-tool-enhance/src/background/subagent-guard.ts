/**
 * subagent 进程识别（D14 降级判据，探针 P5）。
 *
 * subagent-core 的 buildChildEnv（packages/subagent-core/src/execution/engine/engines/pi/session-runner.ts）
 * 对每个子 agent 进程**无条件**注入身份贯穿 env（PI_SUBAGENT_ROOT_SESSION_ID / SELF_RECORD_ID /
 * DEPTH / ROOT_CWD，见其源码注释「无条件注入每个 subagent」）。任一存在 = 当前
 * pi 进程是 subagent 子进程 → 本扩展降级：background:true 被忽略走前台同步语义。
 *
 * 为什么降级：子 agent 内后台化会破坏 workflow 结构化输出契约（预算耗尽时测试未
 * 回）；且子进程死后其 registry 目录永远不会再有 session 启动，孤儿无人 reap。
 */

/** subagent-core（session-runner）注入的身份贯穿 env 前缀（跨包契约，P5 探针确认）。 */
const SUBAGENT_ENV_KEYS = [
	"PI_SUBAGENT_ROOT_SESSION_ID",
	"PI_SUBAGENT_SELF_RECORD_ID",
] as const;

export function isSubagentProcess(): boolean {
	return SUBAGENT_ENV_KEYS.some((key) => process.env[key] !== undefined);
}
