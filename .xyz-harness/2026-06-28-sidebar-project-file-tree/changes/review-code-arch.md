---
verdict: APPROVED
machine_check: PASS
phase: code-arch
reviewer: fresh-context subagent
---

# 审查报告 — ⑤code-arch

> 独立审查 subagent（上下文与主 agent 隔离）。按 design-shared/review-agent.md 执行 6 维审查 + 红队维度。
> **源码实证为主**（git-service.ts / server.ts / protocol.ts / path-utils.ts / git-info.ts / git-executor / chat-chunk-processor / event-adapter），不纯脑力推演。

## 机器检查结果

`python3 check_code_arch.py ... --no-skeleton` → **7/8 PASS，1 项预期不阻断 FAIL**。

| 检查项 | 结果 | 说明 |
|--------|------|------|
| code-architecture.md 存在 | PASS | — |
| frontmatter verdict | PASS | `verdict: pass` |
| 关键章节（§1/§3/§4/§6） | PASS | 全部 4 个必须章节齐 |
| 无占位符 | PASS | 无未替换占位符 |
| **review-code-arch 存在** | **FAIL（预期不阻断）** | 本文件，写完即 PASS |
| test-matrix 来源 B 映射 | PASS | 含 NFR 风险→用例映射表 + 用例 ID 映射 |
| 来源 B 用例 ID 映射 | PASS | 来源 B 行均映射到用例 ID |
| 骨架检查（§9） | SKIP | `--no-skeleton` 跳过（纸面阶段，Step 7 后回填） |

**结论**：唯一 FAIL 是 review-code-arch 自身（写完即 PASS）。无结构性硬伤。machine_check = **PASS**。

---

## 6 维审查

### 维度 1：契约完整性 — **PASS**

§3 签名表每模块公开方法均有签名行（FileService/GitService/IFileExecutor/FsExecutor/GitExecutor/handlers/fileTreeStore/useFileTree/useDetailPane/api），每方法标接线层级（[L1-接线]/[叶子]/[adapter]/[port]）。

**NFR④回灌字段在 §3 体现**（源码+文档双向核查）：
- FileNode `ignored?`（D-020）✓ / isUnderOrEqual 词法特性（④K-1，源码实证 path-utils.ts:14-17 确为 relative+resolve 纯词法）✓ / 越界守门（NFR-AC-S2）✓ / git.diff 越界（NFR-AC-S5）✓ / 防注入（NFR-AC-S3）✓ / 审计日志 ✓ / 禁 v-html（NFR-AC-S4）✓

**FileError 类型（F-2）**：§3 定义 `FileErrorCode` 联合 + `FileError extends Error { code }`，源码实证与 GitError（git-service.ts:29）范式对称。✓

**protocol reply type（F-3）**：§3 列 4 条待扩（file.tree:result/expand:result/git.diff:result/file.write.*.result）+ 精确 payload，源码实证 protocol.ts:221-222 当前缺口属实。✓

### 维度 2：调用链闭合 — **PASS**

**F-1 修正实证**：§4 功能3 新增 GMH(GitMessageHandler)+GS(GitService) 参与者，git.diff 经 `API→GMH→GS.getFileDiff` 与 file.read（`API→H→FS`）分轨，不再误进 FileMessageHandler。✓

每箭头在 §3 有定义；异常 alt/else 错误 code 与 §3 FileErrorCode 联合 + GitError code 字面一致。

### 维度 3：依赖健康 — **PASS**

**§2 包依赖图无环**：transport→services→infra 单向；composablesFE→chatStore 单向 watch（无环）。✓

**分层正确**（源码实证）：services 不引 infra IO（git-service.ts:26 引 git-status-parser 纯函数，D-013 豁免）✓；transport 不碰 node:内置（server.ts:8-10/492 违纪真实，K-2 反哺 AC-2b 已扩展）✓；stores 间禁互引（chat.ts/sidebar.ts 顶部明文，D-4 去行号锚定）✓。

**god object**：新模块 LOC 全 < 400；server.ts 现 512（K-3 标 delete 净减）。✓

### 维度 4：测试覆盖 — **PASS**

每 UC 4 类齐全；NFR④ 8 条代码测试缓解项全覆盖（S1→T1.9/S2→T2.10/S3→T6.8/S5→T6.9/S4→T6.10/C1→T6.11/D1→T1.7/异步竞态→T2.3-2.6）；强制 integration 标对（S1 纯函数豁免 unit 合理）。

**关键 MISSING 已补**（F-4/F-5/F-6 实证）：F-4 expand 越界 T2.10 ✓ / F-5 untracked `??`→A T2.8b ✓ / F-6 过滤框与⌘K区分 T4.4 ✓ / F-7 清空恢复 T4.5 ✓ / F-8 SideDrawer切换 T6.12 ✓ / K-5 git.diff超时/非repo T6.13/6.14 ✓。

K-6 正确将 debounce 移出 test-matrix 归⑤骨架约束。

### 维度 5：闭环（搭便车 + BC） — **PASS**

搭便车 #7/#8/#9/#10 + BC-1~BC-6 全有⑤落点。源码实证：#8 index.ts:111 createAdapter 确未传 cwd（bug 真实）；BC-3 server.ts:481-486 allowedPrefixes 确为 3 目录（保留语义准确）。

**§7 处置登记**：K-1 git-info.ts:59 execSync（edit/豁免 + grep 门禁口径）✓；K-3 server.ts handleFileRead **delete**（净减重）✓。无变主工程迹象。

### 维度 6：内部一致性 + 反哺 — **PASS**

§1/§2/§3/§4 一致；FileError code 字面三处一致；getFileDiff 签名跨节一致。

**K-2 反哺三方落地一致**（非 PHANTOM）：②§11 AC-2b grep 扩展（含 fs/promises + node:path + node:os）✓ + ⑤Step6b 记录 ✓ + ②frontmatter backfed_from:[issues,nfr,code-arch] ✓ + 源码实证 server.ts:492/L9-10 违纪真实 ✓

**K-9 反哺三方落地一致**：②§5/§7/§10 + ③issues AC-3.11（composable 层编排）+ ⑤§3/§4 落地 ✓ + 源码实证 chat-chunk-processor applyFileChanges 回调范式支撑 ✓

D-001~D-020 confirmed 决策无下游证据推翻（不重报）。

---

## 红队维度（对抗性挑刺）

1. **PHANTOM 反哺排查**：K-2/K-9 均有②上游真改 + 源码实证，无 PHANTOM。
2. **回灌字段遗漏排查**：④ 8 条代码测试项全映射 §6，无遗漏。
3. **类型逃逸排查**：§3 无 any 逃逸；FileError/GitError code 均字面量联合；FileNode DTO 可选字段标注清晰。
4. **签名 vs 源码范式**：getFileDiff「仿 resolveFilePaths」——源码实证 git-service.ts:75-87 resolveFilePaths 确为 `resolvePath + isUnderOrEqual + GitError('path_not_allowed')`，范式引用准确。
5. **git-executor 白名单「已含 diff」**：ports/git-executor.ts:24 GitCommand 联合确含 'diff'，属实。
6. **AC-3.11 依赖 #8**：index.ts:111 cwd 缺失 bug 真实，依赖链成立。

---

## 发现的问题

### CRITICAL / MAJOR
无。

### MINOR（审查后主 agent 已修）

- **MINOR-1（§2 mermaid 拼写死节点）**：`composantsFE[composablesFE]` 笔误孤立节点。**已修**：删除该行（composablesFE 已正确定义）。
- **MINOR-2（§4 功能2 缺 expand 越界 alt）**：F-4 仅补 §6 T2.10 用例，§4 功能2 时序图未加越界 alt。**已修**：§4 功能2 时序图补 expand 越界 alt（与功能1 越界守门对称，T2.10 双向可查）。

---

## 反哺核查

### K-2（②§11 AC-2b grep 扩展）— 三方落地一致，非 PHANTOM
②§11 AC-2b 已扩展（fs/promises + node:path + node:os + node:http 白名单）+ ⑤Step6b 记录 + ②frontmatter [issues,nfr,code-arch] + 源码实证 server.ts 违纪真实。

### K-9（composable 层编排）— 三方落地一致，非 PHANTOM
②§5/§7/§10 + ③issues AC-3.11 措辞修正 + ⑤§3/§4 落地 + 源码实证 chat-chunk-processor 回调范式支撑。

---

## 结论

**verdict: APPROVED**

机器检查 PASS（唯一 FAIL 为 review-code-arch 自身，预期不阻断）。6 维审查全 PASS：契约完整（NFR④回灌字段全体现 + FileError/protocol reply type 闭环）、调用链闭合（F-1 分轨实证）、依赖健康（无环 + 分层源码实证 + 无 god object）、测试覆盖（UC 4 类齐全 + NFR④ 8 条全覆盖 + 关键 MISSING F-4/F-5/F-6 全补）、闭环（搭便车 + BC 全有落点 + §7 K-1/K-3 处置登记）、一致性 + 反哺（K-2/K-9 三方落地非 PHANTOM）。

**追踪 round-1 的 F-1~F-8/K-1~K-6/D-1~D-6 全部已应用**（逐条源码/文档实证核对）。仅 2 项 MINOR 已由主 agent 修复（§2 拼写死节点删除 + §4 功能2 补越界 alt）。无 CRITICAL/MAJOR，无放水，源码实证为硬。

§9 骨架覆盖表为空（纸面阶段，Step 7 骨架生成后回填，流程预期）。
