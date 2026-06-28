/**
 * code-skeleton/shared/path-guard.ts — isUnderOrEqual 越界校验纯函数（⑤code-arch §3，#1 F2）
 *
 * ►迁自 runtime/utils/path-utils.ts（#1 F2：从 utils 提升到 shared，file-service + git-service +
 * extension-service 三者共用）。
 *
 * ⚠️ 词法判定（④NFR K-1 残余风险）：函数体仅 relative(resolve(parent), resolve(child))，
 * **不解析 symlink**。cwd 内 symlink 指向 cwd 外 = 词法判 true 但实际读外（越权读漏洞）。
 * 对比 extension-service.ts:321-340 已知此向量并补 realpathSync。⑤骨架裁决：FileService 是否
 * 在越界校验前补 realpath 解析（与 extension-service 对齐）。结论回写 ④NFR「需⑤骨架验证」表。
 *
 * 接线层级：[叶子] 纯函数，逻辑完整（迁移非重写，逐字搬移）。
 * 不变式：parent/child 任意路径，返回 child 是否在 parent 子树内或等于 parent。
 */
import { relative, resolve, isAbsolute } from 'node:path'

/** Is `child` under or equal to `parent`? 词法判定（不解析 symlink）。 */
export function isUnderOrEqual(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return !rel.startsWith('..') && !isAbsolute(rel)
}
