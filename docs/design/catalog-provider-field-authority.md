# Provider 字段权威收口设计（catalog 模型级权威 + 凭据读路径收口 + P0 拆雷 + 模型字段语义对齐）

> **一句话结论**：xyz-agent 的 provider 数据心智（单 api / 单 baseUrl 的 provider 级权威）与 pi 现实（模型级字段权威、provider 级字段仅作覆盖式网关、凭据在 auth.json）不匹配，且写入 models.json 的字段语义与 pi 读取语义在三个维度上不对齐（schema 违规值 / artifact 捏造 / 语义坍缩），已造成 5 个缺陷并埋着一颗未爆 P0（一次普通保存可让 pi 拒载整个 models.json、全部 custom provider 静默消失）；本设计把 provider 数据的展示与操作全部对齐 pi 真实语义——provider 级字段「用户网关优先、否则模型集派生」、写侧防线按 pi schema 违规字段全集拆雷、模型字段出厂显式化对齐 pi 门控语义、凭据解析收为唯一通道、测试连接改为 per-model 真实请求——并用 lint + 约束登记结构性防止复发。

- **当前层 → 下一层**：技术方案 → 实现计划（§5 拆出 M1–M5 五个实施单元）。下一层产物是可实现的接口 / 数据模型 / 任务拆分，本设计属「技术方案设计」类（运行时断言、数据流、错误处理全部按 P0 标准处理）。
- **实装基线**：`@earendil-works/pi-coding-agent@0.84.4` / `pi-ai@0.84.4`（`npm ls` 实测），pi 侧事实全部以 node_modules 实装 dist 为准。

---

## 1. 背景目标

**本节结论：用户看到的是「opencode-go 导入后显示错乱、测试连接失败」「自定义模型的思考档位只剩『关』」，根本问题是 xyz-agent 的 provider 数据模型按「custom provider + 单协议网关」心智设计，与 pi 的数据权威与读取语义在多层冲突；本设计的目标是展示与操作全部对齐 pi 真实语义，并让同类缺陷结构性不可能复发。**

### SCQA

- **S（情境）**：xyz-agent 的 settings-provider 页管理两类 provider：custom（定义全在 models.json，含 apiKey）与 catalog（定义在 pi 二进制内置目录，凭据在 auth.json，models.json 只存用户 override）。runtime 的 `listProviders` 把两源聚合成统一的 `ProviderInfo` 下发前端；用户编辑的模型配置（含思考档位）最终也落 models.json，由 pi 读取并生效。
- **C（冲突）**：catalog provider 的 provider 级 `api`/`baseUrl` 在 pi 侧并非「单值权威」——pi 0.84.4 实装中 opencode-go 的 provider 级 `api` 是三键 map、没有 `baseUrl`，25 个模型各自携带 `api`+`baseUrl`（`pi-ai/dist/providers/opencode-go.js:7-19`）；models.json 里 catalog 条目的 provider 级 `baseUrl` 另有官方语义（覆盖式网关，见术语表）。xyz 的数据心智假设 provider 级单值权威，导致：展示的是构建期捏造的 artifact、测试连接必然失败，且一次普通保存会把空串 baseUrl 写进 models.json——pi 的 TypeBox 校验**拒绝整个文件**（已实测），该用户全部 custom provider（含 apiKey）与 override 静默消失。同类不对齐还发生在模型级字段上：pi 的思考档位门控把 `reasoning` 缺失等同 `false`（`pi-ai/dist/models.js:549`），而 xyz 的两个模型写入入口（模型发现合并、行级思考策略）不写 `reasoning`——用户给自定义模型设置的思考档位在 composer 只剩「关」（models.json 实测实锤）。
- **Q（问题）**：如何让 settings-provider 页对 provider 的展示与操作对齐 pi 的真实语义（模型级权威 + provider 级网关覆盖 + 模型字段门控语义），拆除 P0 雷并救回已踩雷用户，同时结构性防止「每接一个 catalog/模型能力特性就踩一次坑」的复发模式？
- **A（答案）**：模型级权威收口——① 写侧防线按 pi schema 违规字段全集拆 P0（前端空串不传键 + runtime 空串剥除/清除 + catalog 分体系语义 + 不物化空壳 + 存量毒化启动清洗）；② 模型字段出厂显式化（reasoning 三入口收口 + 思考预设对齐 pi 过滤语义）；③ 凭据解析收为唯一通道（5 条散落解析链迁移 + lint 禁直查）；④ 测试连接改 per-model 真实请求，GET /v1/models 正名「模型发现」；⑤ provider 级展示改为「用户网关优先、否则模型集派生」。本文展开这个答案。

### 系统是什么（给不了解背景的读者）

xyz-agent 是 Electron 桌面应用，settings-provider 页（`packages/ui/src/features/settings/`）让用户管理 LLM provider：看列表、展开编辑、测试连接、保存。数据链路：

```
pi 内置 catalog（编译期快照 packages/runtime/src/generated/builtin-providers.json，git 跟踪，39 个 provider）
  ⊕ models.json（~/.xyz-agent/pi/agent/models.json，custom 定义 + catalog override，pi 与 xyz 共享读写）
  ⊕ auth.json（~/.xyz-agent/pi/agent/auth.json，catalog 凭据，pi 与 xyz 共享读写）
  ⊕ providers.json（xyz 私有 extras：authMethod/quota/modelStates）
    → runtime listProviders 聚合（packages/runtime/src/services/provider-config-helper.ts:404）
    → WS 下发 → 前端 settings 页
```

**关键术语**（本段定义，全文复用）：

- **catalog provider**：定义来自 pi 内置目录的 provider（如 opencode-go、openai、anthropic）。判据 = id 命中快照（`provider-catalog.ts:30 isCatalogProvider`）。凭据在 auth.json，models.json 里同 id 条目只是 **override**（用户侧覆盖，pi 合并语义 = 内置定义 ∪ override）。
- **混合协议 provider**：provider 级 `api` 是 map（多协议实现并存）、运行时按每个模型自己的 `model.api` 分发的 provider（pi-ai `dist/models.js:423-427`：「an api map dispatches on model.api」）。锚例 = opencode-go：25 个模型分属 anthropic-messages（2 个）/ openai-completions（20 个）/ openai-responses（3 个）三种协议，baseUrl 也分两组。
- **网关覆盖机制（pi 官方语义，本设计的关键事实）**：models.json 里 catalog 条目的 provider 级 `baseUrl` 是 pi 官方支持的「自定义网关」通道——`provider-composer.js:98`（applyModelsJson）对**全部内置模型**执行 `baseUrl: config.baseUrl ?? model.baseUrl`：override 键存在即**替换**该 provider 全部内置模型的请求端点。用户用途：镜像站、代理、企业网关。「给 catalog provider 换端点」不需要逐个改 25 个模型，改一个键即可——这是本设计必须保留（而非砍掉）的合法工作流。provider 级 `api` 同位置消费（`:49`，仅作 override 自定义模型的协议缺省）。
- **artifact（快照捏造字段）**：构建期脚本 `gen-builtin-providers.mjs` 为对齐「provider 级单值」schema 捏造的字段值，不是 pi 真实数据：`:356` `api: models[0]?.api ?? ''`（取第一个模型的协议冒充 provider 协议）、`:357` `baseUrl: provider.baseUrl ?? ''`（pi 无此字段时落空串）。锚例 = opencode-go 在 settings 页显示「类型：anthropic-messages」——那只是它 25 个模型里第一个的协议。
- **读路径收口**：所有「给我 providerId、还你生效凭据」的读取经过唯一入口。现状是 5 条互不知情的解析链（§2.3）。

### 设计目标（从使用者体验倒推）

- **G1（展示真实）**：用户在 settings 页看到的 catalog provider 信息永远等于 pi 真实生效语义——不再有「类型：anthropic-messages」式误导；混合协议 provider 的协议分布对用户可见；用户设置的网关覆盖值如实展示。
- **G2（操作无害）**：用户在 settings 页做任何保存操作都不可能弄丢其他 provider——P0 雷拆除；已踩雷用户的 models.json 自动修复、消失的 custom provider 回来。
- **G3（测试可信）**：「测试连接」测的是真实聊天要走的协议与端点——成功 = 真的能聊；失败 = 告诉用户哪个协议哪个模型为什么失败、去哪修。
- **G4（收口防复发）**：凭据读取有唯一入口，新场景不需要也不会再发明第 6 条解析链（lint 机器拦截）；约束登记进 constraints.json 进 CR 视野。
- **G5（档位如实）**：用户为自定义模型设置的思考档位在 composer 真实可选——落盘的模型能力字段语义与 pi 门控语义一致，不再「设置了高档、弹层只有关」。

### In / Out of Scope

- **In scope**：settings-provider 页对 catalog provider 的展示 / 保存 / 测试连接 / 模型发现；自定义模型思考档位链路（reasoning 出厂显式化 + 预设过滤语义对齐）；models.json 写侧防线与存量清洗；provider 凭据读路径收口与防复发约束；本设计文档引用的 pi 语义锚点卫生。
- **Out of scope**：① 模型双名称（id/name）编辑表单与 composer 显示 `provider/model` 两个独立 UI 改进——改动面小（2 组件 + 1 composable + i18n），分析结论已在 `/tmp/handoff-xyz-agent-model-display-name.md`，按 dev-flow 小改动直接实施，不进入本设计；② pi 侧行为修改（铁律：不改 pi 源码）；③ quota fetcher 本身的协议逻辑；④ overlay 刷新链对 pi 侧 `models-store.json` 的无锁写竞态（现状风险，见 §3.4 登记，独立问题）；⑤ ProviderInfo 判别联合类型重构（列为远期演进，见 §3.2 方案 C）。

---

## 2. 现状与问题分析

**本节结论：五个缺陷共享同一根因——xyz 按「provider 级单值权威 + 字段可缺省」的心智写入与消费 pi 数据，而 pi 的权威在模型级（provider 级字段另有覆盖式网关语义）、读取语义对缺失字段有硬判定（reasoning 缺失 = 不支持思考、空串 = schema 违规拒整个文件）；历次统一只收口了写路径，读路径从未收口（5 条独立凭据解析链并存），且没有任何结构约束阻止第 6 条出现。**

### 2.1 失败模式 A：P0 雷——一次普通保存毒化整个 models.json（未爆，已实测引爆链）

**用户视角的触发序列**（任何 catalog provider 通用，以 opencode-go 为例）：

1. 用户在 settings 页展开 opencode-go（已导入、凭据在 auth.json）。
2. 编辑体显示「类型：anthropic-messages」「Base URL：（空）」——快照 artifact 回填（`use-provider-edit.ts:338-339`：`form.api = p.api ?? 'anthropic-messages'`、`form.baseUrl = p.baseUrl ?? ''`）。
3. 用户改一个**无关字段**（如加一条自定义 header），点保存。
4. `save()` **无条件**回传 `type: form.api` + `baseUrl: form.baseUrl`（`use-provider-edit.ts:467-468`，不读 `kind`，catalog/custom 无区分）。
5. runtime `applyProviderLevelFields`：`if (data.baseUrl !== undefined) merged.baseUrl = data.baseUrl`（`provider-config-helper.ts:538`）——`''` 非 undefined，空串写入；`:539` 快照 api 固化进 override。`upsertProvider` 落盘（`:765`）。
6. pi 下次加载 models.json：TypeBox 校验 `ProviderConfigSchema.baseUrl = Type.Optional(Type.String({ minLength: 1 }))`（`pi-coding-agent/dist/core/model-config.js:171`）→ 空串违规 → **拒绝整个文件**，`ModelConfig.load` 返回空 Map + error 字符串（`:232-238`）。
7. 后果：models.json 里**全部** provider（custom 的 deepseek 及其 apiKey、全部 override）从 pi 视野静默消失；catalog provider 因定义在内置 catalog、凭据在 auth.json 而幸存。错误只经 pi 侧 ModelRuntime.getError() 暴露给 **pi 自己的 TUI/CLI**（`interactive-mode.js:854` 等 5 处）——xyz-agent 这类 RPC 宿主看不到任何告警。

**探针 P-poison（✅ 已实测，2026-09-10）**：构造含 `opencode-go.baseUrl=""` + 合法 deepseek 的 models.json，调 pi 0.84.4 实装 `ModelConfig.load`：

```
毒化文件 → providers.size = 0（deepseek 连带消失）
error = "Invalid models.json schema:\n  - providers.opencode-go.baseUrl: must not have fewer than 1 characters"
对照（删掉 baseUrl:"" 键）→ providers.size = 2，error = undefined
```

**空串毒化的字段全集（不止 baseUrl）**：pi schema 的 `minLength: 1` 约束覆盖 provider 级 `name/baseUrl/apiKey/api`（`model-config.js:170-173`）+ 模型级 `id/name/api/baseUrl`（`:137-140`）+ modelOverrides 级 `name`。审查探针复核（对抗审查第 1 轮实跑）：`apiKey:""`、`models[0].baseUrl:""`、`models[0].api:""` 同样使 `ModelConfig.load` 返回 size=0。其中 **`apiKey:""` 是活路径**：前端「清除 API Key」哨兵（`use-provider-edit.ts:135`，`API_KEY_CLEAR_SENTINEL`）→ save 发 `apiKey:''`（「清除」语义）→ `provider-config-helper.ts:523` 对 custom 无条件 `merged.apiKey = data.apiKey`——空串直接落盘，同链毒化。

**现有自愈机制救不了**：`sanitizeInvalidProviders` 的 `isInvalidProvider` 按「八字段全缺才算空壳」判定（`pi-provider-repair.ts:54-72`），空串按 falsiness 视同「未指定」——只要条目还有 apiKey/headers 等任一字段即放行，TypeBox 照拒。且修复产物保留空串键，恒挂，需用户手动删条目。历史痕迹：QuickSetup 曾对含 opencode* 在内的 7 个 provider 保存过空串 baseUrl 条目（`pi-provider-store.ts:478-486` MF-5 注释）。

**存量冻结 artifact 的活性危害（非空键也坏）**：历史保存不仅冻结空串，也冻结**非空** artifact——用户保存过 fireworks 后，models.json override 含 `baseUrl: "https://api.fireworks.ai/inference"`（快照 artifact 值，实测该 provider 的模型 baseUrl 有两种：`.../inference` 与 `.../inference/v1`）。经网关覆盖机制（`provider-composer.js:98`），这个 override 键会把 fireworks **全部**模型的 baseUrl 改写为无 `/v1` 的值——带 `/v1` 的那批模型聊天实际打到错误端点。schema 层不报错（非空合法），静默路由错误。

**连带发现（同类写入面）**：① `provider-importer.ts:319` fallback 路径（`credentialWriter` 未注入时）把 `tpl.api`/`tpl.baseUrl`（同为快照 artifact）写进 models.json，且同分支还写 `config.apiKey`（M5-01 同族错位）——生产恒注入故未爆，是潜伏雷；② 前端对 **custom** provider 同样无条件回传空串 `baseUrl`（新增 custom 时 baseUrl 留空保存即毒化）——雷不局限于 catalog；③ **OAuth 授权收尾链**（`useProviderPageOauth.ts:122-127`）无条件回传 `{name, type: target.api, baseUrl: target.baseUrl, authMethod:'oauth'}`——target 是 ProviderInfo，api/baseUrl 是 artifact/派生值，每次 OAuth 登录都会把 artifact 冻结进 override（现状靠这三个字段避开空壳判定，注释自述「避免 models.json 空壳条目」）；④ 前端类型 Select 把选项钳为 3 值（`ProviderEditBody.vue:37-39`），快照 api 不在三值内的 catalog provider（bedrock-converse-stream、google-vertex）回显即为异常态。

### 2.2 失败模式 B：展示 artifact——用户看到的「类型/Base URL」不是 pi 真实数据

- 编辑体「类型」「Base URL」输入框对 catalog 与 custom **完全同版渲染**（`ProviderEditBody.vue:32-41`、`:47`，无 kind 门控），初值 = `resolveCatalogDisplayFields` 的回退链 `api: override?.api ?? builtinP.api`、`baseUrl: override?.baseUrl ?? builtinP.baseUrl`（`provider-config-helper.ts:317-318`）——无 override 时直透快照 artifact；有 override 时透传冻结值（用户网关与冻结 artifact 无法区分）。
- 模型清单 UI **不展示** model 级 api/baseUrl/name（`ModelListSection.vue:103` 只渲染 `m.id`；builtin 只读列表 `ProviderEditBody.vue:274-275` 只渲染 name+id）——混合协议对用户完全不可见。
- **量化（探针 P-scope，✅ 已实测快照）**：39 个 catalog provider 中，7 个 provider 级 baseUrl 为 `''`（amazon-bedrock / azure-openai-responses / cloudflare-ai-gateway / cloudflare-workers-ai / google-vertex / opencode / opencode-go）；5 个模型 api 混合（cloudflare-ai-gateway 3 种、fireworks 2 种、github-copilot 3 种、opencode 4 种、opencode-go 3 种）；38/1290 个模型级 baseUrl 为 `''`（azure-openai-responses 38/38 全空——host 型目录天然无模型级 baseUrl）。
- **artifact 的三个产出点**：gen 脚本 `:357`（provider 级 baseUrl `?? ''`）、gen 脚本 `:307`（model 级 baseUrl `?? ''`）、overlay 归一化 `provider-catalog.ts:74-75`（`api ?? ''`、`baseUrl ?? ''`）。
- 保存一次后 artifact 被「冻结」：override 优先于快照，错误的 api/baseUrl 永久固化（失败模式 A 的第 5 步同时是展示侧的固化点）。

### 2.3 失败模式 C：测试连接必然失败 + 凭据读路径从未收口

**测试连接现状链**（对 catalog provider 每一步都错）：

```
用户点「测试连接」
  → use-provider-edit.ts:397-403 发 payload{baseUrl:''（artifact）, apiKey:undefined（表单未改）, providerType:'anthropic-messages'（artifact）, providerId}
  → settings-message-handler.ts:714 凭据回查只查 models.json：configService.getProvider(providerId)?.apiKey
      ——catalog 凭据在 auth.json，恒 miss
  → model-api-discoverer.ts:20-31 ''.replace(...) → 拼出相对路径 "/v1/models"
  → Node fetch 抛 TypeError → classifyDiscoveryError 归 UNKNOWN
  → 前端 testResult='error'；真实错误只在 dirty save-bar 的 actionError 可见，固定文案「连接失败，请检查 API Key」
```

更深层的是**即使修好 baseUrl 拼接，这个测试也不可信**：GET `/v1/models` 与真实聊天端点脱节——真实聊天按 `model.api` 协议 POST 到 `model.baseUrl`（pi-ai `dist/models.js:444-450` 按 model.api dispatch；opencode-go 的 anthropic 模型与 openai 模型 baseUrl 都不同）。且 pi 生态**没有任何内置 provider 接线 fetchModels**（grep 全 dist 零命中，仅 createProvider 通用钩子存在）——catalog 的模型清单是编译期权威，「发现模型」对 catalog 本无语义。

**凭据读路径全景（「读路径从未收口」的证据）**：runtime 至少 5 条互相独立的凭据解析链，各自硬编码源集合与 fallback 顺序——

| # | 解析链 | 位置 | 数据源 |
|---|--------|------|--------|
| 1 | `QuotaService.getCredential` | `quota-service.ts:576-596` | secrets → auth.json（经 AuthService）→ models.json（唯一三源链，quota 私有） |
| 2 | `handleDiscoverModels` 内联回查 | `settings-message-handler.ts:714` | payload → **仅 models.json**（缺 auth.json） |
| 3 | `pi-provider-store.readAuthCredentials` | `pi-provider-store.ts:175-187` | **私有裸 readFileSync 读 auth.json，绕过 AuthStorage/AuthService**，被 `:353`、`:384` 两处消费 |
| 4 | `AuthService.getCredential` | `auth-service.ts:99` | 仅 auth.json 单源 |
| 5 | `listProviders` 内联 apiKeySet 判定 | `provider-config-helper.ts:335`、`:368/:381` | authIdSet ∪ models.json apiKey 的内联拷贝 |

对照：写路径已经历次收口（auth.json 写收敛 AuthService / 寄生字段写切 XyzProviderStore / 单源 file lock），读路径是逐场景打补丁、无结构约束（无 lint / 无类型区分 / 无强制通道）。「为什么统一过还散落」的答案：统一全部发生在写侧，读侧从未有过唯一入口。

### 2.4 失败模式 D：自定义模型思考档位「只有关」——reasoning 字段语义坍缩

**用户视角的触发序列**（2026-09-10 真实用户数据实测实锤）：

1. 用户从零新建自定义 provider「OpenCode Go」，用「自动发现」合并模型，在模型行设置思考策略「高/最高」（high-max），保存。
2. 打开 composer 的思考档位弹层——只显示「关」，设置的高/最高档不存在。

**根因链（两级门控 + 两个不写 reasoning 的入口）**：

- **两级门控**（pi `getSupportedThinkingLevels`，`pi-ai/dist/models.js:548-558`，本段定义全文复用）：第一级 `if (!model.reasoning) return ["off"]`——**`reasoning` 字段缺失等同 `false`**，直接返回只剩「关」；第二级按 `thinkingLevelMap` 过滤，规则为「显式 `null` 才剔除、`xhigh`/`max` 必须显式列出、其余档（off/minimal/low/medium/high）默认保留」。xyz runtime 的 `attachSupportedLevels`（`model-capability.ts`）用 pi 同源函数算出 `supportedLevels=['off']` 下发；composer `ThinkingLevelPopover.vue:105-107` 只渲染 supportedLevels 内的档位——用户设置的 `thinkingLevelMap`（`{off:'off', high:'high', max:'xhigh'}`）根本轮不到被读取。
- **models.json 实测**：该 provider 的 4 个模型 `reasoning` 字段全部**缺失**（不是 `false`——保存链上 `reasoning: undefined` 双端跳过写键：前端 `use-provider-edit.ts:492` 与 runtime `provider-config-helper.ts:613` 都是 `!== undefined` 才写）。schema 层完全合法（`reasoning` 是 `Optional(Boolean)`），毒化防线管不到它——这是与失败模式 A 不同的第三类不对齐：**字段语义坍缩**（合法缺省被 pi 读取语义硬判定为「不支持」）。
- **三个模型写入入口，只有一个是显式的**（均在 `use-provider-edit.ts`）：① **discover 合并**（`:416-418`）——合并发现的模型只带 `id`/`name`/`contextWindow` 三字段，`reasoning` 为 undefined（用户数据命中此入口）；② **行级思考策略** `pickStrategy`（`:560-564`）——只写 `thinkingLevelMap` 不碰 `reasoning`，与新增表单的 watch 联动（`:206-211`：选非 all-levels 自动置 `reasoning=true`）不对称（用户数据命中此入口）；③ **手动新增** `addModel`（`:586-588`）——已被前次修复出厂显式 `reasoning: true`（注释自称「事故 B 根因 ②」，同族事故已爆过一次）。

**次级发现（reasoning 修复后会暴露，同入口顺手修）**：`THINKING_PRESETS` 的预设值与 pi 过滤语义不一致——表单注释按「key = UI 可选档位」的白名单心智构造 map，但 pi 是**黑名单**语义（`null` 才剔除、未列的常规档默认保留）。实测推导（按 `models.js:551-557` 规则）：`on-off` 预设 `{off:'off', high:'high'}` 实际产生 **5 档**（off/minimal/low/medium/high），`high-max` 预设 `{off:'off', high:'high', max:'xhigh'}` 实际产生 **6 档——都不是各自命名的「关/开」两档与「关/高/最高」三档。要达成命名语义需补显式 null 剔除项（`{minimal:null, low:null, medium:null}`）。

**对照组**：deepseek provider 手动新增的模型 `reasoning=true`，档位正常——进一步印证字段显式性是分水岭。pi 运行时 `clampThinkingLevel` 同源钳制（`models.js:560`），UI 强发高档也会被钳回 off——两层一致错，皆因 reasoning 缺失。

### 2.5 根因与物理数据流

**根因（一句话）**：xyz-agent 的 `ProviderInfo`（单 `api` / 单 `baseUrl` 的 provider 级字段 + 字段可缺省的心智）按「custom provider + 单协议网关」设计，pi 现实是混合协议、模型级字段权威、provider 级字段是覆盖式网关、auth.json 凭据、缺失字段有硬读取语义（reasoning 缺失 = 关、空串 = 拒整个文件）——**xyz 写入/消费 pi 数据的每一层语义不对齐都会变成用户可见缺陷**，已暴露 5 个（展示 artifact、测试连接凭据断链、测试连接端点脱节、P0 雷、思考档位坍缩），且没有结构约束防止第 6 个。

**毒化链物理数据流（失败模式 A 全链路）**：

```
[用户] 展开 opencode-go 编辑体，改 headers，点保存
  │  form.api='anthropic-messages'(artifact)  form.baseUrl=''(artifact)
  ▼
[core] use-provider-edit.ts:465-499 save()
  │  payload 无条件含 type + baseUrl（'' 原样发出）
  ▼ WS config.setProvider
[transport] settings-message-handler.ts:176-183
  ▼
[runtime] provider-config-helper.ts:736 applyProviderLevelFields
  │  :538 '' !== undefined → merged.baseUrl = ''     :539 merged.api = 'anthropic-messages'
  ▼ :765 upsertProvider 落盘
[磁盘] ~/.xyz-agent/pi/agent/models.json
  │  providers["opencode-go"] = { name, api, baseUrl:"", headers:{...}, models:[] }
  ▼ pi 下次启动 / reload
[pi] dist/core/model-config.js:232 validateModelsConfig.Check (TypeBox)
  │  providers.opencode-go.baseUrl: must not have fewer than 1 characters → 拒整个文件
  ▼ :237 return new ModelConfig(new Map(), error)
[pi] providers 视野 = 空 Map —— deepseek（含 apiKey）等全部 custom 静默消失
  ※ error 仅 pi TUI/CLI 消费（interactive-mode.js:854 等），xyz RPC 宿主零告警
```

**展示链物理数据流（artifact 怎么到用户眼前）**：

```
[构建期] gen-builtin-providers.mjs :356 api=models[0].api  :357 baseUrl=provider.baseUrl ?? ''
  ▼ 落盘（git 跟踪）
[快照] packages/runtime/src/generated/builtin-providers.json（39 provider，piAiVersion 0.84.4）
  ▼ 编译期 import（provider-config-helper.ts:10）
[runtime] resolveCatalogDisplayFields :317-318  api/baseUrl = override ?? 快照 artifact
  ▼ listProviders → WS → 前端
[UI] ProviderEditBody.vue:32 类型 Select（钳 3 值） / :47 Base URL Input —— 用户看到 artifact
```

---

## 3. 解决方案

**本节结论：终态 = catalog provider 的 provider 级字段语义定为「用户网关优先、否则模型集派生」——写侧防线按 pi schema 违规字段全集拆雷（D1）+ 存量清洗含冻结 artifact 清理（D2）保证 models.json 永不含 artifact/毒化键、模型字段出厂显式化对齐 pi 门控语义（D9）保证思考档位如实、凭据解析唯一通道（D3）+ lint（D6）收口读路径、测试连接 per-model 真实请求（D4）、展示层网关优先派生兜底（D5）；架构级对比（§3.2）后推荐方案 A（模型级权威收口），否决补丁路线与类型全重构。**

### 3.1 终态（使用者视角先行）

**本节结论：终态下，catalog provider 的「类型」不再可编辑（协议是模型级属性，改为派生展示），「Base URL」变为「自定义网关」可选输入框（留空 = 内置端点，填写 = 覆盖全部模型端点——pi 官方网关语义显式化），测试连接按协议分组发真实最小请求，任何保存都不会向 models.json 写入 schema 违规值或 artifact；存量毒化/冻结文件在启动时被自动清洗。**

**场景 A（成功路径：混合协议 catalog provider 的日常操作）**

```
[用户] 展开 opencode-go 编辑体
[界面] 名称：OpenCode Go（可编辑）
       协议：按模型分发（anthropic-messages ×2 / openai-completions ×20 / openai-responses ×3）  ← 只读派生文案
       端点：内置端点（按模型分发）                                                              ← 网关输入框留空时的展示
       模型清单：25 个（内置徽标）name + id 并排（现状即有）
[用户] 点「测试连接」
[界面] ✓ anthropic-messages（代表模型 minimax-m3）连接成功
       ✓ openai-completions（代表模型 qwen3.8-flash）连接成功
       ✓ openai-responses（代表模型 gpt-5.6-luna）连接成功
[用户] 改 headers，保存
[结果] models.json 中 opencode-go override 条目不含 baseUrl/api 键；
       其他 provider（deepseek 等）不受影响，pi 正常加载，聊天正常
```

**场景 A'（网关工作流：用户给 catalog provider 设镜像站——pi 官方覆盖机制显式化）**

```
[用户] 公司要求 opencode-go 走内部网关 https://gw.corp.example/opencode
[操作] 编辑体「端点」输入框（placeholder：留空使用内置端点，填写后覆盖该 provider 全部模型的请求地址）填入网关 URL，保存
[界面] 端点：自定义网关 https://gw.corp.example/opencode（覆盖全部模型）  ← 用户值如实展示，与派生值可区分
[结果] models.json override 含 baseUrl: "https://gw.corp.example/opencode"（合法非空值）；
       pi 经网关覆盖机制把 25 个模型端点全部替换为该值——展示 = 生效
[用户] 后续想回退内置端点：清空输入框保存 → override 的 baseUrl 键被删除（清除语义，见 D1③）
```

**场景 B（失败路径：错误凭据，带恢复指引）**

```
[用户] opencode-go 配了错误 API Key，点「测试连接」
[界面] ✗ anthropic-messages（minimax-m3）：HTTP 401 invalid api key
       ✗ openai-completions（qwen3.8-flash）：HTTP 401 invalid api key
       ✗ openai-responses（grok-4.6）：HTTP 401 invalid api key
       👉 请检查该 provider 的 API Key（在上方「API Key」处重新填写后保存），
          或确认网络/代理可访问 opencode.ai
```

**场景 C（存量毒化用户的自动恢复）**

```
[已踩雷用户] models.json 含 baseUrl:"" 条目（或冻结的 fireworks artifact baseUrl），deepseek 等 custom provider 已消失/路由错误
[升级后首次启动 runtime] 启动清洗日志：
  [provider-repair] stripped empty-string schema keys on "opencode-go": baseUrl, api
  [provider-repair] stripped unmarked provider-level keys on "fireworks": baseUrl   ← 无网关标记，判定为冻结 artifact
[结果] pi ModelConfig.load 通过；deepseek 重新出现；fireworks 模型端点回到各自内置值；用户零操作
```

**场景 D（custom provider 不受影响 + 新增流程自洽）**

```
[用户] 新增 custom provider：填名称/Base URL/API Key
[用户] 点「模型发现」（原「自动发现」正名）→ GET /v1/models 拉到清单 = 连通性与凭据同时验证
[用户] 保存后展开编辑体 → 类型/Base URL 输入框照旧可编辑（custom 的定义权威就是 provider 级）
[用户] 点「测试连接」→ 对清单第一个模型发真实请求（max_tokens=1；模型级 baseUrl 缺省时回落 provider 级 Base URL——pi 同语义）
[界面] ✓ openai-completions（deepseek-chat）连接成功
```

**终态物理数据流（保存链，对照 §2.5 毒化链）**：

```
[用户] 展开 opencode-go，改 headers，保存
  ▼
[core] use-provider-edit save()：catalog → 不带 type 键；baseUrl 恒显式带键（非空=设置网关，''=清除网关）
  ▼
[runtime] setProvider：
  │  防线② schema 违规值剥除：任何 provider 的 name/baseUrl/apiKey/api 及模型级 id/name/api/baseUrl
  │     收到空串 → 剥除或删键（apiKey:'' = 清除语义 delete；其余 = 未指定不写键），对齐 pi「空串无语义且拒载」
  │  防线③ catalog 分体系：type 键忽略（协议是模型级属性）；baseUrl 空串 = 删除 override 既有键（网关回退）；
  │     剥除后无实质字段（八字段全缺）→ 不物化空壳条目
  ▼
[磁盘] models.json override 条目 = { name?, baseUrl?（仅用户网关）, headers, models } —— 无 artifact、无 schema 违规值
  ▼
[pi] TypeBox 校验通过，全部 provider 正常加载
```

### 3.2 架构级方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|---------------|-------------|------|------|
| **A：模型级权威收口（本设计）** | 高——展示/操作对齐 pi 真实语义（模型级权威 + provider 级网关覆盖），provider 级字段「用户网关优先、否则派生」；写侧防线按 schema 违规全集 + 模型字段出厂显式化 + 读侧单点都是 by construction，不依赖「下次记得小心」 | 中——6 个实施单元（§5），触及 runtime/core/ui/scripts 四层 | 派生展示改变 ProviderInfo.api/baseUrl 语义，消费点影响已逐处枚举判定（§3.3 D5）；存量清洗写 models.json 需幂等（探针 P-sanitize） | ✅ 推荐 |
| B：缺陷点补丁（展示兜底 + discover 加 auth.json 回查 + save 加空串过滤） | 低——「provider 级单值权威」的错误心智保留，artifact 字段继续存在并被消费；每个补丁都是对错误分层的修补，下一个 catalog 特性（新协议、新 overlay 源）仍会踩新坑 | 小——每点几行 | 若用它：§2.1 的 P0 虽被 save 过滤拦住，但 importer fallback、OAuth 收尾冻结、类型 Select 钳 3 值、模型级 artifact、凭据 5 链散落全部保留；三个月后回来看，artifact 仍在、读路径仍在长新链——必然想骂人 | ❌ 否决（与前序诊断中用户否决「baseUrl 兜底/单点探活」同理：对 artifact 字段打补丁是错误分层） |
| C：ProviderInfo 判别联合重构（CatalogProviderInfo / CustomProviderInfo 分裂，类型层编译期禁止 catalog 读 provider 级 api/baseUrl） | 高——终局最彻底，编译期防线强于 lint | 大——shared/runtime/core/ui 全消费方迁移（status/models/enabled 共享字段的合并成本），一次 PR Ripple 过大 | 类型分裂波及所有 ProviderInfo 消费点（composer/quota/能力注册表），回归面远超本问题族；且网关语义保留后 catalog 仍需要 provider 级 baseUrl 字段，分裂红利减小 | ❌ 本次否决，列为远期演进——先落 A（运行期防线 + lint），C 作为 A 的稳定后继 |

**推荐理由**：方案 A 用「网关优先派生兜底 + 防线 + 单点」把正确性建在结构上（by construction），而不是建在「每个新场景记得选对数据源」上（方案 B 的实质）；方案 C 的编译期防线虽更强，但 Ripple 与本次问题族不成比例，且 A 落地后 C 的增量价值大幅下降（运行期防线已覆盖主要踩坑面）。

### 3.3 关键决策与权衡

**D1：P0 写侧防线——按 pi schema 违规字段全集的分层拦截（选定）**

- **采用**：六层防线，每层拦截一类路径。**防线作用的字段全集 = pi `minLength:1` 约束全集**（provider 级 `name/baseUrl/apiKey/api` + 模型级 `id/name/api/baseUrl` + modelOverrides 级 `name`，`model-config.js:137-140/:170-173`）——空串值对 pi 任何 provider 都是「写入即拒整个文件」的毒药，防线不按「历史上谁写过空串」挑选字段：
  - **① 前端不产生违规值**：`save()` 对 catalog 不带 `type` 键（协议是模型级属性）；`baseUrl` **恒显式带键**（值 = 网关输入框 trim 结果：非空 = 设置网关、`''` = 清除网关——「undefined = 不变」的既有 merge 协议不动，清除必须走显式空串带键；OAuth 收尾、QuickSetup 等**不带 baseUrl 键**的调用方因此天然「不变」，不会静默清网关）；对 custom 的空串 baseUrl/name 不带键（对齐同代码库既有模式：`use-quick-setup-form.ts:175-176` 的 truthy 守卫）；「清除 API Key」哨兵对 custom 发 `apiKey:''`（runtime 层转为删键，见②）。
  - **② runtime 空串值转译**：`applyProviderLevelFields` / `applyModelRoutingFields` 对全集字段收到空串（**trim 后空串同视**——拦 CLI 发纯空白串的极边缘）——`apiKey` 空串 = **清除语义**（`delete merged.apiKey`，与 `index.ts:533-538` clearApiKey 闭包同构——「清除」的正确落盘形态是删键而非写空串）；其余字段（name/baseUrl/api 及模型级）空串 = 未指定（不写键）+ warn。custom 分支显式接受语义：**用户清空 custom baseUrl 保存 = 不变更**（custom 无「默认」可回退，删除 provider 用删除功能）。
  - **③ catalog 分体系语义**（`isCatalogProvider(id)` 时，provider 级字段的空串由本层接管——②的通用转译只管 custom 与模型级字段，层间分工：catalog provider 级字段全部走③的分体系语义）：`type` 键忽略 + warn（provider 级 api 对 catalog 无用户语义——只影响 override 自定义模型的协议缺省，撤输入框后新增 override 模型的协议缺省回落派生值）；`baseUrl` 非空 = 用户网关——写入 `merged.baseUrl` 的**同时**在 providers.json extras 写显式网关标记 `gatewayBaseUrl`（authMethod 先例同域：显式标注区分「用户显式设置」与「历史冻结」，判定力不依赖任何会漂移的外部数据）；`baseUrl` **显式空串带键** = 清除网关——删除 override 既有 `baseUrl` 键 + 清除 extras 的 `gatewayBaseUrl`（场景 A' 回退通道；**未带键（undefined）= 不变**，对齐既有 merge 协议——OAuth 收尾等不带键调用方天然不动网关）；**写序契约**：设置网关 = 先写 extras 标记、后写 models.json（崩溃中间态 = 多余标记，D2 自愈、重试即恢复）；清除网关 = 先删 models.json 键、后清 extras 标记（崩溃中间态同样是多余标记——两个方向对称取「标记多余可自愈」侧，反向序会静默丢网关）。**extras 写入点唯一**（setProvider 路径经既有 `extrasStore.modify` 通道；importer 不产生网关写入故无 extras 写；`extrasStore.modify` 无内容 diff 守卫——清除分支对不存在的标记 no-op 短路，避免无谓写盘）。**gatewayBaseUrl 判定为仅存在性**（清洗只看键在不在，禁止按值比对——标记值 stale 不影响判定，防复活 v2 值比对问题）；**不物化空壳**——剥除/清除后 merged 若不含八字段（models/baseUrl/headers/compat/modelOverrides/apiKey/oauth/authHeader）任何键，跳过 `upsertProvider` 不落盘条目 + warn（对齐 M5-01「宁丢不写错位」先例，`provider-config-helper.ts:519-523`）。注意：「不物化空壳」对**既有**条目是 no-op 而非删除——用户全清空 catalog override 后旧条目仍在盘上，由 D2 清洗顺序契约中的既有空壳修复分支在下次启动时接管（MF-5 语义：catalog 空壳从快照合并 models 修复），本防线只保证「不再产生新空壳」。
  - **④ importer fallback 修复**：`provider-importer.ts:319` 一带对 catalog provider 不再写 `tpl.api`/`tpl.baseUrl`（artifact），同分支的 `config.apiKey` 错位写（M5-01 同族）一并移除——生产恒注入 `credentialWriter` 走 auth.json 分支，该 fallback 仅为防御路径；fallback 对 catalog 返回 `failed` 状态（reason 引导用户经 UI 配置凭据），不再有「写模板进 models.json」的降级——`imported` 状态语义保持只对真实落盘成立。
  - **⑤ OAuth 收尾链改造**：`useProviderPageOauth.ts:122-127` 的 setProvider 调用改为只传 `{ authMethod: 'oauth' }`（authMethod 落 providers.json extras、凭据由 pi OAuth flow 写 auth.json）——不再随行携带 name/type/baseUrl（artifact 冻结源 + 空壳规避 hack 一并消除；「不物化空壳」防线③兜底保证该调用不再产生 models.json 条目）。
  - **⑥ QuickSetup payload 修复**：`use-quick-setup-form.ts:175-176` 的 payload 去掉 `baseUrl`（truthy 守卫只滤空串——kimi/minimax 系模板的**非空**默认 baseUrl 会被写入 override，v2「非空放行」语义下再被 D2② 无标记剥除，形成每次导入一次的写-剥循环）与 `api` 键（与 `SetProviderData.type` 字段名不匹配，是**从未生效的死键**，顺带清理）——catalog 模板导入只写凭据相关字段（pi 内置定义已自带 baseUrl/api，override 无必要）。
  - **防线载体（结构约束）**：防线②③的核心转译逻辑（空串转译 + catalog 分体系 + 不物化空壳）提取为**共享纯函数**（暂名 `applyProviderWritePolicy(merged, data, kind, source)`，驻 provider-config-helper）——`source: 'settings' | 'import'` 显式区分调用方语义：settings 来源的 catalog 非空 baseUrl = 用户网关（写入 merged）；**import 来源的 catalog provider 级 baseUrl/api 一律剥除**（导入数据不是用户在 xyz UI 显式设置的网关，不产生隐形网关——两个调用方对同一 `kind='catalog'` 的相反处置由 source 维度显式化，不靠 guess）。**纯函数无副作用**：extras 网关标记不在函数内落盘，返回信号 `{ merged, gatewayToSet?: string, gatewayToClear?: boolean }`，extras 编排（`extrasStore.modify` + 写序契约）归 setProvider 调用方执行。入参字段名差异（`SetProviderData.type` vs importer 侧 `PiProviderConfig.api`）在各自入口归一为统一形态后再进纯函数。接入点：`setProvider` 与 importer 的写入路径（W2 应用导入主路径 `provider-importer.ts:251/:322` 直调 infra `upsertProvider`，**不经过 setProvider**——两条路径都在 upsert 前调用）。这使「防线在写入点」而不是「防线在 setProvider」：导入条目的源端 provider 级 api/baseUrl 同样被 catalog 分体系语义拦截（不产生非用户意图的隐形网关）、源端空串同样被转译（外部 agent 配置的等价字段缺省不毒化文件）。
- **被否**：a) 只改前端（防线①单独）——runtime 裸露，importer/OAuth/CLI 与未来调用方可再踩雷，不满足 G4 防复发；b) 写盘前全量 TypeBox 对齐校验——引入 pi schema 漂移面（pi 升级 xyz 校验规则要跟变），且拒写报错把用户保存动作变成失败（空串转译后保存恒成功且语义正确），过重；c) 防线②对 apiKey 也「不写键」——「清除」会退化为「保留旧 key」（不写键 = base spread 保留既有值），清除语义丢失，必须删键；d) 防线③对 catalog 也「永不写 baseUrl」（v1 草案）——砍掉 pi 官方网关工作流（`provider-composer.js:98` 覆盖机制是 pi 真实消费的通道），用户镜像站/代理需求无处安放；改为「非空保留（带 extras 显式标记）、空串清除」；e) 网关标记写在 models.json 条目内（如 `_xyzGateway: true` 类寄生键）——pi schema 是 closed record 之外的自由 JSON？不：pi 对未知键的容忍度未验证且属寄生字段反模式（项目已做过一轮「寄生字段迁移到 providers.json」的清理，A1-5），标记归 xyz 拥有的 providers.json 才是既定方向。
- **证据**：毒化链 §2.1（P-poison 实测 + 审查复核 apiKey/model 级空串同毒化）；pi 语义 `model-config.js:137-140/:170-173`（minLength 全集）；网关覆盖语义 `provider-composer.js:98`；既有先例 M5-01（`provider-config-helper.ts:519-523`）、QuickSetup truthy 守卫（`use-quick-setup-form.ts:175-176`）、clearApiKey 闭包（`index.ts:533-538`）、authMethod 显式标注修复推断歧义（extras 同域先例，`provider-config-helper.ts:319-320`）。
- **效果**：G2 成立——场景 A/A'/D 中保存后 models.json 无 artifact、无 schema 违规值；防线载体（共享纯函数）使防线②③在**全部写入点**（setProvider + importer 主路径/fallback + 未来调用方、CLI、测试脚本）下都成立，不依赖前端传对。

**D2：存量毒化与冻结 artifact 启动清洗（选定）**

- **采用**：扩展 `sanitizeInvalidProviders`（`pi-provider-store.ts:532-573` 同族），启动时对 models.json 逐 provider 条目做两类清洗（先①后②，再做既有空壳判定——顺序见下）：
  - **① 空串键剥除**：全集中任一字段值为 `''` → 删该键（幂等，有剥除才写盘），日志 `[provider-repair] stripped empty-string schema keys on "<id>": <keys>`。
  - **② catalog 条目的 provider 级键处置（判定锚 = providers.json extras 的显式网关标记 `gatewayBaseUrl`，不依赖任何会漂移的外部数据）**：`api` 键**一律剥除**——xyz 对 catalog 的 provider 级 api 没有合法写入通道（编辑体撤输入框 / QuickSetup 死键清理 / importer 走写入策略后不写），保留它只会成为「pi 消费（override 模型协议缺省，`provider-composer.js:49`）但 xyz 不展示」的不可见生效配置；手编用户的协议缺省诉求走模型级 `api` 透传位。`baseUrl` 键：extras 有 `gatewayBaseUrl` 标记 → 用户网关，**保留**；无标记 → 冻结 artifact/模板默认值，**剥除**，日志 `[provider-repair] stripped unmarked provider-level keys on "<id>": <keys>`。写读错位（extras 有标记但 models.json 无键——写序契约的崩溃中间态）→ 清掉多余标记，无害。此判定对 pi bump 快照重生成免疫（参照系是 xyz 自有数据），对「手输值恰等快照值」无歧义（手输网关必带标记，来源区分靠显式标注不靠值比对）；**gatewayBaseUrl 判定为仅存在性**（只看键在不在，禁止按值比对——标记值 stale 不影响判定，防复活 v2 值比对问题）。**extras 访问通道（分层约束，审查 R3-3）**：清洗实装点 `sanitizeInvalidProviders` 在 infra/pi 层，providers.json 唯一读写者是 services 层 `XyzProviderStore`（C-comm-03，与 D3 链 3 同类约束）——标记读取经注入的同步原语（`getExtrasSync` 已有 sync 形态）进清洗函数签名；「清多余标记」是 async 锁内写，**不塞进同步清洗段**——清洗段产出「待清标记清单」，由启动流程的 async 阶段编排 `extrasStore.modify` 执行（改动地图已列）。
  - **顺序契约**：空串剥除 + provider 级键处置先行，然后进入**既有**空壳判定/修复（MF-5 语义不变：catalog 空壳从快照合并 models 修复、非 catalog 空壳删除）——剥键后仅剩 name 的条目（如 OAuth 历史空壳）由既有修复分支接管，不新增第三套空壳语义。
  - 清洗失败仅 warn 不阻断启动（对齐该族既有语义）。
- **被否**：a) xyz 读侧容错（listProviders 忽略毒化条目）——错层：models.json 的加载权威是 pi，xyz 读侧救不了 pi 侧的空 Map；b) 不清洗、让用户手动删——已踩雷用户不知道自己踩雷（静默消失无告警），等用户发现时数据已不可逆（apiKey 随条目删除丢失）；c) 「值 === 快照同名字段值」判定（v2 草案）——两个可构造反例（两审查同题命中）：锚漂移（pi bump 重生成快照后历史冻结值 ≠ 新快照值，逃逸清洗，网关覆盖机制把全部模型端点永久钉死在过时值——每次 pi bump 都会让上一版本保存过 catalog provider 的用户集体中招，结构性窗口）；处置自相矛盾（纯值比对无法区分「历史冻结」与「用户手输同值」，同一输入两种处置不可同时实现）；d) 「值 ∈ 历代快照值集合」判定——需维护历代值登记（constraints 成本）且仍未解决手输同值歧义；e) 清洗范围含「有标记网关」——那是用户显式设置（D1③ 写侧同步标记），删除即静默改路由。
- **证据**：P-poison 实测对照组——删掉 `baseUrl:""` 键后同一文件 `providers.size = 2`、error = undefined，证明「剥空串键」对空串毒化是充分修复；fireworks 实测（provider.baseUrl 与模型 baseUrl 部分不一致）证明冻结 artifact 有活性路由危害；authMethod 显式标注先例（extras 标记修复推断歧义，`provider-config-helper.ts:319-320`）；MF-5 既有空壳修复语义（`pi-provider-store.ts:478-486`）。
- **效果**：G2 后半成立——场景 C 的自动恢复；清洗判定锚为 xyz 自有显式标记（快照值免疫）+ 处置规则唯一（无来源歧义），保证合法条目零触碰（验收场景 9 反向验证）。
- **已接受代价（存量无标记网关误剥）**：models.json 手编 catalog 网关且从未经新 UI 保存过的条目会被②剥除（判定无从知晓其用户意图）。量级：xyz UI 至今未提供 catalog 网关入口，受影响者 = 知晓 pi 网关语义且手编 models.json 的高级用户（预估极少）；恢复路径：用 M4 的「自定义网关」输入框重设（一次操作，标记同步写入）+ troubleshooting 登记「端点与官网不符时检查 models.json override baseUrl 键」；重审触发：用户反馈网关被清的事件 ≥2 起；显式判定：可接受——对照被否方案 c 的「每次 pi bump 集体逃逸 + 写-剥循环」，一次性误伤极小众且有一操作恢复通道是更小的代价。

**D3：凭据解析唯一通道（选定）**

- **采用**：新建 `packages/runtime/src/services/auth/provider-credential-resolver.ts`，双形态共享同一份源优先级定义（单点模块，优先级常量一处声明）：
  - `resolveProviderCredential(providerId): Promise<{ key: string; source: 'auth.json' | 'models.json' } | undefined>`——async 明文版，供测试连接/模型发现/quota 消费；链 = auth.json（经 AuthService，A1-4 收口通道）→ models.json apiKey。
  - `hasProviderCredential(providerId): boolean` + `listCredentialBackedProviderIds(): Set<string>`——sync 布尔版 + **批量形态**，供 listProviders apiKeySet（批量、单次 `listCredentialIds` 读，维持 B3「消除 N+1 读盘」先例，`provider-config-helper.ts:412`）、setProvider 判定等同步上下文消费；链同上（`AuthStorage.hasCredentialSync` / `listCredentialIds` 同步原语，`auth-storage.ts:166/:178`）。
  - **分层与注入设计**（链 3 可实施性）：接口 `IProviderCredentialResolver` 下沉 `services/ports/`（与 IModelSource 同模式）；实现驻 `services/auth/`（消费 AuthService + configStore port）。链 3 消费点（`pi-provider-store.ts:353/:384`，infra/pi/）**不 import 实现**，只 type-only import 接口（豁免 C-comm-03 的 import type 形态）。注入通道按 PiConfigStore 实际装配形态二选一（均为模块级函数而非实例方法持有逻辑的薄委托类，构造参数到不了消费点）：**首选**模块级 init 注入（组合根装配期调用 `initProviderCredentialResolver(resolver)`，模块级变量持有；调用先于任何 `findValidDefaultModel`——组合根装配序保证）；**备选**调用链显式传参（`findValidDefaultModel` 签名加 resolver 参数逐层透传）。resolver 构造无 IO——读取全部懒发生，装配早期触发 `findValidDefaultModel` 无时序风险。落地形态按待验证检查点 5 实施期定，两形态均须满足「装配完成先于任何 findValidDefaultModel 调用」的时序约束。
  - 迁移 5 条散落链（§2.3 表）：链 2 `handleDiscoverModels:714` 改 async 版；链 1 `QuotaService.getCredential` 的 auth.json/models.json 两段替换为 resolver（保留 quota 专属 secrets 第一段——那是 Coding Plan 专属 key 语义，见 `ProviderInfo.quota.apiKeySet`，不属于 provider 凭据）；链 3 经注入消费 sync 版（顺带消除绕过 AuthStorage 的私有裸读 `readAuthCredentials`）；链 5 `listProviders` 内联判定改批量 sync 版；`index.ts:533-538` clearApiKey 闭包改 sync 版。
- **被否**：a) 只修 discover 一处（当前 bug）不收口——读路径继续散落，下一个新场景发明第 6 条链（违背 G4）；b) 把 quota 的 secrets 段也并入通用 resolver——混淆语义：secrets 段是「quota 专属凭据」（用户可配与 provider 不同的 Coding Plan key），不是 provider 凭据；c) resolver 做成全 async——listProviders 等同步热路径无法消费，必然催生新的 sync 内联拷贝（收口失败）；双形态共享优先级定义是收口与实用的平衡点；d) resolver 模块直接被 infra import 实现——依赖方向违反 C-comm-03 精神（infra 持 services 的 IO 实例无注入通道），接口下沉 + 构造注入才是既有分层惯例（provider-catalog 先例是纯函数不同类）。
- **证据**：§2.3 五链矩阵（全部 file:line 已核）；同步原语存在性（`auth-storage.ts:166/:178`）；ports 注入先例（`services/ports/model.ts` IModelSource + infra 实现）。
- **效果**：G4 前半成立——「给我 providerId 还你生效凭据」有唯一入口；测试连接（D5）与 quota 自动获得正确凭据（失败模式 C 的凭据断链修复）。

**D4：测试连接改 per-model 真实请求，discover 正名「模型发现」（选定）**

- **采用**：
  - **测试连接**（有模型的 provider 可点）：runtime 按模型 api 分组、每组取**第一个 `enabled !== false` 且 `baseUrl` 非空**的模型作代表（双过滤：禁用模型不代表、空串 baseUrl 模型不冒充网络错误），发**协议真实最小请求**（anthropic-messages：POST `{baseUrl}/v1/messages`，body 含 `max_tokens:1`；openai-completions：POST `{baseUrl}/chat/completions`，body 含 `max_tokens:1`；openai-responses：POST `{baseUrl}/responses`，body 含 `max_output_tokens:1`——精确 body 以实施期探针 P-test-req 实测为准）。**baseUrl 取值回落链**：模型级非空 baseUrl → custom provider 级 baseUrl（pi 同语义 `definition.baseUrl ?? providerConfig.baseUrl`，`provider-composer.js:54-55`；「模型发现」拉取的模型只有 id/name/contextWindow，必须回落）→ catalog 网关 override baseUrl（覆盖生效语义）→ 全缺时报「模型未配置 baseUrl，无法测试连接」（引导查 runtime 日志，不冒充网络错误）。凭据经 D3 resolver。结果按协议分组返回 `{ api, modelId, ok, error? }[]`。
  - **模型发现**（原「自动发现」正名）：保留 GET /v1/models 现状实现，仅 custom provider 显示该按钮——它同时承担「新增 custom 时无模型可测」的探活职责（拉到清单 = 连通 + 凭据有效）；catalog provider 隐藏该按钮（pi 无 fetchModels，清单编译期权威，发现无语义且现状必失败）。
  - **协议**：复用 `config.discoverModels` 消息族加 `mode: 'test' | 'discover'`——**optional，缺省 `'discover'`**（向后兼容：runtime CLI `xyz-settings discover-models`（`cli/commands.ts:175-204`）与任何未升级调用方零改动；前端适配层 `settings-transport-adapter.ts:31-44` 显式透传 mode）。test 模式只需 providerId，代表模型选择归 runtime——前端零推导，对齐 view-ready 原则；响应 `config.discoveredModels` 加 optional `results: Array<{ api: string; modelId: string; ok: boolean; error?: string }>`（向后兼容：旧消费方不读该字段）。CLI 顺带补 `--mode test` 入口便于排障（可选，非必须）。
- **被否**：a) 保留全局单点 GET /v1/models 探活、只修凭据与 baseUrl——端点脱节：聊天走 model.api 协议 POST model.baseUrl，GET /v1/models 成功不代表能聊（opencode-go 两种 baseUrl 并存，单点只能测一个）；前序诊断用户已否决此方向；b) 复用 pi-ai dist 的 API 实现发请求——runtime 运行期 import pi-ai 是新的打包依赖形态（需动 tsup noExternal，Electron 打包事故最高发区），且把测试语义耦合到 pi-ai 内部工厂签名（漂移面）；c) 经 pi 子进程起临时 session 发真实聊天——最真实但秒级延迟 + 写 session 文件副作用 + 烧完整 prompt token，为「探活」付出聊天全成本，过重；d) mode 必填——CLI 第二调用方 break（审查发现），缺省 discover 使协议扩展零兼容负担。
- **证据**：端点脱节事实（`pi-ai/dist/models.js:444-450` 按 model.api dispatch；opencode-go 双 baseUrl）；pi 无 fetchModels（grep 零命中）；CLI 调用方（`cli/commands.ts:186-197` payload 无 mode）；现有 HTTP 探活范式（`model-api-discoverer.ts`，直接 fetch 已是项目既有模式，D4 是同族扩展）。
- **效果**：G3 成立——场景 A/B 的按协议真实结果与恢复指引；失败模式 C 的端点脱节修复。
- **已接受代价（四要素）**：① 每次测试每协议一次真实请求（max_tokens=1）——量级：每 provider ≤ 协议数（≤4）次请求、每次输出 1 token，成本约等于零但非零；恢复路径：无状态副作用，无需恢复；重审触发：用户反馈测试慢（>10s 超时）或按量计费 provider 投诉；显式判定：可接受（探活语义要求真实请求，这是用户裁定的方向）。② 三协议请求体由 xyz 自维护——漂移面：若某 provider 对标准协议有私有要求，最小请求可能误报失败；量级：3 个协议 × 各 1 个固定 body 模板；恢复路径：失败文案含真实 HTTP 响应（状态码 + body 截断），用户可凭真实错误判断；重审触发：误报案例出现 ≥2 起；显式判定：可接受（协议是公开稳定 API 格式，且失败可见真实原因，优于现状的固定文案）。③ 空 baseUrl 模型组（azure-openai-responses 等 host 型目录，38/1290 实测）首版不可测——量级：39 provider 中约 1-2 个 provider 的部分/全部协议组；恢复路径：错误文案如实报「模型未配置 baseUrl（内置目录未提供）」并引导查日志，不冒充网络错误；重审触发：用户对 host 型 provider（ambient 认证类）提出测试需求；显式判定：可接受（host 型目录的 baseUrl 语义本就依赖运行时解析，per-model 测试无从构造端点）。

**D5：网关优先派生兜底——provider 级 api/baseUrl 展示与下发（选定）**

- **采用**：`resolveCatalogDisplayFields` 改造为两级语义（对齐 pi 真实生效顺序——网关覆盖在先、模型级在后）：
  - **baseUrl**：override 非空 `baseUrl`（用户网关）→ 原值下发（展示「自定义网关：{url}」，与派生值视觉可区分）；无网关 → 对合并模型集（`getMergedCatalogModels`，快照 ⊕ overlay 单点）计算「全模型 baseUrl 非空且同值 → 该值；存在 >1 种非空值 → undefined（展示『按模型分发』）；全部空/缺省 → undefined（展示『内置目录未提供』）」。
  - **api**：无用户语义（防线③撤编辑入口）——对合并模型集计算「全模型同 api → 该值；>1 种 → undefined（展示『按模型分发（各协议 ×模型数）』）」。
  - runtime 聚合层计算（前端零推导，对齐 supportedLevels 的 view-ready 原则）。前端 `ProviderEditBody`：catalog 时「类型」渲染为只读派生文案（不渲染输入框）；「Base URL」改为**「端点（自定义网关）」可选输入框**——placeholder「留空使用内置端点；填写后覆盖该 provider 全部模型的请求地址」，框下方展示当前派生值/网关标注；custom 照旧。快照脚本的 provider 级 artifact 字段**保留生成**（见被否 b），但 runtime 展示聚合不再消费；`BuiltinProviderTemplate.api/baseUrl` 类型注释标记「构建期 artifact，禁止新代码消费——展示用派生值」。QuickSetup 模板卡的 api/baseUrl 展示（`ProviderQuickSetup.vue:110-112`）顺带改为「混合 provider 显示『按模型分发』、空串显示『—』」的简单聚合（模板 models 数据一行 computed，消除 G1 在 settings 第一步入口的泄漏）。
- **被否**：a) 展示兜底（artifact 基础上「空串不显示」）——artifact 字段继续被消费，类型 Select 钳 3 值等连带缺陷保留；前序诊断用户已否决此方向；b) 快照脚本停止输出 provider 级 api/baseUrl——触及三个高险区：check-pi-sync 锚点族（快照是 C-build-07 守卫对象）、legacy-provider-migration 的「默认字段」比对基准（`legacy-provider-migration.ts:151-162`）、provider-importer；收益（字段消失）不抵风险，且派生展示落地后这些字段已无 runtime 消费方，残留仅为构建期数据；c) 派生放前端——违背 view-ready 原则（前端零推导，supportedLevels 先例），且多前端消费点会各自拷贝派生逻辑（新的散落）；d) 撤掉网关输入框（v1 草案「catalog 撤输入框」）——砍掉 pi 官方网关工作流（审查发现的覆盖式语义），镜像站/代理用户需求无处安放；改为「可选网关输入框 + 派生值展示」。
- **证据**：量化基础（P-scope：39 provider 中 34 个模型 api 单一——派生后显示原值不变，仅 5 个混合 provider 显示「按模型分发」；azure 38/38 全空——「全空 → undefined」规则的必要性）；网关覆盖语义（`provider-composer.js:98`）；派生数据源单点（`getMergedCatalogModels`，`provider-catalog.ts:102`，展示与校验已同源）。
- **效果**：G1 成立——场景 A/A' 的派生与网关展示；失败模式 B 修复（混合协议可见、artifact 不再到用户眼前、展示与 pi 生效语义一致）。
- **已接受代价（消费点完整清单，grep 范围 = renderer/core/ui/runtime 四包对 `ProviderInfo.api/.baseUrl` 与 `p.api/p.baseUrl` 的消费——供 CR 复核）**：

| 消费点 | 派生后输入 | 判定 |
|--------|-----------|------|
| `model-mapper.ts:61` toModelInfo 的 `m.api ?? providerApi` 回落 | catalog 混合 provider 时 providerApi=undefined → override 自定义模型（addModel 不带 api）与 D7 后 overlay 缺省 api 模型的 ModelInfo.api=undefined | 无实际影响：ModelInfo.api 下游是 composer 元数据展示，聊天协议由 pi 侧自行解析；但该回落路径**可达**（v1 草案「不可达」论证错误，已修正），实施时在 toModelInfo 处加注释说明 |
| `quota-service.ts:539` matchQuotaPreset({baseUrl}) | 网关时 = 用户网关值；无网关混合 provider 时 = undefined → preset 不匹配 | 无实际影响：quota preset 相关 provider（kimi/minimax/mimo/zhipu 系）实测全部单协议单 baseUrl，派生值 = 原值（审查复核）；且 matchQuotaPreset 是归属 heuristic，namePattern 兜底存在（审查核实）——quota API 端点与聊天端点本就可能不同，方向不构成判定风险 |
| `useQuotaDisplay.ts:91` / `ProviderEditBody.vue:403` matchQuotaPreset 前端镜像 | 同上 | 同上 |
| `useProviderPageOauth.ts:124-125` OAuth 回传 | M1 改造后该链不再回传 api/baseUrl（D1⑤） | 消费点消失 |
| `ProviderEditBody.vue:517` → `ModelListSection.vue:269-272` compat 编辑器的 providerApi 回落 | M4 定义：form.api 对 catalog = 派生值（混合 → undefined），override 模型 compat 字段集判断回落模型自身 api | 可接受：compat 字段集对 undefined api 走通用集（现状对未知 api 已有该路径） |
| `ProviderQuickSetup.vue:110-112` 模板卡展示 | M4 顺带改为混合检测展示（采用段末尾） | 泄漏消除 |
| `provider-importer.ts:131` `protocol: p.api ?? 'unknown'`（preview 元数据） | 模板级字段（BuiltinProviderTemplate，非派生值） | 无影响：preview 展示用途，'unknown' 兜底已存在；不改为派生（preview 无 models 聚合上下文，保持简单） |

  量级：7 处消费点逐处判定如上，其中 1 处（toModelInfo）语义收窄 + 注释、1 处（OAuth）随 D1⑤ 消失、1 处（QuickSetup）顺带修复、其余无实际影响；恢复路径：N/A（纯读侧，无状态变更）；重审触发：出现依赖「catalog provider 级 api/baseUrl 恒有值」的新消费点需求；显式判定：可接受（清单穷举 + 逐处判定，CR 可复核）。

**D6：防复发结构约束（选定）**

- **采用**：① 新增 `scripts/check-provider-credential-reads.mjs`（照 `check_services_infra_import.py` / `check-extension-dependencies.mjs` 模式：纯 Node 零依赖 ripgrep 扫描 + 白名单 + fail 收集 + 退出码 0/1）：禁 `packages/runtime/src/**` 在白名单文件外出现 `getApiKeyForProvider` / `readAuthCredentials` / `getProvider(*).apiKey` 直查模式；白名单 = resolver 模块自身 + 迁移基线文件（初始即清零）。**同族姊妹守卫：`upsertProvider` 直调清单**（白名单 = setProvider / importer 主路径两处 / clearApiKey 闭包 / 启动清洗——堵防线载体被旁路的复发通道，审查影响 R2-5 的机器化收口）。接入 `.githooks/install-hooks.sh`（按 `packages/runtime/src/**` 路径触发）+ `scripts/preflight-check.sh`（CI）。② constraints.json 登记新约束（id 按 C-proc 域取号，authority = 本文档），`render-constraints.mjs` 重生成 md——进 CR 动态加载视野。③ `check-doc-symbol-drift.mjs` 的 `DOC_MODULE_MAP` 登记本文档与映射源码模块（provider-config-helper / provider-catalog / provider-credential-resolver / pi-provider-store），防文档符号漂移。
- **被否**：a) 只写规约文档不加机器检查——「读路径收口」历史上正是靠规约维持失败的（无结构约束 = 逐场景打补丁，§2.3）；b) eslint no-restricted-imports 方案——管 import 不管「同模块内函数调用」（5 链中多数是运行时调用不是新 import），拦截面不对口；check 脚本扫调用模式才对症。
- **证据**：check 基建两处现成模式（`.githooks/check_services_infra_import.py` 同类检查 + install-hooks.sh 按路径触发段）；constraints.json 登记流程（AGENTS.md + render/select 脚本）。
- **效果**：G4 后半成立——第 6 条解析链在 pre-commit 被拦截；约束进 CR 视野（review agent 动态加载）。
- **已接受代价**：白名单维护——新增合法读取点（经 review 认定的例外）需改白名单；量级：白名单 ≤3 文件起步；恢复路径：改白名单即放行（通道存在）；重审触发：白名单膨胀到 >8 文件 = 收口失效信号，应回到 resolver 设计重审；显式判定：可接受。

**D7：artifact 源头归一——overlay 归一化不再产空串（选定，范围收窄）**

- **采用**：`overlayToCatalogModel`（`provider-catalog.ts:74-75`）的 `api ?? ''`、`baseUrl ?? ''` 改为缺省（undefined/不置键）——pi 的 OverlayModel 本就 optional，空串是归一化捏造；连带 `BuiltinModelSummary.api`（`packages/shared/src/provider.ts:30`，必填 string）改 optional、`getMergedCatalogModels` 的消费方类型收窄（M4 改动地图含此文件）。gen 脚本侧（`:307` model 级、`:356-357` provider 级）**本次不动**：快照是 C-build-07 守卫对象，重生成 diff 大，且 D5 派生展示 + D1 防线落地后快照 artifact 已无 runtime 消费/写入路径；留待下次 pi 升级重生成快照时顺带（在 constraints 登记的约束 authority 即本文档中注明）。
- **被否**：gen + overlay 同批全改——overlay 是 runtime 自控代码（小改），gen 快照是构建期守卫产物（大 diff + 锚点族联动），两类变更的风险等级不同，捆绑会拖住 P0 拆雷的交付节奏。
- **证据**：P-scope 实测（38/1290 模型级 baseUrl 空串全部来自 gen/overlay 归一化捏造，pi catalog 原始数据是缺省）；overlay 归一化职责注释（`provider-catalog.ts:64-69`）。
- **效果**：runtime 侧 artifact 产出点清零（仅剩构建期快照一处、无消费方）；模型级空串不再有机会经 overlay → 合并视图 → 未来某条写路径进入 models.json。

**D8：pi 语义锚点卫生（选定，顺手项）**

- **采用**：修正 `pi-provider-repair.ts:34/:45` 注释的漂移锚点（「zod minLength:1, model-config.js:168」→ 0.84.4 实装为 TypeBox、provider 级 baseUrl 在 `:171`、校验器装配在 `:184`）；`pi-provider-store.ts:495-498`「为什么修复路径不用合并视图」的论证前提（「overlay 条目归一化 baseUrl 缺省填 ''」）随 D7 改变，同批更新该注释的依据表述；本文档全部 pi 断言标注实装行号（已随文标注）。
- **被否**：另起独立 PR 修——锚点漂移与本问题族同源（都是「按旧印象断言 pi 行为」），同批修成本最低。
- **证据**：审查核实（`dist/core/model-config.js:3-4` import typebox，非 zod；项目铁律「曾因按旧 clone 断言实装行为连产 4 条漂移 bug」）。
- **效果**：下一个读这段代码的人不会按 zod 印象写新 bug；设计文档同步纪律（C-proc-10）要求同批清扫。

**D9：模型字段出厂显式化 + 思考预设对齐 pi 过滤语义（选定）**

- **采用**：三入口收口 + 预设修正，全部对齐既有先例（D4 出厂显式 boolean）与 pi 语义，不加新机制：
  - **① discover 合并补 `reasoning: true`**：`use-provider-edit.ts:416-418` 合并发现的模型时对齐 `addModel` 的出厂语义（显式 boolean，不允许 undefined）——「自动发现」合并进来的模型与手动新增的模型在 reasoning 字段上同级对待。
  - **② `pickStrategy` 行级联动**：`:560-564` 设置策略时若 `m.reasoning === undefined` 则置 `true`（**缺失才补显式，永不覆盖用户显式 false**；非 all-levels 与 all-levels **同规则**——存量最常见形态恰是「从未设策略 = all-levels + reasoning 缺失」，救回路径正是 all-levels 分支，只联动非 all-levels 会让它不闭合）。用户显式关 reasoning 又选非 all-levels 策略 → 保持 false，档位弹层按 pi 语义只有「关」——显式选择优先于联动。
  - **③ `THINKING_PRESETS` 预设补显式 null 剔除项**：`on-off` → `{off:'off', high:'high', minimal:null, low:null, medium:null}`（两档）；`high-max` → `{off:'off', high:'high', max:'xhigh', minimal:null, low:null, medium:null}`（三档）——让预设实际输出与命名语义一致（pi 黑名单过滤语义，`models.js:551-557`）。`all-levels` 维持 `undefined`（pi 默认五档，`xhigh`/`max` 需显式映射——在预设注释写明该语义，用户要 max 档选 high-max）。预设只在用户选择时写入（`pickStrategy` structuredClone），改预设不影响存量已保存的 map，无迁移需求。
  - **④ 注释修正**：`THINKING_PRESETS` 头注释「key = UI 可选档位」的白名单心智改写为 pi 黑名单过滤语义的准确表述（「value=null 剔除该档；xhigh/max 需显式列出；其余档默认保留」）——防下一个按白名单心智加预设的人再踩。
  - **⑤ 存量恢复**：不写迁移脚本——修复后用户在编辑体重新设置**任意**策略（含 all-levels：联动补 reasoning + 重选写 map）即救回；手动路径 = models.json 补 `"reasoning": true`（文档化到 troubleshooting 的恢复指引即可）。
- **被否**：a) supportedLevels 计算侧放宽（如 reasoning 缺失时读 thinkingLevelMap 推断「支持」）——错层：pi 门控语义是权威，`model-capability.ts` 用 pi 同源函数是刻意对齐（view-ready 原则），xyz 侧应修数据不是改推断——改推断还会与 pi 运行时 `clampThinkingLevel` 的同源钳制产生「UI 显示有档、pi 实际钳回 off」的新撕裂；b) 只修 discover 不修行级（或反之）——三入口同事故（手动新增入口的前次修复即 D4 先例），收口必须全覆盖，否则下一个入口的用户再爆一次；c) 存量数据启动迁移（批量补 reasoning:true）——过度：无法区分「用户不要思考」与「历史坍缩缺失」（两者落盘形态相同），批量补 true 会把用户显式不要思考的模型改错；「重新设置一次策略」的用户操作成本可忽略。
- **证据**：两级门控 + 过滤语义（`pi-ai/dist/models.js:548-558` 实装核实：`if (!model.reasoning) return ["off"]`；null 剔除 / xhigh-max 显式列出 / 其余保留）；**档位推导实测（主审第 3 轮 pi dist 同源逻辑实跑）**：修正后 `high-max` 预设输出 `[off, high, max]` 恰三档——第三档为**档位名 `max`**（map 值 `xhigh`），弹层显示 max、发送值经 map 映射为 xhigh，与既有「max 档发 xhigh」注释自洽；`on-off` 输出两档；v1 现状 5 档/6 档断言同批实跑复核属实；用户数据实测（models.json 4 模型 reasoning 缺失、composer 只有「关」；对照组 deepseek reasoning=true 档位正常）；D4 先例（`use-provider-edit.ts:586-588` 注释「事故 B 根因 ②——写入时语义坍缩」）；实施期 P-presets 复验。
- **效果**：G5 成立——§4 场景 10 的端到端验证（新建 → 发现 → 行级设策略 → 保存 → models.json reasoning 显式 → composer 出高档）；失败模式 D 修复。
- **已接受代价**：discover 合并的模型默认 `reasoning: true`——不思考的模型（多数 openai 兼容小模型）会被标为「支持思考」，composer 显示全部档位、用户选高档时 pi 侧按实际能力返回错误或降级。量级：discover 合并的每批模型中不思考模型的占比（发现端点不返回 reasoning 元数据，无法精确判定）；恢复路径：用户在行级把策略设为 all-levels + 手动关 reasoning（或选 off 策略）即修正单个模型；重审触发：用户批量反馈「发现合并的模型全是假思考档」；显式判定：可接受——与 `addModel` 出厂 `reasoning: true` 的既有先例同语义（D4 已接受过同一代价），且「假支持」（可选不用）的危害远小于「真支持但被门控判关」（设置无声失效，本失败模式）。

### 3.4 外部共享状态写入面分析（models.json / auth.json / providers.json / models-store.json）

**本节结论：本方案对项目不拥有的持久状态的唯一写入面是 models.json（pi 拥有、xyz 共享读写）；auth.json 与 providers.json 只读不写；models-store.json 为现状竞态登记（本方案不新增写入）；全部写入点、消费方、清理通道已穷举。**

| 写入面 | 本方案的写入点 | 消费方及其过滤/投影规则 | 清理通道 | 累积性 |
|--------|---------------|------------------------|----------|--------|
| models.json（pi 拥有） | ① `setProvider → upsertProvider`（现状即有，本方案加防线收窄写入内容：无 schema 违规值、catalog 无 artifact、无空壳条目）；② 启动清洗（新增，空串全集剥键 + catalog provider 级键按 extras 网关标记处置，有剥除才写盘，幂等）；③ importer 主路径与 fallback（W2 应用导入 `provider-importer.ts:251/:322` 直调 `upsertProvider`——经防线载体共享纯函数拦截，源端 provider 级字段对 catalog 不落盘、空串转译；fallback 分支 D1④ 另修 artifact/apiKey 错位）；④ OAuth 收尾（D1⑤ 修后不再写条目） | **pi `ModelConfig.load`**：TypeBox 全文件校验，任一条目违规拒整个文件（P-poison 实测）——最严苛消费方，防线与清洗对齐它的规则；**pi `applyModelsJson`（网关覆盖）**：catalog 条目的 provider 级 `baseUrl` 存在即替换全部内置模型端点（`provider-composer.js:98`）——用户网关值被真实消费，D5 展示必须网关优先；**pi `modelFromJson`（协议缺省）**：override 自定义模型的 api 缺省回落 provider 级 `api`（`provider-composer.js:49`）——catalog 的该键被 D2② 一律剥除后此消费面只剩模型级 api；**xyz `listProviders`**：override 优先于快照的逐字段回退（`:317-318`，M4 后 provider 级 api/baseUrl 改派生 + 网关优先）；**pi 运行时合并**：catalog override ∪ 内置定义 | 启动清洗（新增）；`removeProviderByKind`（现状，删条目）；手动编辑文件 | 非累积——RMW 单文件，条目随保存/删除增减 |
| auth.json（pi 拥有） | **无写入**（本方案只读：resolver 经 AuthService/AuthStorage 读） | pi 运行时凭据解析（`dist/core/auth-storage.js`）；xyz resolver（D3） | 现状即有（`AuthStorage.remove`），本方案不涉及 | — |
| providers.json（xyz 拥有） | **本方案新增 2 个写入点**：`gatewayBaseUrl` 网关标记（D1③ 设置/清除，写序契约编排）+ 错位自愈清理（D2② 待清清单，启动 async 阶段）——modelStates/authMethod/quota 维持现状路径。xyz 自有文件，非外部共享状态 | listProviders extras 双读（现状）；**网关展示判定与取值的唯一来源 = models.json override 非空 baseUrl（D5）**——标记仅作 D2 清洗锚不作展示源（避免「键已剥、标记待清」窗口展示 stale 标注） | 现状（`cleanProviderExtras`）+ D2 标记自愈清理 | 非累积——RMW 单文件，标记随网关设置/清除增删 |
| models-store.json（pi 拥有；现状登记） | **无写入**（xyz 对该文件只读：`provider-catalog-refresh.ts:70-73` 读它作 overlay 候选源；xyz 写的是**自己的** overlay cache 文件 `<dataDir>/provider-catalog-overlay.json`——该文件 xyz 拥有、pi 不碰，无跨系统写竞态。pi 侧写入带 `withLockAsync` 锁 + tmp/rename（`models-store.js:26-113`），xyz 无锁读 rename 产物是原子可见的，安全） | pi `FileModelsStore`（锁内读写）；xyz overlay 刷新（D5 派生展示经 `getMergedCatalogModels` 间接消费 overlay 合并结果） | 无（pi 侧无清理；xyz overlay cache 副本独立文件可随时重建） | 低——pi 侧低频刷新；**跨系统读写原子性依赖 pi 侧 rename 实现，登记为 pi 升级关注点（upgrade checklist：核对该行为仍原子）** |

**setProvider 全部调用方枚举**（防线③的作用面核对）：① 编辑体 save（`use-provider-edit.ts:465`，M1 改 payload）；② OAuth 收尾（`useProviderPageOauth.ts:122-127`，D1⑤ 改造）；③ QuickSetup（`use-quick-setup-form.ts:175-176`，D1⑥ 修复：catalog 模板不写 baseUrl/api + 死键清理）；④ importer（`provider-importer.ts:251/:322` 主路径直调 upsertProvider + fallback——经防线载体共享纯函数拦截，见 D1 防线载体段）；⑤ CLI `xyz-settings set-provider`（`commands.ts:130-148`，payload 经 config.setProvider → 防线生效，审查核实兜底成立）。**非 setProvider 的 models.json 写入方**：clearApiKey 闭包（`index.ts:533-538`）直调 upsertProvider 但为纯删键 RMW（无新值写入），不产生违规值（审查核实不构成绕过）；quota 写入不落 models.json。

**派生物**：清洗与防线的 runtime 日志写入 `<dataDir>/logs/`（既有日志轮转体系，date+size 双策略），无新落盘形态。

### 3.5 接口与错误规格

**新模块 `provider-credential-resolver.ts`（D3）**：

```ts
// 源优先级单点声明（双形态共享）：
//   1. auth.json（AuthService / AuthStorage 通道，catalog 凭据所在）
//   2. models.json providers[id].apiKey（custom 凭据所在）
export interface IProviderCredentialResolver {  // services/ports/ —— infra 链 3 经 type-only import 消费
  hasProviderCredential(providerId: string): boolean
  listCredentialBackedProviderIds(): Set<string>   // listProviders 批量场景（B3 先例）
  resolveProviderCredential(providerId: string):
    Promise<{ key: string; source: 'auth.json' | 'models.json' } | undefined>
}
// 实现：services/auth/provider-credential-resolver.ts，组合根装配后经模块级 init setter 注入（首选）
// 或调用链显式传参（备选）——见 D3「分层与注入设计」，禁选构造参数形态（薄委托类实态到不了消费点）
```

$ENV_VAR 引用与 command 配置值的解析行为见探针 P-cred（实施期门）。

**setProvider 契约变化（D1）**：`SetProviderData` 协议注释增补——「catalog provider 忽略 `type`；`baseUrl` 非空 = 设置网关（覆盖全部模型端点）、显式空串 = 清除网关回退内置、**未带键（undefined）= 不变**（既有 merge 协议不动）；custom 及模型级：空串 `name/baseUrl/apiKey/api` 按 pi schema 语义转译（apiKey = 清除删键，其余 = 未指定不写键）」。运行时行为变化，协议形状不变（向后兼容）。

**config.discoverModels 协议扩展（D4）**：

```ts
// ClientMessage：加 optional mode（缺省 'discover'，CLI 等旧调用方零改动）
'config.discoverModels': {
  baseUrl: string            // discover 模式必填；test 模式忽略（runtime 按回落链取模型级/provider 级）
  apiKey?: string            // discover 模式沿用；test 模式忽略（runtime 经 resolver）
  providerType?: string
  providerId?: string        // test 模式必填
  mode?: 'test' | 'discover' // 新增，缺省 'discover'
}
// ServerMessage：加 optional results（test 模式填）
'config.discoveredModels': {
  models: Array<{ id: string; name?: string; contextWindow?: number }>  // discover 模式填
  success: boolean
  error?: string
  results?: Array<{ api: string; modelId: string; ok: boolean; error?: string }>  // test 模式填
}
```

**错误规格（每个失败配恢复指引，准则 6）**：

| 失败场景 | 文案（面向用户） | 恢复指引 |
|----------|-----------------|----------|
| 测试连接：resolver 全源 miss | `未找到 API Key——该 provider 的凭据尚未配置` | `👉 在上方「API Key」填写并保存后重试；或确认授权管理（auth.json）中已有该 provider 凭据` |
| 测试连接：单协议失败 | `{api}（{modelId}）：HTTP {status} {响应截断}` | `👉 检查 API Key 有效性与网络/代理（需可访问 {baseUrl}）后重试` |
| 测试连接：协议不在支持集 | `{api}：暂不支持该协议的连接测试` | 首版支持 anthropic-messages / openai-completions / openai-responses（以 P-test-req 探针为准）；其他协议显示此文案不阻断其他协议结果 |
| 测试连接：无可用模型 | `该 provider 无可用模型，无法测试连接` | custom：`👉 先用「模型发现」拉取或手动添加模型`；catalog 恒有快照模型，命中即异常，文案引导查看 runtime 日志 |
| 测试连接：代表模型/协议组无 baseUrl（含空串，azure 类 host 型目录） | `{api}：模型未配置 baseUrl（内置目录未提供），无法测试连接` | `👉 该类 provider 的端点由运行时按目录解析，暂不支持连接测试；详情见 runtime 日志（<dataDir>/logs/）`——如实归类，不冒充网络错误 |
| 测试连接：全部模型被禁用 | `{api}：该协议无启用模型` | `👉 在模型清单中启用至少一个该协议的模型后重试` |
| 写侧防线触发（D1②③） | 用户无感（保存成功）；runtime 日志 warn：`[config-service] dropped empty-string <field> for <id>` / `ignored provider-level type for catalog <id>` / `skipped empty provider entry <id>` | 排障经 runtime 日志（`<dataDir>/logs/`） |
| 存量清洗（D2） | 用户无感；启动日志：`[provider-repair] stripped empty-string schema keys on "<id>": <keys>` / `stripped unmarked provider-level keys on "<id>": <keys>` | 清洗失败仅 warn 不阻断；持久失败（文件只读）在日志可见，手动修复指引 = 删除该条目的对应字段；「手编网关被剥」的识别与恢复见 §3.3 D2 已接受代价（troubleshooting 登记） |
| custom 清空 baseUrl 保存（语义声明） | 无变化（不变更既有值） | UI 输入框 placeholder 注明「留空保持不变」；删除 provider 用删除功能 |

### 3.6 探针清单（运行时断言审计，准则 7）

| ID | 验证的行为断言 | 探针 | 状态 | 失败时的降级路径 |
|----|---------------|------|------|-----------------|
| P-poison | 空串使 pi 拒载**整个** models.json（非拒单条）——覆盖 provider 级 baseUrl/apiKey/name/api 与模型级 id/name/api/baseUrl 全集 | 构造毒化矩阵（8 种字段各一例）+ 对照组，调 pi 0.84.4 实装 `ModelConfig.load` | ✅ 已测（2026-09-10，baseUrl 例 + 审查复核 apiKey/models[0].api/models[0].baseUrl/name 例，均 size=0） | — |
| P-gate | pi 两级门控：`reasoning` 缺失/false → `['off']`；第二级黑名单过滤（null 剔除 / xhigh-max 显式列出 / 其余保留） | 静态核实 `pi-ai/dist/models.js:548-558` + 用户数据实测（reasoning 缺失模型档位只有关、deepseek 对照组正常） | ✅ 已测（2026-09-10 诊断会话实测） | — |
| P-schema | 0.84.4 校验器是 TypeBox 非 zod；minLength 全集 = provider 级 name/baseUrl/apiKey/api + 模型级 id/name/api/baseUrl + modelOverrides name | 静态核实 `dist/core/model-config.js:3-4,:137-140,:170-173,:184` + P-poison 行为印证 | ✅ 已测 | — |
| P-scope | artifact 规模：39 provider 中 7 个 provider 级 baseUrl=''、5 个混合 api、38/1290 模型级 baseUrl=''（azure 38/38）、fireworks provider.baseUrl 与模型级部分不一致 | 直读 `generated/builtin-providers.json` 统计 | ✅ 已测 | — |
| P-gateway | catalog override 的 provider 级 baseUrl 覆盖式改写全部内置模型端点 | 静态核实 `provider-composer.js:98`（applyModelsJson）+ fireworks 实例推演 | ✅ 已测（静态核实；行为正确性由验收场景 8 端到端验证） | — |
| P-cred | xyz `AuthService.getCredential` 对 $ENV_VAR 引用 / command 配置值凭据的解析行为（是否返回明文） | 读 `services/auth/auth-storage.ts` 与 pi `dist/core/auth-storage.js:213-216 resolveConfigValue` 比对 + 构造 env 引用凭据实测 resolver 输出 | ⛔ 实施期门（M2 内） | 失败 → resolver 对 $ENV 用 `process.env` 展开（与 pi `resolveConfigValue` 同语义）；command 配置值首版不支持，resolver 返回该形态标记，测试连接报「该凭据形态暂不支持」 |
| P-test-req | 3 协议最小请求体（max_tokens=1 级）在真实端点可调通且响应可区分 401/网络错/协议错；空 baseUrl 回落链与「不可测」分支行为 | 实施期对真实 provider（opencode-go 或等价测试端点）发 3 协议最小请求 + 构造无 baseUrl 模型组验证分支 | ⛔ 实施期门（M3 内） | 某协议调不通 → 该协议从支持集剔除，测试连接对该协议报「暂不支持」（错误规格表第 3 行），不阻断其他协议 |
| P-sanitize | 剥空串键 + catalog provider 级键处置（api 一律剥 / baseUrl 按 extras 网关标记）后同一 models.json 经 pi `ModelConfig.load` 通过（覆盖 8 字段矩阵 + fireworks 冻结实例 + 有/无标记对照） | 复用 P-poison 探针脚本：剥键 → load → 断言 providers.size 恢复；有标记网关保留 / 无标记剥除的对照断言 | ⛔ 实施期门（M1 内） | 失败 → 收窄清洗范围到「仅空串键剥除」（provider 级键处置降级为展示侧不消费 + troubleshooting 手动指引），并在发布说明标注 |
| P-oauth-shell | D1⑤ 后 OAuth 收尾不再物化 models.json 条目（`{authMethod:'oauth'}`-only 调用 → 无条目/无空壳） | 实施期模拟 OAuth 收尾调用 setProvider 后读 models.json | ⛔ 实施期门（M1 内） | 失败 → 由防线③「不物化空壳」兜底（条目不落盘即无空壳）；仍失败则 OAuth 收尾链回退为携带 headers 占位（现状 hack 显式化）并登记 M5 清理 |
| P-presets | D9③ 修正后的预设实际输出档位数与命名语义一致（on-off 两档 / high-max 三档）；discover 合并 + 行级联动后 reasoning 落盘显式 boolean | 实施期在隔离数据目录跑 §4 场景 10 全流程 + 对修正后预设逐个调 pi `getSupportedThinkingLevels` 断言档位数 | ⛔ 实施期门（M6 内） | 失败 → 按实测档位差调整 null 剔除项集合（pi 过滤语义为权威，预设凑语义）；reasoning 未落盘 → 回退检查双端 `!== undefined` 写键链是否被其他改动破坏 |

---

## 4. 验收（真实场景，非单测非 mock）

**本节结论：11 个真实场景覆盖 §1 全部目标（G1–G5）+ 存量恢复（空串与冻结两形态）+ 网关工作流保留 + 旁路写入方（OAuth/QuickSetup/导入）+ 防复发拦截 + 宿主不变量；全部在 `pnpm dev` 真实环境用真实 models.json/auth.json 与真实网络端点验证，单测仅作回归辅助不计入验收。**

改动规模：大改动（行为变更 + 协议扩展 + 跨四层），按多场景验收。前置：`pnpm dev` 起真实应用（Electron + runtime），用个人真实配置目录的副本（`XYZ_AGENT_DATA_DIR` 指向 `~/.xyz-agent-dev` 类隔离目录，禁止碰 `~/.xyz-agent` 真实数据）。

| # | 验证场景（谁、在什么上下文、做什么、看到什么） | 步骤 | 通过标准 | 回溯目标 |
|---|-----------------------------------------------|------|----------|----------|
| 1 | **P0 拆雷**：用户在 dev 环境已导入 opencode-go（auth.json 有真实凭据）+ 已有一个 custom provider（如 deepseek，models.json 有 apiKey），展开 opencode-go 改 headers 保存 | dev 环境操作；保存后 `cat ~/.xyz-agent-dev/pi/agent/models.json`；发起一次 deepseek 聊天 | models.json 中 opencode-go 条目（若存在）不含 `baseUrl`/`api` 键；deepseek 条目原样；聊天正常返回 | G2（失败模式 A 修复） |
| 2 | **存量毒化恢复（空串形态）**：模拟已踩雷用户——手工往 models.json 写入 `{"opencode-go": {name, api:"anthropic-messages", baseUrl:"", models:[]}}`（deepseek 同文件），重启 runtime | 写入毒化条目 → 重启 dev → 看 runtime 日志与 provider 列表 | 日志含 `[provider-repair] stripped empty-string schema keys on "opencode-go"`；deepseek 在列表中且可聊天；models.json 毒化条目的空串键已被剥除 | G2 恢复通道（D2） |
| 3 | **测试连接真实可信**：opencode-go 配真实 key 点「测试连接」；再把 key 改错重试 | 真实 key → 看结果；改错 key → 再看 | 真实 key：按协议分组显示成功（含代表模型名）；错误 key：每组显示 HTTP 401 + 恢复指引文案（👉 检查 API Key / 网络代理） | G3（失败模式 C 修复） |
| 4 | **派生展示**：展开 opencode-go（混合）与 anthropic（单协议 catalog）、deepseek（custom）三个编辑体对比 | dev 环境逐个展开 | opencode-go：无类型输入框，显示「按模型分发（3 协议分布）」；端点框留空显示「内置端点（按模型分发）」；anthropic：显示派生单值 `anthropic-messages`；deepseek：输入框照旧可编辑可保存 | G1（失败模式 B 修复） |
| 5 | **网关工作流保留**：给 opencode-go 设自定义网关 `https://gw.example/opencode` 保存 → 展开看展示 → 发起聊天（用可用的测试网关或本地 mock 端点验证请求确实打到网关）→ **对该 provider 走一次 OAuth 重登（如支持）或 QuickSetup 重配凭据** → 清空网关保存 | 设网关 → 保存 → 查看 → 聊天/抓包 → 重登/重配 → 查看 → 清空 → 再查看 | 设网关后：展示「自定义网关：{url}（覆盖全部模型）」、models.json override 含该非空 baseUrl、聊天请求实际打到网关（pi 覆盖机制生效）；**重登/重配后网关仍在**（undefined = 不变协议验证，审查 R3-1 组合断言）；清空保存后：override baseUrl 键被删除、展示回「内置端点」 | G1 + pi 网关语义保留（D1③/D5） |
| 6 | **存量冻结 artifact 恢复（标记判定）**：手工构造两类条目——fireworks override `{name, api, baseUrl:"https://api.fireworks.ai/inference"}`（历史冻结形态，无 extras 标记）+ 一条**带** `gatewayBaseUrl` extras 标记的网关 override（模拟经新 UI 保存的用户网关），重启 | 写入两条（后者需同步写 providers.json extras 的 gatewayBaseUrl）→ 重启 dev → 看日志与展示 | fireworks 冻结键被剥（日志 `stripped unmarked provider-level keys`）、api 键一并剥除、模型端点回内置值；带标记网关条目**原样保留**且展示「自定义网关」；另验证：无标记但值 ≠ 快照的手编网关条目也被剥（已知限制，恢复路径 = 新 UI 重设） | G2 恢复通道（D2② 换锚后判定验证） |
| 7 | **凭据收口回归**：quota 已配置的 catalog provider 查额度；custom provider 用「模型发现」拉清单；runtime CLI `xyz-settings discover-models --base-url ...` 冒烟 | dev 环境触发 quota 刷新；对 custom 点「模型发现」；跑 CLI 命令 | quota 正常返回额度（resolver 迁移后凭据解析不回退）；模型发现正常返回清单并合入；CLI 正常返回模型列表（mode 缺省 discover 向后兼容，审查 MF1 修复验证） | G4（5 链迁移无回归 + 协议兼容） |
| 8 | **防复发拦截**：试验 commit——在 `settings-message-handler.ts` 白名单外新写一行 `getApiKeyForProvider(id)` 调用 | 本地 stage 该改动跑 pre-commit（或直接跑 `node scripts/check-provider-credential-reads.mjs`） | 检查红、报错指向文件行号与 resolver 模块；撤销后转绿 | G4（结构约束生效） |
| 9 | **宿主不变量（负面行为反向验证）**：合法 models.json（无毒化/冻结条目）下重启 runtime 三次；custom provider 全流程（新增 → 模型发现 → 保存 → 编辑 → 清除 API Key → 删除） | 每次重启前后 diff 隔离目录的 models.json / auth.json / providers.json；清除 API Key 后读 models.json | 三次重启三个文件零 diff（清洗不触碰合法条目、防线不产生无谓写盘）；custom 全流程后仅预期条目变化，无残留；**清除 API Key 后 models.json 该条目无 `apiKey` 键（删键而非空串）且 pi 正常加载**（主审 MF1 修复验证）；custom 全流程后无残留 | G2 反面（不矫枉过正）+ 宿主表面不变 |

| 10 | **思考档位如实（失败模式 D 修复）**：用户从零新建 custom provider「OpenCode Go」→「模型发现」合并模型 → 行级设 high-max 策略 → 保存 → composer 档位弹层 | dev 环境全流程操作；保存后读隔离目录 models.json；打开 composer 选该模型看档位弹层 | models.json 中每个合并模型含显式 `"reasoning": true`（非缺失）+ thinkingLevelMap 含 null 剔除项（minimal/low/medium 为 null）；composer 档位弹层显示 off/high/max **三档**（非只有「关」、非六档；第三档显示 max、发送值 xhigh）；另设 on-off 策略的模型显示两档；存量救回双分支：重设 high-max 恢复三档、**重设 all-levels（存量最常见形态）同样恢复**（reasoning 缺失被联动补显式） | G5（失败模式 D 修复） |

| 11 | **旁路写入方收口**（OAuth 收尾 / QuickSetup 导入 / W2 应用导入三条不经编辑体 save 的写入路径）：① 对一个 OAuth 支持的 catalog provider（如 openrouter）走真实 OAuth 登录；② QuickSetup 导入一个模板 baseUrl 非空的 provider（如 kimi）；③ 应用导入（从 pi 配置）一个源端含 provider 级 api/baseUrl 字段的条目 | dev 环境逐条操作后读隔离目录 models.json + providers.json；OAuth 登录后重启一次 runtime | ① OAuth 后：models.json 该 provider **无新增条目/无 artifact 键**，providers.json extras 含 authMethod:'oauth' 标注；② QuickSetup 后：条目不含 baseUrl/api 键（模板默认值不落盘），重启后 models.json 零 diff（无写-剥循环）；③ 导入后：catalog 条目不含源端 provider 级 api/baseUrl（防线载体拦截），custom 条目字段完整且无空串值 | G2（旁路写入方全部被防线覆盖） |

**依赖说明**：场景 1/3/5 需要真实可用的 opencode-go（或任意混合协议 catalog provider）凭据与网络；若验收环境无此凭据，用任意单协议 catalog provider（如 anthropic）替代场景 1，场景 3 的「多协议分组」降级为单协议验证并在验收记录中注明缺口（多协议路径同时由 P-test-req 探针覆盖）；场景 5 的网关可用本地反代（如 `npx http-proxy` 转发到真实端点）验证请求落点，无需真实镜像站。场景 11① 需要一个可完成 OAuth flow 的 provider 账号（无则降级为 P-oauth-shell 探针 + 单测，验收记录注明缺口）；场景 6/8/9/10/11②③ 不依赖网络（场景 10 的「模型发现」可用任意可达的 openai 兼容端点，包括本地反代）。

---

## 5. 下一层拆分

**本节结论：6 个实施单元按「拆雷 → 档位活 bug → 基础设施 → 功能重做 → 展示对齐 → 卫生收尾」排序，M1/M2/M6 三者零耦合可并行（M6 改动最小且是用户可见活 bug，可最先交付），M3 依赖 M2 的 resolver，M4 依赖 M1 防线（保存不再冻结 artifact）方可安全改展示，每个单元可独立验收、独立回滚。**

### 实施路径

```
M1（P0 写侧防线 + 存量清洗 + OAuth/importer 写入方修复）← 最优先：雷先拆
M6（思考档位修复：reasoning 三入口 + 预设语义）          ← 活 bug 用户可见，改动最小可最先交付，与 M1/M2 零耦合
M2（凭据 resolver + 5 链迁移 + lint）                    ← 基础设施：M3 的前置
M3（测试连接 per-model + discover 正名 + 协议扩展）       ← 依赖 M2 resolver
M4（网关优先派生展示）                                    ← 依赖 M1 防线
M5（卫生：锚点修复 + 约束登记 + DOC_MODULE_MAP）          ← 收尾，随 M1-M4 同 PR 或紧随
```

### 拆分清单

| 单元 | 内容 | justification（为什么这么拆） | 独立验收 |
|------|------|------------------------------|----------|
| **M1：P0 拆雷** | D1 六层防线（前端不产生违规值 + runtime 空串转译 + catalog 分体系/网关标记/不物化空壳 + 防线载体共享纯函数 + importer fallback 修复 + OAuth 收尾改造 + QuickSetup payload 修复）+ D2 启动清洗（空串全集 + extras 网关标记判定）+ P-sanitize/P-oauth-shell 探针 | 雷的拆除与凭据/测试/展示零耦合，单独成单元最快消除爆雷面；防线/清洗/写入方修复同属「models.json 写侧完整性」一个语义域；QuickSetup 与 importer 主路径不修则防线语义（v2 非空放行）反而制造写-剥循环/绕过（审查 R2-4/R2-5），必须同批；网关标记（extras）是 D2 判定锚，与写侧同步落地 | 验收场景 1、2、6、9、11 |
| **M2：凭据读路径收口** | D3 resolver（接口下沉 ports + 实现驻 services/auth + PiConfigStore 构造注入 + 双形态/批量 + P-cred 探针）+ 5 链迁移 + D6 lint 脚本/接线/constraints 登记 | resolver 是 M3 的前置（测试连接凭据来源）；lint 与迁移必须同批（先 lint 会拦死现状基线，先迁移则 lint 有基线可守）；链 3 的注入通道设计（接口 + 构造注入）与迁移同批避免二次改 PiConfigStore 装配 | 验收场景 7（quota/发现部分）、8 |
| **M3：测试连接重做** | D4 per-model 真实请求（代表模型双过滤选择 + baseUrl 回落链 + 3 协议最小请求 + P-test-req 探针）+ 协议扩展（optional mode/results + CLI 兼容）+ 前端按协议结果展示 + catalog 隐藏「模型发现」+ CLI `--mode test`（可选）+ i18n | 协议变更与前后端联动是一个原子交付（半态协议 = 前后端错位）；与 M4 无依赖可并行；CLI 兼容（mode 缺省）必须与协议扩展同批（审查 MF1） | 验收场景 3、7（CLI 部分） |
| **M4：网关优先派生展示** | D5 两级语义改造（网关优先 + 派生兜底）+ ProviderEditBody catalog 化（类型只读派生 + 端点改「自定义网关」可选框）+ D7 overlay 归一化去空串（含 `BuiltinModelSummary.api` optional 及消费方收窄）+ 类型注释标记 + QuickSetup 卡片混合检测 + i18n | 展示层依赖 M1 落地（否则用户一次保存又把派生值冻回 override artifact）；网关输入框与防线③的「空串=清除」语义必须配套（同一「网关」心智的两端）；独立于 M3 | 验收场景 4、5 |
| **M5：卫生收尾** | D8 pi 锚点注释修正（pi-provider-repair.ts:34/:45 + pi-provider-store.ts:495-498 前提更新）+ constraints.json 登记/render + check-doc-symbol-drift DOC_MODULE_MAP 登记 + 本文档「待验证检查点」回写 | 全是登记/注释类，不独立发 PR；按设计文档同步纪律（C-proc-10）与 M1-M4 同批或紧随提交 | 检查脚本绿 |
| **M6：思考档位修复** | D9 全部：discover 合并补 reasoning:true + pickStrategy 行级联动 + THINKING_PRESETS 两预设补 null 剔除 + 注释修正（黑名单语义）+ P-presets 探针 + troubleshooting 存量恢复指引 | 用户可见活 bug（档位只有关），优先级实际最高；改动面最小（单文件 4 处 + 文档），与 M1-M5 零耦合可独立交付独立回滚；独立成单元而非并入 M1——M1 语义域是「schema 违规值防线」，本单元是「字段门控语义对齐」，合并会模糊两者的验收边界 | 验收场景 10 |

### 文件改动地图

| 文件 | 改动 | 单元 |
|------|------|------|
| `packages/runtime/src/services/provider-config-helper.ts` | `applyProviderLevelFields`/`applyModelRoutingFields` 空串转译（apiKey=删键、其余=不写键）+ catalog 分体系（type 忽略、baseUrl 网关写入/清除 + extras `gatewayBaseUrl` 标记同步 + 不物化空壳）+ 防线载体共享纯函数（setProvider 与 importer 共用）；`resolveCatalogDisplayFields` 网关优先派生改造；listProviders 内联判定改 resolver 批量 sync 版 | M1/M4/M2 |
| `packages/runtime/src/services/provider-extras-store.ts` | `ProviderExtras` 类型加 `gatewayBaseUrl?: string`（网关显式标记，authMethod 同域先例）；`getExtrasSync` 同步原语作为 sanitize 的 extras 读取注入通道（C-comm-03 分层约束） | M1 |
| `packages/runtime/src/infra/pi/pi-provider-store.ts` | `sanitizeInvalidProviders` 扩展（空串全集剥键 + catalog 冻结 artifact 剥键 + 顺序契约）；`readAuthCredentials` 两处消费改经注入的 resolver；MF/修复路径注释锚点与前提修正 | M1/M2/M5 |
| `packages/runtime/src/services/ports/`（新 `provider-credential-resolver.ts` 接口文件） | `IProviderCredentialResolver` 接口（三方法） | M2 |
| `packages/runtime/src/services/auth/provider-credential-resolver.ts` | **新建**：实现（双形态 + 批量 + 源优先级单点 + P-cred） | M2 |
| `packages/runtime/src/index.ts` | 组合根：resolver 装配 + 模块级 init setter 注入（检查点 5）；clearApiKey 闭包改 sync 版；启动 async 阶段编排 D2 待清标记清单的 `extrasStore.modify` 执行 | M2/M1 |
| `packages/runtime/src/infra/pi/pi-config-store.ts` | 链 3 注入通道（模块级 init setter 首选 / 传参备选，按检查点 5 落地） | M2 |
| `packages/runtime/src/services/quota-service.ts` | `getCredential` 的 auth.json/models.json 两段改 resolver（保留 secrets 首段） | M2 |
| `packages/runtime/src/transport/settings-message-handler.ts` | `handleDiscoverModels` 迁移 resolver + mode 分支（test → per-model 编排） | M2/M3 |
| `packages/runtime/src/services/model-service.ts` / 新 `infra/model-connection-tester.ts` | per-协议代表模型双过滤选择 + baseUrl 回落链 + 3 协议最小请求实现（对齐 `model-api-discoverer.ts` 的 infra 归属模式） | M3 |
| `packages/runtime/src/cli/commands.ts` | `discover-models` 冒烟核对（mode 缺省兼容）；可选加 `--mode test` | M3 |
| `packages/runtime/src/services/migration/provider-importer.ts` | 主路径（`:251/:322` 直调 upsertProvider 的两处）接入防线载体共享纯函数（catalog 源端 provider 级字段不落盘 + 空串转译）；fallback 路径 catalog 不写 `tpl.api`/`tpl.baseUrl`/`config.apiKey` | M1 |
| `packages/runtime/src/services/provider-catalog.ts` | `overlayToCatalogModel` 去空串归一（api/baseUrl 缺省） | M4 |
| `packages/shared/src/protocol.ts` | `config.discoverModels` 加 optional `mode`；`config.discoveredModels` 加 `results`；`SetProviderData` 注释增补 | M3 |
| `packages/shared/src/provider.ts` | `ProviderInfo.api/baseUrl` 网关/派生语义注释；`BuiltinProviderTemplate.api/baseUrl` artifact 标记；`BuiltinModelSummary.api` 改 optional（D7 连带） | M4 |
| `packages/core/src/domain/settings/use-provider-edit.ts` | save() catalog 不带 type、baseUrl 仅网关非空才带、custom 空串不带键；runDiscover 传 mode；D9：discover 合并补 reasoning:true、pickStrategy 行级联动、THINKING_PRESETS 两预设补 null 剔除 + 注释修正 | M1/M3/M6 |
| `packages/renderer/src/composables/features/settings/useProviderPageOauth.ts` | OAuth 收尾 payload 改 `{authMethod:'oauth'}`-only | M1 |
| `packages/ui/src/features/settings/provider/use-quick-setup-form.ts` | payload 去掉 baseUrl（模板默认值不落盘）+ 清理 `api` 死键（字段名与 `SetProviderData.type` 不匹配，从未生效） | M1 |
| `packages/renderer/src/composables/shell/settings-transport-adapter.ts` | discoverModels 透传 mode | M3 |
| `packages/ui/src/features/settings/provider/ProviderEditBody.vue` | catalog：类型只读派生展示 + 端点改「自定义网关」可选输入框（placeholder/清除语义）+ form.api 取值定义 | M4 |
| `packages/ui/src/features/settings/provider/ProviderTestDiscoverSection.vue` | 按协议分组结果展示 | M3 |
| `packages/ui/src/features/settings/provider/ProviderQuickSetup.vue` | 模板卡 api/baseUrl 混合检测展示（'—'/「按模型分发」） | M4 |
| `scripts/check-provider-credential-reads.mjs`（新）+ `.githooks/install-hooks.sh` + `scripts/preflight-check.sh` | lint 脚本 + 两处接线 | M2 |
| `docs/constraints.json` + `docs/constraints.md`（render）+ `scripts/check-doc-symbol-drift.mjs` | 约束登记 + 文档映射登记 | M5 |
| i18n（zh-CN / en） | 派生/网关文案 / 测试连接结果 / 错误指引 / 「模型发现」正名 | M3/M4 |
| 测试（vitest，各包既有配置） | resolver 优先级、清洗剥键（空串矩阵 + 网关标记判定/待清清单）、网关优先派生函数、setProvider 防线（含 apiKey 删键/不物化空壳/source 维度分流）、use-provider-edit payload、OAuth 收尾、overlay 归一化、D9 用例（discover 合并 reasoning 显式 / pickStrategy 联动含显式 false 不覆盖 / 两预设经 pi 同源 getSupportedThinkingLevels 断言档位数——挂 use-provider-edit / thinking-levels 既有测试文件）；受 THINKING_PRESETS 修正影响的 renderer fixture 测试同批更新（实施时 grep 定位）——全部 `mkdtemp` 隔离，不碰真实数据目录 | 各单元 |
| `docs/troubleshooting.md` | D9⑤ 存量恢复指引（models.json 补 reasoning:true / 重新设置策略） | M6 |

### 待验证检查点（设计阶段无法确定，实施期必验）

1. **P-cred**（M2 内）：xyz AuthStorage 对 $ENV_VAR / command 配置值凭据的解析现状——决定 resolver 是否要自实现 env 展开（降级路径见 §3.6）。
2. **P-test-req**（M3 内）：3 协议最小请求体在真实端点的可调通性——决定支持集与「暂不支持」文案的覆盖范围。
3. **P-sanitize**（M1 内）：剥键清洗（空串矩阵 + 冻结 artifact）对毒化文件的充分性——复用 P-poison 脚本验证。
4. **P-oauth-shell**（M1 内）：OAuth 收尾不物化条目的端到端验证。
5. **链 3 注入接线**（M2 内）：resolver 注入按 PiConfigStore 实际装配形态落地——**模块级 init setter（首选）/ 调用链显式传参（备选）**；禁选构造参数形态（薄委托类实态下构造参数到不了模块级消费点，主审第 3 轮 S5），任一落地形态均需满足「组合根装配完成先于任何 findValidDefaultModel 调用」的时序约束。
6. **派生展示对 overlay-only 模型的覆盖**（M4 内）：`getMergedCatalogModels` 在 overlay expired/never-seen 时退化为纯快照——派生值在 overlay 刷新前后可能变化（如 pi.dev 目录新增模型改变同值性），实施时确认这是预期行为（派生值跟随数据权威变化）而非缺陷，并在类型注释写明。

---

## 附录：变更历史

- 2026-09-10 v1 初版。基于两轮诊断（opencode-go 混合协议诊断：展示 artifact / 测试连接双缺陷 / P0 雷 / 读路径未收口）与本次全量调研（凭据 5 链矩阵、前端链路、pi 0.84.4 实装核实、P-poison/P-scope 实测探针）。用户已裁定四修复方向（拆 P0 / 凭据唯一通道 / 测试连接 per-model / 聚合派生展示）并否决 baseUrl 兜底与全局单点探活。
- 2026-09-10 v2（第 1 轮对抗审查修订：主审 3 must-fix + 2 suggestion、影响面审 6 must-fix + 4 suggestion，全修）。关键修订：① 防线字段集扩至 pi schema minLength 全集（apiKey:'' 是「清除」哨兵活路径，改删键语义）；② 发现并采纳「catalog override provider 级 baseUrl = pi 官方网关覆盖机制」（provider-composer.js:98）——D1③ 从「永不写」改为「非空保留（用户网关）/ 空串清除」，D5 改「网关优先派生兜底」，M4 输入框改「自定义网关」可选框，D2 新增冻结 artifact 清理（值===快照值判定）；③ D3 链 3 分层注入设计（接口下沉 ports + PiConfigStore 构造注入）+ 批量形态；④ mode 改 optional 缺省 discover（CLI 第二调用方兼容）；⑤ OAuth 收尾链/importer/QuickSetup 写入方枚举与修复；⑥ D5 代价清单完整重写（7 消费点逐处判定）；⑦ §3.4 补 models-store.json 竞态登记与 setProvider 调用方全集；⑧ 验收扩至 9 场景（网关工作流 / 冻结恢复 / CLI 冒烟 / apiKey 删键）。
- 2026-09-10 v3（并入同分支第三份诊断：自定义模型思考档位「只有关」，据 `/tmp/handoff-xyz-agent-thinking-levels.md`）。新增：§2.4 失败模式 D（reasoning 字段语义坍缩——pi 两级门控把缺失等同 false，两个写入入口不写 reasoning，models.json 用户数据实测实锤；次级发现 THINKING_PRESETS 白名单心智 vs pi 黑名单过滤语义，on-off 实际 5 档、high-max 实际 6 档）；G5 目标；D9 决策（三入口收口 + 两预设补 null 剔除 + 注释修正 + 存量「重设策略」恢复路径，被否含计算侧放宽/存量批量迁移）；P-gate（✅ 已实测）/ P-presets（⛔ M6 门）探针；M6 实施单元（活 bug 最先交付）；场景 10 端到端验收；根因表述升级为三维语义不对齐（schema 违规值 / artifact 捏造 / 语义坍缩）。
- 2026-09-10 v3.1（第 2 轮双审复审修订：主审 1 must-fix + 4 suggestion、影响面审 4 must-fix + 1 suggestion，全修；与 v3 合并为同一版本交付）。关键修订：① D2② 判定换锚——废弃「值===快照值」（两审同题命中其锚漂移与自相矛盾反例），改为 providers.json extras 显式网关标记 `gatewayBaseUrl`（api 键一律剥除 + baseUrl 按标记判定，快照值免疫 + 来源歧义消除）；D1③ 网关写入同步落标记 + 写序契约（先 extras 后 models.json）；存量无标记网关误剥登记为已接受代价；② D1 新增防线⑥ QuickSetup payload 修复（模板 baseUrl 写-剥循环 + api 死键清理）与防线载体（转译逻辑提取共享纯函数，importer 主路径 `:251/:322` 直调 upsertProvider 的绕过被封堵）；③ D3 注入形态按 PiConfigStore 薄委托实态改写（模块级 init 首选/传参备选）；④ D1③「不物化空壳」补既有条目 no-op 声明；②③层间分工显式化；⑤ §3.4 importer 主路径双列 + models-store.json 行表述修正（xyz 只读该文件，写的是自有 overlay cache）；⑥ 验收补场景 11（旁路写入方：OAuth/QuickSetup/应用导入）；场景 6 改标记判定语义。
- 2026-09-10 v3.2（第 3 轮双审复审修订：主审 0 must-fix + 5 suggestion、影响面审 3 must-fix + 2 suggestion，全修）。关键修订：① 网关清除信号改**显式空串带键**（R3-1：v3.1「未带键=清除」与 `undefined=不变` 既有协议相撞、OAuth 重登/QuickSetup 会静默清网关）——前端对 catalog 恒带 baseUrl 键，未带键恒 = 不变；场景 5 加「设网关 → OAuth 重登 → 网关仍在」组合断言；② 防线载体加 `source: 'settings' | 'import'` 维度（R3-2：setProvider 与 importer 对 catalog baseUrl 相反处置由参数显式化）+ 纯函数无副作用（extras 编排返回信号归调用方）+ 入参字段名归一；③ D2② extras 访问通道补分层设计（R3-3：`getExtrasSync` sync 原语注入 sanitize，「清多余标记」由启动 async 阶段编排）；④ gatewayBaseUrl 判定显式为仅存在性（禁值比对）；清除网关写序对称（先 models 后 extras，崩溃中间态恒为可自愈的多余标记）；importer fallback catalog 返回 failed（`imported` 语义澄清）；⑤ D9② 联动改「缺失才补显式、永不覆盖用户显式 false、all-levels 同规则」（存量最常见形态救回闭合）；D9 证据补主审第 3 轮档位实测（high-max 第三档 = 档位名 max/发送 xhigh）；⑥ D6 加 `upsertProvider` 直调清单姊妹守卫；§3.4 providers.json 行改为如实列 2 个新增写入点；检查点 5 禁构造参数形态；场景 10 补 all-levels 救回分支。
- 2026-09-10 v3.3（第 4 轮收敛确认：主审 0+0、影响面审 0 must-fix + 1 suggestion，全修——**设计就绪**）。网关展示判定与取值唯一来源 = override 非空 baseUrl（标记仅作 D2 清洗锚，避免 stale 标注窗口）；清除分支对不存在标记 no-op 短路（modify 无内容 diff 守卫）；空串转译 trim 同视；改动地图注入措辞残留清理。四轮收敛轨迹：主审 3→1→0→0 must-fix，影响面审 6→4→3→0 must-fix；四轮累计 13 must-fix + 12 suggestion 全部闭环、零未修项。
