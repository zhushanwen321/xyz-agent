/**
 * RPC 超时校准链常量 SSOT（timeout-slow-flow-wallclock 设计 D2/D3）。
 *
 * 为什么独立文件而非 protocol.ts：protocol.ts 是 wire 形状契约（纯类型 + 守卫），
 * 本文件是运行时超时校准链值域——「协议长什么样」与「各层等多久」是真差异，混装
 * 会稀释两边的单一职责。renderer 与 runtime 双端 import 本文件（barrel 导出），
 * 编译期保证校准链对齐（下游 = 上游 + 余量），消灭注释手动对齐的漂移模式
 * （compact 65s→300s 前科的同根预防）。
 *
 * 消费方：runtime rpc-client（第一刀）/ renderer api 域（backstop，+RENDERER_RPC_MARGIN_MS）。
 */

/**
 * composer bash RPC 超时（runtime 侧第一刀，1 小时）。
 *
 * bash 是命令执行（任务级，合法耗时可达小时级），与 compact（LLM 压缩，分钟级）
 * 量级差一个数量级，禁止共用一个常量（规则 19「禁止跨粒级挪用」；2026-09 超时普查
 * 实锤 `!sleep 320` 被 300s 误杀且迟到结果双吞）。1h 是回收层有界兜底档（非任务
 * 正常路径超时）：取值对齐 worktree TIMEOUT_MAX=3600 先例；>1h 的长跑命令语义上
 * 应走 agent bash 工具（不限时）而非 composer 快捷通道。
 *
 * 超时语义是「停止等待」不是「处决命令」：不自动 abort_bash，pi 侧照常执行并落盘，
 * 重开 session 可见真实结果。env 逃生门 `XYZ_RUNTIME_BASH_RPC_TIMEOUT_MS`
 * （0=不限时）读取留在 runtime rpc-client 侧，本常量是 env 未设时的默认值。
 */
export const BASH_RPC_TIMEOUT_MS = 3_600_000
