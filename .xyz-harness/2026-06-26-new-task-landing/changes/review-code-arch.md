---
verdict: APPROVED
machine_check: PASS
round: 3
---

# 审查报告 — code-arch（Round 3 复核）

## Verdict
APPROVED — Round 2 唯一必须修改（openDirDialog 的 session 绑定语义缺口）已闭合。主 agent 采用 Round 2 推荐方案 B（独立对称表述而非委托 selectWorkspace），将 openDirDialog 选中分支的语义收敛为「选中新 cwd→delete 空旧 session + create 新 session(newCwd)，与 selectWorkspace 同语义，保持②Session.cwd 不变式」。selectWorkspace / openDirDialog 两条 cwd 变更路径对称，原 §4.2「create/切换 session 绑定新 cwd」模糊措辞已消除。6 维无新实质问题。

## 机器检查结果
`check_code_arch.py` exit 1 → 7/8 passed

| 检查项 | 结果 | 说明 |
|--------|------|------|
| code-architecture.md 存在 | ✅ | |
| frontmatter verdict: pass | ✅ | |
| 关键章节 | ✅ | |
| 无占位符 | ✅ | Round 1 修复，维持 |
| review-code-arch verdict | ❌ | **自指悖论**：脚本读到的仍是本次覆盖前的 Round 2 verdict=CHANGES_REQUESTED；本报告写入 APPROVED 后此项即闭合。非作者硬伤，非阻断 |
| test-matrix 来源 B | ✅ | |
| 来源 B 用例 ID 映射 | ✅ | |
| 骨架检查 | ⏭️ SKIP | Step 7 未生成，不阻断 |

> 唯一机器 fail 是 review verdict 自指悖论（流程顺序：脚本读取时机早于本报告写入）。本报告写入 APPROVED 后该悖论自动消解，再跑脚本应为 8/8。非阻断项。

## Round 2 必须修改复核

### 修复 #1（openDirDialog session 绑定语义对称收敛）— ✅ 到位

主 agent 采用方案 B（独立对称表述，非方案 A 委托）。

**§3.3 签名边界条件**（openDirDialog）：
> 选中新 cwd→delete 空旧 session + create 新 session(newCwd)（与 selectWorkspace 同语义，保持②Session.cwd 不变式）；取消→落回 dir-popover（AC-5.3）

- 显式定义了选中分支的 session 生命周期（delete + create），不再对 session 绑定沉默
- 明确「与 selectWorkspace 同语义」，标注不变式
- 接线层级 `[内] ipc.pickDirectory + sessionApi.delete+create + state` 可据接线

**§4.2 时序图 Note**（openDirDialog 选中分支）：
> cwd 变了→delete 当前空 session + create 新 session(newCwd)（与 selectWorkspace 同语义）

- 原「create/切换 session 绑定新 cwd」二选一模糊措辞消除
- 与 selectWorkspace 分支 Note（「cwd 变了→delete 当前空 session + create 新 session(newCwd)；cwd 未变→noop」）对称

**对称收敛核验**（selectWorkspace vs openDirDialog）：

| 路径 | 触发 | cwd 变更语义 | 不变式标注 |
|------|------|------------|----------|
| selectWorkspace（列表选择） | 选 recentWorkspaces 列表项 | cwd 变→delete 空旧 + create 新(newCwd)；cwd 未变→noop | 保持②Session.cwd 不变式 |
| openDirDialog（OS dialog 选中） | pickDirectory IPC 返回 path | 选中新 cwd→delete 空旧 + create 新(newCwd) | 与 selectWorkspace 同语义，保持②Session.cwd 不变式 |

两条路径语义一致，均满足 ②system-architecture.md L57「Session.cwd 在 NewTaskFlow 正常路径不变」。✅

### 上游一致性（#5 方案 A）— ✅ 不冲突
issues.md #5 方案 A 流程描述为「选列表项→回灌 chip；点「打开文件夹」→IPC→OS dialog→选中回灌/取消落回 popover」，定位在**用户交互层**（选目录→chip 显示新 cwd），不规定 session 生命周期。code-arch 补 delete+create 是 ②Session.cwd 不变式在代码层的落地，两层正交，无冲突。方案 A 的「选中回灌」语义被 code-arch 的「delete 空旧 + create 新 session(newCwd)」完整实现（新 session 绑定新 cwd，chip 回灌新 cwd）。

## 维度评估（6 维，重点复查内部一致性 + 可执行性）

### 内部一致性 ✅（Round 2 ⚠️ → Round 3 ✅）
- selectWorkspace ↔ openDirDialog 双路径 session 绑定语义对称收敛，同一不变式（②Session.cwd）单一表述，Round 2「冲突要表面化/一致性」缺口闭合。
- §3.3 ↔ §4.6 转换表维持闭合（dir-dialog→landing by openDirDialog(选中) / dir-popover→landing by selectWorkspace，对称）。
- §3.3 selectWorkspace/openDirDialog 接线引用 `sessionApi.delete`，§3.1 未列 delete（推断既有）——非阻断，建议 Step 7 骨架核验（见可选改进）。

### 可执行性 ✅（Round 2 ⚠️ → Round 3 ✅）
- openDirDialog 接线有据：§3.3 签名显式 `[内] ipc.pickDirectory + sessionApi.delete+create + state`，Step 7 骨架作者可据此直接接线（拿到 path→sessionApi.delete(空旧)+create(newCwd)→state=landing）。
- Round 2「openDirDialog 是 (a) 委托 selectWorkspace (b) 独立 delete+create (c) 仅改 chip」三义性消除（方案 B 选定 (b)，独立 delete+create 对称表述）。

### 上游对齐 ✅
- AC-6.7/AC-6.9（T4.8/T4.9）维持，Round 2 已核。
- delete+create 决策与 ②system-architecture.md L57 一致。
- 其余（②§7 模块表 / ②§5 状态机 / Obs-B 单实例 / git-info 分层债 / NFR④回灌）无回退。

### 完整性 ✅
- 来源 A 4 类齐全；来源 B 12 条风险全映射；E1-E11 全映射。维持。

### 可视化质量 ✅
- 7 mermaid 块完整，§4.2 openDirDialog 选中分支 Note 改写未破坏时序图语法。

### 必要性与比例性（红队）✅
- openDirDialog 的 delete+create 是遵守不变式的最小语义，非过度（与 selectWorkspace 同款，未引入新抽象）。维持。

## 结论

Round 2 唯一必须修改（openDirDialog session 绑定语义对称收敛）采用方案 B 闭合，selectWorkspace / openDirDialog 两条 cwd 变更路径对称，保持 ②Session.cwd 不变式。无新实质问题。**APPROVED**。

## 可选改进（不阻断，供执行阶段参考）
- §3.3 selectWorkspace/openDirDialog 接线引用 `sessionApi.delete`，建议 Step 7 骨架核验表 §9 补一行确认该 API 既有存在（避免骨架作者误以为需新增）。
- §6 覆盖完整性自检「NFR④并发风险 UC 有并用例」一行仍只列「UC-6 T6.6/T6.7」，建议补 UC-4 T4.8（AC-6.7 Esc 排队）。纯文档 cosmetic。
- AC-1.1/AC-1.2 拆独立用例（Round 1 遗留可选）。
