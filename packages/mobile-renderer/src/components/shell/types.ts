/**
 * 移动端 shell 共享类型（spec P4 DM1）。
 * 从 .ts 文件导出而非 .vue（vue SFC 的 named type export 经 tsconfig declare module '*.vue'
 * 通配符无法解析，故抽到独立 .ts）。
 */
export type MobileTab = 'sessions' | 'files' | 'settings'
