/**
 * terminal-reconnect-signal —— WS 重连全局信号（wave3 P2-s4，spec §6.3）。
 *
 * 设计动机：useConnection（全局单例）需在 WS 重连成功时通知 useTerminal（per-instance，
 * 每个 TerminalView 调一次 useTerminal 各自维护独立 scrollback 分区）清 scrollback，
 * 防止断线前本地缓冲与重连后 server 全量回灌重复显示。但 useConnection 无 useTerminal
 * 实例引用（per-instance），反向依赖会破坏分层。
 *
 * 解法：极简全局信号模块（模块级 ref 计数器）：
 * - useConnection 重连成功（getState 从非 connected 翻回 connected）调 bumpReconnectEpoch()++；
 * - 每个 useTerminal 实例 setup 内 watch(useReconnectEpoch(), () => clearScrollback(当前 sid))，
 *   信号变化时各自清自己的当前 sid 分区 scrollback。
 *
 * 为何不用全局 store 承载 scrollback：ADR-0036 明确 scrollback 是 per-instance 视图状态
 * （TerminalView 独有），提升到全局 store 破坏 session 隔离设计。信号模块只广播「该清了」，
 * 清的是哪个分区由各实例自己读 sessionIdRef 决定——保持 per-instance 隔离 + 跨实例广播解耦。
 *
 * 依赖方向：零依赖（仅 vue ref/readonly）；被 useConnection（bump）+ useTerminal（watch）消费。
 */
import { ref, readonly } from 'vue'
import type { Ref, DeepReadonly } from 'vue'

/**
 * 全局重连信号计数器（模块级单例 ref）。
 * - 初始 0；每次 bumpReconnectEpoch() 自增。
 * - useTerminal 各实例 watch 此 ref，变化时清当前 sid 分区 scrollback。
 * 非响应式消费场景不存在——仅 Vue watch 依赖。
 */
const reconnectEpoch = ref<number>(0)

/**
 * 触发重连信号（reconnectEpoch 自增，唤醒所有 watch）。
 *
 * 调用点：useConnection 的 watch(getState()) 检测到重连成功
 * （oldState 非 connected 且非首次 connecting → newState === connected）时调。
 */
export function bumpReconnectEpoch(): void {
  reconnectEpoch.value++
}

/**
 * 读取重连信号（只读 ref，供 useTerminal watch 建立响应式依赖）。
 *
 * @returns 只读 ref，value 是递增的 epoch 计数器（初始 0）
 */
export function useReconnectEpoch(): DeepReadonly<Ref<number>> {
  return readonly(reconnectEpoch)
}
