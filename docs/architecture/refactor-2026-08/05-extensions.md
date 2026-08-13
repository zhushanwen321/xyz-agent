# 5. Extensions 详细设计（17 包 ~49k 行）

> 波次归属：F1/F2/F7 → **W3** · F3/F4 → **W4**（DP-3）· F5/F6 → **W5**（DP-4）。本层所有 ⚠️ 核查修正项均按修正后口径描述（原报告数据见 `arch-review-text.md` §5）。

## §1 背景与目标

### 背景（SCQA）

extensions/ 是本项目维护的 `@zhushanwen/pi-*` 统一开发仓库：17 个顶层包 + `shared/` 下 extension-logger、quota-providers 共 19 包、~49k 行。2026-08-13 架构审查对本层判定：**依赖无环（9 条内部边全单向、链长 ≤2）、深浅比 ≈ 2 深 : 8 中 : 7 浅**（subagent-workflow 23.5k / permission 6.3k 是深包；structured-output 651 行是「逻辑深架构浅」的中包，点名深包被推翻）。但最大结构问题是：**`extensions/shared/` 是杂物抽屉，不是共享层**——它只由「2 个碰巧共址的包」构成，跨包共享实际发生在顶层 infrastructure 包（pending-notifications/goal 等），shared 名不副实。

审查产出 F1-F7 七个候选 + 6 处 conventions 附带冲突（集中在 subagent-workflow 与 plan）。其中 F2/F7 与 F1 共享同一根因模式：**「无守护 → 回潮」**——跨包工具 12 处复制、pi 外部 seam 三份解析、事件流两套分流，都是声明式约定（"shared 是共享层"）没有可执行机制守住，漂移靠人肉发现（F7 的 subagent overlay JSON 混入 bug 即由此产生，commit af237e464 只修了症状）。

### 目标

1. **shared 变真共享层**（F1/F3）：跨包微型工具 12 处复制收敛到 shared 通用 utils；quota-providers 死面删除测试驱动，DP-3 裁决 shared 定位去留
2. **pi 外部 seam 唯一化**（F2/F7）：pi session JSONL 文件解析（3 份）与 assistantMessageEvent 事件流分流（2 套）各收敛到单一权威实现
3. **决策项落地**（F4/F5）：Ajv schema 编译层审计先行收敛（builtin 风险）；裸 console 全仓推广 vs 退出 shared 二选一（DP-4）
4. **conventions 冲突收口**（附带项）：extension-dependencies.json 分类矛盾、tool-handler.ts 1473 行超限、plan peerDep 覆盖不全、pi.workflows 未声明等 6 处修正

### Out of Scope

- 不改变任何 extension 对外行为与 pi 协议交互（收敛是纯内部重构）
- 不新增第三方依赖（Ajv 等既有依赖复用）
- 不在此阶段引入共享层的自动化守护机制（守护方案随 D1 波次的 pre-commit 基建一并评估，本层先收敛代码）

### 强制约束（验证规范）

- **extension 改动功能验证优先在本地 pi CLI 实测**，不优先在 xyz-agent 桌面应用验证（xyz-agent 有 mandatory 打包内置、数据目录隔离等额外层会掩盖版本差异）。实测方法：`pi --mode rpc --session-dir <dir> --model <m> --approve --extension <ext-path>` + stdin JSONL 发 `prompt` 命令，配合 `PI_EXT_DEBUG=1` 看 `~/.pi/agent/logs/` 扩展日志
- **测试模型用 `xiaomi-token-plan-cn/mimo-v2.5-pro`，禁止 kimi 系模型**
- 打包相关改动（tsup/electron-builder/plugin-host）必须逐个 commit 逐个验证（AGENTS.md §12），本层大多不触及打包，但任何新增 shared 导出会进 npm 发布面，需跑 `pnpm extensions:typecheck` / `pnpm extensions:lint` / `pnpm extensions:test`

## §2 现状与问题分析（层判定 + 候选问题清单表）

### 层判定

| 维度 | 判定 |
|------|------|
| 依赖方向 | 19 包依赖无环（9 条内部边全单向、链长 ≤2），无环问题 |
| 深浅比 | ≈ 2 深 : 8 中 : 7 浅；subagent-workflow 23.5k / permission 6.3k 为深包；structured-output 651 行「逻辑深架构浅」 |
| shared 定位 | ⚠️ **最大问题：杂物抽屉**。只有 extension-logger（216 行，合格深模块但渗透率 2/17）+ quota-providers（1376 行纯 src / 1780 含测试）碰巧共址；跨包共享实际发生在顶层包间，shared 名不副实 |
| 外部 seam | pi JSONL 文件格式 3 份解析（F2）、assistantMessageEvent 事件流 2 套分流（F7）、同域逻辑 12 份拷贝（F1）——均无单一权威 |

### 候选问题清单表

| 编号 | 级别 | 一句话 | 波次 | 类型 |
|------|------|--------|------|------|
| F1 | Strong | 跨包微型工具 12 处复制（safeStringify ×3 漂移 / escapeXml ×4 / 时间常量 9 份）下沉 shared | W3 | 下沉收敛 |
| F2 | Strong | pi session JSONL 解析 adapter 唯一化（3 份独立解析循环） | W3 | 外部 seam 收敛 |
| F3 | Strong | shared 层定位重整（quota-providers 死面，删除测试驱动 + DP-3） | W4 | 元决策 |
| F4 | Worth | Ajv schema 编译层收敛（审计先行，涉及 builtin） | W4 | 收敛（前置审计） |
| F5 | Worth | 裸 console 迁移决策（⚠️ 修正后真实计数支持推广，DP-4） | W5 | 元决策 |
| F6 | Speculative | formatDuration 同名异义（合法变体，记录即可） | W5 | 记录/改名 |
| F7 | Medium | assistantMessageEvent 分流唯一化（与 F2 同构，补录） | W3 | 外部 seam 收敛 |
| 附带 | - | 6 处 conventions 冲突（依赖分类矛盾 / 文件超限 / peerDep 覆盖 / pi.workflows 未声明） | W3 随行 | 合规修复 |

### ⚠️ 核查修正汇总（按修正后口径）

1. **F1 MS_PER_SEC 计数 ×5 → ×6**：漏 `quota-providers/src/speed.ts:10` 本地定义；另有 MS_PER_SECOND 异名变体 3 处（session-file-gc.ts:16 / execution-record.ts:46 / goal/constants.ts:10），共 9 份本地定义。而 `shared/quota-providers/src/time.ts` 已导出 MS_PER_SEC 却 0 外部消费（连同包 speed.ts 都自立而不 import）
2. **F3 「死面」误判**：buildRuntimeProviders / PROVIDERS 是**同包 cache.ts / registry.ts 在用**（非死代码）；真死面仅 trackSpeed / getSecret / loadSecrets 跨包零暴露。quota-providers 实际 1376 行纯 src（原 ~1590 无法复现）
3. **F5 方法论失真最重**：原计数把注释与字符串字面量当真实调用——真实裸调用为 permission 12 / model-switch 14 / **subagent-workflow 0**（13 处全为注释 + worker 沙箱字符串）/ evolve-daily 6 / scheduler 3。subagent-workflow 实际是最规范的包，原「已依赖 logger 仍有 13 处」论据不成立；真实数据反而**支持推广 logger 有效**（用了 logger 的包裸 console=0）
4. **F6 判定为合法变体非拷贝**（seconds→"3m5s" vs ms→多单位，语义与签名都不同）
5. **附带项修正**：plan 非「缺」peerDependenciesMeta——字段存在（pi-ai 已标 optional），但 3/4 peerDep 覆盖不全
6. F4 路径修正：subagent-workflow 侧实际为 `src/orchestration/args-validator.ts`（原报告写 execution/ 路径已漂移）

## §3 解决方案

### F1 · 跨包微型工具下沉 shared（Strong · W3）

**级别**：Strong · 下沉收敛

**问题**：同域逻辑 12 份拷贝、行为各自漂移。
- safeStringify ×3：`shared/extension-logger/src/index.ts`（有实现未导出）· `session-reader/src/tool-handler.ts:571` · `subagent-workflow/src/execution/agent-result-mapper.ts:80`——三种 catch 语义（静默空串 / 保底对象 / 兜底字符串）就是漂移证据
- escapeXml ×4：subagent-workflow 两处逐字相同（5 连 replace：`subagent-list-injector.ts` / `workflow-list-injector.ts`）· `goal/src/projection/prompts.ts:22`（3 连子集）· `evolve-daily/src/trackers/skill-registry.ts:17`（逆操作）
- 时间常量：MS_PER_SEC 本地定义 6 份（model-switch/advisor.ts:27 · subagent-workflow/format.ts:36 · vision 单包 3 份：spawn.ts:53 / vision-model.ts:61 / index.ts:37 · quota-providers/speed.ts:10）＋ MS_PER_SECOND 异名 3 处（session-file-gc.ts:16 / execution-record.ts:46 / goal/constants.ts:10）共 9 份——而 `shared/quota-providers/src/time.ts` 已导出却 0 外部消费

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| A：shared 建通用 utils 模块，12 处改 import | **长期方案** | 在 shared 下新建通用 utils（如 `shared/pi-utils` 或并入既有 shared 包），导出 extension-logger 现成的 safeStringify + escapeXml/decodeXml（成对）+ 时间常量；12 处本地定义删除改 import | 一次收敛所有拷贝；但 shared 包增加一个，需同步 npm 发布面与依赖声明（各消费包加 dependency） |
| B：只统一 safeStringify 的 catch 语义，escapeXml/常量不动 | 短期方案 | 三处 safeStringify 改为同一 catch 语义，其余维持 | 修症状不收敛拷贝，escapeXml 4 份与常量 9 份继续漂移，三个月后同样问题复发 |

**推荐**：方案 A。理由：审查已证明漂移是真实发生的（safeStringify 三种 catch、escapeXml 逐字 vs 子集 vs 逆操作），且常量模块已存在（time.ts）却 0 消费——说明「拷贝就地」是默认行为，只有物理收敛才能止住；同时让 shared 从「2 个碰巧共址的包」变真共享层（F3 的 DP-3 评估也要用到这个事实）。escapeXml 统一为**单一 encode 方向**（escapeXml + decodeXml 成对导出，evolve-daily 的逆操作改调 decodeXml）。

**改动点**：
1. shared 新建通用 utils（safeStringify、escapeXml/decodeXml、时间常量集合），safeStringify 以 extension-logger 现成实现为准（其余两处 catch 语义收敛到它）
2. 12 处消费点改 import，删除本地定义；extension-logger 的 safeStringify 改为 re-export 或删除本地（防双源）
3. 消费包 package.json 增加对新 shared 包的 dependency（或复用既有 shared 包名，视共享包形态）
4. 各包测试中若断言了本地工具行为，同步更新

**风险**：新增 shared 子包影响 npm 发布管线（main 线走 `npm-*` tag 人工版本判定，需跑 `scripts/check-version-changes.sh` 看传递闭包）；catch 语义收敛会改变 tool-handler / agent-result-mapper 在异常时的兜底输出——需确认无下游依赖旧兜底值。

**验收（真实场景）**：
1. `pnpm extensions:typecheck` + `pnpm extensions:lint` + `pnpm extensions:test` 全绿
2. 本地 pi CLI 实测：`pi --mode rpc --session-dir /tmp/f1-test --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <session-reader 源码路径>`，stdin JSONL 发 prompt 让 session-reader 读一次真实 session 文件（含特殊字符的 XML 场景，如 `&`/`<` 出现在 agent 名或 workflow 描述），输出与改动前逐字节一致（diff 断言）
3. goal 包实测一次（escapeXml 子集路径）：`/goal` 命令生成的提示词含 escapeXml 内容时输出与改动前一致
4. model-switch 实测 advisor 时间窗口计算与改动前输出一致

**下一层拆分**：① shared utils 模块建立 + 导出 ② safeStringify 三处收敛 ③ escapeXml/decodeXml 四处收敛 ④ 时间常量九处收敛 ⑤ 消费包依赖声明 + 发布面检查。

---

### F2 · pi session JSONL 解析 adapter 唯一化（Strong · W3）

**级别**：Strong · 外部 seam 收敛（本层 leverage 最高）

**问题**：pi 是外部系统，JSONL 文件格式是外部 seam——三份拷贝意味着格式变更要改三处，且各自维护 pi JSONL 结构的最小子集类型，header 行/坏行跳过策略互不知晓：
- `session-reader/src/discovery/find.ts:108`：createInterface 逐行读 + 最小类型子集（读首条 user message 文本，命中即停 stream）
- `subagent-workflow/src/execution/session-reconstructor.ts:292-307`：split + parse + 自造坏行防御
- `subagent-workflow/src/execution/session-pending.ts:55`：readFileSync + includes 按值扫描

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| A：下沉 pi-session-file adapter，两包保留语义层 | **长期方案** | shared 建 pi-session-file adapter：读文件 + header 解析 + 坏行防御 + sessionId 提取（一行一行的安全 parse）；session-reader 语义层（找 user message）与 subagent-workflow 语义层（重建 session/查 pending）只消费 adapter | 外部 seam 单点维护，pi 格式变更只改一处；adapter 是纯格式层无业务语义，天然可测 |
| B：仅统一坏行防御逻辑，拷贝到另两处 | 短期方案 | 把 session-reconstructor 的坏行防御复制到 find.ts / session-pending.ts | 解析循环仍是 3 份，只是防御策略一致；下次 pi 格式变更仍改三处 |

**推荐**：方案 A。与 F7 同构（事件流 seam 唯一化），同批实施（W3）。adapter 接口设计：`readSessionFile(path)` 返回 `{ header, entries, sessionId }`（坏行跳过 + 记 warning），`findFirstUserMessage(path)` 等语义查询留在各包语义层。

**改动点**：
1. shared 建 pi-session-file adapter（读文件 + header 解析 + 坏行防御 + sessionId 提取）
2. session-reader 的 find.ts 改为消费 adapter（保留「命中即停」的流式语义——若 adapter 是全量读，需确认 find.ts 的流式提前停止不是性能关键路径；若 key，adapter 提供 stream 变体）
3. subagent-workflow 的 session-reconstructor.ts:292-307 与 session-pending.ts:55 改为消费 adapter
4. 三处最小类型子集合并到 adapter 单一类型定义

**风险**：find.ts 的「命中即停 stream」语义若被全量读 adapter 替代，大 session 文件（MB 级）会有性能回退——设计上保留流式变体；session-pending 的 includes 按值扫描与 header 解析语义不同，需确认 adapter 覆盖两种查询模式。

**验收（真实场景）**：
1. `pnpm extensions:typecheck` + `pnpm extensions:lint` + `pnpm extensions:test` 全绿
2. 本地 pi CLI 实测 session-reader：用 mimo-v2.5-pro 在 RPC mode 跑一次 `session-reader` 的 find 流程读真实 session 文件（`~/.pi/agent/sessions/` 实际文件），输出与改动前一致
3. 坏行防御专项：构造含一行非法 JSON 的 session JSONL（如截断行），pi CLI 实测 adapter 跳过坏行不抛错，sessionId 仍正确提取（对照改动前 session-reconstructor 行为）
4. subagent-workflow 实测：完整跑一次 subagent 编排（真实模型），session-reconstructor 重建结果与改动前一致

**下一层拆分**：① adapter 建立（含坏行防御单测）② find.ts 消费改造 ③ session-reconstructor 消费改造 ④ session-pending 消费改造 ⑤ 语义层类型清理。

---

### F7 · assistantMessageEvent 分流唯一化（Medium · W3 · 补录）

**级别**：Medium · 外部 seam 收敛（与 F2 同款反模式 · 事件流层）

**补录背景**：由 2026-08-13 subagent overlay JSON 混入 bug（commit af237e464）追溯发现。pi assistantMessageEvent 是外部协议 seam（text / thinking / toolcall / signature 等 typed delta）。原 session-runner 反向排除（只拦 thinking_delta）致 toolcall_delta 被当 text_delta → subagent overlay 末尾混入工具参数 JSON。bug 临时修复已在 session-runner 内提取 `mapAssistantMessageDelta`（正向判定，session-runner.ts:87 导出、:612 使用），但 event-adapter 仍是独立 switch——**两套实现仍在**，本项记录「彻底消除两套实现」的治本收口。

**现状**：
- `runtime/infra/pi/event-adapter.ts:92-130`：handleMessageUpdate · 主 agent 路径 · switch(sub.type) 正向
- `extensions/subagent-workflow/src/execution/session-runner.ts:78`：mapAssistantMessageDelta · subagent/workflow 路径 · 反向排除（已改正向）

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| A：mapAssistantMessageDelta 下沉 shared，event-adapter 复用 | **长期方案** | 将 session-runner 内已提取的 mapAssistantMessageDelta 下沉到 shared 层（只管 sub.type 分类，产出态类型由各调用方包装）；event-adapter 的 handleMessageUpdate 改为复用它 | 消除分流漂移（本次 bug 类不再复现）；pi 新增 delta type 单点维护；与 F2 同构收口（文件层 + 事件层 seam 各唯一化） |
| B：保留两套实现，仅同步修复语义 | 短期方案 | event-adapter 也改为正向判定（抄 mapAssistantMessageDelta 逻辑），两处各自维护 | 逻辑仍两份，pi 协议变更时各改各的，行为悄悄漂移——本次 bug 的根因模式原样保留 |

**推荐**：方案 A。注意实施约束：event-adapter 产出 `message.text_delta` WS 帧、session-runner 产出 AgentEvent，**下沉函数只管 sub.type 分类（输出 `text_delta | thinking_delta | noop` 类判定），产出态类型由各自调用方包装**——不可把任何一方的产物类型带进 shared。

**改动点**：
1. mapAssistantMessageDelta 从 session-runner.ts 迁至 shared（含其单测）
2. session-runner.ts:612 改为 import shared 版本（行为不变）
3. event-adapter.ts:92-130 的 switch 改为复用 shared 版本，产出仍包装为 WS 帧
4. 删除 extension 侧旧实现，确认零残留引用

**风险**：event-adapter 位于 runtime 打包面（tsup bundle），新增 shared import 需确认 tsup noExternal 覆盖（shared 已是 workspace 包，追加依赖声明即可）；event-adapter 的现有 switch 可能有 sub.type 之外的分支逻辑（如签名/工具调用帧），合并时不得丢弃。

**验收（真实场景）**：
1. **subagent overlay 场景**：本地 pi CLI 实测——`--extension <subagent-workflow 源码路径>` 跑一次真实 subagent 完成流程（mimo-v2.5-pro，subagent 调用含 toolcall 的工具如 read/bash），确认 overlay 面板输出**无工具参数 JSON 混入**（对照 af237e464 修复前复现路径）
2. 主 agent 路径回归：runtime 侧 event-adapter 改动后跑 `bash scripts/validate-runtime-bundle.sh`（涉及 runtime 文件），再 `pnpm run dev` + Playwright 连 9222 实测一次完整对话（发消息 → 收 text_delta/thinking_delta 流式更新），确认流式 UI 无回归
3. 新增 delta type 扩展性验证：单测覆盖未知 sub.type 的默认分类（noop），确认单一实现内闭环
4. `pnpm extensions:typecheck` + `pnpm extensions:lint` + `pnpm extensions:test` 全绿

**下一层拆分**：① shared 下沉 + 单测迁移 ② session-runner 改 import ③ event-adapter 改造 + WS 帧包装 ④ runtime bundle 验证。

---

### F3 · shared 层定位重整（Strong · W4 · DP-3）

**级别**：Strong · 删除测试 · 元决策

**问题**：shared/quota-providers/（1376 行纯 src / 1780 含测试）跨包零暴露 3 个导出，secrets.ts 44 行连 shared 内部都没人 import（仅 index.ts re-export）：
- **真死**：trackSpeed / getSecret / loadSecrets（跨包零消费；getSecret/loadSecrets 仅经 index.ts re-export，无任何调用方）
- ⚠️ **非死（核查修正）**：buildRuntimeProviders / PROVIDERS——同包 cache.ts / registry.ts 在用
- **活接口**：readCache + CacheData（仅 model-switch 消费：advisor.ts:9,196 + index.ts:13,305）
- shared/extension-logger（216 行）：合格深模块但渗透率 2/17

**问题本质**：shared 层存在的唯一理由是隐藏复杂度；消费者付 indirection 税只拿到 1 个函数（readCache）。跨包共享实际发生在顶层 infrastructure 包（pending-notifications/goal 等），shared 名不副实。

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| A：删除测试驱动 → DP-3 裁决 | **长期方案** | 先砍 0 消费者导出（trackSpeed/getSecret/loadSecrets + secrets.ts），跑测试确认无回归；砍后若 shared 只剩 readCache 深接口 → 保留并瘦身（quota-providers 降为「model-switch 的 quota 服务包」，定位明确）；若渗透率推不动 → 撤销 shared 定位，quota 并回 model-switch 包内 | 数据驱动决策，先清死面再评估，避免「凭感觉留 shared」或「凭感觉拆 shared」 |
| B：现状保留 + 注释说明 | 短期方案 | 死导出留着，只加注释「0 消费者待删」 | 死面继续占发布面与类型面，三个月的技术债原样沉淀 |

**推荐**：方案 A。**前置条件**：先做删除测试（砍 0 消费者导出），评估残存价值再裁决 shared 去留（DP-3 裁决时机 = W4 实施前）。DP-3 两分支：
- 保留瘦身：quota-providers 明确为「model-switch 私有 quota 服务」，readCache 是唯一对外契约，删除测试同步瘦身
- 撤销 shared 定位：quota-providers 移入 model-switch（`packages/` 或 extensions/model-switch 下），shared 只留 extension-logger；连带 F1 的 utils 归位决策（若 F1 已建 shared utils，此分支需重新评估其归位）

**改动点**：
1. 删除测试：砍 index.ts 中 trackSpeed/getSecret/loadSecrets re-export，删除 secrets.ts 与对应测试，`pnpm extensions:test` 全绿
2. rg 确认跨包零引用（model-switch 只 import readCache/CacheData）
3. DP-3 裁决后按分支落地（保留瘦身 or 并回 model-switch）
4. 同步 shared 包 README/定位说明（若保留：写明「服务包」定位；若撤销：删除 shared/quota-providers 目录）

**风险**：trackSpeed 若被未来 quota 功能依赖，删除后需从 git 历史恢复（风险低，可恢复）；删除测试阶段若误删 buildRuntimeProviders/PROVIDERS 会挂 registry 测试——以「rg 零引用」为准逐个验证，不靠猜。

**验收（真实场景）**：
1. 删除测试阶段：砍 3 个死导出后 `pnpm extensions:typecheck` + `pnpm extensions:test` 全绿；`rg "trackSpeed|getSecret|loadSecrets"` 在 extensions/ 非测试代码中零命中
2. 本地 pi CLI 实测 model-switch：`--extension <model-switch 源码路径>` 跑一次真实场景（模型推荐触发 quota 缓存读取），readCache 路径输出与改动前一致
3. DP-3 裁决落地后：`pnpm install`（依赖声明变化）+ extensions:test 全绿；若撤销 shared 定位，验证 model-switch 打包后 quota 功能正常（pi CLI 实测一次完整推荐流程）

**下一层拆分**：① 删除测试（死导出 + secrets.ts）② 引用扫描 + 测试修复 ③ DP-3 裁决（W4 实施前）④ 裁决分支落地 ⑤ 发布面与依赖声明同步。

---

### F4 · Ajv schema 编译层收敛（Worth · W4 · 审计先行）

**级别**：Worth · 收敛（前置审计）

**问题**：两包各自声明 ajv 依赖，选项矩阵与缓存策略分叉：
- `structured-output/src/ajv-validator.ts:12-25`：WeakMap 缓存（schema 对象引用即 key，GC 友好）+ `strict: false`
- `subagent-workflow/src/orchestration/args-validator.ts:17,35`（⚠️ 路径修正：原报告 execution/ 已漂移）：**无缓存**——有探针证据推翻缓存（编译结果恒定、重复编译无副作用），`coerceTypes: true`（spec.args 原地规范化，worker 启动与 pause/resume 依赖此语义）

**⚠️ 风险标注**：structured-output 是 infrastructure builtin（mandatory 打包内置 10 包之一），其**权威 schema 分支**背负 2026-08-01 静默丢修复事故（LLM 重写 add_channels.items schema 后自洽通过，4 条 channel 修复静默丢失，根因是旧实现校验 LLM 自报 schema 而非权威 schema）。**合并前必须确认两处分叉不是各自正确**——strict:false vs coerceTypes:true 可能是两种独立且正确的语义，收敛不得混并选项。

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| A：审计先行 → 下沉共享 schema-validator 模块 | **长期方案** | 先审计两处分叉语义（structured-output 的 strict:false 服务于权威 schema 校验 + 错误回显；subagent-workflow 的 coerceTypes:true 服务于 spec.args 原地规范化）；确认各自正确后，下沉共享 schema-validator（选项矩阵显式化：strict / coerceTypes / 缓存策略作为入参），两包改 import | 编译层单点；选项矩阵成为显式契约，未来分叉有据可查；builtin 风险通过审计 + 回归测试兜住 |
| B：保持两处分叉 + 互引注释 | 短期方案 | 在 ajv-validator 与 args-validator 各自加注释互指，说明为何不合并 | 零风险但零收敛；选项分叉继续隐性存在，下一个包引入 ajv 时无权威可循 |

**推荐**：方案 A，但**审计是硬前置**（不审计不做）。审计产出物：两处选项语义的对照结论（各自为何正确 / 是否真的正确），记录在 commit message 与代码注释。若审计发现某一处语义本身有误（如 coerceTypes 引入的隐式类型转换是 bug 源），先修语义再收敛。

**改动点**：
1. 审计两处选项矩阵与缓存策略（对照 schema 校验语义、调用方行为、历史 commit）
2. 若审计确认各自正确：shared 建 schema-validator（选项矩阵入参：`compileSchema(schema, { strict, coerceTypes, cache })`）
3. structured-output 改 import（保留 WeakMap 缓存语义 + 权威 schema 分支不动）
4. subagent-workflow 改 import（保留无缓存 + coerceTypes 语义）
5. 若审计发现分叉错误：先修对应包语义，再收敛

**风险**：structured-output 是 infrastructure builtin——改动必须重放 2026-08-01 事故场景回归（见验收 2），否则收敛 = 复发；两包 publish 面同步（dependency 声明）。

**验收（真实场景）**：
1. **权威 schema 分支回归（强制）**：重放 2026-08-01 事故场景——4 条 channel 修复的权威 schema（含 add_channels.items 校验），让 LLM 提交一个 schema 重写请求，确认校验用权威 schema 而非 LLM 自报 schema，4 条 channel 修复**不静默丢失**（对照事故 commit 的复现路径）
2. subagent-workflow 回归：本地 pi CLI 实测（mimo-v2.5-pro）——worker 启动 + pause/resume 流程，spec.args 经 coerceTypes 原地规范化行为与改动前一致（lifecycle.test.ts:210 的语义在真实 pi 场景复验）
3. `pnpm extensions:typecheck` + `pnpm extensions:lint` + `pnpm extensions:test` 全绿
4. structured-output 单测全绿（含权威 schema 分支测试）

**下一层拆分**：① 审计（选项矩阵对照 + 历史 commit 追溯）② 审计结论记录 ③ shared schema-validator 建立 ④ 两包改 import + 依赖声明 ⑤ 事故场景回归测试固化。

---

### F5 · 裸 console 迁移决策（Worth · W5 · DP-4）

**级别**：Worth · 元决策

**问题**：⚠️ 核查修正（方法论失真最重）：原计数把注释与字符串字面量当真实调用。真实裸调用分布：
- permission 12 · model-switch 14 · **subagent-workflow 0**（13 处全为注释 + worker 沙箱字符串）· evolve-daily 6 · scheduler 3
- 用了 logger 的包裸 console = 0 —— **真实数据支持「推广 logger 有效」**

extension-logger 是合格深模块（三层通道：debug/warn/error + pi handle 注入）但渗透率仅 2/17。logger 的 leverage 取决于消费面——渗透率 2/17 时它顶着共享层的名干私有依赖的活。

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| A：全仓推广 extension-logger（DP-4 推荐） | **长期方案** | permission/model-switch/evolve-daily/scheduler 共 35 处真实裸调用迁移到 extension-logger（三层通道日志是 logger 的应然形态）；subagent-workflow 保持 0 裸调用基线 | 消费面 2/17 → 6/17，logger 从「私有依赖之名」变「共享层之实」；每包改 console 调用 + 测试断言调整，工作量中等 |
| B：承认 extension-logger 是私有依赖，退出 shared 定位 | 短期方案 | 将 extension-logger 移出 shared/（并回其实际消费包或独立包），不再以共享层定位宣传 | 不改任何调用代码，但承认 shared 只剩 quota-providers 半死面，与 F3 的「撤销 shared」分支联动 |

**推荐**：方案 A。理由：真实数据（用了 logger 的包裸 console=0）证明推广有效；且 A 与 F1 协同——F1 已让 shared 变真共享层，logger 作为唯一 shared 常驻包理应获得消费面。若 F3 DP-3 裁决走「撤销 shared 定位」，则 F5 连带走方案 B（决策链：DP-3 先裁决 shared 去留，DP-4 再裁决 logger 推广——**两决策有依赖，顺序不可反**）。

**改动点**：
1. 35 处真实裸调用迁移（permission 12 / model-switch 14 / evolve-daily 6 / scheduler 3），按包分批
2. 每包注入 logger（extension default export 拿 pi → createLogger），替换 console.* 调用
3. 注释与字符串字面量（subagent-workflow 的 13 处）不动——核查已确认非真实调用
4. worker 沙箱内字符串（若需执行）保持字符串形态，不迁移

**风险**：permission 的权限决策日志是审计面（用户可查决策依据），迁移需保证日志内容与级别不降级；model-switch 的 advisor 高频调用路径（时间窗口计算）不得引入 logger 性能开销——logger 按级别短路即可。

**验收（真实场景）**：
1. 迁移后 `rg -n "console\.(log|warn|error)" extensions/*/src --include="*.ts"` 非注释/非字符串零命中（subagent-workflow 基线保持 0）
2. 本地 pi CLI 实测 permission：`PI_EXT_DEBUG=1` + `--extension <permission 源码路径>` 跑一次权限决策（approve 模式），确认决策日志走 logger 三层通道落到 `~/.pi/agent/logs/`，内容与迁移前一致
3. model-switch 实测：pi CLI 跑一次模型推荐，advisor 输出与迁移前一致，日志出现于扩展日志文件
4. `pnpm extensions:typecheck` + `pnpm extensions:lint` + `pnpm extensions:test` 全绿

**下一层拆分**：① DP-4 裁决（W5 实施前，依赖 DP-3 结果）② permission 迁移 ③ model-switch 迁移 ④ evolve-daily/scheduler 迁移 ⑤ 全仓裸调用扫描基线固化。

---

### F6 · formatDuration 同名异义（Speculative · W5）

**级别**：Speculative · 记录即可

**问题**：`goal/src/command-adapter.ts:182`（seconds → "3m5s"）vs `scheduler/src/parsing.ts:33`（ms → 多单位）。同名 formatDuration，语义与签名不同（入参单位 seconds vs ms，输出格式不同）。**判定：合法变体非拷贝**——两包无共享意图，各自语义自洽。

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| A：下沉合并为签名明确的单一实现 | 长期方案 | `formatDuration(ms, opts)` 单一实现，goal 侧包装 seconds 入参 | 统一命名空间；但为 2 个不相干的调用方加一层签名转换，收益边际 |
| B：改名消除歧义（推荐） | 短期方案 | goal 侧改名 `formatSeconds`（或 scheduler 侧改 `formatDurationMs`），加注释说明异义 | 一行改名消除「同名异义」风险，零行为变化；未来第三方读代码不误用 |
| C：现状 + 文档记录 | 不推荐 | 在两层文档记录命名冲突风险 | 零改动但风险原样留存，命名冲突是真实踩坑源 |

**推荐**：方案 B。Speculative 级候选不做结构性改动，改名 + 注释即达成「记录即可」的目标。

**验收**：改名后 `pnpm extensions:typecheck` 全绿；goal 实测 `/goal` 命令输出时长格式（"3m5s"）与改动前一致；scheduler 实测定时任务解析输出与改动前一致。

**下一层拆分**：单 commit（改名 + 注释），无拆分。

---

### 附带项 · 6 处 conventions 冲突（W3 随行）

**问题**：以下冲突集中在 subagent-workflow 与 plan 两个包（permission 是抽查 5 包中唯一 0 冲突的深包）：

| # | 冲突 | 位置 | 现状 |
|---|------|------|------|
| 1 | extension-dependencies.json 与 package.json 分类矛盾 | 仓库根 `extension-dependencies.json` | subagent-workflow → structured-output 标 runtime，却在 package.json 声明 optional peerDep |
| 2 | tool-handler.ts 超限 | `session-reader/src/tool-handler.ts`（1473 行） | 违反 ≤1000 行约束 |
| 3 | plan peerDep 覆盖不全 | `plan/package.json` | ⚠️ 核查修正：peerDependenciesMeta 字段**存在**（pi-ai 已标 optional），但 4 个 peerDependencies 中 3/4 覆盖不全（pi-goal 等未标） |
| 4 | workflows 目录未声明 | `subagent-workflow/workflows/`（含 chain/map-reduce/parallel/review-fix-loop/scatter-gather 等 6 个 js） | 有 workflows/ 目录却未在 package.json 声明 pi.workflows |
| 5-6 | 其余 2 处（同上两包内声明类不一致，以 extension-dependencies 一致性检查为准） | - | - |

**方案**（每项单一正解，无多方案分歧）：
1. **分类矛盾**：以 package.json 声明为权威（optional peerDep 是真意图——structured-output 是可选依赖），修 extension-dependencies.json 分类，或反之（选一）；同时补一个一致性检查（extension-dependencies.json 与 package.json 的对照脚本，纳入 extensions 检查面，防回潮）
2. **超限拆分**：tool-handler.ts 按「每工具一组 handler」拆分子文件（或先按「工具参数处理 / 结果转换 / 工具执行」三个内聚块拆），保持对外导出不变
3. **peerDep 覆盖**：plan/package.json 补齐 pi-goal 等剩余 peerDependenciesMeta（按实际 optional 语义标注）
4. **pi.workflows 声明**：subagent-workflow/package.json 补 `pi.workflows` 字段指向 workflows/（extension 内置 workflow 才被发现——resource-discovery 扫 7 源）

**验收**：`pnpm extensions:typecheck` + `pnpm extensions:lint` + `pnpm extensions:test` 全绿；extension-dependencies.json 与 package.json 对照检查通过（若加脚本，脚本 exit 0）；pi CLI 实测 subagent-workflow 的 workflow 被发现（`pi` 内 `workflow` 工具 list 可见 pi-subagent-workflow 内置 workflow）；tool-handler 拆分后 session-reader 实测（mimo-v2.5-pro 读一次真实 session）输出与拆分前一致。

**下一层拆分**：①② 独立 commit；③④ 各独立 commit；分类对照检查脚本单独 commit。

## §4 验收

### 层内整体验收（W3 与 W4 波次完成后各跑一次）

1. **全量检查**：`pnpm extensions:typecheck`、`pnpm extensions:lint`、`pnpm extensions:test` 全部绿（extensions/ 全部 19 包，非只改的包）
2. **共享层一致性**：`rg` 确认 F1 的 12 处本地拷贝零残留、F2 的 3 份解析循环零残留（除 adapter）、F3 的 3 个死导出零引用
3. **pi CLI 实测冒烟**：对涉及行为收敛的包（session-reader / subagent-workflow / model-switch / goal / permission）各用 `xiaomi-token-plan-cn/mimo-v2.5-pro` 在 `pi --mode rpc` 跑一次最小场景，输出与改动前一致（收敛类候选的行为等价验证）
4. **发布面检查**：新增 shared 子包/依赖声明变更后跑 `scripts/check-version-changes.sh` 确认传递闭包（npm 发布线 main 稳定发布机制，见 AGENTS.md）
5. **守护问询**：每项收敛类改动完成后自问「守护在哪」——F1/F2/F7 的收敛如果再次被拷贝漂移，谁来发现？（本层不新造 githook，随 D1 波次的 pre-commit 基建统一评估；至少要在 extensions 检查面留 rg 零残留断言脚本）

### 每候选验收汇总表

| 候选 | 验收核心（真实场景） | 全量检查 | 波次 |
|------|---------------------|---------|------|
| F1 | pi CLI 实测 session-reader 读真实 session（含特殊字符）输出 diff 一致；goal/model-switch 各实测一次 | extensions 三件套全绿 | W3 |
| F2 | pi CLI 实测 find 流程读真实 session 一致；构造坏行 JSONL 验证 adapter 防御；subagent 编排实测 | extensions 三件套全绿 | W3 |
| F7 | **subagent overlay 场景：pi 实测 subagent 完成，overlay 无工具参数 JSON 混入**；主 agent 流式回归（Playwright 9222）；runtime bundle 验证 | extensions 三件套 + validate-runtime-bundle | W3 |
| F3 | 删除测试后 rg 零引用；pi CLI 实测 model-switch quota 缓存读取一致；DP-3 裁决后打包验证 | extensions 三件套 + pnpm install | W4 |
| F4 | **权威 schema 分支回归：重放 2026-08-01 事故（4 条 channel 修复）不静默丢失**；subagent-workflow coerceTypes 语义 pi 实测一致 | extensions 三件套 | W4 |
| F5 | 迁移后 rg 裸 console 非注释零命中；pi CLI + PI_EXT_DEBUG=1 实测 permission/model-switch 日志落盘一致 | extensions 三件套 | W5 |
| F6 | 改名后 goal 实测 "3m5s" 输出一致；scheduler 解析一致 | typecheck | W5 |
| 附带 | extension-dependencies 对照检查通过；pi CLI 实测 subagent-workflow workflow 被发现；tool-handler 拆分后 session-reader 实测一致 | extensions 三件套 | W3 随行 |

## §5 下一层拆分

### 实施顺序与依赖

```
W3（本层第一批）：
  F1  ← 独立，无前置（shared utils 建立先于一切，F5 的 logger 推广依赖其包形态）
  F2  ← 与 F7 同构，建议同批（共享 adapter 的语义层划分经验互用）
  F7  ← 依赖 F2 的「shared 放格式层」先例（可选，独立可做）
  附带项 ← 独立，可并行（分类对照脚本建议先做，为后续所有 extensions 改动提供守护）
W4：
  F3  ← 硬前置：删除测试先行；DP-3 裁决（W4 实施前）
  F4  ← 硬前置：审计先行（builtin 风险，不审计不动）
W5：
  F5  ← 依赖 DP-3 结果（若撤销 shared 定位 → F5 走方案 B，两决策不可反序）
  F6  ← 独立，单 commit
```

### Commit 建议（打包相关改动逐个 commit 逐个验证，AGENTS.md §12）

| commit | 内容 | 验证 |
|--------|------|------|
| 1 | F1-① shared utils 建立 + 导出（safeStringify/escapeXml/decodeXml/时间常量） | extensions:typecheck + test |
| 2 | F1-②③④ 12 处消费点收敛（safeStringify → escapeXml → 时间常量，可再拆 2-3 个 commit 按包） | 每 commit 后 extensions:test + 对应包 pi CLI 实测 |
| 3 | F1-⑤ 消费包 dependency 声明 + 发布面检查 | check-version-changes.sh |
| 4 | F2-① pi-session-file adapter 建立（含坏行防御单测） | extensions:test |
| 5 | F2-②③④ 三处消费改造（find.ts / session-reconstructor / session-pending） | 每处后 pi CLI 实测对应场景 |
| 6 | F7-① shared 下沉 + 单测迁移 | extensions:test |
| 7 | F7-②③ event-adapter 改造（涉及 runtime 打包面） | validate-runtime-bundle.sh + Playwright 9222 实测 |
| 8 | 附带-1 extension-dependencies 分类修正 + 对照脚本 | 脚本 exit 0 |
| 9 | 附带-2 tool-handler 拆分（1473 → ≤1000） | session-reader pi CLI 实测 |
| 10 | 附带-3 plan peerDep 补全 | typecheck |
| 11 | 附带-4 subagent-workflow pi.workflows 声明 | pi CLI workflow list 实测 |
| 12 | F3-① 删除测试（死导出 + secrets.ts） | rg 零引用 + extensions:test |
| 13 | F3-④ DP-3 裁决分支落地 | pnpm install + pi CLI model-switch 实测 |
| 14 | F4-① 审计产出（commit 内记录对照结论） | - |
| 15 | F4-③④ shared schema-validator + 两包改 import | extensions:test + 事故场景回归 |
| 16 | F5-②③④ 35 处 console 迁移（按包 2-3 个 commit） | rg 零命中 + pi CLI 日志实测 |
| 17 | F6 改名 + 注释 | typecheck + goal/scheduler 实测 |

> W3 完成后跑层内整体验收（§4 清单）；W4 前先裁决 DP-3；W5 前先裁决 DP-4（依赖 DP-3 结果）。全部完成后在主文档标注实施状态。
