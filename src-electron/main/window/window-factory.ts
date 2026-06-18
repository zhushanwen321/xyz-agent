/**
 * 窗口工厂。
 *
 * 对应 spec §4.2 M2/M3：WindowManager 不直接创建 BrowserWindow，
 * 创建职责由此模块承担。含 dev 模式 Vite 就绪轮询。
 *
 * [HISTORICAL] 不变量：
 * - dev 模式 waitForVite 轮询（解决 concurrently 下 Electron 比 Vite 先启动白屏）
 * - preload 路径：dist/preload/preload.cjs（electron-builder files 白名单对应）
 * - contextIsolation: true / nodeIntegration: false（Electron 安全默认）
 * - windowId 注入到 URL query，renderer 读取后用于注册到 WindowManager
 *
 * 依赖方向：window-factory → electron + main/interfaces（type-only）
 */
import type { BrowserWindow } from 'electron'
import type { WindowOptions } from '../interfaces.js'

/** Dev 模式 Vite URL */
export const VITE_DEV_URL = 'http://localhost:1420'

/** 等待 Vite dev server 就绪的总超时 */
export const VITE_READY_TIMEOUT_MS = 30_000

/** Vite 轮询间隔 */
export const VITE_POLL_INTERVAL_MS = 300

/**
 * 等待 Vite dev server 就绪（轮询直到连接成功）。
 * 解决 concurrently 下 Electron 比 Vite 先启动导致白屏。
 *
 * @param url Vite 地址
 * @param timeoutMs 总超时
 * @throws 超时抛 Error
 */
export async function waitForVite(url: string, timeoutMs = VITE_READY_TIMEOUT_MS): Promise<void> {
  void url; void timeoutMs
  throw new Error('not implemented: waitForVite')
}

/**
 * 创建 BrowserWindow 并加载内容（dev: Vite URL / prod: index.html）。
 *
 * @param options.windowId 指定窗口 id（不传由调用方生成）
 * @param options.sessionId 可选，携带 session 迁移
 * @param deps.isDev 是否开发模式
 * @param deps.windowManager windowManager 引用（用于查重/分配 id）
 */
export async function createWindow(
  options: WindowOptions | undefined,
  deps: { isDev: boolean; generateId: () => string },
): Promise<{ win: BrowserWindow; windowId: string }> {
  void options; void deps
  throw new Error('not implemented: createWindow')
}
