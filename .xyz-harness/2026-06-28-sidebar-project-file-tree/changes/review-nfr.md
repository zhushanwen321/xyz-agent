---
phase: nfr
verdict: APPROVED
machine_check: PASS
reviewer: fresh-context subagent
---

# 审查报告 — ④非功能性设计

## 机器检查结果

check_nfr.py 输出 7/8 passed → 仅 `review-nfr 存在` FAIL（预期项，本审查正在产出该文件，不计阻断）。其余 7 项全 PASS：

| 检查项 | 结果 |
|--------|------|
| non-functional-design.md 存在 | PASS |
| frontmatter verdict (pass) | PASS |
| 关键章节（分析矩阵 / 详细分析 / 缓解项回灌登记 / 残余风险 / Step6b 反哺）全在 | PASS |
| 无占位符 | PASS |
| review-nfr 存在 | FAIL（预期，本文件正在写）|
| 验收方式列合法（32 行缓解项四选一：代码测试/骨架约束/性能混沌/运维项） | PASS |
| 无 ❌ 不可接受项残留 | PASS |
| 回灌③指针 PHANTOM | SKIP（回灌表无指向 ③issue 行，N/A）|

machine_check 判定 PASS（唯一 FAIL 项为预期不阻断项）。

## 6 维审查

### 维度1 覆盖完整性 — PASS

11 个已决策 issue（#1/#2/#3/#4/#5/#6/#7/#8/#9/#10/#14/#16）逐一进分析矩阵，7 维度全标（✅/⚠️）无空格。✅ 维度的「一行理由」整体站得住——本主题确为 Electron 桌面单机单用户应用（runtime 单实例 + 前端单写者），NFR 模板面向后端服务的「多用户越权 / 分布式并发 / 雪崩熔断 / 灰度发布」在本主题大量不适用，标 ✅ 给一行理由合理，未把真实风险当 ✅ 打发。

重点核实「放水」嫌疑：
- **#8 全 ✅**：无放水。源码实证 event-adapter.ts 的 reconcileFileChanges 修复是补回丢失的闭包 cwd 变量，纯 bug 修复无新功能/新权限。tracing D-9 已提示 reconcileFileChanges 首次启用引入 git status 同步阻塞风险（execSync 5s 超时）——NFR 文档已采纳 D-9（虽然 #8 标稳定性 ✅，但 AC-8.1 已含降级回归要求，reconciler 降级路径存在）。⚠️ 轻微：#8 稳定性 ✅ 的一行理由未显式提 D-9 那条 reconcileFileChanges 首次启用的同步阻塞风险，但 AC 层已覆盖，非 CRITICAL。
- **#14 全 ✅**：无放水。骨架抛 NotImplemented，无真实 fs 写、无运行时价值。兼容性标 ⚠️（契约锚点 G4 依赖），非全 ✅。准确。

### 维度2 缓解可行性 — PASS

抽查全部 32 条缓解项：每条 ⚠️ 均有可落地缓解，验收方式四选一标对（代码测试 8 条 / 骨架约束含⑤骨架验证 23 条 / 性能混沌 1 条），无「裸奔风险」（标了风险但没缓解的）。代码测试类 NFR-AC（S1/S2/S3/S4/S5/C1/D1）均附 UC 描述 + 具体断言（如 S5: `git.diff(sessionId,"/etc/passwd")` 返回 path_not_allowed）。回灌去向 ⑤test-matrix / ⑤骨架 / ⑥perf Wave 合理。

### 维度3 回灌完整性（反向） — PASS

- 缓解项回灌表「回灌去向」22→32 条缓解行全部去 ⑤/⑥，零行指向 ③issue —— 视角3 重建器独立核对属实，无 PHANTOM。
- **K-9 反哺三方落地核查（重点）**：
  - ③issues AC-3.11：已修正为「composable 层（useFileTree）编排跨 store 失效触发（watch chat store file_changes + 派发 fileTree store 的 invalidate 接口）」+ 显式引架构硬约束，issues.md L308 确认。✅ 真落地。
  - ②architecture §7：L191 stores/fileTree.ts「暴露 invalidate 接口供 composable 派发（不在 store 内监听）」+ L192 useFileTree「编排跨 store 失效触发 watch + invalidate」。✅
  - ②architecture §10：D-017（L316）「失效触发的编排位置在 composable 层，非 store 层」。✅
  - ②architecture §5：L99 失效转移状态机。✅
  - 三方 frontmatter backfed_from 一致：issues.md `[nfr]`、architecture.md `[issues, nfr]`、nfr.md `[]`（④自身产出方，无 backfed_from 合理）。✅

### 维度4 事实准确性（红队） — PASS

抽查 6 个关键技术断言全部源码可证：

| 断言 | 源码实证 | 结果 |
|------|---------|------|
| K-9 「stores 间禁止互相 import」明文 | `stores/chat.ts:3` + `stores/sidebar.ts:5` 均有「依赖方向：无（stores 间禁止互相 import）」明文 | ✅ 准确 |
| K-1 isUnderOrEqual 纯词法不解析 symlink | `utils/path-utils.ts:14-17` 函数体仅 relative+resolve，无 realpath；对比 `extension-service.ts:321-345` 已知此向量补 lstatSync+realpathSync | ✅ 准确 |
| K-8 FileTreeRow 读 change/addLines/delLines/fileCount | FileTreeRow.vue 模板直接读 node.fileCount(L17)/addLines(L40)/delLines(L42)/change(L48)；TreeNode 定义两处一致（FileView L63 + FileTreeRow L58）含这些字段，shared FileNode（D-012）不含 | ✅ 准确，AC-10.2「渲染等价」无法仅靠 import 替换达成的判断成立 |
| F-2 execFileSync 数组形式防注入 | `infra/git-executor.ts:33` execFileSync('git', fullArgs,...) 数组形式；port 注释 L37-38 明文约束 | ✅ 准确 |
| K-6 resolveFilePaths 仅写操作 | `git-service.ts` resolveFilePaths 只用于 stage/unstage/commit，diff 无越界校验先例，getFileDiff 需新写 | ✅ 准确 |
| F-1 listDir 1+M 次 | architecture §6 GAP-S5（L164）「service 调一次 listDir(cwd) 拿顶层，对其中 dir 再调 listDir」= 1+M 次（M=顶层目录数） | ✅ 准确（注：架构原文写「2 次 listDir」措辞偏简化，NFR 修正为 1+M 更精确，tracing F-1 修正合理）|

**额外实证（#9）**：`pi-protocol.ts` PiHistoryMessage(L321) + PiHistoryToolCallPart(L344) 确无 fileChanges 字段，NFR「方案 A 大概率无法落地，⑤验证后回填重建策略」判断源码可证。✅

### 维度5 残余风险合理性 — PASS

7 条残余风险逐条接受理由站得住，无甩锅：
- 「恶意 symlink 需先被放进 cwd」+ 监控（⑤裁决 realpath 补/不补）—— 合理
- 「用户主动展开极深目录卡顿」+ 懒加载 + perf Wave 压测 —— 合理（非首加载问题）
- 「session.cwd 指向系统目录可读子树」+ 用户负责 —— 合理（cwd 是用户主动选择）
- 「#9 历史/实时数据源不一致」—— 已转⑤骨架探查重建策略，未塞不可接受风险

### 维度6 内部一致性 — PASS

分析矩阵的 ✅/⚠️ 与详细分析一致。tracing-round-1 的 D 类修正（#6/#9/#16 兼容性 ✅→⚠️）已在矩阵（#6 兼容性⚠️、#9 兼容性⚠️、#16 稳定性⚠️+数据⚠️）+ 详细分析同步落地，无「矩阵改了详细分析没跟」。

矩阵汇总回灌去向（⑤test-matrix 7 条 / ⑤骨架含⑤骨架验证 / ⑥perf 1 条）与回灌登记表 32 行计数一致。无 ③ 新 issue 自报经重建核对属实。

## 发现的问题（按严重度）

**无 CRITICAL，无 MAJOR。**

MINOR（措辞/格式，不阻断 APPROVED）：

- **MINOR-1（维度4，git-info.ts 路径标签不精确）**：NFR D-7（#5 兼容性）引用 `git-info.ts:59` 用 execSync，但该文件实际位于 `runtime/src/services/git-info.ts`（非 infra/）。行号引用（L59 execSync 'git rev-parse'）准确，仅归类标签松。建议：⑤骨架约束行明确路径（services/git-info.ts）。
- **MINOR-2（维度1，#8 稳定性 ✅ 的一行理由未提 D-9 reconcileFileChanges 同步阻塞）**：D-9 提示 reconcileFileChanges 首次启用引入 git status execSync 同步阻塞（5s 超时）影响 agent_end complete 帧时序，reconciler 降级路径已存在但 NFR #8 稳定性 ✅ 一行理由未显式提。AC-8.1 已含降级回归要求覆盖之，故仅措辞层面，不影响实质。

## 反哺完整性核查（K-9）

| 落点 | 核查 | 结果 |
|------|------|------|
| ③issues.md AC-3.11 措辞 | L308 修正为「composable 层 useFileTree 编排跨 store 失效（watch chat store file_changes + 派发 fileTree invalidate）」+ 显式引架构硬约束 + 引 #8 依赖 | ✅ 真修正 |
| ②architecture §7 | L191 stores/fileTree.ts 暴露 invalidate 接口（不自行监听）+ L192 useFileTree 增跨 store 失效编排职责 | ✅ 真落地 |
| ②architecture §10 D-017 | L316 编排位置在 composable 层非 store 层，明文引 stores/chat.ts 禁 import 约束 | ✅ 真落地 |
| ②architecture §5 状态机 | L99 loaded→invalidated 失效转移 | ✅ |
| frontmatter 一致性 | issues.md backfed_from:[nfr] / architecture.md backfed_from:[issues,nfr] / nfr.md backfed_from:[] | ✅ 三方一致 |

K-9 反哺完整无 PHANTOM，且为「措辞/位置修正非决策推翻」（非 D-不可逆），无需 ask_user，处理合规。

## 结论

**verdict: APPROVED**

理由：
1. 机器检查 PASS（唯一 FAIL 为 review-nfr.md 正在产出，预期不阻断）。
2. 6 维审查全 PASS：覆盖完整（11 issue × 7 维度无漏，✅ 理由站得住，#8/#14 无放水）、缓解可行（32 条全落地无裸奔）、回灌完整（无 PHANTOM，K-9 反哺三方真落地且 frontmatter 一致）、事实准确（6 个关键技术断言全部源码可证，含 K-9 架构约束 / K-8 字段断裂 / F-1 listDir 次数 / F-2 防注入 / K-1 symlink / #9 pi 历史无 fileChanges）、残余风险合理、内部一致（矩阵与详细分析同步、D 类修正已回灌）。
3. 仅 2 条 MINOR（git-info.ts 路径标签松 / #8 稳定性 ✅ 未显式提 D-9 同步阻塞但 AC 已覆盖），均为措辞层面不影响实质，不阻断。
4. 已 confirmed 决策（D-001~D-020）无下游证据推翻，未重报已拍板决策。
5. Step6b 反哺记录（K-9 一处）处理规范（措辞修正非决策推翻，三方真落地，frontmatter 一致）。
