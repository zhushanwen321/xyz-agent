const SPACING_PREFIXES = /^(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|space|inset)(?:-|$)/;
const ARBITRARY_VALUE = /\[\d+(?:px|rem|em)\]/;

function checkClassAttr(context, node) {
  if (node.key.name !== 'class' || !node.value) return;
  const classStr = node.value.value;
  if (!classStr) return;
  for (const token of classStr.split(/\s+/)) {
    if (SPACING_PREFIXES.test(token) && ARBITRARY_VALUE.test(token)) {
      context.report({ node, messageId: 'magic', data: { value: token } });
    }
  }
}

export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow arbitrary spacing values in Vue template class attributes' },
    messages: { magic: 'Use Tailwind spacing scale instead of arbitrary value: `{{value}}`' },
  },
  create(context) {
    const ps = context.sourceCode?.parserServices;
    if (ps?.defineTemplateBodyVisitor) {
      return ps.defineTemplateBodyVisitor({
        VAttribute(node) { checkClassAttr(context, node); },
      });
    }
    return {};
  },
};
