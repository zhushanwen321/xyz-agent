/**
 * toolResult 图片落盘编排（crash-resilience §3.3 D6-⑨ / u7-memory-governance，core 侧）。
 *
 * 职责切分：落盘**执行方**是 main 进程（fs 只存在于 main；目录
 * `<dataDir>/cache/images/<sessionId>/<sha256>.<ext>`、幂等去重、64MB size 帽、三条
 * 清理通道都在 apps/electron/main/images/image-cache.ts）——本模块是 renderer 侧的
 * **编排与记账层**：
 * - hydrate 批量编排：hydrate 时收集消息序（旧→新）全部 base64 图，**反转为新→旧**
 *   一次性交 main 按序落盘、超帽即停（设计 D6-⑨ v8 显式声明的顺序语义，挂点在
 *   useChat.hydrateHistory——load-more 更早图由组件挂载单图兜底，剩余额度内即写）。
 * - live 单图写入：新到图片（live overlay 回填 images）由渲染组件触发，main 侧在
 *   剩余额度内即写、超帽返回 quota-full。
 * - 路径记账：内容 hash → 落盘路径（**值语义键**——记账必须跨「hydrate 编排收集的
 *   image 对象」与「渲染组件 props 收到的 image 对象」生效，而 props 链存在深拷贝
 *   （@vue/test-utils 实测）/ 代理化等引用漂移，对象引用键不可靠；内容 hash 与 main
 *   侧幂等判据同源同值语义。Map 有界性：同 hash 覆盖写，条目数 ≤ 历史去重图片数）。
 * - 帽满标记：quota-full 后该 session 的未落盘图（更旧图）渲染「图片缓存已满」占位。
 *
 * 平台边界：main 调用经 write port 注入——生产环境懒探测 preload 暴露的
 * `globalThis.electronAPI.imageCacheWrite`（core 平台无关内核不 import electron；
 * headless 测试 / mock 门面（VITE_MOCK）下无此全局 → port 缺省，编排 no-op，
 * 渲染组件走降级形态）。
 */
import type { Message } from '@xyz-agent/shared'
import type { ImageCacheWriteImage, ImageCacheWriteResult } from '@xyz-agent/shared'

/**
 * 图片落盘 write port（main 侧 IMAGE_CACHE_WRITE invoke 的 core 侧镜像签名）。
 * images 数组序 = 落盘序（新→旧），main 按序处理超帽即停——契约见
 * shared ipc-payloads.ts ImageCacheWritePayload 注释。
 */
export type ImageCacheWritePort = (
  sessionId: string,
  images: ImageCacheWriteImage[],
) => Promise<ImageCacheWriteResult>

/** preload 暴露形态的窄化探测结构（core 不 import electron，结构守卫替代类型依赖）。 */
interface ElectronAPILike {
  imageCacheWrite?: (payload: { sessionId: string; images: ImageCacheWriteImage[] }) => Promise<ImageCacheWriteResult>
}

/**
 * 模块级状态挂 globalThis 单例（**防双实例**）：本模块被 core barrel 与 .vue SFC 两条
 * 编译链消费时（vitest/ui 测试环境实测存在 SFC 链独立模块实例——export 常量一致但
 * 模块级可变状态分裂），记账表与帽满标记会各持一份，hydrate 编排记的账组件读不到
 * （全部退化为重复写盘请求，帽满标记失效）。挂 globalThis 后跨实例共享同一状态容器，
 * 语义回归「进程内单例」。键名带命名空间防撞。
 */
const STATE_KEY = '__xyz_agent_image_cache_state__'

interface ImageCacheGlobalState {
  writePort: ImageCacheWritePort | undefined
  portExplicit: boolean
  /** 内容 hash → 落盘路径 */
  imagePaths: Map<string, string>
  /** 内容 hash → in-flight 写入 Promise（同内容并发请求共享，防双写） */
  inflightWrites: Map<string, Promise<string | undefined>>
  quotaFullSessions: Set<string>
}

function state(): ImageCacheGlobalState {
  const g = globalThis as unknown as Record<string, unknown>
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      writePort: undefined,
      portExplicit: false,
      imagePaths: new Map<string, string>(),
      inflightWrites: new Map<string, Promise<string | undefined>>(),
      quotaFullSessions: new Set<string>(),
    }
  }
  return g[STATE_KEY] as ImageCacheGlobalState
}

/** FNV-1a 32 位偏移基（h1 初始值）。 */
const FNV1A_OFFSET_BASIS = 0x811c9dc5
/** FNV-1a 32 位质数（h1 乘子）。 */
const FNV1A_PRIME = 0x01000193
/** h2 混合乘子（非 FNV 标准——第二通道独立质数，降低同碰撞相关性）。 */
const FNV1A_SECOND_LANE_PRIME = 0x85ebca6b
/** 16 进制字符数 / 每通道 8 字符（2×8 = 16 hex 记账键）。 */
const HEX_CHARS_PER_LANE = 8

/** 图片记账键：双通道 FNV-1a（64 bit 组合，16 hex 字符）。 */
function imageKey(data: string): string {
  let h1 = FNV1A_OFFSET_BASIS
  let h2 = (FNV1A_PRIME ^ data.length) | 0
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, FNV1A_PRIME)
    h2 = Math.imul(h2 ^ c, FNV1A_SECOND_LANE_PRIME)
  }
  const HEX_RADIX = 16
  return (h1 >>> 0).toString(HEX_RADIX).padStart(HEX_CHARS_PER_LANE, '0')
    + (h2 >>> 0).toString(HEX_RADIX).padStart(HEX_CHARS_PER_LANE, '0')
}

/**
 * 注入/清除 write port（renderer 装配可显式注入；不注入时 lazily 探测 electronAPI）。
 * 传 undefined 且此前未显式注入过时保留懒探测资格——测试用 _resetImageCacheForTest 复位。
 */
export function setImageCacheWritePort(port: ImageCacheWritePort | undefined): void {
  state().writePort = port
  state().portExplicit = true
}

/** 懒探测 preload 全局（core 平台无关：无 window.electronAPI 的宿主返回 undefined）。 */
function resolvePort(): ImageCacheWritePort | undefined {
  const s = state()
  if (s.portExplicit) return s.writePort
  const api = (globalThis as { electronAPI?: ElectronAPILike }).electronAPI
  if (api?.imageCacheWrite) {
    const invoke = api.imageCacheWrite
    s.writePort = (sessionId, images) => invoke({ sessionId, images })
  }
  s.portExplicit = true
  return s.writePort
}

/** 读口：图片已落盘的路径（未落盘 / 编排未跑 → undefined）。 */
export function getCachedImagePath(image: ImageCacheWriteImage): string | undefined {
  return state().imagePaths.get(imageKey(image.data))
}

/** 读口：该 session 图片缓存是否已帽满（「图片缓存已满」占位渲染判定）。 */
export function isSessionImageCacheFull(sessionId: string): boolean {
  return state().quotaFullSessions.has(sessionId)
}

/**
 * 收集 messages 里全部 toolResult 图片（消息序，旧→新）。
 * 只扫 toolCalls[].images（toolResult base64 图，设计 D6-⑨ 对象）；user 消息贴图走
 * segments 磁盘路径（attachments），不属本通道。
 */
export function collectImagesFromMessages(messages: Message[]): ImageCacheWriteImage[] {
  const result: ImageCacheWriteImage[] = []
  for (const m of messages) {
    if (!m.toolCalls) continue
    for (const tc of m.toolCalls) {
      if (!tc.images) continue
      for (const img of tc.images) {
        if (img.data) result.push(img)
      }
    }
  }
  return result
}

/**
 * 记账单批结果（results 与 images 按序对应；quota-full → 标记 session 帽满）。
 */
function recordBatchResults(sessionId: string, images: ImageCacheWriteImage[], result: ImageCacheWriteResult): void {
  const s = state()
  let sawQuotaFull = false
  result.results.forEach((r, i) => {
    if (r.status === 'written' || r.status === 'cached') {
      const img = images[i]
      if (r.path !== undefined && img !== undefined) s.imagePaths.set(imageKey(img.data), r.path)
    } else if (r.status === 'quota-full') {
      sawQuotaFull = true
    }
    // invalid：payload 字段畸形单图跳过，不影响批内其他图（错误可观测：main 侧负责，
    // core 不重复告警——低频防御路径，静默降级为无图形态由组件 fallback 承接）。
  })
  if (sawQuotaFull || result.quotaFull) s.quotaFullSessions.add(sessionId)
}

/**
 * 单图写入（live / 组件挂载兜底路径）：帽满快速失败 + in-flight 去重。
 * 返回落盘路径；无 port / 写入失败 / 帽满 → undefined（组件降级或占位）。
 */
export function requestImageWrite(sessionId: string, image: ImageCacheWriteImage): Promise<string | undefined> {
  const s = state()
  const key = imageKey(image.data)
  const cached = s.imagePaths.get(key)
  if (cached !== undefined) return Promise.resolve(cached)
  const inflight = s.inflightWrites.get(key)
  if (inflight) return inflight
  // 帽满 session 前置快速失败：不再发无效 IPC（超帽即停语义在编排层收口，
  // 渲染组件无须各自自查也能拿到一致的 undefined → 占位降级）
  if (s.quotaFullSessions.has(sessionId)) return Promise.resolve(undefined)
  const port = resolvePort()
  if (!port || !image.data) return Promise.resolve(undefined)
  const task = port(sessionId, [image])
    .then((result) => {
      recordBatchResults(sessionId, [image], result)
      return state().imagePaths.get(key)
    })
    .catch(() => undefined)
    .finally(() => {
      state().inflightWrites.delete(key)
    })
  s.inflightWrites.set(key, task)
  return task
}

/**
 * hydrate 批量编排：输入为消息序（旧→新）收集的全部图片，内部**反转为新→旧**交 main
 * 按序落盘——设计 D6-⑨ v8 显式声明「新→旧有序落盘、超帽即停、更旧的图占位」（正序会
 * 把窗口内较旧图写满帽、最新图占位，与「最新内容优先可见」承诺相反）。fire-and-forget
 * 语义（调用方不 await 不阻塞 hydrate）：内部消化全部异常——图片缓存故障不得放大为
 * 历史加载失败。
 */
export async function persistImagesNewestFirst(sessionId: string, imagesInMessageOrder: ImageCacheWriteImage[]): Promise<void> {
  if (imagesInMessageOrder.length === 0) return
  const port = resolvePort()
  if (!port) return
  // 新→旧 = 消息序反转；已记账（hash 命中）的图剔除，只把未落盘图交 main。
  const s = state()
  const pending = imagesInMessageOrder.filter((img) => !s.imagePaths.has(imageKey(img.data))).reverse()
  if (pending.length === 0) return
  try {
    const result = await port(sessionId, pending)
    recordBatchResults(sessionId, pending, result)
  } catch { void 0 } // 编排失败静默（fire-and-forget 契约）：组件挂载兜底会逐图重试单图写入。
}

/** 测试复位：清全部模块级状态（port / 记账表 / in-flight / 帽满标记）。 */
export function _resetImageCacheForTest(): void {
  const s = state()
  s.writePort = undefined
  s.portExplicit = false
  s.imagePaths.clear()
  s.inflightWrites.clear()
  s.quotaFullSessions.clear()
}
