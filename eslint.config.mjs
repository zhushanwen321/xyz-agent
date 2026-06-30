import tasteConfig from './taste-lint/vue.mjs';

export default [
  ...tasteConfig,
  {
    ignores: [
      'src/dist/**',
      'src-tauri/**',
      'runtime/dist/**',
      'taste-lint/**',
      'src-electron/dist/**',
      'src-electron/**/dist/**',
      'tools/*.cjs',
      'src-electron/preload/preload.js',
      'vendor/**',
      'src-electron/resources/pi/**',
      '.pi/**',
      // .xyz-harness 是设计文档/骨架代码（spec/plan/code-skeleton），非项目源码，不参与 lint
      '.xyz-harness/**',
    ],
  },
];
