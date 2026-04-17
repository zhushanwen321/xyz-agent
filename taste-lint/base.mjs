import tseslint from 'typescript-eslint';

export default tseslint.config(
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,vue}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
    },
  },
  {
    ignores: ['node_modules/**', 'dist/**', 'src-tauri/**', '*.d.ts', 'taste-lint/**'],
  },
);
