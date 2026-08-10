# Provider 增删路径三道结构性加固：拆分 + 标识防护 + defaultModel 统一

> **结论**：provider 增删是 xyz-agent 高频且易错的代码路径。近两次线上 bug——`ModelSelectPopover` 把显示名当标识传给 pi 致 "Model not found"（commit `cd41254ba` 已局部修）、`applyImportProviders` 漏维护 defaultModel（同 commit 已局部补）——都源于这条路径缺乏结构性防护：类型层零编译期拦截（全程裸 `string`）、行为层维护逻辑分散（5 个 handler 各自编排）、结构层承载文件超阈难审查（`config-service.ts` 1059 行 / `pi-provider-store.ts` 871 行）。本文设计三道加固，**按"先拆分清场 → 类型化拦截 → 行为收敛"的依赖顺序**整合实施，让每步独立可测、可回滚。

---

## §1 背景目标

### SCQA

- **S（情境）**：xyz-agent 经 runtime 聚合 pi 的两套 provider 体系（catalog 内置 / custom `models.json`），provider 的增删（导入 / 新建 / 切换启用 / 移除）是 Settings 页核心操作，每次增删都要维护 `defaultModel`（重选 + 广播）让 composer 不失配。
- **C（冲突）**：这条路径在类型、行为、结构三层都缺防护——类型层 `ProviderInfo.id`（机器标识）与 `.name`（显示名）同为 `string`，靠人工约定区分，已踩坑（显示名误传 pi）；行为层 defaultModel 维护分散在 5 个 handler 各自编排，已踩坑（导入漏维护）；结构层两承载文件超 500 行阈值靠 ESLint override 豁免，难审查。
- **Q（问题）**：怎么让这条路径在类型层编译期拦截 id/name 混淆、行为层消除分散编排的遗漏根因、结构层降到可审查的行数？
- **A（答案）**：三道加固整合实施——**先**拆分两承载文件（纯搬家、行为零变化、清出模块边界），**再**引入 `ProviderId` 品牌类型（编译期拦截），**最后**抽 `reconcileDefaultModelAfterProviderChange` helper 统一 5 handler 的 defaultModel 维护（消除遗漏根因）。

### 系统是什么

xyz-agent 的 provider 配置体系（详见 [provider 双体系聚合架构](provider-config-pi-alignment.md)）由三层组成，理解三者的边界是理解本设计的前提：

1. **数据文件**（`<dataDir>/pi/agent/` 下，xyz-agent 只操作三个）：`models.json`（自定义 provider 全配置 + catalog override）、`auth.json`（凭据）、`settings.json`（`defaultProvider` + `defaultModel` 两字段 + `enabledModels` 白名单）。
2. **runtime 读写层**（本设计的两个主战场）：`config-service.ts`（`ConfigService` 类，provider CRUD + Skill/Agent/SystemPrompt/Terminal/Worktree 配置的 facade）、`pi-provider-store.ts`（`models.json`/`settings.json` 原子读写层，纯函数模块）。
3. **pi 子进程**：per-session 独立进程，经 `set_model` RPC 切模型、经 `createSession` 的 `options.model` 设初始模型。**pi 边界只认 provider id**（小写机器标识），不认显示名。

> **关键边界**：本设计所有改动遵守"xyz-agent 只操作 settings.json / auth.json / models.json，不改 pi 源码"。

### 设计目标（从使用者体验倒推）

| # | 使用者 / 维护者要能做到 | 现状 |
|---|---|---|
| G1 | 切换模型时**不可能**因 id/name 混淆报 "Model not found" | ⚠️ 已局部修一处，但类型层无拦截，同类混淆可复发 |
| G2 | 任何 provider 增删入口（含未来新增）**自动**维护 defaultModel，不再靠每个 handler 各自记 | ❌ 5 handler 分散编排，`applyImportProviders` 曾漏 |
| G3 | `config-service.ts` / `pi-provider-store.ts` 单文件可审查（<500 行），不用 ESLint override 豁免 | ❌ 1059 / 871 行，override 登记为"独立重构任务" |
| G4 | mock 数据也区分 id/name，**不让 mock 掩盖混淆** | ❌ `composer-data.ts` mock 把显示名 'Anthropic' 同时赋给 `providerId` 和 `providerName`（`mockModelToInfo` 内 `providerId: m.provider`） |

### scope

- **当前层 → 下一层**：当前层 = 三道加固的技术方案设计；下一层 = 可实现的接口签名 / 模块拆分清单 / 文件改动地图。属**技术方案设计类**（准则 5/6/7 全 P0，验收要求真实环境跑通）。
- **in-scope**：
  - 结构：`config-service.ts` 拆分（Provider 编排 / Skill / SystemPrompt / Terminal 抽 helper）、`pi-provider-store.ts` 拆分（维护工具 / 白名单 / skill 路径抽模块）
  - 类型：`ProviderId` 品牌类型引入 + 边界决策（runtime 内 vs 跨 WS 协议）
  - 行为：`reconcileDefaultModelAfterProviderChange` helper 抽取 + 5 handler 收口
- **out-of-scope**：
  - toggle 的 service 层重选（`pickEnabledDefaultModel` 有凭据优先）与 store 层重选（`pickFirstModelProvider`）语义统一——这是独立的重选策略问题，reconcile 只接管"拿到 newDefault 后广播"，不动重选逻辑
  - OAuth login 后 defaultModel 持久化的边界场景加固（调查 B 判定为产品决策，见 §3.3 决策 D4）
  - pi 源码改动（架构约定禁止）

### 三组改动的依赖顺序（核心决策，详解见 §3.3 决策 D1）

```
Phase 1 拆分（纯搬家，行为零变化）  →  Phase 2 品牌类型（编译期拦截）  →  Phase 3 reconcile（行为收敛）
```

每步独立可测、可回滚。理由：拆分先清出模块边界，让类型化和行为收敛的改动集中在清晰落点，而非散落在 1000 行大文件里。

---

## §2 现状与问题分析

### 2.1 失败模式 A：显示名误传 pi 致 "Model not found"（已局部修，根因未除）

**真实复现**（commit `cd41254ba` 修复前）：用户导入 pi 的 catalog provider `xiaomi-token-plan-cn`（显示名 "Xiaomi Token Plan CN"），在 composer 切换到该模型时：

```
[用户操作] ModelSelectPopover 点击 "Xiaomi Token Plan CN" 分组下的模型
[bug 路径] onSelect 传 group.provider（= m.providerName = "Xiaomi Token Plan CN"）
           → switchModel(sid, "Xiaomi Token Plan CN", modelId)
           → WS model.switch { provider: "Xiaomi Token Plan CN" }
           → rpc-client set_model { provider: "Xiaomi Token Plan CN", modelId }
[pi 报错] "Model not found"  ← pi 按 provider id 查，"Xiaomi Token Plan CN" 不是 id
```

**根因**：`ProviderInfo` 正确定义了 `id`（标识）和 `name`（显示），但 **TS 类型层两者都是 `string`**——把 `name` 赋给期望 `id` 的位置，编译器零提示。`ModelSelectPopover.vue` 的 `group.provider` 字段名歧义（既可能是 id 也可能是 name），靠开发者记忆区分，踩坑是迟早的事。

**调查实证**（调查 A，全链路 file:line 证据）：当前代码库逻辑上基本正确——复合串统一 `"providerId/modelId"`（实测样例 `"amazon-bedrock/amazon.nova-2-lite-v1:0"`，id/id），pi 边界（`set_model` RPC + `createSession` options.model + plugin agent.setModel）全程收 id，无其他 name 误用。**但"逻辑正确"全靠人工约定 + 注释维持，无编译期防护**。

**恢复指引**（准则 6）：切模型报 "Model not found" 时，检查 `config.defaults` WS payload 的 `defaultModel` 复合串 provider 段——若是大写 / 含空格（显示名特征），即为 id/name 混淆，修复方式见 §3 决策 D2（品牌类型根治）或临时在 `ModelSelectPopover` emit 处改传 `group.providerId`。

### 2.2 失败模式 B：provider 增删后 defaultModel 维护遗漏（已局部修，根因未除）

**真实复现**（commit `cd41254ba` 补救前）：用户从其他 agent 导入首个 provider 后，composer 无默认模型可选——因为 `applyImportProviders` handler 只广播了 provider 列表，没设 defaultModel：

```
[导入完成] settings.json: { defaultProvider: undefined, defaultModel: undefined }
[handler]  applyImportProviders → broadcastProviderList ✓  → (漏) 没广播 config.defaults
[composer] defaultModel 空 → 无默认模型
```

**根因**：defaultModel 维护（重选 + 广播 `config.defaults`）分散在 `settings-message-handler.ts` 的 5 个 handler 各自编排，**没有统一机制**。各 handler 状态（调查 B 实证）：

| handler | service 调用 | broadcastProviderList | defaultModel 维护 | 机制 |
|---|---|---|---|---|
| `config.setProvider` (:42) | setProvider | ✅ | ✅ 读 `setResult.newDefault` | store 层重选返回 |
| `config.deleteProvider` (:57) | deleteProvider | ✅ | ✅ 读 `delResult.newDefault` | store 层重选返回 |
| `config.toggleProviderEnabled` (:71) | toggleProviderEnabled | ✅ | ✅ 读 `toggleResult.newDefault` | service 层重选返回 |
| `config.removeProviderByKind` (:88) | removeProviderByKind | ✅ | ✅ 读 `removeResult.newDefault` | store 层透传 |
| `config.applyImportProviders` (:250) | applyImportProviders | ✅ | ✅ **靠 `getDefaultModel()` 兜底**（已补） | 不返回 newDefault |

前 4 个 handler 走 `result.newDefault`，第 5 个走 `getDefaultModel()` 兜底——**两类机制并存**，正是遗漏的根源：任何"不返回 newDefault"的新入口（如未来的 OAuth 后维护），开发者必须记得另写兜底，否则复发。

**调查实证**（调查 B）：除这 5 个 handler 外无其他入口（CLI 走 RPC 复用同 handler，extensions/apps 零调用）；OAuth login 成功回调（`auth-service.ts:95-137`）不触及 defaultModel（性质上 OAuth 只给已存在 provider 加凭据，不增删，不维护基本合理，见 §3.3 决策 D4）。

**恢复指引**：导入 / 新建 provider 后 composer 无默认模型时，查 `settings.json` 的 `defaultProvider` 字段是否为空——若空且 provider 列表非空，即 defaultModel 维护遗漏，临时手动切换一次模型触发 `getDefaultModel`（内部 `findValidDefaultModel` + `wasFixed` 写回）即可修复。

### 2.3 失败模式 C：承载文件超阈难审查

`config-service.ts`（1059 行）是 Config 域唯一 facade，`pi-provider-store.ts`（871 行）是 models.json/settings.json 唯一读写层。两者都因行数超 500 用 ESLint override 豁免（`eslint.config.mjs` 带 `[HISTORICAL]` 注释登记为"独立重构任务"）。

**根因**：不是单点 bug，而是**结构性债务**——所有 Config 域 / provider 读写逻辑堆在单文件，每次新增功能（wave2/3/4 的 toggle/remove/import）都往里塞，最终超阈。后果：§2.1 §2.2 的排查都要在 1000 行文件里定位，审查成本高。

**已验证的拆分范本**：`worktree-config-helper.ts` 已把 worktree 偏好从 `config-service` 抽出，模式是「抽 helper 模块 + `ConfigService` 保留单行委托 + 行为 / 签名 / import 路径零变化」。本设计的 Phase 1 复用此模式。

### 2.4 物理数据流：provider 增删 → defaultModel → 广播（现状）

```
[用户操作] Settings 增删 provider（5 个 handler 之一）
      │
      ▼  configService.<method>(id, ...)        ← ConfigService（config-service.ts 1059 行）
[ConfigService] 委托 configStore / authStorage / pi-provider-store
      │                                           ← pi-provider-store.ts（871 行）
      ▼  store 层：upsertProvider/removeProvider 内 updateSettingsSync 重选 defaultModel
[settings.json] { defaultProvider, defaultModel } 写回（wasFixed:true 时）
      │
      ▼  return { newDefault? }  ────────── applyImportProviders 不返回 newDefault ──┐
[handler] 各自编排：                                                                  │
   前4个: if (result.newDefault) broadcast('config.defaults', 复合串)                │
   第5个: getDefaultModel() 兜底 → broadcast('config.defaults', 复合串) ◄────────────┘
      │
      ▼
[renderer] settingsStore.defaultModel 更新 → composer 默认模型联动
```

**两个断裂点**（对应 §2.1 §2.2）：
- 数据流里 `provider` 段全程是裸 `string`，id/name 混淆无拦截（§2.1）。
- defaultModel 广播的编排散在 5 个 handler，无统一收口（§2.2）。

### 2.5 术语定义（锚定上述例子）

| 术语 | 定义 | 就是上面例子的 |
|---|---|---|
| **ProviderId** | provider 的机器标识，小写如 `xiaomi-token-plan-cn`，pi 边界只认它 | §2.1 复合串 `"xiaomi-token-plan-cn/glm-4.6"` 的前段 |
| **显示名 (name)** | 给用户看的文案，如 "Xiaomi Token Plan CN" | §2.1 误传 pi 导致 "Model not found" 的那个值 |
| **复合串** | `"providerId/modelId"` 格式，内存 / WS / session.modelId 用；磁盘拆两字段 | §2.1 的 `"amazon-bedrock/amazon.nova-2-lite-v1:0"` |
| **defaultModel 维护** | provider 增删后重选默认模型 + 广播 `config.defaults` | §2.2 5 handler 各自做的事 |
| **reconcile** | 统一收口 defaultModel 维护的 helper（本设计 Phase 3 产物） | §2.2 要替代的分散编排 |

---

## §3 解决方案

### 3.1 终态（使用者视角）

**成功路径 · 导入首个 provider 后 defaultModel 自动设置**

```
[用户] Settings → 从其他 agent 导入 → 选 xiaomi-token-plan-cn
[importer] catalog 分支：凭据 → auth.json，models.json 不建条目
[handler] applyImportProviders 成功
[reconcile] reconcileDefaultModelAfterProviderChange(ctx)   ← Phase 3 统一入口
            ├─ existingNewDefault = undefined（applyImport 不返回）
            ├─ fallback = getDefaultModel() → findValidDefaultModel → wasFixed:true → 写回 settings.json
            └─ broadcast('config.defaults', { defaultModel: "xiaomi-token-plan-cn/<first-model>" })
[composer] 默认模型 = xiaomi-token-plan-cn 的首个模型  ✅ G2 达成
```

**成功路径 · 切换模型时类型层拦截误用**

```
[开发者写] ModelSelectPopover 某处误把 group.provider（显示名）传给 switchModel
[tsc 编译] error: Argument of type 'string' is not assignable to parameter of type 'ProviderId'.
           ← Phase 2 品牌类型编译期拦截，代码进不了仓库  ✅ G1 达成（根治）
```

**失败路径 · mock 数据掩盖混淆（Phase 2 顺带修）**

```
[开发者写] mock/composer-data.ts: providerId: m.provider（展示名 'Anthropic'）
[tsc 编译] error: 'Anthropic' 不能赋给 ProviderId（品牌类型要求小写 id 形式）
[修复]    改为 providerId: 'anthropic', providerName: 'Anthropic'  ✅ G4 达成
```

**恢复指引**（准则 6，贯穿原则）：任何 provider 相关的 "Model not found" / 默认模型空，第一检查点是 `settings.json` 的 `defaultProvider` 字段 + `config.defaults` WS payload 的复合串 provider 段——Phase 2/3 后这两处类型化为 `ProviderId`，运行时若仍出现，说明有绕过品牌的 `as` 断言，用 `grep -rn "as ProviderId" packages` 定位。

### 3.2 多方案对比

#### 问题一：id/name 混淆防护

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 品牌类型 `ProviderId`**（选） | 编译期拦截，by construction 正确；mock 也强制区分 | 中：第一批 ~30 文件、纯函数参数签名 ~30-40 处（审查核实 runtime 层 `provider: string`/`providerId: string` grep 90+ 处/26 文件，含字段/局部变量） | 反序列化边界需工厂函数提升；**分两批**见决策 D2（quota.*/oauth* 第二批独立） | ✅ |
| B 约定 + ESLint 规则 | 仅靠人遵守 + 规则启发式匹配 | 低 | 规则易误报 / 漏报，无编译期保证；新代码不受约束 | ❌ 若用 B，§2.1 的 `group.provider` 歧义字段名仍可复发 |
| C 契约测试 | 测试兜底，不改类型 | 低 | 只能事后发现，且 mock 数据掩盖下测不出 | ❌ 若用 C，§2.1 同类混淆仍可在非测试覆盖路径复发 |

**推荐 A**。品牌类型是唯一能 by construction 阻止混淆的方案，且顺带修复 mock 弱点（G4）。成本可控——改动集中在 explorer A 盘点的 ~10 个生产 id 文件，消费侧读 `.id` 当 `string` 多数不报错（`ProviderId extends string`）。

#### 问题二：defaultModel 维护统一

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 抽 `reconcileDefaultModelAfterProviderChange` helper**（选） | 统一收口，新 handler 自动获得兜底 | 低：5 handler 各改 ~5 行 | 调查 B 已证无双重写回 / 广播（探针 P1 实测） | ✅ |
| B 各 handler 保持现状 | 零改动 | 零 | 遗漏根因（§2.2）不除，新入口复发 | ❌ 若用 B，§2.2 的 applyImport 漏维护会在下一个"不返回 newDefault"的入口复发 |

**推荐 A**。helper 契约 `existingNewDefault ?? getDefaultModel()` 二选一，调查 B 已逐项排查双重副作用（见 §3.3 决策 D3 + 探针 P1）。

#### 问题三：承载文件拆分

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 彻底拆（摘 override）**（选） | 模块边界清晰，可审查；为 Phase 2/3 提供落点 | 中：纯搬家，测试兜底 | 低（行为零变化，复用 worktree-config-helper 已验证模式） | ✅ |
| B 只拆最不内聚块 | store 降 ~690 仍超阈 | 低 | override 保留，未根治 | ❌ 若用 B，§2.3 的审查成本不降，且 Phase 2 类型化仍在大文件散改 |

**推荐 A**。拆分是 Phase 2/3 的前置清场（决策 D1），彻底拆才能让后两步改动集中、可审查。

### 3.3 关键决策与权衡

#### 决策 D1：依赖顺序 = 拆分 → 类型化 → 行为收敛

- **选择**：Phase 1 拆分（纯搬家）→ Phase 2 品牌类型 → Phase 3 reconcile。
- **被否**：先类型化再拆分 / 先 reconcile 再拆分。
- **证据**：拆分是行为零变化的纯搬家（worktree-config-helper 已验证），先做能清出模块边界。若先类型化，`config-service` 还是 1059 行，~15 个签名改动散落难审查；若先 reconcile，handler 编排改了但承载文件没拆，helper 放置点（service 还是 handler 层）不清晰。
- **减法考量**（准则 8）：三步是否都能砍？不能——拆分清场、类型拦截、行为收口各治一个独立根因（§2.3 / §2.1 / §2.2），缺一留一类复发面。

#### 决策 D2：品牌类型边界 = 分两批，核心防混淆链优先

- **选择**：分两批类型化。**第一批（Phase 2 范围，核心防混淆链）**——`ProviderId` 贯穿 shared 定义 → runtime（rpc-client 边界）→ renderer（composable/component），并类型化与 id/name 混淆直接相关的 7 个 WS payload：`model.switch` / `config.defaults` / `config.setDefaultModel` / `config.setProvider` / `config.deleteProvider` / `config.toggleProviderEnabled` / `config.removeProviderByKind`。**第二批（独立任务，不在本次 scope）**——`quota.fetch` / `quota.getCached` / `quota.configure` / `quota.refresh` 与 `config.oauthLogin` / `oauthCancel` / `hasOAuth` 等 payload 的 provider 字段。
- **被否**：① 仅 runtime 内部类型化（WS payload 仍 `string`）——防护到进程边界就断，前端仍可传 name；② Phase 2 一次全类型化 protocol.ts 全部 13+ 含 provider 的 payload——会波及 quota 服务、QuickSetup OAuth 前端等大量连带代码，改动面爆炸。
- **证据**：调查 A 指出混淆高发在前端 → WS → runtime 这段（`ModelSelectPopover` 正是前端）。第一批覆盖 model 交互链 + provider CRUD（混淆直接面）；第二批的 quota/oauth 虽跨 WS，但 provider 语境在 provider 卡片内已确定（非自由输入），混淆风险低，留独立加固。
- **成本修正**（审查 P0-12 核实）：protocol.ts 实测含 provider/providerId 的 payload type 共 13+，非文档原估的 ~5；runtime 层签名 grep 90+ 处/26 文件。第一批约 7 payload + ~30-40 函数参数签名；第二批约 6-7 payload + 连带 quota/OAuth 前端组件，独立排期。

#### 决策 D3：reconcile helper 契约 + 放置点

- **选择**：契约 `reconcileDefaultModelAfterProviderChange(ctx, existingNewDefault?)`，内部 `existingNewDefault ?? ctx.configService.getDefaultModel()`，`config.defaults` 广播收敛 helper 内一次；`broadcastProviderList` 留 handler（语义正交）；放置在 `settings-message-handler.ts` 的 ctx helper（与 handler 同文件，不新增跨模块依赖）。
- **被否**：把 `broadcastProviderList` 也收进 helper；把 helper 放 service 层。
- **证据**（调查 B）：`broadcastProviderList` 是"provider 列表变更"语义，applyImport 只成功时广播、其它总广播，收口 handler 更清晰；helper 放 service 层会引入 service → broadcast 的反向依赖（broadcast 是 transport 层职责）。
- **运行时断言**（准则 7）：「无双重写回 / 双重广播」靠 `??` 短路 + 广播收敛。**探针 P1（⛔ Phase 3 前必跑）**：5 handler 各触发一次，断言 `config.defaults` 广播次数 = 1。

#### 决策 D4：OAuth login 后 defaultModel 持久化（边界场景，out-of-scope）

- **选择**：本次不加固。OAuth 成功后不主动 reconcile。
- **被否**：OAuth 成功后调 reconcile。
- **证据**（调查 B）：OAuth 只给**已存在** catalog provider 加凭据，不增删 provider，defaultModel 承载的 provider 有效性不变 → 不维护在主路径下合理。唯一边界（defaultModel 为空时首次 OAuth，settings.json 持久化滞后）是产品决策，非缺陷，留待产品定夺后另开任务。

#### 决策 D5：品牌类型反序列化边界用工厂函数

- **选择**：磁盘读出（settings.json `defaultProvider`、auth.json key、builtin-providers.json `id`）是裸 `string`，用工厂 `as ProviderId` + 运行时 guard（可选）提升。
- **被否**：直接 `as ProviderId` 无 guard。
- **证据**：品牌类型只在编译期防护，运行时 `as` 可绕过。反序列化是"信任边界"（外部数据），加最小 guard（如校验小写 / 非空）更稳。但为控制改动面，guard 可选——Phase 2 先 `as ProviderId`，后续按需加 guard。

### 探针清单（准则 7，实施期门槛）

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| **P1** | reconcile 无双重写回 / 双重广播 | 5 handler 各触发一次，断言 `config.defaults` 广播 = 1 次 + settings.json 写 = 1 次 | ⛔ Phase 3 前 |
| **P2** | 品牌类型拦截 mock 混淆 | Phase 2 后 `composer-data.ts` mock 若 id/name 同值，tsc 报错；修复后绿 | ⛔ Phase 2 后 |
| **P3** | 拆分后两文件 <500 行 | `wc -l config-service.ts pi-provider-store.ts` + ESLint override 移除后 `pnpm lint` 绿 | ⛔ Phase 1 后 |
| **P4** | 导入首个 provider 后 defaultModel 写盘 | applyImportProviders 后读 `settings.json.defaultProvider` 非空 | ⛔ Phase 3 后 |
| **P5** | 品牌类型未引入绕过的 `as` 断言 | `grep -rn "as ProviderId" packages` 清单审查，每处有 guard 或注释说明 | ⛔ Phase 2 后 |

---

## §4 验收（真实场景，非单测）

> 验收回溯 §1 四个目标（G1-G4）。单元测试仅作回归辅助，不计入验收——验收回答"真实工作里符合预期吗"。

### 场景 1（验证 G1 + G2）：导入首个 catalog provider 后切模型

- **回溯目标**：G1（不报 Model not found）+ G2（defaultModel 自动维护）
- **步骤**：
  1. 清空 dev 数据目录的 `settings.json`（`defaultProvider`/`defaultModel` 置空）
  2. `pnpm dev` 启动，Settings → 从其他 agent 导入 → 选 `xiaomi-token-plan-cn`
  3. 观察导入完成后 composer 是否有默认模型
  4. 在 composer 用 ModelSelectPopover 切到该 provider 的模型
- **通过标准**：步骤 3 composer 显示默认模型 + `settings.json.defaultProvider === "xiaomi-token-plan-cn"`（P4）；步骤 4 切换成功无 "Model not found"
- **依赖**：真实 pi 子进程 + 真实 dev 数据目录，无 mock

### 场景 2（验证 G1 + G4）：品牌类型编译期拦截

- **回溯目标**：G1（编译期根治）+ G4（mock 也区分）
- **步骤**：
  1. Phase 2 完成后，在 `ModelSelectPopover.vue` 故意写 `switchModel(sid, group.provider, ...)`（传显示名）
  2. 跑 `cd packages/renderer && npx vue-tsc --noEmit`
  3. 恢复正确代码，检查 `composer-data.ts` mock 的 id/name 是否已分开
- **通过标准**：步骤 2 tsc 报错 `string not assignable to ProviderId`（P2）；步骤 3 mock 的 `providerId` 是小写 id、`providerName` 是显示名
- **依赖**：tsc 真实编译，无 mock

### 场景 3（验证 G3）：拆分后单文件可审查

- **回溯目标**：G3（<500 行，摘 override）
- **步骤**：
  1. Phase 1 完成后 `wc -l packages/runtime/src/services/config-service.ts packages/runtime/src/infra/pi/pi-provider-store.ts`
  2. 移除 `eslint.config.mjs` 里这两个文件的 override 块
  3. `pnpm lint` + `cd packages/runtime && npx tsc --noEmit`
  4. `cd packages/runtime && npx vitest run`（config-service / pi-provider-store 专项测试）
- **通过标准**：两文件 <500 行（P3）；lint / tsc 绿；专项测试全绿（行为零变化的证据）
- **依赖**：真实 ESLint + tsc + vitest

### 场景 4（验证 G2）：reconcile 统一收口

- **回溯目标**：G2（消除分散编排）
- **步骤**：
  1. Phase 3 完成后，分别触发 5 个 provider 变更 handler（setProvider / deleteProvider / toggleProviderEnabled / removeProviderByKind / applyImportProviders）
  2. 每个 handler 触发后，抓 WS 流确认 `config.defaults` 广播恰好 1 次
- **通过标准**：5 handler 各广播 1 次（P1）；`settings-message-handler.ts` 内不再有分散的 `if (x.newDefault) broadcast(config.defaults)` 块
- **依赖**：真实 WS 流（Playwright 连 dev app port 9222 抓消息）

---

## §5 下一层拆分（实施路径）

### 实施路径：三阶段，每阶段独立可验收 / 可回滚

```
Phase 1 拆分（纯搬家）        → 验收场景 3
Phase 2 品牌类型（编译期拦截） → 验收场景 2
Phase 3 reconcile（行为收敛） → 验收场景 1 + 4
```

### Phase 1：承载文件拆分

**目标**：`config-service.ts` / `pi-provider-store.ts` 降到 <500 行，摘 override。行为零变化（纯搬家 + 单行委托，复用 `worktree-config-helper` 模式）。

**`config-service.ts` 拆分清单**（facade 退化成构造 + appConfig IO + 单行委托）：

| 抽出到 | 含方法 | 估算行数 |
|---|---|---|
| `provider-config-helper.ts` | setProvider / toggleProviderEnabled / pickEnabledDefaultModel / deleteProvider / removeProviderByKind / listProviders / listBuiltinProviders / checkEnvVars / getDefaultModel / setDefaultModel / getProvider | ~360 |
| `skill-config-helper.ts` | loadSkills / collectSkillsFromDir / pushSkillSource / scanSkills / saveSkills / upsertSkill / deleteSkill / setSkillDirs / getSkillDirs / getSkillPathScopes / migrateSettingsSkillsToDiscovery | ~155 |
| `agent-config-helper.ts` | loadAgents / saveAgents / upsertAgent / deleteAgent / getAgentDirs / getAgentPathScopes / setAgentDirs / getExtensionDirs / getExtensionPathScopes / setExtensionDirs | ~80 |
| `system-prompt-config-helper.ts` | systemPromptPath / getSystemPromptConfig / setSystemPromptConfig / getReplaceSystemPrompt | ~50 |
| `terminal-config-helper.ts` | terminalPath / getTerminalConfig / setTerminalConfig | ~40 |
| 已有 `worktree-config-helper.ts` | worktree 偏好 + auto-rename | — |
| `config-service.ts`（剩余） | 构造 + appConfig IO + import/字段注释 + ~39 个方法委托桩 | **~480-490（边缘达标 <500，余量 <20）** |

**config-service 余量与稳达方案**（审查 P0-11 核实修正）：原估 ~250 行未计入委托桩——抽出 ~39 个方法后每个需留 3-4 行委托桩（含注释），计 ~137 行，加必留的 import/字段注释/constructor/appConfig IO(63)/worktree 委托桩(57)，剩余约 480-490 行，**边缘达标且余量趋近 0**。若要稳达 <500 留 buffer，建议把 appConfig IO（loadAppConfig/saveAppConfig/appConfigPath/appConfig，63 行，是其他 helper 的依赖基础）抽成 `app-config-store.ts`，config-service 降至 ~420。**provider-config-helper 内聚性**（审查 P1-2）：helper 抽出后约 372 行，含 setProvider(~120)/listProviders(~92) 两个大方法——两者同属"provider CRUD + 双体系聚合"高内聚（共享 configStore/authStore/pi-provider-store 依赖与 ProviderInfo 构造逻辑），不再细分；若后续 setProvider 继续膨胀，可在 helper 内再拆聚合/写入子模块。

**`pi-provider-store.ts` 拆分清单**（纯函数模块，按职责分文件，store 退化成 barrel re-export 保 import 路径）：

| 抽出到 | 含函数 | 估算行数 |
|---|---|---|
| `pi-maintenance.ts` | migrateToPiSubdir / migrateDirContents / isLeakedPackage / cleanLeakedPackages | ~180 |
| `pi-provider-repair.ts` | isInvalidProvider / sanitizeInvalidProviders | ~60 |
| `pi-enabled-models.ts` | getEnabledModels / setEnabledModels / clearEnabledModels / ensureProviderInWhitelist / cleanEnabledModelsResidue | ~80 |
| `pi-skill-paths.ts` | syncSkillDirsToSettings / migrateSettingsSkillsToDiscovery / getSkillPaths / getSkillPathScopes / setSkillPaths / addSkillPath / removeSkillPath | ~135 |
| `pi-provider-store.ts`（剩余） | models.json 读写 + provider CRUD + default model 校验 + refresh + barrel re-export | ~430 |

**摩擦点**：`modelsStore` 模块级 cache（`pi-provider-store.ts` 模块顶部）被读写类函数共享——抽出的 `pi-enabled-models` 等若需访问，要么留一起（推荐：白名单/skill 路径不直接碰 modelsStore，只经 settings），要么抽共享 store 单例（与 `pi-settings-store` 对称）。`sanitizeInvalidProviders` 依赖 writeModels，暂留 store。

**验收**：场景 3。

### Phase 2：品牌类型 ProviderId

**目标**：编译期拦截 id/name 混淆，顺带修 mock。依赖 Phase 1（类型化集中在新拆分的 helper）。

**定义**（`packages/shared/src/provider.ts`）：

```ts
declare const __providerIdBrand: unique symbol
export type ProviderId = string & { readonly [__providerIdBrand]: true }
export type ModelId = string  // model id 暂不品牌化（混淆面低）
```

**改动地图**（基于调查 A 盘点）：

| 层 | 文件 | 改动 |
|---|---|---|
| shared（定义源） | `provider.ts` | `ProviderInfo.id: ProviderId`、`ModelInfo.providerId: ProviderId`；protocol.ts **第一批** 7 个 payload 类型化（`model.switch`/`config.defaults`/`config.setDefaultModel`/`config.setProvider`/`config.deleteProvider`/`config.toggleProviderEnabled`/`config.removeProviderByKind`）；quota.*/oauth* 留第二批独立任务（决策 D2） |
| runtime（生产 id 密集） | `pi-provider-store.ts`（反序列化 settings.json key / auth.json key）、`provider-catalog.ts`、`provider-importer.ts` / `provider-parser.ts`、`model-mapper.ts`、`config-service.ts`（拆分后的 `provider-config-helper.ts`）、`session-service.ts` / `session-lifecycle.ts`、`rpc-client.ts`（setModel 边界） | 工厂提升 `as ProviderId`（决策 D5）；函数签名 `provider: string` → `ProviderId`（~15-20 处） |
| renderer / core | `useModel.ts`、`api/domains/model.ts`、`model-thinking.ts`、`useNewTaskFlow.ts`（复合串切分）、`ModelSelectPopover.vue` | 签名类型化；复合串 `parts[0]` 切出后 `as ProviderId` |
| mock | `composer-data.ts` / `mock/index.ts` / `settings-data.ts` | 分开 id/name（P2 强制） |

**待验证检查点**：反序列化边界的 `as ProviderId` 是否需要加运行时 guard（决策 D5 暂不加，P5 审查 `as` 清单）。

**验收**：场景 2。

### Phase 3：reconcile helper 统一 defaultModel 维护

**目标**：5 handler 的 defaultModel 维护收口到单一 helper。依赖 Phase 1（handler 调的 service 方法已拆分稳定）+ Phase 2（getDefaultModel 返回类型已稳定）。

**helper 契约**（`settings-message-handler.ts` 内 ctx helper）：

```ts
function reconcileDefaultModelAfterProviderChange(
  ctx: SettingsHandlerContext,
  existingNewDefault?: { provider: ProviderId; modelId: ModelId },
): void {
  const dm = existingNewDefault ?? ctx.configService.getDefaultModel()
  if (!dm) return
  ctx.broadcast({
    type: 'config.defaults',
    id: ctx.nextPushId(),
    payload: { defaultModel: `${dm.provider}/${dm.modelId}`, source: 'provider-change' },
  })
}
```

**5 handler 收口方式**：

| handler | 收口前 | 收口后 |
|---|---|---|
| setProvider / deleteProvider / toggleProviderEnabled / removeProviderByKind | `if (result.newDefault) broadcast(config.defaults)` | `reconcile(ctx, result.newDefault)` |
| applyImportProviders | `getDefaultModel() + broadcast(config.defaults)` 兜底 | `reconcile(ctx)`（不传 → 自动兜底） |

`broadcastProviderList` 各 handler 保留（语义正交，决策 D3）。

**验收**：场景 1 + 场景 4（P1 探针实测无双重广播）。

---

## 附录 A：与 provider 双体系聚合架构的关系

本设计是 [provider 双体系聚合架构](provider-config-pi-alignment.md)（slice + 5 wave，已交付）之上的**加固层**，不改动聚合架构的设计决策（catalog/custom 分体系、enabledModels 承载 enable、catalog 移除清凭据不删定义）。三道加固针对的是聚合架构交付后实测发现的两个 bug（§2.1 §2.2）+ 结构债（§2.3），与聚合层设计正确性无关。
