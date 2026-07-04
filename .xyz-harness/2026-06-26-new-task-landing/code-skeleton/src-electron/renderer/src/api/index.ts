/**
 * api 域 barrel（useNewTaskFlow 经 `@/api` 取 session/git 域）。
 * 真实 barrel 在 src-electron/renderer/src/api/index.ts（聚合多个 domain，未改动）。
 * 骨架仅暴露 NewTaskFlow 链路用到的 session / git 两域。
 */
export * as session from './domains/session'
export * as git from './domains/git'
