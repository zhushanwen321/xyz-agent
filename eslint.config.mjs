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
  // [HISTORICAL] useContenteditableInput.ts 是 composer 富文本输入的唯一聚合点：
  // 视觉行移动（getClientRects+caretRangeFromPoint）+ segments 解析（getSegmentsFromEl）
  // + 草稿/光标/IME/粘贴事件处理 + Cmd+V 双通路图片粘贴。各职责共享 savedRange/preferredX
  // 闭包与 contenteditable DOM 语义，强行拆分会破坏闭包封装或引入跨模块状态同步。
  // 行数在 wave4（双通路粘贴）后超 500，短期 max-lines override 避免阻塞。
  {
    files: ['packages/renderer/src/composables/panel/useContenteditableInput.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] useChatStore 是 Pinia chat store 的唯一 setup 函数（defineStore('chat', () => {...})），
  // 包含所有 chat state（messages Map 分区 / streaming / pending / retry / queue）+ 全部 action
  // （appendUser/appendPending/applyMessageEvent/finalize/hydrate/truncateFrom 等 30+ 方法）。
  // 与 event-adapter/session-service 同性质——唯一聚合中心，职责内聚但函数体行数超 300。
  // max-lines-per-function 规则对 Pinia setup 函数不适用（setup 天然是单一大函数），override 避免误报。
  // max-lines：chat.ts 作为消息流核心 store 承载多种消息类型处理（assistant 流式 + bash 执行 +
  // subagent + compaction/branch + retry/queue + LRU + handoff + changeset），职责内聚但行数超 500
  // （当前 ~900 行，main 分支基线已 872 行）。同质于 event-adapter/session-service 的唯一聚合中心，
  // 短期 max-lines override 避免阻塞，长期应拆分为 chat-core + chat-effects 子模块。
  {
    files: ['packages/renderer/src/stores/chat.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-lines': 'off',
    },
  },
];
