/**
 * 运行环境判定工具（D18 + D19）。
 *
 * - `isPackaged()`：统一 `process.env.XYZ_AGENT_PACKAGED === '1'` 判定（散落 5 处）。
 * - `getExtensionFilePath(projectRoot, packaged)`：统一「文件型 extension 路径」解析
 *   （extension-service / session-service 各写一遍）。
 *
 * 注：`isPackaged()` 读 env，进程生命周期内不变；若调用方需在测试中覆盖，应从构造
 * 参数注入 packaged（如 ExtensionService 已做 `options.packaged ?? isPackaged()`）。
 */
import { resolve } from 'node:path'

/** 是否运行在打包后的 Electron 应用中（ Resources 目录布局）。 */
export function isPackaged(): boolean {
  return process.env.XYZ_AGENT_PACKAGED === '1'
}

/**
 * 解析文件型 extension（xyz-agent-extension.js）的绝对路径。
 *
 * - 打包模式：在 `process.cwd()`（Resources 根）下
 * - 开发模式：在 `projectRoot/..`（repo root，src-electron/ 父目录）下
 */
export function getExtensionFilePath(projectRoot: string, packaged: boolean): string {
  return packaged
    ? resolve(process.cwd(), 'xyz-agent-extension.js')
    : resolve(resolve(projectRoot, '..'), 'xyz-agent-extension.js')
}
