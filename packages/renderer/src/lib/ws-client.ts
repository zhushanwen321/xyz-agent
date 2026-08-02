/**
 * WebSocket 客户端 —— 连接状态机 + 心跳 + 指数退避重连 + 远程 auth 握手。
 *
 * 重建版：去掉 event-bus 依赖和消息队列（连接骨架不发送业务消息）。
 * 保留所有运行时不变量（违反必出 bug）：
 *
 * [HISTORICAL] 不变量：
 * 1. 4 态状态机：disconnected → connecting → connected（onclose → reconnecting → connecting...）
 * 2. 心跳：15s 发 ping，runtime 不回 pong 会主动断（触发重连）
 * 3. 指数退避重连：1s 起、×2、上限 30s
 * 4. generation 计数：新连接 ++generation，旧 WS 的残余回调（onopen/onclose/onmessage）
 *    检查 gen !== wsGeneration 时直接 return，不干扰新连接
 * 5. HMR 复连：import.meta.hot 保存 url，热重载后自动重连
 * 6. mock 分支：VITE_MOCK=true 走 mockConnect（不连真实 WS，状态由 mock 驱动）
 *
 * [wave1 远程化] 新增不变量（远程模式 currentAuthOpts !== null 时生效）：
 * 7. connected 语义升级（spec D2）：远程模式 connected = WS open + auth.ok，onopen 不翻转 connected，
 *    先发 auth 消息（buildAuthMessage 复用 probe.ts IF13 防漂移）+ 启动 10s auth 超时。
 * 8. intercept(msg) 拦截层（onmessage 最前）：authId 非空时消化 auth.ok/auth 失败/握手期其他消息，
 *    auth 完成后清 authId，业务消息回归 messageHandler。
 * 9. onclose 按 CloseEvent.code 分流（spec §4.2）：4001→failed(auth) 不重连、4002→failed(replaced)
 *    不重连、auth 超时标志→failed(auth) 不重连、其他→现状退避重连超限 failed(network)。
 * 10. 本地模式（currentAuthOpts === null）逐字节不变：onopen 即 connected、onclose 退避、
 *     setFailed() 时 failReason=null、isRemote=false。
 *
 * [wave2 RTT] 新增不变量（本地+远程通用，mock 不介入）：
 * 11. 心跳 ping 带 envelope 顶层 id（buildPingId = `<timestamp>-<random>`），payload 仍 {}（零协议变更，
 *     server.ts:241 broker.reply 透传 msg.id 回 pong）。ping 发送前判 pendingPingId===null（in-flight=1）。
 * 12. onmessage 收到 pong 时（intercept 放行后）：msg.id===pendingPingId → 计算 RTT=Date.now()-sentAt
 *     → push 滑动窗口（FIFO，N=20）→ 清 pending；id 不匹配 → 忽略（不报错，不进 messageHandler）。
 * 13. RTT 窗口生命周期：connect 开头 / onclose 任何分支 / disconnect 三处 resetRtt（清窗口 + pending）。
 *     getRttStats() 返回窗口快照 {min,max,avg,p50,last,count}（空窗口 count=0 其余 undefined）。
 *
 * [wave3 seq 可靠投递] 新增不变量（P2-s4 spec §6.1，远程模式 currentAuthOpts !== null 时生效）：
 * 14. 模块级 lastSeq/serverBootId/subscribedSessions 三状态（DM1，普通变量非 ref，与 currentAuthOpts 同级）：
 *     - lastSeq：最后收到的广播 seq（初始 0）。onmessage intercept 放行后、pong 之前更新（updateLastSeq
 *       守卫 seq>0 且有限才存，ERR1）。reply（auth.ok/pong）无 seq 不更新。
 *     - serverBootId：auth.ok{bootId} 返回时保存（非空字符串才存）。重连 auth 成对携带。
 *     - subscribedSessions：setSubscribedSessions 注入（去重排序），重连 auth 携带限定回放范围。
 *     三状态跨重连保留（disconnect 不清——重连需带回）；仅 seqReset/__resetForTest 清。
 * 15. onopen 远程模式发 auth 时，lastSeq>0（同页面生命周期内的重连）携带 lastSeq+bootId+subscribedSessions
 *     成对三字段（IF6，扩展 buildAuthMessage 签名）；首次连接/冷启动 lastSeq=0 不带（全量 initial state）。
 * 16. intercept 的 auth.ok 成功分支消费 P2-s2 扩展字段（IF4/DM3）：保存 bootId、serverSeq 基线对齐
 *     （>lastSeq 才更新）、seqReset=true → 清 lastSeq=0 + window.location.reload()（D6 哲学，renderer
 *     无全局 reset 能力，reload 是构造性正确路径；ERR2 守卫 typeof window）。非浏览器环境降级仅清 lastSeq。
 * 17. seqReset 静默窗口：seqReset 分支置 isReloading=true（reload 前设，新页面是新 JS 上下文自然重置），
 *     onmessage intercept 放行后（业务消息路径）检查此标志，命中静默丢弃（不 updateLastSeq、不
 *     messageHandler）。防 reload 异步窗口内残余增量广播污染即将销毁的旧 stores 触发 UI 闪烁副作用。
 *
 * 依赖方向：依赖 remote/probe（buildAuthMessage）；暴露 connect/disconnect/send/getState/onMessage
 * + failReason/isRemote 只读 ref（远程化扩展）+ getRttStats（RTT 快照）
 * + setSubscribedSessions/getSeqState（seq 状态注入与快照）。
 */
import { ref, readonly } from 'vue'
import type { Ref, DeepReadonly } from 'vue'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import { mockConnect, mockSend, mockDisconnect } from '../mock/mock-ws'
import { buildAuthMessage } from './remote/probe'

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'restarting' // runtime 崩溃，主进程正在拉起新实例（来自 IPC runtime-restarting）
  | 'failed'     // runtime 重启用尽 / 远程 auth 失败 / 被挤下线（failReason 区分来源）

/**
 * 失败原因（远程化扩展，spec §4.2）。
 * - 'auth'：远程 auth 握手失败（close 4001 或客户端 10s 超时）
 * - 'replaced'：被另一客户端挤下线（close 4002）
 * - 'network'：退避重连超限（本地 + 远程通用，对齐现状 MAX_RECONNECT 上限）
 * - null：未失败 / 本地模式 setFailed() 通用失败（兼容 useConnection runtime-failed IPC）
 */
export type FailReason = 'auth' | 'replaced' | 'network' | null

/** auth 握手参数（spec §7.4 + protocol ClientMessage.auth payload）。 */
export interface AuthOpts {
  /** 鉴权 token（明文经 WS 传输） */
  token: string
  /** 客户端唯一 ID（getClientId 惰性生成） */
  clientId: string
  /** 设备名（getDeviceName 推导） */
  deviceName?: string
}

/** connect 选项（wave1 远程化：auth opts 供远程握手）。 */
export interface ConnectOpts {
  auth?: AuthOpts
}

/**
 * RTT 统计快照（wave2 RTT）。getRttStats() 返回的窗口统计形状。
 * count 必填（0..N）；其余字段在 count===0 时为 undefined，count>0 时为有限正数（ms 单位）。
 * - min/max：窗口内最小/最大 RTT
 * - avg：算术平均
 * - p50：中位数（窗口排序后取中间）
 * - last：最新一条样本
 */
export interface RttStats {
  min?: number
  max?: number
  avg?: number
  p50?: number
  last?: number
  count: number
}

// ── 常量 ────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 15_000
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_BACKOFF_EXPONENT = 2
const MAX_RECONNECT_DELAY_MS = 30_000
/** 重连尝试上限（设计文档 A4 §3.3）：超此不再自动重连，置 failed 待用户手动重试 */
const MAX_RECONNECT_ATTEMPTS = 20
/** 重连总时长上限（ms）：超过即放弃，避免长时间无意义重试占用资源 */
const MAX_RECONNECT_DURATION_MS = 60_000
/** 远程 auth 握手超时（spec §7.5 + §4.1）：onopen 发 auth 后 10s 内未收 auth.ok → 主动 close 走 failed(auth) */
const AUTH_TIMEOUT_MS = 10_000
/** RTT 滑动窗口大小（wave2 RTT）：保留最近 N 条样本，超出 FIFO shift 最旧 */
const RTT_WINDOW_SIZE = 20

/** 服务端 close code：auth 失败（spec §7.4 / runtime ConnectionManager TC3） */
const CLOSE_CODE_AUTH_FAILURE = 4001
/** 服务端 close code：被挤下线（spec §7.4：该 clientId 在别处登录） */
const CLOSE_CODE_REPLACED = 4002

// ── 状态 ────────────────────────────────────────────────────
const state = ref<ConnectionState>('disconnected')
/**
 * 失败原因（远程化扩展）。本地模式恒 null；
 * 远程模式按 onclose 分流设置 'auth'/'replaced'/'network'。
 * 单独导出只读 ref（failReason），getState() 仍返回 readonly(state) 不破坏现有契约。
 */
const failReasonRef = ref<FailReason>(null)
/**
 * 是否远程模式（从 connect auth opts 推导）。本地模式恒 false；
 * 远程模式 connect(url,{auth}) 时置 true，disconnect 不重置（下次 connect 重新推导）。
 */
const isRemoteRef = ref<boolean>(false)

let ws: WebSocket | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
/** auth 超时定时器（远程模式 onopen 启动，auth.ok/失败/close 时清理） */
let authTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let wsGeneration = 0
let currentUrl: string | null = null
/**
 * 本轮 connect 的 auth opts（远程模式保存供重连复用，与 currentUrl/hmrUrl 同级）。
 * null = 本地模式（无 auth 握手，onopen 即 connected）。
 */
let currentAuthOpts: AuthOpts | null = null
/** 本轮重连起始时间戳（首次 scheduleReconnect 设置，connect 成功后置 null 重置） */
let reconnectStartedAt: number | null = null

/**
 * 当前 auth 握手的消息 id（onopen 发 auth 时记录，auth.ok/失败/disconnect 时清空）。
 * 非空 = 握手进行中（intercept 介入）；空 = 本地模式或 auth 已完成（intercept 放行）。
 */
let authId: string | null = null
/**
 * auth 超时标志（10s 定时器触发时置 true，主动 close 后让 onclose 走 failed(auth) 分支）。
 * onclose 优先检查此标志（超时 close 的 event.code 是 1000/1006 而非 4001，需靠标志区分）。
 */
let authTimedOut = false

/**
 * seqReset 触发的 reload 进行中标志（防 reload 完成前残余增量广播污染即将销毁的旧页面）。
 *
 * 背景：auth.ok{seqReset:true} 调 window.location.reload() 后，reload 是异步的——JS 继续
 * 执行，旧 WS 在新页面真正卸载旧页面、断开旧连接前仍存活，server 仍向其推带 seq 的增量广播。
 * 此时旧 onmessage 若继续执行（updateLastSeq + messageHandler），会把消息应用到即将销毁的旧
 * stores 上，可能触发副作用（流式计时器、审批弹窗），用户在 reload 冷启动重来前看到瞬时 UI 抖动。
 *
 * 解法：seqReset 分支在 reload 前置此标志，onmessage intercept 放行后（业务消息路径）检查它，
 * 命中则静默丢弃。新页面是新 JS 上下文，标志位自然重置（模块级变量重新初始化为 false）。
 */
let isReloading = false

// ── seq 状态（wave3 P2-s4 可靠投递）─────────────────────────
/**
 * 最后收到的广播 seq（同页面生命周期内的重连凭此回放缺失段）。
 *
 * 生命周期（DM1）：
 * - 初始 0（首次连接/冷启动不带，走全量 initial state）。
 * - onmessage 每条带 seq 的广播消息更新（intercept 放行后、pong 之前；取最后一条即最大值，
 *   因 seq 全局单调递增）。reply（auth.ok/pong）无 seq 不更新。
 * - auth.ok{serverSeq:N} 基线对齐：N>lastSeq 时更新（auth 后基线对齐）。
 * - auth.ok{seqReset:true} → 清 0（防 reload 前残余）。
 * - 跨重连保留（disconnect 不清——重连需带回）；仅 seqReset/__resetForTest 清。
 * 非持久化（spec D5：localStorage 有害，reload 后 stores 全空带旧 lastSeq 得残缺状态）。
 */
let lastSeq: number = 0
/**
 * 服务端 bootId（auth.ok 返回，重连同页面生命周期判定）。
 * 初始 null；auth.ok{bootId:'b1'} 保存；重连 auth 携带 lastSeq+bootId 成对。
 * server 侧 connection-manager 比对 bootId 不一致 → 回 seqReset=true（P2-s2 ERR3）。
 */
let serverBootId: string | null = null
/**
 * 当前已订阅 session id 列表（useConnection 经 setSubscribedSessions 注入，IF1）。
 * 重连 auth 携带此列表限定 server 回放范围（只回放订阅 session 的增量，P2 FC2）。
 * setter 内部去重 + 排序保证幂等。空数组合法（无订阅）。本地模式不被 auth 消费。
 */
let subscribedSessions: string[] = []

// ── RTT 状态（wave2）────────────────────────────────────────
/**
 * RTT 滑动窗口（最近 RTT_WINDOW_SIZE 条样本，ms）。普通数组非 ref（getRttStats 计算快照，无需响应式）。
 * connect/onclose/disconnect 时 resetRtt 清空。
 */
let rttWindow: number[] = []
/**
 * 当前 in-flight ping 的 id（in-flight=1：同一时刻最多一个未配对的 ping）。
 * startHeartbeat 发 ping 前判 null 才发；recordRtt 配对成功后清空。
 */
let pendingPingId: string | null = null
/** 当前 in-flight ping 的发送时间戳（Date.now()），配对 pong 后计算 RTT=Date.now()-pendingPingSentAt */
let pendingPingSentAt: number | null = null

// Vite HMR：热重载前保存 url，重载后自动重连
let hmrUrl = (import.meta.hot?.data as { wsUrl?: string } | undefined)?.wsUrl ?? null

const isMock = import.meta.env.VITE_MOCK === 'true'

/** 消息回调（连接骨架阶段不注册；后续业务层注册处理 ServerMessage） */
let messageHandler: ((msg: ServerMessage) => void) | null = null

/** 注册消息回调，返回取消函数 */
export function onMessage(cb: (msg: ServerMessage) => void): () => void {
  messageHandler = cb
  return () => {
    if (messageHandler === cb) messageHandler = null
  }
}

/** 连接状态（只读 ref，供 UI 消费） */
export function getState(): DeepReadonly<Ref<ConnectionState>> {
  return readonly(state)
}

/** 失败原因（远程化扩展，只读 ref）。本地模式恒 null。 */
export function getFailReason(): DeepReadonly<Ref<FailReason>> {
  return readonly(failReasonRef)
}

/** 是否远程模式（只读 ref，从 connect auth opts 推导）。 */
export function getIsRemote(): DeepReadonly<Ref<boolean>> {
  return readonly(isRemoteRef)
}

/**
 * 返回当前 RTT 滑动窗口统计快照（wave2 RTT）。
 *
 * 计算 min/max/avg/p50/last/count（窗口空时 count=0 其余 undefined）。
 * 非响应式——UI（Landing 状态条）轮询消费；窗口数据存模块级普通数组（无需触发响应式）。
 */
export function getRttStats(): RttStats {
  const n = rttWindow.length
  if (n === 0) return { count: 0 }
  let min = rttWindow[0]!
  let max = rttWindow[0]!
  let sum = 0
  for (const v of rttWindow) {
    if (v < min) min = v
    if (v > max) max = v
    sum += v
  }
  const sorted = [...rttWindow].sort((a, b) => a - b)
  // eslint-disable-next-line no-magic-numbers -- 中位数索引：n 个样本排序后取中间（除 2）
  const p50 = sorted[Math.floor((n - 1) / 2)]!
  return {
    min,
    max,
    avg: sum / n,
    p50,
    last: rttWindow[n - 1],
    count: n,
  }
}

/**
 * 注入当前已订阅的 session id 列表（wave3 P2-s4 IF1）。
 *
 * useConnection 在 session 创建/attach/删除/detach 时调用，把当前已订阅的 session id 列表
 * 注入 ws-client。重连时 auth 消息携带此列表（限定 server 回放范围，只回放订阅 session 的增量）。
 *
 * - 内部去重 + 排序保证幂等（重复调用同值无副作用）。
 * - 空数组合法（无订阅）。
 * - 本地模式（currentAuthOpts===null）调用无副作用（值不被 auth 消费，但保存供切远程模式后用）。
 */
export function setSubscribedSessions(sessionIds: string[]): void {
  // 去重 + 排序保证幂等（Set 去重 + localeCompare 稳定排序）
  subscribedSessions = Array.from(new Set(sessionIds)).sort((a, b) => a.localeCompare(b))
}

/**
 * 返回当前 seq 状态快照（wave3 P2-s4，仅测试用）。
 *
 * 模块级 lastSeq/serverBootId/subscribedSessions 无响应式需求（仅 ws-client 内部消费），
 * 但单测（TC18/TC21/TC25）需断言其值——故暴露只读快照。
 *
 * @internal 仅测试用，生产代码不应消费。
 */
export function getSeqState(): {
  lastSeq: number
  serverBootId: string | null
  subscribedSessions: string[]
  } {
  return {
    lastSeq,
    serverBootId,
    subscribedSessions: [...subscribedSessions],
  }
}

/**
 * 设置为 restarting 态（收到 IPC runtime-restarting 时调，useConnection 编排）。
 * 断开当前 WS（死端口）并停止自动重连——等主进程拉起新实例后推新端口再 connect。
 */
export function setRestarting(): void {
  if (isMock) return
  disconnect() // 停止在死端口上的自动重连，避免与 restarting 状态打架
  state.value = 'restarting'
}

/**
 * 设置为 failed 态（wave1 改签名接可选 failReason）。
 *
 * - `failReason === undefined`：兼容现有 useConnection setFailed() 无参调用（runtime-failed IPC），
 *   failReason 保持当前值（通常 null），语义同现状。
 * - `failReason` 有值：远程模式失败分流（'auth'/'replaced'/'network'），写 failReasonRef + state='failed'。
 *
 * 停止自动重连（clearTimers），等用户手动重试。
 */
export function setFailed(failReason?: Exclude<FailReason, null>): void {
  if (isMock) return
  clearTimers()
  if (failReason !== undefined) {
    failReasonRef.value = failReason
  }
  state.value = 'failed'
}

/** 建立连接（已连接/连接中时幂等 no-op）。wave1 远程化：opts.auth 触发远程握手分支。 */
export function connect(url: string, opts?: ConnectOpts): void {
  currentUrl = url
  // 推导远程模式 + 保存 auth opts 供重连复用：
  // 仅当显式传 opts 时更新 currentAuthOpts；重连（scheduleReconnect → connect(url) 无 opts）
  // 复用首次 connect 存的 currentAuthOpts，避免重连退化为本地模式（plan R3）。
  if (opts !== undefined) {
    currentAuthOpts = opts.auth ?? null
  }
  isRemoteRef.value = currentAuthOpts !== null

  if (isMock) {
    mockConnect(
      (s) => { state.value = s },
      (msg) => { messageHandler?.(msg) },
    )
    return
  }

  // 保存 url 供 HMR 复连
  hmrUrl = url

  // 幂等：已连接或连接中，不重复建连
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  state.value = 'connecting'
  const gen = ++wsGeneration
  // 新连接前清 auth 握手状态（防止上一轮残余）
  authId = null
  authTimedOut = false
  // 新连接前清 RTT 窗口（重连后网络条件可能不同，旧样本无参考价值；in-flight ping 永远收不到 pong）
  resetRtt()
  ws = new WebSocket(url)
  console.log('[ws] connecting to', url, currentAuthOpts ? '(remote auth)' : '(local)')

  ws.onopen = () => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，忽略
    if (currentAuthOpts !== null) {
      // ── 远程模式：onopen 发 auth + 启动超时，不翻转 connected（spec D2）──
      // wave3 P2-s4 IF6：lastSeq>0（同页面生命周期内的重连）时携带 lastSeq+bootId+subscribedSessions
      // 成对三字段（限定 server 回放范围）；首次连接/冷启动 lastSeq=0 不带（全量 initial state）。
      const authMsg = buildAuthMessage({
        ...currentAuthOpts,
        ...(lastSeq > 0
          ? { lastSeq, bootId: serverBootId ?? undefined, subscribedSessions }
          : {}),
      })
      authId = authMsg.id
      authTimedOut = false
      try {
        ws?.send(JSON.stringify(authMsg))
      // eslint-disable-next-line taste/no-silent-catch -- onopen→close 竞态下 send 抛 InvalidStateError，留给 onclose 接管
      } catch (e) {
        console.error('[ws] send auth failed:', e)
      }
      // 10s auth 超时：设标志后主动 close，让 onclose 统一走 failed(auth)（spec §7.5）
      authTimer = setTimeout(() => {
        if (gen !== wsGeneration) return
        authTimedOut = true
        console.warn('[ws] auth timeout, closing')
        try {
          ws?.close()
        // eslint-disable-next-line taste/no-silent-catch -- close 抛（已 close）吞掉，onclose 会接管或已触发
        } catch {
          // 吞 close 异常
        }
      }, AUTH_TIMEOUT_MS)
    } else {
      // ── 本地模式：现状逐字节不变，onopen 即 connected ──
      // CR-fix WARNING3：connected 翻转时重置 failReasonRef——防 failed 态残留 failReason 泄漏
      // （本地模式 failReason 恒 null，但 failed→connected 循环时旧值可能残留）。
      failReasonRef.value = null
      state.value = 'connected'
      reconnectAttempts = 0
      // 连接成功 → 重置重连计时窗口（下次掉线重新开始计数）
      reconnectStartedAt = null
      startHeartbeat()
    }
  }

  ws.onmessage = (event) => {
    if (gen !== wsGeneration) return
    try {
      const msg = JSON.parse(event.data) as ServerMessage
      // intercept 优先：远程模式 auth 握手期消化 auth 回复 + 丢弃握手期业务消息
      if (intercept(msg)) return
      // seqReset 触发的 reload 进行中：旧 WS 仍连、server 仍在推增量广播，但旧页面即将销毁——
      // 静默丢弃这些残余消息，避免应用到即将销毁的 stores 触发副作用（reload 后冷启动重来）。
      // 新页面是新 JS 上下文，isReloading 自然重置为 false。
      if (isReloading) return
      // seq 断点更新（wave3 P2-s4 IF3）：intercept 放行后（auth 已完成或本地模式），
      // 在 pong RTT 配对之前更新 lastSeq。reply（auth.ok/pong）无 seq（undefined）不更新。
      // 业务广播消息带 seq → lastSeq 取最后一条（全局单调递增即最大值）。
      updateLastSeq(msg.seq)
      // RTT 配对（auth 已完成或本地模式）：pong 是传输层 reply，统一在 RTT 层消化不进 messageHandler。
      // id 匹配 pending ping → 记录 RTT；id 不匹配（stray/broadcast pong）→ 忽略。
      if (msg.type === ('pong' as ServerMessage['type'])) {
        recordRtt(msg.id)
        return
      }
      messageHandler?.(msg)
    // eslint-disable-next-line taste/no-silent-catch -- 非 JSON 消息解析失败，跳过
    } catch (e) {
      console.error('[ws] parse error:', e)
    }
  }

  ws.onclose = (event: CloseEvent) => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，不干扰新连接
    stopHeartbeat()
    clearAuthTimer()
    // 清 RTT 窗口（覆盖所有 close 分支：4001/4002/auth 超时/退避。重连后从 0 重新积累）
    resetRtt()
    // ── 远程模式失败分流（spec §4.2）：4001/4002/超时不重连，直接 failed ──
    if (event.code === CLOSE_CODE_AUTH_FAILURE) {
      console.warn('[ws] closed by server: auth failure (4001)')
      setFailed('auth')
      return
    }
    if (event.code === CLOSE_CODE_REPLACED) {
      console.warn('[ws] closed by server: replaced (4002)')
      setFailed('replaced')
      return
    }
    if (authTimedOut) {
      // 客户端 auth 超时主动 close（event.code 通常是 1000/1006），走 failed(auth)（D11 统一收口）
      console.warn('[ws] closed after auth timeout')
      setFailed('auth')
      return
    }
    // ── 其他 close code（含本地模式）：现状退避重连，超限 failed(network) ──
    authId = null
    state.value = 'disconnected'
    scheduleReconnect()
  }

  ws.onerror = (err) => {
    console.error('[ws] error:', err)
    ws?.close()
  }
}

/** 主动断开（不触发重连） */
export function disconnect(): void {
  if (isMock) {
    mockDisconnect()
    state.value = 'disconnected'
    return
  }
  // 递增 generation 使旧 WS 的回调失效
  wsGeneration++
  clearTimers()
  // 清 auth 握手状态（防止残余 intercept 介入下次连接）
  authId = null
  authTimedOut = false
  // 清 RTT 窗口（主动断开，in-flight ping 永远收不到 pong）
  resetRtt()
  if (ws) {
    // 先摘回调再 close，避免触发 onclose → scheduleReconnect
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws.close()
    ws = null
  }
  state.value = 'disconnected'
}

/**
 * 发送消息（W4：返回 boolean，让调用方 fast-fail）。
 *
 * 返回契约：
 * - readyState=OPEN → 实际发送，返回 true（已发送确认）
 * - readyState≠OPEN（CONNECTING/CLOSED）→ 不发送，返回 false（调用方可立即 reject / 重试）
 *
 * mock 模式：mock 始终「可发送」，返回 true（mockSend 不抛即视为发送成功）。
 * 透传 mockSend 返回值以支持测试桩精确控制（mockSend 返回 boolean 时以它为准）。
 */
export function send(msg: ClientMessage): boolean {
  if (isMock) {
    const ret = mockSend(msg)
    // mockSend 桩默认返回 undefined（视为发送成功 → true）；测试桩可返回 boolean 精确控制
    return typeof ret === 'boolean' ? ret : true
  }
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
    return true
  }
  return false
}

/**
 * 重置模块级状态（仅测试用，模拟「新模块实例」）。
 *
 * ws-client 是单例——state/failReasonRef/isRemoteRef 等 ref + currentUrl/currentAuthOpts/authId
 * 等模块级变量在单测间会残留（disconnect 只复位连接态，不复位 failReason）。多用例测试需在
 * beforeEach 调此函数清空，确保用例隔离（与 connection-config.__resetForTest 同模式）。
 *
 * @internal
 */
export function __resetForTest(): void {
  state.value = 'disconnected'
  failReasonRef.value = null
  isRemoteRef.value = false
  reconnectAttempts = 0
  wsGeneration = 0
  currentUrl = null
  currentAuthOpts = null
  reconnectStartedAt = null
  authId = null
  authTimedOut = false
  // wave3 P2-s4：复位 seq 状态（与 RTT 窗口同级，保证用例隔离）
  lastSeq = 0
  serverBootId = null
  subscribedSessions = []
  // 复位 reload 标志（防上一用例的 seqReset 残余标志污染下一用例的 onmessage）
  isReloading = false
  resetRtt()
  clearTimers()
  if (ws) {
    // 摘回调避免触发 onclose 干扰重置后的状态
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws = null
  }
}

// ── 内部 ────────────────────────────────────────────────────

/**
 * 更新 lastSeq 断点（wave3 P2-s4 IF3/ERR1）。
 *
 * onmessage intercept 放行后调用（auth 已完成或本地模式）。守卫：
 * - typeof seq==='number' && seq>0 && Number.isFinite(seq) → 更新 lastSeq=max(lastSeq, seq)
 * - 否则（undefined/0/负数/NaN/非数字）→ 忽略（ERR1 降级，畸形 seq 不污染断点）
 *
 * C2 修复（review CRITICAL）：取 max 而非直接覆盖。replay 段（seq 101-150）在 auth.ok
 * 基线对齐（lastSeq 抬到 serverSeq 如 150）之后到达——若直接覆盖，每条 replay 把 lastSeq
 * 回退成更小值（如 101），下次重连带回远低于实际水位 → 触发超大 replay → 非幂等 chat effect
 * 重复气泡。取 max 与 serverSeq 守卫（intercept 内 p.serverSeq > lastSeq）口径一致，保证单调递增。
 * reply（auth.ok/pong）无 seq 不更新。
 */
function updateLastSeq(seq: number | undefined): void {
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq <= 0) return
  lastSeq = Math.max(lastSeq, seq)
}

/**
 * 拦截 auth 握手消息（远程模式 onmessage 最前调用，返回 true=消化不进 messageHandler）。
 *
 * 三态逻辑（spec D12）：
 * 1. authId 非空 + msg.id===authId：
 *    - type==='auth.ok' → 清 auth 超时 + 翻转 connected + 重置 reconnectAttempts + 清 authId + startHeartbeat（return true 消化）
 *    - 其他（type:'error' / 非预期 auth reply）→ 视为 auth 失败：设 authTimedOut 标志 + ws.close 触发 onclose→failed(auth)（return true）
 * 2. authId 非空 + msg.id!==authId（auth 完成前的握手期业务消息）→ warn + return true 丢弃（防止污染状态）
 * 3. authId 为空（本地模式或 auth 已完成）→ return false，走 messageHandler
 */
function intercept(msg: ServerMessage): boolean {
  if (authId === null) return false // 本地模式或 auth 已完成，放行
  if (msg.id === authId) {
    if (msg.type === ('auth.ok' as ServerMessage['type'])) {
      // auth 成功：清超时 + 翻转 connected（spec D2：connected = WS open + auth.ok）
      clearAuthTimer()
      authId = null
      // wave3 P2-s4 DM3/IF4：消费 auth.ok payload 的 bootId/serverSeq/seqReset（P2-s2 已交付字段）
      const p = msg.payload as {
        bootId?: string
        serverSeq?: number
        seqReset?: boolean
        // P5 presence：auth.ok 顺带带 presence 全量列表（spec D10）。
        presence?: unknown[]
      }
      // seqReset：server 判定不可回放（bootId 不一致或 lastSeq<evictedWatermark）→ 清 lastSeq + reload。
      // CR-fix BLOCKER2：必须最先判 + 提前 return true——reload 是异步的（JS 继续执行），若放在
      // presence 合成 + state 翻转之后，会多做无用功（presence 合成喂给即将销毁的页面）+ 触发
      // state.value='connected' → useConnection watch → onConnected 多余 IO。提前 return 跳过后续副作用。
      if (p.seqReset === true) {
        // 先清 lastSeq=0（防 reload 前残余 onmessage 写回旧值，DM3 不变量）
        lastSeq = 0
        // 标记 reload 进行中：reload 是异步的，旧 WS 在新页面卸载前仍存活、server 仍推增量广播。
        // onmessage intercept 放行后检查此标志，命中静默丢弃（见 ws.onmessage）。
        isReloading = true
        console.warn('[ws] seqReset received, reloading page for full resync')
        // ERR2 守卫：非浏览器环境（SSR/无 location）降级为仅清 lastSeq 不 reload
        if (
          typeof window !== 'undefined' &&
          typeof window.location !== 'undefined' &&
          typeof window.location.reload === 'function'
        ) {
          window.location.reload()
        } else {
          console.error('[ws] seqReset received but location.reload unavailable')
        }
        return true
      }
      // P5 presence：auth.ok 带 presence 时，合成 presence.update 喂给 messageHandler（routeInbound）。
      // auth.ok 本身被 intercept 消化（return true）不进 routeInbound，故 presence 经此合成消息
      // 进入全局通道，让 useConnection/presence store 消费（与 presence.update 同一处理路径）。
      // presence 缺省（旧 runtime / 未启用）时不合成，零回归。
      if (Array.isArray(p.presence) && messageHandler) {
        messageHandler({ type: 'presence.update', payload: { connections: p.presence } } as ServerMessage)
      }
      // 保存 bootId（供下次重连同页面生命周期携带，非空字符串才存）
      if (typeof p.bootId === 'string' && p.bootId !== '') {
        serverBootId = p.bootId
      }
      // 基线对齐：serverSeq > lastSeq 时更新（auth 后基线对齐，避免第一条广播 seq 被误判乱序）
      if (typeof p.serverSeq === 'number' && p.serverSeq > lastSeq) {
        lastSeq = p.serverSeq
      }
      // CR-fix WARNING3：connected 翻转时重置 failReasonRef——防 failed 态残留的 failReason
      // （如远程 'auth'）泄漏到本次 connected。下次 failed 若调用方传 undefined（如本地 IPC
      // runtime-failed），旧值会误导 App.vue 分化 UI（本地 runtime-failed 误显远程 auth/replaced）。
      failReasonRef.value = null
      state.value = 'connected'
      reconnectAttempts = 0
      reconnectStartedAt = null
      startHeartbeat()
      console.log('[ws] auth ok, connected')
      return true
    }
    // id 匹配但非 auth.ok（如 type:'error'）→ 视为 auth 失败，close 触发 onclose→failed(auth)
    console.warn('[ws] auth failed (non-ok reply), closing:', msg.type)
    authTimedOut = true
    try {
      ws?.close()
    // eslint-disable-next-line taste/no-silent-catch -- close 抛（已 close）吞掉，onclose 接管
    } catch {
      // 吞 close 异常
    }
    return true
  }
  // authId 非空但 id 不匹配：握手期收到业务消息，丢弃 + warn（不进 messageHandler）
  console.warn('[ws] message before auth ok, dropping:', msg.type, msg.id)
  return true
}

function scheduleReconnect(): void {
  if (!currentUrl) return
  // 重连上限兜底（设计文档 A4 §3.3）：尝试次数或总时长超限 → 放弃自动重连，置 failed(network)
  if (reconnectStartedAt === null) reconnectStartedAt = Date.now()
  if (
    reconnectAttempts >= MAX_RECONNECT_ATTEMPTS ||
    Date.now() - reconnectStartedAt > MAX_RECONNECT_DURATION_MS
  ) {
    console.warn('[ws] reconnect attempts exhausted, giving up (state=failed, reason=network)')
    setFailed('network')
    return
  }
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(RECONNECT_BACKOFF_EXPONENT, reconnectAttempts),
    MAX_RECONNECT_DELAY_MS,
  )
  reconnectAttempts++
  state.value = 'reconnecting'
  console.log('[ws] reconnecting in', delay, 'ms (attempt', reconnectAttempts + ')')
  reconnectTimer = setTimeout(() => {
    // 重连时 opts 为 undefined，connect 内部从 currentAuthOpts 读（已保存供复用）
    connect(currentUrl!)
  }, delay)
}

function startHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return
    // in-flight=1：上一条 ping 的 pong 还没回来则 skip 本轮（不覆盖 sentAt，保证样本语义干净）
    if (pendingPingId !== null) return
    const id = buildPingId()
    pendingPingId = id
    pendingPingSentAt = Date.now()
    send({ type: 'ping', id, payload: {} })
  }, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function clearAuthTimer(): void {
  if (authTimer) {
    clearTimeout(authTimer)
    authTimer = null
  }
}

// ── RTT 内部（wave2）────────────────────────────────────────

/**
 * 生成 ping id（`<timestamp>-<random>`）。
 * timestamp 前缀便于 debug 排序，random 后缀防同毫秒冲突（心跳 15s 间隔几乎不可能，兜底）。
 */
function buildPingId(): string {
  // eslint-disable-next-line no-magic-numbers -- base36 编码 + slice(2,8) 去 '0.' 前缀取 6 位随机尾
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 配对 pong 与 pending ping，记录 RTT 样本（onmessage 收到 pong 时调）。
 *
 * @param id 收到的 pong 的 envelope id
 * @returns true=配对成功已记录 RTT（消化不进 messageHandler）/ false=id 不匹配或无 pending（忽略）
 *
 * 配对成功：RTT=Date.now()-pendingPingSentAt → push 窗口（FIFO 截断 N）→ 清 pending。
 * id 不匹配：忽略（runtime 可能广播或延迟的旧 pong），不报错不污染窗口。
 */
function recordRtt(id: string | undefined): boolean {
  if (pendingPingId === null || pendingPingSentAt === null) return false
  if (id !== pendingPingId) return false
  const rtt = Date.now() - pendingPingSentAt
  rttWindow.push(rtt)
  // FIFO 截断：超出窗口大小丢弃最旧
  if (rttWindow.length > RTT_WINDOW_SIZE) rttWindow.shift()
  pendingPingId = null
  pendingPingSentAt = null
  return true
}

/** 清空 RTT 窗口 + pending ping 状态（connect/onclose/disconnect 调用）。 */
function resetRtt(): void {
  rttWindow = []
  pendingPingId = null
  pendingPingSentAt = null
}

function clearTimers(): void {
  stopHeartbeat()
  clearAuthTimer()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

// ── Vite HMR：热重载后自动重连 ──────────────────────────────
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // 保存 url 给新模块实例
    if (hmrUrl) {
      ;(import.meta.hot!.data as Record<string, unknown>).wsUrl = hmrUrl
    }
    // 关闭旧 WS，让新实例重连
    if (ws) {
      const old = ws
      ws = null
      old.onclose = null
      old.onerror = null
      old.onmessage = null
      old.close()
    }
    clearTimers()
  })

  // 热重载后若曾有 url，自动重连
  if (hmrUrl) {
    connect(hmrUrl)
  }
}
