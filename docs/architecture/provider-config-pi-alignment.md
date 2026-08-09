# provider 配置体系对齐 pi：分体系处理（catalog 内置 vs models.json 自定义）

> **结论**：pi 有两套独立的 provider 体系——**catalog provider**（定义来自 pi 内置 catalog，秘钥走 auth.json/env）和**自定义 provider**（models.json 全配置含 apiKey）。xyz-agent 的错位是把 catalog provider 当成自定义 provider 处理（秘钥写进 models.json 定义层）。本文给出分体系对齐方案：importer/config-service 按「providerId 是否在 catalog」分路——catalog provider 秘钥归 auth.json 不建 models.json 条目；自定义 provider 保持 models.json 全配置含 apiKey。

---

## §1 背景目标

- **S（情境）**：xyz-agent 底层是 pi，每个 session 独立 spawn 一个 pi 子进程，经 `PI_CODING_AGENT_DIR` 把 pi 配置根指向 `<dataDir>/pi/agent/`。pi 有两套独立的 provider 体系（源码审计证实，见 §2.2）：catalog provider（定义来自 pi 内置 catalog，秘钥走 auth.json/env/`--api-key`）和自定义 provider（models.json 全配置含 apiKey）。
- **C（冲突）**：xyz-agent 没有区分这两套体系，把所有 provider 当成「models.json 全配置」处理——导入 pi 的 catalog provider（如 zai-coding-cn）时，用模板补了一个残缺定义（name/api/baseUrl + apiKey 明文）塞进 models.json，而非把秘钥对等写 auth.json。这破坏了 catalog provider「定义靠 catalog、秘钥靠 auth.json」的正交关系，导致「能选不能用」。
- **Q（问题）**：怎么让 xyz-agent 的 provider 处理对齐 pi 的两套体系，做到「catalog provider 秘钥归 auth.json、自定义 provider 全配置留 models.json、能选就能用」？
- **A（答案）**：importer 和 config-service 按「providerId 是否在 catalog」分路：catalog provider → 秘钥写 auth.json，models.json 不建条目（pi catalog 提供定义）；自定义 provider → models.json 全配置含 apiKey，对等复制。配套 AuthStorage 扩展 api_key 类型 + getDefaultModel 认知 catalog。

### 系统是什么

xyz-agent 的 provider 配置体系由三部分组成：

1. **数据文件**（`<dataDir>/pi/agent/` 下）：`models.json`（自定义 provider 定义 + catalog provider override）、`auth.json`（秘钥，当前仅 OAuth）、`settings.json`（默认 provider/model）。这些既是 xyz-agent runtime 读写对象，也是 pi 子进程的配置源。
2. **runtime 读写层**（`packages/runtime/src/`）：`config-service.ts`（setProvider/listProviders/getDefaultModel）、`infra/pi/pi-provider-store.ts`（读写 models.json）、`services/auth/auth-storage.ts`（读写 auth.json）、`services/migration/provider-importer.ts`（导入）。
3. **pi 子进程**：per-session 独立进程，启动时加载 catalog（内置 35 个 provider 定义）+ models.json（自定义/override）+ auth.json（秘钥）到 ModelRegistry。

### 设计目标（从使用者体验倒推）

| # | 使用者要能做到 | 现状 |
|---|---|---|
| G1 | 从 pi 导入 catalog provider 后，composer 能选该模型 **且** create 能成功用 | ❌ 能选不能 create（用户报告的 bug） |
| G2 | catalog provider 秘钥归 auth.json（0600），不与定义层混杂 | ❌ catalog provider 秘钥被写进 models.json 定义层（0644 明文） |
| G3 | 自定义 provider（router/Ollama 等）的 models.json 全配置（含 apiKey + models）保持不变 | ⚠️ 现状自定义 provider 在 models.json 是对的，但导入路径可能误改 |
| G4 | pi 原生秘钥形态（`$ENV`/`!cmd`）正确保留并生效 | ⚠️ pi-parser 保留形态，但落盘层可能错（catalog provider 应进 auth.json） |

### scope

- **in-scope**：分体系处理（catalog vs 自定义）——importer 分路 + config-service.setProvider 分路 + AuthStorage 扩展 api_key + getDefaultModel 认知 catalog + 存量迁移（分体系）。
- **out-of-scope**：
  - 孤儿配置清理（config.toml / model-db.json / config.json 的 providers 字段）——独立前置任务。
  - 已有 session 配置生效时序（软重启/提示）——正交维度，独立设计。
  - models-store.json 等价物（远程 catalog 动态刷新）——P1 增强。
  - pi 层 env var 张力（§2.5 风险点 R1）——pi 源码不改，仅标注待实测。
  - pi 源码改动——架构约定禁止。

**本次设计当前层 → 下一层**：当前层 = 配置对齐源码审计结论；下一层 = 可实现的接口/数据模型/技术方案（importer/config-service/AuthStorage 改造）。属技术方案设计。

---

## §2 现状与问题分析

### 2.1 使用者视角：一次真实的「能选不能用」

用户在 Settings → 从其他 agent 导入，选中 pi 的 `zai-coding-cn`（pi 的 `~/.pi/agent/auth.json` 有 `{type:"api_key", key:"a275..."}`，pi 的 models.json 无该 provider——定义在 pi catalog）。导入完成后：

```
[composer 模型列表] zai-coding-cn / glm-5.2  ✅ 出现（可选中）
[用户点新建会话，选中 glm-5.2]
→ create 报错：No model configured（无法创建会话）
```

**为什么能选**：`listProviders()`（`config-service.ts:182`）当 provider 的 `models[]` 为空时，用 xyz-agent 的 `builtin-providers.json` 副本兜底显示（`:219`，`models: userModels.length > 0 ? ... : builtinModelsById...`）。

**为什么不能用**：`getDefaultModel()`（`config-service.ts:174`）委托 `findValidDefaultModel`，只遍历 models.json 找有 models 数组的 provider，不兜底 catalog → 返回 null → create 守卫失败。导入的 zai-coding-cn 按 B4 铁律只写了模板定义 + apiKey，**没写 models 数组**（`provider-importer.ts:251-258`）。

**根因**：importer 把 catalog provider（zai-coding-cn）当成了自定义 provider——补了一个 models.json 残缺定义（无 models 数组）。而 pi 的正道是：catalog provider 定义来自 catalog（无条件加载），秘钥写 auth.json，models.json 不需要条目。

### 2.2 pi 的两套 provider 体系（源码审计权威）

> 以下结论基于 pi-mono main 分支源码（`/Users/zhushanwen/GitApp/pi-ecosystem/pi-mono`），每条附源码文件:行号。

**体系 A · catalog provider = pi 内置 catalog（定义）+ auth.json/env（秘钥）**

- catalog 由 `models.generated.ts`（构建产物，源是各 `*.models.ts`）聚合，经 `all.ts:56 getBuiltinProviders()` / `compat.ts:63 getProviders`（= getBuiltinProviders 别名）暴露。当前 35 个 provider（anthropic/openai/deepseek/zai-coding-cn/...）。
- 每个 catalog provider 的 baseUrl/api/models **声明时写死**（如 `packages/ai/src/providers/anthropic.ts:11` baseUrl 是 string literal），运行时只可经 models.json override baseUrl/compat（`model-registry.ts:462-468`，loadBuiltInModels 内 providerOverride 应用块）。
- **秘钥归宿**：auth.json（`/login` 写入，pi `auth-storage.ts`）/ 环境变量（`packages/ai/src/env-api-keys.ts:65 getApiKeyEnvVars` 硬编码 provider→env-var 表，如 zai-coding-cn→`ZAI_CODING_CN_API_KEY` @ `:88`）/ `--api-key` runtime override。

> **同名文件歧义提示**：pi 与 xyz-agent 都有 `auth-storage.ts`。本文 pi 契约引用标 `pi auth-storage.ts`，xyz-agent 自身代码引用标 `xyz auth-storage.ts`。其余文件名（model-registry.ts/sdk.ts/all.ts/compat.ts/env-api-keys.ts 仅 pi 有；config-service.ts/provider-importer.ts/pi-provider-store.ts 仅 xyz 有）无歧义。
- **用户不在 models.json 建条目**（除非 override，如走代理只写 baseUrl）。

**体系 B · 自定义 provider = models.json 全配置**

- models.json 定义一切：`{baseUrl, api, apiKey, models, compat, ...}`（`ProviderConfigSchema`，`model-registry.ts:222-232`）。
- 用于 Ollama/LM Studio/vLLM/代理/任何兼容服务（pi docs/models.md 全部示例如此）。
- **apiKey 留 models.json 是合法且推荐的归宿**：`storeProviderRequestConfig`（`:700`）存入 `providerRequestConfigs`，请求时 `getApiKeyAndHeaders`（`:731`）作 fallback 秘钥解析——`apiKeyFromAuthStorage ?? providerConfig?.apiKey`（`:737-740`；authStorage 侧用 `includeFallback:false` 不回退 env @ `:735`）。

**两套体系的判据（唯一）**：providerId 是否在 `getProviders()`（pi catalog）。`validateConfig`（`model-registry.ts:561`）用 `builtInProviders.has(providerName)` 判定（`:565`）。

**定义合并完全不碰凭据**：`ModelRegistry.loadModels`（`:421`）合并 catalog + models.json + extension 三层定义（baseUrl/api/models/compat），apiKey 单独存在 `providerRequestConfigs`，**请求时才解析**（`:731` getApiKeyAndHeaders）。

### 2.3 物理数据流：现状（catalog provider 被错位转换）

```
[导入源 pi: ~/.pi/agent/]
  auth.json  ─┐  {zai-coding-cn: {type:api_key, key:"a275..."}}   ← 体系 A 秘钥层
  models.json └─ {} （定义在 catalog）                              ← 体系 A 无需条目
              │
              ▼  provider-importer.ts（pi-parser 合并 → classifyCredential 提取 apiKey）
[parsed: ParsedProvider {name, api, baseUrl, apiKey:"a275...", _credentialType:plaintext}]
              │  ← 错误：把体系 A 的 catalog provider 当成体系 B 自定义 provider
              ▼  matchBuiltinTemplate + upsertProvider（组2 :242-258）
[xyz-agent: <dataDir>/pi/agent/models.json]
  providers.zai-coding-cn = { name, api, baseUrl, apiKey:"a275..."(明文) }  ← 残缺自定义形态
                                                ❌ 无 models 数组（catalog 本应提供，但 xyz-agent 不知道）
[xyz-agent: <dataDir>/pi/agent/auth.json]
  {}  ← 秘钥未对等写入

[pi 子进程启动] 读 models.json（zai-coding-cn 条目：name/api/baseUrl/apiKey，**无 models 数组**）+ 读 catalog（zai-coding-cn 完整定义含 glm-5.2）
  → 空模型的 models.json 条目**不产生 custom model**：loadCustomModels（`:506`）的 parseModels（`:608`）对 `models:[]` 内层 for 不执行，贡献 0 个 Model
  → mergeCustomModels（`:493`，按 provider+id 替换）无对应 custom model 可替换 → **catalog 的 glm-5.2 完整保留、未被覆盖**（JSDoc「custom wins on conflicts」@ `:492` 仅对实际存在的 custom model 生效）
  → 该条目的实际副作用：apiKey 进 providerRequestConfigs 作 fallback（秘钥错位，本应 auth.json）；baseUrl 经 loadBuiltInModels（`:462-468`）作 override（模板 baseUrl 即 catalog baseUrl，实质 no-op）
  → listProviders（xyz-agent）：用 builtin-providers.json 副本兜底显示 glm-5.2 ✅
  → getDefaultModel（xyz-agent）：只扫 models.json 有 models[] 数组的 provider，不咨询 catalog → zai-coding-cn 无 models[] → null → create 失败 ❌（单一断裂 F2）
```

**单一断裂（F2）**：功能不可用的根因是 getDefaultModel 不咨询 catalog（§2.1）。空模型的 models.json 条目**不删除/不覆盖** catalog 的 model——`loadCustomModels`（`:506`）对 `models:[]` 贡献 0 个 custom model，`mergeCustomModels`（`:493`，按 provider+id 替换）无对应项可替换，catalog 的 glm-5.2 在 pi 侧完整可用。错位条目的实际副作用是 F1/F3：apiKey 错进 models.json（0644 明文，本应 auth.json 0600）+ baseUrl override 污染（`storeProviderRequestConfig`），均**非** catalog 失效。功能修复归因到决策4（getDefaultModel 兜底 catalog）+ 秘钥归位（auth.json），**无需「防 catalog 被覆盖」防御代码**。

### 2.4 终态数据流：分体系对齐

```
[导入源 pi]
  catalog provider（zai-coding-cn）：auth.json 有秘钥 + models.json 无条目
  自定义 provider（router）：models.json 全配置含 apiKey
              │
              ▼  importer 分路（判据：providerId ∈ getProviders()）
  ┌─────────── catalog provider ───────────┐   ┌───── 自定义 provider ─────┐
  │ 秘钥 → auth.json {id:{type:api_key,key}}│   │ models.json 全配置对等复制 │
  │ models.json 不建条目（catalog 提供定义） │   │ （含 apiKey + models）     │
  └─────────────────────────────────────────┘   └────────────────────────────┘
              │
              ▼  pi 子进程
  catalog provider：catalog 定义 + auth.json 秘钥 → 完整可用 ✅
  自定义 provider：models.json 全配置 → 完整可用 ✅
  → listProviders / getDefaultModel 都认知 catalog → 能选也能用 ✅
```

### 2.5 根因与失败模式

| 层面 | 表现 | 代码位置 |
|---|---|---|
| 导入层 | importer 不区分 catalog/自定义，catalog provider 秘钥错位进 models.json（0644 明文）+ baseUrl override 污染（空 models 条目不覆盖 catalog，见 §2.3） | `provider-importer.ts:242-258`（组2）、`:214-215`（组1） |
| 接口层 | AuthStorage 只认 oauth，catalog provider 的 api_key 秘钥无容器 | xyz `auth-storage.ts:25` OAuthCredential |
| 判定层 | getDefaultModel 不兜底 catalog（listProviders 兜底显示） | `config-service.ts:174` vs `:219` |
| 数据层 | catalog provider 秘钥散落（models.json 明文 + 孤儿 config.json/config.toml） | 见 §4 前置清理 |

**三大失败模式**：
- **F1 catalog provider 错位转换**：importer 把体系 A 的 catalog provider 转成体系 B 的 override-only 残缺条目（秘钥错进 models.json + baseUrl override 污染；空 models 数组**不覆盖** catalog，见 §2.3）。
- **F2 能选不能用**：getDefaultModel 不兜底 catalog（§2.1）。
- **F3 catalog provider 秘钥散落**：本应在 auth.json（0600），实进 models.json（0644 明文）+ 孤儿文件。

**风险点（pi 层，标注不修）**：
- **R1 env var 张力**：pi 源码审计发现 `/model` 列表用 `hasAuth`（查 env var，pi `auth-storage.ts:355`），complete 用 `getApiKeyAndHeaders(includeFallback:false)`（不查 env var，`model-registry.ts:735`）→ 纯 env var 模式可能「显示可用但 complete throw」。此点与 `args.ts:240` 文档措辞（「--api-key defaults to env var」）有张力。**待实测**（⛔ 探针 P-envvar-complete）：设 `ZAI_CODING_CN_API_KEY` 不 /login、不配 models.json apiKey，跑 pi complete 看是否 throw。本设计不修 pi 源码，若实测确认是 pi bug，记录并绕过（xyz-agent 的 catalog provider 秘钥走 auth.json 不走纯 env var，不踩此坑）。

---

## §3 解决方案

### 3.1 终态（使用者视角）

**成功路径 · 导入 catalog provider**：

```
[用户] Settings → 从其他 agent 导入 → 选 zai-coding-cn
[importer 分路] providerId "zai-coding-cn" ∈ catalog（getProviders）→ 走 catalog 分支
  - 秘钥 → auth.json 写 {zai-coding-cn: {type:"api_key", key:"a275..."}}（0600，保留原形态）
  - models.json 不建条目（pi catalog 提供 baseUrl/api/models 定义）
[导入完成] composer 显示 zai-coding-cn / glm-5.2（pi catalog 定义）
[用户] 选中 → 新建会话
[create 守卫] getDefaultModel 认知 catalog → 返回 zai-coding-cn/glm-5.2 ✅
[会话] pi 读 catalog（定义）+ auth.json（秘钥）→ glm-5.2 可用 ✅
```

**成功路径 · 导入自定义 provider**：

```
[用户] 导入 pi 的 router provider（providerId 不在 catalog，pi models.json 有完整定义含 apiKey）
[importer 分路] providerId "router" ∉ catalog → 走自定义分支
  - models.json 全配置对等复制 {name, baseUrl, api, apiKey:"...", models:[...]}（apiKey 留 models.json）
  - auth.json 不动
[结果] 自定义 provider 行为与 pi 源一致 ✅
```

**成功路径 · 手动配置 catalog provider 秘钥（Settings 选内置模板）**：

```
[用户] Settings → 添加供应商 → 选 anthropic（内置模板=catalog provider）→ 填 API Key → 保存
[config-service.setProvider 分路] anthropic ∈ catalog → 走 catalog 分支
  - 秘钥 → auth.json 写 {anthropic: {type:"api_key", key:"sk-ant-..."}}（0600）
  - models.json 不建条目（除非用户改了 baseUrl 走代理→override-only 条目）
[结果] 等价于 pi 的 /login anthropic ✅
```

**失败路径 · catalog 判据查询失败（带恢复指引）**：

```
[importer] 查询 providerId 是否在 catalog 失败（pi 子进程未启动 + 副本未就绪）
[降级] 走「保守判定为自定义 provider」→ models.json 全配置（含 apiKey + 补 models）
[提示] warn: catalog membership unknown for <id>, treated as custom provider
[恢复] pi 子进程启动后用户可重新导入，或手动到 Settings 改配（删 models.json 条目 + auth.json 配秘钥）
```

### 3.2 多方案对比（准则 9，强制）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 分体系处理**（importer + setProvider 按 catalog 判据分路 + AuthStorage 扩展 api_key + getDefaultModel 认知 catalog + 存量迁移分体系） | ✅ 完全对齐 pi 两套体系，catalog/自定义各归其位，消除 F1/F2/F3 | 高（importer 分路 + setProvider 分路 + AuthStorage 扩展 + catalog 判据来源 + 迁移 + 测试，约 5-7 wave） | 中（catalog 判据来源需选型；catalog provider 秘钥改写 auth.json 需跨进程锁，已有 proper-lockfile） | ✅ **推荐** |
| **B. 只修 importer 分路 + catalog 兜底**（不动 setProvider/UI，AuthStorage 不扩展——catalog provider 秘钥仍只能进 models.json 或走 OAuth） | ⚠️ importer 对了但 setProvider 仍把 catalog provider 秘钥写 models.json（手动配置路径未修），F3 部分残留 | 中（importer + catalog 兜底，3 wave） | 高（两套秘钥写入路径并存：导入走 auth.json、手动走 models.json，长期分叉） | ❌ |
| **C. 最小修复**（只修 getDefaultModel 兜底 catalog + 清孤儿，不碰 importer/秘钥分层） | ❌ 不解决 F1/F3，只让 F2 的「能用」凑效，秘钥仍错位 | 低（1 wave） | 低 | ❌（紧急止血） |

**推荐方案 A**。理由：F1/F2/F3 同源（不分体系），A 一次性消除；B 的「导入/手动两套秘钥路径」会在未来每次 provider 改动制造分叉；C 只是藏 bug。

**若用方案 B，§3.1 的终态**：导入路径 catalog provider 秘钥归 auth.json，但用户手动在 Settings 选内置模板配秘钥仍写 models.json——同一 catalog provider 秘钥可能同时在 auth.json（导入）和 models.json（手动），且手动路径仍 0644 明文。G2 达不到。

**若用方案 C，§3.1 的终态**：能选也能用（F2 修），但 catalog provider 秘钥仍错位散落（F1/F3），只是 bug 表面消失。

### 3.3 关键决策与权衡

#### 决策 1：importer 分路（catalog 判据）

- **选择**：provider-importer.applyImport 按「providerId ∈ catalog」分路：
  - **catalog 分支**：秘钥写 auth.json（经 AuthStorage.set，保留 `$ENV`/`!cmd` 原形态），models.json 不建条目
  - **自定义分支**：models.json 全配置对等复制（含 apiKey + models），auth.json 不动
- **pi-parser 形态保留已具备**：classifyCredential 对 plaintext/env/command 三态保留原形态（非新增工作），分路只决定保留的形态回写 auth.json 还是 models.json。env-bundle/oauth Phase2 是独立增量。
- **被否**：不分路（现状，全走 models.json）——F1 根因。
- **证据**：pi 源码 `validateConfig`（`model-registry.ts:561`，`builtInProviders.has()` @ `:565`）区分两套体系；catalog provider 定义来自 catalog（`getProviders`/`getModels`），无需 models.json 条目。

#### 决策 2：AuthStorage 扩展 api_key（catalog provider 秘钥归宿）

- **选择**：Credential 联合类型从 xyz OAuthCredential（`xyz auth-storage.ts:25`）扩展为 `ApiKeyCredential | OAuthCredential`，对齐 pi auth.json schema：
  ```ts
  interface ApiKeyCredential { type:'api_key'; key:string; env?:Record<string,string> }
  interface OAuthCredential { type:'oauth'; access:string; refresh?:string; expires:number }
  type Credential = ApiKeyCredential | OAuthCredential
  ```
  配套新增 `hasCredentialSync(providerId)`（判 auth.json 有任意 type 条目，替代 listProviders 当前读 models.json apiKey 判定）。
- **用途收窄**：只服务 catalog provider 的 api_key 秘钥（决策1 catalog 分支写入）。自定义 provider 秘钥仍走 models.json（决策1 自定义分支）。
- **被否**：维持 oauth-only——catalog provider 的 api_key 无容器，决策1 catalog 分支无处写。
- **证据**：pi `auth.json` 实际文件 6 个凭据全是 api_key（`~/.pi/agent/auth.json`）；pi 源码 `ApiKeyCredential`（pi `auth-storage.ts:24-28`）。

#### 决策 3：config-service.setProvider 分体系

- **选择**：setProvider 按「选中模板/providerId ∈ catalog」分路：
  - **catalog provider**（用户选内置模板，如 ProviderTemplatePicker 选 anthropic）：秘钥写 auth.json，models.json 不建条目（除非用户改 baseUrl 走代理→override-only 条目 `{providers:{id:{baseUrl}}}`）
  - **自定义 provider**（用户新建，providerId 不在 catalog）：models.json 全配置（baseUrl/api/apiKey/models）
- **ConfigService 注入类型扩展**：当前 `Pick<AuthStorage,'remove'|'hasOAuth'|'hasOAuthSync'>`（`config-service.ts:169`）需加 `set`/`hasCredentialSync`（决策2 新增）。
- **空 apiKey 守卫（防 MF-1 回归）**：catalog 分支在 apiKey 为空/undefined 时不调 AuthStorage.set（沿用 MF-1 守卫 `data.apiKey !== undefined && data.apiKey !== ''`），避免空值覆盖已有 OAuth。
- **I9 清理简化**：catalog 分支秘钥改走 auth.json 后，「保存 API Key 清 OAuth」（`config-service.ts:281` I9 清理①）改为同层覆盖语义（api_key 覆盖 oauth），不再主动 remove。
- **被否**：setProvider 不分路（现状全写 models.json）——手动配置路径仍错位。
- **证据**：pi `/login <provider>` 就是给 catalog provider 配秘钥写 auth.json（`interactive-mode.ts:5136` `authStorage.set`），xyz-agent 手动配置应等价。

#### 决策 4：catalog 兜底对称化（修 F2）

- **选择**：`findValidDefaultModel`（`pi-provider-store.ts`）增加 catalog 兜底——models.json 无可用 provider 时，查 catalog（builtin-providers.json 副本或 RPC 查 pi 子进程 getProviders/getModels）找有定义的 provider 作默认候选，且校验该 provider 有可解析秘钥（auth.json/env/models.json apiKey 任一）。
- **与 MF-5 的分工**：pi-provider-store 已有 MF-5（`sanitizeInvalidProviders` 启动时对五字段全空壳合并 catalog models 修复）。决策4 是查询时兜底判定（不写数据）。MF-5 修复后的 provider 已有 models，正常命中；决策4 兜底分支服务 MF-5 未覆盖的（如有 baseUrl 的非空壳但无 models 的导入 provider）。
- **被否**：不兜底（现状）——F2 持续。
- **证据**：pi `hasConfiguredAuth`（`model-registry.ts:688`）= hasAuth OR models.json apiKey configured，是可用性判定标准；xyz-agent 的 getDefaultModel 应对齐此判定。

#### 决策 5：catalog 判据来源（选型）

- **选择**：**xyz-agent 自维护的 `builtin-providers.json` 副本**（已有，编译期 import）作为 catalog 判据。判据 = `builtinProviders.some(p => p.id === providerId)`。
- **被否 A**：RPC 查 pi 子进程 `getProviders`——pi 子进程可能未启动（离线导入场景），且每次导入 RPC 往返成本高。
- **被否 B**：读 pi `models.generated.ts`——编译期 import 需 pi 版本对齐，xyz-agent 升 pi 版本时要同步。
- **权衡**：副本可能与 pi 子进程 catalog 版本不同步（pi 升级新增 provider，副本滞后）。副本只用于「判据 + UI 展示」，**不作为运行时定义来源**（定义权威是 pi 子进程 catalog）。
- **滞后后果（已核实 importer，非「功能不坏」）**：新 catalog provider 以孤儿凭据形态（源 auth.json 有秘钥、源 models.json 无条目）导入时，importer 组2（`provider-importer.ts:242-245`）需 `matchBuiltinTemplate` 命中副本才能合成 `{name,api,baseUrl}` 定义；副本滞后 → 模板缺失 → 推 `status:'failed'`（reason: no built-in template match），**导入失败**。孤儿凭据只有 `{providerId, apiKey}`、无源定义可「全配置复制」，故**不存在**「走 models.json 全配置」的降级路径。决策1 分路侧同理：副本滞后时新 catalog provider 被误判为自定义分支，但其源 models.json 也无条目可写，最终仍不可导入。
- **强制缓解**：副本同步是 pi 升级的**显式必经步骤**——刷新 `builtin-providers.json` 副本 + 回归测试断言副本 id 全集 ⊇ pi `getProviders()` 全集，不得依赖「升级后顺手更新」。滞后窗口内新 catalog provider 在 xyz-agent 侧不可导入（pi 升级刷新副本后恢复）。
- **选型张力（如实标注）**：此后果使「静态副本」的离线可用性优势打折——副本缺失时连「降级导入」都做不到。若未来新 catalog provider 的及时可用性成为硬需求，应重评「被否 A（RPC 查 pi 子进程 getProviders）」：接受 pi 子进程未启动时的离线失败（与副本滞后同效），但 pi 在线时判据始终准确、无需手动同步副本。当前维持静态副本选型，以副本同步纪律兜底。
- **证据**：`provider-importer.ts:245`（模板缺失 → failed）；源码审计组6.4——builtin-providers.json 副本的角色是 UI 展示/判据，非运行时定义权威。

#### 决策 6：存量迁移（分体系）

- **选择**：启动时幂等迁移，按 catalog 判据分体系：
  - **catalog provider 的错位 apiKey**（models.json 有 catalog providerId 条目且含 apiKey）→ 秘钥迁 auth.json，**删除整个 models.json 条目**（移除 0644 明文 apiKey + override 污染；空 models 条目本就不覆盖 catalog，见 §2.3，删除是为秘钥归位**非**「修复覆盖」）。若该条目有 override（baseUrl/compat）→ 保留 override-only 条目，只删 apiKey。
  - **自定义 provider 的 apiKey**（providerId 不在 catalog）→ **不动**（models.json 是合法归宿）。
- **OAuth 冲突优先**：catalog provider 迁移时若 auth.json 已有 OAuth → OAuth 优先，跳过迁移，warn。
- **已有 session 时序（如实标注，无文件监听）**：迁移在启动期完成。pi 的 `AuthStorage` **无文件监听/周期重读/per-request 重读**——`reload()`（pi `auth-storage.ts:259`）仅在构造（`:212`）、`persistProviderChange` 写盘分支（`:276`）、OAuth 刷新失败分支（`:506`）三处调用；`grep "getFileRevision\|fileRevision" packages/` 0 命中，本文档前述「auth.json 经 getFileRevision 动态重读」**系编造，已删除**。故迁移安全**仅当迁移先于 session spawn 完成**：迁移若在已有 session 的 pi 子进程构造之后写 auth.json，该 session 的 AuthStorage 不会感知新秘钥（直到其自身 persist/OAuth 刷新触发 reload）。models.json 删条目同理：旧 session 内存快照的 override-only 条目仍在，需新建/恢复 session 才完全对齐。**结论**：已有 session 的秘钥改动**不自动生效**，与 models.json 侧同等对待——属 out-of-scope 的生效时序问题，迁移日志应提示用户重启 session。
- **被否**：不迁移——老用户 catalog provider 永久错位。
- **错误恢复**：迁移失败不阻断启动，warn + 下次重试。

#### 运行时行为断言探针清单（准则 7）

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-modelskey | models.json apiKey 对自定义 provider 是合法秘钥归宿 | pi 源码 `model-registry.ts:225/700/737-740`（apiKey Optional + storeProviderRequestConfig + getApiKeyAndHeaders fallback） | ✅ 已验证（源码审计） |
| P-catalog-avail | catalog provider 不建 models.json 条目时 pi 判可用 | pi 源码 `model-registry.ts:688 hasConfiguredAuth` + pi `auth-storage.ts:355 hasAuth`（查 auth.json/env/runtime） | ✅ 已验证（源码审计） |
| P-resolve-trigger | 凭据解析在请求时触发（非加载时） | pi 源码 `sdk.ts:302 streamFn` → `getApiKeyAndHeaders`（`model-registry.ts:731`）每次 complete 调 | ✅ 已验证（源码审计） |
| P-envvar-complete | 纯 env var（无 auth.json/无 models.json apiKey）能否 complete（R1 风险点） | 设 `ZAI_CODING_CN_API_KEY`，不 /login、不配 models.json apiKey，跑 pi complete，观察是否 throw（源码路径分析说 throw，文档措辞说能） | ⛔ 实施前门（决定 xyz-agent 是否允许纯 env var 配秘钥） |
| P-write-auth | xyz-agent 写 auth.json api_key 类型后 pi 子进程正确解析 | 实施后写 auth.json `{id:{type:api_key,key:"test"}}`，启动 session 发 prompt 验证 200 | ⛔ 实施期门（wave 2 后） |
| P-importer-split | importer 分路后 catalog provider 进 auth.json、自定义 provider 进 models.json | 实施后导入 pi 的 zai-coding-cn（catalog）+ router（自定义），断言前者 auth.json 有秘钥+models.json 无条目、后者 models.json 全配置 | ⛔ 实施期门（importer wave） |
| P-migrate | 存量迁移分体系：catalog provider 条目删除+秘钥迁 auth.json，自定义 provider 不动 | 实施后造 models.json 含 catalog provider 残缺条目 + 自定义 provider 条目，跑迁移，断言前者清理后者保留 | ⛔ 实施期门（迁移 wave） |

---

## §4 下一层拆分

### 4.1 实施路径（阶段化）

```
[前置 P0]  清理孤儿配置（config.toml / model-db.json / config.json providers 字段）
           └─ 独立 commit，消除 0644 明文安全负债

[阶段 1]   AuthStorage 扩展 api_key + hasCredentialSync
           └─ Credential 联合类型 + set/get 泛化 + 跨进程锁复用
           └─ 验证：P-write-auth 探针

[阶段 2]   importer 分路（catalog 判据）
           └─ applyImport 按 providerId ∈ builtin-providers 分路 + catalog 分支写 auth.json + 自定义分支全配置
           └─ 验证：P-importer-split 探针

[阶段 3]   config-service.setProvider 分体系
           └─ catalog 分支写 auth.json + 自定义分支写 models.json + 注入类型扩展 + 空 apiKey 守卫 + I9 简化
           └─ 验证：手动配 catalog provider 秘钥进 auth.json，自定义 provider 进 models.json

[阶段 4]   getDefaultModel 认知 catalog
           └─ findValidDefaultModel 加 catalog 兜底 + 秘钥可解析校验 + 与 MF-5 分工
           └─ 验证：导入 catalog provider 后 getDefaultModel 非 null，create 成功（F2 修复）

[阶段 5]   存量迁移（分体系）
           └─ catalog provider 错位条目清理 + 秘钥迁 auth.json + 自定义 provider 不动 + OAuth 冲突优先
           └─ 验证：P-migrate 探针

[前置门]   P-envvar-complete 探针（阶段 2 前跑，决定是否允许纯 env var 配秘钥）
```

### 4.2 下一层单元拆分清单 + justification

| 单元 | 改动 | justification |
|---|---|---|
| AuthStorage 类型扩展 + hasCredentialSync | `auth-storage.ts` Credential 联合类型 + api_key 支持 + 新增 hasCredentialSync | 接口层，catalog 分支写入依赖；hasCredentialSync 供 listProviders 替代读 models.json apiKey |
| AuthStorage 写入测试 | api_key 读写 + 多态 key 保留 + 锁竞争 | 安全关键，TDD |
| catalog 判据工具 | 新增 `isCatalogProvider(providerId)` 基于 builtin-providers.json | 决策5 选型，importer/setProvider/迁移共用判据 |
| importer 分路 | `provider-importer.ts` applyImport catalog/自定义分支 + 组1/组2 都按判据分路 | F1 根因修复 |
| importer env-bundle/oauth Phase2 | pi-parser 提取 env-bundle/oauth + 回写 auth.json | G4 增量（plaintext/env/command 已保留） |
| config-service.setProvider 分体系 | catalog→auth.json / 自定义→models.json + 注入类型加 set/hasCredentialSync + 空 apiKey 守卫 + I9 简化 | 手动配置路径对齐，依赖 AuthStorage + 判据工具 |
| config-service.listProviders 凭据判定 | hasOAuthSync 改 hasCredentialSync | 与 setProvider 配套 |
| findValidDefaultModel catalog 兜底 | pi-provider-store.ts 加 catalog 候选 + 秘钥校验 + MF-5 分工 | F2 修复（G1） |
| 存量迁移（分体系） | 启动迁移：catalog provider 清理+秘钥迁 auth.json，自定义不动 | 老用户升级修复 F1 |
| 迁移测试 | 分体系幂等 + OAuth 冲突优先 + 边界 | 数据安全关键 |

### 4.3 文件改动地图

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `packages/runtime/src/services/auth/auth-storage.ts` | 改写 | Credential 联合类型（:25）+ api_key 支持 + 新增 hasCredentialSync |
| `packages/runtime/src/services/migration/provider-importer.ts` | 改写 | applyImport 分路 + 组1（:214）/组2（:257）按判据分路 |
| `packages/runtime/src/services/migration/parsers/pi-parser.ts` | 改 | env-bundle/oauth Phase2 提取 |
| `packages/runtime/src/services/config-service.ts` | 改 | setProvider（:264）分体系 + 注入类型（:169）加 set/hasCredentialSync + listProviders（:214）改 + I9（:281）简化 |
| `packages/runtime/src/infra/pi/pi-provider-store.ts` | 改 | findValidDefaultModel catalog 兜底（与 MF-5 分工） |
| 新增 `packages/runtime/src/services/provider-catalog.ts`（或复用现有 builtin-providers 加载） | 新增 | isCatalogProvider 判据工具 |
| `packages/runtime/src/index.ts` | 改 | 启动迁移编排（分体系） |
| `packages/runtime/src/services/auth/__tests__/*.test.ts` | 新增/改 | api_key 测试 + hasCredentialSync + 迁移分体系测试 |
| `packages/runtime/src/services/__tests__/config-service.test.ts` | 改 | setProvider 分体系契约 + 空 apiKey 守卫 |

### 4.4 待验证检查点

- ⛔ **P-envvar-complete（实施前门）**：纯 env var 能否 complete（R1 风险）。若 throw，xyz-agent 的 catalog provider 秘钥必须走 auth.json（本设计默认路径，不踩坑）；若能，xyz-agent 可额外支持 env var 配秘钥。**阶段 2 前必跑**。
- ⛔ **catalog 判据副本同步**：builtin-providers.json 副本与 pi 子进程 catalog 版本同步策略（pi 升级时如何更新副本）。
- ⛔ **迁移对已有 session 的残缺定义影响**：存量迁移删 models.json 的 catalog provider 条目后，已有 session 内存快照仍有残缺定义——需新建/恢复 session 才完全修复。属生效时序（out-of-scope），但迁移日志应提示用户。

---

## 附录：与 pi 源码的契约边界

本设计所有改动在 xyz-agent 侧，依赖但不修改 pi 的以下契约（pi-mono main @ b084d2fb）：

| pi 契约 | 内容（源码证据） | xyz-agent 依赖方式 |
|---|---|---|
| `PI_CODING_AGENT_DIR` | pi 配置根（rpc-client.ts:134 注入） | pi 读 `<dir>/auth.json`/`models.json` |
| 两套体系判据 | `getProviders()` 返回 catalog provider id（`compat.ts:63` = `all.ts:56 getBuiltinProviders` 别名） | xyz-agent 用 builtin-providers.json 副本近似判据 |
| catalog 定义权威 | `models.generated.ts` → `getBuiltinModels`（`all.ts:60`） | pi 子进程自带，xyz-agent 不需复制定义 |
| auth.json schema | `{providerId:{type,key,env?}}`（pi `auth-storage.ts:24-34`，ApiKeyCredential/OAuthCredential/AuthCredential 联合） | xyz-agent AuthStorage 按此写 |
| 凭据优先级链 | runtime override > auth.json > models.json apiKey（`model-registry.ts:737-740`，请求时 getApiKeyAndHeaders 解析） | catalog provider 秘钥写 auth.json（链位高）；自定义 provider 留 models.json（fallback） |
| auth.json 读取时机 | **无文件监听**：`reload()`（pi `auth-storage.ts:259`）仅在构造/`persistProviderChange`/OAuth 刷新失败三处调用，无 getFileRevision/mtime/watch（`grep "getFileRevision\|fileRevision"` 0 命中） | 已有 session **不**自动感知 auth.json 改动；迁移须先于 session spawn |
| models.json apiKey 合法 | `ProviderConfigSchema.apiKey` Optional（`model-registry.ts:225`），fallback 秘钥 | 自定义 provider apiKey 留 models.json 不破坏 pi |
