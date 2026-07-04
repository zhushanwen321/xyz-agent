---
verdict: APPROVED
reviewer: tracing-converge-rechecker
date: 2026-06-25
scope: review-issues-v2.md 6 项修复（P1-1/P1-2/P2-1/P2-2/P3-1/P3-2）落地核验 + 新矛盾扫描
---

# 收敛复核报告

## Verdict: APPROVED

2 阻塞项（P1-1/P1-2）彻底 RESOLVED，无新阻塞矛盾。P2-1 存在未修残液（非阻塞，system-arch §7/§8 两处 execFileSync 描述漏改），记录不卡 APPROVED。其余非阻塞项全 RESOLVED。

---

## 逐项核验

### P1-1 [阻塞] #1 AC-3 范围溢出 fix scope — **RESOLVED**

四项全数对齐：

① AC 措辞收窄到 git 相关：issues.md:121 现写「AC-3 grep 覆盖 **git 相关 shell out（git-executor + reconciler）** 无字符串形式」——已收窄。✅

② 不再说「全目录无字符串形式」：grep issues.md 无「全目录」字样，原溢出措辞已删。✅

③ #18 在 P3 延后项新增、P 级、方案正确：issues.md:956 `#18 [P2 安全债]` 位于「后续迭代（P3 延后项）」段，方案「迁移为 `spawn`/`execFile` 数组参数（filePath 不经 shell）」正确。✅（注：P2 项置于「P3 延后项」段名下是轻微命名错配，但段内 #14-#17 为 P3、#18 显式标 P2 安全债且注「建议本轮顺手修」，语义清晰，不构成矛盾。）

④ #18 正确指认 trash.ts:13 为 filePath 插值（对比 reconciler/process-manager 常量串）：核验实际代码——
- `trash.ts:13` = ``execSync(`trash "${filePath}" 2>/dev/null || osascript ...`)`` —— **filePath 插值，真注入面** ✅
- `reconciler.ts:75` = `execSync('git status --porcelain', {cwd})` —— **常量串** ✅
- `process-manager.ts:45` = `execSync(whichCmd)` (whichCmd='which pi') —— **常量串** ✅

#18 对 trash.ts 的「filePath 插值 / 用户可控路径」定性准确，与 reconciler 常量串的区分正确。✅

### P1-2 [阻塞] #1 问题描述与方案 A 矛盾 — **RESOLVED**

① 问题描述现说 async / 重构：issues.md:47「落地状态（2026-06-25）：Wave 1 已落地…当前是 `async exec(){ ...execFileSync... }`（async 壳包同步调用）…本轮…将其拔为真正的 async `execFile`」；issues.md:49「`infra/git-executor.ts`（**重构 execFileSync → async execFile**）」。✅

② 无「采用 execFileSync」描述：grep issues.md 全部 execFileSync 出现归类——现状陈述（:47「当前是…execFileSync」）/ 重构方向（:49）/ 对比分析（:79,:105）/ 反向 AC（:118）。**无任何把 execFileSync 当采用方案的描述**。✅

### P2-1 [非阻塞] code-arch/system-arch execFileSync 残液 — **部分 RESOLVED**

code-architecture.md 全清：§1.2(:109 async execFile)/§4.1(:391 execFile)/§4.2(:456 execFile)/§4.2异常(:497 async reject)/§6.4(:1147 async execFile grep)/NFR(:430 async execFile)——全同步 async。✅

system-architecture.md §11 AC-3(:427-428) 已更新为 async execFile + 注 #18 排除。✅

**未修残液（非阻塞）**：system-arch 仍有两处把 execFileSync 当「采用方案」描述：
- `:256`「`infra/git-executor.ts` | **新建**，**execFileSync 封装** | git 命令增删」——描述该模块封装形态为 execFileSync，与 async 决策矛盾；且「新建」与 #1 重构性质矛盾（P3-1 已修 issues.md 但未反哺此行）
- `:301`「工作目录 .git | 客户-供应商 | **spawn（execFileSync）**」——关联系统交互方式表，描述 git 交互为 execFileSync

这两行不在 review-issues-v2 P2-1 显式修复清单（清单只列 code-arch 各节 + system-arch §11 AC-3），属 P2-1 广义 scope 内漏改。**非阻塞**：implementer 读 §11 AC-3 仍能写出正确验收（AC 是 grep 检测模式，非描述性引导）；但 :256/:301 会误导对模块封装形态的认知，建议同批修。

### P2-2 [非阻塞] C14 refocus visibilitychange 覆盖盲区 — **RESOLVED**

① 验收双触发：issues.md:273「窗口 refocus 触发刷新（`visibilitychange` + `window:focus` **双触发**，覆盖最小化恢复与外部窗口遮挡恢复场景）」。✅

② 流程行也双触发（非只改验收）：issues.md:232「窗口 refocus（**visibilitychange + window:focus 双触发**）」。流程与验收一致，无单边修改。✅

### P3-1 [次要] #1 框架「新建」误导 — **RESOLVED**

issues.md:47「落地状态（2026-06-25）：Wave 1（commit `9ff5d8b6`）已落地…本轮…拔为真正的 async execFile」+ :49「重构 execFileSync → async execFile」。已反映落地状态 + 重构性质，不再误导工作量。✅

（注：该修正只反哺到 issues.md，system-arch:256 的「新建」字样未同步——同 P2-1 残液，非新矛盾。）

### P3-2 [次要] [STALE] 内联标注 — **RESOLVED（跳过合理）**

- spec-w11.md 顶部 [STALE] 声明显式列举失效范围（Background §1 / In-scope#2 / FR-2 / G-001/G-002 / Acceptance）+ 明确「不失效」项（FR-4 queue pending），无歧义。✅
- requirements.md 顶部 [STALE] 声明显式覆盖 F2 / §4 G1 路径 + F4 不失效说明，无歧义。✅

顶部声明已足够收敛，内联标注为纯改进项，YAGNI 跳过合理。✅

---

## 新矛盾扫描

1. **issues.md #1 内部自洽**：问题描述（:47-49 async 重构）/ 方案 A（:60-74 async execFile）/ 验收（:117-118 无 execFileSync 字符串拼接）——三段全 async，无「采用 execFileSync」描述，自洽。✅

2. **跨文档 async 一致性**：
   - issues.md #1 ↔ code-arch §1.2/§4.1/§4.2/§6.4/NFR —— 全 async execFile，一致。✅
   - issues.md #1 ↔ system-arch §11 AC-3（:427-428）—— 一致。✅
   - issues.md #1 ↔ system-arch §7 模块表（:256）/ §8 关联系统表（:301）—— **不一致**（execFileSync 残液，见 P2-1）。非新矛盾，是 P2-1 漏改。

3. **#18 依赖表影响**：#18 未入「依赖关系汇总」表（表只列 #1-#13 + Wave）。#18 无 blocked_by、不阻塞任何 issue、标注「建议本轮顺手修…不卡核心功能」，属独立可选安全债，不入 Wave 表合理。不构成遗漏。✅

4. **修复是否引入新矛盾**：无。issues.md #1 三段统一 async、#3 验收/流程双触发一致、#18 定性准确、[STALE] 声明收敛。唯一跨文档残液（system-arch :256/:301）是 P2-1 未覆盖 scope，非本次修复引入。

---

## 收敛判定

**APPROVED**。P1-1/P1-2 彻底 RESOLVED，无新阻塞矛盾，issues.md 自身收敛达标。

非阻塞跟进建议（不卡 APPROVED，可与 code-arch/system-arch 下一批修订同修）：
- system-arch :256「新建，execFileSync 封装」→「重构，async execFile 封装」（同时清 P2-1 残液 + P3-1 「新建」字样）
- system-arch :301「spawn（execFileSync）」→「spawn（async execFile）」

这两行是 review-issues-v2 P2-1 显式清单外的漏网，红队 R3 揭示的 trash.ts 风险已通过 #18 正确收敛，核心阻塞链已断。
