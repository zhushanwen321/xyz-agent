const COLOR_PATTERN = /^(bg|text|border|ring|outline|shadow|from|to|via|fill|stroke|divide|placeholder|decoration|caret)-(\[#[0-9a-fA-F]+\]|\[rgb|\[hsl|\[oklch|(?:red|orange|yellow|green|blue|indigo|violet|purple|pink|rose|slate|gray|zinc|neutral|stone|amber|lime|emerald|teal|cyan|sky|fuchsia)-\d)/;

const ALLOWED_TOKENS = new Set([
  // project tokens
  'base', 'surface', 'elevated', 'inset', 'ai', 'user',
  'tertiary', 'inverse',
  'border-default', 'border-hover',
  'semantic-green', 'semantic-green-hover', 'semantic-green-muted',
  'semantic-blue', 'semantic-yellow', 'semantic-red',
  // shadcn-vue
  'background', 'foreground',
  'card', 'card-foreground',
  'popover', 'popover-foreground',
  'primary', 'primary-foreground',
  'secondary', 'secondary-foreground',
  'muted', 'muted-foreground',
  'accent', 'accent-foreground',
  'destructive', 'destructive-foreground',
  'input', 'ring',
]);

function checkClassAttr(context, node) {
  if (node.key.name !== 'class' || !node.value) return;
  const classStr = node.value.value;
  if (!classStr) return;
  for (const token of classStr.split(/\s+/)) {
    const colorPart = token
      .replace(/^(?:bg|text|border|ring|outline|shadow|from|to|via|fill|stroke|divide|placeholder|decoration|caret)-/, '')
      .replace(/\/\d+$/, '');
    if (COLOR_PATTERN.test(token) && !ALLOWED_TOKENS.has(colorPart)) {
      context.report({ node, messageId: 'hardcoded', data: { value: token } });
    }
  }
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow hardcoded colors in Vue template class attributes' },
    messages: { hardcoded: 'Use design token instead of hardcoded color: `{{value}}`' },
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
