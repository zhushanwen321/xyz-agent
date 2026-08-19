/**
 * 品味规则（data-source-governance R2 骨架）：store mutation 只能被 owner 文件直呼
 *
 * 每个登记在案的 store mutation 的直呼许可来自数据源登记表
 * （docs/architecture/data-source-registry.md，父文档 §3.6 R2：许可表来自登记表，
 * 登记表条目驱动逐步收紧）。首版拦「直呼形态」：文件 import 目标 store 后，在许可
 * 文件之外对 store 实例直调受管 mutation —— 跨文件调用图分析留 W24（plan W4 步骤 2）。
 *
 * 已知检出边界（docstring 声明，W24 收紧对象）：
 * - 方法引用传递（如 bindSessionListBroadcast 的整表快照回调注入）与参数注入形态
 *   （core useChat/use-session 经 port 接收 store）不可见——本规则只看 import 边直呼；
 * - 接收者变量需可追溯到 store 工厂调用（const s = useSessionStore()），
 *   形参/解构等间接形态不追踪。
 *
 * 首版许可清单（= 登记表条目声明的现行写路径实现文件；owner 化目标落地后同步删条目）：
 * - owner（mutation 定义处）：stores/session.ts（pinia 注册壳）+ core domain/session/store.ts（factory）；
 * - useSidebar.ts：#1「renderer store 三路写」的 applySnapshot 整表形态（列表载入/config.sessions
 *   广播，原 setGroups/updateLabel 写路径 W13 收敛为唯一入口）+ rename 乐观更新（单 session 形态）；
 * - useModel.ts：#1 三路写的 applySnapshot 单 session 形态（模型/思考等级乐观更新，
 *   原 updateSessionState 写路径，useModel docstring 声明）。
 *
 * 误报豁免闭环（对齐 check-domain-boundaries allowlist 先例）：规则拦到合法写入时，
 * 豁免路径 = 先在 data-source-registry.md 补条目/例外 + 本文件 PERMITTED_FILES 登记，
 * 再加行内豁免注释 `taste:allow-non-owner-mutation`——禁止只加注释不登记。
 */

/** 受管 mutation → 登记表条目引用（登记表 §1 主表；新增受管 mutation 须先在登记表落条目）。
 *  W13 起三入口（setGroups/updateLabel/updateSessionState）收敛为唯一写入口 applySnapshot。 */
const WATCHED_MUTATIONS = {
  applySnapshot: '#1（renderer 三路写）/ #2（session 列表载入 + modelId/thinkingLevel 局部更新）——W13 起唯一写入口',
}

/** session store 工厂的 import 识别：绑定名 + import source 形态（renderer 壳 / core 包出口 / core 深路径） */
const STORE_FACTORY_NAMES = new Set(['useSessionStore', 'createSessionStore'])
const STORE_SOURCE_RE =
  /(^|\/)stores\/session(\.ts)?$|^@xyz-agent\/core$|\/domain\/session(\/(store|index))?(\.ts)?$/

/**
 * 许可文件（按路径后缀匹配）。owner 定义处 + 登记表声明的现行写路径实现文件，
 * 每条注明依据；收紧 = owner 化 wave 落地后删除对应条目（登记表条目驱动逐步收紧）。
 */
const PERMITTED_FILES = [
  // owner：mutation 定义处（pinia 注册壳）
  'packages/renderer/src/stores/session.ts',
  // owner：mutation 定义处（core factory 本体）
  'packages/core/src/domain/session/store.ts',
  // #1/#2 现行写路径：applySnapshot 唯一写入口的整表形态（config.sessions 广播/列表载入）+ rename 乐观更新
  'packages/renderer/src/composables/features/sidebar/useSidebar.ts',
  // #1 现行写路径：applySnapshot 单 session 乐观更新（switchModel/setThinkingLevel）
  'packages/renderer/src/composables/features/model/useModel.ts',
]

const INLINE_ALLOW_RE = /taste:allow-non-owner-mutation/

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow direct calls to registered store mutations outside permitted owner files (data-source-governance R2 first version: import-edge direct-call detection)',
    },
    schema: [],
    messages: {
      nonOwnerMutation:
        'store mutation {{mutation}} 只能被许可文件直呼，当前文件不在许可表内（登记条目：{{entries}}）。' +
        '合法路径：改经 owner 文件暴露的编排方法；确属新增合法写方：先在 docs/architecture/data-source-registry.md ' +
        '补条目/例外并在规则 PERMITTED_FILES 登记，或加行内豁免注释 taste:allow-non-owner-mutation。',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? ''

    if (
      filename.includes('.test.') ||
      filename.includes('.spec.') ||
      filename.includes('__tests__')
    ) {
      return {}
    }
    if (PERMITTED_FILES.some((suffix) => filename.endsWith(suffix))) return {}

    // store 工厂绑定名（import { useSessionStore } from '@/stores/session' 等）
    const factoryBindings = new Set()
    // store 实例变量名（const s = useSessionStore()，任意作用域）
    const instanceBindings = new Set()
    // 候选违规（property 名受管 + 接收者为 Identifier/工厂调用），Program:exit 统一裁决——
    // 合法 JS 允许「声明晚于引用它的函数体」（函数先定义、store 后声明），单遍词法序会漏检
    const candidates = []

    return {
      ImportDeclaration(node) {
        // type-only import 不引入运行时绑定，不构成直呼通道
        if (node.importKind === 'type') return
        if (!STORE_SOURCE_RE.test(node.source.value)) return
        for (const spec of node.specifiers) {
          if (
            spec.type === 'ImportDefaultSpecifier' ||
            spec.type === 'ImportSpecifier'
          ) {
            const importedName =
              spec.type === 'ImportSpecifier' && spec.imported.type === 'Identifier'
                ? spec.imported.name
                : spec.local.name
            if (STORE_FACTORY_NAMES.has(importedName)) {
              factoryBindings.add(spec.local.name)
            }
          }
        }
      },

      VariableDeclarator(node) {
        if (
          node.init?.type === 'CallExpression' &&
          node.init.callee.type === 'Identifier' &&
          factoryBindings.has(node.init.callee.name) &&
          node.id.type === 'Identifier'
        ) {
          instanceBindings.add(node.id.name)
        }
      },

      CallExpression(node) {
        const { callee } = node
        if (callee.type !== 'MemberExpression') return
        if (callee.property.type !== 'Identifier') return
        const mutation = callee.property.name
        if (!Object.prototype.hasOwnProperty.call(WATCHED_MUTATIONS, mutation)) {
          return
        }
        if (
          callee.object.type === 'Identifier' ||
          (callee.object.type === 'CallExpression' &&
            callee.object.callee.type === 'Identifier')
        ) {
          candidates.push({ node, mutation })
        }
      },

      'Program:exit'() {
        const sourceCode = context.sourceCode ?? context.getSourceCode?.()
        for (const { node, mutation } of candidates) {
          const obj = node.callee.object
          // 接收者必须可追溯到 store（实例变量 or 工厂调用直连 useSessionStore().mutation(...)）
          const isInstanceVar =
            obj.type === 'Identifier' && instanceBindings.has(obj.name)
          const isDirectFactoryCall =
            obj.type === 'CallExpression' &&
            obj.callee.type === 'Identifier' &&
            STORE_FACTORY_NAMES.has(obj.callee.name) &&
            factoryBindings.has(obj.callee.name)
          if (!isInstanceVar && !isDirectFactoryCall) continue

          const hasInlineAllow =
            sourceCode &&
            [
              ...sourceCode.getCommentsBefore(node),
              ...sourceCode.getCommentsAfter(node),
            ].some((c) => INLINE_ALLOW_RE.test(c.value))
          if (hasInlineAllow) continue

          context.report({
            node,
            messageId: 'nonOwnerMutation',
            data: { mutation, entries: WATCHED_MUTATIONS[mutation] },
          })
        }
      },
    }
  },
}
