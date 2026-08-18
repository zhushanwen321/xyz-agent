import tasteConfig from './taste-lint/vue.mjs';

export default [
  ...tasteConfig,
  {
    ignores: [
      'src/dist/**',
      'src-tauri/**',
      'taste-lint/**',
      // 独立 CJS 验证脚本（verify-scheduler-e2e.cjs，随 tools→scripts 目录迁移更新路径）：
      // require() 是 CJS 唯一导入方式 + 内部 `_` 占位变量，no-require-imports/no-unused-vars 均误报
      'scripts/*.cjs',
      'vendor/**',
      '.pi/**',
      // 临时/历史 demo 目录（.tmp 已 gitignore，v6 是重构前的遗留 demo）
      '.tmp/**',
      // 构建产物（目录重构后：apps/electron + packages/*）
      'apps/electron/dist/**',
      'apps/electron/renderer/dist/**',
      'apps/electron/renderer/dist-new/**',
      'packages/*/dist/**',
      'apps/electron/preload/preload.js',
      'apps/electron/resources/pi/**',
      'apps/electron/resources/extensions/**',
      // .xyz-harness 是设计文档/骨架代码（spec/plan/code-skeleton），非项目源码，不参与 lint
      '.xyz-harness/**',
      // playwright 测试产物（trace/报告是工具生成的压缩 JS，非项目源码，已被 .gitignore）
      'playwright-report/**',
      'playwright/.cache/**',
      'test-results/**',
      // vitest coverage 产物（工具生成的 JS，已被 .gitignore）
      '**/coverage/**',
      // pi extension 运行时脚本/示例（非 TS 源码，不参与 lint）
      'extensions/*/workflows/**',
      'extensions/*/.pi/workflows/**',
      'extensions/*/examples/**',
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
  // [HISTORICAL] runtime 的 .cjs 文件（plugin-esm-loader.cjs 等）是 Node CJS 模块，
  // require() 是唯一导入方式——no-require-imports 规则对 .cjs 是误报（2026-08-05 添加，
  // sandbox ESM loader 落地时确认：tsup entry 直接打包 .cjs 源文件，无 TS 转换层）。
  {
    files: ['packages/runtime/**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
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
  // [HISTORICAL] renderer markdown 渲染唯一适配层：markdown-it 配置 + fence 规则覆盖 +
  // filepath core rule + KaTeX + segments 拆分 + D-5 增量渲染（findStableBoundary/
  // renderIncremental，2026-08-16 W22 落地）。职责内聚（都消费同一 markdown-it 单例与
  // MarkdownSegment 协议），行数超 500。拆分需先定增量协议归属（W23 消费方对接后），
  // 属独立重构任务。短期 max-lines override 避免阻塞，长期应拆分。
  {
    files: ['packages/renderer/src/composables/logic/markdown.ts'],
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
  // [HISTORICAL] Turn.vue 是 message-stream 的唯一 turn 聚合组件：user 气泡（含 image segment
  // 缩略图）+ assistant summary + trace 区（merged/single 双分支 + Transition 动画）+ streaming
  // 光标 + fork/复制 等操作行。conversation-density slice（merged 卡片）与 main 的 image-attach
  // + trace Transition 合并后行数超 500（template ≤400 / script setup ≤300 均合规，仅总行数超标）。
  // 拆分需先理清 user/summary/trace/action 四块的职责边界，属独立重构任务。短期 override 避免阻塞。
  //
  // [HISTORICAL·模板结构角度] 同文件还有一处历史 override（原 PR #112 补充）：Turn.vue 也是单回合
  // 展示的唯一组件，模板结构（350+ 行）与 script setup（300 行）职责内聚，拆分子组件需传递 15+
  // props/slots，收益不抵成本。useTurnActions 已提取 handler 层，剩余为模板渲染逻辑。
  // 该条与上方 conversation-density 角度的说明规则相同（max-lines: off），原为两处独立 override 块，
  // 现合并为一处（ESLint 合并规则使其功能无碍，合并仅为消除冗余），保留两段决策注释供追溯。
  {
    files: ['packages/renderer/src/components/panel/message-stream/Turn.vue'],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] SystemPage.vue 是 Settings 系统页的唯一聚合组件：语言与外观（locale/theme/fontSize/
  // completionSound/autoRename）+ 系统提示音（success/error 双 Select + 试听）+ 配色主题（muted/colorful
  // swatches）+ 快捷键重录（录制/重置/onRecordKeydown）。各职责共享 SystemSettings props/emit 与
  // commandStore 闭包，强行拆分子组件需传递 10+ props/slots（如快捷键段需 recordingId/DEFAULT_KEYS/
  // shortcutOverrides/startRecording/cancelRecording/onRecordKeydown/resetShortcut 全套），收益不抵成本。
  // 版本检查卡片已拆出 UpdateCheckCard.vue（独立关注点），剩余 538 行均为系统设置内聚职责。
  // 原始已 534 行（github/main 基线即超限），同质于 event-adapter/session-service/Turn.vue 的唯一
  // 聚合中心，短期 max-lines override 避免阻塞。
  {
    files: ['packages/renderer/src/components/settings/SystemPage.vue'],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] ConfigService 是 config 域唯一聚合点（settings-message-handler 全部 config.* case 的
  // 注入端），随功能以纯委托行增长——真实逻辑已在 worktree-config-helper（worktree 偏好 + auto-rename
  // flag/rename 模型）/ config-merge-helpers（system prompt/terminal 合并）等 helper。rename-model 功能
  // +8 行触顶（此前已 499/500 计行，任何新增即超限），拆 Skill CRUD 等区块属独立重构任务，
  // 短期 max-lines override 避免阻塞。
  {
    files: ['packages/runtime/src/services/config-service.ts'],
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
  // [HISTORICAL] useProviderEdit 是 Provider 编辑弹窗的唯一 composable 工厂（同 chat.ts 性质），
  // 承载 form/localModels/headerRows 状态 + test/discover/save 编排 + 模型/headers CRUD +
  // compat 编辑器展开态 + isDirty 快照 + 过期刷新 watch。职责内聚但函数体超 300 行。
  // 与 chat.ts setup 同理：唯一聚合中心，max-lines-per-function 规则不适用，override 避免误报。
  // [HISTORICAL] arch-fix-v2 归位：useProviderEdit 迁至 packages/core/src/domain/settings/（M1a 新包），
  // files 模式补新路径（旧 renderer 路径文件已删，仅保留作迁移记录）。
  {
    files: [
      'packages/renderer/src/composables/features/useProviderEdit.ts',
      'packages/core/src/domain/settings/use-provider-edit.ts',
    ],
    rules: {
      'max-lines-per-function': 'off',
    },
  },
  // [HISTORICAL] createChatStore 是 core 域 chat store 的唯一 setup 函数（自 renderer stores/chat.ts 迁入，
  // P3 chat 域绞杀 w4）。与 renderer chat.ts 同性质——唯一聚合中心，setup 天然是单一大函数，
  // max-lines-per-function 规则不适用（项目已裁定该场景为误报，对齐 renderer chat.ts 同款 override）。
  // B6 *Impl 消除（FR2 内联）后函数体 345 行；深模块化已由 streaming-state-machine 承担（FR1），
  // 不再为绕行数拆分模块级函数（B6 反模式）。
  {
    files: ['packages/core/src/domain/chat/store.ts'],
    rules: {
      'max-lines-per-function': 'off',
    },
  },
  // [HISTORICAL] buildWorkerScript 是 worker 源码生成器——返回单一字符串数组的纯模板函数，
  // 数组每个元素是生成脚本的逐行源码。AC-4 不变式要求脚本格式逐字保留（用户资产：workflow 脚本
  // 依赖 agent/parallel/pipeline/$ARGS/$BUDGET 等注入契约），不可为凑行数随意合并/拆分行。
  // returnMeta 透传补全后函数体超 300（303），属同质唯一聚合中心，override 避免误报。
  {
    files: ['extensions/subagent-workflow/src/orchestration/worker-script-builder.ts'],
    rules: {
      'max-lines-per-function': 'off',
    },
  },
  // [HISTORICAL] i18n settings 字典（zh-CN/en-US 镜像）是 settings 全文案的 SSOT，
  // 每新增一个设置项需双语同步追加。auto-rename-session 开关追加后行数微超 500（501 行），
  // 属唯一聚合中心、结构内聚（扁平 key），强行拆分需设计 per-section 文件组织，
  // 收益不抵成本。短期 max-lines override 避免阻塞。
  {
    files: [
      'packages/renderer/src/i18n/locales/zh-CN/settings.ts',
      'packages/renderer/src/i18n/locales/en-US/settings.ts',
    ],
    rules: {
      'max-lines': 'off',
    },
  },
  // [HISTORICAL] core 包纯净性强制（AC2，renderer-rebuild v2 §11.4 验收基准）：
  // core 零 `node:` / 零 window.electronAPI / 零直接 localStorage/WebSocket（lint 强制）。
  // 平台能力（KVStorage/WebSocketFactory/ipc）经 PlatformPort 注入，禁止绕过。
  // overrides 按 packages/core/src 路径限定，不触碰 renderer/ui/mobile 存量（ES2）。
  // 新增规则时必须先确认 core 现有代码零命中（2026-08-03 审计：零实际使用，仅注释提及）。
  {
    files: ['packages/core/src/**/*.{ts,vue}'],
    rules: {
      'no-restricted-globals': ['error', 'window', 'localStorage'],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'core 包禁止 node: import——平台能力经 PlatformPort 注入' },
            { group: ['ws'], message: 'core 包禁止直连 ws 包——WebSocket 经 PlatformPort.webSocket.create' },
            { group: ['electron'], message: 'core 包禁止 import electron——ipc 经 PlatformPort' },
            // [HISTORICAL] AC10 跨域铁律（W5 drawer-boundaries-gate，FR7 终验收）：
            // domain 内文件禁止 import 任何「@xyz-agent/core/domain/<域>/<内部模块>」包名路径（含同域内部路径——
            // 域内应走相对路径）。合法形态：单层 '@xyz-agent/core/domain/<域>'（index.ts 公开 API，
            // minimatch * 不跨 / 故单层不匹配下方 pattern）或 '@xyz-agent/core'（包入口 index.ts）。
            // 相对路径跨域（深度可变，patterns 无法表达）由 scripts/check-domain-boundaries.sh 兜底。
            // 2026-08-04 审计：domain 下零包名内部路径 import，规则落地零命中。
            { group: ['@xyz-agent/core/domain/*/*'], message: 'AC10 跨域铁律：domain 内禁 import 域内部模块（包名形式）——经 @xyz-agent/core/domain/<域> 公开 index API 或 @xyz-agent/core 包入口消费' },
            { group: ['@xyz-agent/core/domain/*/**/*'], message: 'AC10 跨域铁律：domain 内禁 import 域内部深层模块（包名形式）——经公开 index API 消费' },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'NewExpression[callee.name="WebSocket"]',
          message: 'core 包禁止 new WebSocket——经 PlatformPort.webSocket.create 创建',
        },
      ],
    },
  },
  // [HISTORICAL] subagent-workflow factory（src/index.ts）是 extension 的唯一装配点：
  // 注册 3 tool + 2 command + messageRenderer + pi.__workflowRun + 4 个 session 事件 handler
  // （session_start 单独就 ~100 行：双 Service 装配 + AgentRegistry + store 健康度 + recovery）。
  // 与 event-adapter/session-service/chat.ts 同质——唯一聚合中心，职责内聚但函数体超 300。
  // 拆分需先把 session_start handler 及 makeDeps/log/resolveSessionDir 等闭包内函数提取到
  // 模块级（需透传 pi/sessionState/registry 等大量闭包变量），属独立重构任务。
  // 短期 max-lines-per-function override 避免阻塞（HEAD 版已 321 行超限，属存量）。
  {
    files: ['extensions/subagent-workflow/src/index.ts'],
    rules: {
      'max-lines-per-function': 'off',
    },
  },
  // pi extensions（extensions/**/*.ts）专用规则块。
  // extensions 是无构建的 TS 源码（pi 运行时直接加载），迁自 xyz-pi-extensions 仓库，
  // 与 renderer/runtime 的 Vue/Electron 代码性质不同：
  //   - 缩进：源项目用 tab（pi 生态约定），不强制 2-space。关掉 indent 规则保留既有约定。
  //   - 行数上限：放宽到 1000（源项目约定，extensions 逻辑比 Vue 组件更聚合）。
  //   - 启用迁自 pi-taste-lint 的 4 条 TS 向品味规则（注册在 tastePlugin 但不在默认 tasteRules，
  //     仅在此块开启，不影响 renderer/runtime）。
  {
    files: ['extensions/**/*.ts'],
    rules: {
      'indent': 'off',
      'max-lines': ['warn', { max: 1000, skipBlankLines: true, skipComments: true }],
      'taste/no-unsafe-cast': 'warn',
      'taste/no-unbounded-while-true': 'warn',
      'taste/no-inline-import-type': 'warn',
      'taste/no-unsafe-object-entries': 'warn',
    },
  },
  // [HISTORICAL] resource-discovery.ts 的 3 处 Promise.all（源级/包级/scoped 子包级）触发
  // taste/prefer-allsettled 属规则误报，per-file override 关闭。规则设计针对「独立数据源
  // 可部分降级」场景；本文件三处是 swf-perf-impl cleanup slice（TC2/IF2，见
  // .cw/swf-perf-impl/cleanup-slice-design.json）把串行扫描并行化的产物，硬约束是
  // 输出与异常传播语义均与串行版等价：每级预期失败已由内部既有 catch 面承担
  // （access/readdir/processPackage），未捕获异常必须向上抛（Promise.all 整体 reject
  // ↔ 串行版向上抛）。allSettled + 部分失败返回 [] 是设计中明确否决的 alternative
  // （会吞掉未捕获异常的向上传播，改变调用方可观察行为）。故禁用 eslint-disable 行内
  // 注释形态（taste/no-eslint-disable 语义），统一走本配置级 override。
  {
    files: ['extensions/subagent-workflow/src/shared/resource-discovery.ts'],
    rules: {
      'taste/prefer-allsettled': 'off',
    },
  },
];
