# shared-llm-config 遗留问题与清理清单（followups）

> **设计层**：问题盘点 + 清理任务规格（当前层）→ 具体代码清理任务（下一层）
> **一句话结论**：shared-llm-config 设计的 P0-P4 主体已全部完成（3 废弃包已删、llm-shared 已建、rename/permission 已收口、设计清单内 6 处硬编码已修），单测全绿；但残留 **1 项违反验收标准（A1）、3 项真实环境验收缺口（B）、4 项设计偏差待裁决（C）、4 项文档过期（D）、4 项历史代码/兼容逻辑清理（E）、2 项范围外同类硬编码（F）**。本文档是这些遗留项的唯一权威清单，每项附位置 + 证据 + 处理方向。

---

## 1. 背景目标

- **Situation**：`shared-llm-config` slice（设计见同目录 `design.md`）已完成 P0-P4 开发并合入。完成后对全量代码做了一次「设计 vs 实现」核查（核查范围：llm-shared / rename-session / permission / model-switch / vision / scheduler / quota-providers / 文档与登记表）。
- **Complication**：核查发现实现与设计存在 1 处验收标准违反、多处偏差与过期文档；另有若干历史代码（死字段、死协议、旧开关）和「设计漏网的同类硬编码」不在原 slice scope 内，无人认领就会长期滞留。
- **Question**：这些遗留项分别是什么、该怎么处理、按什么顺序做？
- **Answer**：本文档逐项登记，分 6 类（A-F）给出处理方向与方案对比，按 4 个批次实施。

**受众假设**：读者懂 pi extension 体系（工厂函数 + ExtensionContext + modelRegistry），但未参与 shared-llm-config 开发。每项问题自包含，无需读 design.md 即可理解。

**设计目标**：
1. 所有遗留项有唯一登记处，不依赖口头传承
2. 每项有明确处理方向（修/删/接受），需裁决的项给方案对比
3. 清理后不留新的死代码/过期文档

---

## 2. 问题清单（现状 + 证据）

### A. 违反设计验收标准（必修）

#### A1. rename-session 静默跳过路径完全没有日志

**位置**：`extensions/rename-session/src/llm.ts`

**现状**：

```ts
// llm.ts callRenameLLM()
const model = resolveModel(ctx, config.model);
if (!model) return null;              // ← model 不可用：无任何日志
// ...
const result = await callLLM(ctx, { ... });
if (!result.ok) return null;          // ← LLM 调用失败：无任何日志
```

**为什么是问题**：design.md §4 场景 2 的通过标准明确要求「日志记录 `[rename-session] model not available, skipping`（或类似）」。当前两条失败路径都是裸 `return null`（不抛异常，所以 index.ts 的 fire-and-forget `.catch()` 也不会触发），线上排查「为什么 session 没改名」完全无迹可循。

---

### B. 真实环境验收缺口（design.md §4 场景 / §5.3 探针未完成项）

design.md §4 的 6 个验收场景要求**真实环境验证（非单测）**，§5.3 列了 6 个实施期探针。目前状态：

| 项 | 状态 | 缺口 |
|----|------|------|
| 场景 1（rename 用独立小模型真实生成标题） | ⚠️ 部分 | 仅有单测 + prompt 长度实测（llm.ts 注释 length=75）；无本地 pi CLI 端到端实测记录（真实 session 首 turn 后标题真实更新、真实用了配置的便宜模型） |
| 场景 2（model 不可用静默跳过） | ⚠️ 部分 | 单测覆盖；真实环境未验（且 A1 的日志缺失会阻塞该场景的「日志记录」通过标准） |
| 场景 3（permission classifier 用到 OAuth provider） | ❌ 未验 | 探针 2（`getAvailable()` 在 xyz-agent 环境含 OAuth provider）无实测证据；production.test.ts TC4 是 mock，不能替代 |
| 场景 4（scoped 不依赖 cost） | ✅ | 单测覆盖（scoped.test.ts），实现按 enabledModels 顺序取首个，无 cost 读取 |
| 场景 5（PI_CODING_AGENT_DIR 实例隔离） | ⚠️ 部分 | pure.test.ts:213-237 有落盘用例；rename 真实写配置到隔离目录的端到端未验 |
| 场景 6（删包无 broken reference） | ✅ | typecheck 全过 + grep 零硬引用 + 测试全绿 |
| 探针 1（completeSimple 静态 import 不 throw） | ✅ | call.ts 注释记录 pi 0.84.0 实测 |
| 探针 3（permission 全量回归） | ✅ | 25 文件 571 用例全绿 |
| 探针 4（config.ts 原子写 Windows 行为） | ❌ 未验 | 全 macOS 开发，tmp+rename 在 Windows 目标文件占用时失败的行为未测；llm-shared/config.ts 是否有 fallback 未核对 |
| 探针 5（callLLM 参数字段名对齐） | ✅ | call.ts 注释记录探针⑤对齐结论 + tsc 通过 |
| 探针 6（settings.json enabledModels 解析） | ✅ | scoped.test.ts 覆盖缺失/坏 JSON/顺序保持/glob |

按项目 mandatory 规则（pi extension 改动优先本地 pi CLI 实测），场景 1/2/3/5 的端到端实测是**欠债**。

---

### C. 实现与设计的偏差（需裁决后处理）

#### C1. permission 未收口到 callLLM，仍保留 streamSimple + `@ts-ignore`

**位置**：`extensions/permission/src/production.ts:19-21, 84-91`

**现状**：

```ts
// @ts-ignore - getApiProvider resolves via root tsconfig stub but per-package tsc paths differ
import { getApiProvider } from "@earendil-works/pi-ai";
// ...
streamSimple: (model, context, options) => {
    const provider = getApiProvider(model.api);
    if (!provider) throw new Error(`[pi-permission] No API provider registered for api: ${model.api}`);
    return provider.streamSimple(model, context, options);
},
```

**背景**：design.md 决策 C1 正文只明文要求「resolveModel + getApiKeyAndHeaders」收口（已完成），但 §3.4 错误规格「callLLM 返回 {ok:false} → permission 降级为 ask」隐含 permission 也走 callLLM。保留 streamSimple 有一个技术理由：classifier 依赖 `stopReason` 显式检查（classifier.ts:196-204，stopReason=error/aborted → fallback），而 llm-shared 的 `callLLM` 不检查 stopReason——completeSimple resolve 出 error 消息时 callLLM 会 `ok:true` 返回错误文本，只能靠下游 parse fallback 兜住，错误粒度变粗。代码与 commit 均未声明这个取舍。

**方案对比**：

| 方案 | 做法 | 长期合理性 | 短期成本 | 风险 |
|------|------|-----------|---------|------|
| **a（长期，推荐）** | llm-shared 的 callLLM 增加 stopReason 检查（error/aborted → `{ok:false}`），permission 随后收口到 callLLM，删 getApiProvider + @ts-ignore | 高：真正完成 C1 收口，@ts-ignore 消除 | 中：动 llm-shared + permission + 两边测试 | 低 |
| b（短期） | 保留 streamSimple，在 production.ts 补注释声明「为何不用 callLLM（stopReason 粒度）」 | 中：收口留半截，@ts-ignore 永存 | 低：只加注释 | 低 |

#### C2. callLLM 的 `recoverable:false` 分支不存在

**位置**：`extensions/shared/llm-shared/src/call.ts:115`

**现状**：design.md §3.4 错误规格定义了两级：`recoverable:true`（网络/超时/auth）和 `recoverable:false`（model 配置错误如 api 类型不支持）。实际实现 catch 里**所有错误统一 `recoverable:true`**，不存在 false 分支。当前两个消费者（rename 静默跳过、permission fail-closed）都不区分 recoverable 值——**该字段无实际消费者**。

**方案对比**：

| 方案 | 做法 | 推荐 |
|------|------|:---:|
| a | 实现 recoverable 细分（识别不可恢复错误类：无 provider、api 类型不支持等） | ❌ YAGNI：无消费者，加了是推测性功能 |
| **b** | 承认现状：设计文档错误规格降级为「当前统一 true，未来有消费者再细分」；代码加注释说明 | ✅ |

若 C1 选方案 a（给 callLLM 加 stopReason 检查），stopReason=error 可顺带作为 recoverable 细分的第一个真实场景，届时再评估。

#### C3. permission config 不支持对象形式 selector，传对象被静默忽略

**位置**：`extensions/permission/src/types.ts:92`（`model: string`）+ `config.ts` 的 normalizeClassifierConfig

**现状**：`classifier.model` 只接受字符串（`'auto'` 或 `'provider/model-id'`）。design.md §4 场景 3 的前置条件写了「`classifier.model` 设为 `{ "type": "available" }` 或某 OAuth ref」——**对象形式不被支持**：传对象会被 normalize 静默忽略，回落默认值 `"auto"`，无任何 warning。用户照设计文档配对象形式会得到一个与自己预期不同的行为且无法察觉。

**方案对比**：

| 方案 | 做法 | 推荐 |
|------|------|:---:|
| a | 扩展 config schema 支持 `string \| ModelSelector` 对象形式 | ❌ 边缘需求：'auto' 已映射 scoped，scoped 空还有 available fallback（C4），对象形式只多一个「显式指定 available」的边角场景 |
| **b** | 保持 string；normalize 遇非 string 值打 console.warn 提示「忽略无效 classifier.model，用默认 auto」；同步修正 design.md 场景 3 的表述 | ✅ 消除静默，不扩张 schema |

#### C4. permission 的 scoped→available fallback 是超设计加固（建议接受并回写设计文档）

**位置**：`extensions/permission/src/production.ts:70-72`

**现状**：

```ts
// CL-scoped-fallback：scoped（'auto'）在 enabledModels 空/无 auth 时 fallback available，
// 保证「有 apiKey provider 但没配 enabledModels」的用户不退化（旧 auto 行为）。
if (!model && selector.type === "scoped") {
    model = resolveModelShared(ctx, { type: "available" });
}
```

**背景**：design.md 决策 E 的探针写的是「enabledModels 空 → fail-closed ask」。实现选择了更宽的兜底（scoped 空 → 先试 available → 仍 null 才 fail-closed）。代码注释已声明理由（向后兼容旧 auto 行为），有测试覆盖（production.test.ts TC7）。**这是合理加固，建议接受**——但它改变了设计文档写明的降级语义，设计文档应回写更新（决策 E 探针描述），避免后续读者按设计文档误判实现有 bug。

---

### D. 文档/注释过期（低成本，直接修）

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| D1 | 根 `AGENTS.md` 行 46 + 行 55-72「Pi Extension 全集」表格 | 表格声称「14 个包」且只有 14 行，但 `extensions/session-reader/` 存在且 `extension-dependencies.json` 已登记 `pi-session-reader`——P0 同步表格时漏了它 | 补 session-reader 一行，「14 个」改「15 个」（正文行 46 同步） |
| D2 | `extensions/permission/src/types.ts:91` | 注释「模型：'auto'（选最便宜）」——cost 排序已废弃，新语义是 scoped（enabledModels 用户排序首个可用）+ available fallback | 改为「'auto'（=scoped：读 settings.json enabledModels 取首个可用，空则 fallback available）或 'provider/model-id'」 |
| D3 | `extensions/permission/README.md:57` + `:363` | 「`auto` 选最便宜」「`auto` 自动选最便宜」——同上过期 | 同 D2 语义改写 |
| D4 | `extensions/shared/quota-providers/src/` 多处（secrets.ts:20、registry.ts:50、paths.ts:27,48、config.ts:5,36、providers/types.ts:33、providers/index.ts:20） | quota-providers 接管 statusline 的 cache 写入后沿用 `[statusline]` 日志前缀和注释，排查时误导 | 前缀统一改 `[quota-providers]`，注释改写来源 |

---

### E. 历史代码 / 兼容逻辑清理

#### E1. `ResolvedModelEntry.apiKey` 死字段

**位置**：`extensions/permission/src/classifier/model-resolver.ts:79-80`（定义）+ `:125-126`（flattenModels 填充）

**现状**：P3 收口后 classifier 不再消费该字段（凭证走 modelRegistry），全 src 零生产消费者（仅测试断言），字段注释「用于 streamSimple 调用」已过期。

**处理**：删除字段 + 填充逻辑 + 测试断言同步删。

#### E2. permission picker 仍自读 models.json（CL-picker-scope）

**位置**：`extensions/permission/src/classifier/model-resolver.ts`（loadModelsJson / flattenModels / listAvailableModels 三函数，供 `/permission model` picker 命令用）

**现状**：P3 只收口了 classifier，picker 保留自读 models.json 的单源逻辑（文件头已登记 `TODO(follow-up): CL-picker-scope`）。**classifier 当年的缺陷在 picker 上原样存在**：用户只经 `pi auth login` 配的内置/OAuth provider，picker 列表里看不到。另注意 picker 的展示排序仍按 `cost.input` 升序（:184-188）——cost 字段在 xyz-agent 环境普遍缺失（design.md §2.3 问题 6 已证），排序退化为稳定但无语义的 0 序。

**处理**：listAvailableModels 改走 `ctx.modelRegistry.getAll()` + `hasConfiguredAuth()` 过滤，删 loadModelsJson/flattenModels；排序字段从 cost.input 改为 provider+id 字典序（cost 普遍缺失，排序无意义）。

#### E3. rename-session 旧开关无迁移，旧开启用户升级后静默回落关闭

**位置**：`extensions/rename-session/src/pure.ts`（config 加载）

**现状**：旧版开关是 `<agentDir>/auto-rename-enabled` **文件存在性**；新版改为 `config/rename-session.json` 的 `enabled` 字段（默认 false）。无迁移逻辑——旧版手动开启过的用户升级后开关被静默重置为关闭。design.md 未要求迁移，属用户可感知的行为变更。

**方案对比**：

| 方案 | 做法 | 推荐 |
|------|------|:---:|
| **a** | 一次性迁移：loadConfig 时若新配置文件不存在且旧开关文件存在 → enabled=true 写入新配置 + 删旧文件（带注释标 [HISTORICAL] 迁移逻辑，两个版本后可删） | ✅ 成本低（~20 行），消除用户困惑 |
| b | 只发 CHANGELOG/release notes 明示 | 可接受的兜底，但用户不一定会读 |
| c | 接受现状 | ❌ rename 是 mandatory 9 包之一，影响面不小 |

#### E4. statusline footer 反射协议已成死协议

**位置**：`extensions/permission/src/footer-provider.ts` + `statusline-palette.ts`

**现状**：permission 通过 `Symbol.for("@zhushanwen/pi-statusline.footerHandshake")` globalThis 反射与 statusline 的 footer registry 握手（consumer 端：push pending 等 owner flush）。statusline 包已于 P0 删除 → **registry owner 永远不存在**，握手永远停在 pending，整套协议（FOOTER_HANDSHAKE_KEY / REQUEST_RENDER_KEY / FooterLineRenderer / statusline-palette.ts）零实际效果。文件注释已声明保留意图（「若有未来 footer 消费方读取这些 slot，名称必须一致」）。

**方案对比**：

| 方案 | 做法 | 长期合理性 | 风险 |
|------|------|-----------|------|
| a | 保留：协议是稳定契约，未来若有新 footer 聚合者可复用；当前成本为零（noop） | 中：赌一个不确定的未来需求 | 低 |
| b | 删除整套反射 + palette，permission footer 回归直接 `ctx.ui.setFooter`（如有）或暂不显示 | 中：YAGNI；但 ADR-036 的 footer 单例冲突问题（多扩展注册互相覆盖）并未消失，只是冲突方暂时不存在 | 中：未来再引入 footer 聚合时要从 git 历史恢复协议 |

**建议**：暂不做，登记在此等「permission footer 显示需求」或「新 footer 聚合者」任一出现时再裁决。若届时都无，下下次大扫除删。

---

### F. 设计漏网的同类 `~/.pi/agent` 硬编码（建议扩张处理）

design.md §3.6 的 P4 清单只列了 6 处（已全部修完）。全仓扫描发现同类硬编码还有 2 处不在清单内——**在 xyz-agent 隔离环境下会读错目录**（读 `~/.pi/agent/` 而非 `~/.xyz-agent/pi/agent/`），与 P4 修复的 6 处是同性质的实例隔离 bug：

| # | 位置 | 现状 |
|---|------|------|
| F1 | `extensions/plan/src/templates.ts:43` | `path.join(os.homedir(), ".pi", "agent", "plan-templates")` 扫全局模板目录 |
| F2 | `extensions/subagent-workflow/` 4 处 | `src/index.ts:169,171`（resolveSessionDir 的 defaultDir + sessionScopedDir 根）；`src/orchestration/skill-discovery.ts:44`（global skills + npm skills 目录）；`src/interface/views/WorkflowsView.ts:865`（workflow-traces 落盘目录） |

**处理**：统一改 `getAgentDir()` 派生。注意 subagent-workflow 的 resolveSessionDir 有「sessionScopedDir 存在则用它否则 defaultDir」的探测逻辑，改路径根时保留该语义。

---

## 3. 实施拆分（4 个批次，每批可独立验收）

| 批次 | 内容 | 性质 | 依赖 |
|------|------|------|------|
| **批次 1** | A1（rename 补日志）+ D1-D4（文档/注释/前缀） | 低风险文案+日志级改动，一个 commit 可完成 | 无 |
| **批次 2** | E1（删死字段）+ E3（rename 旧开关迁移，方案 a）+ F1/F2（硬编码改 getAgentDir） | 小代码改动 + 各自单测 | 无（可与批次 1 并行） |
| **批次 3** | C1-C4 裁决后实施（C1 推荐方案 a 时含 llm-shared stopReason 检查 + permission 收口；C2/C3 推荐方案 b；C4 回写设计文档）+ E2（picker 改 modelRegistry） | 需先裁决，C1a/E2 是中等改动 | 裁决结论 |
| **批次 4** | B 类真实环境验收：本地 pi CLI 实测场景 1/2/3/5（`pi --mode rpc --approve --extension <path>` + PI_EXT_DEBUG=1）+ 探针 4（Windows 原子写核对或标注） | 验证性工作，不改功能代码（除非实测发现问题） | 批次 1（A1 日志是场景 2 验收的前提） |

**E4（statusline 死协议）不进任何批次**：按 §2-E4 的建议挂起，触发条件出现再裁决。

---

## 4. 验收（批次级，真实场景）

### 批次 1+2 验收（改动级）

1. `pnpm extensions:typecheck` 全过、`npx vitest run`（rename-session / permission / llm-shared / plan / subagent-workflow）全绿
2. F1/F2 改完后：`grep -rn 'homedir()' extensions/ --include="*.ts" | grep -v node_modules | grep -v test` 剩余命中逐条有注释说明合法理由（用户输入 `~` 展开 / 非 pi 目录 / 迁移 fallback）
3. rename 旧开关迁移：临时构造 `<agentDir>/auto-rename-enabled` 文件 + 无新配置 → 加载后 enabled=true 且旧文件被删

### 批次 4 验收（真实环境，回溯 design.md §4 场景）

**场景 R1（对应场景 1/2，验证 rename 端到端 + A1 日志）**：
- 前置：本地 pi CLI（`pi --mode rpc --session-dir /tmp/r1 --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension extensions/rename-session/src` + `PI_EXT_DEBUG=1`）；`<agentDir>/config/rename-session.json` 配 `{"enabled":true,"model":{"type":"ref","ref":"<某便宜模型>"}}`
- 步骤：发一条消息等 assistant 回复完成
- 通过标准：session 标题真实更新为内容相关短标题；日志确认 rename 用了配置的模型（非主 session 模型）；把 ref 改成 `nonexistent/model` 再测一次 → 标题保留默认、主对话不受影响、**日志出现跳过记录**（A1 修复的实证）

**场景 R2（对应场景 3 + 探针 2，验证 OAuth provider 链路）**：
- 前置：仅用 `pi auth login` 配置一个官方 OAuth provider（不手写 models.json provider）；permission-config 的 classifier.model 为 `"auto"`
- 步骤：触发一次需 classifier 的中等风险 bash 命令
- 通过标准：classifier 真实返回分类结果（非 fail-closed 降级 ask）；日志确认解析到的 model 是 OAuth provider 的

**场景 R3（对应场景 5，实例隔离）**：
- 前置：`PI_CODING_AGENT_DIR=/tmp/agent-isolated` 启动 pi
- 步骤：rename 写配置、model-switch 读 model-policy.json、plan 读全局模板（F1 修复后）、subagent-workflow 导 trace（F2 修复后）
- 通过标准：所有文件落 `/tmp/agent-isolated/` 下，不碰 `~/.pi/agent/`（`ls -R /tmp/agent-isolated` + `stat ~/.pi/agent/<对应文件>` 不存在）

**探针 4（Windows 原子写）**：核对 llm-shared/config.ts 的 tmp+rename 在 `renameSync` 失败时有无 fallback；无则标注「Windows 目标占用场景会写失败」并在 catch 里补错误日志（不阻塞读）。无 Windows 环境时以代码审读 + 单测模拟 ENOENT/EPERM 代替实机验证。

---

## 附：已确认无需处理项（防重复提出）

- **llm-shared 无 `pi.extensions` 声明**：handoff 文档曾提及，但 design.md 全文未要求；共享库不是 extension（同类 quota-providers 亦无此字段），声明了反而会被 pi loader 当 extension 加载。**现状正确，不改**。
- **scheduler importer.ts:34 的 homedir**：有意的旧版（npm 0.1.1）数据迁移探测 fallback，注释已声明，**保留**。
- **quota-providers 的 zhipu.ts:13 / tavily.ts:9,46 的 homedir**：读 `~/.claude` / `~/.tavily` 非 pi 目录，实例隔离不适用，**保留**。
- **permission 的 scoped 空 → fail-closed ask 主路径**：未变（C4 只是在 ask 前多试一次 available），fail-closed 设计完整。
