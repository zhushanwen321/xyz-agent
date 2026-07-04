import tasteConfig from './taste-lint/vue.mjs';

export default [
  ...tasteConfig,
  {
    ignores: [
      'src/dist/**',
      'src-tauri/**',
      'taste-lint/**',
      'tools/*.cjs',
      'vendor/**',
      '.pi/**',
      // 构建产物（目录重构后：apps/electron + packages/*）
      'apps/electron/dist/**',
      'apps/electron/renderer/dist/**',
      'packages/*/dist/**',
      'apps/electron/preload/preload.js',
      'apps/electron/resources/pi/**',
      // .xyz-harness 是设计文档/骨架代码（spec/plan/code-skeleton），非项目源码，不参与 lint
      '.xyz-harness/**',
      // playwright 测试产物（trace/报告是工具生成的压缩 JS，非项目源码，已被 .gitignore）
      'playwright-report/**',
      'playwright/.cache/**',
      'test-results/**',
      // vitest coverage 产物（工具生成的 JS，已被 .gitignore）
      '**/coverage/**',
    ],
  },
];
