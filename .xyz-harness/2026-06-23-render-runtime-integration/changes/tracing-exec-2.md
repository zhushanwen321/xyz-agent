# 执行计划追踪报告 — tracing-exec-2（收敛复核）

**追踪对象**: execution-plan.md（修订后）+ code-architecture.md（上游）
**追踪者**: 独立 subagent（上下文隔离，源码验证）
**追踪日期**: 2026-06-24
**结论**: **NOT CONVERGED** — 7 个核心 gap 中 6 个已闭合，但 **D3 未完全闭合**（W2a SideDrawer 漏改标签），**F5 未完全闭合**（验收标准已改，但上游 §6.3 点5 事实错误残留 + W2a 内部措辞自相矛盾）。两者均集中在 W2a SideDrawer，风险低、修复成本 < 5 行。无结构性新 gap。

---

## 一、首轮 7 gap + F5 逐项核验

| # | 类型 | 首轮 gap | 修订后状态 | 证据（源码/计划行号） |
|---|------|---------|-----------|---------------------|
| F1 | F | #8 已实现 → W0 标「已实现·回归验证」 | ✅ **闭合** | W0 P级覆盖「P1（#8 #2 回归验证）」；runtime 已就绪确认块「#8 chat store 消息补全 **已实现**…→ **#8 回归验证**，无新代码」；文件影响「回归验证（不应改）: chat-chunk-processor.ts」；Subagent 配置「明确告知 #8/#2 已实现勿重写」。源码复核：chat-chunk-processor.ts thinking_end:107 / tool_call_update:172 / complete.usage:195 / auto_retry_*:262,276 / queue_update:285 / file_changes:345 全部存在 |
| F2 | F | #2 已实现 → W0 标「已实现·回归验证」 | ✅ **闭合** | W0 功能项「#2 domain 规范化 — **已实现·回归验证**（settings.ts/config.ts 已无 get*）」。源码复核：settings.ts:4 注释「返工前（错误）：getSkills/getAgents/getExtensions 全 Promise」已改 onSkills/onAgents/onExtensions（:25-27），无 get* 残留 |
| F3 | F | #5 runtime 已就绪 → W1b 前端单层、删 runtime 创建项 | ✅ **闭合** | W1b「切片类型: 前端切片（runtime 已就绪）」；文件影响仅列 extension.ts + ExtensionPage.vue，「runtime 零改动（extension-service.ts 全套 install 方法、IInstaller port、handler 路由均已存在）」；已删除首轮的 installer.ts/extension-settings.ts 创建项。源码复核：extension-service.ts installLocalDirectory:314 / installGitRepository:364 / finishInstall:417 / cancelInstall:476 齐全 |
| F4 | F | #10 文件位置 → W1c 改 Sidebar.vue | ✅ **闭合** | W1c 文件影响「修改 Sidebar.vue（fixtureFileChanges:143 → chat store 派生 fileChanges）」「FileView.vue 保持不变（props.changes 接收，签名稳定）」；验收「Sidebar.vue 从 chat store 派生…grep fixtureFileChanges → 无输出」。源码复核：fixtureFileChanges import 确在 Sidebar.vue:143（非 FileView.vue），FileView.vue 经 props.changes 接收。FileView 签名二选一已消解（选保持 props 不变） |
| D1 | D | W1e→W3w 边理由 → extension.ts 文件冲突 | ✅ **闭合** | DAG 注释（execution-plan.md:60）「**W1e→W3w 是 extension.ts 文件冲突串行**（#5 在 W1b 补 install 方法、#11 在 W3a 补 onWidget，同改 extension.ts；widget 订阅与安装 UI 功能独立，边仅为文件安全保留）」 |
| D2 | D | #3 Wave 偏离 → 显式声明 | ✅ **闭合** | W1a「跨文档偏离声明」（execution-plan.md:139）「issues.md 依赖表与 code-architecture §6.1 将 #3 GitZone 归入 W2。本计划把 #3 提前合并进 W1a…理由：#3 严格依赖 #1…合并可省一跳、缩短关键路径…Panel.vue 文件冲突要求 #1/#3 串行」 |
| D3 | D | 垂直切片标签过度 → 前端切片 | ⚠️ **未完全闭合（W2a 漏改）** | 5/6 已改：W1b/W1c/W2b/W2c/W3a =「前端切片（runtime 已就绪）」，W3b =「前端切片（runtime + store 均已就绪）」。**但 W2a SideDrawer（execution-plan.md:214）仍标「垂直切片」**。SideDrawer #9 纯前端（创建 SideDrawer.vue + useSideDrawer.ts + 改 Panel.vue，零 runtime 工作），标「垂直切片」与 D3 修复意图相悖 |
| F5 | F | Panel.vue LOC 论据 → 架构解耦 | ⚠️ **未完全闭合（上游残留 + W2a 内部矛盾）** | W2a 验收标准（execution-plan.md:225）已改✅「架构解耦，避免 Panel 随 tab/dock 状态膨胀」。但残留三处：①W2a 文件影响（:220）仍写「经 useSideDrawer 避免 Panel 超 LOC」；②W2a Subagent 配置（:223）仍写「Panel LOC 预算提取 useSideDrawer」；③**上游 code-architecture §6.3 点5（:1140）未改，仍写「Panel.vue 现有 template 接近上限…可能超 400 行」——事实错误**（源码：Panel.vue 实为 92 行）。验收标准与文件影响/Subagent 配置在同一 Wave 内自相矛盾 |

---

## 二、W0 缩小后依赖链闭合性复核（重点检查项）

W0 净新代码仅剩 #12（contract）+ #4（mock），#8/#2 降级为回归验证。逐条核验下游依赖是否仍落回 W0：

| 下游 Wave | 依赖项 | 落点 | 闭合？ |
|-----------|--------|------|--------|
| W1a git (#1+#3) | #12 git 类型（GitStatusResult/FileChangeStatus.unmerged/git.* ClientMessageType）、#4 mock/git.ts | 均 W0 | ✅ |
| W1b ext (#5) | #12 ExtensionInfo.tools | W0 | ✅ |
| W1c fileview (#10) | #8 store fileChanges 访问器（已实现·回归）、#12 FileChangeStatus.unmerged | 均 W0 | ✅ |
| W2a SideDrawer (#9) | W1a（git Diff 触发源 + Panel.vue 冲突） | W1a | ✅ |
| W2b session (#7) | events.onGlobalType（#2 回归，已存在） | W0 | ✅ |
| W2c compact (#6) | runtime compact 已就绪（message-dispatcher.ts:161） | W0 | ✅ |
| W3a widget (#11) | W2a SideDrawer 容器 + W1b extension.ts 冲突 | W2a/W1b | ✅ |
| W3b retryUI (#13) | #8 store 访问器 getRetryState/getQueueState（已实现·回归）、W2c Composer.vue 冲突释放 | W0/W2c | ✅ |

**结论：依赖链闭合，无悬空边。** #8/#2 降级为回归不影响任何下游 Wave（其产物已存在于代码，W0→下游边仍成立）。

---

## 三、DAG 边与并行安全复核（检查修订是否引入新 gap）

### DAG 边准确性

| 边 | 语义 | 准确？ |
|----|------|--------|
| W0→W1g/W1e/W1f/W2n/W2c/W3r | 依赖 W0 契约地基 | ✅ |
| W1g→W2s | SideDrawer 依赖 git Diff 触发源 + Panel.vue 冲突 | ✅（双重约束成立） |
| W2c→W3r | Composer.vue 冲突串行 | ✅ |
| W2s→W3w | widget 渲染进 SideDrawer 容器 | ✅ |
| W1e→W3w | extension.ts 文件冲突串行 | ✅（D1 已修正理由） |

**无遗漏依赖、无多余边。**

### 并行组文件互斥（修订后）

| 并行组 | 成员文件集 | 互斥？ |
|--------|-----------|--------|
| A（W1a/W1b/W1c） | git{server.ts, Panel.vue, git-*✨, GitZone.vue✨} ∥ ext{extension.ts, ExtensionPage.vue} ∥ fileview{Sidebar.vue, FileView.vue[不变]} | ✅（Sidebar.vue 仅 W1c 触碰；extension.ts 仅 W1b 触碰；Panel.vue 仅 W1a 触碰） |
| B（W2a/W2b/W2c） | SideDrawer{Panel.vue, SideDrawer.vue✨, useSideDrawer.ts✨} ∥ session{useSidebar.ts} ∥ compact{Composer.vue, chat.ts} | ✅ |
| C（W3a/W3b） | widget{extension.ts, SideDrawer.vue} ∥ retryUI{Composer.vue, RetryIndicator.vue✨, QueueBubble.vue✨} | ✅ |

**并行安全基石未受修订影响。** 串行边（Panel.vue: #1→#9；extension.ts: #5→#11；Composer.vue: #6→#13；SideDrawer.vue: #9→#11）均被对应 DAG 边覆盖。

---

## 四、新 gap 扫描

### 无结构性新 gap

- 依赖闭合 ✅、文件互斥 ✅、DAG 边准确 ✅、runtime-ready 声明经源码复核全部属实 ✅（#5/:314-476、#6/:161、#11/:364-383、#8 processor 全 case、#2 无 get*）。
- W0 缩小未产生悬空依赖（见第二节）。

### 残留 gap（2 项，均低风险、集中于 W2a）

#### Gap-R1（D3 残留）：W2a SideDrawer 标签漏改

- **位置**: execution-plan.md:214「**切片类型**: 垂直切片」
- **事实**: SideDrawer #9 零 runtime 工作（创建 SideDrawer.vue + useSideDrawer.ts + 改 Panel.vue），同 W1b/W1c/W2b/W2c/W3a 一样属前端单层。首轮 D3 明确要求 6 个误标 Wave 改为「前端切片」，修订改了 5 个，**独漏 W2a**。
- **风险**: 低（不影响并行安全或依赖闭合；仅 subagent 工作量预期偏差——可能误以为需建 runtime）。
- **修复**: execution-plan.md:214 改为「**切片类型**: 前端切片（runtime 已就绪）」。

#### Gap-R2（F5 残留）：上游 §6.3 点5 事实错误 + W2a 内部矛盾

- **位置**:
  - code-architecture.md:1140「Panel.vue 现有 template 接近上限…可能超 400 行」（**事实错误**：Panel.vue 实为 92 行）
  - execution-plan.md:220「经 useSideDrawer 避免 Panel 超 LOC」
  - execution-plan.md:223「Panel LOC 预算提取 useSideDrawer」
- **矛盾点**: W2a 验收标准（:225）已正确改为「架构解耦」，但同一 Wave 的文件影响 + Subagent 配置仍用「LOC 预算/超 LOC」措辞，且 Subagent 配置显式引用 §6.3 点5（仍含 92≠400 的事实错误）。subagent 读到「§6.3 点5 Panel LOC 预算」后会进入一个与实际行数（92）矛盾的上下文。
- **风险**: 低（验收标准本身正确；useSideDrawer 提取仍是正确决策，动机应统一为架构解耦而非 LOC）。但不修会让 subagent 上下文自相矛盾，削弱对提取动机的信任。
- **修复**:
  1. code-architecture.md:1140「Panel.vue 现有 template 接近上限…可能超 400 行」→ 改为「Panel.vue 当前 92 行，但 GitZone + SideDrawer 触发逻辑直接堆入会使 Panel 承担 tab/dock 状态管理，退化为上帝对象。提取 useSideDrawer 是架构解耦，非 LOC 压力」。
  2. execution-plan.md:220「避免 Panel 超 LOC」→「架构解耦，避免 Panel 承担 tab/dock 状态」。
  3. execution-plan.md:223「Panel LOC 预算提取 useSideDrawer」→「Panel 控制逻辑下沉 useSideDrawer（架构解耦）」。

### 非阻塞观察（不计入收敛判定）

- **DAG 节点命名双轨制**：Mermaid DAG 用后缀 g/e/f/s/n/c/w/r（W1g/W1e/W1f/W2s/W2n/W2c/W3w/W3r），调度表与 Wave 详情用 a/b/c（W1a/W1b/W1c/W2a/W2b/W2c/W3a/W3b）。边语义一致（节点内联带描述可映射），但两套命名混用增加读者映射成本。属修订前既有，非本轮引入。建议（可选）：DAG 节点 ID 统一为 a/b/c 后缀。

---

## 五、收敛判定

**NOT CONVERGED。**

- 7 核心缺口：6 闭合（F1/F2/F3/F4/D1/D2），**D3 未完全闭合**（W2a 漏改，Gap-R1）。
- F5 未完全闭合（Gap-R2）。
- 无结构性新缺口；依赖闭合、文件互斥、DAG 边、runtime-ready 声明均经复核成立。

**阻塞项仅 2 个，全部集中在 W2a SideDrawer + 其上游 §6.3 点5，修复总成本 < 8 行，零结构改动。** 修完 Gap-R1 + Gap-R2 后即可判定 CONVERGED，安全派遣。

### 最小修复清单

| 优先 | Gap | 文件:行 | 改动 |
|------|-----|--------|------|
| 1 | R1 | execution-plan.md:214 | 「垂直切片」→「前端切片（runtime 已就绪）」 |
| 2 | R2a | code-architecture.md:1140 | 删「接近上限…可能超 400 行」事实错误，动机改「架构解耦」 |
| 3 | R2b | execution-plan.md:220 | 「避免 Panel 超 LOC」→「架构解耦，避免 Panel 承担 tab/dock 状态」 |
| 4 | R2c | execution-plan.md:223 | 「Panel LOC 预算提取 useSideDrawer」→「Panel 控制逻辑下沉 useSideDrawer（架构解耦）」 |
