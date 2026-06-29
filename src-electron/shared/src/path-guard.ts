/**
 * shared/path-guard.ts — isUnderOrEqual 越界校验纯函数（⑤code-arch §3，#1 F2）
 *
 * ►迁自 runtime/utils/path-utils.ts（#1 F2：从 utils 提升到 shared，file-service + git-service +
 * extension-service 三者共用）。迁移非重写，逐字搬移算法。
 *
 * ⚠️ 词法判定（④NFR K-1 残余风险）：函数体仅 relative(resolve(parent), resolve(child))，
 * **不解析 symlink**。cwd 内 symlink 指向 cwd 外 = 词法判 true 但实际读外（越权读漏洞）。
 * 对比 extension-service.ts 已知此向量并补 realpathSync——FileService 是否在越界校验前补 realpath
 * 解析属后续 wave 决策。
 *
 * 接线层级：[叶子] 纯函数，逻辑完整。
 * 不变式：parent/child 任意路径，返回 child 是否在 parent 子树内或等于 parent。
 */
import { relative, resolve, isAbsolute } from 'node:path'

/**
 * 判断 child 是否在 parent 目录下或等于 parent（词法判定，不解析 symlink，④K-1 残余）。
 *
 * 算法：path.relative(parent, child) → 结果为空串/不以 '..' 开头/不以路径分隔符开头 → true。
 * 使用 path.resolve 规范化后再比较，处理 '..' 和多余分隔符。
 *
 * @param parent 父目录绝对路径
 * @param child 待检测路径（绝对或相对，内部 resolve）
 * @returns child 在 parent 下或等于 parent → true
 *
 * 安全语义：用于文件树越界守门（listTree/expandDir/readFile 入口校验 path 不逃出 cwd）。
 */
export function isUnderOrEqual(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return !rel.startsWith('..') && !isAbsolute(rel)
}
