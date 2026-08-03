/**
 * P0 coexistence spike：renderer 构建产物入口解析（loadFile 用）。
 *
 * 契约（继承父单元 IF1 flag 协议）：
 *   process.env.NEW_ARCH === '1' → 'renderer/dist-new/new-arch/index.html'（新壳骨架产物）
 *   其余（undefined/''/'0'/'false'/任意非 '1'）→ 'renderer/dist/index.html'（原入口，ES1 安全默认）
 *
 * 注意：新壳产物路径含 new-arch/ 子目录——vite 保留源 html 相对 root 的目录结构
 * （源 packages/renderer/new-arch/index.html → 产物 dist-new/new-arch/index.html），零 hack。
 *
 * 与 renderer 侧 vite.config.ts 的 globalThis.__NEW_ARCH__ 同源（都读 process.env.NEW_ARCH），
 * 保证 main loadFile 的 renderer 与 renderer 自认架构一致（否则白屏）。
 * 纯函数无副作用，vitest 可直测。
 */
export function resolveRendererEntry(newArchEnv: string | undefined): string {
  return newArchEnv === '1' ? 'renderer/dist-new/new-arch/index.html' : 'renderer/dist/index.html'
}
