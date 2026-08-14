# 设计文档对抗式审查报告

> **审查对象**：`.xyz-harness/shared-llm-config/design.md`（独立 LLM 调用共享库 + 配置统一收口）
> **审查依据**：`tech-design` skill 的 `rubric-design-doc.md`（P0 致命 / P1 建议）
> **审查方式**：逐项核实文档声明的文件路径/行号/API/字段名，read 源码交叉验证 6 个关键事实 + 副作用面

## Summary

**2 must-fix, 5 suggestions.** 整体文档质量高——五段骨架完整、方案对比充分（5 决策 × ≥2 方案 × 三栏评估）、验收用真实场景 + ⛔ 探针 + 回溯目标、运行时断言诚实标注待验证。6 个关键事实中 5 个核实正确（ExtensionContext 无 settings API、ModelRegistry 无 scope、permission 自读 models.json、completeSimple/streamSimple 入参同形、三废弃包可删）。must-fix 集中在**删废弃包的 docs 引用遗漏**和**production.ts 路径归属误导**两处事实性/副作用问题。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §2.6 + §5.2 | P0-11 事实 / P0-12 副作用 | **"无 CI/脚本/docs 引用"断言错误，且遗漏 docs 清理决策**。实测 `docs/extensions/` 下至少 5 个 .md 引用 evolve-daily：`research/permission/technical/01-pi-llm-invocation.md:217`、`adr/pi-ext-024-skill-tracker-active-declaration.md`、`glossary.md:177`（"Evolve 自进化系统"术语条目）、`third-party-extensions/{README,autocontext-vs-evolve-architecture-comparison,evolve-ecosystem-comparison}.md`。§5.2 "修改"清单只列了 `AGENTS.md` 和 `extension-dependencies.json`，未涵盖这些 docs。删包后它们成悬空引用。 | 核实全部 docs 引用并分类处理：ADR/竞品分析属历史记录可保留但建议加 deprecation 标注；glossary 术语条目 + 01-pi-llm-invocation 现状描述指向已删包，需更新或删除。在 §5.2 补 docs 清理条目，§2.6 修正"无 docs 引用"措辞。 |
| MUST_FIX | §2.1 + 附录 A | P0-11 事实 | **production.ts 路径归属误导**。§2.1 小标题写 `extensions/permission/src/classifier/`，紧接的代码注释写 `classifier.ts:188 + production.ts:45-51`——读者会去 `classifier/` 目录下找 production.ts，实际它在 `extensions/permission/src/production.ts`（classifier 的**父级**目录）。行号 45-51 正确（streamSimple wrapper 在第 45-50 行），但目录归属不清。附录 A 引用 `production.ts:38-51` 同样缺完整路径。 | 补全路径：`src/production.ts:45-51`（§2.1）、`extensions/permission/src/production.ts:38-51`（附录 A）。 |
| SUGGESTION | §3.3 决策 A + §3.3 决策 E | P0-10 对抗 | **scoped→available 语义替换对 permission 的影响论证不足**。决策 A 放弃 scoped 改用 `getAvailable()`，理由是"语义接近"。但 `getAvailable()` = 配了 auth 的**全量** model，scoped = 用户**启用子集**，两者范围不同（getAvailable ⊇ scoped 通常）。对 rename（默认精确 ref）影响小，但对 permission（C1 收口后 `{type:"available"}` 取首个）可能选到用户未启用、甚至非预期的 model。决策 E 又断言"available 取首个等价于 permission 现在的退化结果"——但 `getAvailable()` 顺序（三源合并）vs permission 现有 `flattenModels` 顺序（models.json 单源 Object.entries 插入序）未必一致，这个"等价"是新的运行时断言却未标 ⛔ 探针。 | 在决策 A 补充：getAvailable vs scoped 的范围差异对 permission 的实际影响有多大；在决策 E 的"等价"断言补 ⛔ 探针（对比 getAvailable()[0] 与 flattenModels[0] 在 xyz-agent 环境是否同 provider/model）。 |
| SUGGESTION | §2.3 问题 6 | P0-11 事实 | **"字典序首项"措辞不精确**。文档称 auto 退化后"结果恒为 `Object.entries(providers)` 字典序首项的首个 model"。实测 `findCheapestModel`（model-resolver.ts:159-166）用 `flattenModels` 遍历 `Object.entries(providers)`，而 `Object.entries` 返回的是对象**插入顺序**，非字典序——除非 models.json 的 providers 定义恰好按字典序排列。核心结论（auto 失效、取首个、与 cost 无关）正确，但"字典序"用词不准。 | 改为"插入顺序首项（即 models.json 中 providers 对象第一个 key 的第一个 model）"。 |
| SUGGESTION | §3 / §4 | P0-12 副作用 | **fire-and-forget 语义契约未显式声明**。现状 `index.ts:44-50` 是真正的 fire-and-forget（`void callRenameLLM(...).then(...).catch(...)`，handler 立即 resolve，LLM 调用后台异步）。改造后此契约是否保留？场景 2"不阻断主对话"隐含了，但未作为显式契约声明。实施者若改为 await 会阻塞 turn_end handler，与现有行为不符。 | 在 §3 或 §4 显式声明："改造后 turn_end handler 保留 fire-and-forget 语义（handler 同步 resolve，LLM 调用与 setSessionName 后台异步），禁止 await callLLM 阻塞 handler。" |
| SUGGESTION | §1.1 / §2.4 / §5.2 | P0-11 事实 | **extension 包数量口径不一致**。文档 §1.1 / §2.4 称"18 个 pi extension 包"，但 AGENTS.md「Pi Extension 全集」表列 17 个 `@zhushanwen/pi-*` 包 + `extensions/shared/quota-providers`。实测 `extensions/` 下 18 个顶级目录（含 `shared/` 容器），真正的 `@zhushanwen/pi-*` 包 17 个，`shared/` 下另有 `extension-logger` + `quota-providers`。删 3 个废弃包后，文档口径（18→15）与 AGENTS.md 表（17→14）对不上。 | 统一口径：明确"18 个顶级目录（含 shared）"还是"17 个 @zhushanwen/pi-* 包"，并在 §5.2 注明删包后 AGENTS.md 表从 17 行减至 14 行。 |
| SUGGESTION | §3.4 callLLM 伪代码 | P0-12 副作用 | **callLLM 的 completeSimple 参数结构未核对接收方签名**。伪代码第二参数传 `{systemPrompt, messages, tools:[]}`，第三参数传 `{apiKey, headers, env, signal, maxTokens, timeoutMs}`。compat.d.ts 确认 `completeSimple(model, context, options)` 三段式，但 context 是否接受 `tools` 字段、options 是否接受 `timeoutMs` 字段，需核对 pi-ai 的 `Context` / `SimpleStreamOptions` 定义（compat.d.ts 未展开）。若字段名不符，实施时 callLLM 会静默忽略或报错。 | §5.3 待验证检查点补一条：核对 `Context` 与 `SimpleStreamOptions` 的字段名（systemPrompt vs system、tools 是否在 context、timeoutMs 是否在 options），作为 P1 实施的首个类型对齐探针。 |

## 已通过项（核实确认无误的关键事实）

- **ExtensionContext 无 settings API**（§2.3 问题 5）：types.d.ts:208-250 确认无 getSettings/getEnabledModels/settingsManager。断言正确。
- **ModelRegistry 无 scope 参数**（§2.2）：model-registry.d.ts:25-35 确认 getAll/getAvailable/find/getApiKeyAndHeaders/hasConfiguredAuth/isUsingOAuth，无 scope 入参。正确。
- **permission 自读 models.json**（§2.1）：model-resolver.ts:108 `readFileSync`，不走 modelRegistry。正确。
- **completeSimple/streamSimple 入参同形**（§2.3 问题 7）：compat.d.ts:65-66 两者都是 `(model, context, options?: SimpleStreamOptions)`，仅返回值不同。loader.js:43-44 确认 `@earendil-works/pi-ai` 与 `/compat` 都重映射到 compat。正确。
- **三废弃包不在 mandatory/recommended**（§2.6）：mandatory-extensions.json 含 9 包（ask-user/goal/todo/pending-notifications/subagent-workflow/structured-output/permission/scheduler/rename-session），recommended 为 `[]`，均不含待删三包。正确。
- **permission 对 statusline 是纯反射依赖**（§2.6）：footer-provider.ts:16 确认"不静态 import statusline"，用 `Symbol.for("@zhushanwen/pi-statusline.footerHandshake")` 反射，statusline 缺失即 noop。删 statusline 后 footer-provider.ts 留着合理（设计内）。正确。
- **getAvailable() 含 OAuth provider**（§4 场景 3 依赖）：model-runtime.js:149 `available = all.filter(model => configuredProviders.has(model.provider))`，:163-169 configuredProviders 来自 auth 检查，:418 OAuth provider 标记为 `type:"oauth"` 并计入。场景 3 理论成立（文档已在 §5.3 检查点 2 诚实标注待探针）。
- **硬编码路径三包**（§3.6）：model-switch config.ts:15 `join(homedir(),".pi","agent")`、vision vision-model.ts:44 `path.join(os.homedir(),".pi","agent",...)`、scheduler store.ts:15-24 `os.homedir()`+`.pi/agent/scheduler/...`。全部确认。正确。
- **config.ts 原子写范式存在**（§3.5）：permission config.ts:183-189 确实是 tmp+rename+mode 0o600。文档引用准确。

## 结构与验收质量评价

- **五段骨架**（P0-1）：§1-§5 齐全，无缺失。通过。
- **方案对比**（P0-7/8/9）：5 个决策，每个 ≥2 方案，决策 A/C 有"长期合理性+短期成本+风险"三栏 + 明确推荐。决策 B/D/E 简化为两栏但属小决策，合理。通过。
- **验收**（P0-13/14/15）：6 场景，全部真实环境（非 mock/单测），每个回溯 §1 目标，场景 3/4 带 ⛔ 前后对比探针，场景 5/6 带 ⛔ 文件系统探针。投入匹配改动规模。通过。
- **运行时断言探针**（P0-16）：completeSimple 静态 import、getAvailable OAuth、auto 失效、config 原子写 Windows 均标 ⛔。诚实。通过。
- **错误恢复指引**（P0-18）：§3.4 错误规格表每个错误配恢复动作（检查 models.json / pi auth login / getAvailable 列出）。通过。
