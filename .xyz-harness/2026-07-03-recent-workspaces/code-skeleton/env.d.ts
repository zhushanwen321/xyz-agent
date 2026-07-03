// 骨架验证用 node 环境最小 stub（骨架目录无 @types/node，声明编译所需的最小形状）
declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void
  export function readFileSync(path: string, encoding: string): string
}
declare module 'node:path' {
  export function join(...paths: string[]): string
}
declare const process: { cwd(): string; env: Record<string, string | undefined> }
