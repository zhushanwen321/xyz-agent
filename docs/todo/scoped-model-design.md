# Scoped Model 功能设计（v2.1，重写版）

**结论**：新增「Scoped Model」白名单机制——用户从已配置模型中勾选若干并自定义顺序，GUI 模型选择器只显示这些模型。存储放 `config/providers.json` 顶层新增 `scopedModels` 字段（xyz 扩展域），过滤与排序在 runtime `aggregateModels` 消费层实现，默认模型复用现有 `setDefaultModel` 链路同步为列表第一位。

> 版本说明：v1（复用 pi `settings.json.enabledModels`）经对抗式审查判定不成立（5 MUST-FIX：GUI 过滤链路断裂 / RPC 不存在 / 黑白名单共用数组冲突 / 跨进程感知通路不存在 / pi 侧即时生效不成立）。v2 重写为 xyz 域自持方案后又经第二轮对抗复审（3 MUST-FIX：renderer 接收通路断裂 / OAuth catalog provider 默认模型被 findValidDefaultModel 冲掉 / D2 数据流未设计），v2.1 已全部融合修复。

---

## §1 背景与目标

### 1.1 SCQA

- **Situation**：xyz-agent 支持多 provider（models.json 配置 + auth.json 凭证），用户可配置几十个模型，模型选择器按 provider 分组显示全量
- **Complication**：用户常用只有 3-5 个模型；现有 toggle provider 是 **provider 级**白名单开关（`settings.json.enabledModels` 存 `<id>/*` 前缀 pattern，空 = 全可用），无法按单个模型粒度控制，且无法自定义显示顺序
- **Question**：如何让用户只看到想用的模型，并按习惯顺序排列？
- **Answer**：Scoped Model 模型级白名单 + 有序列表，选择器只显示白名单内模型且按用户序排列

### 1.2 设计目标

| 目标 | 描述 | 验收标准 |
|------|------|----------|
| G1 固定模型集 | 配置后模型选择器只显示指定模型 | 配置 3 个模型，`model.list` 广播与选择器只含这 3 个 |
| G2 自定义顺序 | 模型按用户配置顺序显示，第一位即新会话默认 | 调序后广播顺序变化；settings.json defaultModel 同步为新第一位且 spawn 读回一致 |
| G3 全 provider 覆盖 | catalog（含 OAuth、auth.json-only）与 custom provider 的模型都能加入 | OAuth 认证 provider（models.json 无条目形态）的模型可正常添加、显示、作为默认 |
| G4 GUI 即时生效 | 配置变更后无需重启，选择器立即更新 | 写操作触发现有 `model.list` 广播，选择器响应式更新 |

**G4 边界（明确收窄）**：即时生效仅指 GUI 显示。新会话默认模型在 spawn 时读取（现有语义）；已运行的 pi 会话不受任何影响。

### 1.3 Scope

**In Scope**：
- `providers.json` 顶层新增 `scopedModels` 存储 + 读写（含 renderer 侧接收链路扩展）
- runtime `aggregateModels` 按白名单过滤 + 按序重排（含 ModelService→scopedModels 数据流接线）
- 新增 `config.setScopedModels` RPC（含广播接线）；`config.getProviders` reply / `config.providers` 广播 payload 扩展 `scopedModels`
- `findValidDefaultModel` 校验源扩展（修 auth.json-only catalog provider 默认模型被冲掉的存量缺陷，G3 前置）
- Provider 页顶部 ScopedModelSection 配置组件（添加/删除/上移/下移）

**Out of Scope**：
- 拖拽排序（第一版用上移/下移按钮，与 LoadPaths 现有交互一致；拖拽后续迭代再评估引入依赖）
- pattern/glob 语法输入（选择式 picker，不支持自由文本匹配）
- thinking level 配置、批量导入导出、按任务类型自动切换
- pi TUI/CLI 侧任何感知（pi 侧不消费本配置，见决策 D1）
- 跨进程文件监听（外部手改 providers.json 不会热更新 GUI，重启或下次 RPC 后生效——与现有 providers.json 各字段一致）

---

## §2 现状与问题分析

### 2.1 使用者视角的现状

用户配置 3 个 provider（每个 5-10 个模型），日常只用 Claude Opus、GPT-4o、DeepSeek V3。当前选择器显示 20+ 个模型，按 provider 分组、组序由 auth.json/models.json 键序决定，用户无法收缩范围也无法调整顺序。toggle provider 开关粒度是整个 provider，关掉 Anthropic 会藏掉全部 5 个 Claude 模型，留不下想用的那一个。

### 2.2 现状机制盘点（已核验，含证据锚点）

| 机制 | 实现位置 | 语义 |
|------|----------|------|
| provider 级开关 | `provider-config-helper.ts:554-610`（`toggleProviderEnabled`，RPC case 在 `settings-message-handler.ts:80-89`） | 写 pi `settings.json.enabledModels`（`<id>/*` pattern）；**白名单语义**：空/未设置 = 全可用，非空 = 只保留匹配 provider；空白名单时 toggle OFF 是 no-op |
| 模型级 enabled | `providers.json` 的 `modelStates: Record<modelId, {enabled}>`（`provider-extras-store.ts:24-42`） | 聚合层填入 `ProviderInfo.models[].enabled`；当前**无 UI 编辑入口**（迁移产物 + 编辑体收集） |
| GUI 模型列表 | `model-service.ts:115-126`（`aggregateModels`，纯函数，providers 由调用方传入）→ `model.list` 广播 → renderer `settingsStore.models` → `ModelSelectPopover.vue` | 过滤条件仅 `p.enabled !== false ∧ m.enabled !== false`；顺序 = `listProviders()` 双源聚合序；ModelService 现无读取 scopedModels 的能力（setServices 只注入 session/config/broker） |
| 默认模型链 | `config.setDefaultModel` RPC → `pi-provider-store.ts:382-387` 写 settings.json（无校验直接写）；spawn 时 `getDefaultModel()`（`rpc-client.ts:155`）→ `findValidDefaultModel`（`pi-provider-store.ts:301-378`）校验，失败 fallback 重选并 **wasFixed 自动写回** | **存量缺陷**：findValidDefaultModel 主路径只查 `models.providers[defaultProvider]`——auth.json-only catalog provider（OAuth 形态）无 models.json 条目必走 fallback，default 被冲掉 |
| 广播通路 | `broadcastProviderList()`（`message-broker.ts:143-149`）= `config.providers` + `model.list` 双推；renderer 常驻订阅（`settings-lifecycle.ts:63-80`） | 5 个 provider 写 RPC + 连接首推 + `model.list` 请求-响应共 7 处触发；**providers.json 的新写入口必须自带广播接线**；renderer onProviders 链（`api/domains/config.ts:143-146` → core `transport.ts:54` → lifecycle → store）现只透传 providers 数组，payload 其余字段丢弃 |
| 主动拉取 | `refreshProviders()` 打开 modal 时拉 `config.getProviders`（`settings-lifecycle.ts:97-105`） | reply payload 现只 `{ providers }`；历史教训（AGENTS.md）：renderer 需立即消费的状态必须主动拉取，不可依赖 broadcast |

### 2.3 关键结论（问题定性）

1. **GUI 选择器的唯一数据源是 runtime `aggregateModels`**——谁控制这层输出，谁就控制显示范围和顺序。renderer `ModelSelectPopover` 按 `providerId` 建 Map 分组（JS Map 保插入序），runtime 侧排好序后分组呈现天然正确，选择器组件零改动。
2. **pi 的 `enabledModels` 对本功能无贡献**：pi 0.84.1 dist 实测，其消费点是 pi TUI 的模型循环（Ctrl+P）、`/model` 选择器默认视图（软白名单，可 Tab 切 all）、CLI `--models`；xyz 走 `--mode rpc` 子进程，用户不接触这些交互。且 pi 启动只读一次 settings.json，运行中不感知外部修改。
3. **providers.json 是 xyz 扩展域 SSOT**（XyzProviderStore 唯一读写，proper-lockfile + 原子写，已有 `modelStates` 模型级状态先例），新增顶层字段是该架构的自然延伸。现有 `modify(providerId, fn)` 只触达 provider 条目，顶层字段需新增 RMW API。

---

## §3 解决方案

### 3.1 终态（使用者视角）

**成功路径**：
```
用户：打开 Settings → Provider 页，顶部看到「Scoped Model」卡片
用户：点击「添加」，弹出模型选择面板（按 provider 分组显示全部已配置模型，含未加入的）
用户：勾选 Claude Opus 4.5、GPT-4o、DeepSeek V3，确认
系统：卡片列表显示这 3 个模型（按添加序），选择器立即只显示这 3 个
用户：选中 GPT-4o 点「上移」到第一位
系统：选择器中 GPT-4o 排第一；新会话默认模型变为 GPT-4o
用户：点某模型行「移除」
系统：该模型从选择器消失；移除至列表为空时恢复显示全部模型
```

**失败路径**：
```
用户：添加面板中选择一个未配置凭证 provider 的模型
系统：该模型行显示「未认证」警示标记，仍允许添加（提供凭证后即可用），列表中该条目持续显示警示
用户：列表中某模型所属 provider 后来被删除
系统：该条目从列表自动清除（对称现有 cleanEnabledModelsResidue）
```

### 3.2 多方案对比

| 方案 | 描述 | 长期合理性 | 短期成本 | 风险 | 推荐 |
|------|------|------------|----------|------|------|
| **A: xyz 域白名单（providers.json + aggregateModels）** | 存储/过滤/排序全在 xyz runtime 域 | ✅ 单一真相源，选择器零改动，广播通路复用 | 中 | 低 | ✅ |
| **B: 复用 pi settings.json.enabledModels** | v1 方案 | ❌ pi 消费点在 TUI（GUI 不受益）；与 toggle 共用数组互相破坏；pi 启动只读一次 | 低 | 高 | ❌ |
| **C: renderer 侧过滤** | settingsStore.models 在前端按白名单过滤 | ❌ 过滤逻辑散落两端，mock/多消费方都要各自实现 | 低 | 中 | ❌ |

**方案 B 致命伤**（审查实证）：写入 model 级 pattern 后 xyz `deriveEnabled`（`provider-catalog.ts:33-35` 只认 `<providerId>/` 前缀）对未命中 provider 判禁；toggle OFF 按 `startsWith('<id>/')` 连带清除 scoped 条目（`provider-config-helper.ts:572-577`）；两个机制对同一数组语义冲突无法调和。

**方案 C 致命伤**：runtime `model.list` 仍是全量，任何新消费方都要重实现过滤；顺序信息必须传到 renderer，排序职责推给每个消费方。

**方案 A 成立的构造性理由**：`aggregateModels` 是 GUI 链路唯一数据源，在此过滤后 `model.list` 广播即终态；renderer 分组 Map 保序，零组件改动；写操作挂现有 `broadcastProviderList()` 通路；`config.providers` 广播的 ProviderInfo 保持全量（添加面板数据源），`model.list` 才是过滤后视图——两数据源不冲突。

### 3.3 关键决策与权衡

#### 决策 D1：存储位置 —— `providers.json` 顶层新增 `scopedModels: string[]`

```jsonc
// <piAgentDir>/config/providers.json
{
  "version": 1,
  "providers": { /* 现有 provider 级条目，不动 */ },
  "scopedModels": ["openai/gpt-4o", "anthropic/claude-opus-4-5", "deepseek/deepseek-v3"]
}
```

- 条目格式：`provider/modelId` 复合串（与 `config.defaults.defaultModel`、`SessionSummary.modelId` 既有惯例一致，renderer 已有 `bareModelId()` 拆分逻辑）
- 数组序 = 显示序 = 默认优先序；空数组/字段缺失 = 未启用（显示全部，现状行为）
- **被否**：复用 pi `enabledModels`（理由见 §3.2 方案 B）；放某个 provider 条目下（scoped 跨 provider 且顺序是全局的）；新文件（增加文件数，脱离 XyzProviderStore 单一写口）
- 兼容性：读侧对非法值（非 string[]、条目非 `x/y` 格式）容错——过滤掉非法条目并 log warning，不隔离整个文件（`providers` 域沿用现有 quarantine，`scopedModels` 域独立容错）；现有 per-provider `modify` 的 RMW spread 写回不丢顶层字段（已验证）；不 bump `version`（非破坏性新增）
- **写 API**：现有 `modify(providerId, fn)` 只触达 provider 条目，**新增顶层级 RMW API `modifyScopedModels(fn)`**（同文件内复用同一 withFileLock，天然与 per-provider 写串行）

#### 决策 D2：过滤 + 排序在 runtime `aggregateModels` 消费层，数据流走 IConfigService 注入

- **数据流（v2.1 补）**：`IConfigService` 新增 `getScopedModels(): string[]`（`config-service.ts` 实现，直读 providerExtrasStore——该文件已持有 providerExtrasStore 实例）；`ModelService.aggregateModels` 内部经已注入的 configService 调用（`setServices` 已注入 config，`model-service.ts:61-68`）。两个调用方（`message-broker.ts:147` 广播、`settings-message-handler.ts:314` 请求-响应）**真正零改动**。`interfaces.ts` 同步 IConfigService / IModelService 接口声明
- 过滤条件（合并现有）：`providerEnabled(provider) ∧ modelEnabled(model) ∧ (scopedModels 为空 ∨ "provider/modelId" ∈ scopedModels)`
- **优先级语义：provider 级 disabled 压过 scoped**——用户 toggle OFF 某 provider，即使 scoped 含其模型也不显示。语义组合清晰：toggle = provider 总开关，scoped = 可见范围
- 排序：scopedModels 非空时，输出按 scopedModels 数组序（跨 provider 交错序保留；renderer 分组后组序 = 该组首个模型的全局位置）；scopedModels 为空时保持现状双源聚合序
- scoped 条目解析不到实际模型（provider/模型已被删除）时静默跳过该条目，不报错；凭证状态不影响可见性（凭证只影响可用性）
- **被否**：renderer 过滤（方案 C）；pi 侧消费（方案 B）；aggregateModels 签名加参（迫使 message-broker 与 handler 两个调用方改签名，破坏「广播零改动」）

#### 决策 D3：默认模型 —— 写 scopedModels 时同步 `setDefaultModel(scoped[0])`，并修复 findValidDefaultModel 存量缺陷

- `config.setScopedModels` handler 内：列表非空且 scoped[0] 不同于当前 default 时，调用现有 `setDefaultModel(provider, modelId)`（写 settings.json model 域，锁内 RMW 已有字段域保护），随现有链路广播 `config.defaults`
- 新会话 spawn 走现有 `options.model ?? getDefaultModel()` 读到 scoped[0]，**不改 spawn 链路**
- 列表清空时不动 default（保持用户最后选择）
- **前置修复（v2.1 补，G3 必需）**：`findValidDefaultModel`（`pi-provider-store.ts:301-378`）主路径只查 `models.providers[defaultProvider]`——scoped[0] 为 **auth.json-only catalog provider**（OAuth 形态，models.json 无条目，S3 场景）时，`setDefaultModel` 写入成功但下次 spawn 读取校验必失败 → fallback `pickFirstModelProvider` 重选并 `wasFixed` **自动写回冲掉 scoped[0]**。这也是存量缺陷（现有 GUI setDefaultModel 设 OAuth provider 同样被冲）。修复：findValidDefaultModel 校验源扩展——defaultProvider 无 models.json 条目但 auth.json 有凭证且属 catalog 时，校验 defaultModel ∈ 该 provider 的 builtin 模型集（catalog 兜底分支 `pi-provider-store.ts:343-361` 已可访问 catalog 数据），通过则不 fallback、不写回
- **已知并接受的错位**：用户会话内切模型时 pi 回写 defaultModel（现有语义「最后用的 = 新默认」），此后 scoped[0] 与 default 可能不一致，直到用户下次调整 scoped 列表或显式设默认。这是现有语义的自然延伸，不引入新机制对抗 pi 回写
- **被否**：spawn 侧 `scoped[0]` 强制覆盖（制造第二真相源，与「最后用的模型」心智冲突）；handler 每次读时补偿（掩盖存量缺陷，错误层面修）

#### 决策 D4：排序交互 —— 上移/下移按钮，不引入拖拽库

- 全仓无 vuedraggable/dnd-kit/sortablejs 依赖；现有排序交互先例是 LoadPaths 的 moveUp/moveDown 按钮（`packages/ui/src/features/settings/common/LoadPaths.vue:91-103`）
- 一致性优先 + 不为单一功能引入新依赖；拖拽列 Out of Scope
- **被否**：vuedraggable（新依赖 + 选型论证成本）；dnd-kit（React 库，与 Vue 3 不兼容，v1 文档未选型的错误）

#### 决策 D5：添加交互 —— 选择式 picker，不支持 pattern 文本输入

- 添加面板数据源 = `config.providers` 广播的 `ProviderInfo[].models`（listProviders 输出，**未经 scoped 过滤的全量**），天然覆盖 catalog/custom/override 全部已配置模型
- 选择式输入消灭 pattern 语法问题（v1 的「无效 pattern 警告」任务随之消失）；重复添加直接去重拒绝
- 未认证 provider（`ProviderInfo.apiKeySet === false` 且无 ambient 凭证）的模型行显示警示标记，允许添加（凭证配置后即恢复可用）
- **被否**：自由文本 pattern（引入 glob/模糊匹配双端实现差异风险）

#### 决策 D6：UI 位置与包拓扑

- `ScopedModelSection.vue` 放 `packages/ui/src/features/settings/common/`（跨端共享 settings feature 组件，与 ModelListSection/LoadPaths 同级）
- 组件经 **props/emits 接线**（ui 包零 renderer import 铁律，ProviderEditBody 范式）：props 传入 scoped 列表渲染数据（模型名/provider 名/警示态）与全量可选模型，emit `add/remove/move` 事件
- `useScopedModels.ts` composable 放 `packages/renderer/src/composables/features/settings/`（与现有 7 个 settings composable 同级），持状态 + 调 RPC
- 挂载点：`packages/renderer/src/components/settings/provider/ProviderPage.vue` 顶部

#### 决策 D7（v2.1 新增）：renderer 接收通路 —— 扩展现有 onProviders 链，reply 与广播双通道

广播 payload 扩展 `scopedModels` 只是发车，接收端三段链路现有代码会把字段丢掉（`api/domains/config.ts:143-146` 只取 `payload.providers` → core `transport.ts:54` 接口签名 → `settings-lifecycle.ts:63` → settings-store 只存 providers）。完整通路：

1. **runtime 发出侧**：`config.providers` 广播 payload 与 `config.getProviders` reply payload 均扩展 `{ providers, scopedModels }`（`message-broker.ts` 广播构造 + `settings-message-handler.ts` getProviders case）
2. **core 链扩展**：`packages/core/src/domain/settings/transport.ts` onProviders 接口签名加 scopedModels 参数/字段 → `settings-lifecycle.ts` 订阅透传 → `settings-store.ts` 新增 `scopedModels: Ref<string[]>` 状态与 setter
3. **renderer 门面**：`api/domains/config.ts` onProviders 透传新字段
4. **初始值主动拉取**（防 broadcast 时序竞争，AGENTS.md 历史教训）：打开 Provider 页时现有 `refreshProviders()` 拉 getProviders，reply 已含 scopedModels，store 同步填充——无需新 RPC
5. **mock 层适配**：`api/mock/index.ts` onProviders 与 setScopedModels mock 同步扩展（VITE_MOCK 模式可用）

### 3.4 RPC 契约

```ts
// packages/shared/src/protocol.ts 新增/扩展
'config.setScopedModels': {
  request: { models: string[] }        // provider/modelId 复合串数组，序 = 显示序；[] = 清除
  response: { scopedModels: string[] } // 回写后的规范化结果（去重保序）
}
'config.getProviders': {               // reply 扩展（广播 config.providers 同构）
  response: { providers: ProviderInfo[], scopedModels?: string[] }
}
```

- handler 流程：格式校验（每条 `^[^/]+/.+$`，非法整单拒绝返回可操作错误）→ 去重（保序）→ `extrasStore.modifyScopedModels` 写 providers.json → 列表非空时同步 `setDefaultModel(scoped[0])` → `broadcastProviderList()`（含 scopedModels 字段）+ `config.defaults` 广播
- 删除 provider 的既有路径（`deleteProvider` / `removeProviderByKind`）同步清理 scopedModels 残留：新增 `cleanScopedModelsResidue(providerId)`（filter 掉 `providerId/` 前缀条目），与现有 `cleanEnabledModelsResidue` 对称挂接（`provider-config-helper.ts:682,727,753` 三处）

---

## §4 验收

### 4.1 验收场景（全部可用真实链路验证）

| 场景 | 操作 | 预期结果 | 回溯目标 |
|------|------|----------|----------|
| S1 固定模型集 | RPC 写入 3 个模型 → 读 `model.list` / GUI 打开选择器 | 只显示这 3 个，其余全部隐藏 | G1 |
| S2 自定义顺序 | 列表 [A,B,C]，把 B 上移到首位 | `model.list` 顺序变为 [B,A,C]；settings.json `defaultModel` = B（写入断言）；GUI 分组中 B 所在组排首 | G2 |
| S3 OAuth catalog provider 模型 | 添加 OAuth 认证 provider（auth.json-only，models.json 无条目，如 kimi-coding）的模型并置首 | 正常添加、显示、可选中切换；**spawn 读回 default 仍为该模型**（findValidDefaultModel 不冲掉） | G3 |
| S4 GUI 即时生效 | GUI 添加模型后不重启直接打开选择器 | 新模型已显示（`model.list` 广播驱动，无手动刷新） | G4 |
| S5 新会话默认 | scoped[0]=X 时新建会话 | 会话级状态广播/快照的 modelId = X（断言 session.modelId 终态，覆盖 catalog 与 custom 两种 provider 源） | G2 |
| S6 toggle 共存（**前置：enabledModels 处于白名单模式**，即已写入过 `<id>/*` pattern——默认空白名单态 toggle OFF 是 no-op） | scoped 含 provider P 的模型，再 toggle OFF P | P 的模型从选择器消失（provider 开关优先），scoped 列表条目保留（重新 toggle ON 即恢复显示） | - |
| S7 清空恢复 | 移除全部 scoped 条目 | 选择器恢复全量显示，default 不变 | G1 |
| S8 残留清理 | scoped 含 provider P 的模型，删除 P | scoped 列表自动清除 P 的条目 | - |

### 4.2 边界场景

| 场景 | 处理方式 |
|------|----------|
| scopedModels 字段非法（非数组/条目格式错） | 读侧过滤非法条目 + log warning，不隔离文件；写侧整单拒绝 |
| scoped 条目指向已删除模型 | 聚合时静默跳过；UI 列表该条目标注「模型已不存在」可移除 |
| 重复条目 | 写侧去重（保序），UI 重复选择拒绝 |
| 未认证 provider 的模型 | 可添加，行/条目显示警示标记（`apiKeySet === false`） |
| provider 编辑后模型 id 变化 | 旧条目变残留（按「已不存在」处理），用户手动清理 |
| pi 会话内切模型回写 defaultModel | 接受错位（现有语义），下次调整 scoped 时重新对齐（决策 D3） |
| toggle OFF 承载 default（=scoped[0]）的 provider | 现有 `pickEnabledDefaultModel` 重选 default 不感知 scoped，新 default 可能在 scoped 外（选择器不可见但 default pill 显示实际值）——接受现有行为，用户可再调整；不为此扩展重选逻辑 |

### 4.3 验收执行方式

- **自动化（主）**：runtime 单测覆盖 aggregateModels 过滤/排序/优先级/残留跳过、handler 校验与广播触发、residue 清理、findValidDefaultModel catalog 源校验（扩展 + 回归锁定现有行为）；renderer 组件测试覆盖 ScopedModelSection 渲染与事件。三视角（构建者白盒 + 使用者黑盒 DOM 断言 + 观察者形态）。测试放置**按被测对象现有基线**：aggregateModels/handler 测试扩展 `packages/runtime/test/`（model-service.test.ts、settings-message-handler.test.ts），extras-store 测试在 `packages/runtime/src/services/__tests__/`
- **S5 断言手段**：session 创建后断言 session 级 modelId（`session-service.ts:530-558` 切模型链已直写 `session.modelId` 并广播快照；spawn 成功即终态）——不依赖 pi stdout 探针
- **GUI 探针（补充）**：`pnpm dev` 后 Playwright 连 9222，走 S1/S2/S4 真实点击路径断言选择器 DOM
- **不可用探针（明确排除）**：pi `--list-models` 不受任何白名单影响（0.84.1 dist 实测），不能作为本功能验收手段

---

## §5 下一层拆分（cw 开发单元）

### 5.1 任务清单

| 任务 | 文件 | 优先级 | 依赖 | 验收检查点 |
|------|------|--------|------|------------|
| U1 shared 契约 + extras-store 顶层 API | `packages/shared/src/protocol.ts`（setScopedModels 命令 + getProviders/广播 payload 扩展）；`packages/runtime/src/services/provider-extras-store.ts`（modifyScopedModels + 读容错） | P0 | 无 | 单测：读写往返、非法值容错、去重、与 per-provider modify 并发安全 |
| U2 runtime 过滤/排序 + RPC + 默认模型链修复 | `model-service.ts`（aggregateModels 过滤重排）；`interfaces.ts` + `config-service.ts`（getScopedModels 接线）；`settings-message-handler.ts`（case + 广播 + getProviders reply 扩展 + default 同步）；`provider-config-helper.ts`（cleanScopedModelsResidue 挂三处）；`pi-provider-store.ts`（findValidDefaultModel catalog 源扩展） | P0 | U1 | 单测：S1/S2/S3(default 读回)/S5(modelId 终态)/S6/S8 全场景 + 现有行为回归锁定 |
| U3 renderer/core 接收链 + UI | core `transport.ts`/`settings-lifecycle.ts`/`settings-store.ts`（onProviders 链 + scopedModels 状态）；renderer `api/domains/config.ts` + `api/mock/index.ts`；`packages/ui/src/features/settings/common/ScopedModelSection.vue`（新增）；`composables/features/settings/useScopedModels.ts`（新增）；`ProviderPage.vue`（顶部挂载） | P0 | U2 | 组件测试：列表渲染/上移下移/移除/添加面板/警示标记/「已不存在」标注；store 链路透传；页面集成后可见 |
| U4 端到端验收 + 回归 | GUI 探针（S1/S2/S4）；全量 lint + 三包测试 | P0 | U3 | 探针断言通过；无回归 |

### 5.2 文件改动地图

```
packages/
├── shared/src/
│   └── protocol.ts                                  ← 修改：setScopedModels 命令 + getProviders reply/广播 payload 扩展
├── core/src/domain/settings/
│   ├── transport.ts                                 ← 修改：onProviders 接口签名扩展
│   ├── settings-lifecycle.ts                        ← 修改：订阅透传 scopedModels + refreshProviders 填充
│   └── settings-store.ts                            ← 修改：新增 scopedModels 状态与 setter
├── runtime/src/
│   ├── interfaces.ts                                ← 修改：IConfigService.getScopedModels
│   ├── services/
│   │   ├── provider-extras-store.ts                 ← 修改：顶层 scopedModels 读写（modifyScopedModels）+ 容错
│   │   ├── config-service.ts                        ← 修改：getScopedModels 实现
│   │   ├── model-service.ts                         ← 修改：aggregateModels 按 scoped 过滤 + 重排
│   │   ├── provider-config-helper.ts                ← 修改：cleanScopedModelsResidue 挂 deleteProvider/removeProviderByKind
│   │   └── __tests__/（extras-store 测试扩展）
│   ├── infra/pi/pi-provider-store.ts                ← 修改：findValidDefaultModel catalog 源校验扩展
│   ├── transport/
│   │   ├── settings-message-handler.ts              ← 修改：config.setScopedModels case + 广播 + getProviders reply + default 同步
│   │   └── message-broker.ts                        ← 修改：broadcastProviderList payload 构造扩展
│   └── test/（model-service / settings-message-handler / pi-provider-store 测试扩展）
├── ui/src/features/settings/common/
│   └── ScopedModelSection.vue                       ← 新增：配置组件（props/emits 接线）
├── renderer/src/
│   ├── api/domains/config.ts                        ← 修改：onProviders 透传 + setScopedModels 门面
│   ├── api/mock/index.ts                            ← 修改：onProviders/setScopedModels mock
│   ├── composables/features/settings/
│   │   └── useScopedModels.ts                       ← 新增：状态 + RPC 调用
│   └── components/settings/provider/
│       └── ProviderPage.vue                         ← 修改：顶部挂载 ScopedModelSection
└（ModelSelectPopover / spawn 链路：零改动）
```

### 5.3 技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| config.providers payload 扩展破坏现有消费方 | 低 | 中 | scopedModels 为可选字段，旧消费方忽略；grep 全部 onProviders 订阅点确认 |
| aggregateModels 改动影响无 scoped 现有行为 | 低 | 高 | scopedModels 为空走原路径（guard 分支），回归测试锁定现状输出序 |
| findValidDefaultModel 扩展引入默认链回归 | 中 | 高 | 先为现有行为写锁定测试（wasFixed 写回、fallback 序），再扩展；S3 子场景专测 |
| providers.json 并发写（quota 域同文件） | 低 | 中 | 已有 proper-lockfile 锁内 RMW，顶层字段走同一 withFileLock |
| pi 回写 defaultModel 与 scoped[0] 错位 | 中 | 低 | 决策 D3 明确接受 + 文档化，UI default pill 显示实际 default |

### 5.4 依赖项

无新增外部依赖。全部复用：`@xyz-agent/shared` 协议、XyzProviderStore 存储机制、`broadcastProviderList` 广播、`setDefaultModel` 链路、`refreshProviders` 拉取范式、ui 包基础组件。

---

## 附录 A: 关键证据锚点（两轮审查实证）

| 事实 | 位置 |
|------|------|
| aggregateModels 现有过滤仅 enabled 布尔（纯函数，providers 由调用方传入） | `packages/runtime/src/services/model-service.ts:115-126` |
| ModelService 依赖注入面（config 已注入） | `packages/runtime/src/services/model-service.ts:61-68` |
| deriveEnabled 只认 provider 前缀 pattern | `packages/runtime/src/services/provider-catalog.ts:33-35` |
| toggle OFF 按前缀连带清 model 级条目；空白名单 toggle OFF 是 no-op | `packages/runtime/src/services/provider-config-helper.ts:572-581` |
| toggle OFF 承载 default 时 pickEnabledDefaultModel 重选写回 | `packages/runtime/src/services/provider-config-helper.ts:597-607` |
| providers.json schema（version/providers/modelStates）；modify 只触达 provider 条目 | `packages/runtime/src/services/provider-extras-store.ts:24-42, 175-187` |
| broadcastProviderList 双推 + 7 触发点 | `packages/runtime/src/transport/message-broker.ts:143-149`、`settings-message-handler.ts` |
| renderer onProviders 链只透传 providers 数组（丢弃其余字段） | `packages/renderer/src/api/domains/config.ts:143-146` → `packages/core/src/domain/settings/transport.ts:54` → `settings-lifecycle.ts:63` |
| getProviders reply 现只含 providers | `packages/runtime/src/transport/settings-message-handler.ts:63` |
| spawn 模型 = options.model ?? getDefaultModel() | `packages/runtime/src/infra/pi/rpc-client.ts:155-160` |
| findValidDefaultModel 主路径只查 models.json；失败 fallback 重选并 wasFixed 写回 | `packages/runtime/src/infra/pi/pi-provider-store.ts:301-378` |
| setDefaultModel 写 settings.json model 域（无校验） | `packages/runtime/src/infra/pi/pi-provider-store.ts:382-387` |
| config-service 已持有 providerExtrasStore | `packages/runtime/src/services/config-service.ts:156-157` |
| pi enabledModels 消费点在 TUI/CLI（软白名单、启动读一次、--list-models 不受影响） | pi 0.84.1 `dist/main.js:635-638`、`dist/core/model-resolver.js:203-269`、`dist/modes/interactive/components/model-selector.js:50`（隔离环境探针实测佐证） |
| renderer 分组 Map 保插入序 | `packages/renderer/src/components/panel/ModelSelectPopover.vue:126-137` |
| ui 包零 renderer import 铁律 | `packages/ui/src/features/settings/provider/ProviderEditBody.vue:9` |
| 会话切模型直写 session.modelId 并广播快照 | `packages/runtime/src/services/session/session-service.ts:530-558` |

## 附录 B: 术语表

| 术语 | 定义 |
|------|------|
| Scoped Model | 模型白名单 + 有序列表；非空时模型选择器只显示其中模型，序 = 数组序 |
| scopedModels | `providers.json` 顶层 string[] 字段，条目为 `provider/modelId` 复合串 |
| toggle provider | 现有 provider 级开关（pi settings.json.enabledModels，`<id>/*` 白名单），与本功能独立、优先级更高 |
| modelStates | providers.json provider 条目内既有字段 `Record<modelId, {enabled}>`，模型级 enabled 黑名单语义，与 scopedModels 正交组合 |
| auth.json-only catalog provider | 凭证在 auth.json（OAuth/api_key）而 models.json 无条目的内置目录 provider；findValidDefaultModel 原不识别（本设计 D3 修复） |
