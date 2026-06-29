---
phase: execution
round: 1
backfed_to: [code-architecture]
entries: 2
---
# backfeed-round-1-execution — ⑥反哺①-⑤检查

> design-execution Step 6b。回扫①-⑤上游，检查⑥execution 产出是否需回流修改上游文档。

## 检查结论：2 处标注性反哺（非决策推翻）

### 反哺1：⑤code-architecture.md §8 Wave DAG 与⑥定稿差异标注

**⑥定稿相对⑤§8 Wave 草图的差异**：
- ⑤§8 草图：W0 shared → W1 runtime → W2 git.diff+file.read → W3 前端 store → W4 前端 view → W5 预览 → W6 失效+搭便车 → W7 showIgnored → W8 file.write 骨架（9 功能 Wave）
- ⑥定稿：W0 Prefactor(Playwright) → W1 runtime(含原 W8 file.write 骨架) → W2 git.diff+file.read → W3 前端 store → W4 前端 view → W5 预览 → W6 失效+搭便车 → W7 showIgnored → W8 验收（8 Wave）

**差异原因**：
1. 新增 W0 Prefactor（Playwright E2E harness）——用户指令「新增 Playwright 真 E2E」，⑤无此 Wave（⑤在用户指令前完成）
2. 原 W8（file.write 骨架）并入 W1——红队审查：W8 文件与 W1 完全重叠，独立 Wave 制造 AC-14.4 疑点，并入后疑点根本不产生
3. 验收 Wave 从隐含变为显式 W8（skill [MANDATORY] 要求末尾验收 Wave）

**处理**：⑤§8 是「建议」性质（标题「对应 Wave（建议）」），⑥定稿是权威。不修改⑤§8原文（保留历史），但在⑤§8 加一行注释指向⑥定稿。

**已反哺**：code-architecture.md §8 表后加注。

### 反哺2：⑤code-architecture.md §9 骨架覆盖核验表（D-021 偏差声明已有，无需追加）

D-021 一致性审查已在⑤§9 加了「骨架 vs §3 签名表偏差声明」。⑥W3 的「⚠️ D-021 强制对齐项」与此一致——W3 实现时按§3 签名表非骨架旧结构。**无需追加反哺**，⑥引用⑤既有声明即可。

## 未触发反哺的上游

- ①requirements：UC 覆盖不变（UC-5 实现仍延后，协议骨架在 W1）
- ②system-architecture：决策未被⑥推翻（D-018 file.write 骨架不延后仍兑现，只是从独立 Wave 并入 W1）
- ③issues：issue 覆盖不变（#14 仍兑现，归属 W1）
- ④non-functional-design：NFR 路由不变

## 结论

2 处反哺均为标注性（差异说明），非决策推翻。⑥execution 与①-⑤上游一致，可进 Step 6c 一致性终检。
