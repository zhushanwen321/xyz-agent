const NATIVE_ELEMENTS = new Set(['button', 'input', 'select', 'textarea']);
const ALLOWED_TYPES = new Set(['file', 'hidden', 'image', 'range']);

function checkElement(context, node) {
  const tag = node.rawName;
  if (!NATIVE_ELEMENTS.has(tag)) return;
  if (tag === 'input') {
    const typeAttr = node.startTag.attributes.find(
      a => a.type === 'VAttribute' && a.key.name === 'type',
    );
    const typeVal = typeAttr?.value?.value;
    if (typeVal && ALLOWED_TYPES.has(typeVal)) return;
  }
  context.report({ node, messageId: 'native', data: { tag } });
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow native form elements, use shadcn-vue components' },
    messages: { native: 'Use shadcn-vue component instead of native `<{{tag}}>`' },
  },
  create(context) {
    const ps = context.sourceCode?.parserServices;
    if (ps?.defineTemplateBodyVisitor) {
      return ps.defineTemplateBodyVisitor({
        VElement(node) { checkElement(context, node); },
      });
    }
    return {};
  },
};
