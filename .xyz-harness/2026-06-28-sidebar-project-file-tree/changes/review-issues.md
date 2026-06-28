---
verdict: APPROVED
machine_check: PASS
review_mode: single
deep_review_round: 1
---

# Review — issues（全项目文件树 · Issue 拆分）

> **[深度复审后记]** 用户要求更深的复审 + 跨阶段一致性审计。派 2 个 fresh subagent（深度红队 + 跨阶段审计）发现首轮 review APPROVED 建立在文字自证上，遗漏 7 项实质问题（2 事实错 + AC/traces 断口 + 三角矛盾）。全部修正后复审确认。

## 深度复审修正清单（全部已落地）

| # | 来源 | 问题 | 修正 |
|---|------|------|------|
| F1 | deep-review | #10「3 处 TreeNode」实为 2 处（grep 实证 ChangeSetCard 用 FileChange） | #10 改 2 处 + AC-10.1 + ②§3/§11 AC-5 |
| F2 | deep-review | #1 isUnderOrEqual 实在 utils/path-utils（非 git-service 内联），3 消费者 | #1 AC-1.2 扩验 + ②§7/§10 |
| AC | 跨阶段#1 | D-007①③（默认亮色/弃dim）零落地 | #4 补 AC-4.14 |
| AC | 跨阶段#6 | §11 AC-3（无 PiXxx）#2 未列 | #2 补 AC-2.8 |
| AC | 跨阶段#7 | currentFile computed 错位（②§4 说 store，③落 view） | #3 补 AC-3.12 |
| 机制 | deep-review C2 | #3 AC-3.11 失效触发跨 store 机制空白 + 隐性依赖 #8 | AC-3.11 补机制 + #8 依赖说明 |
| 措辞 | 跨阶段#5 | #8/#9 P1 理由错误归因（file-tree vs ChangeSetCard） | #8/#9 措辞澄清 |

## 深度复审新增决策（用户裁决）

- **D-019**：展开态 reset 三角矛盾（①AC-3.2 ↔ ②§4 ↔ ③AC-3.5）→ 按 session 缓存+rehydrate，反哺 ②§4
- **D-020**：显示忽略项开关 + 灰斜体从 P3 提级 P1（#16 新增），反哺 ②§4（FileNode ignored 字段）+ §6（ignore 双模式）

## 复审结论
首轮 APPROVED 的虚覆盖（完整性/方案对比深度/#8#9 措辞）经深度复审 + 跨阶段审计实证核验全部修正。最终：**0 PHANTOM**（三方确认）、③方案零违反 confirmed 决策、check_issues.py 9/9 PASS、3 处反哺②（D-017/D-019/D-020）落地一致。**verdict 维持 APPROVED**（深度复审后）。

---

## 首轮审查（深度复审前，记录原状）

> fresh subagent 独立审查。轻量项目（L1）单组模式 review_mode: single。6 维全 ✅，无必须修改。

## Verdict
APPROVED

## 机器检查结果

`check_issues.py` → 8/9 passed（review-issues 落盘后预期 9/9）。其余 8 项全过：
- issues.md 存在 ✅ / frontmatter verdict: pass ✅ / 关键章节 ✅ / 无占位符 ✅
- P0/P1 ≥2 方案对比 ✅（#1/#2 P0 + #3~#10/#14 P1 全有方案 A/B）
- blocked_by 无幽灵依赖 ✅ / P 级一致性 ✅
- 覆盖核验表形式 ✅（52 行，每行有 #issue 或 N/A+理由，无 ❌ 待补残留）

**machine_check: PASS**。

## 维度评估（6 维）

| 维度 | 评级 | 要点 |
|------|------|------|
| 内部一致性 | ✅ | P 级与 blocked_by 一致（P0 不被 P1 block）；方案对比与取舍自洽；FileNode 不含 gitStatus 全文一致；D-017 失效转移 §5/§7/§10/#3 四处一致 |
| 上游对齐 | ✅ | 覆盖表 52 行逐行对应 ②§1~§12；§5 失效转移→#3 AC-3.11；§1 UC-5→#14（M1 已解）；②反哺 backfed_from:[issues] 已标；AC trace 回 ①UC |
| 可执行性 | ✅ | 每 issue 模块/AC 可直接编码；grep AC（AC-2.6/2.7/7.4/10.1）命令可执行；搭便车待⑤标记清晰 |
| 完整性 | ✅ | 0 PHANTOM（机器+角色A双重确认）；无 ❌ 待补；迷雾 #11/#12/#13 标 `?`；搭便车 4 项 P1 与 D-015 一致 |
| 可视化质量 | ✅ | DAG 节点/边/状态色标正确；**#11/#12/#13 编号已修正（X7）**；覆盖表可读；方案对比卡片清晰 |
| 红队（必要性与比例性）| ✅ | IFileExecutor port（D-008 deletion test 证真实）、#14 骨架（D-018 契约价值）、D-017 失效转移（真实场景非过度）、搭便车 P1（D-015）、拆分粒度（#8/#9 不合并/#7 不并入 #2）——confirmed 决策均无新证据证明过度 |

## 红队逐条质询结论

- **IFileExecutor port（D-008 confirmed）**：删→service 内联 fs→测试 mock fs 模块脆弱 + 范式不对称。②§6 deletion test 已证真实。**不可降级。**
- **#14 file 写骨架（D-018 confirmed ask_user）**：file 域协议一致性（读 #1+写 #14 同期），下游 G4 只填实现不改契约。②§1 本承诺骨架就绪，D-016 初稿过度延后才触发 D-018。**合理。**
- **D-017 失效转移（confirmed）**：真实场景——agent 新建文件进 GitOverlay 但 file.tree 快照无节点 → G2 静默失效。补 invalidated 让树结构失效重拉补节点。**非过度，仅加一条转移边不破坏宽松范式。**
- **搭便车 4 项 P1（D-015 confirmed）**：#7 UC-6 前置、#10 FileView 重写前置——确为 P1；#8/#9 服务 ChangeSetCard 但 D-010/D-015 confirmed 全纳入。**无新证据降级。**
- **拆分粒度**：#8/#9 不合并（§12 拆 BC-5/BC-6 利回滚定位）；#7 不并入 #2（BC-3 独立 ticket 正交）。**拆分合理。**

## 必须修改
无。

## 可选改进（不阻断）

1. AC-4.4 过滤语义（懒加载下=已加载节点）⑤实现时验证用户预期
2. #11/#12/#13 fog 项展开触发条件可在「待确认」段集中登记（当前分散 fog 段）
3. 机器检查「P0/P1 ≥2 方案」SKIP 属脚本识别逻辑问题，非 issues.md 质量问题（可反馈脚本维护者）

## 结论

issues.md 定稿达可交接质量：D-017 反哺准确落地 ②§5/§7/§10/#3 AC-3.11 四处一致；#14 骨架符合 D-018 confirmed 且对齐 ②§1；覆盖表 0 PHANTOM；DAG #11/#12/#13 编号已修正；搭便车 4 项 P1 与 D-015 一致。**可进 Step 6b 反哺检查。**
