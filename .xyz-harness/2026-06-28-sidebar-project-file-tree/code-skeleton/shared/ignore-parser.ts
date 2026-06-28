/**
 * code-skeleton/shared/ignore-parser.ts — .gitignore 规则编译 + 路径匹配纯函数（⑤code-arch §3，#1 D-013）
 *
 * 纯函数范式（D-013：仿 git-status-parser 豁免，不包 port）。放 shared 非 infra——纯函数无 IO/无外部依赖。
 * FileService 经 IFileExecutor.readFile 读 .gitignore 内容（IO 走 port），再调本纯函数匹配（计算走 shared）。
 *
 * 双模式（D-020）：matchPath 纯函数本身不变。FileService 编排层分双模式——
 *   默认隐藏（matchPath=true 的节点移除）/ 显示模式（保留 + 标 ignored=true）。
 *
 * ⚠️ negate（!foo）/嵌套 .gitignore 判定一致性（④NFR D-4）：⑤骨架补用例验证 ignored 标志在复杂规则下正确。
 *
 * 接线层级：[叶子] 纯函数。
 * 不变式：无 node:fs import（AC-1.3 grep 验证）；无外部依赖。
 */

/** 编译后的 ignore matcher（不透明，由 compileIgnoreRules 产出，matchPath 消费）。 */
export interface IgnoreMatcher {
  /** 已编译的规则集（内部表示，调用方不直接读）。 */
  readonly patterns: ReadonlyArray<{ negate: boolean; regex: RegExp }>
}

/**
 * 编译 .gitignore 内容为 matcher。
 * @param content .gitignore 文件文本（多行 glob 规则，支持 ! 取反）
 * @returns IgnoreMatcher（content 空→空 matcher）
 */
export function compileIgnoreRules(content: string): IgnoreMatcher {
  const patterns = content
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(line => {
      const negate = line.startsWith('!')
      const glob = negate ? line.slice(1) : line
      // glob → regex（简化骨架：转义特殊字符 + * → [^/]* + ** → .*）。⑤骨架只验签名，实现⑥Wave 填。
      const regex = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'))
      return { negate, regex }
    })
  return { patterns }
}

/**
 * 判定路径是否被 ignore 规则匹配。
 * @returns true=被匹配（应隐藏/标 ignored）；false=不匹配。
 * negate（!foo）规则：取反语义，后规则覆盖先规则（与 git 一致）。
 */
export function matchPath(matcher: IgnoreMatcher, path: string): boolean {
  let ignored = false
  for (const p of matcher.patterns) {
    if (p.regex.test(path)) ignored = !p.negate
  }
  return ignored
}
