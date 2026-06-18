/**
 * TCP 健康检查器。
 *
 * 对应 spec §4.2 M2 子职责「健康检查」。
 *
 * [HISTORICAL] 不变量：
 * - 30 次 × 200ms 重试，总等待 ~6s
 * - 用 TCP socket 连接检测（createConnection），非 HTTP /health
 *   （注：runtime 进程暴露了 /health 端点，但 RuntimeManager 未调用它——保持现状语义）
 * - socket 连接成功立即 destroy，resolve(true)；超时/错误 resolve(false)
 *
 * 这是相对薄的文件——签名即设计，不深化骨架。
 *
 * 依赖方向：health-checker → node:net
 */
import { createConnection } from 'node:net'

/** 健康检查重试次数 */
export const HEALTH_RETRY_COUNT = 30

/** 健康检查重试间隔 */
export const HEALTH_INTERVAL_MS = 200

/** TCP 连接超时 */
export const CONNECT_TIMEOUT_MS = 500

/**
 * 检测端口是否被监听（TCP socket 连接尝试）。
 *
 * @param port 目标端口
 * @param timeoutMs 连接超时，默认 CONNECT_TIMEOUT_MS
 * @returns true=端口在监听 / false=空闲或连接失败
 */
export function isPortInUse(port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  void port; void timeoutMs
  void createConnection
  throw new Error('not implemented: isPortInUse')
}

/**
 * 轮询健康检查：直到端口监听或重试耗尽。
 *
 * @param port 目标端口
 * @throws 重试耗尽（HEALTH_RETRY_COUNT × HEALTH_INTERVAL_MS 后仍不监听）
 */
export async function waitForHealth(port: number): Promise<void> {
  void port
  throw new Error('not implemented: waitForHealth')
}
