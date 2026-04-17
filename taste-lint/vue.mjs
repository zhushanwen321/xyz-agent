import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import baseConfig from './base.mjs';
import { tastePlugin, tasteRules } from './rules/index.mjs';

export default [
  ...baseConfig,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
    plugins: { taste: tastePlugin },
    rules: {
      ...tasteRules,
      'vue/no-v-html': 'error',
      'vue/component-name-in-template-casing': ['error', 'PascalCase'],
      'vue/multi-word-component-names': 'off',
    },
  },
];
