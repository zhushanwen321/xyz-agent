/**
 * tasks builtin plugin 骨架导出（s5 W3）。
 *
 * 只导出本目录的静态声明与类型；不导入 s2 的任何运行时模块（ES2 降级：
 * 真实激活/注册待 s2 就绪，本骨架纯静态）。
 */
export {
  tasksPluginManifest,
  type BuiltinActivationEvent,
  type BuiltinPluginManifest,
  type PluginCommandDeclaration,
  type PluginSlashCommandDeclaration,
} from './manifest'
