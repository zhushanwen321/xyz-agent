import tasteConfig from './taste-lint/vue.mjs';

export default [
  ...tasteConfig,
  {
    ignores: [
      'src/dist/**',
      'src-tauri/**',
      'sidecar/dist/**',
      'taste-lint/**',
    ],
  },
];
