---
verdict: APPROVED
reviewer: 独立执行计划审查 subagent（上下文隔离）
target: execution-plan.md + execution-plan.html
upstream: code-architecture.md, issues.md
prior_trace: tracing-exec-2.md
date: 2026-06-24
---

# 执行计划审查报告（5 维）

## 结论速览

**APPROVED。** 5 维全部通过，遗留均为 cosmetic/可读性问题，不影响下游 subagent 派遣。前置追踪报告 tracing-exec-2.md 判定的 2 个阻塞 gap（R1 W2a 标签 / R2 §6.3 点5 事实错误 + 措辞矛盾）**已在当前版本全部修复**（源码核验见下），计划已进入可安全派遣状态。

### 前置 gap 修复核验（tracing-exec-2 R1/R2）

| 前置 gap | 核验点 | 当前状态 |
|---------|--------|---------|
| R1: W2a 标「垂直切片」 | execution-plan.md:214 | ✅ 已改「前端切片（新建容器组件，runtime 已就绪）」 |
| R2a: code-arch §6.3 点5「接近上限…可能超 400 行」事实错误 | code-architecture.md:1140 | ✅ 已改「Panel.vue 当前 92 行…退化为上帝对象…架构解耦，非 LOC 压力」 |
| R2b: W2a 文件影响「避免 Panel 超 LOC」 | execution-plan.md:220 | ✅ 已改「经 useSideDrawer 架构解耦，避免 Panel 承担 tab/dock 状态」 |
| R2c: W2a Subagent 配置「Panel LOC 预算提取」 | execution-plan.md:223 | ✅ 已改「Panel 控制逻辑下沉 useSideDrawer 架构解耦」 |

全部 9 个 Wave 的切片类型标签现已统一：仅 W1a 是唯一真「垂直切片」，其余 8 个为「前端切片」。

---

## 维度 1：内部一致性 — **PASS**

### DAG 边 ↔ 调度表 blocked_by

逐边核验，完全一致：

| DAG 边（Mermaid） | 调度表 blocked_by | 一致 |
|------------------|------------------|------|
| W0→W1g | 1a: W0 | ✅ |
| W0→W1e | 1b: W0 | ✅ |
| W0→W1f | 1c: W0 | ✅ |
| W1g→W2s | 2a: W1a | ✅ |
| W0→W2n | 2b: W0 | ✅ |
| W0→W2c | 2c: W0 | ✅ |
| W2s→W3w / W1e→W3w | 3a: W2a, W1b | ✅ |
| W2c→W3r / W0→W3r | 3b: W0, W2c | ✅ |

### 切片类型标签统一性

R1 修复后，标签一致：W0=prefactor，W1a=垂直切片（唯一），W1b/W1c/W2a/W2b/W2c/W3a=前端切片（runtime 已就绪），W3b=前端切片（runtime+store 均就绪）。无矛盾。

### #3 偏离声明 ↔ W1a 实际

偏离声明（:139）称「#3 从 issues/code-arch 的 W2 提前合并进 W1a」。W1a 标题「git 全栈（#1 + #3）」、文件影响含 GitZone.vue 创建（:144）。声明与实现一致 ✅。

**小问题（非阻塞）**：DAG 节点用后缀 g/e/f/s/n/c/w/r（Mermaid），调度表与 Wave 详情用 a/b/c。两套命名混用增加读者映射成本。属修订前既有，不影响边语义。

---

## 维度 2：上游对齐 — **PASS**

### 依赖 DAG（§6.2，绑定约束）忠实保留

逐条核验 code-architecture §6.2 关键依赖 DAG，全部在执行计划中保留（编号映射：F11=#12, F7=#8, F6=#4, F1/F2=#1, F3=#5, F5=#7, F4=#6, F8=#10, F10=#9, F9=#11, F7UI=#13）：

| §6.2 边 | 执行计划映射 | 保留 |
|---------|------------|------|
| F11→F7 | W0 内（#12/#8 同 Wave） | ✅ |
| F11→F1 | W0→W1a | ✅ |
| F11→F3 | W0→W1b | ✅ |
| F11→F8 | W0→W1c | ✅ |
| F7→F6 | W0 内（#8/#4 同 Wave） | ✅ |
| F7→F8 | W0→W1c | ✅ |
| F7→F7UI | W0→W3b | ✅ |
| F1→F10 | W1a→W2a | ✅ |
| F3→F9 | W1b→W3a | ✅ |
| F10→F9 | W2a→W3a | ✅ |

执行计划**新增**的边均为文件冲突串行（Panel.vue #1→#9、extension.ts #5→#11、Composer.vue #6→#13、SideDrawer.vue #9→#11），合法且有据。

### 上游结论未被偷改

- **[STALE] ToolCallStatus.pending 移除**：执行计划未加 pending case，#12 未加 pending 枚举 ✅
- **#13 [SURFACED] P1 升级**：W3b 标 P1（[SURFACED] spec C10 形态已定），保留 issues.md 裁决 ✅
- **#8/#2 回归标注**：W0 明确「已实现·回归验证」「明确告知勿重写」，未降级为重写 ✅
- **runtime-ready 声明**：#5（:314-476）/ #6（:161）/ #7（:322）/ #11（:364/383）/ #8 processor 全 case / #2 无 get* —— tracing-exec-2 已逐行源码核验属实，未发现虚假声明 ✅

**小问题（非阻塞）**：
1. **Wave 编号相对 §6.1 偏移未声明**：§6.1 把 F11/F7/F6 映射到 W1，执行计划引入 W0 prefactor 后整体后移一位（执行计划 W0≈§6.1 W1，W1a≈§6.1 W1 git+W2 GitZone）。只有 #3 GitZone 的 Wave 偏移被显式声明，其余偏移（Extension W2→W1b、FileView W2→W1c、retryUI W2→W3b）是并行分组优化的隐含结果。绑定约束（§6.2 DAG）已保留，不影响正确性，仅影响跨文档可追溯性。
2. **#13 从 issues.md「W2」移到「W3b」无跨文档偏离声明**：移因 Composer.vue 冲突（#6 在 W2c 必须先释放），冲突本身在文件冲突表（:22）有记录，但未像 #3 那样显式声明 Wave 偏移。

---

## 维度 3：可执行性 — **PASS**

### 每 Wave 可直接派遣

9 个 Wave 均有完整四要素：文件影响（含创建/修改清单）+ 注入上下文（issues 方案号 + code-arch 章节号 + 关键提醒）+ 读取文件 + 验收标准。下游 subagent 拿着任何一份都能直接干活。

### 关键路径清晰

「W0 → W1a git → W2a SideDrawer → W3a widget（4 跳）」在总览、调度表脚注、执行交接三处重复声明，HTML 用 accent 色高亮路径节点。无歧义。

### 并行安全（同文件不冲突）

逐并行组核验文件互斥：

| 组 | 成员文件集 | 互斥 |
|----|-----------|------|
| A | git{server.ts, Panel.vue, git-*, GitZone.vue} ∥ ext{extension.ts, ExtensionPage.vue} ∥ fileview{Sidebar.vue} | ✅ |
| B | SideDrawer{Panel.vue, SideDrawer.vue, useSideDrawer.ts} ∥ session{useSidebar.ts} ∥ compact{Composer.vue, chat.ts} | ✅ |
| C | widget{extension.ts, SideDrawer.vue} ∥ retryUI{Composer.vue, RetryIndicator.vue, QueueBubble.vue} | ✅ |

跨组文件冲突（Panel.vue #1→#9、extension.ts #5→#11、Composer.vue #6→#13、SideDrawer.vue #9→#11）均被对应 DAG 边覆盖，串行保证成立。

### runtime-ready 声明不误导

声明只对 #5/#6/#7/#8/#11/#2 做出，均经源码核验；#1 git 明确标「唯一真垂直切片」需 runtime+前端全建。subagent 不会误以为 #1 是纯前端。

**小问题（非阻塞）**：W0/W1a 的 Subagent 配置表含 Agent 行，W1b–W3b 省略（隐含 general-purpose）；W0/W1a 含「修改/创建文件」行，其余省略（清单在文件影响小节）。格式不统一但不缺信息。

---

## 维度 4：完整性 — **PASS**

### P3 延后项均有理由

| 延后项 | 理由 |
|-------|------|
| #14 Plugin 管理页 | C4 决策维持 deferred（本期只做 Extension 不做 Plugin） |
| #15 session 分组 UI | 非核心，列表可先平铺 |
| #16 ContextChipsBar/ProgressZone 真实数据 | 协议级缺口（附件/pi 无 todo），需后端先建通道 |
| #17 @/# 搜索通道 | 协议级缺口，需整体设计 |

理由充分，无遗漏关键延后项。

### prefactor Wave（W0）真铺路

W0 净新代码 = #12 契约 + #4 mock，为下游提供：
- #12 类型契约 → W1a（git 类型）/ W1b（ExtensionInfo.tools）/ W1c（FileChangeStatus.unmerged）
- #4 mock 流式 → 端到端验证 store 消费链
- #8/#2 回归验证 → 确认 store 访问器（getRetryState/getQueueState/applyFileChanges）+ domain 订阅形态就绪，供 W1c/W3b/W2b/W2c 复用

无悬空依赖（tracing-exec-2 第二节已逐条核验闭合）。

**小问题（非阻塞）**：W0 对 #8/#2 说「已实现勿重写」，但未定义「回归若失败」的升级路径。实践中 tracing 已源码核验这些访问器存在，风险极低；但严格说缺一个「回归失败则回退到补实现」的兜底说明。

---

## 维度 5：可视化质量 — **PASS**

### HTML DAG 渲染

ASCII 拓扑正确表达 W0→3 分支→W1a/W2a/W3a 关键路径 + 并行组 A/B/C 分层。关键路径用 accent 色高亮，底部 `═══ 关键路径: W0 → W1a → W2a → W3a（4 跳）═══` 标注。调度表（含 P级/类型 badge/blocked_by/并行组）与 .md 一致。

### 文件冲突表（HTML）

HTML 列全 5 个冲突文件（Panel.vue/Composer.vue/extension.ts/SideDrawer.vue/server.ts），比 .md 的 3 行表更完整。

**小问题（非阻塞）**：
1. **.md 文件冲突表不全**（:19-23 仅列 Panel.vue/Composer.vue/server.ts），缺 extension.ts 和 SideDrawer.vue。但两者在 DAG 注释（:60）和 HTML 冲突表中均有，调度表 blocked_by 也编码了串行约束，subagent 不会因此漏串行。建议 .md 表补齐 5 行以与 HTML 对齐。
2. **ASCII 省略 W0→W3b 边**：W3b blocked_by 含 W0（依赖 #8 store 访问器），ASCII 只画了 W2c→W3b（Composer.vue 冲突），未画 W0→W3b。调度表正确，不影响派遣。

---

## 非阻塞观察汇总（均不影响下游派遣）

| # | 问题 | 位置 | 性质 |
|---|------|------|------|
| O1 | DAG 节点命名双轨（g/e/f/s vs a/b/c） | Mermaid DAG | cosmetic，可读性 |
| O2 | Wave 编号相对 §6.1 偏移，仅 #3 偏移显式声明 | 总览/调度表 | 可追溯性 |
| O3 | #13 从 issues「W2」移到「W3b」无跨文档偏离声明 | W3b | 一致性（冲突已记录） |
| O4 | Subagent 配置表格式不统一（W1b–W3b 省 Agent/修改文件行） | Wave 详情 | 格式一致性 |
| O5 | .md 文件冲突表仅 3 行（缺 extension.ts/SideDrawer.vue） | :19-23 | 表完整性（信息在别处有） |
| O6 | ASCII DAG 省略 W0→W3b 边 | HTML DAG 图 | 图完整性（表正确） |
| O7 | W0 标 P2 但含 #4 P1 + #8/#2 P0 回归；#1 issues 标 P0 但 W1a 标 P1 | :66, :67 | P级语义模糊（blocked_by 才是排序依据） |
| O8 | #8/#2 回归失败的兜底路径未定义 | W0 | 风险预案（tracing 已核验存在，风险低） |

---

## 判定依据

**APPROVED** = 5 维均通过或仅 cosmetic 小问题（不影响下游派遣）。

- 维度 1（内部一致性）：PASS —— DAG/调度表/标签/偏离声明全一致
- 维度 2（上游对齐）：PASS —— §6.2 绑定 DAG 完整保留，[STALE]/[SURFACED]/回归标注均忠实，runtime-ready 声明源码核实
- 维度 3（可执行性）：PASS —— 9 Wave 四要素齐全，关键路径清晰，并行组文件互斥，runtime-ready 不误导
- 维度 4（完整性）：PASS —— P3 延后有理由，prefactor 真铺路，无悬空依赖
- 维度 5（可视化）：PASS —— DAG 正确渲染，关键路径标注，排版可读

8 个非阻塞观察全部属于 cosmetic/可读性/可追溯性范畴，**没有任何一个会让下游 subagent 卡住、改错文件或遗漏关键依赖**。核心调度信息（blocked_by、文件清单、并行组、验收标准、runtime-ready 边界）全部正确且完整。

**建议**：可直接进入编码派遣。若有余力，建议作者顺手修 O5（.md 冲突表补齐 5 行）和 O7（P级列补一句「wave 级优先级，非 issue 级；排序以 blocked_by 为准」），消除两处最易让读者困惑的小瑕疵，但非放行前提。
