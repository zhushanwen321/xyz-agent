---
converged: false
---

# ④NFR 回灌指针重建 Round 1

## issues.md 真实 issue 清单（重建结果）

> 真相源：`issues.md`（③）。决策图主节点 #1–#8（含完整方案对比/验收标准），后续迭代 #9–#12（P3，仅延后记录无决策体）。共 12 个 #N 编号。

### 决策图主节点（mermaid 已画 + 含完整决策体）

| #N | P级 | 标题 |
|----|----|------|
| #1 | P0 | sessionApi.create cwd 透传（T1 搭便车） |
| #2 | P0 | landing 组件 + 落地空态判据（D-3, BC-10, BC-12） |
| #3 | P0 | useNewTaskFlow composable（D-4, BC-8） |
| #4 | P1 | recentWorkspaces 派生 + resolveDefaultCwd（D-6, BC-9） |
| #5 | P1 | directory popover + OS dialog 接入（BC-7） |
| #6 | P1 | branch popover + dirty 二次确认 + unborn HEAD |
| #7 | P1 | create-branch modal + GitService.createBranch 扩 port（UC-6） |
| #8 | P2 | forkSession cwd 波及（BC-11, T1 波及） |

### 后续迭代（P3，无决策体，仅延后记录）

| #N | P级 | 标题 |
|----|----|------|
| #9 | P3 | popover 锚定 fallback |
| #10 | P3 | dirty 切走自动 stash 选项（v2） |
| #11 | P3 | 远程连接（SSH remote picker） |
| #12 | P3 | Git 图谱（lazygit/tig 嵌入） |

## 回灌表③指针核对

逐行核对「缓解项回灌登记」表全部 21 行的「回灌去向」列：

| # | 缓解项 | 来源 Issue# | 回灌去向 | 含③? |
|---|--------|-----------|---------|------|
| 1 | runtime cwd 路径校验 | #1, #5 | ⑤契约 | 否 |
| 2 | session.create 失败回滚 | #1 | ⑤时序图 | 否 |
| 3 | 新建触发点幂等保护 | #1 | ⑤test-matrix | 否 |
| 4 | session.create 结构化日志 | #1 | ⑤契约 | 否 |
| 5 | landing hydrate 骨架屏 | #2 | ⑤test-matrix | 否 |
| 6 | getHistory 失败重试出口 | #2 | ⑤test-matrix | 否 |
| 7 | 状态机非法转换回 idle + 错误边界 | #3 | ⑤test-matrix | 否 |
| 8 | overlay 打开切 session cancelled 转移 | #3 | ⑤test-matrix | 否 |
| 9 | 状态转换 debug 日志 + 非法转换计数 | #3 | ⑤契约 | 否 |
| 10 | getStatus 复用 readGitInfo 同源缓存 | #6 | ⑤test-matrix | 否 |
| 11 | getStatus P99 耗时埋点 | #6 | ⑤契约 | 否 |
| 12 | getStatus P99 > 200ms 告警 | #6 | 运维项 | 否 |
| 13 | dirty 切走 inline 二次确认条 | #6 | ⑤test-matrix | 否 |
| 14 | pick-directory IPC 抛错 popover 显错 | #5 | ⑤test-matrix | 否 |
| 15 | createBranch 分支名双重校验 | #7 | ⑤test-matrix | 否 |
| 16 | createBranch execSync 超时包装 | #7 | ⑤契约 | 否 |
| 17 | GitCommand 白名单显式枚举 | #7 | ⑤契约 | 否 |
| 18 | createBranch 提交按钮 disabled 防重复 | #7 | ⑤test-matrix | 否 |
| 19 | createBranch 失败留 modal 显错（D-7） | #7 | ⑤test-matrix | 否 |
| 20 | createBranch 结构化日志 | #7 | ⑤契约 | 否 |
| 21 | forkSession 源 cwd 透传 | #8 | ⑤test-matrix | 否 |

**结论**：21 行「回灌去向」全部为 ⑤契约/⑤时序图/⑤test-matrix/运维项，**0 行指向③issue**。与 ④ L365「回灌指针说明」自述一致（本表无③新 issue 回灌去向）。

### 附：来源 Issue# 列交叉验证（非回灌去向，但涉及③引用）

「来源 Issue#」列出现：#1、#2、#3、#5、#6、#7、#8，全部真实存在于③决策图主节点。无悬空来源引用（#4/#9–#12 未被引用为来源，合理——#4 是纯函数无 NFR 副作用、#9–#12 是 P3 延后项）。

## Gap 清单

| Gap ID | 类型(F/K/D) | 指针类型(PHANTOM/MISMATCH/ORPHAN) | 描述 |
|--------|------------|----------------------------------|------|
| — | — | SKIP | ④回灌表无「回灌去向=③issue」行，③PHANTOM/MISMATCH 无可查对象。⑤指针不查（⑤尚未产出，闭环由⑤来源 B 接住）。 |

## 总结

回灌表③指针检查：**SKIP**（0 条指向③的行）。④ 21 条缓解项回灌去向全去 ⑤（契约/时序图/test-matrix）+ 运维项，与 ④ L365 自述一致。③真实 issue 清单 12 个（决策图主节点 #1–#8 + P3 延后 #9–#12）。来源 Issue# 列引用的 #N 全部真实存在，无悬空。
