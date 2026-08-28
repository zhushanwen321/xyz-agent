/**
 * schema env 跨包契约常量（零依赖叶子模块）。
 *
 * 抽取自 session-runner.ts（S5 记账项）：session-runner 依赖树沉重（pi SDK /
 * spawn 链），跨包契约测试若从它 import 常量会把整条依赖树拖进测试进程。
 * 本模块只含常量与纯函数、零 import，为 structured-output 侧（及任何消费者）
 * 的跨包契约测试提供稳定 import 点。
 *
 * 层归属：Shared（orchestration 与 execution 共用，先例 timer-delay.ts）。
 */

/**
 * 跨包契约 env 名：workflow 子进程把权威 JSON Schema 通过此 env 传给 structured-output 扩展。
 *
 * [跨包契约 SSOT] 此字面量是两个独立 npm 包（@zhushanwen/pi-subagent-workflow 与
 * @zhushanwen/pi-structured-output）之间的隐式 env 契约。structured-output 包内同名常量为
 * `ENV_SCHEMA = "PI_WORKFLOW_SCHEMA"`（见 extensions/universal/structured-output/src/index.ts）。
 * 两包是独立 npm 包不能直接 import，故各自保留常量但显式标注此契约关系——
 * 任一端改名必须同步另一端，否则权威 schema 注入会静默断桥（子进程不注册 tool/hook）。
 */
export const SCHEMA_ENV_VAR = "PI_WORKFLOW_SCHEMA";

/**
 * schema env 值的字节上限（256 KiB）：超过则注入前 fail-fast 拒绝。
 *
 * 背景（SO-DATA-4）：schema 经 childEnv 注入子进程，env 值随 spawn argv/env 块走
 * execve 语义——单条 env 值过大叠加全量继承的 process.env 时可能触发 E2BIG
 *（ARG_MAX 约束，Linux 通常 ~2MB 总上限，macOS 更紧），spawn 直接失败且错误难归因
 *（E2BIG 报在 spawn 调用点，与 schema 内容无关的表象）。256KB 对 JSON Schema 是
 * 宽裕上限（正常 schema 数 KB），提前拒绝把「难归因的 spawn 失败」变成
 * 「注入点处含实际大小的明确报错」。
 */
/** 1 KiB 字节数（换算基数，SCHEMA_ENV_MAX_BYTES 组合用）。 */
const BYTES_PER_KIB = 1024;
/** 上限的 KiB 形态（256 KiB = 262144 bytes，注释与文档引用值）。 */
const SCHEMA_ENV_MAX_KIB = 256;
export const SCHEMA_ENV_MAX_BYTES = SCHEMA_ENV_MAX_KIB * BYTES_PER_KIB;

/**
 * 计算 schema env 值的 UTF-8 字节长度（注入大小 = 该值，用于超限判定与错误消息）。
 */
export function schemaEnvByteLength(schemaEnv: string): number {
  return Buffer.byteLength(schemaEnv, "utf8");
}
