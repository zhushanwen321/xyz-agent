/**
 * useMemoryPressure —— runtime 内存看门狗通知消费（crash-forensics-and-watchdog.md
 * §3.3 D4，实施单元 u6）。
 *
 * 通道归属（D4 原文）：runtime 看门狗 → WS 广播（watchdog:memoryPressure）→ 本 composable
 * 消费——memory-relief 降级的 renderer 半边：收到 warn 及以上 → 收紧 renderer 侧 LRU 缓存。
 * 目标对象 = chat store 的 messages 分区 LRU（core lru.ts，LRU_MAX_SESSIONS 窗口内的
 * messages/hydrated 均为可重建缓存——驱逐重进走 hydrate 全量重放，用户无感，代价是切回
 * 延迟；与 D4「可回收物全部自动重建」语义一致）。
 *
 * [领地登记] 「收紧」的完整语义 = 运行时把保留窗口从 LRU_MAX_SESSIONS(8) 压到更小档，
 * 需要 core/domain/chat/lru.ts 暴露可变上限 API（当前为编译期常量，领地外）。本文件
 * 当前最大安全动作 = 默认 reliefAction 调 chat store 公开 evictIfNeeded()（按既有 8 上限
 * 执行一轮驱逐，幂等；压力持续期 runtime 每采样拍重发通知 → 每拍都有驱逐机会）。真实
 * 收紧 API 交付后仅需替换 reliefAction 默认实现，消费通道（本文件其余部分）不变。
 *
 * 状态形态：窗口级单例（非 per-session）——内存压力是全局信号，与 useCrashRecoveryNotice
 * 同款「窗口级单例状态，ADR-0049 Map 分区范式不适用」判定（无 sidRef、无 per-session
 * 分区，useSessionScopedState 的 setup-scoped 工厂契约不成立）。
 *
 * 订阅防重复（AGENTS 关键规则 2）：模块级 refCount——多实例（split mode）共享单条物理
 * events.onGlobalType 订阅，首个消费者注册、最后一个卸载时退订（useAppUpdate 同款范式）。
 */
import { ref, shallowRef, onScopeDispose, type Ref } from 'vue'
import * as events from '@xyz-agent/core/transport/api'
import type { WatchdogMemoryLevel, WatchdogMemoryPressurePayload } from '@xyz-agent/shared'
import { useChatStore } from '@/stores/chat'

/** 压力级别（含消费侧常态 'normal'——协议只在越线时广播，缺省态即 normal）。 */
export type MemoryPressureLevel = 'normal' | WatchdogMemoryLevel

/**
 * memory-relief 收紧动作签名（level + 完整 payload 透传，供未来分档收紧策略使用）。
 * 动作实现须自捕获异常（best-effort：降级动作失败不得放大为消费链故障）。
 */
export type MemoryReliefAction = (level: MemoryPressureLevel, payload: WatchdogMemoryPressurePayload) => void

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：内存压力级别（窗口级全局观测态）
const level = ref<MemoryPressureLevel>('normal')
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：最近一拍通知快照（观测面，payload 原样透传）
const lastPayload = shallowRef<WatchdogMemoryPressurePayload | null>(null)

/** 订阅引用计数（useAppUpdate 同款：多消费者共享单条物理订阅）。 */
let refCount = 0
/** 物理退订函数（null = 当前无订阅）。 */
let unsubscribe: (() => void) | null = null

/**
 * 收紧动作（可注入：测试 spy / 未来真实「可变上限收紧」API 的替换点）。
 * 默认实现见 defaultReliefAction 注释（领地登记）。
 */
let reliefAction: MemoryReliefAction = defaultReliefAction

/** 默认收紧动作：chat store 公开 evictIfNeeded（既有 8 上限内执行一轮驱逐，幂等）。 */
function defaultReliefAction(): void {
  try {
    useChatStore().evictIfNeeded()
  } catch (e) {
    // best-effort：pinia 未就绪（极端早到通知）/ store 异常时降级为静默——renderer 侧
    // 收紧失败不影响 runtime 侧降级链（台账与滚动重启决策都在 runtime）。
    console.warn('[useMemoryPressure] memory-relief action failed; skipped this tick:', e)
  }
}

function applyPayload(payload: WatchdogMemoryPressurePayload): void {
  level.value = payload.level
  lastPayload.value = payload
  try {
    reliefAction(payload.level, payload)
  } catch (e) {
    // 双保险：注入动作未自捕获时也不让异常逃出订阅链（events 层 safeForEach 会兜，
    // 本层先兜使语义不依赖分发器实现细节）。
    console.warn('[useMemoryPressure] relief action threw; suppressed:', e)
  }
}

function ensureSubscribed(): void {
  if (unsubscribe !== null) return
  unsubscribe = events.onGlobalType('watchdog:memoryPressure', (msg) => {
    applyPayload(msg.payload)
  })
}

function releaseSubscription(): void {
  unsubscribe?.()
  unsubscribe = null
}

/**
 * 消费内存看门狗通知（窗口级单例状态 + refCount 订阅，任意组件可调用）。
 *
 * 返回共享的模块级 ref（多实例读同一状态，无 per-instance 拷贝）。
 */
export function useMemoryPressure(): {
  level: Ref<MemoryPressureLevel>
  lastPayload: Ref<WatchdogMemoryPressurePayload | null>
  } {
  refCount++
  ensureSubscribed()
  onScopeDispose(() => {
    refCount--
    if (refCount <= 0) {
      refCount = 0
      releaseSubscription()
    }
  })
  return { level, lastPayload }
}

/** 测试钩子：注入收紧动作 spy（null 复位默认动作）。生产代码禁用。 */
export function _setMemoryReliefActionForTest(action: MemoryReliefAction | null): void {
  reliefAction = action ?? defaultReliefAction
}

/** 测试钩子：复位模块级状态 + 强制退订（对齐 _resetXxxForTest 模式）。 */
export function _resetMemoryPressureForTest(): void {
  refCount = 0
  releaseSubscription()
  level.value = 'normal'
  lastPayload.value = null
  reliefAction = defaultReliefAction
}
