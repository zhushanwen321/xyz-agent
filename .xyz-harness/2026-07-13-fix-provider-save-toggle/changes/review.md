# Code Review — fix-provider-save-toggle

## 审查范围
- commits: 65836ca8 (W1) / 014dfdb6 (W2) / 75c1b718 (W3) / b8f439f6 (W4)
- base: 4eca9966
- 改动面：27 文件 +849/-60，覆盖 runtime（config-service / model-service / model-mapper / pi-config-store / pi-provider-store / settings-message-handler / ports）、shared（protocol / constants / provider / index）、renderer（ProviderPage / ProviderEditModal / ModelSelectPopover / useProviderEdit / api/domains/config / mock）。
- 7 个 U* 单测 + 3 个 E* 手动验证（cw status 显示 testCases 仍 pending，未跑过 test gate；本 review 基于读代码 + 读测试代码）。

## 发现的问题

| # | 维度 | 问题 | 严重度 | 位置 |
|---|------|------|--------|------|
| 1 | 业务逻辑正确性 | **setProvider 的 model 合并丢弃传入的 `api`/`baseUrl`/`enabled`/`reasoning`/`maxTokens`/`cost`/`compat`**。合并循环只显式写 `name/contextWindow/input/thinkingLevelMap`，`{ ...base, id }` 后从未把 `m.api`/`m.baseUrl`/`m.enabled` 写回 `model`。后果：(a) **新模型**（不在 existing.models 里，base={}）保存后这些字段全部丢失；(b) **编辑现有模型**时前端改的 `enabled`/`api`/`baseUrl` 被静默丢弃，只保留 base 旧值。由于 pi 层 `upsertProvider` 是 `models.providers[id] = config` 全量覆盖写盘，丢字段即落盘丢失。这直接违反 W4 changes[1]「编辑保存时这些字段必须回传，否则 model 级配置会在 setProvider 合并时被丢弃」的承诺——前端回传了，runtime 又丢了。 | **must_fix** | `packages/runtime/src/services/config-service.ts:126-148`（setProvider 的 `merged.models = rawModels.map(...)`） |
| 2 | 测试覆盖 | **U3 未覆盖 setProvider 的 model 级 enabled 写入路径**。U3（model-service.test.ts「U3 端到端」）直接手构 `ProviderInfo[]`（model 已带 enabled）喂给 `aggregateModels`，只测了「过滤」半边；config-service.test.ts 的「model 级 enabled 透传」用例只测 `writeModels` 落盘 + `listProviders` 读回，**绕过了 `setProvider` 写路径**。故问题 #1（setProvider 丢 enabled）测试全绿也没暴露——正是 plan 提示「mock 掩盖 bug」的同款陷阱重演。需补：`setProvider({models:[{id:'m1',enabled:false}]})` → `listProviders()` 断言 `m1.enabled===false`。 | **must_fix** | `packages/runtime/test/config-service.test.ts`（缺 setProvider model 级 enabled 写入断言）、`packages/runtime/test/model-service.test.ts:U3`（用例未走 setProvider 写路径） |
| 3 | 类型安全 / 契约一致性 | **W1 的 SSOT 常量 `PROVIDER_API_TYPES` 定义并导出但实际无人消费**。pi-config-store 的 `applyTypeTranslation` 自建本地 `KNOWN_API_TYPES = new Set(['anthropic-messages','openai-completions','openai-responses'])`（多一个 `openai-responses`，与 SSOT 漂移）；ProviderEditModal.vue 的两个 SelectItem value 仍是硬编码字符串字面量，仅注释提到「对齐 PROVIDER_API_TYPES」。W1 changes[3] 声明此常量是「前后端共享 SSOT，供前端 Select option value 与 runtime 校验共用，消除契约漂移」，但实际契约仍漂移（两处白名单不一致：shared 2 项 vs runtime 本地 3 项）。 | should_fix | `packages/runtime/src/infra/pi-config-store.ts:74`（本地 KNOWN_API_TYPES）、`packages/renderer/src/components/settings/ProviderEditModal.vue:48-49`（硬编码 value）、`packages/shared/src/constants.ts:30`（SSOT 未被消费） |
| 4 | 边界条件 | **provider enabled===false（或所有 model 均 disabled）时 aggregateModels 返回空列表**。这是期望行为（禁用 provider 不进 Composer 选择器），但当前没有任何 UI 提示用户「为何 Composer 模型列表空了」——若用户误把唯一 provider 禁用，Composer 选择器静默变空且无引导。功能正确但 UX 有坑，建议 Composer 空列表时给一句「所有 provider 已禁用，去 Settings 启用」之类的提示（非阻塞，可在后续 topic 处理）。 | nit | `packages/runtime/src/services/model-service.ts:118-128` |
| 5 | 类型安全 | **W3 广播 payload 带 `source` 字段但 ServerMessageMap['config.defaults'] 类型只声明 `{ defaultModel: string }`**。代码用 `as const` + broadcast 宽类型绕过（reply 严格不带 source、broadcast 宽带 source），handler 注释也坦承「留给 W4/后续 topic 收紧 source 字段」。现状可工作（前端 onDefaults 只读 defaultModel），但类型契约与实际运行时数据不符，未来重构易踩。与现有 setProvider/deleteProvider 广播（同样带 source）一致，属历史遗留风格，不阻塞。 | nit | `packages/shared/src/protocol.ts:254`、`packages/runtime/src/transport/settings-message-handler.ts:140-153` |
| 6 | 计划符合性 | **W4 changes[0] 与实现不符**。plan 说「ollama 项的 value 改为 openai-completions 并在 label/baseUrl 提示区分」（保留 3 个 SelectItem），实现是「直接删掉 ollama SelectItem」（剩 2 个）。实现 arguably 更干净（无误导性重复项），且注释说明了 ollama 走 OpenAI Compatible + baseUrl，但与 plan 字面不符。倾向接受实现，仅记录偏差。 | nit | `packages/renderer/src/components/settings/ProviderEditModal.vue:48-50` |
| 7 | 代码规范 | useProviderEdit 的 `autoDiscover` 合并新模型时只取 `{id, name, contextWindow}`（`localModels.value.push(...merged.map(m => ({ id, name, contextWindow })))`），**不带回 discover 返回的 api/baseUrl/enabled**。若 discover 返回的模型带这些字段，保存时会丢（叠加问题 #1 后双丢）。与 W4「model 级字段全透传」的主旨不完全一致。 | should_fix | `packages/renderer/src/composables/features/useProviderEdit.ts:188-190` |

### 未发现问题的维度（已逐项核对，结论 OK）

- **enabled 向上兼容**：读侧三处（config-service.listProviders `config.enabled !== false`、model-mapper.toModelInfo `m.enabled !== false`、aggregateModels `p.enabled !== false`/`m.enabled !== false`）语义统一，undefined/true 均视为启用，存量 models.json 无此字段时正确兜底为启用。config-service.test.ts 有「向上兼容（无 enabled 字段默认 true）」用例覆盖。**向上兼容真成立**。
- **applyTypeTranslation 透传不破坏现有行为**：删除 mapTypeToApi 别名表后，前端已直接发 pi 终值（ProviderEditModal value = anthropic-messages/openai-completions），runtime 透传后 `merged.api` 仍为 pi 终值，与删除前的翻译结果一致（anthropic→anthropic-messages 之前是翻译、现在是前端直发）。U4 测了 anthropic-messages/openai-completions/未知值/ollama/anthropic/openai 六种透传，覆盖充分。
- **defaultModel 复合串解析边界**：`defaultProviderId = dm ? dm.split('/')[0] : ''`——空串返回 ''（pill 不显示，正确）；无 `/` 的非法串返回整串（不会匹配任何 provider id，pill 不显示，无 crash）；模板用 `p.id + '/' + m.id === defaultModel` 全串比对，比单独比对 provider+model 更严，正确。U5c 测了空串场景。
- **defaultModel 持久化（W3）真落盘**：`configService.setDefaultModel` → `configStore.setDefaultModel` → `pi-provider-store.setDefaultModel` → `updateSettingsSync(s => { s.defaultProvider = provider; s.defaultModel = modelId })`，真写 settings.json。W3 真持久化，非内存态。
- **广播模式对齐**：W3 的 reply+broadcast 与 setProvider/deleteProvider 的 newDefault 广播同构（同用 config.defaults、同带 source 标签），settings-message-handler.test.ts 有专测验证 setDefaultModel 调 configService + reply + broadcast 三件套。
- **mock 与 real 对齐**：mock/index.ts 的 setDefaultModel 用 `defaultsSub.broadcast(`${provider}/${modelId}`)` 与 runtime 广播 `config.defaults` 同构；fixture ollama provider 的 api 从 'ollama' 改为 'openai-completions'、baseUrl 加 `/v1`，与 real pi 契约一致。**未发现 mock 掩盖 real bug 的新坑**（除问题 #1/#2 是 real 自身的 bug，mock 也复现不了因为前端测试没走 setProvider 落盘链路）。
- **provider 级开关（核心修复）链路完整**：ProviderPage `<Switch @update:model-value="onToggleEnabled(p, $event)">` → `config.setProvider(p.id, { enabled })` → runtime `if (data.enabled !== undefined) merged.enabled = data.enabled` → 落盘 → onProviders 回推。**provider 级 enabled 读写链是真闭环**，U2 用真实 PiConfigStore + 临时 models.json 端到端验证（含读盘断言）。
- **类型安全无 any**：grep 确认 4 个 commit 未在源码引入 `any`（仅测试文件用 `as unknown as` 访问组件实例内部，可接受）。`upsertProvider` 的 `merged as unknown as Parameters<typeof upsertProvider>[1]` cast 在 W1 加 enabled 后仍成立（ConfigProviderConfig 与 PiProviderConfig 现同构含 enabled）。SetProviderData.models 类型扩展（W4）与 runtime setProvider 入参类型一致。

## plan 覆盖核对

### W1（65836ca8）
- [x] **changes[0]** pi-provider-store.ts：PiProviderConfig/PiModelDefinition 加 `enabled?: boolean`（provider 级 L56-57、model 级 L40-41），注释「省略时默认 true，向上兼容存量数据」。已落地。
- [x] **changes[1]** ports/config.ts：ConfigProviderConfig/ConfigModelDefinition 同步加 `enabled?: boolean`（L14、L28），注释「与 infra 同构」。已落地。
- [x] **changes[2]** pi-config-store.ts：删除 mapTypeToApi 死别名表（diff 确认 -14 行函数体），applyTypeTranslation 改透传 + warn。已落地。**但白名单用本地 Set 而非共享 SSOT，见问题 #3**。
- [x] **changes[3]** shared/constants.ts：新增 `PROVIDER_API_TYPES = ['anthropic-messages','openai-completions'] as const` + `ProviderApiType` 类型，index.ts 导出。已落地。**但前端 Select 未消费此常量（仍硬编码），runtime 校验也未消费（自建本地 Set），SSOT 名不副实，见问题 #3**。

### W2（014dfdb6）
- [ ] **changes[0]** config-service.setProvider 补 enabled 处理——**provider 级已落地**（`if (data.enabled !== undefined) merged.enabled = data.enabled`，L120），但 **model 级「save 映射里若 model 含 enabled 则写入，未传时 base 兜底保留原值」未落地**。实现是 `{ ...base, id }` 后只写 name/contextWindow/input/thinkingLevelMap，从未读 `m.enabled`/`m.api`/`m.baseUrl` 写入 model。base 兜底对**现有模型**勉强成立（旧值透传），但对**新模型**（base={}）和**前端改值**场景完全失效。**见问题 #1（must_fix）**。
- [x] **changes[1]** config-service.listProviders：provider 级 `api: config.api`（L86，修 P0-1 编辑回填丢 api）+ `enabled: config.enabled !== false`（L99，替代硬编码 true）；models 补 `enabled: m.enabled !== false`（L97）。已落地。
- [x] **changes[2]** model-mapper.toModelInfo：`enabled: m.enabled !== false`（替代硬编码 true），泛型约束加 `enabled?: boolean`。已落地。
- [x] **changes[3]** model-service.aggregateModels：provider 级 `.filter(p => p.enabled !== false)` + model 级 `.filter(m => m.enabled !== false)` 双层过滤。**实现确为双层过滤，与 plan 一致**。已落地。
- [x] （附带）shared/provider.ts：ProviderInfo.models 元素 + ProviderInfo 顶层加 `enabled?: boolean`。已落地。

### W3（75c1b718）
- [x] **changes[0]** shared/protocol.ts：ClientMessageType 加 `'config.setDefaultModel'`（L26）；ClientMessageMap 加 `{ provider: string; modelId: string }`（L115）。已落地。
- [x] **changes[1]** settings-message-handler.ts：新增 `case 'config.setDefaultModel'`（L136-153），调 `configService.setDefaultModel` + reply `config.defaults` + broadcast 带 `source: 'default-set'`。已落地。广播模式与 setProvider/deleteProvider 同构。
- [x] **changes[2]** renderer/api/domains/config.ts：新增 `setDefaultModel(provider, modelId)` 动作函数（L130-137），transport.send config.setDefaultModel。已落地。

### W4（b8f439f6）
- [~] **changes[0]** ProviderEditModal.vue SelectItem——删了 ollama 项（剩 anthropic-messages + openai-completions 两个），**而非 plan 说的「ollama value 改 openai-completions 保留项 + label/baseUrl 提示」**。实现更干净但与 plan 字面不符。**见问题 #6（nit）**。且 value 仍硬编码字符串，未引用 PROVIDER_API_TYPES 常量（**见问题 #3**）。
- [x] **changes[1]** useProviderEdit.ts：LocalModel 加 `api?/baseUrl?/enabled?`（L17-26），save() 映射补发这三字段（L231-235）。前端侧已落地。**但 runtime 侧 setProvider 丢弃，见问题 #1**。
- [x] **changes[2]** ModelSelectPopover.vue：groups computed 加 `if (m.enabled === false) continue`（L103），用 `=== false` 精确语义（undefined/true 都不过滤，与 plan 描述一致）。已落地。U6 测试覆盖。
- [x] **changes[3]** ProviderPage.vue：defaultProviderId/defaultModelId 从本地 ref 改 computed 派生自 `settingsStore.defaultModel`（L189-198）；setDefaultModel 改调 `config.setDefaultModel(providerId, modelId)`（L270-277）；删掉 provider 级「设为默认」按钮（默认派生自 model 级）。已落地。U5a/U5b/U5c 测试覆盖。
- [x] **changes[4]** mock/index.ts：新增 setDefaultModel（L441-448）对齐 real；fixture ollama api 改 'openai-completions'、baseUrl 加 /v1。已落地。

## 测试覆盖核对（U1-U7）

| 用例 | 状态 | 说明 |
|------|------|------|
| U1 | ✅ 已测 | config-service.test.ts「provider 级 api 字段」+「enabled=true」——真实 PiConfigStore + 临时 models.json，断言 api/enabled 回填。 |
| U2 | ✅ 已测 | config-service.test.ts「provider 级 enabled 读写链路」——setProvider({enabled:false/true}) → listProviders 读回 + 读盘验证持久化。**provider 级闭环真验证**。 |
| U3 | ⚠️ **半测** | aggregateModels 过滤逻辑测了（model-service.test.ts 4 个用例：provider 禁用/model 禁用/向上兼容/端到端），但**未走 setProvider 写入路径**——直接手构 ProviderInfo[] 喂 aggregateModels。config-service.test.ts 的 model 级 enabled 用例只测 writeModels+listProviders，绕过 setProvider。**故 setProvider 丢 model.enabled 的 bug（问题 #1）未暴露，见问题 #2**。 |
| U4 | ✅ 已测 | pi-config-store.test.ts 6 个用例：anthropic-messages/openai-completions/未知值/ollama/anthropic/openai 全测透传。 |
| U5 | ✅ 已测 | provider-page.test.ts U5a（默认标记显示）+ U5b（切换跟随）+ U5c（点击调 setDefaultModel）。覆盖空串边界（U5c defaultModel=''）。 |
| U6 | ✅ 已测 | model-select-popover.test.ts U6：enabled:true/false 混合，断言 false 的 claude-haiku 不进列表。用 `enabled === false` 精确语义。 |
| U7 | ✅ 已测 | provider-edit-modal.test.ts U7：option 文案无 Ollama、含 Anthropic Messages + OpenAI Compatible、form.api 初始值 ∈ PROVIDER_API_TYPES。**注意：测的是文案/初始值，没断言 SelectItem value 属性**（reka-ui 不暴露 data-value，测试用文案兜底），所以问题 #3（value 硬编码而非引用常量）测试发现不了。 |
| E1-E3 | ⏭ 待手动 | real 层验证，review 阶段确认 steps 可执行、expected 可判定——均合理（读 models.json/settings.json 断言字段值）。**但 E1「api===openai-completions」会过（listProviders 回填了），E2「enabled:false 落盘」会过（provider 级闭环 OK）；唯独「编辑现有 model 的 enabled/api/baseUrl 后保存」这类操作 E* 没覆盖，会触发问题 #1**。 |

## 结论

- **must_fix 数量：2**（问题 #1 setProvider 丢 model 级字段、问题 #2 U3 未覆盖写路径）
- **should_fix 数量：2**（问题 #3 SSOT 未消费/契约漂移、问题 #7 autoDiscover 丢字段）
- **nit 数量：3**（问题 #4 空列表无 UI 提示、问题 #5 source 字段类型松、问题 #6 W4 ollama 处理与 plan 字面不符）

**结论：需修后重 cw(dev)。**

### 修复优先级
1. **P0（阻塞，必须修）**：config-service.setProvider 的 model 合并循环补写 `m.api`/`m.baseUrl`/`m.enabled`（及 reasoning/maxTokens/cost/compat 等已声明字段），模式对齐 name/contextWindow 的「if (m.X !== undefined) model.X = ...」。否则 model 级配置（含 enabled 启停）编辑保存即丢失，W2/W4 的 model 级修复形同虚设。
2. **P0（阻塞，必须修）**：补 config-service.test.ts 用例——`setProvider({models:[{id:'m1',enabled:false},{id:'m2',enabled:true}]})` → `listProviders()` 断言 m1.enabled===false && m2.enabled===true，再 → `aggregateModels()` 断言只含 m2。这条测试当前缺，是 #1 能溜进来的根因。
3. **P2**：把 pi-config-store 的本地 KNOWN_API_TYPES 改用 `PROVIDER_API_TYPES` 常量（消除 openai-responses 漂移）；ProviderEditModal 的 SelectItem value 改用常量（或至少加编译期校验）。让 SSOT 名副其实。
4. **P2**：useProviderEdit.autoDiscover 合并新模型时带回 api/baseUrl/enabled。
5. **P3**：broadcast source 字段类型收紧 / Composer 空列表 UX 提示 / 文档化 W4 ollama 处理偏差。

### 对抗性审查的总体判断
provider 级 enabled 启停（核心 P0）修复扎实、真闭环、测试端到端（含读盘）；defaultModel 持久化（W3）真落盘、广播对齐；applyTypeTranslation 透传不破坏现有行为；向上兼容真成立。**但 model 级 enabled/api/baseUrl 的「写」路径有一处硬伤（setProvider 合并漏写）被测试盲区掩盖**——这恰是 plan 反复警告的「mock/手构数据掩盖 real bug」的同款陷阱在本次修复里重演。修掉 #1+#2 后，本 topic 的 4 个声称修复才真正全部成立。
