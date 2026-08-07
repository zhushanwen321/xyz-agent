/**
 * connection-config —— localStorage 5 key CRUD 纯函数模块（P1-s1-w1）。
 *
 * 设计决策（spec §二 + D1/D3）：
 * - localStorage 即 SSOT，无 store、无响应式（模式切换即 reload，spec §2.3 末段）。
 * - 5 key：client-id（uuid 惰性）/ device-name（UA 推导兜底）/ remote-servers（profile JSON 数组）
 *          / connection-mode（local|remote，缺省 local）/ active-server-id。
 * - getClientId 惰性：读 → 无则生成（crypto.randomUUID，无 crypto 降级 Date.now()+Math.random）写回 → 永不变。
 * - 降级（ES3）：try/catch localStorage，失败用模块级内存 Map 缓存幂等；listProfiles 返 []、isRemoteMode 返 false、getActiveProfile 返 null。
 * - 写路径吞异常（WC3），JSON.parse 失败降级返回安全默认。
 * - saveProfile 按 url trim 后 upsert（WC4）：同 url 复用原 id 覆盖非 id 字段（ES5），新 url 生成 uuid 追加。
 *
 * 依赖方向：依赖 types.ts；无下游（被 useConnection / RemoteConnectModal / Landing 等消费）。
 */
import type { RemoteServerProfile } from './types'

// ── localStorage key 常量（spec §2.1 schema）─────────────────────
const KEY_CLIENT_ID = 'xyz-agent:client-id'
const KEY_DEVICE_NAME = 'xyz-agent:device-name'
const KEY_REMOTE_SERVERS = 'xyz-agent:remote-servers'
const KEY_CONNECTION_MODE = 'xyz-agent:connection-mode'
const KEY_ACTIVE_SERVER_ID = 'xyz-agent:active-server-id'

// ── 内存降级缓存（ES3：localStorage 不可用时幂等兜底）─────────────
const memoryCache = new Map<string, string>()

/**
 * 安全读 localStorage（失败/不可用返 null，不抛）。
 * 优先 localStorage，不可用时读内存缓存。
 */
function safeGet(key: string): string | null {
  try {
    const v = localStorage.getItem(key)
    if (v !== null) return v
    // eslint-disable-next-line taste/no-silent-catch -- SecurityError/隐私模式/SSR 无 localStorage → 降级内存缓存（spec ES3）
  } catch {
    // SecurityError / 隐私模式 / SSR 无 localStorage → 降级内存缓存
  }
  return memoryCache.has(key) ? memoryCache.get(key)! : null
}

/**
 * 安全写 localStorage（失败/不可用降级写内存缓存，不抛，WC3）。
 */
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
    return
    // eslint-disable-next-line taste/no-silent-catch -- SecurityError/隐私模式 → 降级内存缓存（spec ES3/WC3 写路径吞异常）
  } catch {
    // SecurityError / 隐私模式 → 降级内存缓存
  }
  memoryCache.set(key, value)
}

/** 安全删 localStorage（失败吞异常，降级删内存缓存） */
function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key)
    // eslint-disable-next-line taste/no-silent-catch -- 删失败吞异常（spec ES3 降级），降级删内存缓存
  } catch {
    // 吞
  }
  memoryCache.delete(key)
}

/** 安全读 + JSON.parse，任一失败返 fallback */
function safeReadJSON<T>(key: string, fallback: T): T {
  const raw = safeGet(key)
  if (raw === null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// ── uuid / 设备名推导 ──────────────────────────────────────────

/** Date/Math 转 base-36 字符串的基数（uuid 二级降级用） */
const RADIX_BASE36 = 36
/** Math.random().toString(36) 产物前缀 '0.' 长度，slice 跳过 */
const RANDOM_PREFIX_LEN = 2

/**
 * 生成 uuid：优先 crypto.randomUUID()，无 crypto 时降级 Date.now()+Math.random（ES3 二级降级）。
 */
function generateUuid(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }
  return `${Date.now().toString(RADIX_BASE36)}-${Math.random().toString(RADIX_BASE36).slice(RANDOM_PREFIX_LEN)}`
}

/**
 * 按 navigator.userAgent 推导设备名（Mac/Windows/Linux）。
 * SSR 或无 navigator 时返 'Linux'（兜底，与多数 dev 环境一致）。
 */
function deviceNameFromUA(): string {
  if (typeof navigator === 'undefined') return 'Linux'
  const ua = navigator.userAgent
  if (ua.includes('Mac')) return 'Mac'
  if (ua.includes('Windows')) return 'Windows'
  if (ua.includes('Linux')) return 'Linux'
  return 'Linux'
}

// ── 公开 API（IF4-IF12，spec §2.3）──────────────────────────────

/**
 * 取 clientId（惰性生成 + 持久化，永不变）。
 * 首次：localStorage 无 client-id → 生成 uuid 写回 → 返回。
 * 二次：返回与首次完全相同的值（幂等）。
 * 降级（ES3）：localStorage 不可用时用模块级内存缓存幂等。
 */
export function getClientId(): string {
  const existing = safeGet(KEY_CLIENT_ID)
  if (existing) return existing
  const id = generateUuid()
  safeSet(KEY_CLIENT_ID, id)
  return id
}

/**
 * 取设备名（存储值 ?? UA 推导）。
 * modal 手动 tab 保存后读存储值；缺省按 UA 推导 Mac/Windows/Linux。
 */
export function getDeviceName(): string {
  const stored = safeGet(KEY_DEVICE_NAME)
  if (stored) return stored
  return deviceNameFromUA()
}

/**
 * 写设备名（modal 手动 tab 字段改动回写，spec §二.1 / §7.3）。
 * 空串视为「恢复 UA 推导兜底」→ 删 key（下次 getDeviceName 重新推导），与 getDeviceName 对称。
 */
export function setDeviceName(name: string): void {
  const trimmed = name.trim()
  if (trimmed) {
    safeSet(KEY_DEVICE_NAME, trimmed)
  } else {
    safeRemove(KEY_DEVICE_NAME)
  }
}

/**
 * 当前是否远程模式。
 * = connectionMode==='remote' && getActiveProfile()!==null（ES6 短路：active id 指向不存在 profile 时返 false）。
 */
export function isRemoteMode(): boolean {
  const mode = safeGet(KEY_CONNECTION_MODE)
  return mode === 'remote' && getActiveProfile() !== null
}

/**
 * 取当前激活的 profile（active-server-id 指向的项）。
 * 无 active id 或指向不存在的 profile → 返 null（降级路径，不抛）。
 */
export function getActiveProfile(): RemoteServerProfile | null {
  const activeId = safeGet(KEY_ACTIVE_SERVER_ID)
  if (!activeId) return null
  const profiles = listProfiles()
  return profiles.find((p) => p.id === activeId) ?? null
}

/**
 * 列出全部已保存 profile（按写入顺序）。
 * 无数据或 JSON.parse 失败 → 返 []（降级路径）。
 */
export function listProfiles(): RemoteServerProfile[] {
  return safeReadJSON<RemoteServerProfile[]>(KEY_REMOTE_SERVERS, [])
}

/**
 * 保存 profile（upsert by url，spec §2.3 + ES5）。
 *
 * - 同 url：复用原 id，覆盖 token/name/networkKind/lastConnectedAt，数组长度不变。
 * - 新 url：生成新 uuid 作为 id，追加到数组末尾，长度 +1。
 *
 * @returns 落库后的完整 profile（含 id）
 */
export function saveProfile(
  p: Omit<RemoteServerProfile, 'id'> & { id?: string },
): RemoteServerProfile {
  const profiles = listProfiles()
  const normalizedUrl = p.url.trim()
  // upsert by url（trim 后比较，WC4）
  const idx = profiles.findIndex((it) => it.url.trim() === normalizedUrl)
  const id = idx >= 0 ? profiles[idx].id! : (p.id ?? generateUuid())
  const profile: RemoteServerProfile = {
    id,
    name: p.name,
    url: normalizedUrl,
    token: p.token,
    networkKind: p.networkKind,
    ...(p.lastConnectedAt !== undefined ? { lastConnectedAt: p.lastConnectedAt } : {}),
  }
  if (idx >= 0) {
    profiles[idx] = profile
  } else {
    profiles.push(profile)
  }
  safeSet(KEY_REMOTE_SERVERS, JSON.stringify(profiles))
  return profile
}

/**
 * 删除指定 id 的 profile。
 * 若删的是当前 active 项 → 清空 active-server-id（getActiveProfile 随之返 null）。
 */
export function removeProfile(id: string): void {
  const profiles = listProfiles().filter((p) => p.id !== id)
  safeSet(KEY_REMOTE_SERVERS, JSON.stringify(profiles))
  // 删的是 active 项则清空 active id
  const activeId = safeGet(KEY_ACTIVE_SERVER_ID)
  if (activeId === id) {
    safeRemove(KEY_ACTIVE_SERVER_ID)
  }
}

/**
 * 激活远程模式（连接成功流程调用，spec §7.5）。
 * 写 connection-mode=remote + active-server-id=profileId。
 */
export function activateRemote(profileId: string): void {
  safeSet(KEY_CONNECTION_MODE, 'remote')
  safeSet(KEY_ACTIVE_SERVER_ID, profileId)
}

/**
 * 断开远程模式（Landing 状态条「断开连接」按钮，spec §八）。
 * 写 connection-mode=local（profiles 保留，可随时切回）。
 */
export function deactivateRemote(): void {
  safeSet(KEY_CONNECTION_MODE, 'local')
}

// ── 仅供测试：重置模块级内存缓存（避免跨用例串扰）─────────────────
/**
 * 重置内存降级缓存（仅供测试 beforeEach 调用，业务代码勿用）。
 * @internal
 */
export function __resetForTest(): void {
  memoryCache.clear()
}
