/**
 * shared 包 barrel（骨架镜像）。
 * 真引本目录下 protocol.ts / session.ts（复制自 src-electron/shared/src 并加 git.createBranch/checkout 扩展），
 * 以及 protocol 依赖的 provider.ts / message.ts 类型桩。
 */
export * from './session'
export * from './protocol'
export * from './provider'
export * from './message'
