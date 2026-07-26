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
 *  packaged=true（生产）从 process.cwd() 取；packaged=false（开发）从 projectRoot/../.. 取。
 *  fileName 默认 'xyz-agent-extension.js'，传 'xyz-system-prompt-extension.js' 等可解析第二个文件型扩展。
 *
 *  [HISTORICAL] dev 分支为什么是两层之上（projectRoot/../..）：
 *  - dev 模式 projectRoot = app.getAppPath() = `<repo>/apps/electron`
 *    （由 apps/electron/main/supervisor/process-control.ts:154 设定）
 *  - 3 个 builtin extension（xyz-agent-extension.js / xyz-system-prompt-extension.js /
 *    xyz-client-msg-id-mapper.js）位于 repo root，即 `apps/electron/../..`
 *  - 重构前（commit 0f6eed87 之前）项目结构扁平，projectRoot 在 `src/electron`，repo root
 *    是一层之上（`..`）。monorepo 重构后 projectRoot 迁到 `apps/electron`，路径深度变成两层，
 *    但本函数当时未同步更新，导致 3 个 builtin extension 在 dev 模式全失效（pi spawn 命令无
 *    `--extension` 参数，runtime log 显示 `resolved 0 extensions from 4 sources`，
 *    pi session JSONL 中 `<!--xyz:msg:u-...-->` 标记原样进了 user message——extension input
 *    hook 没执行）。这里修正为 `../..`。
 *  - packaged 分支不变：process.cwd() 是打包后的 Resources/，extension 文件直接在该目录。 */
export function getExtensionFilePath(projectRoot: string, packaged: boolean, fileName = 'xyz-agent-extension.js'): string {
  return packaged
    ? resolve(process.cwd(), fileName)
    : resolve(resolve(projectRoot, '..', '..'), fileName)
}
