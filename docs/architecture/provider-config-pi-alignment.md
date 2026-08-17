# provider 配置体系对齐 pi：双体系聚合架构（runtime 聚合 + enable 统一承载）

> **结论**：xyz-agent 的 provider 层缺两块——**展示层不聚合双体系**（catalog provider 导入后从列表消失）、**enable 状态无承载**（散落在 models.json 的 provider.enabled，pi 不消费它控制 composer）。本文给出双体系聚合架构：runtime 把 models.json（custom）+ auth.json/builtin（catalog）两源聚合成带 `kind` 的 `ProviderInfo[]`，renderer 只消费聚合模型；enable 状态统一收敛到 `settings.json.enabledModels`（pi 原生的 composer 可选白名单），过滤在聚合层（listProviders）派生 `ProviderInfo.enabled`，xyz-agent UI 与 pi session 双消费。配套 catalog 移除语义（清凭据+清 override，不删定义）与存量迁移。

---

## §1 背景目标

### SCQA

- **S（情境）**：xyz-agent 底层是 pi，每个 session 独立 spawn pi 子进程，经 `PI_CODING_AGENT_DIR` 把 pi 配置根指向 `<dataDir>/pi/agent/`。pi 有两套独立的 provider 体系（源码审计证实，见 §2.2）：**catalog provider**（定义来自 pi 二进制内置 catalog，凭据走 auth.json）与**自定义 provider**（models.json 全配置含 apiKey）。
- **C（冲突）**：导入/写入侧已在前一轮对齐 pi 双体系（importer 与 setProvider 按 catalog 判据分路，见 §2.3 盘点），但**展示侧与 enable 状态没跟上**：`listProviders` 仍只遍历 models.json，catalog provider 因不再写 models.json 条目而**从 provider 列表消失**；provider 的「启用/禁用」状态散落在 models.json 的 `provider.enabled`，但 pi 不消费它控制 composer 可选范围（pi 用 `settings.json.enabledModels`）。
- **Q（问题）**：怎么让 provider 层在展示、enable、移除三个维度都对齐 pi 的双体系，做到「导入后看得见、enable 状态有统一承载且 composer 联动、catalog 移除不误删定义」？
- **A（答案）**：runtime 做双体系聚合层（合并两源 + 标注 `kind`），renderer 只消费聚合模型；enable 状态统一用 `settings.json.enabledModels` 承载（pi 原生 composer 白名单），过滤落在聚合层（listProviders 派生 `ProviderInfo.enabled`），xyz-agent UI 与 pi session 双消费；catalog 移除 = 清 auth.json 凭据 + 清 models.json override 条目（定义归 pi catalog 不删）。

### 系统是什么

xyz-agent 的 provider 配置体系由三部分组成。**理解三者的边界是理解本设计的前提**：

1. **数据文件**（`<dataDir>/pi/agent/` 下，xyz-agent 只操作这三个）：
   - `models.json`：**自定义 provider 的完整定义**（baseUrl/api/apiKey/models）+ **catalog provider 的 override 条目**（可选，仅改 baseUrl/compat 等）+ **model 级 enabled**（W2 已上线，`model.enabled`）。注意：**provider 级 `enabled` 字段将废弃**（见决策3），enable 语义归 settings.json.enabledModels。
   - `auth.json`：凭据（api_key 明文 / oauth token），0600 权限。catalog provider 的 api_key 凭据归宿。
   - `settings.json`：`defaultModel` / `enabledModels`（composer 可选白名单，本设计的 enable 承载）/ skills 等。
2. **runtime 读写层**（`packages/runtime/src/`）：`config-service.ts`（listProviders/setProvider 聚合门面）、`model-service.ts`（aggregateModels 把 ProviderInfo 展开成 ModelInfo 供 composer）、`infra/pi/pi-provider-store.ts`（读写 models.json + settings.json）、`services/auth/auth-storage.ts`（读写 auth.json）、`services/migration/provider-importer.ts`（导入）。
3. **pi 子进程**：per-session 独立进程。**pi catalog 是 pi 二进制内置的 provider 定义**（源是 pi-ai 的 `models.generated.ts`，构建时编译进 pi 可执行文件），**不是磁盘文件**——既不在 `~/.pi/` 也不在 `<dataDir>/`。xyz-agent 从不读写 pi catalog。pi 启动时自己加载内置 catalog 定义，再读 xyz-agent 的 models.json（custom/override）+ auth.json（凭据）+ settings.json（enabledModels 等）合并到 ModelRegistry。

> **关键边界**：xyz-agent 只操作 `settings.json` / `auth.json` / `models.json` 三个文件。pi catalog（二进制内置）与 `~/.pi/` 下的任何文件都不在 xyz-agent 的读写范围内。本设计所有改动遵守此边界。

### 设计目标（从使用者体验倒推）

| # | 使用者要能做到 | 现状 |
|---|---|---|
| G1 | 从 pi 导入 catalog provider 后，provider 列表**显示该 provider**（修复当前 bug） | ❌ 列表空白（importer 分路后 catalog 不写 models.json，listProviders 只读 models.json） |
| G2 | provider 的启用/禁用有**统一承载**，且 composer 模型选择与之一致 | ❌ enable 散落 models.json provider.enabled，pi 用 settings.json.enabledModels 控制 composer |
| G3 | renderer 只消费**聚合后的统一模型**，通过 `kind` 区分 catalog/custom，不直接接触两套文件体系 | ❌ listProviders 是 models.json 遍历器，renderer 隐式假设所有 provider 都在 models.json |
| G4 | catalog provider 的「移除」**不删定义**（定义归 pi catalog），只清 xyz-agent 侧的凭据+override | ❌ 删除按钮对 catalog/custom 一视同仁（语义错误） |
| G5 | 存量用户的旧配置（错位 apiKey、旧 provider.enabled）**自动迁移**到新架构 | ❌ 无迁移代码 |

### scope

- **当前层 → 下一层**：当前层 = 双体系聚合架构设计；下一层 = 可实现的接口/数据模型/技术方案（聚合层 + enabledModels SSOT + UI 分体系 + 迁移）。属技术方案设计，§3 采用最严格的接口先行 + 数据模型 + 选型对比 + 物理数据流。
- **in-scope**：runtime 聚合层（listProviders 双源合并 + kind 标注 + enabledModels 派生 enabled）；enable 状态统一到 enabledModels；ProviderInfo 加 kind；catalog/custom 分体系 UI（移除语义、操作收窄）；存量迁移。
- **out-of-scope**：pi 源码改动（架构约定禁止）；孤儿配置清理（config.toml / model-db.json，独立前置任务）；已有 session 配置生效时序（软重启提示，正交维度）；**经 enabledModels pattern（`provider/specific-model`）的 model 级 toggle**——注意 **model 级 `model.enabled` 字段（W2 已上线）保留**，aggregateModels 继续过滤；provider 级（enabledModels 派生）与 model 级（model.enabled）两层过滤在 aggregateModels 叠加（见决策3 两层过滤）。

---

## §2 现状与问题分析

### 2.1 使用者视角：导入后列表空白

用户在 Settings → 从其他 agent 导入，选中 pi 的 `xiaomi-token-plan-cn`（pi 的 `~/.pi/agent/auth.json` 有 `{type:"api_key", key:"..."}`，pi models.json 无该 provider——定义在 pi catalog）。导入完成后：

```
[Settings → Provider 页] 空状态「还没有供应商」  ← 导入明明成功了
[dev 数据目录实证]
  ~/.xyz-agent-dev/pi/agent/models.json → providers: {} （空）
  ~/.xyz-agent-dev/pi/agent/auth.json  → { "xiaomi-token-plan-cn": {...} } （凭据写入了）
```

**导入流程返回 `status: imported`（成功），但 provider 卡片不出现**。比前一轮分析的「能选不能用」更严重：连选都看不见。

### 2.2 pi 的两套 provider 体系（源码审计权威）

> 结论：pi 有 catalog 与 custom 两套正交体系，判据唯一——providerId 是否在 pi catalog。以下结论基于 pi-mono 源码，每条附文件:行号。

**体系 A · catalog provider = pi 内置 catalog（定义）+ auth.json（凭据）**

- catalog 是 pi 二进制内置（`models.generated.ts` 构建产物），经 `getBuiltinProviders()` 暴露。当前 37 个 provider（含 xiaomi-token-plan-cn / deepseek / anthropic / ...）。**不是磁盘文件，xyz-agent 不读写。**
- 每个 catalog provider 的 baseUrl/api/models 声明时写死，运行时只可经 models.json override（baseUrl/compat）。**用户不在 models.json 建条目**（除非 override，如走代理只写 baseUrl）。
- 凭据归宿：auth.json（`/login` 写入，pi `auth-storage.ts`）/ 环境变量（`env-api-keys.ts` 硬编码 provider→env-var 表）/ `--api-key`。

**体系 B · custom provider = models.json 全配置**

- models.json 定义一切：`{baseUrl, api, apiKey, models, ...}`。用于 Ollama/LM Studio/代理/任何兼容服务。
- apiKey 留 models.json 是合法归宿（`model-registry.ts:225` apiKey Optional + `:731` getApiKeyAndHeaders 定义 / `:735` authStorage.getApiKey `{includeFallback:false}` 不回退 env，models.json apiKey 作 fallback）。

**判据（唯一）**：providerId 是否在 pi catalog。xyz-agent 用自维护的 `builtin-providers.json` 副本（`provider-catalog.ts:isCatalogProvider`）作近似判据（决策见 §3.3 决策5）。

### 2.3 现状盘点：前一轮设计的 6 个决策实施状态

前一轮设计（方案 A「分体系处理」）的 6 个决策，代码已实施 5 个、漏 1 个，且**展示层与 enable 状态是当时的设计盲点**：

| 决策 | 内容 | 实施状态 |
|---|---|---|
| 1 | importer 分路（catalog 不写 models.json） | ✅ `provider-importer.ts` 组1/组2 都有 `isCatalogProvider` 分支，`continue` 跳过写 models.json |
| 2 | AuthStorage 扩展 api_key + hasCredentialSync | ✅ `auth-storage.ts:25` ApiKeyCredential + `:163` hasCredentialSync |
| 3 | setProvider 分体系 | ✅ `config-service.ts:281` catalog→auth.json |
| 4 | findValidDefaultModel 兜底 catalog | ✅ `pi-provider-store.ts:315` 读 auth.json 找 catalog 候选 |
| 5 | catalog 判据（builtin 副本） | ✅ `provider-catalog.ts` |
| 6 | 存量迁移（分体系） | ❌ 未实施 |
| **展示层 listProviders 聚合** | **当时盲点** | ❌ `config-service.ts:182` 只遍历 `models.providers`，不展示纯 auth.json 凭据的 catalog provider |
| **enable 状态承载** | **当时盲点** | ⚠️ 散落 models.json `provider.enabled`（config-service.ts:224 读 / :305 写），pi 用 settings.json.enabledModels 控制 composer（决策3） |

### 2.4 物理数据流：现状（断裂点）

**路径 A · 导入 + 列表显示（F1 断裂）**

```
[导入源 pi: ~/.pi/agent/]
  auth.json  ─┐  {xiaomi-token-plan-cn: {type:api_key, key}}   ← 体系 A 凭据层
  models.json └─ {} （定义在 pi catalog 二进制内置）             ← 体系 A 无需条目
              │
              ▼  provider-importer.ts（决策1 已实施：catalog 分支）
[catalog 分支] authStorage.set(...) 写 auth.json → continue（不写 models.json）  ✅ 正确
              │
              ▼  config-service.listProviders（❌ F1 断裂点）
[listProviders] 只遍历 models.json.providers → providers:{} → 返回 [] 
              │   （catalog provider 没有条目，不出现）
              ▼
[ProviderPage] 空状态  ← 用户看到「没有供应商」
```

**路径 B · composer 模型显示（F2 断裂）**

```
[ProviderPage toggle 禁用] → config.setProvider(id, {enabled:false})
              │
              ▼  config-service.setProvider（:305 写 models.json provider.enabled）
[models.json] providers[id].enabled = false
              │
              ▼  config-service.listProviders（:224 读 provider.enabled → ProviderInfo.enabled=false）
[ProviderInfo.enabled=false]
              │
              ▼  model-service.aggregateModels（:120 过滤 p.enabled!==false）  ← xyz-agent composer 门
[composer 显示] 该 provider 的 model 不显示  ✅ xyz-agent 侧生效
              │
              ▼  BUT pi session 启动读 settings.json.enabledModels（不看 models.json provider.enabled）
[pi session] enabledModels=undefined（全可用）→ scopedModels=全部 → composer cycling 仍显示该 model
              ❌ xyz-agent 禁用了，pi 侧仍可用（F2：两端不一致）
```

**两条断裂的根因**：
- **F1（展示层不聚合）**：`listProviders` 是 models.json 遍历器，不知道 catalog provider 的存在。前一轮分析的前提（importer 写 models.json 残缺条目 → listProviders 靠条目兜底显示）已被决策1（importer 分路）推翻。
- **F2（enable 无承载）**：enable 散落 models.json provider.enabled，xyz-agent composer 经 aggregateModels 认它（路径 B 上半段生效），但 **pi session 用 settings.json.enabledModels**（路径 B 下半段不通），两端不一致。

### 2.5 根因与失败模式

| 失败模式 | 表现 | 根因 |
|---|---|---|
| F1 展示层不聚合 | catalog provider 导入后列表空白 | `listProviders` 只遍历 models.json，不合并 auth.json 凭据的 catalog provider |
| F2 enable 无承载 | xyz-agent UI 禁用与 pi session composer 不一致 | enable 散落 models.json provider.enabled，pi 用 settings.json.enabledModels 控制 composer |
| F3 catalog 移除语义错 | 删除按钮对 catalog provider 试图删 pi catalog 定义（不可能） | renderer 不区分 kind，删除对所有 provider 一视同仁 |
| F4 存量未迁移 | 老用户 catalog 错位 apiKey + 旧 provider.enabled 残留 | 决策 6 未实施 |

---

## §3 解决方案

### 3.1 终态（使用者视角）

**成功路径 · 导入 catalog provider 并显示**

```
[用户] Settings → 从其他 agent 导入 → 选 xiaomi-token-plan-cn
[importer] catalog 分支：凭据 → auth.json，models.json 不建条目  （决策1，已实施）
[importer 白名单守卫] 若 enabledModels 已非空 → 自动把 xiaomi-token-plan-cn/* 加入  （决策3 边界）
[listProviders 聚合层] auth.json keys ∪ models.json catalog keys ∩ builtin
  → 收录 xiaomi-token-plan-cn（kind='catalog'，apiKeySet=true）
  → enabled 派生：<id>/* 匹配 enabledModels → true
[ProviderPage] 显示卡片  ✅ G1 修复
[pi session] 读 catalog（定义）+ auth.json（凭据）→ 可用  ✅
```

**成功路径 · provider 启用/禁用联动 composer（双消费）**

```
[用户] 在 ProviderPage 禁用 custom provider "my-router"
[runtime] enabledModels 重算：移除 "my-router/*" pattern
[settings.json.enabledModels] 更新
  ├─ [xyz-agent] listProviders 派生 my-router 的 enabled=false → aggregateModels 过滤 → composer 不显示  ✅
  └─ [pi session] 读 settings.json.enabledModels → resolveModelScope → scopedModels 不含 my-router  ✅ G2
[defaultModel 守卫] 若 my-router 承载 defaultModel → 重选 default  （决策3 边界）
```

**成功路径 · 移除 catalog provider（不删定义）**

```
[用户] 点 catalog provider 卡片的「移除」
[runtime] 清 auth.json 凭据 + 清 models.json override 条目（如有）+ 清 enabledModels 残留 `<id>/*`  （决策4）
           └─ 清残留若使白名单为空 → 边界3(a) 守卫：删除 enabledModels 字段（置 undefined），不写空数组
[listProviders 聚合层] 该 provider 不再被收录（无凭据无 override）→ 从列表消失
[pi catalog] 定义仍在（二进制内置，未触碰）→ 用户随时可重新添加  ✅ G4
```

**失败路径 · catalog 副本滞后（带恢复指引）**

```
[场景] pi 升级新增 catalog provider "new-prov"，xyz-agent builtin 副本未同步
[聚合层] isCatalogProvider("new-prov")=false（副本不识）→ 误判为 custom
       → 但 models.json 无 new-prov 条目（定义在 pi catalog）→ 无 name/api/baseUrl/models 可聚合
       → 聚合层不收录（custom 分支要求 models.json 有条目）
[后果] new-prov 在 xyz-agent provider 列表不显示；其孤儿凭据导入时 matchBuiltinTemplate 未命中 → status:failed
       （注：滞后导致的是 xyz-agent 聚合层/导入层不收录，不是 pi resolveModelScope 0 命中——
        pi 的 resolveModelScope 匹配 pi 自己的 modelRegistry，pi 知道自家 catalog，不受 xyz-agent 副本影响）
[恢复] 运行 gen-builtin-providers.mjs 刷新 builtin 副本 → isCatalogProvider 命中 → 聚合层收录 + 导入可用
```

### 3.2 多方案对比（强制 ≥2）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 双体系聚合 + enabledModels SSOT**（listProviders 双源合并+kind / enable 统一 enabledModels 派生 enabled / 分体系 UI / 存量迁移） | ✅ 完全对齐 pi：展示聚合双体系、enable 有原生承载、catalog 移除不删定义。renderer 只消费统一模型 | 中（聚合层 + ProviderInfo.kind + enabledModels 双消费 + UI 分体系 + 迁移，约 4-5 wave） | 中（enabledModels 白名单边界见决策3；catalog 副本滞后窗口见决策5） | ✅ **推荐** |
| B. 只补展示层（listProviders 合并 auth.json 凭据的 catalog provider，不加 kind、enable 仍留 models.json） | ⚠️ 展示对了但 enable 仍散落 models.json provider.enabled，pi 不消费它 → F2 残留；renderer 仍需自己判 catalog 区分移除语义（kind 缺失） | 低（1-2 wave） | 高（enable 不统一，UI 与 composer 长期不一致；无 kind 字段 renderer 无法干净区分操作） | ❌ |
| C. listProviders 合并全部 37 个 catalog provider（不区分有无凭据，全显示） | ⚠️ 列表膨胀 30+ 卡片，对存量用户冲击大；未配凭据的 catalog provider 显示「未配置」噪声大 | 中 | 高（UX 退化；与 pi /login 的浏览体验混淆） | ❌ |

**推荐方案 A**。理由：F1/F2/F3/F4 同源于「展示层不聚合 + enable 无承载」，A 一次性消除；B 的「展示对但 enable 散落」会在每次 provider toggle 制造 UI/composer 不一致；C 的列表膨胀违背「只显示用户配过的」现状语义。

**若用方案 B，§3.1 的终态**：导入 catalog provider 能显示了，但用户禁用 provider 后 pi session composer 仍显示其 model（F2 未修），且 renderer 要靠 `isCatalogProvider` 副本判据自行区分移除语义（kind 缺失，判据逻辑泄漏到 renderer）。

**若用方案 C，§3.1 的终态**：设置页突然冒出 37 个 provider 卡片，30 个标「未配置」，用户要在噪声里找自己配过的。

### 3.3 关键决策与权衡

#### 决策 1：runtime 聚合层（listProviders 双源合并 + kind 标注 + enabledModels 派生 enabled）

- **选择**：`config-service.listProviders` 重构为双体系聚合器：
  - **custom**：遍历 `models.json.providers`，`id ∉ catalog` 的条目 → `kind:'custom'`，全配置来自 models.json。
  - **catalog**：`(auth.json keys ∪ models.json catalog keys) ∩ builtin` → `kind:'catalog'`。name/api/baseUrl/models 优先取 models.json override，否则取 builtin 副本；`apiKeySet = id ∈ auth.json`。
  - **enabled 派生（裁定 F2 落点）**：`ProviderInfo.enabled = (enabledModels == null || enabledModels.length === 0) ? true : enabledModels.some(p => p === '<id>/*' || p.startsWith('<id>/'))`（undefined/空 = true 全启用；非空 = 白名单匹配）。**model 级 pattern 处置**：若 enabledModels 含 `A/x`（非 `A/*`），provider A 派生 enabled=true（视为已启用——避免 aggregateModels 整体过滤掉 A 与 pi resolveModelScope 单 model 命中不一致）；具体 model 的显示由 aggregateModels model 级过滤 + pi scopedModels 精确控制。**过滤落在 listProviders 派生 enabled**，下游 `model-service.aggregateModels` 职责不变（继续 `p.enabled !== false` + `m.enabled !== false` 两层过滤，见决策3 两层过滤）。
  - renderer 拿到带 `kind` 的 `ProviderInfo[]`，**不直接接触 models.json/auth.json/settings.json**。
- **被否**：维持 models.json 遍历器（现状）—— F1 根因。
- **证据**：pi 双体系判据（§2.2）；聚合是「让 renderer 不懂两套体系 + enable 单一过滤点」的唯一干净方式。

#### 决策 2：ProviderInfo 加 kind 字段（shared SSOT）

- **选择**：`shared/src/provider.ts` 的 `ProviderInfo` 新增：
  ```ts
  export type ProviderKind = 'catalog' | 'custom'
  export interface ProviderInfo {
    // ...现有字段不动
    /** 体系来源，聚合层标注。catalog=定义来自 pi catalog；custom=定义全在 models.json */
    kind: ProviderKind
    /** catalog provider 是否有 models.json override 条目；custom 恒 undefined */
    hasOverride?: boolean
  }
  ```
- **用途**：renderer 据 `kind` 收窄操作（决策4）；据 `hasOverride` 判断「移除」会清掉什么。
- **被否**：不加 kind，renderer 自行调 `isCatalogProvider` —— 判据逻辑泄漏到 renderer，违反「renderer 只消费聚合模型」。

#### 决策 3：enabledModels 作为 enable 状态唯一承载（双消费 SSOT）

- **选择**：provider 的启用/禁用统一用 `settings.json.enabledModels` 承载，**废弃 models.json `provider.enabled` 的 UI 语义**（存量迁移见决策6）。**xyz-agent UI 与 pi session 双消费**：
  - **xyz-agent composer**：聚合层（listProviders）从 enabledModels 派生 `ProviderInfo.enabled` → `aggregateModels` 过滤（职责不变）→ composer 显示。
  - **pi session**：pi 启动读 settings.json.enabledModels → `resolveModelScope`（minimatch glob）→ `session.scopedModels` → cycling 范围。
- **pi 源码证据（运行时断言，✅ 已验证）**：
  - `settings-manager.ts:115` `enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)`
  - `main.ts:690-692` `modelPatterns = parsed.models ?? settingsManager.getEnabledModels()` → `resolveModelScope(modelPatterns, modelRegistry)` → `scopedModels`，**空数组/undefined → scopedModels=[] → cycling 回退全部可用**（`interactive-mode.ts:4327` `scopedModels.length>0 ? scopedModels : getAvailable()`）
  - `model-resolver.ts:297` `minimatch(fullId, globPattern, {nocase:true}) || minimatch(m.id, globPattern)`，**pattern 是 minimatch glob，匹配 `provider/model` 或纯 model id**，`provider/*` 匹配整个 provider
  - `agent-session.ts:1568` `scopedModels.filter(scoped => modelRegistry.hasConfiguredAuth(scoped.model))`，**scopedModels 再过一道凭据校验**（与聚合层 status 判定一致）
- **两层过滤（provider 级 + model 级在 aggregateModels 叠加）**：
  - **provider 级**：`ProviderInfo.enabled`（listProviders 从 enabledModels 派生，`<id>/*` 是否在白名单）—— provider 级 toggle 的承载。
  - **model 级**：`model.enabled`（models.json 的 W2 已上线字段）—— 单个 model 的启停，经 setProvider model 级编辑写入。
  - aggregateModels 保持 `p.enabled !== false && m.enabled !== false`，两层正交叠加。
- **维护策略（provider 级 toggle → pattern 映射 + 边界）**：xyz-agent 维护 enabledModels 为「所有启用 provider 的 `<id>/*` pattern 列表」。
  - 初始：undefined（全可用，向后兼容现状）。
  - toggle provider X 禁用：重算 enabledModels = 所有仍启用 provider 的 `X/*`。**首次禁用时，从 undefined 切换到显式白名单**（列出所有其他启用 provider）。
  - toggle provider X 启用：把 `X/*` 加回列表。
  - **边界 1（白名单存在时新增 provider）**：导入（importer）或 setProvider 新建 provider 时，**若 enabledModels 已是非空白名单，自动把 `<id>/*` 加入**——否则一旦用户做过任何禁用，之后导入的 provider 都会因不在白名单而默认关闭（UX 不一致）。若 enabledModels 仍 undefined 则不动（保持全可用）。
  - **边界 2（defaultModel 守卫）**：禁用 provider 时若其承载 `defaultModel`，需重选 default——否则 pi session scopedModels 不含该 provider，defaultModel 与 scope 错位可能触发 pi 兜底/报错。
  - **边界 3（白名单非空不变式 + 全禁用架构限制）**：pi 的 enabledModels 是白名单语义（空=不限制=全可用），与 xyz-agent 想表达的「启用集合」（空=全禁用）**方向相反**。本架构**无法表达「全禁用」**——enabledModels 写空数组会让两端都回退到全可用（pi `interactive-mode.ts:4327` else 回退 `getAvailable()`；决策1 派生空=true），语义与用户意图相反（危险：用户以为禁用=停止 API 调用/计费，实际全可用）。故：(a) **任何写 enabledModels 的操作（toggle / 移除清残留 / 迁移重算）后若白名单为空，一律不写空数组——删除 enabledModels 字段（置 undefined），非「跳过写入」**（跳过会残留旧 pattern；旧 pattern 对 catalog provider 会在 pi 侧 resolveModelScope 匹配 catalog 定义 → scopedModels 空 → pi 回退全可用 → 复现本边界要防的语义反转）。undefined 在 pi 语义仍是全可用，故必须配合 (b)；(b) **UI 约束：toggle 禁用最后一个启用 provider 时拒绝 + 提示「至少保留一个 provider 启用；全部停用请用移除」**（移除路径因 (a) 守卫不会写空数组，但移除后用户可能处于「全部移除」状态——此时 enabledModels 保持 undefined/全可用属合理，因为已无 provider 可选）；(c) 这是 pi 契约的硬限制（xyz-agent 不改 pi 源码），文档显式声明，非缺陷。
  - 用 `provider/*` 而非枚举具体 model：catalog provider 的 model 来自 pi catalog（动态），xyz-agent builtin 副本可能滞后；`provider/*` glob 绕开枚举，pi 侧 resolveModelScope 实时匹配 catalog 全部 model。
- **被否 A**：继续用 models.json `provider.enabled` —— **pi 根本不消费它控制 composer**（这是 F2 根因本身）：pi session 启动读 settings.json.enabledModels，不读 models.json provider.enabled；写 provider.enabled 对 pi composer 无效，UI 与 composer 永远不一致。
- **被否 B**：用 models.json override-only `{enabled:false}` 条目存 catalog provider 的禁用态。**主因同被否 A**（pi 不读 provider.enabled，写了对 pi 无效）。额外障碍分情况：**custom provider** 会被 xyz-agent `isInvalidProvider`（`pi-provider-store.ts:742`，五字段全缺即删）清掉、且 pi `validateConfig`（`model-registry.ts:559-601`）对空壳（models.length===0）校验五字段会拒绝；**catalog provider** 的 override-only 空壳：xyz-agent `sanitizeInvalidProviders`（`pi-provider-store.ts:772`，**注意是 xyz-agent 的函数非 pi 的**）先走 MF-5 修复分支（合并 builtin models 使其非空壳）不删除，pi `validateConfig` 对**带 models 的** builtin provider 跳过 baseUrl 校验（`:578`）——即 catalog 空壳靠 xyz-agent sanitize 先合法化才不被 pi 拒，**非**「pi 对 builtin 跳过五字段校验」（pi 对空壳的五字段校验不区分 builtin，`:570-576`）。结论（override-only 条目不可靠）对，但根本原因是 pi 不认 provider.enabled。
- **代价（如实标注）**：enabledModels 非空后是全局白名单（pi 语义），xyz-agent 每次 toggle/新增 provider 都要重算完整列表（聚合层需知道全部 provider，决策1 已满足）。toggle 写入链路改造：现有 `ProviderPage.onToggleEnabled → config.setProvider(id,{enabled})`（走 setProvider :305 写 models.json provider.enabled）改为 **toggle 写 enabledModels**（setProvider 的 provider.enabled 写入 :305 停用，详见 §4.3 消费点处置）。

#### 决策 4：catalog 移除语义（不删定义）+ 操作收窄

- **选择**：按 `kind` 收窄 renderer 操作：
  | 操作 | catalog | custom |
  |---|---|---|
  | 启用/禁用 Switch | 渲染（toggle 写 enabledModels） | 渲染（toggle 写 enabledModels） |
  | 删除/移除 | 文案「移除」：清 auth.json 凭据 + 清 models.json override + 清 enabledModels 残留 `<id>/*`（保持聚合层与白名单一致）。**不删定义**（pi catalog 二进制内置）。注：清残留若使白名单变空，触发决策3 边界3(a) 空数组守卫（删除 enabledModels 字段置 undefined，不写空数组） | 文案「删除」：删 models.json 条目 + 清 enabledModels 残留 `<id>/*` |
  | 编辑 models 定义 | 不开放（定义归 pi catalog） | 完整编辑 |
  | 改 baseUrl（代理） | 写 models.json override-only 条目 | 写 models.json 全配置 |
- **被否**：删除对所有 provider 一视同仁（现状）—— catalog 无定义可删，语义错误（F3）。
- **证据**：pi catalog 定义在二进制内置（§2.2），xyz-agent 无法删除；`/login` 的「remove stored key」（`interactive-mode.ts:5030`）也是清凭据不删定义。

#### 决策 5：catalog 判据来源（builtin 副本 + 滞后窗口标注）

- **选择**：维持 xyz-agent 自维护的 `builtin-providers.json` 副本（`provider-catalog.ts:isCatalogProvider`）作 catalog 判据 + UI 展示。判据 = `builtinProviders.some(p => p.id === providerId)`。
- **滞后后果（已核实，非「功能不坏」）**：副本滞后（pi 升级新增 catalog provider，副本未同步）时：
  - **聚合层**：新 provider 被误判为 custom（isCatalogProvider=false），但其定义在 pi catalog、models.json 无条目 → custom 分支要求 models.json 有条目 → 聚合层不收录（无 name/api/baseUrl 可聚合）。表现为 provider 列表不显示。
  - **导入层**：孤儿凭据 matchBuiltinTemplate 未命中 → `status:'failed'`（reason: no built-in template match）。
  - **安全性（滞后+重算论证）**：滞后 provider 在 xyz-agent 侧不收录（聚合/导入都不进）→ auth.json 无其凭据 → 不会被 enabledModels 重算收录 → pi 侧也无凭据不可用。**两端一致（安全）**，不会出现「xyz-agent 显示但 pi 不可用」的错位。pi 升级刷新副本后恢复。
- **强制缓解**：副本同步是 pi 升级的显式必经步骤——刷新 `builtin-providers.json`（`gen-builtin-providers.mjs`）+ 回归测试断言副本 id 全集 ⊇ pi `getProviders()` 全集。
- **被否**：RPC 查 pi 子进程 `getProviders` —— pi 子进程可能未启动（离线导入场景），每次导入/聚合 RPC 往返成本高。
- **证据**：副本当前角色是 UI 展示/判据（非运行时定义权威，定义权威是 pi 二进制 catalog）。

#### 决策 6：存量迁移

- **选择**：启动时幂等迁移，分三步：
  1. **catalog provider 错位 apiKey 清理**（models.json 有 catalog providerId 条目且含 apiKey）→ 秘钥迁 auth.json，删 apiKey；若条目只剩 override（baseUrl/compat）则保留 override-only 条目，否则删整个条目。
  2. **旧 provider.enabled → enabledModels 迁移**（幂等：仅当 models.json 存在 provider 级 enabled 字段时执行；迁移删除该字段后，后续启动 no-op，与 step1 同模式——避免重启时重算覆盖用户后续 toggle 禁用）：扫描 models.json 所有 `enabled===false` 的 provider，重算 enabledModels = 所有 `enabled!==false` 的 provider 的 `<id>/*` pattern（首次写入即从 undefined 切到显式白名单）。**空数组守卫**：若所有 provider 均 enabled===false（罕见），重算得空数组——不写空数组，**删除 enabledModels 字段（置 undefined），非跳过写入**（避免残留旧 pattern 复现决策3 边界3 语义反转），warn「检测到所有 provider 均已禁用，已保留全部可用；请手动移除不需要的 provider」。**defaultModel 重选**：若迁移后 defaultModel 落在 enabledModels 白名单外，重选 default（或依赖 findValidDefaultModel 运行时 enabledModels 过滤兜底，见 §4.3）。迁移后**删 models.json 的 provider 级 `enabled` 字段**（enable 语义归 enabledModels；model 级 `model.enabled` 保留）。
  3. **OAuth 冲突优先**：catalog provider 迁移时 auth.json 已有 OAuth → OAuth 优先，跳过 apiKey 迁移，warn。
- **已有 session 时序（如实标注）**：迁移在启动期完成。pi 的 AuthStorage 无文件监听（`reload()` 仅在构造/persist/OAuth 刷新三处调用，`auth-storage.ts:212/276/506`），故已有 session 不自动感知 auth.json/settings.json 改动，需新建/恢复 session。迁移日志应提示用户重启 session。属生效时序（out-of-scope），但迁移日志须提示。
- **被否**：不迁移 —— 老用户 catalog apiKey 永久散落 models.json（0644 明文），旧 enabled 语义与 composer 不一致。
- **错误恢复**：迁移失败不阻断启动，warn + 下次重试。

#### 运行时行为断言探针清单（准则 7）

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-enabledmodels-semantics | enabledModels 空=全可用、非空=白名单 | pi `main.ts:690-692` + `interactive-mode.ts:4327` | ✅ 已验证（源码审计） |
| P-pattern-format | pattern 是 minimatch glob，`provider/*` 匹配整个 provider | pi `model-resolver.ts:282-297` | ✅ 已验证（源码审计） |
| P-scoped-auth-filter | scopedModels 过 hasConfiguredAuth | pi `agent-session.ts:1568` | ✅ 已验证（源码审计） |
| P-no-file-watch | AuthStorage 无文件监听，已有 session 不感知 auth.json 改动 | pi `auth-storage.ts` reload 调用点仅 3 处（212/276/506） | ✅ 已验证（源码审计） |
| P-xyz-write-enabledmodels | xyz-agent 写 settings.json.enabledModels 后 pi session 的 composer cycling 生效 | 实施后写 enabledModels=["deepseek/*"]，spawn session，`/model` 只见 deepseek | ⛔ 实施期门（决策3 wave） |
| P-toggle-recompute | toggle provider 后 enabledModels 重算正确（首次禁用从 undefined→显式白名单） | 实施后造 3 provider，禁用 1 个，断言 enabledModels=其余 2 个的 `<id>/*` | ⛔ 实施期门（决策3 wave） |
| P-new-provider-whitelist | 白名单存在时导入/新建 provider 自动加入 `<id>/*`，不默认关闭 | 实施后先禁用某 provider（白名单非空），再导入新 provider，断言新 provider 的 `<id>/*` 在 enabledModels 内 + UI 显示为启用 | ⛔ 实施期门（决策3 边界1） |
| P-disable-default-provider | 禁用承载 defaultModel 的 provider 时重选 default，不与 scope 错位 | 实施后设 defaultModel=A/x，禁用 A，断言 defaultModel 重选 + pi session 启动不报错 | ⛔ 实施期门（决策3 边界2） |
| P-aggregate-merge | 聚合层合并 custom+catalog，kind 标注正确，enabled 从 enabledModels 派生 | 实施后造 models.json custom + auth.json catalog，断言 listProviders 返回两者且 kind/enabled 正确 | ⛔ 实施期门（决策1 wave） |
| P-composer-filter-source | composer 过滤经 listProviders 派生的 enabled（aggregateModels 不改过滤源） | 实施后聚合层从 enabledModels 派生 enabled，断言 aggregateModels 仍读 p.enabled/m.enabled 且行为正确 | ⛔ 实施期门（决策1/3 wave） |
| P-migrate-enabled | 旧 provider.enabled 迁移到 enabledModels，models.json provider 级 enabled 字段清除（model.enabled 保留） | 实施后造 models.json 含 enabled:false provider，跑迁移，断言 enabledModels 含其他 provider pattern + models.json 无 provider 级 enabled 字段 | ⛔ 实施期门（决策6 wave） |
| P-empty-whitelist | 白名单变空时不发生两端语义反转（pi scopedModels 非全部可用 + xyz-agent composer 非全显示） | 实施后三条路径全测：①造所有 provider disabled 的存量配置跑迁移（断言删除字段置 undefined 不写空数组 + warn）；②UI 逐个禁用到最后一个（断言拒绝 + 提示）；③逐个移除最后一个 provider（断言清残留后删除字段置 undefined + 无两端语义反转） | ⛔ 实施期门（决策3 边界3 + 决策4 移除 + 决策6 step2） |

---

## §4 下一层拆分

### 4.1 实施路径（阶段化）

```
[阶段 1] ProviderInfo 加 kind/hasOverride（shared SSOT）
         └─ 类型扩展，聚合层/UI 还没消费，纯类型层无风险

[阶段 2] listProviders 双体系聚合层 + enabledModels 派生 enabled
         └─ 合并 models.json(custom) + auth.json/builtin(catalog) + kind 标注
         └─ enabled 从 settings.json.enabledModels 派生（<id>/* minimatch）
         └─ aggregateModels 不改（继续读 p.enabled/m.enabled 两层过滤）
         └─ 验证：P-aggregate-merge + P-composer-filter-source → G1 修复

[阶段 3] enabledModels 双消费（enable SSOT）+ toggle 写入链路改造
         └─ toggle 改写 enabledModels（废弃 setProvider:305 的 provider.enabled 写入）
         └─ importer/setProvider 新建 provider 时白名单守卫（边界1）
         └─ defaultModel 守卫（边界2）
         └─ 验证：P-xyz-write-enabledmodels + P-toggle-recompute + P-new-provider-whitelist + P-disable-default-provider + P-empty-whitelist → G2

[阶段 4] 分体系 UI（ProviderPage 按 kind 收窄）
         └─ catalog 无「编辑 models」+ 移除文案/行为 + custom 完整 CRUD
         └─ 验证：catalog 移除只清 auth.json+override，pi catalog 定义不动 → G3/G4

[阶段 5] 存量迁移（分体系 + enabled 迁移）
         └─ catalog 错位 apiKey 清理 + 旧 provider.enabled → enabledModels + OAuth 冲突优先
         └─ 删 models.json provider 级 enabled 字段（model.enabled 保留）
         └─ 验证：P-migrate-enabled → G5
```

### 4.2 下一层单元拆分清单 + justification

| 单元 | 改动 | justification |
|---|---|---|
| ProviderInfo kind/hasOverride | `shared/src/provider.ts` 加 ProviderKind 联合 + 两字段 | 类型层先行，聚合/UI 消费的前提（决策2） |
| listProviders 聚合 + enabled 派生 | `config-service.ts` 双源合并 + kind 标注 + 读 auth.json + 从 enabledModels 派生 enabled | F1 根因修复 + F2 过滤落点（决策1） |
| toggle 写 enabledModels | ProviderPage.onToggleEnabled 改走 enabledModels（重算白名单），setProvider :305 provider.enabled 写入停用 | G2 写入侧（决策3） |
| toggle 边界守卫 | importer/setProvider 新建 provider 白名单守卫 + defaultModel 守卫 + 空数组守卫（拒绝禁用最后一个） | 决策3 边界1/2/3（防 UX 不一致 + scope 错位 + 两端语义反转） |
| ProviderPage 按 kind 收窄 | catalog 无编辑 models + 移除文案/行为；custom 完整 CRUD | F3 修复（决策4） |
| catalog 移除 RPC | 清 auth.json 凭据 + 清 models.json override + 清 enabledModels 残留 `<id>/*` + 边界3(a) 空数组守卫，不删定义 | 决策4 移除语义（避免残留 pattern 导致 pi resolveModelScope 匹配已清凭据的 catalog provider） |
| 存量迁移 | 启动迁移：catalog 错位 apiKey 清理 + 旧 enabled→enabledModels + 空数组守卫（边界3(a)）+ 删 provider 级 enabled 字段 | G5（决策6） |
| 迁移测试 | 分体系幂等 + OAuth 冲突优先 + enabled 迁移边界（model.enabled 保留）+ P-empty-whitelist（迁移至空 / 移除至空 / toggle 至最后一个） | 数据安全关键 |

### 4.3 provider.enabled 消费点逐点处置 + 文件改动地图

**provider.enabled 读/写/过滤消费点（实测核实）**：

| 消费点 | 位置 | 当前行为 | 本设计处置 |
|---|---|---|---|
| 读 | `config-service.ts:224` listProviders | `enabled: config.enabled !== false` | **改为从 enabledModels 派生**（`<id>/*` 是否匹配） |
| 过滤 | `model-service.ts:120` aggregateModels | `p.enabled !== false` | **不改**（读 ProviderInfo.enabled，来源变了但消费不变；model 级 `m.enabled` W2 保留） |
| 写（provider 级） | `config-service.ts:305` setProvider | `merged.enabled = data.enabled` | **停用**（toggle 改走 enabledModels；迁移后 models.json 不再有 provider 级 enabled） |
| 写（model 级） | `config-service.ts:333` setProvider | model.enabled 写入 | **保留**（W2 model 级 toggle，与 provider 级 enabledModels 正交） |
| findValidDefaultModel | `pi-provider-store.ts:289-345` | **不读 provider.enabled**（已核实，安全）；但 catalog 兜底分支（:330-340）找「凭据可解析」provider 作 default 时**不查 enabledModels 范围** | **需改**：catalog 兜底过滤 enabledModels 白名单（避免返回被禁用 provider 的 model 作 default，与 scopedModels 错位） |

**文件改动地图**：

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `packages/shared/src/provider.ts` | 改 | ProviderKind 联合 + ProviderInfo 加 kind/hasOverride |
| `packages/runtime/src/services/config-service.ts` | 改写 | listProviders 双源聚合 + kind 标注 + enabled 从 enabledModels 派生；setProvider :305 provider 级 enabled 写入停用（:333 model 级保留） |
| `packages/runtime/src/services/model-service.ts` | **不改** | aggregateModels 职责不变（读 p.enabled/m.enabled，来源由 listProviders 保证） |
| `packages/runtime/src/infra/pi/pi-provider-store.ts` | 改 | getEnabledModels/setEnabledModels 接入聚合层（已有，复用）；findValidDefaultModel catalog 兑底过滤 enabledModels 白名单（避免返回被禁用 provider 的 model 作 default）；removeProvider 扩展清 enabledModels 残留 `<id>/*` + 边界3(a) 空数组守卫 |
| `packages/runtime/src/services/migration/provider-importer.ts` | 改 | 白名单守卫（导入时若 enabledModels 非空自动加 `<id>/*`） |
| `packages/renderer/src/components/settings/provider/ProviderPage.vue` | 改 | 按 kind 收窄操作（移除文案、编辑限制）；Switch toggle 走 enabledModels |
| `packages/runtime/src/index.ts` | 改 | 启动迁移编排（决策6） |
| `packages/runtime/src/services/__tests__/config-service.test.ts` | 改 | 聚合层契约 + kind 标注 + enabled 派生测试 |
| `packages/runtime/src/services/__tests__/*migrate*.test.ts` | 新增 | 存量迁移分体系测试 |

### 4.4 待验证检查点

- ⛔ **P-xyz-write-enabledmodels**：xyz-agent 写 settings.json.enabledModels 后 pi session composer 是否生效（决定决策3 双消费是否真成立）。阶段 3 必跑。
- ⛔ **catalog 副本同步纪律**：builtin-providers.json 副本与 pi catalog 版本同步策略（pi 升级时 gen-builtin-providers.mjs 刷新 + 回归断言）。决策5 缓解。
- ⛔ **迁移对已有 session 的影响**：存量迁移改 settings.json/auth.json 后，已有 session 不感知（无文件监听），需提示用户重启 session。决策6 已标注，属生效时序 out-of-scope。

---

## 附录：与 pi 源码的契约边界

本设计所有改动在 xyz-agent 侧，依赖但不修改 pi 的以下契约（pi-mono main 分支）：

| pi 契约 | 内容（源码证据） | xyz-agent 依赖方式 |
|---|---|---|
| `PI_CODING_AGENT_DIR` | pi 配置根（rpc-client.ts 注入） | pi 读 `<dir>/auth.json`/`models.json`/`settings.json` |
| pi catalog 定义权威 | 二进制内置（`models.generated.ts` 编译产物），非磁盘文件 | xyz-agent 不读写；pi 子进程自带 |
| 两套体系判据 | `getProviders()` 返回 catalog provider id | xyz-agent 用 builtin-providers.json 副本近似判据（决策5） |
| enabledModels 语义 | composer 可选白名单（minimatch glob，空=全可用） | xyz-agent 写 settings.json.enabledModels，pi 与 xyz-agent 双消费（决策3） |
| auth.json schema | `{providerId:{type,key,env?}}`（ApiKeyCredential/OAuthCredential） | xyz-agent AuthStorage 按此写（决策2 前一轮已实施） |
| 凭据优先级链 | runtime override > auth.json > models.json apiKey | catalog 凭据 auth.json（链位高）；custom 凭据 models.json（fallback） |
| auth.json/settings.json 读取时机 | 无文件监听：`reload()` 仅在构造/persist/OAuth 刷新三处（212/276/506） | 已有 session 不感知改动，迁移须先于 session spawn（决策6） |
| pi 不读 models.json provider.enabled | pi session 启动读 settings.json.enabledModels 控制 composer cycling，不读 models.json provider.enabled | F2 根因；enable 归 enabledModels（决策3） |
