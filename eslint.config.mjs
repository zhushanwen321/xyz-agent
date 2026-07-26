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
  // [HISTORICAL] mock 门面文件是所有 domain 的聚合中心（session/chat/config/model/extension/plugin/
  // settings/workspace/composer 共 9 个域），天然需要超 500 行。拆分到 per-domain 文件需要重构
  // 内部共享函数（pushSession/emit/sleep/fixtureSessions 等），收益不抵成本。fixture 数据已拆到
  // data.ts/settings-data.ts/composer-data.ts/workflow-data.ts。
  {
    files: ['packages/renderer/src/api/mock/index.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] runtime 核心服务聚合点：event-adapter（pi 事件→前端消息的唯一适配层）、
  // extension-service（扩展生命周期 + 路径解析 + 热重载）、session-service（session 生命周期/历史/
  // fork/agentcall 的 facade）。三者都是本子系统的唯一聚合中心，职责内聚但行数超 500。
  // 拆分需先理清职责边界（如 session-service 的 fork vs history vs lifecycle 三块），
  // 属独立重构任务。短期 max-lines override 避免阻塞，长期应拆分。
  {
    files: [
      'packages/runtime/src/infra/pi/event-adapter.ts',
      'packages/runtime/src/services/extension-service.ts',
      'packages/runtime/src/services/session/session-service.ts',
    ],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] protocol.ts 是全 WS 协议的 SSOT（ClientMessageType/ServerMessageType/
  // ClientMessageMap/ServerMessageMap/ReplyPayloadMap + 各域 Config/ErrorCode 类型）。
  // 所有 type 相互交叉引用（ClientMessage<T> 依赖 ClientMessageMap，后者引用所有 payload 类型），
  // 拆分到 per-domain 文件需要重新设计模块边界（如把 ReplyPayloadMap 的 key 列表与 ClientMessageType
  // 解耦），属独立重构任务。与上方 4 个 override 同性质——唯一聚合中心，行数超 500。
  {
    files: ['packages/shared/src/protocol.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
];
