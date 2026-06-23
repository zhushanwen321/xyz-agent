# 前端↔runtime 真实集成 Wave 计划（第 3+4 项）

> **状态：** 已批准（2026-06-23），待执行。
> **输入：** [gap-analysis.md](./gap-analysis.md)（缺口全景）+ 4 轮决策确认 + 3 个 Explore agent 精确核实。
> **前置：** 第 1+2 项已完成（[plan.md](./plan.md)，commit `74868a15`/`2ba98155`/`0002131f`/`9895610c`）。本文是第 3+4 项的执行文档。
> **执行 worktree：** `~/Code/xyz-agent-workspace/refactor-arch-render-runtime`（分支同名）。
> **派工方式：** 串行执行 W01→W10。每 wave = 1 次 implementer + spec review + code-quality review（subagent-driven-development 铁律）。**不可并行派 implementer**（会冲突）。
> **验证基线（每 wave 都跑）：** `cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run`，git status 干净后才提交。

---

## 0. 决策记录（执行前必读，后续 subagent 不读对话历史）

4 轮决策锁定范围与边界。任何 wave 若想越界，**必须先回到本文档核对**：

| # | 决策 | 选项 | 理由 |
|---|------|------|------|
| D1 | tree-* / 工具审批 | **都不做** | tree 后端就绪但属 Flow-3 范畴；工具审批前后端都缺逻辑。fork 继续用 mock 伪实现 |
| D2 | SubAgent 多 agent 编排 | **不做** | 产品护城河，前后端都大量缺失，整体设计推后 |
| D3 | Plugin 进 Settings | **不做** | 后端 10 个 plugin.* handler 闲置，前端无 PluginPage |
| D4 | 协议缺口深度 | **只做 file_changes**（ADR-0024） | 附件/搜索通道是全新设计，推后 |
| D5 | ServerMessageMap 强类型化 | **作为地基最先做（W01）** | 消除 11 处 `as` 断言 + 所有订阅型 domain 天然带类型 |
| D6 | Markdown 库选型 | **shiki** | 代码高亮质量最好，Electron 桌面端体积影响小 |
| D7 | session.list 类型 | **renderer 加分组 UI** | runtime 推 `SessionGroup[]`（按 cwd 分组），renderer 当扁平用是 bug；对齐 ui-skeleton §49「项目分组」 |
| D8 | commands/context 订阅路由 | **改走 session 通道** | 这两类型带 sessionId，按 routeInbound 现逻辑走 session 通道，组件用 onGlobalType 永远收不到。改用 `events.on(sessionId, handler)` + Composer 透传 sessionId。**不放宽 routeInbound**（CLAUDE.md line 98 sessionId 隔离不变） |
| D9 | context.update 的 cacheHit/modelId | **保留静态占位** | runtime 只推 usagePercent/inputTokens/contextLimit，cacheHit/modelId 无来源；UI 保留占位（假数据，但 UI 不塌陷） |
| D10 | Settings 本轮范围 | **核心增删改查** | Provider 增删改查+discoverModels、Skill/Agent 扫描+启用+删除、Extension toggle。**install/uninstall 多步流推后** |

**本轮不做（明确边界）：** Plugin 进 Settings、SubAgent 编排、tree-*、工具审批（tool.approve/deny）、附件/上下文条目增删通道、@/# 搜索通道、Extension install/uninstall 多步流。

---

## 1. Wave 依赖图

```
W01 (ServerMessageMap + ModelInfo 统一) ← 全部订阅型 domain 的类型地基
 └─ W02 (session.list 分组 UI) ← Sidebar/SearchModal 地基
     ├─ W03 (Markdown shiki 渲染) ← 独立，接 Turn/Block
     ├─ W04 (Composer 接线 4 项: model/thinking/commands/context)
     │   └─ W05 (消息流 part A: 纯字段, thinking_end/tool_call_update/status/complete.usage)
     │       └─ W06 (消息流 part B: store 状态, auto_retry/queue_update)
     │           └─ W07 (消息流 part C: shared 类型扩展, bash/compaction/branch)
     ├─ W08 (Settings Provider CRUD)
     │   └─ W09 (Settings Skill/Agent/Extension CRUD)
     └─ W10 (message.file_changes 协议 + ChangeSetCard, ADR-0024)
```

**关键依赖：**
- **W01 阻塞全部**：订阅型 domain 的类型守卫基础
- **W02 阻塞 W04**：Composer 透传 sessionId 依赖 Sidebar 稳定的基线
- **W05→W06→W07 严格串行**：同改 chat store，逐步加字段（A 字段已存在→B store 状态→C 扩展 shared 类型）
- **W08→W09 串行**：同改 settings 组件，模式一致
- **W03（Markdown）**：W02 后任意点可插，独立；建议 W04 前（消息流改 Turn/Block 前先把 markdown 基础设施铺好）
- **W10（file_changes）**：最大块，唯一动 runtime 源码，放最后

---

## 2. 各 Wave 详细规格

### W01 · ServerMessageMap 类型地基 + ModelInfo 统一

**目的：** 仿 ClientMessageMap 加 ServerMessageMap，让 `ServerMessage.payload` 有 per-type 类型守卫，消除 11 处 `as` 断言（domain 7 + 组件 4）。

**前置阻塞项：统一 ModelInfo。** `api/domains/model.ts` 本地定义了扁平 `ModelInfo`（`{id,name,provider,providerColor?,tag?}`），与 shared/provider.ts 的 `ModelInfo`（`{providerId,providerName,reasoning?,contextWindow?...}`）冲突。ServerMessageMap 的 `'model.list'` 条目无法定型，必须先删本地版、迁回 shared。

**文件（≤5）：**
1. `shared/src/protocol.ts`：加 `interface ServerMessageMap`（复用 12 个已有 payload 接口 + 内联 config.*/model.list 等形状）；改 `ServerMessage` 为泛型 `{ type: T; id?: string; payload: ServerMessageMap[T] }`（方案 B，见核实报告）
2. `shared/src/index.ts`：re-export `ServerMessageMap`
3. `api/domains/model.ts`：删本地 ModelInfo，用 shared；`onModels` 返回 `shared.ModelInfo[]`
4. `api/domains/{config,extension,plugin}.ts` + `api/events.ts`：删 7 处 `as` 断言；`events.onGlobalType` 泛型化（type 收紧 `ServerMessageType`，handler 内 payload 自动收窄；存储层保持宽类型安全擦除）
5. `components/{panel/ModelSelectPopover.vue, settings/SettingsModal.vue}`：删 4 处二级断言；ModelInfo import 改 shared，字段访问对齐（shared.ModelInfo 无 providerColor/tag，需组件适配——见 review 要点）

**验证：** vue-tsc 0 错误（runtime 侧构造消息处顺带得契约校验，若 runtime 报错同步修构造点，记录报告）；vitest 全绿。

**⚠️ 已知类型坑：**
- `useConnection.ts:48` `msg.payload?.sessionId` 横跨多种 type，discriminated union 下访问 `.sessionId` 需先判别或窄断言 `(msg.payload as {sessionId?: string}).sessionId`
- shared.ModelInfo 字段与本地版差异大，ModelSelectPopover 的 `m.provider`/`m.providerColor`/`m.tag` 需重新映射（shared.ModelInfo 有 `providerId`/`providerName`，无 `providerColor`/`tag`——UI 染色逻辑需适配或后端补字段）

**Review 要点：**
- [x] ServerMessageMap 是否覆盖 sendInitialState 推的 7 条 + 各 domain 订阅的全部 type
- [x] 11 处 `as` 断言是否全删（grep `as ProviderInfo|as SkillInfo|as ModelInfo|as ExtensionInfo|as PluginInfo|as AgentInfo` 零命中）
- [x] ModelInfo 统一后，ModelSelectPopover/Composer 的渲染是否正常（不崩、分组/染色不丢）
- [x] events.onGlobalType 泛型化后，runtime 构造消息处有无类型回归
- [x] routeInbound 的 sessionId 访问坑是否处理

**✅ 执行记录（2026-06-23）：**
- 实测原 grep 9 处（非 11），全删。ModelSelectPopover 的 `as ExtensionItem[]`（SettingsModal 扩展本地类型桥接）不在删除目标内，保留（tools/dirName/source 字段统一属 W08）。
- **ServerMessageMap 精确条目超出原 7 条**：额外收紧了 `message.error` / `extension:widget` / `extension:status`（runtime 已固定形状生产，收紧后顺带让 5 个 runtime 测试得契约校验）。其余 message.* / plugin:* / session.commands / context.update 仍占位（W04/W05-W07 收紧）。
- **runtime 测试改动（5 文件）**：`event-adapter-bridge/extension/statusline` 的 `sent[0].payload.X` 字段访问在联合类型下不再合法，加 `as { widgetKey; lines }` / `as { statusKey; text }` 局部断言（数组索引无法自动窄化）；`session-service.test.ts` 的 `findBroadcast` 改为泛型（按 type 收窄返回）；`protocol-extension.test.ts` error.details 访问加窄断言。
- **mock 同构化**：mock config/model/plugin 订阅 handler 从 `GlobalHandler<unknown>` 改为带精确类型（`ProviderInfo[]`/`ModelInfo[]`/`PluginInfo[]` 等），与 real domain 同构，消除组件层断言。mock `onExtensions` 保留 `unknown`（fixture FixtureExtension 带 tools，与 shared ExtensionInfo 结构冲突，统一属 W08）。
- **ModelInfo 字段适配**：shared.ModelInfo 无 providerColor/tag → ModelSelectPopover 加本地 `PROVIDER_COLORS` 映射（anthropic/openai/google + 中性灰兜底），按 `providerId` 取色；tag 字段删除（runtime 无来源，D9 精神不臆造）。分组键改 `providerId`，展示用 `providerName`。
- **chat.ts 新增 `readRecord` helper**：`tool_call_start.input` 原直接 `msg.payload.input` 访问，联合窄化后需经 helper（与既有 `readString` 同模式）。
- 验证：shared tsc / runtime tsc / renderer vue-tsc 全 0 错；renderer vitest 60/60；runtime vitest 925/925；eslint 净。

---

### W02 · session.list 分组 UI（renderer 加分组，对齐后端 SessionGroup[]）

**目的：** 修复类型系统性不匹配（runtime 推 `{groups: SessionGroup[]}`，renderer 当扁平用）。

**文件（5）：**
1. `api/domains/session.ts`：`list()` 返回类型改 `Promise<SessionGroup[]>`，payload 取 `groups`
2. `api/mock/index.ts`：session.list mock 返 `SessionGroup[]`（现有 fixtureSessions 按 cwd 分组）
3. `stores/session.ts`：list ref 类型改 + 加 groups 状态（或派生）
4. `composables/features/useSidebar.ts`：loadSessions 解析 groups（保分组结构供 SessionList，扁平索引供其它消费如 derivedStatus/sessionDigest）
5. `components/sidebar/SessionList.vue`：加分组标题渲染层（按 cwd 分组，组标题 + 组内 SessionItem 列表）

**验证：** mock 模式 Sidebar 显示分组；vue-tsc/vitest 全绿。

**Review 要点：**
- [x] domain list() 返回类型与后端 `{groups: SessionGroup[]}` 对齐
- [x] useSidebar 的 derivedStatus/sessionDigest 等扁平消费是否未被破坏（它们要的是 SessionSummary[]）
- [x] SessionList 分组渲染是否正确（组标题 + 组内项）
- [x] mock 数据分组是否合理（fixtureSessions 的 cwd 是否有 ≥2 组）

**✅ 执行记录（2026-06-24）：**
- **修复真实 bug**：原 domain `list(): Promise<SessionSummary[]>` 在 real 模式结构性失效——useConnection `pending.resolve(msg.id, msg.payload)` 回灌整个 payload `{groups: SessionGroup[]}`，与 `register<SessionSummary[]>` 不匹配。改为 `register<{groups}>` + 解包 `.groups`。
- **store 单一真源重构**：`groups` 为 `ref<SessionGroup[]>`（真源），`list` 降级为 `computed(flatMap)`（派生扁平视图）。消除两处分别维护漂移。新增 `setGroups`/`appendSession` 取代直接的 `session.list = [...]` 赋值（computed 不可赋值）。
- **mock 分组**：fixtureSessions 按 cwd 归组（Map 累积），实际产出 2 组（xyz-agent: s1/s2/s5；work-project: s3/s4）。
- **SessionList 分组渲染**：每组一个 sticky 组标题（Folder 图标 + cwd 末段 + 计数）+ 组内 SessionItem 列表；空态判定改跨组汇总 `totalCount`。
- **Sidebar 透传**：`:sessions` → `:groups="session.groups"`。其余 `session.list.length`/`.find()` 消费因 list 仍为扁平 computed，零改动。
- 验证：vue-tsc 0 错；renderer vitest 60/60（fg1-dataflow 前两测改为断言分组形状）。

---

### W03 · Markdown 渲染（shiki）

**目的：** 补真实缺口（feature-map §三误标「已完成」，实际 renderer 无任何 markdown 库——已复核确认）。

**文件（4）：**
1. 装 `shiki`（`cd src-electron/renderer && npm i shiki`）
2. 新建 `components/panel/message-stream/MarkdownRenderer.vue`：props `content: string`；shiki 双主题（light/dark，对接 design-tokens 的 theme）；列表/表格/代码块/行内代码样式（Tailwind 类）
3. 改 `components/panel/message-stream/Turn.vue`：user content（`:36 {{ turn.user.content }}`）+ 收尾 summary（`:124 <p>{{ summaryText }}</p>`）改用 `<MarkdownRenderer :content="...">`
4. 改 `components/panel/message-stream/Block.vue`：text 块（`:52 whitespace-pre-wrap`）改用 MarkdownRenderer

**验证：** mock 模式发消息能看到 markdown 渲染（标题/列表/代码高亮）；vue-tsc/vitest 全绿。

**Review 要点：**
- [x] shiki 主题是否对接 design-tokens（不硬编码颜色，taste/no-hardcoded-colors 规则）
- [x] 流式光标（Turn.vue 的 streaming 态）在 markdown 渲染下是否正常
- [x] 代码块高亮语言是否覆盖常见（ts/vue/json/bash/md）
- [x] XSS 安全（shiki 默认转义，确认 v-html 只用于 shiki 输出）

**✅ 执行记录（2026-06-24）：**
- **双库组合**：shiki 只做代码高亮，markdown 结构解析用 markdown-it（shiki 不解析 markdown）。两者装到 workspace root（src-electron/node_modules，hoist），renderer package.json 声明依赖。
- **shiki 双主题（dark-plus/light-plus，VSCode 级高亮）**：`codeToHtml` 用 `themes:{dark,light}` + `defaultColor:false`，产出带 `--shiki-dark`/`--shiki-light` CSS 变量的 span。MarkdownRenderer scoped 样式层按 `:root`(暗默认) / `[data-theme="light"]` 切换变量，走 design-tokens 主题机制（ADR-0021-B），不新增硬编码色。
- **markdown-it 配置**：`html:false`（不透传用户原始 HTML，XSS 第一防线）+ `linkify` + `typographer`；外链 `link_open` 加 `target=_blank rel=noopener noreferrer`。shiki highlight 回调同步调 `codeToHtml`，未知语言 fallback typescript。
- **v-html + vue/no-v-html:error**：taste-lint 全局禁 v-html（error）。MarkdownRenderer 局部 `eslint-disable-next-line vue/no-v-html`（带 XSS 安全 rationale），是唯一的 v-html 落点。
- **流式光标**：Turn.vue 的 `<span streaming-cursor>` 是 MarkdownRenderer 的 sibling（非子节点），独立闪烁不受 markdown 重渲染影响。MarkdownRenderer 加 renderSeq 竞态守卫防流式增量下旧渲染覆盖新内容。
- **接线 3 处**：Turn.vue user 气泡（`:36`）+ 收尾 summary（`:124` `<p>`→`<MarkdownRenderer>`）+ Block.vue 中间 text 块（`:28` `<p>`→`<MarkdownRenderer>`）。thinking 块保持纯文本斜体（思考内容非 markdown）。
- 验证：vue-tsc 0 错；eslint 净（4 文件 exit 0）；renderer vitest 60/60。

---

### W04 · Composer 接线 4 项（model/thinking/commands/context）

**目的：** 接通 4 个空壳/半接 handler，让 mock→real 真正可用。

**子任务：**
1. **model.switch**：ModelSelectPopover emit 改带 `{modelId, provider}`（provider 从 group 反查）；Composer.onModelSelect 调 `model.switchModel(props.sessionId, provider, modelId)`；订阅 `model.switched` 回写 currentModelId（domain 加 onModelSwitched）
2. **thinking**：`api/domains/session.ts` 加 `setThinkingLevel(sessionId, level)`；Composer.onThinkingSelect 调用；ThinkingLevelPopover 加 `level` prop 接收当前值（从 SessionSummary.thinkingLevel 取，经 Composer 透传）
3. **session.commands**：CommandPopover 订阅改 `events.on(sessionId, handler)`（Composer 透传 sessionId）；解析 `msg.payload.commands`（`{name,description,source}`，**payload 实际已契约化**）填 slashCommands，删静态 fallback
4. **context.update**：ContextCapacityPopover 订阅改 session 通道（sessionId prop）；字段映射 `used←inputTokens / total←contextLimit / percent←usagePercent`，cacheHit/modelId **保留静态占位**（D9）

**文件（≤5）：**
1. `api/domains/{session.ts(加setThinkingLevel), model.ts(加onModelSwitched)}` + mock/index.ts 对齐
2. `components/panel/Composer.vue`：onModelSelect/onThinkingSelect 实现 + 透传 sessionId 给 CommandPopover/ContextCapacityPopover
3. `components/panel/ModelSelectPopover.vue`：emit 带 provider
4. `components/panel/{ThinkingLevelPopover, CommandPopover, ContextCapacityPopover}.vue`：加 props.sessionId（后两者）；改订阅通道；解析 payload

**验证：** mock 模式切模型/切思考/选命令/context 更新均触发（mock 仅 ack）；vue-tsc/vitest 全绿。

**⚠️ 已知问题：**
- CommandPopover/ContextCapacityPopover 现用 `onGlobalType`（D8 决策改 `events.on(sessionId)`），组件需加 sessionId prop，Composer 透传
- context.update 字段名差异（D9）：`ContextStats.used/total/percent` vs runtime `inputTokens/contextLimit/usagePercent`

**Review 要点：**
- [x] model.switch 是否真调 runtime（非仅本地 ref）；model.switched 订阅是否回写
- [x] thinking 等级切换是否持久（setThinkingLevel + thinkingLevel prop 同步）
- [x] commands/context 订阅是否改 session 通道（非 onGlobalType）；sessionId 是否正确透传
- [x] context.update 字段映射是否正确；cacheHit/modelId 是否保留占位（非崩溃）
- [x] 静态 fallback 是否删除（slashCommands 不再硬编码）

**✅ 执行记录（2026-06-24）：**
- **协议收紧**：`session.commands` → `{sessionId, commands: Array<{name,description?,source}>}`；`context.update` → `{sessionId, usagePercent, inputTokens, contextLimit}`（对齐 runtime session-service/index.ts 生产端）。runtime tsc 0 错（生产端形状本就匹配）。
- **model.switch（子1）**：ModelSelectPopover emit 改 `{modelId, provider}`（provider=providerId，从 group 反查）；ModelGroup 加 providerId 字段。Composer.onModelSelect 调 `modelApi.switchModel(sessionId, provider, modelId)`。model.switched 是请求级 reply（带 id），经 pending 通道 resolve，不需订阅——成功即生效。
- **thinking（子2）**：session domain 加 `setThinkingLevel(sessionId, level)`；mock 同构（持久到 fixture.thinkingLevel）。ThinkingLevelPopover 加 `level?: string` prop（SessionSummary.thinkingLevel 是 string，经 isValidLevel 守卫映射 ThinkingLevel，非法 fallback max）。Composer 从 sessionStore.active?.thinkingLevel 透传。
- **commands/context（子3+4，D8）**：两个 Popover 加 sessionId prop，订阅从 `onGlobalType` 改 `events.on(sessionId)`。sessionId 变化时重订（watch）。payload 经 type 守卫 + 窄断言取字段（events.on 非 onGlobalType，无 per-type 泛型收窄——W01 已知坑）。context.update 字段映射（D9）：used←inputTokens/total←contextLimit/percent←usagePercent，cacheHit/modelId 保留静态占位。删静态 slashCommands fallback。
- **mock session 通道桥接**：mock-ws 只 sim ping→pong，session 通道无来源。故 mock facade 加 `pushSessionState(sessionId)`——switchSession 后经 `events.dispatchSession` 推 session.commands + context.update，模拟 runtime server-push，让组件订阅 mock 模式下也触发（mock/real 同构）。
- **空 catch 修复**：onModelSelect/onThinkingSelect 原空 catch 触 taste/no-silent-catch warning → 改为直接 await（错误自然上抛，与 onSend 的 throw e 模式一致）。
- 验证：shared+runtime+renderer tsc 全 0 错；eslint 净（7 文件 exit 0）；renderer vitest 60/60。

---

### W05 · 消息流 message.* 消费 Part A（纯字段，字段已存在）

**目的：** chat store `appendAssistantChunk` 补 4 个 case，字段已存在无需扩展 shared。

**case：**
- `message.thinking_end`（payload `{sessionId}`）：给最后 ThinkingBlock 设 `endTime`（字段已存在 message.ts:30）
- `message.tool_call_update`（payload `{sessionId, toolCallId, detail?}`）：更新 ToolCall.detail（字段已存在 message.ts:14）。**注：protocol.ts 的 ToolCallUpdatePayload 声明含 `progress?`，但 event-adapter 生产端只发 detail**——消费时对齐生产端
- `message.status`（event-adapter 推 `{sessionId, status, detail?}`）：处理 steer/aborted 等运行时态。**区别于请求级 reply**（send/steer/follow_up/abort 的 reply 已走 pending 通道，不走 streamSubscribe）
- `message.complete` 补 usage 消费：读 payload.usage（`{inputTokens,outputTokens,totalTokens}`）填 Message.usage（字段已存在）；responseModel 可选回显

**文件（1-2）：**
1. `stores/chat.ts`：appendAssistantChunk switch 加 4 case
2. （可选）`api/mock/index.ts`：mock send 补 thinking 流（thinking_start/delta/end）+ tool_call 流（start/end）让 mock 可演示——**决策性**，若 mock 哲学保持最小则不动，记录报告

**验证：** vue-tsc/vitest 全绿。

**Review 要点：**
- [ ] 4 case 是否都加（thinking_end/tool_call_update/status/complete.usage）
- [ ] tool_call_update 是否对齐生产端（只读 detail，不臆造 progress）
- [ ] message.status 是否区分请求级 reply（不重复处理）
- [ ] mock 是否补了 thinking/tool 流（如补，验证 mock 模式可演示）

---

### W06 · 消息流 Part B（store 级状态：retry/queue）

**目的：** 补 2 个 session 级状态 case（非 Message 字段，需加 store 状态）。

**case：**
- `message.auto_retry_start`（`{sessionId, attempt?, maxAttempts?, delayMs?, errorMessage?}`）：chat store 加 `retryState` ref；`auto_retry_end`（`{sessionId, success?, attempt?, finalError?}`）清空
- `message.queue_update`（`{sessionId, steering?: string[], followUp?: string[]}`）：chat store 加 `queue` ref

**文件（1-2）：**
1. `stores/chat.ts`：加 retryState/queue ref + 2 case
2. （可选）轻量 UI：`components/panel/message-stream/RetryIndicator.vue` 或并入现有提示位——**最小化**，若无现成 SystemNotice 位则 store 状态先建、UI 留下个 wave

**验证：** vue-tsc/vitest 全绿。

**Review 要点：**
- [ ] retryState/queue 是否加在 chat store（state 区，非 Message 字段）
- [ ] auto_retry_end 是否清空 retryState
- [ ] store 状态变更是否响应式（ref/reactive）

---

### W07 · 消息流 Part C（shared 类型扩展：bash/compaction/branch）

**目的：** 补 3 个需扩展 shared Message 类型的 case。

**case：**
- `message.bashExecution`（`{sessionId, command?, output?, exitCode?, cancelled?, truncated?, fullOutputPath?, timestamp?, excludeFromContext?}`）
- `message.compactionSummary`（`{sessionId, summary?, tokensBefore?, timestamp?}`）
- `message.branchSummary`（`{sessionId, summary?, fromId?, timestamp?}`）

**文件（3）：**
1. `shared/src/message.ts`：Message 加 `bashExecution?`/`compactionSummary?`/`branchSummary?` 字段（或复用 contentBlocks 扩展，看哪个更贴现有模型）
2. `stores/chat.ts`：3 case 填对应字段
3. `components/panel/message-stream/{Block.vue 或 Turn.vue}`：渲染这 3 种特殊块（最小化：compaction/branch 作 system 提示行；bashExecution 作增强 tool 块显示 exitCode/截断）

**验证：** vue-tsc/vitest 全绿。

**Review 要点：**
- [ ] shared Message 类型扩展是否破坏现有序列化（hydrate history）
- [ ] bashExecution 的 exitCode/truncated/fullOutputPath 是否有 UI 体现
- [ ] compactionSummary/branchSummary 是否作 system 提示（非冒充 user/assistant）

---

### W08 · Settings Provider CRUD

**目的：** 接通 ProviderPage 删除 + ProviderEditModal 保存/发现（现 setTimeout 模拟）。

**文件（2）：**
1. `components/settings/ProviderPage.vue`：删除确认按钮调 `config.deleteProvider(deleteTarget.id)`；启用开关调 `config.setProvider(id, {enabled})`
2. `components/settings/ProviderEditModal.vue`：保存调 `config.setProvider(providerId, formData)`；自动发现调 `config.discoverModels({baseUrl,apiKey,providerType})` + 订阅 `config.discoveredModels` 回填 localModels；testConnection **复用 discoverModels 探活**（domain 无 testConnection，本轮不新增协议，记录报告）

**验证：** mock 模式 Provider 增删改可用；vue-tsc/vitest 全绿。

**Review 要点：**
- [ ] 删除/保存/发现是否真调 api（非 setTimeout/只关弹窗）
- [ ] discoverModels 订阅回填是否正确
- [ ] testConnection 决策是否记录（复用 discoverModels or 保留模拟）
- [ ] 错误处理（api 失败有无 UI 反馈，非静默）

---

### W09 · Settings Skill/Agent/Extension CRUD

**目的：** 接通 SkillPage/AgentPage 扫描+启用、ExtensionPage toggle。

**文件（3）：**
1. `components/settings/SkillPage.vue`：加扫描按钮（调 `scanSkills`）+ skill 启用/禁用开关（调 `setSkill` 带 enabled）+ 删除（`deleteSkill`）
2. `components/settings/AgentPage.vue`：同构（`scanAgents`/`setAgent`/`deleteAgent`）
3. `components/settings/ExtensionPage.vue`：toggle checkbox 调 `extension.toggle(ext.name, checked)`

**验证：** mock 模式 Skill/Agent/Extension 操作可用；vue-tsc/vitest 全绿。

**Review 要点：**
- [ ] Skill/Agent 是否加了操作 UI（扫描/启用/删除按钮，非只读）
- [ ] Extension toggle 是否真调 api（非纯展示）
- [ ] install/uninstall 是否**没做**（D10 推后，不越界）

---

### W10 · message.file_changes 协议 + ChangeSetCard（ADR-0024）

**目的：** 落地 ADR-0024 全链路——协议类型 + runtime 解析（event-adapter 从 tool_call_end 提取 write/edit 的 FileChange + git 对账 ready 帧）+ 前端 ChangeSetCard + store applyFileChanges 实现。

**范围说明：** 协议 C 类缺口，工作量最大，**唯一动 runtime 源码的 wave**。

**文件（5）：**
1. `shared/src/protocol.ts`：ServerMessageType 加 `'message.file_changes'`；ServerMessageMap 加条目（`{sessionId, messageId, fileChanges: FileChange[], changeSetStatus, isFullSet}`，复用 message.ts 的 FileChange/ChangeSetStatus）
2. `runtime/src/infra/pi/event-adapter.ts`：handleToolExecutionEnd 提取 write/edit 的 FileChange（accumulating 增量）+ handleAgentEnd 调 git 对账（ready 全集）
3. 新建 `runtime/src/services/file-change-reconciler.ts`：git status --porcelain + diff --name-only 对账（ADR-0024 D5），XY 码映射 added/modified/deleted
4. `stores/chat.ts`：实现 applyFileChanges（替换 `throw` 空壳）+ appendAssistantChunk 加 `message.file_changes` case
5. 新建 `components/panel/message-stream/ChangeSetCard.vue`：5 态状态机渲染（accumulating/ready/partially-reviewed/resolved/superseded）+ accept/reject

**验证：** real 模式 agent 改文件后消息流出现 ChangeSetCard；vue-tsc/vitest 全绿。

**⚠️ ADR-0024 关键设计点（执行时核对）：**
- D2 分派表：write（added/modified 需 fs.existsSync 判定，行数从 input.content 分行计）+ edit（恒 modified，行数从 result.details.patch 的 unified diff 解析 +/- 行）；bash 不解析
- D5 git 对账：agent_end/turn_end 时 `git status --porcelain`，cwd 取 pi session 工作目录，非 git 仓库跳过
- D6 双段推送：accumulating（每条 tool_end 增量）+ ready（agent_end git 对账全集，真值收口）
- 状态机职责：runtime 推事实（accumulating/ready），前端管审查（partially-reviewed/resolved/superseded）

**Review 要点：**
- [ ] ServerMessageType 是否加了 message.file_changes（ServerMessageMap 同步）
- [ ] runtime event-adapter 是否提取 write/edit 的 FileChange（非 bash）
- [ ] git 对账器是否实现（XY 码映射正确）
- [ ] applyFileChanges 是否实现（替换 throw）
- [ ] ChangeSetCard 5 态状态机是否完整
- [ ] runtime 测试是否覆盖（这是唯一动 runtime 的 wave，需 runtime 侧重试）

---

## 3. 验收标准（全部 Wave 完成后）

- [ ] **ServerMessageMap 落地：** `grep -rn "as ProviderInfo\|as SkillInfo\|as ModelInfo\|as ExtensionInfo\|as PluginInfo" src-electron/renderer/src/` 零命中（11 处断言全删）
- [ ] **session.list 分组：** Sidebar 显示按 cwd 分组的会话列表
- [ ] **Markdown 渲染：** renderer 装了 shiki，消息流 user/assistant/text 走 MarkdownRenderer
- [ ] **Composer 4 接线：** 切模型/切思考/选命令/context 更新均触发 runtime（mock 模式可验证链路通）
- [ ] **消息流 9 case：** thinking_end/tool_call_update/status/complete.usage/auto_retry/queue_update/bashExecution/compactionSummary/branchSummary 均有 store case
- [ ] **Settings 核心 CRUD：** Provider 增删改查+discoverModels、Skill/Agent 扫描+启用+删除、Extension toggle 均接 runtime
- [ ] **file_changes：** real 模式 agent 改文件产出 ChangeSetCard
- [ ] **`npx vue-tsc --noEmit` 0 错误 + `npx vitest run` 全绿**（每 wave 基线）
- [ ] **feature-map §三 修正：** Markdown 渲染从「已解决技术债」改为准确状态（执行完成后更新 docs/feature-map/2026-06-20.md）

---

## 4. 派工控制指引（给控制器）

**每 wave 执行循环：**
1. 把该 wave 的「详细规格」+「Review 要点」+ gap-analysis 相关章节塞进 implementer prompt
2. implementer 完成后跑验证基线（vue-tsc + vitest），git status 干净后提交（英文 commit message）
3. 派 spec-reviewer（核对 Review 要点 + 决策边界）
4. 派 code-quality-reviewer（taste 规则 + 架构一致性）
5. 都过后标记完成、进下一 wave

**模型建议：**
- W01（类型地基）、W04（Composer 接线）、W10（file_changes 全链路）：**标准模型**（复杂、跨多文件、有类型坑/runtime 改动）
- W02、W03、W05-W09：**标准模型**（模式清晰但需理解订阅/store 语义）
- 重复性高的（如 W09 三个 Page 同构）：可考虑同一 implementer 一次做完

**Wave 间检查点：** 每完成一个 wave，在本文 §0 决策记录下方的进度表打勾（见下）。

---

## 5. 执行进度

| Wave | 内容 | 状态 | Commit |
|------|------|------|--------|
| W01 | ServerMessageMap + ModelInfo 统一 | ✅ 完成 | `e05bbdf7` |
| W02 | session.list 分组 UI | ✅ 完成 | `9cca8116` |
| W03 | Markdown shiki 渲染 | ✅ 完成 | `e352726a` |
| W04 | Composer 接线 4 项 | ✅ 完成（待提交） | _待提交_ |
| W05 | 消息流 Part A（纯字段） | ⬜ 待执行 | — |
| W06 | 消息流 Part B（store 状态） | ⬜ 待执行 | — |
| W07 | 消息流 Part C（shared 扩展） | ⬜ 待执行 | — |
| W08 | Settings Provider CRUD | ⬜ 待执行 | — |
| W09 | Settings Skill/Agent/Extension CRUD | ⬜ 待执行 | — |
| W10 | message.file_changes + ChangeSetCard | ⬜ 待执行 | — |

---

## 附录：与现有文档的关系

| 文档 | 关系 |
|------|------|
| [gap-analysis.md](./gap-analysis.md) | 缺口全景。每 wave 规格基于它的 §2-§4 |
| [plan.md](./plan.md) | 第 1+2 项（已完成）。本文是第 3+4 项 |
| [contract.md](./contract.md) | domain 契约表。W01 的 ServerMessageMap 是它的类型层延伸 |
| [tasks.md](./tasks.md) | 第 1+2 项派工单（T0-T7）。本文是第 3+4 项派工单（W01-W10） |
| [docs/feature-map/2026-06-20.md](../../docs/feature-map/2026-06-20.md) §三 | Markdown 描述失真，W03 完成后修正 |
