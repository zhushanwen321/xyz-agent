# shared-llm-config 遗留问题与清理清单（followups）

> **设计层**：问题盘点 + 清理任务规格（当前层）→ 具体代码清理任务（下一层）
> **一句话结论**：shared-llm-config 设计的 P0-P4 主体已全部完成（3 废弃包已删、llm-shared 已建、rename/permission 已收口、设计清单内 6 处硬编码已修），单测全绿；但残留 **1 项违反验收标准（A1，已扩为失败+成功路径日志）、3 项真实环境验收缺口（B）、4 项设计偏差（C，裁决已定，见 §2）、4 项文档过期（D）、4 项历史代码/兼容逻辑清理（E）、2 项范围外同类硬编码（F）**。本文档是这些遗留项的唯一权威清单，每项附位置 + 证据 + 处理方向。

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

成功路径同样零日志：`callLLM`（llm-shared/call.ts）全文件无 console 输出，rename 成功分支也不记录所选 model id——「改名用了什么模型」与「为什么没改名」都无迹可循。

**为什么是问题**：design.md §4 场景 2 的通过标准明确要求「日志记录 `[rename-session] model not available, skipping`（或类似）」（design.md:646-651）。当前两条失败路径都是裸 `return null`（不抛异常，所以 index.ts 的 fire-and-forget `.catch()` 也不会触发），线上排查「为什么 session 没改名」完全无迹可循。**且成功路径日志缺失会阻塞批次 4 场景 R1 的「日志确认」通过标准**（见 §4）。

**处理**：失败路径补 `[rename-session] model not available, skipping`（model 不可用）/ `[rename-session] rename LLM call failed: <error>`（调用失败）；**成功路径补 `[rename-session] rename with model <modelId>`（记录所选 model id）**——后者是 §4 R1 通过标准 2 可观察性的前提。

---

### B. 真实环境验收缺口（design.md §4 场景 / §5.3 探针未完成项）

design.md §4 的 6 个验收场景要求**真实环境验证（非单测）**（场景原文在 design.md；关键句引用：场景 2 通过标准 :646-651、场景 3 前置 :654），§5.3 列了 6 个实施期探针。目前状态：

| 项 | 状态 | 缺口 |
|----|------|------|
| 场景 1（rename 用独立小模型真实生成标题） | ✅ | 批次 4 R1 实测通过：真实 session 首 turn 后标题更新为「MiMo自我介绍」+ 日志 `[rename-session] rename with model mimo-v2.5-pro`（见 §4 批次 4 验收记录） |
| 场景 2（model 不可用静默跳过） | ✅ | 批次 4 R1 步骤 b 实测通过：ref 改 nonexistent/model 后标题保留默认 + 日志 `[rename-session] model not available, skipping`（见 §4） |
| 场景 3（permission classifier 用到 OAuth provider） | ⚠️ 部分 | 批次 4 R2 实测通过 classifier 链路（using model 日志 + extension_ui_request 实证非 fail-closed），但本地无 OAuth provider（auth.json 全 api_key），以内置 provider 的 available 路径替代（classifier auto → deepseek-v4-flash），OAuth provider 链路待有 OAuth 凭证环境补验（见 §4） |
| 场景 4（scoped 不依赖 cost） | ✅ | 单测覆盖（scoped.test.ts），实现按 enabledModels 顺序取首个，无 cost 读取 |
| 场景 5（PI_CODING_AGENT_DIR 实例隔离） | ⚠️ 部分 | 批次 4 R3 实测通过：rename 配置 / plan 模板 / model-switch policy / subagent-workflow sessions 全落隔离目录，真实 ~/.pi/agent 未污染；subagent-workflow trace 导出（S 键）仅在 TUI 视图，RPC 模式无 UI 入口未实测（见 §4） |
| 场景 6（删包无 broken reference） | ✅ | typecheck 全过 + grep 零硬引用 + 测试全绿 |
| 探针 1（completeSimple 静态 import 不 throw） | ✅ | call.ts 注释记录 pi 0.84.0 实测 |
| 探针 3（permission 全量回归） | ✅ | 25 文件 571 用例全绿（E4 删除后重跑：23 文件 541 用例） |
| 探针 4（config.ts 原子写 Windows 行为） | ✅ | 批次 4 P4 单测通过：ENOENT/EPERM 用例验证 catch 路径（{success:false} + onWarning `Failed to save config at '<path>'` + tmp 清理）；Windows 目标占用行为说明已补入 config.ts 注释；实机验证仍限 Windows 环境（见 §4） |
| 探针 5（callLLM 参数字段名对齐） | ✅ | call.ts 注释记录探针⑤对齐结论 + tsc 通过 |
| 探针 6（settings.json enabledModels 解析） | ✅ | scoped.test.ts 覆盖缺失/坏 JSON/顺序保持/glob |

按项目 mandatory 规则（pi extension 改动优先本地 pi CLI 实测），场景 1/2 已端到端实测，场景 3/5 已实测（部分缺口见上），**欠债仅剩：OAuth provider 环境下的 classifier 链路 + subagent-workflow trace 导出 TUI 实测**。

---

### C. 实现与设计的偏差（需裁决后处理）

#### C1. permission 未收口到 callLLM，仍保留 streamSimple + `@ts-ignore`

**位置**：`extensions/permission/src/production.ts:19-21, 82-87`

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

**背景**：design.md 决策 C1 正文只明文要求「permission 的 classifier 改走共享库（resolveModel + getApiKeyAndHeaders），废弃 model-resolver.ts 的自读逻辑」（design.md:361-367，已完成），但 §3.4 错误规格「callLLM 返回 {ok:false} → permission 降级为 ask」（design.md:539-546）隐含 permission 也走 callLLM。保留 streamSimple 有一个技术理由：classifier 依赖 `stopReason` 显式检查（classifier.ts:223-227，stopReason=error/aborted → fallback，含 G3 关键修正注释），而 llm-shared 的 `callLLM` 不检查 stopReason——completeSimple resolve 出 error 消息时 callLLM 会 `ok:true` 返回错误文本（rename 会把它 cleanTitle 后当标题用，是实际存在的隐藏 bug），只能靠下游 parse fallback 兜住，错误粒度变粗。代码与 commit 均未声明这个取舍。

**方案对比**：

| 方案 | 做法 | 长期合理性 | 短期成本 | 风险 |
|------|------|-----------|---------|------|
| **a（长期，推荐）** | llm-shared 的 callLLM 增加 stopReason 检查：`stopReason=error/aborted → {ok:false, recoverable:true}`（与 C2 裁决的统一值一致，不触发细分）；`CallLLMResult` 的 ok:false 分支增加 `stopReason?: "error" \| "aborted"` **独立透传字段**（不映射 recoverable，供调用方保留错误/中止的日志区分）；permission 随后收口到 callLLM，删 getApiProvider + @ts-ignore | 高：真正完成 C1 收口，@ts-ignore 消除；错误模型定型为公共 API（llm-shared 是共享库），未来 vision/scheduler 收口直接消费 | 中：动 llm-shared + permission + 两边测试 | 中：收口后 classifier 的 error/aborted 显式区分变粗——行为上两者都 fallback（无差别），日志区分依赖 stopReason 透传字段；另需验证 classifier 的 abort 路径：callLLM 透传 ctx.signal，abort 时 completeSimple reject → catch → ok:false，须正确落到 fallback |
| b（短期） | 保留 streamSimple，在 production.ts 补注释声明「为何不用 callLLM（stopReason 粒度）」 | 中：收口留半截，@ts-ignore 永存 | 低：只加注释 | 低 |

#### C2. callLLM 的 `recoverable:false` 分支不存在

**位置**：`extensions/shared/llm-shared/src/call.ts:110`（catch 统一 `recoverable:true`；文件全长 112 行）

**现状**：design.md §3.4 错误规格定义了两级：`recoverable:true`（网络/超时/auth，rename 静默跳过、permission 降级 ask）和 `recoverable:false`（model 配置错误如 api 类型不支持）（design.md:539-546）。实际实现 catch 里**所有错误统一 `recoverable:true`**，不存在 false 分支。**当前唯一消费者是 rename**（grep 证实 `callLLM` 仅 `rename-session/src/llm.ts:88` 一处调用；permission 尚未收口，走 streamSimple，从未消费 callLLM——C1 收口后才会成为第二消费者）——唯一消费者不区分 recoverable 值，**该字段当前无实际消费者**。

**方案对比**：

| 方案 | 做法 | 推荐 |
|------|------|:---:|
| a | 实现 recoverable 细分（识别不可恢复错误类：无 provider、api 类型不支持等） | ❌ YAGNI：无消费者，加了是推测性功能 |
| **b** | 承认现状：设计文档错误规格降级为「当前统一 true，未来有消费者再细分」；代码加注释说明 | ✅ |

**与 C1a 的衔接裁决**：C1a 实施时 `stopReason=error/aborted → {ok:false, recoverable:true}`（与 b 的统一值一致，**不触发细分**）。stopReason 作为 CallLLMResult 的独立透传字段（见 C1 方案 a）已就位——若未来出现需要区分恢复性的消费者（如「模型配置错误立即失败不重试」），细分时可直接映射该字段，无需再改公共 API。

#### C3. permission config 不支持对象形式 selector，传对象被静默忽略

**位置**：`extensions/permission/src/types.ts:92`（`model: string`）+ `config.ts` 的 normalizeClassifierConfig

**现状**：`classifier.model` 只接受字符串（`'auto'` 或 `'provider/model-id'`）。design.md §4 场景 3 的前置条件写了「`classifier.model` 设为 `{ "type": "available" }` 或某 OAuth ref」（design.md:654）——**对象形式不被支持**：传对象会被 normalize 静默忽略，回落默认值 `"auto"`，无任何 warning。用户照设计文档配对象形式会得到一个与自己预期不同的行为且无法察觉。

**方案对比**：

| 方案 | 做法 | 推荐 |
|------|------|:---:|
| a | 扩展 config schema 支持 `string \| ModelSelector` 对象形式 | ❌ 边缘需求：'auto' 已映射 scoped，scoped 空还有 available fallback（C4），对象形式只多一个「显式指定 available」的边角场景 |
| **b** | 保持 string；normalize 遇非 string 值打 console.warn 提示「忽略无效 classifier.model，用默认 auto」；同步修正 design.md 场景 3 的表述 | ✅ 消除静默，不扩张 schema |

#### C4. permission 的 scoped→available fallback 是超设计加固（建议接受并回写设计文档）

**位置**：`extensions/permission/src/production.ts:71-73`

**现状**：

```ts
// CL-scoped-fallback：scoped（'auto'）在 enabledModels 空/无 auth 时 fallback available，
// 保证「有 apiKey provider 但没配 enabledModels」的用户不退化（旧 auto 行为）。
if (!model && selector.type === "scoped") {
    model = resolveModelShared(ctx, { type: "available" });
}
```

**背景**：design.md 决策 E 的探针写的是「enabledModels 为空时 permission 降级为 fail-closed ask」（design.md:391-393）。实现选择了更宽的兜底（scoped 空 → 先试 available → 仍 null 才 fail-closed）。代码注释已声明理由（向后兼容旧 auto 行为），有测试覆盖（production.test.ts TC7）。**这是合理加固，建议接受**——但它改变了设计文档写明的降级语义，设计文档应回写更新（决策 E 探针描述），避免后续读者按设计文档误判实现有 bug。

---

### D. 文档/注释过期（低成本，直接修）

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| D1 | 根 `AGENTS.md` 行 46 + 行 55-72「Pi Extension 全集」表格 | 表格声称「14 个包」且只有 14 行，但 `extensions/session-reader/` 存在且 `extension-dependencies.json` 已登记 `pi-session-reader`——P0 同步表格时漏了它 | 补 session-reader 一行，「14 个」改「15 个」（正文行 46 同步） |
| D2 | `extensions/permission/src/types.ts:91` | 注释「模型：'auto'（选最便宜）」——cost 排序已废弃，新语义是 scoped（enabledModels 用户排序首个可用）+ available fallback | 改为「'auto'（=scoped：读 settings.json enabledModels 取首个可用，空则 fallback available）或 'provider/model-id'」 |
| D3 | `extensions/permission/README.md:57` + `:363` + `:374` | 「`auto` 选最便宜」「`auto` 自动选最便宜」「自动选最便宜可用模型」——同上过期 | 同 D2 语义改写 |
| D4 | `extensions/shared/quota-providers/src/` 多处（secrets.ts:20、registry.ts:50、paths.ts:27,48、config.ts:5,36、providers/types.ts:33、providers/index.ts:20） | quota-providers 接管 statusline 的 cache 写入后沿用 `[statusline]` 日志前缀和注释，排查时误导 | 前缀统一改 `[quota-providers]`，注释改写来源 |

---

### E. 历史代码 / 兼容逻辑清理

#### E1. `ResolvedModelEntry.apiKey` 死字段

**位置**：`extensions/permission/src/classifier/model-resolver.ts:80-81`（定义）+ `:125-126`（flattenModels 填充）

**现状**：P3 收口后 classifier 不再消费该字段（凭证走 modelRegistry），全 src 零生产消费者（仅测试断言），字段注释「用于 streamSimple 调用」已过期。

**处理**：删除字段 + 填充逻辑 + 测试断言同步删。**注意与 E2 重叠**：flattenModels 是 E2 要删的整函数之一，本项的 :125-126 填充删除与测试断言改动是 E2 改动的子集——实施上 E1/E2 合并处理（批次 3），避免同文件同区域两次改动。

#### E2. permission picker 仍自读 models.json（CL-picker-scope）

**位置**：`extensions/permission/src/classifier/model-resolver.ts`（loadModelsJson / flattenModels / listAvailableModels 三函数，供 `/permission model` picker 命令用）

**现状**：P3 只收口了 classifier，picker 保留自读 models.json 的单源逻辑（文件头已登记 `TODO(follow-up): CL-picker-scope`）。**classifier 当年的缺陷在 picker 上原样存在**：用户只经 `pi auth login` 配的内置/OAuth provider，picker 列表里看不到。另注意 picker 的展示排序仍按 `cost.input` 升序（:184-188）——cost 字段在 xyz-agent 环境普遍缺失（design.md §2.3 问题 6 已证），排序退化为稳定但无语义的 0 序。

**处理**：listAvailableModels 改走 `ctx.modelRegistry.getAll()` + `hasConfiguredAuth()` 过滤（hasConfiguredAuth 已在 llm-shared/resolve.ts:97 使用，API 存在），删 loadModelsJson/flattenModels；排序字段从 cost.input 改为 provider+id 字典序（cost 普遍缺失，排序无意义）。

**调用方连带改动**（listAvailableModels 是「无 ctx 纯函数 + 注入」模式，改走 modelRegistry 后签名带 ctx，以下三处必须同步改）：`model-picker.ts:291-295`（注入签名）、`commands.ts:121`（listModels 接口）、`index.ts:77`（`setDefaultListAvailableModels` 注入点）。`/permission model` picker 命令的展示路径（index.ts:171）不变。

#### E3. rename-session 旧开关无迁移，旧开启用户升级后静默回落关闭

**位置**：`extensions/rename-session/src/pure.ts`（config 加载）

**现状**：旧版开关是 `<agentDir>/auto-rename-enabled` **文件存在性**；新版改为 `config/rename-session.json` 的 `enabled` 字段（默认 false）。无迁移逻辑——旧版手动开启过的用户升级后开关被静默重置为关闭。design.md 未要求迁移，属用户可感知的行为变更。

**方案对比**：

| 方案 | 做法 | 推荐 |
|------|------|:---:|
| **a** | 一次性迁移：loadConfig 时若新配置文件不存在且旧开关文件存在 → enabled=true 写入新配置 + 删旧文件（带注释标 [HISTORICAL] 迁移逻辑，两个版本后可删） | ✅ 成本低（~20 行），消除用户困惑 |
| b | 只发 CHANGELOG/release notes 明示 | 可接受的兜底，但用户不一定会读 |
| c | 接受现状 | ❌ rename 是 mandatory 9 包之一，影响面不小 |

#### E4. statusline footer 反射协议已成死协议（已裁决删除，2026-08-13 完成）

**位置**：`extensions/permission/src/footer-provider.ts` + `statusline-palette.ts`（**已删除**）

**现状（历史）**：permission 通过 `Symbol.for("@zhushanwen/pi-statusline.footerHandshake")` globalThis 反射与 statusline 的 footer registry 握手（consumer 端：push pending 等 owner flush）。statusline 包已于 P0 删除 → **registry owner 永远不存在**，握手永远停在 pending，整套协议（FOOTER_HANDSHAKE_KEY / REQUEST_RENDER_KEY / FooterLineRenderer / statusline-palette.ts）零实际效果。

**方案对比**：

| 方案 | 做法 | 长期合理性 | 风险 |
|------|------|-----------|------|
| a | 保留：协议是稳定契约，未来若有新 footer 聚合者可复用；当前成本为零（noop） | 中：赌一个不确定的未来需求 | 低 |
| **b（已选）** | 删除整套反射 + palette，permission footer 回归直接 `ctx.ui.setFooter`（如有）或暂不显示 | 中：YAGNI；但 ADR-036 的 footer 单例冲突问题（多扩展注册互相覆盖）并未消失，只是冲突方暂时不存在 | 中：未来再引入 footer 聚合时要从 git 历史恢复协议 |

**裁决**：2026-08-13 按方案 b 删除。理由：owner（statusline）已删且无恢复计划，保留是「单方面宣称的契约」（协议的另一端从未存在过）；恢复成本由 git 历史承担，届时裁决点（「permission footer 显示需求」/「新 footer 聚合者」）已登记。

**删除内容**（验证：permission 测试 23 文件 541 用例全绿 + `pnpm extensions:typecheck` exit 0）：
- `footer-provider.ts`（193 行）+ `statusline-palette.ts`（38 行）+ `__tests__/footer-provider.test.ts`（342 行）+ `__tests__/statusline-palette.test.ts`
- index.ts：移除 footer import、disposeFooterLine 声明、session_start/session_tree 的 footer 注册（保留 refreshConfig）、三处 `requestFooterRender()` 调用、`registerFooterLineFor` / `makePermissionFooterRenderer` 辅助
- `__tests__/index-integration.test.ts`：删 footer describe 块（4 用例）+ getSessionTreeHandler helper + FOOTER_HANDSHAKE_KEY 清理
- README.md：删「statusline 集成」「升级须知」章节 + 已知限制 footer 条目
- ADR pi-ext-036 的 DEPRECATED 标注补充 permission 侧协议已删

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
| **批次 1** | A1（rename 补日志：失败路径 + 成功路径记录所选 model id）+ **permission classifier 成功路径日志（记录解析到的 model id，R2 验收前提）** + D1-D4（文档/注释/前缀） | 低风险文案+日志级改动，一个 commit 可完成 | 无 |
| **批次 2** | E3（rename 旧开关迁移，方案 a）+ F1/F2（硬编码改 getAgentDir） | 小代码改动 + 各自单测 | 无（可与批次 1 并行） |
| **批次 3** | C1-C4 按 §2 已定裁决实施（C1 方案 a：callLLM stopReason 检查 + 透传字段 + permission 收口，裁决值见 §2-C1/C2；C2/C3 方案 b；C4 回写设计文档）+ E1（删死字段，与 E2 同区域，合并实施）+ E2（picker 改 modelRegistry + 三处调用方连带改动） | C1a/E2 是中等改动 | 裁决结论（已在本文档给出） |
| **批次 4** | B 类真实环境验收：本地 pi CLI 实测场景 1/2/3/5（`pi --mode rpc --approve --extension <path>` + PI_EXT_DEBUG=1）+ 探针 4（Windows 原子写核对或标注） | 验证性工作，不改功能代码（除非实测发现问题） | 批次 1（A1 日志是场景 2/R1 验收的前提）+ **批次 2（R3 通过标准依赖 F1/F2 修复后）** |

**E4（statusline 死协议）已处理**：2026-08-13 按方案 b 删除（见 §2-E4），不占批次，独立 commit。

---

## 4. 验收（批次级，真实场景）

### 批次 1+2 验收（改动级）

1. `pnpm extensions:typecheck` 全过、`npx vitest run`（rename-session / permission / llm-shared / plan / subagent-workflow）全绿
2. F1/F2 改完后：`grep -rn 'homedir()' extensions/ --include="*.ts" | grep -v node_modules | grep -v test` 剩余命中逐条有注释说明合法理由（用户输入 `~` 展开 / 非 pi 目录 / 迁移 fallback）
3. rename 旧开关迁移：临时构造 `<agentDir>/auto-rename-enabled` 文件 + 无新配置 → 加载后 enabled=true 且旧文件被删
4. A1 日志（rename）：单测断言 model 不可用时输出 `[rename-session] model not available, skipping`、调用失败时输出 `[rename-session] rename LLM call failed: <error>`、成功时输出 `[rename-session] rename with model <modelId>`

### 批次 4 验收（真实环境，回溯 design.md §4 场景）

**场景 R1（对应场景 1/2，验证 rename 端到端 + A1 日志）**：
- 前置：本地 pi CLI（`pi --mode rpc --session-dir /tmp/r1 --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension extensions/rename-session/src` + `PI_EXT_DEBUG=1`）；`<agentDir>/config/rename-session.json` 配 `{"enabled":true,"model":{"type":"ref","ref":"<某便宜模型>"}}`
- 步骤：发一条消息等 assistant 回复完成
- 通过标准：session 标题真实更新为内容相关短标题；**日志出现 `[rename-session] rename with model <modelId>` 且 modelId 是配置的模型**（非主 session 模型——A1 成功路径日志的实证，批次 1 交付）；把 ref 改成 `nonexistent/model` 再测一次 → 标题保留默认、主对话不受影响、**日志出现 `[rename-session] model not available, skipping`**（A1 失败路径日志的实证）

**场景 R2（对应场景 3 + 探针 2，验证 OAuth provider 链路）**：
- 前置：仅用 `pi auth login` 配置一个官方 OAuth provider（不手写 models.json provider）；permission-config 的 classifier.model 为 `"auto"`
- 步骤：触发一次需 classifier 的中等风险 bash 命令
- 通过标准：classifier 真实返回分类结果（非 fail-closed 降级 ask）；**日志出现 `[pi-permission] classifier: using model <modelId>` 且 modelId 是 OAuth provider 的**（classifier 成功路径日志的实证，批次 1 交付）

**场景 R3（对应场景 5，实例隔离）**：
- 前置：`PI_CODING_AGENT_DIR=/tmp/agent-isolated` 启动 pi
- 步骤：rename 写配置、model-switch 读 model-policy.json、plan 读全局模板（F1 修复后）、subagent-workflow 导 trace（F2 修复后）
- 通过标准：所有文件落 `/tmp/agent-isolated/` 下，不碰 `~/.pi/agent/`（`ls -R /tmp/agent-isolated` + `stat ~/.pi/agent/<对应文件>` 不存在）

**探针 4（Windows 原子写）**：核对 llm-shared/config.ts 的 tmp+rename 在 `renameSync` 失败时有无 fallback。**现状核对**：config.ts 的 save 已有 catch → onWarning（`[llm-shared] Failed to save config`）+ tmp 清理，错误日志已存在，无需补。待做：标注「Windows 目标占用场景会写失败」的行为说明 + 单测模拟 ENOENT/EPERM 验证 catch 路径（无 Windows 环境时以代码审读 + 单测代替实机验证）。

### 批次 4 实测记录（2026-08-13，pi 0.84.0 + 模型 xiaomi-token-plan-cn/mimo-v2.5-pro）

**R1（rename 端到端 + A1 日志实证）——✅ 通过**

环境：`PI_CODING_AGENT_DIR=/tmp/r1-agent`（隔离 agent 目录，避免写真实 `~/.pi/agent`）+ `--session-dir /tmp/r1` + `--approve` + `--extension extensions/rename-session` + `PI_EXT_DEBUG=1`；凭据从 `~/.pi/agent/auth.json` 复制到隔离目录（读操作）。

步骤 a（ref 指向配置模型）：`config/rename-session.json` = `{"enabled":true,"model":{"type":"ref","ref":"xiaomi-token-plan-cn/mimo-v2.5-pro"}}` → 发消息「写一句话介绍你自己。」等 assistant 完成。
- 结果：session JSONL 出现 `session_info` entry，name=`MiMo自我介绍`（内容相关短标题，真实更新 ✅）；stderr 日志 `[rename-session] rename with model mimo-v2.5-pro`（A1 成功路径实证，ref 配置生效 ✅）。

步骤 b（model 不可用）：ref 改 `nonexistent/model` 重测 → 标题保留默认（无 session_info 写入）；stderr 日志 `[rename-session] model not available, skipping`（A1 失败路径实证 ✅）；主对话不受影响。

**R2（permission classifier 链路）——✅ 通过（OAuth 缺口标注）**

环境：`PI_CODING_AGENT_DIR=/tmp/r2-agent` + `--session-dir /tmp/r2` + `--extension extensions/permission`；`permission-config.json` = `{"mode":"auto","classifier":{"model":"auto",...}}`（放隔离 agentDir 根，不碰真实 `~/.pi/agent/permission-config.json`）。

步骤：prompt 让模型执行 `curl -s --max-time 10 https://example.com | head -1`（中等风险，无规则匹配 → ask → 层 3 racing）。
- 结果：tool_call 拦截 → stderr 日志 `[pi-permission] classifier: using model deepseek-v4-flash`（classifier resolveModel 成功，非 fail-closed）；无 `no model resolved` / `LLM call failed` / `timed out` 日志（LLM 分类调用成功）；stdout 出现 `extension_ui_request`（method=select，title 含「awaiting approval (auto mode: AI classifier racing with user prompt)」）——classifier 返回 ask 后审批流程推进到用户，是「真实分类（非 fail-closed 降级）」的决定性证据（fail-closed 路径在 RPC 下直接 deny，不发 UI 请求）。低风险命令（echo）实测规则直通放行。
- **缺口**：本地 `~/.pi/agent/auth.json` 全部为 api_key 类型（xiaomi-token-plan-cn/opencode-go/zai-coding-cn/deepseek/kimi-coding/minimax-cn），无 OAuth provider → 按 design tradeoff 用内置 provider 的 available 路径替代（classifier auto 解析到第一个可用模型 deepseek-v4-flash）。OAuth provider 链路（using model 日志为 OAuth 模型）待有 OAuth 凭证环境补验。

**R3（PI_CODING_AGENT_DIR 实例隔离）——✅ 通过（trace 导出未验）**

环境：`PI_CODING_AGENT_DIR=/tmp/agent-isolated` 启动 pi，同时加载 rename-session / plan / model-switch / subagent-workflow 四扩展；`/tmp/agent-isolated/config/rename-session.json`（enabled + ref）+ `plan-templates/r3-isolated-test.md` 预置。

- rename：配置从隔离目录读取生效（日志 `[rename-session] rename with model mimo-v2.5-pro`）✅
- plan：`templates.ts:44` 全局模板路径 = `getAgentDir()/plan-templates`（F1 修复后静态确认）；隔离目录模板文件就位（模板列表走 plan_tool action=list-template，需模型调用工具，未作为验收断言）
- model-switch：`config.ts:17-18` `CONFIG_PATH = getAgentDir()/model-policy.json` 静态确认；预置 v2 文件后 `/setup-model-policy` 行为与「配置已存在」一致（未生成新文件 → state.config 从隔离目录加载成功）。注：setup-model-policy 命令本身不写盘（生成 summary 等用户 confirm），写盘走 switch_model tool 的交互确认流程，RPC 无 UI 未完整走通
- subagent-workflow：`session_start` 后在隔离目录创建 `subagents/--<cwd-slug>--/records/` + `logs/subagents-<date>.log`（F2 修复后 getAgentDir 派生的实际写入证据）✅；trace 导出（WorkflowsView S 键）仅在 TUI 视图，RPC 模式无 UI 入口 → **未验证项**（design risk R3/low 预期内）
- 隔离断言：`ls -R /tmp/agent-isolated` 全部文件落隔离目录；`~/.pi/agent/config/rename-session.json`、`~/.pi/agent/plan-templates` 不存在 ✅；`~/.pi/agent/model-policy.json`（2026-06-02）/`permission-config.json`（2026-07-29）为预存用户文件（stat 时间戳确认非本次测试写入）

**P4（探针 4 单测）——✅ 通过**

`extensions` 目录 `npx vitest run llm-shared/src/__tests__/config.test.ts`：13 用例全绿（新增 ENOENT/EPERM 两用例，断言 `{success:false}` + onWarning 输出 `[llm-shared] Failed to save config at '<path>': <message>` + tmp 清理 + 目标未创建）。config.ts save 文档注释补充「Windows 目标占用场景 renameSync 抛 EPERM，无 fallback，catch 返回失败 + 调用方重试」行为说明。

---

## 附：已确认无需处理项（防重复提出）

- **llm-shared 无 `pi.extensions` 声明**：handoff 文档曾提及，但 design.md 全文未要求；共享库不是 extension（同类 quota-providers 亦无此字段），声明了反而会被 pi loader 当 extension 加载。**现状正确，不改**。
- **scheduler importer.ts:34 的 homedir**：有意的旧版（npm 0.1.1）数据迁移探测 fallback，注释已声明，**保留**。
- **quota-providers 的 zhipu.ts:13 / tavily.ts:9,46 的 homedir**：读 `~/.claude` / `~/.tavily` 非 pi 目录，实例隔离不适用，**保留**。
- **permission 的 scoped 空 → fail-closed ask 主路径**：未变（C4 只是在 ask 前多试一次 available），fail-closed 设计完整。
