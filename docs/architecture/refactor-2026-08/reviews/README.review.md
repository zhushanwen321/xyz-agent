# 对抗式审查报告 · README.md（重构总纲）

> 审查对象：`docs/architecture/refactor-2026-08/README.md`（167 行，主文档/总纲）
> 审查依据：`rubric-design-doc.md`（P0-1~18 / P1-1~7）+ 项目 `AGENTS.md` 约定
> 审查方式：逐项对抗核查 + read 源码/子文档交叉验证事实（chat.ts 31 行、useSidebar.ts 565 行、extension-protocol 838 行、pinia 在 core dependencies、D1 守护扫描范围等均经实测）

## Summary

**2 must-fix, 4 suggestions.**

总纲整体质量高：五段骨架完整、SCQA 开篇、§2 跨层共性 3 条触到根因、§4 验收用真实场景（pnpm dev + Playwright + 故意制造违规看拦截）而非单测/mock、波次总览表与波次段落的波次分配逐项核对一致（D7 笔误已修正，未发现新的波次错配）。36 候选计数、包名 `@xyz-agent/frontend`、chat.ts/useSidebar 行数等关键事实均实测无误。

但有两处必须修：**①D1 守护的 scope overclaim**——主文档声称"后续所有波次回潮都被它兜住"，实测守护只扫 runtime 三层，renderer/core/electron/extensions 均无 committed 守护，与文档自身"无守护→回潮是通用病根"的论断直接冲突；**②总览表 B3 行数与子文档已修正口径不一致**（同类笔误，任务要求核对项）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §1 目标1 / §3 W1 / §2 共性3 | P0-10 对抗 + P0-12 遗漏 + P0-16 运行时断言 | **D1 守护 scope overclaim，与"通用病根"论断自相矛盾。** 主文档 §3 W1 称守护"把声明式架构变成可执行架构，**后续所有波次的回潮都被它兜住**"；§1 目标1 把"无守护→回潮"框定为跨 runtime/renderer 七层/core headless 的通用解。但实测 D1 的 `check_layer_boundaries.py` 扫描范围是 `packages/runtime/src/{transport,services,infra}/`（03-runtime.md:113），**只覆盖 runtime 三层**。其余三层无任何 committed 守护：renderer 七层(C2)——06-doc-debt.md:84 明确"不为此建守护，避免过度工程；真正需要守护的是 D1 的三层边界"；extensions——05-extensions.md:24/343 称"随 D1 波次的 pre-commit 基建统一评估"，但 D1 基建硬编码 runtime 路径、不扫 `extensions/`；core headless(B2)——01-package-chain.md:171 的 core 禁 pinia 规则标"可选"且 D1 脚本不扫 `packages/core/src/`；B1 的 re-export lint（01:88）同样"建议 W1 评估"未落地。**按文档自身 §2 共性3 的论断（"无守护→回潮是通用病根，每层落地归位类改动必须同时问守护在哪"），W2-W4 的 C2/E2/E3/F1/F2 等归位无守护必将回潮**——这正是 §4 验收项4"守护生效"只测"D1 类违规"（runtime）测不出来的盲区。 | 二选一：**(a)** 在 C2/B2/F1 等各归位波次补最小 pre-commit 守护（doc 已有种子：01:88 re-export 兼容层 lint、01:171 core-pinia 规则、renderer Feature→lib/ipc 直连扫描），把"可选"提为 committed；**(b)** 修正 overclaim——§1 目标1 / §3 W1 改为"runtime 三层回潮被兜住，其余层归位靠人工+review 守住、守护待后续评估"，并显式调和 06-doc-debt.md:84"避免过度工程"立场（说明为何 renderer 七层不值得自动化守护）。现状是目标声明与落地范围脱节，读者会误以为 W2-W4 也有自动化兜底。 |
| MUST_FIX | §3 总览表 B3 行 | P0-11 事实 | **总览表 B3 行数与子文档已修正口径不一致（同类笔误）。** 总览表 B3 写"composables/logic/ 纯函数下沉 core（**13 文件 1456 行**）"，但 01-package-chain.md 已修正为"logic/ 目录现为 **12 个 .ts 文件 1347 行**（审查时 13 文件 1456 行含 guiComponent.ts，**该文件已按 C4 内联删除；本次实测时 guiComponent 已不存在**）"。即 1456/13 是审查时旧口径，C4（W0）删除 guiComponent 后实测为 1347/12。B3 在 W3 执行（W0 之后），执行时点正确计数应为 12/1347。主文档总览表未同步子文档的修正，仍引用旧口径。这正是任务要求核对的"D7 类笔误"的同类不一致。 | 总览表 B3 改为"12 文件 1347 行（C4 删 guiComponent 后实测）"。建议同时 grep 全部子文档与总览表的数字交叉核对一遍，确认无其他旧口径残留。 |
| SUGGESTION | §3 DP-2 / W5 段 | P0-2 边界 + 产物自包含（AGENTS 规则15） | **"R9 决策"为内部审查轮次编号，主文档未释义。** DP-2 与 W5 两处提"与 R9 决策相悖"，但 R9 仅在 03-runtime.md:146 解释为"ports 按域集中拆分，runtime-module-map.md 快照时点标注"。读总纲的人未必翻到 runtime 子文档，"R9"是悬空内部引用，违反产物自包含（不引用前序版本/内部编号）。 | DP-2 行补一句释义，如"R9 = runtime-module-map.md 记载的「ports 按域集中拆分」既有裁决"，或直接链接到 runtime-module-map.md 锚点。 |
| SUGGESTION | §3 波次（W2/W5） | P1-2 拆分 justification | **D3(W2)→D2(W5) 的依赖未在主文档标注。** 03-runtime.md:136 明确"ITerminalService + IWorktreeService 各 3（⚠️ 后两者被 D3 移出 ports/，移出后 ports/ 净剩 7 个多消费方）"——即 D2 的 port 折叠计数依赖 D3 先把 2 个方向反置接口移出 ports/。主文档 W5 仅写"D2 前置：DP-2 裁决"，遗漏 D3 前置。虽 W2<W5 顺序已隐式满足，但依赖关系应显式（否则未来若调整波次会踩空：D2 先于 D3 会数错 port 清单）。 | W5 的 D2 前置补一句"依赖 D3（W2）先把 ITerminal/IWorktree 移出 ports/ 后 port 清单稳定"。 |
| SUGGESTION | §3 W5 段落 | P1-5 MECE / P1-2 | **E5 的前置说明错置在 W5 段落下，E5 实属 W4。** W5 段落末尾 bullet"E5 在 W4（总览表口径），涉及 shared 类型 + renderer 消费方，盘点先行...再动"——E5 在总览表与 W4 段落均归 W4，但其前置讨论挂在 W5，读者扫 W5 会误判 E5 属 W5、扫 W4 又找不到前置说明。 | 把该 bullet 移到 W4 段落（E5 条目下），或在 W5 显式标注"〔跨波次 note：E5 属 W4，此处仅记前置盘点〕"。 |
| SUGGESTION | §2 总览表 D2 / §3 | P1-1 关键概念无例子 | **"hypothetical seam"未定义。** 总览表 D2 与 W5 多处用"7 个 hypothetical seam 折叠"，但主文档未给定义。03-runtime.md:124-136 释为"16 个 port 全部 1:1:1（接口:实现:消费方各一），其中 7 个单消费方＝读 file-service 要跳一层接口才看到真实调用的假 seam"。总纲首次出现宜自包含。 | 总览表 D2 行或 §2 共性处补一句："hypothetical seam = 单消费方的 1:1:1 port，接口层无第二消费方，是形式上的 seam 而非真抽象点"。 |

## 附：已核查通过的事实（免疑）

| 声明 | 核查结果 |
|------|---------|
| chat.ts 906→31 行 | `packages/renderer/src/stores/chat.ts` 实测 31 行 ✓（906 为历史迁移前口径，子文档一致） |
| useSidebar.ts 565 行死壳 | 实测 565 行 ✓，消费方仅 useChatViewDeps.ts ✓ |
| core pinia 死声明 | `packages/core/package.json` dependencies 实有 `"pinia":"^3"`，生产源码零 import（仅 2 测试文件用 createPinia）✓；子文档方案 A 正确处理为 deps→devDeps（非删除） |
| 包名 @xyz-agent/frontend | `packages/renderer/package.json` name 实测即此 ✓（DP-6 改名讨论成立） |
| extension-protocol 0.8k 行零依赖 | 实测 838 行 ✓ |
| 36 候选计数 | B7+C7+D9+E7+F7=36 ✓，加 §6 文档债行 |
| 总览表 vs 波次段落波次分配 | 逐项核对一致，D7 已修正为 W3，未发现新错配 ✓ |
| W2 跨层并行无文件冲突 | C2/C3(renderer) / D3/D4(runtime 不同子目录) / E2/E3(electron 不同文件) 文件级隔离成立 ✓ |
| §4 验收 testable | 4 条全局验收均可在真实环境执行（pnpm dev + Playwright 9222 + validate-runtime-bundle.sh + 故意制造违规）；非单测/mock/抽象断言 ✓ |

## 未发现问题的维度（及原因）

- **P0-1 五段骨架**：§1-§5 齐全。
- **P0-3 结论先行**：§1 SCQA、§2 判定表、§3 波次粗体结论均达标。
- **P0-4 现状触根因**：§2 跨层共性 3 条（绞杀迁移/文档滞后/无守护→回潮）均有实例（chat.ts 下沉、module-map 过期 3 倍、runtime 回潮 9 处）。
- **P0-7/8/9 方案对比**：DP 表对 6 个真争议项给推荐+alternatives；逐候选详细对比在子文档（A/B/C 方案），总纲若全展开反成 P1-7 越层。分工合理。
- **P0-14/15 验收**：真实场景冒烟 + 守护拦截实测，投入与改动匹配。
- **P1-7 scope 越层**：总纲停留在战略/编排层，未深入函数签名（留给子文档），scope 守住。
- **P1-6 加机制 vs 减法**：整体是减法（删除/收敛/归位），D1 加守护有充分根因。
