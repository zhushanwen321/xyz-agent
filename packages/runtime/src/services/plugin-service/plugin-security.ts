/**
 * Plugin 安全开关（external 安装硬锁）—— §6.6 排期硬锁落地。
 *
 * [HISTORICAL] 此开关对应 sandbox 真隔离修复进度：
 *
 * 背景：plugin-bootstrap.ts:79 用 `await import()`（ESM 动态导入）加载插件模块，
 * 而 initSandbox 只 patch 了 Module._resolveFilename（CJS require 钩子），ESM 导入
 * 完全绕过该拦截 —— sandbox 名存实亡，external plugin 可 import node:fs 直接
 * 越权访问 fs/child_process/http。在该缺陷修复（runtime/sdk 侧独立工作）落地前，
 * external 插件的安装与激活都是任意代码执行。
 *
 * 联动契约：EXTERNAL_PLUGIN_ENABLED 默认 false（fail-closed）。sandbox 真隔离
 * 修复（消除 plugin-bootstrap.ts:79 的 ESM 绕过）落地时，由修复方在此文件将
 * 常量翻转为 true 并更新本注释。修复未完成前禁止置 true —— 外部插件在
 * sandbox 未就绪时的危险面不应暴露给任何调用方。
 */

/** external 插件安装开关（false = 硬锁）。sandbox 修复方翻转，禁止提前打开。 */
export const EXTERNAL_PLUGIN_ENABLED = false

/** 锁错误码前缀（InstallResult.error 字符串前缀，业务错误码；与 RPC 线协议数值码分层不混用）。 */
export const EXTERNAL_PLUGIN_DISABLED = 'EXTERNAL_PLUGIN_DISABLED'

/** installPlugin 短路返回的完整错误文案。 */
export const EXTERNAL_PLUGIN_DISABLED_MESSAGE =
  'EXTERNAL_PLUGIN_DISABLED: sandbox isolation not yet implemented, external plugin install is locked'
