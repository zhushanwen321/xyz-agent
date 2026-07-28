/**
 * probe —— WS 连接探测模块（P1-s1-w2 / spec §7.4 / §7.5）。
 *
 * 设计决策（spec §7.4 / §7.5 + D6 + IF13/IF14/IF15 + DM5/DM6）：
 * - **探测不自动连**（spec D6 安全约束）：probeConnection / probeOnline 内部 `new WebSocket(url)`
 *   创建临时局部实例，所有返回路径 try/finally 强制 close，绝不调用 ws-client.connect。
 * - **副作用隔离**（spec §7.5）：探测全程不写 localStorage（不落 connection-mode / active-server-id /
 *   remote-servers），不触发任何全局连接副作用——仅读 getClientId()/getDeviceName()。
 * - **token 空短路**（DM6）：probeConnection 收到空 token 直接 resolve {ok:false,error:'auth'}，
 *   不构造 WebSocket、不发 auth（避免无谓请求 + 防止误把空 token 当 open-mode 直连）。
 * - **错误归一**（与 ws-client onclose 分支一致 spec §4.2）：close code 4001 → 'auth'；其余
 *   （4002 replaced / 1006 / 1011 / onerror / 超时）按 DM6 三态归一为 'auth' | 'network' | 'timeout'。
 *   注：spec §7.4 区分了 auth（4001）/ replaced（4002，UI 单独提示「该 ID 在别处登录」），但
 *   DM6 的 ProbeConnectResult 只暴露三态 error 联合——故 4002 在 probe 层归一为 'network'，
 *   真正的「被挤下线」语义交给正式 connect 后的 ws-client onclose 处理（probe 仅握手预检）。
 * - **超时**：setTimeout + Promise.race（不依赖 ws-client 的重连退避），超时后立即 close WS。
 *
 * 与 ws-client 的边界：probe 不 import ws-client（ws-client 是单例，import 会触发 HMR 复连副作用），
 * auth 消息构造用本地纯函数 buildAuthMessage（与 T2 ws-client 共用此函数防漂移，spec IF13）。
 *
 * 依赖方向：依赖 connection-config（getClientId/getDeviceName 仅读不写）；无下游（被
 * RemoteConnectModal 探测按钮 / useConnection 预检 等消费）。
 */
import { getClientId, getDeviceName } from './connection-config'

// ── 常量 ───────────────────────────────────────────────────────────

/** probeConnection 默认超时（spec §7.5 / §4.1） */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000
/** probeOnline 默认超时（spec §7.4） */
const DEFAULT_PROBE_ONLINE_TIMEOUT_MS = 3_000

/** 服务端 close code：认证失败（spec §7.4 / runtime ConnectionManager TC3） */
const CLOSE_CODE_AUTH_FAILURE = 4001

// ── 类型 ───────────────────────────────────────────────────────────

/** auth 消息 payload（spec §7.4 + protocol ClientMessageMap.auth）。 */
export interface AuthPayload {
  /** 鉴权 token（明文经 WS 传输，与 ws-client 一致） */
  token: string
  /** 客户端唯一 ID（getClientId 惰性生成） */
  clientId: string
  /** 设备名（getDeviceName 推导） */
  deviceName?: string
  /**
   * 已确认消息序号（断线续传用）。
   * probe 是握手预检，不带 lastSeq（undefined，spec D10 + IF13）；
   * ws-client 正式 connect 时若 lastSeq>0（同页面生命周期内的重连）才携带（P2-s4 IF6）。
   */
  lastSeq?: number
  /**
   * 服务端 bootId（与 lastSeq 成对，同页面生命周期重连同 server 判定，P2-s4 DM2）。
   * probe 不带；ws-client 重连时 lastSeq>0 才携带。来自上一次 auth.ok 的 bootId。
   */
  bootId?: string
  /**
   * 已订阅 session id 列表（限定 server 回放范围，P2-s4 DM2/IF1）。
   * probe 不带；ws-client 重连时 lastSeq>0 才携带。由 useConnection 经 setSubscribedSessions 注入。
   */
  subscribedSessions?: string[]
}

/**
 * probeConnection 返回（DM6 三态联合）。
 *
 * - ok=true：握手成功，serverVersion 取自 auth.ok payload（spec §7.4 / protocol auth.ok）。
 * - ok=false：握手失败，error 归一为 'auth'（token 错/空）/ 'network'（onerror / 非 4001 close）/ 'timeout'。
 */
export type ProbeConnectResult =
  | { ok: true; serverVersion: string }
  | { ok: false; error: 'auth' | 'network' | 'timeout' }

// ── buildAuthMessage（IF13 纯函数，与 ws-client 共用防漂移）────────

/**
 * 构造 auth 消息（spec §7.4 + protocol ClientMessage.auth）。
 *
 * - id：`auth_<uuid>`（与 runtime ConnectionManager 首消息 on('message') 流程对齐，
 *   便于 ws-client 的 reply 路由用同一 id 收窄 auth.ok reply）。
 * - payload：{ token, clientId, deviceName } + 可选 lastSeq/bootId/subscribedSessions（P2-s4 IF2/DM2）。
 *   **probe 调用时不带** lastSeq/bootId/subscribedSessions（spec D10：probe 是握手
 *   预检不参与断线续传）；**ws-client 正式 connect 调用时**若 lastSeq>0（同页面生命周期内的重连）
 *   才携带 lastSeq+bootId+subscribedSessions（P2-s4 IF6）。三字段按条件展开——undefined 不入 wire
 *   payload，保持 wire 格式干净（probe 调用零回归）。
 *
 * 纯函数：相同输入产生结构等价输出（id 随机），无副作用，便于单测 + ws-client 复用。
 */
export function buildAuthMessage(payload: AuthPayload): {
  type: 'auth'
  id: string
  payload: AuthPayload
} {
  return {
    type: 'auth',
    id: `auth_${generateAuthId()}`,
    // 按条件展开：deviceName/lastSeq/bootId/subscribedSessions undefined 时不入 wire payload
    // （probe 不传后三字段 → wire 格式与改造前逐字节一致，零回归；ws-client 传时才出现）
    payload: {
      token: payload.token,
      clientId: payload.clientId,
      ...(payload.deviceName !== undefined ? { deviceName: payload.deviceName } : {}),
      ...(payload.lastSeq !== undefined ? { lastSeq: payload.lastSeq } : {}),
      ...(payload.bootId !== undefined ? { bootId: payload.bootId } : {}),
      ...(payload.subscribedSessions !== undefined
        ? { subscribedSessions: payload.subscribedSessions }
        : {}),
    },
  }
}

/** Date/Math 转 base-36 字符串的基数（与 connection-config 一致，二级降级用） */
const RADIX_BASE36 = 36
/** Math.random().toString(36) 产物前缀 '0.' 长度，slice 跳过（与 connection-config 一致） */
const RANDOM_PREFIX_LEN = 2

/**
 * 生成 auth id 后缀：优先 crypto.randomUUID，无 crypto 降级 Date+random
 * （与 connection-config.generateUuid 同策略，SSR/老环境兜底）。
 */
function generateAuthId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }
  // 降级：与 connection-config 一致的 base36 组合（不引依赖、幂等可用即可）
  return `${Date.now().toString(RADIX_BASE36)}-${Math.random().toString(RADIX_BASE36).slice(RANDOM_PREFIX_LEN)}`
}

// ── probeConnection ────────────────────────────────────────────────

/**
 * 探测远程服务器握手连通性（spec §7.5）。
 *
 * 流程：
 * 1. token 空短路 → resolve {ok:false,error:'auth'}，**不构造 WebSocket**（DM6 + 防误连）。
 * 2. `new WebSocket(url)` 临时局部实例（绝不走 ws-client 单例）。
 * 3. onopen → 发 buildAuthMessage（token + getClientId + getDeviceName）。
 * 4. onmessage → 收到 type==='auth.ok'（id 匹配）→ resolve {ok:true,serverVersion}。
 * 5. onclose(code=4001) → resolve {ok:false,error:'auth'}。
 * 6. onclose(其他 code) / onerror → resolve {ok:false,error:'network'}。
 * 7. timeoutMs 超时 → resolve {ok:false,error:'timeout'}。
 * 8. 所有路径 try/finally 强制 ws.close()（防连接泄漏，spec §7.5 + DM5）。
 *
 * @param url       ws://host:port 或 wss://domain
 * @param token     鉴权 token（空串短路）
 * @param timeoutMs 超时上限，默认 10s（spec §7.5）
 */
export async function probeConnection(
  url: string,
  token: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeConnectResult> {
  // 1. token 空短路：不发 WS、不构造 auth（DM6 前置校验）
  if (!token) {
    return { ok: false, error: 'auth' }
  }

  const ws = new WebSocket(url)
  // 防御：url 非法导致 new WebSocket 抛 → 上层 try/catch 兜底归 network
  // （浏览器构造器对非法 scheme 会 throw SyntaxError）

  let timer: ReturnType<typeof setTimeout> | null = null
  let settled = false

  /**
   * Promise 体：等握手结果（open/auth.ok/close/error），首条 settle 后忽略后续事件。
   * 不直接用 reject：所有失败都归一为 resolve(ok:false) 以便上层 try/finally 无差别 close。
   */
  return new Promise<ProbeConnectResult>((resolve) => {
    const settle = (result: ProbeConnectResult): void => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      resolve(result)
    }

    // 7. 超时
    timer = setTimeout(() => {
      settle({ ok: false, error: 'timeout' })
    }, timeoutMs)

    ws.onopen = () => {
      // 3. 连接 open 后立即发 auth（spec §7.4）
      const msg = buildAuthMessage({
        token,
        clientId: getClientId(),
        deviceName: getDeviceName(),
      })
      // readyState 守护：极少数 onopen 后立即 close 的竞态，send 会抛 InvalidStateError
      try {
        ws.send(JSON.stringify(msg))
      // eslint-disable-next-line taste/no-silent-catch -- onopen→close 竞态下 send 抛 InvalidStateError，留给 onclose/onerror 接管（若都未触发则 timeout 兜底）
      } catch {
        // send 失败视为网络异常（已 close / readyState 翻转），不单独 settle
        // （后续 onclose/onerror 会接管；若都未触发则走 timeout 兜底）
      }
    }

    ws.onmessage = (event: MessageEvent) => {
      // 4. 等 auth.ok（type==='auth.ok'）；非 JSON 或其他 type 静默忽略
      const parsed = safeParse(event.data)
      if (!parsed) return
      if (parsed.type === 'auth.ok') {
        const serverVersion =
          (parsed.payload as { serverVersion?: unknown } | undefined)?.serverVersion
        settle({ ok: true, serverVersion: typeof serverVersion === 'string' ? serverVersion : '' })
      }
      // 注：spec §7.4 也提到服务端可能发 type:'error' 表示鉴权失败——
      // 与 close 4001 等价归一。runtime 当前实现是 close 4001（见 ConnectionManager TC3），
      // 不发 in-band error，故此处仅认 auth.ok；type:'error' 不主动 settle，留给 onclose 兜底。
    }

    ws.onclose = (event: CloseEvent) => {
      // 5/6. 4001 → auth；其余 → network（DM6 归一，spec §4.2 分支一致）
      if (event.code === CLOSE_CODE_AUTH_FAILURE) {
        settle({ ok: false, error: 'auth' })
      } else {
        settle({ ok: false, error: 'network' })
      }
    }

    ws.onerror = () => {
      // 6. onerror（服务器不可达 / Tailscale 断 / TLS 失败）→ network
      // 注：浏览器 WS onerror 不携带细节（安全考虑），统一归 network；
      // 通常 onerror 后会跟一个 onclose（code 1006），但 close handler 已被 settled 守护幂等。
      settle({ ok: false, error: 'network' })
    }
  }).then(async (result) => {
    // try/finally 等价：所有返回路径强制 close（防泄漏 spec §7.5 + DM5）
    // 放在 Promise resolve 之后异步 close，避免 close 触发的 onclose 干扰已 settle 的结果。
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    // eslint-disable-next-line taste/no-silent-catch -- close 抛（已 close / 状态翻转 / 双重 close）吞掉，不影响探测结果（spec §7.5 强制 close 兜底）
    } catch {
      // close 抛（已 close / 状态翻转）吞掉，不影响探测结果
    }
    return result
  })
}

// CL4：probeConnection 别名（slice plan IF14 命名兼容）
export { probeConnection as probeConnect }

// ── probeOnline ────────────────────────────────────────────────────

/**
 * 探测服务器是否在线（TCP/TLS 握手能否达成 WS 握手，spec §7.4 + IF15）。
 *
 * 与 probeConnection 的区别：
 * - **不发 auth**（仅探活，无鉴权），onopen 即返回 true。
 * - 不读 getClientId/getDeviceName（无 auth payload）。
 * - 默认超时 3s（spec §7.4，比 probeConnection 的 10s 更短：探活不需要等 auth 握手）。
 *
 * @returns true=onopen 在 timeoutMs 内触发；false=onerror / 超时
 */
export async function probeOnline(
  url: string,
  timeoutMs: number = DEFAULT_PROBE_ONLINE_TIMEOUT_MS,
): Promise<boolean> {
  const ws = new WebSocket(url)

  let timer: ReturnType<typeof setTimeout> | null = null
  let settled = false

  return new Promise<boolean>((resolve) => {
    const settle = (ok: boolean): void => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      resolve(ok)
    }

    timer = setTimeout(() => settle(false), timeoutMs)

    ws.onopen = () => settle(true)
    ws.onerror = () => settle(false)
    ws.onclose = () => settle(false)
  }).then(async (ok) => {
    // onopen 后立即 close（spec §7.4：仅探活，不维持连接）
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    // eslint-disable-next-line taste/no-silent-catch -- close 抛（已 close / 状态翻转）吞掉，不影响探活结果（spec §7.4 探活即 close）
    } catch {
      // 吞 close 异常
    }
    return ok
  })
}

// ── 内部工具 ───────────────────────────────────────────────────────

/** 安全 JSON.parse（失败返 null，不抛）。供 onmessage 解析服务端消息。 */
function safeParse(data: unknown): { type?: unknown; payload?: unknown } | null {
  if (typeof data !== 'string') return null
  try {
    return JSON.parse(data) as { type?: unknown; payload?: unknown }
  } catch {
    // 非 JSON / 畸形消息 → 忽略（onmessage 不应 crash 探测）
    return null
  }
}
