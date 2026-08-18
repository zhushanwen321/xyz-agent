/**
 * 品味规则（data-source-governance R3）：模块级缓存必须带 @data-owner 注解且条目真实
 *
 * 模块级可变缓存（new Map/Set/WeakMap、ref/shallowRef/reactive）是「数据多源」病灶的
 * 高发形态（影子状态/第二写方都从这里长出来，见 data-source-governance.md §2.2）。
 * 新增必须先登记 owner 再写代码（登记表 §5 维护规约第 5 条），本规则强制该顺序可机检：
 * 声明处缺 `@data-owner <登记表条目编号>` 注释，或引用的编号不在登记表内 → 报错。
 *
 * 登记表 SSOT：docs/architecture/data-source-registry.md（条目 #1-#12 + P1 已 owner 化声明）。
 * REGISTRY_ENTRIES 与登记表人工同步；登记表 P1 起演进为可执行配置后由配置生成/双向校验。
 *
 * 范围裁定（首版）：仅扫 `packages/renderer/src/stores/`（plan W4 交付物范围——存量可修复
 * 范围仅限 stores/；composables/ 等处的模块级可变缓存补注解 + 扩围随 W24 调用图收紧同批）。
 * 模块级 = Program 顶层声明；defineStore setup 函数体内的 ref/new Map 是 store 实例状态
 * （pinia 管理生命周期），不属本规则目标形态，函数作用域声明一律放行。
 *
 * 豁免（plan W4 步骤 1 指定）：
 * - 测试文件（.test.ts / .spec.ts / __tests__/）；
 * - useSessionScopedState 内部实现（ADR-0049 原语本体——session 隔离基础设施自身持有
 *   模块级 registry/partition Map，是范式源头而非违规，原语本体豁免登记于 EXEMPT_FILES）。
 *
 * 误报豁免闭环（对齐 check-domain-boundaries allowlist 先例）：规则拦到合法缓存时，
 * 豁免路径 = 先在 data-source-registry.md 补条目/例外，再加行内豁免注释
 * `taste:allow-no-data-owner`（禁止只加注释不登记——登记表是 S1/R2/R3 共同依据）。
 */
const REGISTRY_ENTRIES = [
  '#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8', '#9', '#10', '#11', '#12',
  'P1', // plugin sessionData「已 owner 化声明」条目（登记表 §1 末行）
]

/** ADR-0049 原语本体豁免（见文件头注释）：renderer 兼容 re-export 层 + core SSOT 实现 */
const EXEMPT_FILES = [
  // re-export 兼容层，不持有逻辑（core SSOT 的 renderer 壳）
  'composables/useSessionScopedState.ts',
  // 原语本体：sessionCleanupRegistry（模块级 Set）+ Map 分区范式的源头
  'foundation/use-session-scoped-state.ts',
]

/** 视为「模块级缓存声明」的初始化形态：可变容器构造 + Vue 可变响应式原语 */
const CONTAINER_CTORS = new Set(['Map', 'Set', 'WeakMap'])
const REACTIVE_FNS = new Set(['ref', 'shallowRef', 'reactive'])

const DATA_OWNER_RE = /@data-owner\s+(\S+)/
const INLINE_ALLOW_RE = /taste:allow-no-data-owner/

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require @data-owner <registry entry> annotation on module-level cache declarations (data-source-governance R3)',
    },
    schema: [],
    messages: {
      missingOwner:
        '模块级缓存声明缺少 @data-owner 注解（data-source-governance R3）。' +
        '先在 docs/architecture/data-source-registry.md 登记条目（新增条目或并入既有条目），' +
        '再在声明处加注释 `@data-owner <登记表条目编号>`（如 `@data-owner #1`）。',
      unknownEntry:
        '@data-owner 注解引用的条目 {{entry}} 不在 docs/architecture/data-source-registry.md 登记表内。' +
        '改用真实条目编号（#1-#12 / P1），或先在登记表补该条目。' +
        '确属合法缓存且不适用既有条目：先登记表补条目/例外，再加行内豁免注释 taste:allow-no-data-owner。',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? ''

    if (!filename.endsWith('.ts')) return {}
    // 首版范围：stores/ 目录（见文件头「范围裁定」）
    if (!/(^|\/)stores\//.test(filename)) return {}
    // 豁免：测试文件（测试构造数据的缓存非生产状态）
    if (
      filename.includes('.test.') ||
      filename.includes('.spec.') ||
      filename.includes('__tests__')
    ) {
      return {}
    }
    // 豁免：ADR-0049 原语本体（EXEMPT_FILES 按路径后缀匹配，仓库布局无关）
    if (EXEMPT_FILES.some((suffix) => filename.endsWith(suffix))) return {}

    const sourceCode = context.sourceCode ?? context.getSourceCode?.()

    /**
     * 检查声明是否带有效 @data-owner 注解（相邻上方注释块或同行尾注释）。
     * 返回 { messageId, entry }（违规时）或 null（合规/已豁免）。
     */
    function checkAnnotation(node) {
      const comments = [
        ...sourceCode.getCommentsBefore(node),
        ...sourceCode.getCommentsAfter(node),
      ]
      // 相邻上方注释块（结束行紧贴声明行）或声明行同行尾注释才归属该声明，
      // 隔了空行的远处注释不算——防止拿文件头注释冒充注解
      const attached = comments.filter(
        (c) =>
          c.loc.end.line >= node.loc.start.line - 1 ||
          c.loc.start.line === node.loc.start.line,
      )
      if (attached.some((c) => INLINE_ALLOW_RE.test(c.value))) return null

      const entryComment = attached.find((c) => DATA_OWNER_RE.test(c.value))
      if (!entryComment) return { messageId: 'missingOwner' }
      const entry = DATA_OWNER_RE.exec(entryComment.value)[1]
      if (!REGISTRY_ENTRIES.includes(entry)) {
        return { messageId: 'unknownEntry', entry }
      }
      return null
    }

    function isCacheInit(init) {
      if (!init) return false
      if (init.type === 'NewExpression' && init.callee.type === 'Identifier') {
        return CONTAINER_CTORS.has(init.callee.name)
      }
      if (init.type === 'CallExpression' && init.callee.type === 'Identifier') {
        return REACTIVE_FNS.has(init.callee.name)
      }
      return false
    }

    return {
      VariableDeclaration(node) {
        // 模块级 = Program 直接子节点（export const 经 ExportNamedDeclaration 包裹一层）
        const parent = node.parent
        const isModuleLevel =
          parent.type === 'Program' ||
          (parent.type === 'ExportNamedDeclaration' &&
            parent.parent.type === 'Program')
        if (!isModuleLevel) return
        if (!node.declarations.some((d) => isCacheInit(d.init))) return

        const violation = checkAnnotation(node)
        if (violation) {
          context.report({
            node,
            messageId: violation.messageId,
            data: violation.entry !== undefined ? { entry: violation.entry } : {},
          })
        }
      },
    }
  },
}
