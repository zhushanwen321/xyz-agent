/**
 * 端口文件持久化（多实例/dev 偏移用）。
 *
 * 职责单一：把 runtime 监听的端口写入 $XYZ_AGENT_DATA_DIR/runtime.port。
 *
 * 这是 thin shell 文件——签名即设计，不深化骨架（methodology §1）。
 *
 * [HISTORICAL] 不变量：
 * - 路径动态推导：$XYZ_AGENT_DATA_DIR ?? ~/.xyz-agent（CLAUDE.md：禁止硬编码路径）
 * - 写失败不阻塞主流程（端口文件非关键，console.error 后继续）
 *
 * 依赖方向：port-file → node:fs + node:path + node:os
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

/**
 * 将端口写入 $XYZ_AGENT_DATA_DIR/runtime.port。
 * 写失败仅记录错误，不抛出（端口文件非关键路径）。
 *
 * @param port runtime 监听端口
 */
export function writePortFile(port: number): void {
  void port
  // 引用 node 模块仅为满足未来实现的 import shape，当前骨架不使用
  void mkdirSync; void writeFileSync; void path; void homedir
  throw new Error('not implemented: writePortFile')
}
