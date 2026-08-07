/**
 * 远程连接 lib 共享数据模型（P1-s1-w1）—— 跨 ws-origin / parse-connect-info / connection-config 三个模块的纯类型聚合。
 *
 * 设计决策（spec §二.1 / §三）：
 * - 无运行时逻辑，纯类型导出，避免跨模块类型耦合与循环 import。
 * - NetworkKind 为展示用枚举（不影响连接行为，spec §2.2 末段）；ConnectionInfoFormat 驱动粘贴框 UI 状态。
 * - ParsedConnectionInfo 是 parseConnectionInfo 的判别联合输出：命中格式时带 url?/token?/networkKind?，
 *   全不命中时只带 error:'unrecognized'（ES1，spec §三 末段）。
 *
 * 依赖方向：无下游（被 remote/ 下三个模块 import）。
 */

/** 网络类型（展示用，spec §2.2 启发式识别） */
export type NetworkKind = 'tailscale' | 'public' | 'lan' | 'localhost'

/** 连接信息粘贴格式（spec §三 四种格式） */
export type ConnectionInfoFormat = 'deep-link' | 'http-url' | 'ws-url' | 'url-token-lines'

/**
 * parseConnectionInfo 解析结果。
 *
 * - 命中格式：带 format + 可选 url/token/networkKind（token 缺失按 ES2 不报 error，仅 undefined）。
 * - 全不命中：仅带 error:'unrecognized'（ES1 静默不抛，UI 显示橙色提示）。
 */
export interface ParsedConnectionInfo {
  /** 推导后的 WS 地址（ws://host:port 或 wss://domain），unrecognized 时可能缺失 */
  url?: string
  /** 鉴权 token（非空校验，P0 前部署兼容 hex），url-token-lines / deep-link / http-url 可缺失 */
  token?: string
  /** 命中的粘贴格式，unrecognized 时为占位（仍存在以便 UI 解构） */
  format?: ConnectionInfoFormat
  /** host 启发式识别的网络类型，仅命中格式时携带 */
  networkKind?: NetworkKind
  /** 仅 'unrecognized' 一种值（全不命中时，ES1） */
  error?: 'unrecognized'
}

/**
 * 已保存的远程服务器 profile（spec §2.1 schema）。
 * 存于 localStorage `xyz-agent:remote-servers`，token 明文（与 Web 端同级，spec D1）。
 */
export interface RemoteServerProfile {
  /** uuid，saveProfile upsert by url 时复用既有 id（ES5） */
  id: string
  /** 显示名，默认取 host；已保存 tab 可重命名 */
  name: string
  /** ws://host:port | wss://domain */
  url: string
  /** 鉴权 token（明文存 localStorage） */
  token: string
  /** 展示用网络类型，解析时识别 */
  networkKind: NetworkKind
  /** 上次连接成功时间戳（ms），可选 */
  lastConnectedAt?: number
}
