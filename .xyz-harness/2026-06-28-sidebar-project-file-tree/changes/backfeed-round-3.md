# 反哺 Round 3 — ⑤code-arch → 上游

> ⑤code-arch Step 6b 反哺检查（纸面阶段，Step 1-5）。本轮 5 组追踪发现 1 处需反哺上游的架构 AC 覆盖缺口（K-2），已落地。

## 反哺条目

### K-2: ②§11 AC-2b grep pattern 覆盖不全（fs/promises 动态 import + node:path/node:os）

**发现阶段**: ⑤code-arch 结构帧（fresh subagent，源码实证）
**发现人**: fresh subagent（独立 context）
**类型**: 架构验收 AC 覆盖缺口（非决策推翻，K 级）

**问题**:
- ②architecture §11 AC-2b 原文：`grep -rn "node:fs" src-electron/runtime/src/transport/` 期望无输出
- 源码实证 `transport/server.ts`:
  - L8 `import { createServer } from 'node:http'`（WS 宿主，合理）
  - L9 `import { resolve } from 'node:path'`（BC-3 下沉后应清零）
  - L10 `import { homedir } from 'node:os'`（BC-3 下沉后应清零）
  - **L492 `const fs = await import('fs/promises')`** — 这是真实三层违纪（正是 BC-3 要修的），但**旧 AC grep `node:fs` 漏掉 `fs/promises` 动态 import 形式**，会误判通过
- → 旧 AC-2b 无法捕获它本该守的违纪，验收形同虚设

**反哺动作**:

| 上游文件 | 修改内容 |
|---------|---------|
| ②architecture §11 AC-2b | grep pattern 扩展：`grep -rn "node:fs\|node:path\|node:os\|from ['\"]fs\|import\(['\"]fs" src-electron/runtime/src/transport/` 期望无输出。补 `[BACKFED from ⑤code-arch K-2]` 标注 + 漏检理由（fs/promises 动态 import + BC-3 下沉残留）+ node:http 白名单（WS 宿主豁免） |
| ②architecture §下游衔接 Step 6b | 追加 K-2 反哺条目 |
| ②architecture frontmatter | `backfed_from: [issues, nfr]` → `[issues, nfr, code-arch]` |

**非 D-不可逆**：K-2 是 AC grep 覆盖补强（源码实证驱动），非用户已拍板决策的推翻，无需 ask_user。

## 无反哺的 gap（全在 ⑤内消化）

其余 F-1~F-8/K-1/K-3~K-6/D-1~D-6 均为 code-architecture.md 自身修正（时序图参与者/FileError 类型/protocol reply type/test-matrix MISSING 用例/§7 处置精度），不触发上游修订。K-9 已在 ④NFR 阶段反哺，本阶段落地一致。闭环帧全 PASS（搭便车 4 项 + BC-1~BC-6 无变主工程）。D-001~D-020 confirmed 决策无下游证据推翻。

## 闭环验证

- ②architecture §11 AC-2b grep pattern 已扩展（含 fs/promises + node:path + node:os）
- ②architecture frontmatter backfed_from: [issues, nfr, code-arch] 已标
- ⑤code-architecture.md Step 6b 反哺记录已记 K-2
- **Step 7 骨架物理验证后**可能触发新反哺（骨架常证伪②分层假设——⑤反哺高发场景），届时追加本文件
