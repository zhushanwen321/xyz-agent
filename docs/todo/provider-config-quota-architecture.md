# Provider 配置与 Coding Plan 额度架构设计

> **一句话结论**：把 provider 体系的「来源 / 凭证 / 套餐额度」三轴组合能力补全——xyz 私有配置从 pi 的 models.json 迁出到独立文件并收口读写路径，额度凭证源补上 auth.json 通道，Settings 统一编辑体按三轴条件化，全程不改 pi 源码、不寄生 pi 数据。
>
> **层声明**：本文档是技术方案设计层（当前层），下一层产物是可实现的代码任务（§5 拆分为 Phase A1/A2/B/C）。不跨层到具体测试用例。

---

## §1 背景目标

**SCQA**：

- **情境（S）**：xyz-agent 通过子进程 RPC 驱动 pi（`@earendil-works/pi-coding-agent@0.84.1`），provider 配置落在 pi 识别的两个文件上——`auth.json`（凭证）与 `models.json`（provider/模型定义）。用户实际使用中，coding-plan 类 provider（智谱 GLM、Kimi、MiniMax 等）的凭证按 M5-01 决策只写入 auth.json。
- **冲突（C）**：额度查询服务（QuotaService）的凭证解析链只认 secrets 文件与 models.json 的 `apiKey` 字段，**根本不读 auth.json**——凡是凭证走 auth.json 的 provider，额度查询全部断开；同时 oauth 型 provider 在 Settings 中没有自定义模型入口，xyz 私有字段（quota、模型启停）寄生在 pi 的 models.json 里，pi 升级收紧 schema 时有数据损毁风险。
- **问题（Q）**：如何在不修改 pi 源码、不污染 pi 数据文件的前提下，补全「任意来源 × 任意凭证形态 × 套餐额度绑定」的组合能力，并让所有配置数据有唯一的权威真相源与收口的读写路径？
- **答案（A）**：三文件所有权划分（auth.json = pi 凭证域 / models.json = pi 定义域·仅原生语义 / `config/providers.json` = xyz 扩展域），三个 Store 收口读写（file-lock + 原子写），额度 fetcher 改为凭证能力声明数组并新增 auth.json 凭证源，额度数据结构扩展绝对剩余量，Settings 统一编辑体按三轴条件化。

### 系统是什么

xyz-agent 是 Electron + Vue 3 桌面 AI Agent 工作台。与本文相关的链路：

```
┌─ Renderer（Vue）┐   WS RPC   ┌─ Runtime（Node）┐  子进程 RPC(pi --mode rpc)  ┌─ pi 进程 ─┐
│  Settings 页面   │ ────────→ │  ConfigService   │ ─────────────────────────→ │ 读 auth.json│
│  ProviderPage    │           │  QuotaService    │   env: PI_CODING_AGENT_DIR  │ 读 models.json│
└─────────────────┘           │  AuthService     │                             └───────────┘
                              └──────────────────┘
```

pi 进程启动时由 runtime 注入 `env.PI_CODING_AGENT_DIR = getPiAgentDir()`（`packages/runtime/src/infra/pi/rpc-client.ts:168`），指向 `<dataDir>/pi/agent/`（`<dataDir>` 由 shared `getDataDir()` SSOT 派生，缺省 `~/.xyz-agent`，读 `XYZ_AGENT_DATA_DIR` 支持实例隔离）。pi 从该目录读取 `auth.json`（凭证）与 `models.json`（provider/模型定义）。

**provider 体系的三轴抽象**（现有代码已具备，本文在它之上补全，不另起炉灶）：

| 轴 | 现有抽象 | 取值 | 回答的问题 | 代码位置 |
|---|---|---|---|---|
| 来源 | `ProviderKind` | `catalog` \| `custom` | 定义来自 pi 内置 catalog 还是 models.json | `packages/shared/src/provider.ts:104` |
| 凭证形态 | `authMethod`（当前形态）/ `authMode`（能力全集） | `api_key` \| `oauth` \| `env_var` \| `ambient` | 凭证存放在哪 | `provider.ts:117` / `:66` |
| 套餐绑定 | `ProviderInfo.quota?`（0..1 个额度查询） | fetcher + enabled | 额度怎么查 | `provider.ts:142-160` |

**术语定义（锚定例子）**：

- **catalog provider**：pi 二进制内置定义的 provider（如 `zai-coding-cn`、`anthropic`），凭证在 auth.json，models.json 可写同 id 的 override 条目。
- **custom provider**：定义完全在 models.json 的 provider（如本地代理 `omlx`）。
- **coding-plan**：不是独立 provider 类型，是「特定 baseUrl + 订阅计费」的套餐形态（如智谱 `https://open.bigmodel.cn/api/coding/paas/v4`），由套餐绑定表达。
- **寄生字段**：写进 pi 文件但不在 pi schema 内的字段。pi 0.84.1 `ProviderConfigSchema` 的字段全集为 name/baseUrl/apiKey/api/oauth/headers/compat/authHeader/models/modelOverrides（`dist/core/model-config.js:168-180`）；现状寄生字段共三类——provider 级 `quota` 与 `authMethod`（`pi-provider-store.ts:66-83`、`provider-config-helper.ts:288`，QuickSetup 保存时持续写入）以及 models[].`enabled`，靠 pi 的 typebox 校验对额外属性宽容而存活。

### 设计目标（从使用者体验倒推）

- **G1**：用户给凭证在 auth.json 的 provider（如 zai-coding-cn）添加自定义模型，保存后该模型与内置模型合并出现在模型选择器，且能真实对话。
- **G2**：凭证在 auth.json 的 provider（api_key 或 oauth 形态）在 Settings 与输入框容量 chip 中显示 coding-plan 额度，包含绝对剩余量（已用/总量）而不只是百分比。
- **G3**：xyz 私有配置不进 pi 的 models.json；升级 pi（含 schema 收紧）不需要数据迁移，xyz 配置无丢失风险。
- **G4**：Settings 中任意 provider（catalog/custom × api_key/oauth）都在同一个展开编辑体里完成凭证、模型、套餐三类配置，无平行配置体系。

### In / Out scope

**In**：providers.json 新文件与三 Store 收口；存量寄生字段迁移；额度凭证源扩展与数据结构扩展；Settings 统一编辑体改造；headers/authHeader 写入断链修复。

**Out**：pi 源码与 pi 内置 extension 的任何修改；新增 pi extension（本方案经评估不需要，逃生舱见 §3.3 D3）；`extensions/shared/quota-providers`（npm 包，服务 model-switch 的另一套额度实现）与 runtime QuotaService 的统一——两套重复 fetcher 的合并是独立后续项；openai-codex / anthropic 新额度 fetcher 的实现（Phase C，端点实测前置）；智谱 oauth 通道（pi 侧 zai-coding-cn 为 env API key 型，无 oauth flow）。

---

## §2 现状与问题分析

**结论**：额度断开的根因不是「缺 oauth 支持」，而是 QuotaService 凭证解析链缺了 auth.json 这一整域；自定义模型缺口的根因是 UI 对 catalog provider 的刻意收窄（wave4 C4 决策）；数据风险的根因是 xyz 私有字段寄生 pi 文件且写路径多口。

### 2.1 使用者视角的现状与真实失败模式

**场景 A（额度断开，真实用户环境）**：用户在 Settings 用模板添加「智谱 GLM Coding Plan」，按 M5-01 决策 API key 被剥离转写 auth.json（`provider-config-helper.ts:262-286`：catalog 凭据只归 auth.json）。实测用户系统 pi 域 `~/.pi/agent/auth.json`：5 个凭证全部为 `{type:'api_key', key:...}`（zai-coding-cn、kimi-coding、minimax-cn、deepseek、xiaomi-token-plan-cn）——该实测佐证「catalog 类 coding-plan provider 的普遍凭证形态是 auth.json api_key」；xyz 场景（`<dataDir>/pi/agent/auth.json`）的断链结论由下方源码论证独立支撑。随后开启额度查询——QuotaService 凭证解析链如下（`quota-service.ts:356-368`）：

```ts
if (authType === 'api-key') {
  const quotaKey = this.readSecret(this.getApiKeyPath(providerId))   // <dataDir>/secrets/<id>-apikey.txt（专属额度 key）
  if (quotaKey) return quotaKey
  const providerKey = getApiKeyForProvider(providerId)               // models.json providers[id].apiKey
  return providerKey ?? null                                         // ← auth.json 的 key 永远读不到
}
```

用户没填过 secrets 专属 key，catalog provider 的 models.json 条目也没有 apiKey（被剥离了）→ 返回 null → 额度查询静默返回缓存、不发请求。**用户的 GLM/Kimi/MiniMax coding-plan 额度全部不可见**。

**场景 B（oauth 型 provider 无模型编辑）**：oauth 登录的 catalog provider（anthropic、kimi-coding 等 6 个，`builtin-providers.json` 的 `oauthConfig` 字段）展开编辑体后，模型区是只读列表（`ProviderEditBody.vue:204-224`，wave4 C4 注释：「内置模型由 pi catalog 提供，升级覆盖编辑无意义」）。用户想给 kimi-coding 加一个自定义模型别名或新发布的模型——没有入口，只能手改 models.json。

**场景 C（寄生字段的升级风险）**：models.json 的 provider 条目上写着 pi schema 外的 `quota` 字段、models 数组元素上写着 `enabled` 字段。pi 0.84.1 的 typebox 校验（`model-config.js` `ProviderConfigSchema`）目前宽容额外属性，但 pi 的 schema 已见收紧趋势（`oauth` 字段收为 `Type.Literal("radius")`）。一旦收紧，pi 加载 models.json 报 schema 错误 → **全部 provider 定义失效**。

**场景 D（写入断链，存量 bug）**：前端编辑表单发送 `headers`/`authHeader`（`packages/core/src/domain/settings/use-provider-edit.ts:396-398`），但 runtime 的 `SetProviderInput` 不含这两个字段、`setProvider` 不写（`provider-config-helper.ts:286-297`）——用户在 UI 编辑的自定义 header 不落盘，无任何报错。

**场景 E（oauth-only provider 无法持久化额度配置）**：`persistQuotaConfig` 要求 provider 在 models.json 有条目，为空直接 warn 失败（`quota-service.ts:254-257`）——oauth 登录的 catalog provider 在 models.json 无条目，连「开启额度查询」这个动作都无法完成。

### 2.2 根因分析

1. **凭证源抽象缺一域**：`ProviderQuotaFetcher.authType` 只有 `'api-key' | 'cookie'` 两值（`quota-types.ts:32`），凭证解析链对应只有 secrets/models.json 两条。auth.json 作为 catalog provider 凭证的目标位置（M5-01），从一开始就不在额度体系的视野里。场景 A、E 同根。
2. **数据所有权未划分**：xyz 没有区分「pi 公开配置接口」与「pi 容忍的额外空间」，quota/authMethod/enabled 就近塞进了 models.json（场景 C）；同时 `authStorage.set` 有两个独立调用点（OAuth 登录成功的 `auth-service.ts:104` 与 catalog 保存 apiKey 的 `provider-config-helper.ts:271`），models.json 写入散在 pi-provider-store 与 provider-config-helper——「权威真相源收口」从未成立。
3. **UI 按类型分裂而非按轴条件化**：模型编辑能力被 wave4 C4 按 ProviderKind 一刀切（catalog=只读），额度区虽有渲染但对 oauth/api_key(auth.json) 形态拿不到凭证——三轴组合中「catalog × auth.json 凭证 × 自定义模型」「catalog × oauth × 套餐」两个组合格是空的。

### 2.3 现状物理数据流（额度查询为例）

```
[用户 hover 容量 chip]
   ↓ useQuotaDisplay（条件 providerInfo.quota?.enabled ← 读 models.json provider.quota〔寄生〕）
[quota.fetch RPC]
   ↓ QuotaService.getCredential
   ├─ secrets/<id>-apikey.txt        ← 用户没填 → miss
   └─ models.json providers[id].apiKey ← catalog 条目被剥离 → miss
   ↓ 凭证 null → 直接返回缓存，不发请求
[平台额度 API 从未被调用]              ← 断点
```

---

## §3 解决方案

### 3.1 终态（使用者视角）

**场景 A 终态——auth.json 凭证的 catalog provider 配置自定义模型**：

> 用户展开 Settings → 供应商 → 「Z.AI Coding CN」（凭证徽章：API Key·已配置）。模型区显示混合列表：`glm-5.3`（徽章·内置）、`glm-5.2`（徽章·内置）、`my-glm-alias`（徽章·自定义）。点击「添加模型」，填 id `glm-5.4-preview`、name、contextWindow，保存。模型选择器中出现 `zai-coding-cn / glm-5.4-preview`，选中后发起对话，请求真实发往智谱端点（认证用 auth.json 的 key）。删除该模型后列表恢复。
>
> 失败路径：若 models.json 写入失败（磁盘满/锁冲突），save-bar 显示错误「保存失败：models.json 写入超时」，并给出恢复指引：「重试保存；若持续失败，检查磁盘空间后重启应用」。模型列表保持旧值，不出现半保存状态。

**场景 B 终态——额度恢复与绝对量显示**：

> 同一 provider 的套餐区显示：「智谱 GLM Coding Plan ｜ 5h 窗口已用 1,204 / 5,000 次 · 24% ｜ 重置 2:31:05」（智谱平台现状仅 5h 窗口有数据、周/月为无限档，维持现有 ∞ 窗口隐藏语义；kimi/minimax 按各自平台实际窗口与字段显示）。输入框容量 chip hover 同样可见。数据来自真实平台 API（智谱 `bigmodel.cn/api/monitor/usage/quota/limit`），凭证取自 auth.json 的 api_key。
>
> 失败路径：oauth 型 provider 额度查询返回 401（token 过期且 pi 尚未刷新）→ 额度区显示「额度查询失败：凭证可能过期」+ 恢复指引「与该供应商发起一次对话触发 token 刷新后，点击刷新重试」。不发未知请求重试风暴，QuotaService 不自行 refresh（见 D6）。

**场景 C 终态——统一编辑体**：

> kimi-coding（oauth 登录）展开编辑体：凭证区显示「● 已登录（OAuth）· [重新登录] [退出登录]」；切换为 API Key 时弹确认「改用 API Key 将退出 OAuth 登录」（I9 双凭据互斥）；套餐区凭证态显示「凭证已就绪（OAuth 登录）」；模型区内置列表（徽章·内置）+ 自定义模型可增删（徽章·自定义，写 models.json override）。

### 3.2 多方案对比

**对比一：xyz 私有配置的持久化位置**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 继续寄生 models.json（现状） | 差：所有权混淆，pi schema 收紧即炸 | 零（不动） | 场景 C 的升级风险持续存在；真相源永不收口 | ❌ |
| **B. 三文件所有权划分（providers.json 独立 + 迁移）** | 好：每个文件单一 owner，pi 升级零迁移；id 关联清晰 | 中：新 Store + 迁移 + 读侧切换 | 迁移期兼容窗口需处理（双读一个版本周期）；用户降级装旧版时 xyz 扩展配置不可见（见错误规格表，已接受取舍） | ✅ |
| C. 全部经 pi extension 注入（native Provider 注册） | 差：内置模型列表需 extension 自行拼接，pi-ai 版本与宿主漂移时发出旧 catalog——真相源分裂 | 高：新 extension + 版本对齐机制 | 违背「权威真相源收口」的根本约束 | ❌ |

若用方案 A：场景 C 的用户在 pi 升级收紧 schema 后打开应用，全部 provider 消失，需要紧急数据修复——这是本次要根除的故障模式。若用方案 C：pi 升级新增内置模型（如 glm-5.4）后，extension 若未同步升级 pi-ai 依赖，用户看到的内置列表停在旧版本，且无人能解释差异来源。

**对比二：额度 fetcher 的凭证声明方式**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. authType 单值 + QuotaService 隐式回退 | 差：kimi 为什么用了 oauth token 不可见，凭证依赖不可审计 | 低 | 隐式回退链调试困难 | ❌ |
| **B. fetcher.auth 能力声明数组** | 好：每个 fetcher 的凭证依赖显式；解析顺序即数组序 | 中：接口改造 + 5 个 fetcher 适配 | 低 | ✅ |

若用方案 A：kimi-coding 同时接受 api key 与 oauth token，单值只能选一个，另一个靠隐藏回退——三个月后排查「额度为什么查错账号」时没有任何显式线索。

**对比三：Settings 的配置入口形态**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. QuickSetup（模板向导）与行内编辑并行两套 | 差：两套状态机、两条保存路径，组合爆炸 | 低 | oauth provider 只能走向导，能力缺口固化 | ❌ |
| **B. 行内展开编辑体为唯一入口，QuickSetup 降位为模板化快速通道**（同一 setProvider/oauth 底层） | 好：三轴条件化一处收口 | 中：凭证区/模型区改造 | UI 回归面较大 | ✅ |

### 3.3 关键决策与权衡

**D1：models.json 保留为 pi 原生语义字段的写入点（用户已确认「保留原生语义即可」）**

- 选择：自定义模型（`models`/`modelOverrides`）、baseUrl/api/headers/authHeader/apiKey 继续写 models.json，但**只写 pi schema 内字段**；xyz 私有字段全部迁出。
- 被否：连 models.json 也不写（= 对比一方案 C）。
- 证据：pi 官方文档 `docs/models.md:148`「models become available when auth is configured through /login/auth.json…」——models.json 是 pi 公开设计的宿主配置接口，不是 pi 内部数据。✅ **已实测**（探针见 D7）：临时 `PI_CODING_AGENT_DIR` 下写 auth.json（api_key 与 oauth 两种假凭证）+ models.json 同 providerId override，`pi --list-models` 输出内置模型与自定义模型合并且全部可用；`modelOverrides` 的 contextWindow 生效（glm-4.7 显示 111K）；清空 auth.json 后同样 override 输出 "No models available"——**凭证是可用性门槛，与模型定义正交**，两种凭证形态均成立。

**D2：凭证必须留在 auth.json，不做 xyz 侧凭证存储**

- 选择：api_key 与 oauth 凭证均写 auth.json，经收口的 AuthService。
- 被否：凭证也存 providers.json（extension 注入 resolve）。
- 证据：oauth token 的 refresh 由 pi 的 Models 在文件锁内串行管理（`pi-ai/dist/auth/types.d.ts:46-75` CredentialStore 契约：「`modify` is the only write path…concurrent requests cannot double-refresh a rotated token」）。凭证离开 auth.json = xyz 自行实现 refresh 轮换与锁——重复实现 pi 已有能力，且与 pi 请求路径的凭证读取形成双写竞争。pi-ai `OAuthCredentials` 带索引签名 `[key: string]: unknown`（`types.d.ts:18-23`），auth.json 结构上允许附加字段，但本方案不利用它存任何 xyz 配置（那是 radius 的 gatewayConfig 专属语义，绕开 models.json 的 schema 校验）。

**D3：不新增 pi extension；extension 机制定位为未来逃生舱**

- 选择：本方案 pi 侧零改动、零新增 extension。
- 证据：pi extension 的 `registerProvider` config 形式对 `models` 是**替换语义**（官方文档 `docs/extensions.md`：「If provided, replaces all existing models for this provider」；源码 `provider-composer.js` `applyExtension` 一致）——无法表达「内置 + 追加」，与需求 1 冲突。native Provider 形式可绕过，但见对比一方案 C 的真相源分裂风险。当未来出现 pi 原生通道覆盖不了的需求（如凭证驱动动态模型目录 `refreshModels`）时，经 builtin extension 实现，且 extension 的 pi-ai 依赖版本必须与宿主 pi 对齐——此约束记录于本决策，未来实施时核对。

**D4：providers.json 落点 `<getPiAgentDir()>/config/providers.json`**

- 选择：放 pi agentDir 的 `config/` 子目录，派生函数 `getProviderExtrasPath()` 加入 `pi-paths.ts`（路径 SSOT）。
- 被否：`<dataDir>/` 根（与现有平铺 config.json 并列）——离消费者（同 pi 实例的 runtime 服务）远；`~/.pi`（全局 pi 域）——违背数据目录隔离。
- 证据：同目录已有先例 `config/rename-session-ext-config.json`（`worktree-config-helper.ts:200`，xyz 与 pi extension 的契约配置，extension 侧经 `process.env.PI_CODING_AGENT_DIR` 读取）——pi 不扫描 agent/config/ 子目录，无冲突；且若未来启用 D3 逃生舱，extension 可用同一 env 到达该文件。xyz 域归属不受影响（整个 `<dataDir>/pi/` 在 xyz 数据目录内）。

**D5：额度数据结构扩展为「绝对量 + 百分比」双轨，全部 optional**

```ts
interface QuotaWindow {
  pct: number | null            // 保留：现有消费方（容量 chip、model-switch advisor）零改动
  used?: number | null          // 新增：已用绝对量（次数或 token 数）
  limit?: number | null         // 新增：总量
  unit?: 'requests' | 'tokens' | 'credits' | null  // 新增：平台计费单位（实施期按真实平台数据核对/补充枚举）
  resetSec: number | null
}
```

- 证据：绝对量数据源的已证与待证要分开——**kimi 已证**：fetcher 内部从平台 API 拿到 limit/remaining 后折算为 pct 丢弃（`runtime/services/quota-providers/kimi.ts:64-71`），纯输出侧补全即可；**zhipu/minimax 待实测**：现状类型建模分别为 percentage+currentValue（仅 5h 窗口，周/月 = ∞ 隐藏，`zhipu.ts:8,19-23`）与纯剩余百分比+时间（`minimax.ts:8,27-36`），平台 API 是否可取总量与多窗口字段未知，列入待验证检查点 4（Phase A2 前置）。optional 保证向后兼容（旧缓存/旧 fetcher 输出仍合法）。

**D6：oauth token 额度查询 401 时不做 runtime 侧 refresh**

- 选择：QuotaService 只读 auth.json 现值（经 AuthService file-lock 读取）；401 返回带原因的失败态，UI 文案指向恢复动作（发起一次对话让 pi 触发刷新，再手动刷新额度）。
- 被否：runtime 实现 refresh。
- 证据：refresh token 轮换的并发安全由 pi 在锁内保证（同 D2）；runtime 自行 refresh 会与 pi 的写回形成双写竞争。额度查询是低频状态展示，短时过期容忍的代价远低于双写风险。

**D7：所有 pi 语义断言以 node_modules 实装版（0.84.1）为准，探针已跑**

- 本文引用的 pi 行为断言（override 合成、凭证优先级、替换语义、schema 容忍）均出自 `node_modules/@earendil-works/pi-coding-agent@0.84.1` dist 编译 JS 与其内置 docs；其中 override 组合机制已用项目内入口（`node node_modules/.../dist/cli.js --list-models` + 隔离 `PI_CODING_AGENT_DIR`）实测验证，两组探针输出记录于 §2/§3.1 对应场景。⛔ **实施期门**：Phase A1 落地前重跑一次探针（防 pi 版本升级漂移，AGENTS.md 曾因 clone 滞后断言连产 4 条漂移 bug）。

### 3.4 数据模型与接口

**providers.json（xyz 扩展域，version 留迁移钩子）**——承载全部自 models.json 迁出的寄生字段：

```jsonc
{
  "version": 1,
  "providers": {
    "zai-coding-cn": {
      "authMethod": "api_key",                                  // 凭证形态标注（自 models.json 迁入）
      "quota": {                                                 // 套餐绑定（自 models.json 迁入）
        "fetcher": "zhipu",
        "enabled": true,
        "cookieSet": false,                                      // cookie 类 provider 的 cookie 已写状态（迁入，供 ProviderInfo.quota.cookieSet）
        "apiKeySet": false                                       // 额度专属 key 已写状态（迁入，供 ProviderInfo.quota.apiKeySet）
      },
      "modelStates": { "glm-5.2": { "enabled": false } }         // 模型启停（自 models[].enabled 迁入）
    }
  }
}
```

关联键 = providerId（与 auth.json 的 key、models.json 的 `providers.<id>` 同名对齐）。聚合层 `listProviders` 以 id 做三源拼接，`ProviderInfo` 对前端形状不变（含 `quota.cookieSet/apiKeySet` 与 `authMethod` 的数据源切换，消费方 `deriveAuthMethod` 等改读 providers.json）。

**fetcher 接口（能力声明数组化 + 错误通道）**：

```ts
interface ProviderQuotaFetcher {
  id: string
  /** 能力声明：该套餐额度 API 接受的凭证形态，按优先级排序 */
  auth: Array<'api-key' | 'oauth' | 'cookie'>
  /** kind 让 fetcher 可区分凭证语义（如个别平台 oauth 与 api key 请求头不同） */
  fetchQuota(credential: string, kind: 'api-key' | 'oauth' | 'cookie'): Promise<QuotaFetchOutcome>
}

/** 失败原因可区分——现状 null-only 接口下 401 / 网络失败 / 无订阅三者不可分辨（zhipu.ts:71 / kimi.ts:59 / minimax.ts:71 均 `if (!resp.ok) return null`），D6 的「401 失败态 + 恢复指引」无从实现 */
type QuotaFetchOutcome =
  | { ok: true; data: NormalizedQuotaRow }
  | { ok: false; reason: 'unauthorized' | 'network' | 'no-subscription' | 'parse' }
```

`reason` 经 QuotaService 缓存层透传到前端（现状缓存结构 `QuotaFetchResult` 只有 data/lastFetchAt，需同步扩展 reason 字段）。

`QUOTA_PRESETS` 的 `auth` 字段同步数组化：kimi-coding 声明 `['api-key','oauth']`（其 usages API 与 oauth 同域同 Bearer——pi 侧 kimi oauth 的 `toAuth` 即 `Authorization: Bearer credential.access`，`pi-ai/dist/auth/oauth/kimi-coding.js:257-258`，与 xyz fetcher 的 Bearer 调用同构，`runtime/services/quota-providers/kimi.ts:52-57`）；zhipu/minimax 维持 `['api-key']`（zhipu 额度 API 为裸 authorization 头无 Bearer，oauth 通道暂不声明）。⛔ 实施期门：kimi oauth access token 查 `/coding/v1/usages` 是否 200 需真实凭证实测（Phase C 前置）。

**凭证解析链（终态）**：

| 形态 | 解析顺序 |
|---|---|
| api-key | secrets 专属 key → auth.json `credential(api_key).key`（**新增**）→ models.json `providers[id].apiKey` |
| oauth | auth.json `credential(oauth).access`（**新增**） |
| cookie | secrets cookie 文件（不变） |

**三 Store 收口（读写双侧唯一入口）**：

| 文件 | 唯一 writer / reader | 机制 |
|---|---|---|
| `<agentDir>/auth.json` | AuthService | 复用现有 AuthStorage（proper-lockfile + 原子写 + 0600）；`authStorage.set` 的两个独立调用点（`auth-service.ts:104`、`provider-config-helper.ts:271`）收拢到 AuthService 单一入口 |
| `<agentDir>/models.json` | ModelDefinitionWriter | 只写 pi schema 内字段；剥离寄生字段；复用 JsonStore 原子写；顺带修复 headers/authHeader 断链、模型白名单补 `reasoning`/`maxTokens`/`cost`/`headers` |
| `<agentDir>/config/providers.json` | XyzProviderStore | file-lock（复用 `extensions/shared/file-lock`）+ tmp/rename 原子写 + version 迁移钩子 |

Renderer 永不感知文件名（WS RPC → ConfigService facade → 三 Store）；跨 Store 组合操作（「保存 provider 同时写定义 + 绑定套餐」）由 ConfigService 按序编排，不引入跨文件事务，靠顺序 + 幂等保证一致。

**错误规格（每个失败配恢复指引）**：

| 错误 | 行为 | 恢复指引 |
|---|---|---|
| oauth 额度 401 | `reason:'unauthorized'` 失败态，不自动 refresh、不重试风暴 | 「与该供应商发起一次对话触发 token 刷新后，点击刷新重试」（D6） |
| providers.json 迁移失败 | 不阻塞启动，双读回退 models.json 旧字段，日志告警 | 下次启动自动重试迁移（幂等）；持续失败查看 `<dataDir>/logs/` |
| 迁移失败窗口内的双源合并 | **双读优先级：providers.json 优先、models.json 旧字段兜底；重试迁移只搬入 providers.json 中尚无条目的 provider，已有条目以 providers.json 为准并丢弃 models.json 旧字段**（防止失败窗口内的用户新写入被 stale 旧值覆盖） | 搬运成功后写回剥离版 models.json，即完成剥离判定 |
| 迁移产生 pi 校验空壳条目 | 剥离寄生字段后若条目不满足 pi 八字段校验（models/baseUrl/headers/compat/modelOverrides/apiKey/oauth/authHeader 全缺——pi `applyModelsJson` 对此 throw），**整条删除**（典型：存量「只有 quota + name」的条目，`quota-service.ts:260-270` 经 upsertProvider 产生） | 无需恢复（该条目在 pi 侧本就无定义语义，xyz 扩展信息已保入 providers.json） |
| models.json 写入锁冲突/超时 | save-bar 报错，保持旧值 | 「重试保存；持续失败检查磁盘后重启」（§3.1 场景 A 失败路径） |
| providers.json 损坏（非法 JSON） | 按空配置启动，备份坏文件 | 从 `<config>/providers.json.corrupt-<ts>` 人工恢复 |
| 用户降级安装旧版 xyz | 旧版不识别 providers.json，quota/modelStates 表现为「未配置」（models.json 旧字段已剥离，不回写） | 重新配置套餐；此为已接受的取舍（pi schema 损毁风险 > 降级体验损失，见对比一风险栏） |

### 3.5 终态物理数据流（额度查询）

```
[用户 hover 容量 chip / Settings 套餐区]
   ↓ quota.fetch RPC（条件 providerInfo.quota?.enabled ← 读 providers.json〔xyz 域〕）
[QuotaService.getCredential：按 fetcher.auth 数组序]
   ├─ 'api-key' → secrets/<id>-apikey.txt → AuthService.get(providerId).key（auth.json）→ models.json apiKey
   └─ 'oauth'   → AuthService.get(providerId).access（auth.json，file-lock 读）
   ↓ 真实凭证
[平台额度 API：bigmodel.cn /api/monitor/usage/quota/limit 等]
   ↓ NormalizedQuotaRow{ pct, used, limit, unit, resetSec }
[UI：绝对量 + 百分比双轨显示]
```

### 3.6 Settings 统一编辑体（四区块按三轴条件化）

```
Provider 行展开体（ProviderEditBody 泛化，唯一编辑入口；QuickSetup 降位为模板快速通道）
├─ 基础区      name / api / baseUrl        catalog: baseUrl 显示内置值，改写即 override（标注）
├─ 凭证区      按 authMethod 切换呈现：
│    oauth   → ● 已登录 + [重新登录] [退出登录]（复用 useProviderOAuth / oauthPresent）
│    api_key → 现有 key 输入（catalog 落 auth.json / custom 落 models.json，M5-01 不变）
│    形态切换显式确认（I9 双凭据互斥双向）
├─ 套餐额度区  CodingPlanSection 泛化，按 fetcher.auth 渲染凭证态：
│    oauth   → 「凭证已就绪（OAuth 登录）」/「请先完成 OAuth 登录」
│    api-key → 现有专属 key 输入 + 回退顺序说明
│    显示     used/limit + pct 双轨 + 重置倒计时
└─ 模型区      catalog: 内置模型（徽章·内置，只读）+ 自定义模型增删改（徽章·自定义，写 models.json override）
                       + 内置条目参数覆写（写 modelOverrides，徽章·已覆写）
              custom:  现有 ModelListSection 不变
```

两个 UI 决策：

1. **wave4 C4 决策的边界修订（显式标注，不是推翻）**：C4 禁止的是「修改内置模型定义」（pi 升级会覆盖编辑）——内置条目保持只读不变；「追加自定义模型」与「对内置条目做参数 override」是 pi 原生支持的合法操作（D1 探针已证），不属于 C4 禁止场景。组件注释中记录此边界修订。
2. **模型来源徽章需聚合层配合**：`listProviders` 合并（override.models 优先、builtin 兜底，`provider-config-helper.ts:159-161`）后丢失条目来源。`ProviderInfo.models[]` 增加 optional `source?: 'builtin' | 'override'`（shared 类型，向后兼容），聚合层合并时标注。

---

## §4 验收（真实场景，非单测非 mock）

> 大改动（持久化架构 + 额度体系 + UI 三处），按四个目标各配真实场景；全部在开发机真实 xyz-agent + 真实 pi 数据目录执行，不 mock 平台 API、不造假凭证。

**V1（验证 G1：auth.json 凭证 + 自定义模型）**

- 场景：开发者本机，数据目录使用真实凭证（zai-coding-cn，用户已有 auth.json api_key）。
- 步骤：Settings 展开「Z.AI Coding CN」→ 添加自定义模型 `glm-5.4-preview`（填 contextWindow 200000）→ 保存 → 打开新会话模型选择器选中该模型 → 发送一条真实消息；再删除该模型。
- 通过标准：选择器出现 `zai-coding-cn / glm-5.4-preview` 且其余内置模型不受影响；真实对话返回 200 且计费发生在 coding-plan 套餐内（额度 used 增长，见 V2）；删除后选择器不再出现；`~/.xyz-agent/pi/agent/models.json` 中该条目增删与 UI 操作一致，且条目内**无任何 pi schema 外字段**。

**V2（验证 G2：额度恢复 + 绝对量）**

- 场景：同一开发机，zai-coding-cn（api_key 在 auth.json）、kimi-coding、minimax-cn 三个 catalog provider。
- 步骤：Settings 展开各 provider → 套餐区启用额度查询 → 触发查询 → hover 输入框容量 chip。
- 通过标准：三个 provider 均返回真实额度（非缓存空值）；**智谱显示 5h 窗口绝对量（used/limit，待验证检查点 4 实测确认可得性；若平台确实无总量字段，则显示 currentValue + percentage 并在文档修订时如实记录）**，周/月 ∞ 窗口维持隐藏语义（此前完全查不到额度是断点，此为恢复验证）；kimi 显示三窗口中平台实际提供的窗口；V1 的对话使其 used 可观察增长；`config/providers.json` 中出现对应 quota 绑定（含 cookieSet/apiKeySet），models.json 中不再有 quota/authMethod 字段。

**V3（验证 G3：迁移与 pi 升级隔离）**

- 场景：构造存量数据（用当前版本写一份含寄生字段的 models.json：provider.quota + authMethod + models[].enabled，**另含一条只有 quota + name 的空壳条目**——`persistQuotaConfig` 经 upsertProvider 产生的真实形态）→ 启动新版 xyz-agent。
- 步骤：观察启动迁移 → 重启二次（幂等验证）→ 检查两个文件内容 → 用 `node <项目>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --list-models`（PI_CODING_AGENT_DIR 指向 xyz 数据目录）验证 pi 正常加载。
- 通过标准：迁移后 models.json 只含 pi 原生语义字段、providers.json 含迁出的 quota/authMethod/modelStates（含 cookieSet/apiKeySet）且值不丢失（provider 列表、额度开关、模型启停与迁移前行为一致）；**空壳条目按 §3.4 错误规格整条删除且其 quota 信息保入 providers.json**；二次启动 no-op；pi --list-models 输出与迁移前有效 provider 集合一致（空壳条目本就不产生 pi 侧模型，删除不影响输出）。

**V4（验证 G4：oauth 型 provider 统一编辑体全链路 + 401 恢复闭环）**

- 场景：kimi-coding（oauth device flow 登录，真实账号）。
- 步骤：Settings 展开 → 确认凭证区显示「已登录（OAuth）」→ 添加自定义模型 → 保存 → 套餐区确认凭证态「已就绪（OAuth 登录）」→ 触发额度查询 → 再切换认证方式为 API Key（确认弹窗出现）→ 切回 OAuth 重新登录。
- 通过标准：全程在同一展开体内完成（无页面跳转/无第二套配置入口）；自定义模型对 oauth 凭证 provider 同样生效；额度查询用 oauth access token 发起（⛔ 若实测 401/403 则该 fetcher 的 oauth 能力摘除，降级为仅 api-key——Phase C 门）；认证切换后凭证互斥正确（auth.json 无双凭证共存）。
- **401 恢复闭环**（D6 承诺的验收）：将 auth.json 中该 provider 的 access 人为改为无效值（模拟过期）→ 触发额度查询 → 确认显示「凭证可能过期」失败态（而非静默缓存/空白）→ 与该 provider 发起一次真实对话（pi 触发 refresh 写回 auth.json）→ 点击刷新 → 额度恢复显示。通过标准：失败态文案与恢复指引完整呈现，恢复动作后无需重启应用即恢复。

**V5（验证 G3/G4：收口与并发）**

- 场景：同一 provider 同时触发「保存模型定义」与「切换套餐开关」。
- 步骤：并行发出两个写请求；随后读取 models.json 与 providers.json。
- 通过标准：两文件各自内容完整一致（无交错半写）；代码层面 `rg` 确认 auth.json 写入点仅剩 AuthService 一处、providers.json 写入点仅 XyzProviderStore 一处。

---

## §5 下一层拆分

**实施路径**：A1（地基）→ A2（额度）与 B（UI）可并行 → C（扩展 fetcher，端点实测前置）。每阶段可独立验收/回滚。

### Phase A1：持久化收口（对应 V3/V5 地基）

| 单元 | 内容 | justification |
|---|---|---|
| A1-1 | `getProviderExtrasPath()` + `XyzProviderStore`（file-lock + 原子写 + version） | 路径入 pi-paths SSOT；锁与原子性是收口硬约束 |
| A1-2 | 存量迁移（剥离 models.json 寄生字段——quota/authMethod/enabled/cookieSet/apiKeySet → providers.json，幂等 + 双读回退 + 备份 + §3.4 空壳条目整条删除 + 合并策略） | 先迁数据再切读侧，读侧切换才能零风险 |
| A1-3 | 聚合层/消费方切换读源（quota/authMethod 读 providers.json；modelStates 过滤同） | 双读回退保证兼容窗口 |
| A1-4 | AuthService 收口（`authStorage.set` 的两个独立调用点——`auth-service.ts:104` 与 `provider-config-helper.ts:271`——收拢到 AuthService 单一入口）+ QuotaService 读凭证走 AuthService | 读侧收口与写侧同步完成，避免新直读产生 |

### Phase A2：额度凭证源与数据结构（对应 V2）

| 单元 | 内容 | justification |
|---|---|---|
| A2-1 | fetcher `auth` 数组化 + `QuotaFetchOutcome` 错误通道 + 5 个 fetcher 适配 | 接口先行，能力显式化；无错误通道则 401 恢复指引无法实现 |
| A2-2 | getCredential 三形态解析链（含 auth.json 两形态） | 直接修复场景 A 断点 |
| A2-3 | QuotaWindow 扩展 + kimi 输出绝对量（zhipu/minimax 待检查点 4 实测后跟进） | kimi 数据源已证现成；zhipu/minimax 不编造字段 |
| A2-4 | 401 失败态 + 恢复指引文案（i18n 双语）+ 缓存层 reason 透传 | D6 错误规格落地 |

### Phase B：Settings 统一编辑体（对应 V1/V4）

| 单元 | 内容 | justification |
|---|---|---|
| B-1 | 凭证区 authMethod 条件化 + 形态切换互斥确认 | oauth 型 provider 语义正确的凭证操作 |
| B-2 | 模型区混合列表（内置只读 + 自定义增删 + override）+ `source` 徽章 + C4 边界标注 | G1 的 UI 落点；聚合层 source 标注配合 |
| B-3 | CodingPlanSection 泛化（凭证态 + 绝对量显示） | G2 的 UI 落点 |
| B-4 | headers/authHeader 断链修复 + 模型白名单补全 | 同链路存量 bug，一次修完 |

### Phase C：扩展 fetcher（端点实测前置，⛔ 待验证）

kimi oauth token 实测 usages → openai-codex / anthropic（Claude Pro/Max）用量端点对第三方 oauth token 的兼容性实测 → 按结果新增 fetcher。实测不通过则该平台降级或放弃，如实记录。

### 文件改动地图

- 新增：`<agentDir>/config/providers.json`（运行时生成）；`packages/runtime/src/services/provider-extras-store.ts`（XyzProviderStore）
- 修改：`pi-paths.ts`（+getProviderExtrasPath）、`quota-types.ts` / `quota-presets.ts`（shared）、`quota-service.ts` + `quota-providers/*`（runtime）、`provider-config-helper.ts` / `pi-provider-store.ts`（写侧收口与白名单）、`auth-service.ts` / `oauth-flow.ts`（写口合并）、`provider.ts`（ProviderInfo.models[].source）、`ProviderEditBody.vue` / `CodingPlanSection.vue` / `ModelListSection.vue` / `useProviderOAuth.ts`（UI）、i18n 两个 locale 文件
- 不动：pi 包（node_modules）、pi 内置 extension、`extensions/shared/quota-providers`（Out scope）

### 待验证检查点（设计阶段无法确定，诚实标注）

1. ⛔ kimi oauth access token 查 `/coding/v1/usages` 返回 200 及响应结构（V4/Phase C 门）。
2. ⛔ codex / claude 用量端点对第三方 oauth token 兼容性（Phase C）。
3. ⛔ Phase A1 前重跑 D7 探针（pi 版本升级漂移防护）。
4. ⛔ zhipu / minimax 平台额度 API 是否可取总量与多窗口字段（Phase A2 前置实测——现状类型建模分别为 percentage+currentValue 仅 5h 窗口、纯剩余百分比+时间；决定 V2 中两平台的绝对量显示形态）。
