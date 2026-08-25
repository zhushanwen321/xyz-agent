# xyz-agent 架构约束登记表（人读视图）

> **机器权威 = [constraints.json](./constraints.json)**，本文件由 `node scripts/render-constraints.mjs` 生成，**勿手改**——改约束请改 json 后重跑渲染。
> 「约束（摘要）」列仅导航，非权威表述；约束内容的唯一权威源 = 「权威源」列指向的文档。
> scope 为 `global` 的条目每次 CR 必载；其余按改动路径前缀命中（`node scripts/select-constraints.mjs --base main`）。

共 70 条（生成于 2026-08-24）。

## pi 关系（外部依赖边界）

| ID | 约束（摘要） | scope | 权威源 | 执行 |
|---|---|---|---|---|
| C-pi-01 | 不修改 pi 源码、不 fork、不提上游 PR；能力缺口由 @zhushanwen/pi-* extension 自实现 | global | [AGENTS.md](../AGENTS.md) · [0008-extension-bridge-for-navigate-tree](adr/0008-extension-bridge-for-navigate-tree.md) | review: review-arch-boundary |
| C-pi-02 | pi 语义断言权威源 = node_modules 实装版（npm ls 核对版本）；写进代码/文档/测试的 pi 行为声明须附 pi-mono 源码锚点并穷尽 pi 侧消费层 | global | [AGENTS.md](../AGENTS.md) · [0063-session-attachment-invariants](adr/0063-session-attachment-invariants.md) | review: review-business-logic |
| C-pi-03 | runtime 对 pi 数据只有两个动作：调 RPC 命令、订阅事件；pi 能力缺口在 pi 进程内经扩展补齐（appendEntry 持久化） | global | [data-source-governance](architecture/data-source-governance.md) | review: review-data-governance |
| C-pi-04 | pi 严格打包内置（Bun 编译二进制），无系统回退，缺失/启动失败即 fatal error | apps/electron/**、packages/runtime/src/** | [0005-bun-binary-over-npm-package](adr/0005-bun-binary-over-npm-package.md) · [0006-strict-bundled-pi-no-fallback](adr/0006-strict-bundled-pi-no-fallback.md) | hook: `prepare-pi-resources.sh` + review: review-electron-build |
| C-pi-05 | pi-protocol.ts 是 pi 协议真契约：PiEvent 联合全覆盖、字段类型镜像 pi 源码、禁 args ?? input 类防御性双读 | packages/runtime/src/infra/pi/** | [0037-pi-protocol-real-contract](adr/0037-pi-protocol-real-contract.md) | review: review-type-safety |
| C-pi-06 | ~/.xyz-agent 与 ~/.pi/agent 完全隔离；路径禁硬编码，从 getConfigDir()/getPiAgentDir() 动态推导 | global | [0009-xyz-agent-data-dir-isolation-from-pi](adr/0009-xyz-agent-data-dir-isolation-from-pi.md) · [AGENTS.md](../AGENTS.md) | hook: `check_path_whitelist.py` |
| C-pi-07 | pi JSONL 唯一写方 = pi 进程（绝对写规则）；合法边界仅登记三类：sidecar 四后缀 / fork 文件创建型 / restore 归一化白名单 | global | [0062-single-data-owner-absolute-write-rule](adr/0062-single-data-owner-absolute-write-rule.md) · [data-source-registry](architecture/data-source-registry.md) | hook: `check_pi_direct_write.py` + review: review-data-governance |
| C-pi-08 | pi session 文件延迟写入：首次 flush 前禁止 xyz 代码创建/触碰（EEXIST 致 session 永久卡死）；读取必须处理文件不存在 | packages/runtime/src/** | [AGENTS.md](../AGENTS.md) · [data-source-registry](architecture/data-source-registry.md) | review: review-data-governance |
| C-pi-09 | 系统提示词替换走 --system-prompt CLI（仅新会话），追加走 extension before_agent_start hook（每轮热生效）；禁 hook 内整段替换 | extensions/taiji/system-prompt/**、packages/runtime/src/** | [0044-system-prompt-replace-via-cli-append-via-hook](adr/0044-system-prompt-replace-via-cli-append-via-hook.md) | review: review-extension-api |
| C-pi-10 | 非活跃 session 的修改经短命 pi 进程 + RPC（withEphemeralPi），不做直接文件操作 | packages/runtime/src/** | [data-source-governance](architecture/data-source-governance.md) | review: review-data-governance |
| C-pi-11 | 扩展状态变更必须 appendEntry 自描述完整记录；禁借 pi 文件当私有数据库、禁逆向解析 toolCall/toolResult 编码 | extensions/** | [data-source-governance](architecture/data-source-governance.md) | review: review-data-governance |

## 数据治理（单一数据拥有者体系）

| ID | 约束（摘要） | scope | 权威源 | 执行 |
|---|---|---|---|---|
| C-data-01 | 单一数据 owner：缓存不得存在权威源之外的第二写入者（判据=第二写方，有则收编或删除） | global | [0062-single-data-owner-absolute-write-rule](adr/0062-single-data-owner-absolute-write-rule.md) · [data-source-governance](architecture/data-source-governance.md) | review: review-data-governance |
| C-data-02 | 新 GUI 数据先在 data-source-registry.md 登记再写代码；新模块级缓存必须带 @data-owner 注解（R3） | global | [data-source-registry](architecture/data-source-registry.md) | hook: `eslint.config.mjs` + review: review-data-governance |
| C-data-03 | 投影只发生一次：派生逻辑只在 runtime（或 core 唯一实现）；renderer 零派生，stores 是视图模型容器，WS 消息 view-ready | packages/renderer/src/**、packages/core/src/**、packages/runtime/src/** | [data-source-governance](architecture/data-source-governance.md) | review: review-data-governance |
| C-data-04 | 事件只做失效不直写数据：标量状态快照重拉（ReplicatedState），append-only 走单一 applyEntry reducer；不发明第三种模式 | packages/renderer/src/**、packages/runtime/src/** | [data-source-governance](architecture/data-source-governance.md) | review: review-data-governance |
| C-data-05 | live ≡ reload 构造性成立：实时与持久化两通路共用同一 reducer / 分组规则表 / shared 常量；不丢弃任何 pi entry 类型 | packages/renderer/src/**、packages/core/src/** | [AGENTS.md](../AGENTS.md) · [conversation-turn-attribution](architecture/conversation-turn-attribution.md) | review: review-data-governance |
| C-data-06 | 派生数据不落第二份：禁给 Message 物化 turnId/placement 类派生字段（物化值即第二真相） | packages/renderer/src/**、packages/core/src/** | [conversation-turn-attribution](architecture/conversation-turn-attribution.md) | review: review-data-governance |
| C-data-07 | 快照合并 = 权威源整字段覆盖（含显式空值）；字段空值语义是 ReplicatedState 配置的一部分，禁同字段双登记相反语义 | packages/runtime/src/** | [data-source-governance](architecture/data-source-governance.md) | review: review-data-governance |
| C-data-08 | 队列按字段分权威：深度 = pi 计数快照；内容 = renderer 提交日志；xyz 扩展禁 sendUserMessage 注入队列；消费按计数 FIFO 禁文本匹配 | packages/renderer/src/**、extensions/** | [data-source-governance](architecture/data-source-governance.md) · [data-source-registry](architecture/data-source-registry.md) | review: review-data-governance |
| C-data-09 | 跨进程共享文件（≥2 进程写）必须同锁协议：同一把锁 + 锁内读改写 + 只写声明字段域；新共享文件先登记锁协议再写代码 | packages/runtime/src/**、apps/electron/** | [data-source-registry](architecture/data-source-registry.md) | review: review-data-governance |
| C-data-10 | attach 必断言：switchSession 后 get_state 比对 sessionFile，不一致即 throw；会话内容禁入 $TMPDIR | packages/runtime/src/** | [0063-session-attachment-invariants](adr/0063-session-attachment-invariants.md) | review: review-data-governance |
| C-data-11 | JSON 落盘统一 atomicWrite（write-tmp + rename）+ 每域一 JSON + dirty/debounce/flushAll；禁 writeFileSync 直写主文件 | packages/runtime/src/**、apps/electron/** | [0004-atomic-write-for-config-files](adr/0004-atomic-write-for-config-files.md) | review: review-arch-boundary |
| C-data-12 | session 终态由 runtime 写 .meta.json sidecar（原子写 + 写前 existsSync 守卫），不向 pi JSONL append session_end | packages/runtime/src/** | [0042-runtime-session-end-entry](adr/0042-runtime-session-end-entry.md) | review: review-data-governance |
| C-data-13 | 默认模型：校验基准双源聚合（catalog ∪ auth ∪ custom）+ 用户意图优先 + 收口 default-model-resolver 单点；pi 实际模型对账以 get_state 为唯一真值源 | packages/renderer/src/**、packages/runtime/src/** | [default-model-unified-exit](architecture/default-model-unified-exit.md) | review: review-business-logic |
| C-data-14 | hydrate 记录尾窗锚（piEntryId），load-more 按锚切分只前插；id 去重降级为兜底断言 | packages/renderer/src/**、packages/core/src/** | [conversation-turn-attribution](architecture/conversation-turn-attribution.md) | review: review-data-governance |

## 进程与通信架构

| ID | 约束（摘要） | scope | 权威源 | 执行 |
|---|---|---|---|---|
| C-comm-01 | runtime 三层 transport→services←infra 单向无环；手动 DI 禁 IoC 容器与上帝类；services 间禁具体类循环依赖 | packages/runtime/src/** | [0001-manual-di-over-ioc-container](adr/0001-manual-di-over-ioc-container.md) · [runtime-three-layer-design](architecture/runtime-three-layer-design.md) | hook: `check_no_service_cycle.py` + review: review-arch-boundary |
| C-comm-02 | PiXxx 类型只在 infra/pi 内部可见：services/transport 禁引用 Pi 前缀类型；pi 原始事件经 pi-events.ts 翻译后才进 services | packages/runtime/src/services/**、packages/runtime/src/transport/** | [runtime-three-layer-design](architecture/runtime-three-layer-design.md) | hook: `check_pi_type_leak.py` + review: review-arch-boundary |
| C-comm-03 | services 层 IO 一律经 port 接口（禁直接 import node:fs）；受控例外仅 logger 与 kernel 纯函数两类 | packages/runtime/src/services/** | [runtime-three-layer-design](architecture/runtime-three-layer-design.md) | hook: `check_services_infra_import.py` + review: review-arch-boundary |
| C-comm-04 | EventAdapter 是 pi 协议唯一适配点，pi 格式知识不外溢；sendCommand 必须检查 success 字段 | packages/runtime/src/** | [AGENTS.md](../AGENTS.md) · [0024-filechanges-channel](adr/0024-filechanges-channel.md) | review: review-arch-boundary |
| C-comm-05 | runtime→前端消息必须带 sessionId（缺失被前端忽略）；route-inbound 三通道是分发单一真相源，禁 transport 旁路偷听 | packages/runtime/src/**、packages/renderer/src/**、apps/electron/sidecar/** | [AGENTS.md](../AGENTS.md) · [0060-route-inbound-cross-session-channel](adr/0060-route-inbound-cross-session-channel.md) | hook: `check_sidecar_session.py` + review: review-arch-boundary |
| C-comm-06 | session 级消息必须经 MessageBus publish（单调 seq）；切 session 经 session.subscribe 快照回放 + lastSeq 基线 + gap reconcile；禁绕过 bus 直接 broadcast | packages/runtime/src/**、packages/renderer/src/** | [0055-messagebus-architecture](adr/0055-messagebus-architecture.md) | review: review-arch-boundary |
| C-comm-07 | RPC 调用一律走 command<K>() 类型化原语（payload/返回从协议 Map 推导）；禁 domain 手写 pending.register<{...}> 泛型 | packages/renderer/src/**、packages/shared/src/** | [0046-rpc-type-pairing-ssot](adr/0046-rpc-type-pairing-ssot.md) | review: review-type-safety |
| C-comm-08 | 立即消费的 session 级状态必须主动拉取 RPC（broadcast 早于订阅即丢）；低频数据默认 pull-only 不做 broadcast | packages/renderer/src/** | [AGENTS.md](../AGENTS.md) · [0034-recent-workspaces-pull-only-rpc](adr/0034-recent-workspaces-pull-only-rpc.md) | review: review-arch-boundary |
| C-comm-09 | watchdog 进程健康探测用周期 ping（连续 3 次失败才 abort，仅 turn 进行中）；禁事件静默时长检测与 pause/reset 状态机 | packages/runtime/src/** | [0047-watchdog-ping-replaces-event-silence](adr/0047-watchdog-ping-replaces-event-silence.md) | review: review-business-logic |
| C-comm-10 | renderer 不直连 pi；store/composable/组件禁直调 ws-client.send 与 window.electronAPI，统一经 api 门面（白名单仅 3 个传输封装文件） | packages/renderer/src/** | [context](architecture/context.md) | hook: `check_no_direct_ws_send.py` |
| C-comm-11 | emit 只传单个 payload 对象（禁多参数）；event-bus listener 用模块级 refCount 防重复注册；错误必须重置 isGenerating + streamingMessage | packages/runtime/src/**、packages/renderer/src/** | [AGENTS.md](../AGENTS.md) | review: review-arch-boundary |
| C-comm-12 | extension UI 交互走 extension.ui_request/ui_response 独立通道（禁复用 tool approval）；plugin tool 经 Pi Bridge Extension 代理注册 | packages/runtime/src/**、extensions/taiji/** | [0010-extension-ui-independent-channel](adr/0010-extension-ui-independent-channel.md) · [0012-pi-bridge-extension-for-plugin-proxy](adr/0012-pi-bridge-extension-for-plugin-proxy.md) | review: review-extension-api |

## renderer 状态与包拓扑

| ID | 约束（摘要） | scope | 权威源 | 执行 |
|---|---|---|---|---|
| C-state-01 | per-session 状态统一 useSessionScopedState Map 分区工厂；WS handler 用 updateFor(capturedSid)；禁实例级状态与 watch(sessionId) 手动清空；cleanup 统一编排 | packages/renderer/src/** | [0049-session-isolation-map-partition](adr/0049-session-isolation-map-partition.md) | review: review-arch-boundary |
| C-state-02 | user content 是 Segment[] 判别联合；序列化/反序列化只发生在 pi 边界一处；禁中途正则打平再反解析 | packages/renderer/src/**、packages/shared/src/**、packages/core/src/** | [0043-message-content-segments](adr/0043-message-content-segments.md) | review: review-type-safety |
| C-state-03 | display 字段三条转换路径全透传；过滤只在渲染层（store 保留完整消息）；禁按 customType 维护黑名单 | packages/runtime/src/**、packages/renderer/src/** | [0048-respect-extension-display-field](adr/0048-respect-extension-display-field.md) | review: review-data-governance |
| C-state-04 | 包依赖单向无环：shared ← core（零 DOM 零 electron）← dom-core ← ui ← renderer；禁 DOM 逻辑入 core | packages/shared/**、packages/core/**、packages/dom-core/**、packages/renderer/** | [0058-dom-core-package](adr/0058-dom-core-package.md) · [renderer-rebuild-architecture](architecture/renderer-rebuild-architecture.md) | hook: `check-domain-boundaries.sh` + review: review-monorepo-impact |
| C-state-05 | packages/shared 禁 import node 内置模块（浏览器崩）；node 路径工具归 runtime path-utils；纯计算函数放 shared 须零 IO 零 node 依赖 | packages/shared/src/** | [runtime-three-layer-design](architecture/runtime-three-layer-design.md) | hook: `check_shared_node_builtin.py` |
| C-state-06 | 视图切换状态驱动（settingsStore.currentView）不用 vue-router；Mock 用 VITE_MOCK 在 ws-client 层拦截（mock 不越过通信层） | packages/renderer/src/** | [AGENTS.md](../AGENTS.md) | review: review-arch-boundary |
| C-state-07 | 领域类型 SSOT 归领域层，mock 反向 import 生产类型；禁生产代码从 mock 目录获取类型 | packages/renderer/src/**、packages/core/src/** | [0029-domain-types-ssot-in-lib](adr/0029-domain-types-ssot-in-lib.md) | review: review-type-safety |
| C-state-08 | session 级 renderer 状态三问——存哪里（分区 store/composable）？切走谁清（cleanup 编排）？切回谁喂（恢复腿）？新增 ServerMessageType 的 renderer 消费方 / useSessionEvents 调用点时 CR 必查，三问有明确归属才放行；「onMessage 直写组件本地 ref」反模式由 taste-lint 规则 no-instance-level-session-state 机器拦截 | packages/renderer/src/** | [context-consistency-design](todo/context-consistency-design.md) · [0049-session-isolation-map-partition](adr/0049-session-isolation-map-partition.md) | hook: `taste-lint/base.mjs` + review: review-data-governance |

## extension 体系

| ID | 约束（摘要） | scope | 权威源 | 执行 |
|---|---|---|---|---|
| C-ext-01 | 目录分组（taiji/universal）+ package.json xyz-agent.role + mandatory 清单三处一致；extensions/ 顶层禁放 extension 包 | extensions/** | [extension-conventions](extensions/extension-conventions.md) | hook: `check-extension-dependencies.mjs` |
| C-ext-02 | 唯一合法 namespace @earendil-works/pi-*（四包）；任何文件禁出现 @mariozechner/pi-* | extensions/** | [extension-conventions](extensions/extension-conventions.md) | hook: `install-hooks.sh §2c` |
| C-ext-03 | tool parameters 顶层必须 Type.Object（OpenAI function calling 兼容）；多 action 用扁平 Object + 字段级 Literal Union + 运行时校验范式 | extensions/** | [extension-conventions](extensions/extension-conventions.md) · [tool-schema-openai-compat](extensions/tool-schema-openai-compat.md) | hook: `check_tool_schema.py` |
| C-ext-04 | extension 间依赖必须在根 extension-dependencies.json 声明（runtime/package/optional 三型）；Pi SDK 用 peerDependencies（pi-coding-agent 不可 optional） | extensions/** | [extension-conventions](extensions/extension-conventions.md) | hook: `check-extension-dependencies.mjs` |
| C-ext-05 | 凡调用 pi.on/registerTool/registerCommand/读 ctx.* 的代码，新增/修改必须有 SDK 契约测试覆盖 | extensions/** | [extension-conventions](extensions/extension-conventions.md) | review: review-test-coverage |
| C-ext-06 | 进程级单例必须 globalThis[Symbol.for(包名.角色)] 持有（jiti 路径缓存致模块级 let 互不可见）；会话级状态 session_start 闭包重建；禁模块级 let 状态 | extensions/** | [development-guide](extensions/development-guide.md) | review: review-extension-api |
| C-ext-07 | extension 日志三层通道（tool result / appendEntry custom entry / XYZ_AGENT_DEBUG 文件日志 / ctx.ui.notify）；禁一切裸 console.*；禁 per-extension DEBUG 变量 | extensions/** | [logging-conventions](extensions/logging-conventions.md) | hook: `check_staged_forbidden_lines.py` + review: review-extension-api |
| C-ext-08 | 磁盘配置统一 <agentDir>/config/<简名>-ext-config.json，经 getConfigPath(pkgName) 生成禁自拼；agentDir 从 getAgentDir() 派生 | extensions/** | [extension-conventions](extensions/extension-conventions.md) | review: review-extension-api |
| C-ext-09 | 错误处理两层：内部实现可 throw；execute 是 API 边界必须 catch 返回 { isError: true } + err.message（不含堆栈）；禁错误成功模式 | extensions/** | [extension-conventions](extensions/extension-conventions.md) · [development-guide](extensions/development-guide.md) | review: review-extension-api |
| C-ext-10 | 扩展资源自包含（包目录内 + files 字段全量声明）；生产使用只走 pi install npm:（本地目录仅限 dev 调试） | extensions/** | [extension-conventions](extensions/extension-conventions.md) | review: review-extension-api |
| C-ext-11 | extension 改动优先本地 pi CLI 实测（--mode rpc + stdin JSONL），不是只在 xyz-agent 桌面验证 | extensions/** | [AGENTS.md](../AGENTS.md) | — |
| C-ext-12 | TUI/GUI 环境区分用 ctx.mode === "rpc"（hasUI 在 TUI/RPC 均为 true 不能区分）；event handler 注入消息只能 pi.sendUserMessage；agent_end 禁启动新 LLM 调用 | extensions/** | [extension-conventions](extensions/extension-conventions.md) · [development-guide](extensions/development-guide.md) | review: review-extension-api |

## 打包与分发

| ID | 约束（摘要） | scope | 权威源 | 执行 |
|---|---|---|---|---|
| C-build-01 | Electron 打包三铁律：runtime 源码禁 import.meta.url / globalThis.__dirname（须 typeof guard）；新 runtime 依赖同步 tsup noExternal；打包子系统改动逐 commit 逐验证 | packages/runtime/src/**、apps/electron/**、tsup.config.ts | [AGENTS.md](../AGENTS.md) | hook: `check_runtime_meta_url.py` + hook: `validate-runtime-bundle.sh` + review: review-electron-build |
| C-build-02 | builtin extensions esbuild bundle 后 staged 到 apps/electron/resources/extensions/ 随应用打包（不走运行时 npm）；清单 SSOT = mandatory-extensions.json；删打包依赖致产物缺失是事故高发区 | extensions/**、apps/electron/resources/** | [AGENTS.md](../AGENTS.md) · [0011-bundled-extensions-direct-copy](adr/0011-bundled-extensions-direct-copy.md) | hook: `verify-staged-extensions.mjs` + review: review-electron-build |
| C-build-03 | pnpm workspace 单 root 单 lock（pnpm-lock.yaml 唯一权威）；执行者是项目开发者/CI/AI 用 pnpm，外部消费者用 npm；禁 npm version | global | [AGENTS.md](../AGENTS.md) · [0036-monorepo-structure-target](adr/0036-monorepo-structure-target.md) | review: review-monorepo-impact |
| C-build-04 | runtime/pi 日志必须落盘 + 轮转（date + size 双策略）；pi stdout tee 到 pi-<date>-<sessionId>.jsonl；新增日志库必须加 tsup noExternal | packages/runtime/src/** | [AGENTS.md](../AGENTS.md) | review: review-electron-build |
| C-build-05 | runtime 零 Electron 依赖（纯 Node.js 可独立运行）；renderer 对 Electron 的依赖收敛 lib/ipc.ts 单一适配层（undefined 时优雅降级） | packages/runtime/**、packages/renderer/src/** | [0036-monorepo-structure-target](adr/0036-monorepo-structure-target.md) | review: review-monorepo-impact |
| C-build-06 | 嵌入式网页一律用 WebContentsView；禁 iframe（X-Frame-Options/CSP 硬伤）与 <webview> tag（官方 discouraged） | apps/electron/** | [0054-browser-drawer-webcontentsview](adr/0054-browser-drawer-webcontentsview.md) | review: review-electron-build |

## 工程流程

| ID | 约束（摘要） | scope | 权威源 | 执行 |
|---|---|---|---|---|
| C-proc-01 | vitest 唯一测试框架（禁 node:test / tsx --test）；配置在子包 vitest.config.ts 从子包目录运行；timer 测试用 fake timers | global | [TEST-STRATEGY](../TEST-STRATEGY.md) · [AGENTS.md](../AGENTS.md) | review: review-test-coverage |
| C-proc-02 | 测试三视角缺一不可（构建者白盒 + 使用者黑盒 + 观察者形态）；每条用例至少一个用户可见 DOM 断言 | packages/renderer/**、packages/core/** | [TEST-STRATEGY](../TEST-STRATEGY.md) | review: review-test-coverage |
| C-proc-03 | worktree 创建必须走 git-cwt（自动 install + Electron dist 缓存）；bare repo 模式 origin=.bare、GitHub remote 叫 github；gh 命令带 --repo | global | [AGENTS.md](../AGENTS.md) | — |
| C-proc-04 | pre-commit 检出问题全部正面修复（含存量含 warning）；禁 --no-verify / SKIP_*（仅线上热修复且须 commit message 说明）；禁 eslint-disable-next-line 静默 | global | [AGENTS.md](../AGENTS.md) | hook: `check_staged_forbidden_lines.py` |
| C-proc-05 | 完成即提交：变更验证通过后、汇报完成前必须 git commit；「检查未过」不构成不提交理由（先修复） | global | [AGENTS.md](../AGENTS.md) | — |
| C-proc-06 | push 发布 tag 后必须轮询验证 CI 产物直到验证脚本 exit 0（verify-ci-release.sh / prerelease-test.sh）；禁「应该没问题」 | global | [AGENTS.md](../AGENTS.md) | — |
| C-proc-07 | ENV_WHITELIST_PREFIXES 只许定义在 packages/shared/src/constants.ts，main/runtime 只 import（pre-commit 检查） | packages/**、apps/** | [AGENTS.md](../AGENTS.md) | hook: `check_env_whitelist_sync.py` |

