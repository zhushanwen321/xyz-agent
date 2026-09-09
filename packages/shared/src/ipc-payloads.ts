/**
 * Electron IPC payload 类型 SSOT（renderer → main 方向，与 ipc-channels.ts 通道名配对）。
 *
 * 现状归属：既有 IPC payload 类型按领域散落（update.ts 的 UpdateErrorPayload、panel.ts
 * 的 WindowState 等）；renderer-log 是跨领域诊断通道，无既有领域文件可归，独立成文件
 * 防止并行单元共改漂移（crash-resilience u-foundation 同型考量）。
 *
 * 信任边界：本类型只约束 renderer 的组装形态；main 侧 handler（renderer-log-handler.ts）
 * 对进站 payload 做运行时再校验（renderer 在崩溃/中毒状态下可能发出畸形 payload），
 * 类型不作为信任依据。
 */

/**
 * performance.memory 快照（Chromium 专属非标准 API）[crash-resilience §3.3 D6-③]。
 *
 * 字段与 Chrome 官方非标准 memory 形态一致；renderer 侧读取前做运行时 guard，
 * API 不可用时整字段省略（探针 P-mem-api 留 u6/阶段 5 验证，不可用不阻塞上报）。
 */
export interface RendererMemorySnapshot {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

/**
 * 三件套捕获面标识 [crash-resilience §3.3 D2-①]：
 * - 'vue-error-handler'：app.config.errorHandler（组件 render/setup/生命周期错误）
 * - 'window-onerror'：window 层 error 事件（Vue 体系外的全局 JS 错误）
 * - 'unhandledrejection'：未接住的 Promise rejection
 */
export type RendererErrorSource = 'vue-error-handler' | 'window-onerror' | 'unhandledrejection'

/**
 * renderer → main 错误上报 payload（RENDERER_LOG = 'renderer-log' invoke 通道）
 * [crash-resilience §3.3 D2-② / D6-③]。
 *
 * windowId 有意不在 payload 内：main 侧从 `event.sender.id`（webContents id）权威
 * 读取并用作限流键与落盘字段，不信任 renderer 自报（u2 验收条款）。
 */
export interface RendererLogPayload {
  /** 捕获面（三件套哪一环捕获） */
  source: RendererErrorSource
  /** 错误消息（Error.message / 事件 message / rejection reason 字符串化） */
  message: string
  /** 错误栈（Error.stack；抛出值非 Error 时省略） */
  stack?: string
  /** renderer 捕获时刻毫秒 epoch（跨端排序参考；落盘行的权威时间戳取 main 侧） */
  timestamp: number
  /** 捕获时活跃 session（panel focusedSessionId；pinia 未激活或无活跃 session 时省略） */
  sessionId?: string
  /** performance.memory 快照（Chromium 专属；API 不可用时省略——探针 P-mem-api） */
  memory?: RendererMemorySnapshot
}
