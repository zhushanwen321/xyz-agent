/**
 * 品味规则：xyz-ui 组件上优先使用 v-model 而非 :value=
 *
 * PascalCase 组件（xyz-ui 约定）若使用单向 :value= 绑定，
 * 通常应该用 v-model 实现双向绑定。
 * 由于 eslint-plugin-vue 的 processor 会将 .vue 拆分为纯 JS blocks，
 * 使用 Program:exit + 源码正则扫描。
 */
export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Prefer v-model over :value on xyz-ui components' },
    messages: {
      preferVModel: 'Use v-model instead of :value on xyz-ui components',
    },
    fixable: null,
  },
  create(context) {
    const filename = context.filename || ''
    if (!filename.endsWith('.vue')) return {}

    const sourceCode = context.sourceCode || context.getSourceCode()
    const text = sourceCode.getText()

    // 只扫描 <template> 部分
    const templateMatch = text.match(/<template[^>]*>([\s\S]*?)<\/template>/)
    if (!templateMatch) return {}

    const templateContent = templateMatch[1]
    const templateOffset = templateMatch.index + templateMatch[0].indexOf('>') + 1

    const lines = text.split('\n')
    const lineStarts = [0]
    for (const line of lines) {
      lineStarts.push(lineStarts[lineStarts.length - 1] + line.length + 1)
    }

    function offsetToLine(offset) {
      for (let i = lineStarts.length - 1; i >= 0; i--) {
        if (lineStarts[i] <= offset) return i + 1
      }
      return 1
    }

    // 逐行扫描：PascalCase 标签 + :value= 但无 v-model
    const templateLines = templateContent.split('\n')
    const issues = []

    for (let i = 0; i < templateLines.length; i++) {
      const line = templateLines[i]
      // 检测是否包含 PascalCase 组件标签
      if (!/<[A-Z][A-Za-z]*/.test(line)) continue
      // 检测 :value= 绑定
      if (!/:value\s*=/.test(line)) continue
      // 如果同时有 v-model 则没问题
      if (/v-model/.test(line)) continue

      issues.push(templateOffset + templateContent.split('\n').slice(0, i).join('\n').length)
    }

    return {
      'Program:exit'(node) {
        for (const offset of issues) {
          const line = offsetToLine(offset)
          context.report({
            node,
            loc: { line, column: 0 },
            messageId: 'preferVModel',
          })
        }
      },
    }
  },
}
