/**
 * fs-guard 实现（纯逻辑）——由 test/fs-guard.ts 的 vi.mock 工厂动态 import。
 *
 * 为什么独立成文件且零 `import 'node:fs'`：vi.mock 工厂被 vitest 提升到 setupFiles 模块
 * 顶部执行，引用模块级声明会 TDZ；本文件经工厂动态 import 加载，若顶部再 ESM import
 * node:fs 会触发刚注册的 mock 工厂 → 循环依赖。realpathSync 改经 createRequire 取
 * CJS 原始模块（vi.mock 只拦 ESM import 链），guard 自身不经过自己安装的 wrapper。
 *
 * 语义见 test/fs-guard.ts 文件头（[HISTORICAL] 2026-09-02 会话丢失事故）。
 */
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const realFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')

/** 真实用户数据目录（与 apps/electron/main 的打包态缺省一致，homedir 动态推导）。 */
const REAL_DATA_DIR = resolve(join(homedir(), '.xyz-agent'))

/**
 * 路径的判定形式全集：resolve 形式（逻辑规范化，不解析 symlink）+ realpath 形式
 * （symlink 真身，目标存在时）。双形式必要性（macOS 实测）：os.tmpdir() 返回
 * /var/folders/...，而测试路径经 realpathSync 后是 /private/var/folders/...——
 * 单形式前缀匹配会把合法 tmp fixture 误拦。realpath 形式同时是 symlink 别名的
 * 权威判定面（/tmp/link → ~/.xyz-agent 的真身必须被拒）。
 */
function pathVariants(p: string): string[] {
  const variants = [resolve(p)]
  try {
    variants.push(realFs.realpathSync(p))
  } catch {
    // 目标不存在（mkdir/writeFile 新建场景）的有意降级：resolve 形式参与匹配。创建类的
    // symlink 别名绕过由 AGENTS「禁止绕过 guard」条款约束（删除类目标必然存在，realpath
    // 权威判定覆盖）。void 0 标记非空块（no-empty）。
    void 0
  }
  return [...new Set(variants)]
}

function matchesPrefix(p: string, whitelist: string[]): boolean {
  return whitelist.some((w) => p === w || p.startsWith(w + sep))
}

function whitelistPrefixes(): string[] {
  const raw = [resolve(tmpdir()), resolve(join(homedir(), '.xyz-agent-dev'))]
  if (process.env.XYZ_AGENT_DATA_DIR) raw.push(resolve(process.env.XYZ_AGENT_DATA_DIR))
  const prefixes: string[] = []
  for (const p of raw) {
    prefixes.push(...pathVariants(p))
  }
  return [...new Set(prefixes)]
}

/** 真实数据目录判定形式全集（resolve + realpath，拒绝对 symlink 别名不透明）。 */
function realDataDirVariants(): string[] {
  return pathVariants(REAL_DATA_DIR)
}

/** 路径是否落在真实数据目录内（无条件拒绝区；任一形式命中即拒）。导出供 fs-guard.test.ts 单测。 */
export function isRealDataDir(p: string): boolean {
  const realForms = realDataDirVariants()
  return pathVariants(p).some((v) => matchesPrefix(v, realForms))
}

/** 路径是否允许作为破坏性 fs 操作目标（任一形式落在白名单即放行）。导出供 fs-guard.test.ts 单测。 */
export function isDestructiveAllowed(p: string): boolean {
  if (isRealDataDir(p)) return false
  return pathVariants(p).some((v) => matchesPrefix(v, whitelistPrefixes()))
}

/** 提取参数中的路径形态（string / file URL）；Buffer / fd / options 对象返回 null 跳过。 */
function pathOf(arg: unknown): string | null {
  if (typeof arg === 'string') return resolve(arg)
  if (arg instanceof URL) {
    try {
      return resolve(fileURLToPath(arg))
    } catch {
      return null
    }
  }
  return null
}

function guardPaths(fnName: string, paths: unknown[]): void {
  for (const arg of paths) {
    const p = pathOf(arg)
    if (p === null || isDestructiveAllowed(p)) continue
    throw new Error(
      `[vitest-fs-guard] BLOCKED ${fnName} → ${p}\n` +
        `  破坏性 fs 操作只允许落在白名单目录：${whitelistPrefixes().join(' | ')}\n` +
        `  真实数据目录 ${REAL_DATA_DIR} 无条件禁止（2026-09-02 会话丢失事故防线）。\n` +
        `  修复方向：测试夹具用 mkdtempSync(join(tmpdir(), ...)) 自建自删；确需持久数据目录时` +
        ` 设 XYZ_AGENT_DATA_DIR 指向 dev 目录（~/.xyz-agent-dev），禁止指向 ~/.xyz-agent。`,
    )
  }
}

export const FS_SYNC_FNS = [
  'rmSync', 'unlinkSync', 'rmdirSync', 'renameSync', 'cpSync', 'copyFileSync',
  'mkdirSync', 'writeFileSync', 'appendFileSync', 'truncateSync',
] as const

export const FS_ASYNC_FNS = [
  'rm', 'unlink', 'rmdir', 'rename', 'cp', 'copyFile',
  'mkdir', 'writeFile', 'appendFile', 'truncate',
] as const

/**
 * 各 API 的校验参数位：
 * - rename（src 被移走 = 破坏性）：src + dest 双端校验
 * - cp / copyFile（src 只读不破坏）：只校验 dest——src 从包内 fixtures 复制到 tmp 是
 *   标准测试形态（读源无损害，拦 src 会误伤全部 fixture 复制用例）
 * - 其余：只校验首参（次参可能是 string 文件内容，如 writeFileSync(path, data)）
 */
const RENAME_FNS = new Set(['renameSync', 'rename'])
const DEST_ONLY_FNS = new Set(['cpSync', 'cp', 'copyFileSync', 'copyFile'])
/** slice 参数位（具名常量，no-magic-numbers；0/1 在规则默认豁免内）。 */
const TWO_ARGS = 2

/** 对 actual 模块做浅拷贝并替换破坏性函数为 wrapper（读函数原样透传）。 */
export function wrapModule(actual: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const wrapped = { ...actual }
  for (const name of names) {
    const orig = actual[name]
    if (typeof orig !== 'function') continue
    const argSlice = RENAME_FNS.has(name) ? [0, TWO_ARGS] : DEST_ONLY_FNS.has(name) ? [1, TWO_ARGS] : [0, 1]
    wrapped[name] = function (this: unknown, ...args: unknown[]) {
      guardPaths(name, args.slice(argSlice[0], argSlice[1]))
      return (orig as (...a: unknown[]) => unknown).apply(this, args)
    }
  }
  return wrapped
}
