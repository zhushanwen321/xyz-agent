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

/** 解析文件型 extension 的绝对路径。
 *  packaged=true（生产）从 process.cwd() 取；packaged=false（开发）从 projectRoot/.. 取。
 *  fileName 默认 'xyz-agent-extension.js'，传 'xyz-system-prompt-extension.js' 等可解析第二个文件型扩展。 */
export function getExtensionFilePath(projectRoot: string, packaged: boolean, fileName = 'xyz-agent-extension.js'): string {
  return packaged
    ? resolve(process.cwd(), fileName)
    : resolve(resolve(projectRoot, '..'), fileName)
}
