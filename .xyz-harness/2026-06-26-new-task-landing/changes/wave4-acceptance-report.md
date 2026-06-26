---
verdict: pending
date: 2026-06-27
---

# Wave 4 验收报告 — 新建任务（new-task landing）

> HEAD `2ec3c7b8`（Wave 1-3 全完成）。本报告由 Wave 4 自动化验收 subagent 生成。
> **诚实原则**：手工走查未执行 → verdict=**pending**，不伪造 pass。tsc 类型错误与 T4.8 auto 缺失如实记录。

## §1 自动化测试总结

| 套件 | 命令 | 结果 | EXIT |
|------|------|------|------|
| 前端 new-task | `cd src-electron/renderer && npx vitest run src/__tests__/new-task/` | **8 文件 / 75 用例全 passed** | 0 |
| runtime new-task | `cd src-electron/runtime && npx vitest run test/new-task/` | **3 文件 / 24 用例全 passed** | 0 |
| 前端类型检查 | `cd src-electron && npx vue-tsc --noEmit -p renderer` | **干净，无错误** | 0 |
| runtime 类型检查 | `cd src-electron/runtime && npx tsc --noEmit` | **2 个类型错误**（见下） | **2** |

**runtime tsc 2 个类型错误（vitest 用 esbuild 不做类型检查故全绿，tsc --noEmit 暴露）：**

1. `src/services/git-service.ts(122,50)` — `Argument of type '"branch"' is not assignable to parameter of type 'GitCommand'`。
   根因：`GitCommand` 白名单 = `'status'|'add'|'reset'|'commit'|'diff'|'rev-parse'|'checkout'`（git-executor.ts:23），Wave 2 给 `getStatus` 加分支列表数据源时调了 `execSafe(cwd,'branch',...)` 但**漏扩 GitCommand 加 `'branch'`**。git-executor-port.test.ts:21 的白名单完整性断言也只验了 7 项不含 `branch`，与实现自洽但与 git-service.ts:122 实际调用矛盾。
2. `test/new-task/git-service.test.ts(26,61)` — `Type 'typeof GitService' does not satisfy the constraint '(...args: any) => any'`。测试在泛型约束位用了 `typeof GitService`（类构造器），不满足 callable 约束。

**定性**：均为 Wave 1-3 runtime 实现的类型窟窿，非 Wave 4 引入。vitest 行为正确（99 个用例全绿），但 `tsc --noEmit` 不通过。**建议回流 Wave 1-3 处理**：要么扩 GitCommand 加 `'branch'`（+ 同步更新白名单单测），要么 getStatus 分支列表改用已白名单的命令。本 subagent 只验收不修。

## §2 39 用例状态统计

| 状态 | 数量 | 占比 | 用例 ID |
|------|------|------|---------|
| **PASS（纯 auto 绿）** | 31 | 79% | T1.1-T1.8, T3.1, T3.2, T3.5, T4.1, T4.2, T4.4, T4.6, T4.9, T6.1-T6.8, T7.1, T8.1-T8.6 |
| **PASS（auto 绿）+ 待人工走查** | 4 | 10% | T3.3, T3.4, T4.3, T4.5（auto mock 分支已绿，真实 OS/git 部分待走查） |
| **[DEVIATED]④NFR 允许 v1 不加缓存** | 1 | 3% | T4.7（条件性，v1 未加缓存，登记豁免） |
| **⚠️ auto 单测缺失 + 待人工走查** | 1 | 3% | T4.8（设计的 `describe('Esc 排队')` 未实现） |
| **待人工走查（pure manual）** | 1 | 3% | T7.2（非 git→git 恢复，依赖外部 git init + git-info 缓存 TTL） |
| **待验（独立 ticket #8，未实现）** | 1 | 3% | T1.9（fork-session.test.ts 未建） |
| **合计** | **39** | 100% | — |

> 主交付口径（计划 D-4：主流程 38 = 39 − T1.9 独立）：38 用例中 PASS 31 / DEVIATED 1 / 待走查 6（含 T4.8 auto 缺口）/ auto 缺口 1。

## §3 39 用例逐条状态表

| 用例 ID | 类型（主） | 状态 | 测试文件 / 手工清单 | 备注 |
|---------|-----------|------|---------------------|------|
| T1.1 | integration | PASS | flow-integration.test.ts:85 + session-api.test.ts:43 | startFlow 全链路 + cwd 透传配套 |
| T1.2 | unit | PASS | use-new-task-flow.test.ts:83 | 首次启动延迟 create |
| T1.3 | integration | PASS | flow-integration.test.ts:103 | E1 双击并发 in-flight 守卫 |
| T1.4 | integration | PASS | flow-integration.test.ts:111 | E2 非法 cwd reject |
| T1.5 | integration | PASS | flow-integration.test.ts:121 | E3 spawn 失败回滚 |
| T1.6 | unit | PASS | landing.test.ts:74 | messageCount===0 渲染 |
| T1.7 | unit | PASS | landing.test.ts:82 | isGenerating 优先 |
| T1.8 | unit | PASS | landing.test.ts:145 | getHistory 失败重试 |
| T1.9 | unit | **待验（独立 ticket #8）** | fork-session.test.ts（**未建**） | forkSession cwd 透传，独立 PR，不阻塞主交付 |
| T3.1 | integration | PASS | flow-integration.test.ts:133,151 | selectWorkspace 列表选择 + noop |
| T3.2 | unit | PASS | dir-select-popover.test.ts:51 | 空态文案 |
| T3.3 | integration(+manual) | PASS（auto）+ 待走查 M-1 | flow-integration.test.ts:167 | auto mock canceled=false 绿；真实 OS dialog 待 M-1 |
| T3.4 | integration(+manual) | PASS（auto）+ 待走查 M-1 | flow-integration.test.ts:182 | auto mock canceled=true 绿；真实取消待 M-1 |
| T3.5 | integration | PASS | flow-integration.test.ts:198 | E5 IPC 抛错 |
| T4.1 | unit(+integration) | PASS | git-service.test.ts:41 + flow-integration.test.ts:212 + git-message-handler.test.ts:68 | runtime + 前端 + handler 三侧 |
| T4.2 | integration | PASS | flow-integration.test.ts:232 | dirty 确认切走留工作区 |
| T4.3 | unit(+manual) | PASS（auto）+ 待走查 | branch-select-popover.test.ts:43 + git-service.test.ts:92 | auto mock unborn 绿；真实 unborn 仓库待走查 |
| T4.4 | unit | PASS | use-new-task-flow.test.ts:187 | 非 git 不可达 |
| T4.5 | unit(+manual) | PASS（auto）+ 待走查 M-3 | git-service.test.ts:47 + flow-integration.test.ts:251 | auto checkout reject 留 popover 绿；真实工作区不变待 M-3 |
| T4.6 | unit | PASS | branch-select-popover.test.ts:54 | getStatus 失败显错 |
| T4.7 | manual(条件性) | **[DEVIATED]④NFR 允许 v1 不加缓存** | — | 见 execution-plan.md D-6；v1 未加缓存，需用户确认豁免 |
| T4.8 | unit(+manual) | **⚠️ auto 缺失 + 待走查** | use-new-task-flow.test.ts（**缺 describe('Esc 排队')**） | test-cases-layered 设计的 it 未实现；真实 execSync 阻塞待走查 |
| T4.9 | unit | PASS | branch-select-popover.test.ts:66,77 + git-service.test.ts:80 | 虚拟滚动 + 分支列表 |
| T6.1 | unit(+integration) | PASS | git-service.test.ts:117 + flow-integration.test.ts:285 + git-message-handler.test.ts:101 | runtime + 前端 + handler |
| T6.2 | unit | PASS | create-branch-modal.test.ts:100 | 分支名校验 |
| T6.3 | unit | PASS | git-service.test.ts:123 + create-branch-modal.test.ts:126 + flow-integration.test.ts:327 | E10 已存在留 modal D-7 |
| T6.4 | unit | PASS | git-service.test.ts:134 + create-branch-modal.test.ts:146 | E11 超时留 modal |
| T6.5 | unit | PASS | use-new-task-flow.test.ts:209 | E9 来源守卫 |
| T6.6 | unit | PASS | create-branch-modal.test.ts:160 + flow-integration.test.ts:293 | 飞行中防重复 |
| T6.7 | unit | PASS | create-branch-modal.test.ts:183 + flow-integration.test.ts:309 | 飞行中 Esc 孤儿 promise |
| T6.8 | unit | PASS | git-service.test.ts:142,149 | runtime 分支名二次校验 |
| T7.1 | unit | PASS | use-new-task-flow.test.ts:94 | 非 git 守卫 |
| T7.2 | manual | **待走查（pure manual）** | — | 非 git→git 恢复，依赖 git-info 缓存 TTL |
| T8.1 | unit | PASS | use-new-task-flow.test.ts:116 | overlay 互斥 |
| T8.2 | unit | PASS | use-new-task-flow.test.ts:130 | Esc 优先级 |
| T8.3 | unit | PASS | use-new-task-flow.test.ts:144 | overlay 切 session |
| T8.4 | unit | PASS | use-new-task-flow.test.ts:154 | cancelled 重入 |
| T8.5 | unit | PASS | use-new-task-flow.test.ts:165 | completed 终态销毁重建 |
| T8.6 | unit | PASS | use-new-task-flow.test.ts:179 | 非法转换抛错 |

## §4 E2E-1~7 自动化场景覆盖情况

> v1 无 Playwright。e2e-test-plan §2 的 E2E-1~7 设计为 integration 测试覆盖（mock 进程边界）。下表为现有 integration/unit 测试对每个 E2E 场景的覆盖度。

| E2E ID | 场景 | 覆盖情况 | 对应用例 |
|--------|------|---------|---------|
| E2E-1 | 首次启动 ⌘N→chip 空态→选目录→选分支→发送 | **组合覆盖（无单点贯穿测试）** | T1.2（首次启动）+ T1.1（startFlow）+ T3.1（选目录）+ T4.1（选分支）各步骤 integration 覆盖，但无单一测试串联完整轨迹 |
| E2E-2 | 非首次启动 ⌘N→直接发送 | **组合覆盖（无单点贯穿测试）** | T1.1 + lib-utils.test.ts resolveDefaultCwd 多 session 取最新（数据基座）；无"非首次直接发送"单一 integration |
| E2E-3 | 取消 OS dialog→落回 popover | **覆盖（auto）+ 待走查** | T3.4 flow-integration.test.ts:182 auto mock 绿；真实 dialog 取消待 M-1 |
| E2E-4 | dirty 确认切走→留工作区 | **覆盖（auto）+ 待走查** | T4.2 flow-integration.test.ts:232 auto 绿；真实工作区不变待 M-3 |
| E2E-5 | 创建分支→chip 回灌 | **覆盖（auto）+ 待走查** | T6.1 flow-integration.test.ts:285 auto 绿；真实 `.git/refs/heads` 出现待 M-4 |
| E2E-6 | 非法分支名 disabled | **覆盖（auto）** | T6.2 create-branch-modal.test.ts:100 auto 绿，纯前端校验 |
| E2E-7 | 状态机非法转换→抛错回 idle | **覆盖（auto）** | T8.6 use-new-task-flow.test.ts:179 auto 绿 |

**覆盖统计**：直接覆盖 5 个（E2E-3~7，其中 E2E-3/4/5 含真实走查待办）；组合覆盖（各步骤覆盖但无单点贯穿）2 个（E2E-1/E2E-2）。
**缺口**：E2E-1/E2E-2 作为"端到端轨迹"无单一 integration 测试贯穿。若 v1 视 integration 各步骤覆盖为达标则无缺口；若严格要求单点 E2E 贯穿则需补 2 个 integration。本报告按前者记录（与 e2e-test-plan §1「能 mock 的全测」+ §2 mock 边界一致）。

## §5 待人工走查清单

> **手工走查需用户在真实 Electron 环境执行，subagent 无法驱动 OS 原生 dialog / 真实 git 进程 / 真实窗口。**
> 操作步骤详见 [e2e-test-plan.md](../e2e-test-plan.md) §3 手工验收走查清单。

### §5.1 e2e-test-plan §3 手工清单 M-1~M-7（全部待执行）

| M ID | 操作（详见 e2e-test-plan.md §3） | 状态 | 覆盖用例 |
|------|--------------------------------|------|---------|
| M-1 | mac/win/linux 各一遍：⌘N→点目录 chip→「打开文件夹」→原生选目录→选 git repo | **待走查** | T3.3 / T3.4（OS dialog 选中/取消） |
| M-2 | 选 repo A 发消息→再 ⌘N→点目录 chip→选 repo B | **待走查** | T1.1/T3.1（切 cwd） |
| M-3 | repo A 建改动文件不 commit→⌘N→点分支 chip→选另一分支→二次确认「切走」 | **待走查** | T4.2 / T4.5（真实工作区不变） |
| M-4 | ⌘N→点分支 chip→「创建分支」→填 `test-e2e-branch`→「创建并切换」 | **待走查** | T6.1（真实 `.git/refs/heads` 出现） |
| M-5 | 全屏/非全屏/已有会话/无会话 4 态各按 ⌘N | **待走查** | T1.1/T1.2（4 态唤起落地空态） |
| M-6 | 拉窗口到极窄高度→点 chip 开 popover | **待走查** | 遗留项（spec §6 fallback 未做） |
| M-7 | 创建分支瞬间最小化/切走窗口→等 8s→恢复 | **待走查** | T6.4（超时/失败留 modal） |

### §5.2 manual 类用例走查（test-cases-layered 未自动化用例清单）

| 用例 ID | 手工走查内容 | 状态 | 不能自动化的根因 |
|---------|-------------|------|----------------|
| T3.3 | 真实点「打开文件夹」→ OS 原生 dialog 弹出 → 选目录 → chip 回灌 | **待走查（M-1）** | OS 原生 dialog 无法在 vitest 模拟，前端只测 canceled=false mock 分支 |
| T3.4 | 真实 OS dialog 取消 → 落回 popover、chip 不变 | **待走查（M-1）** | 同上，前端只测 canceled=true mock 分支 |
| T4.3 | 真实 unborn HEAD 仓库（`git init` 后未 commit）→ popover 空态+引导 | **待走查** | 需真实无 commit 仓库，前端只测 mock status 返回 unborn |
| T4.5 | dirty 切走冲突 → 真实工作区文件内容不变 | **待走查（M-3）** | "工作区不变"需真实 git 工作树校验，前端只测 checkout reject 留 popover |
| T4.7 | （条件性）若加 per-cwd 缓存：同 cwd 连开两次零 spawn | **[DEVIATED]豁免** | v1 不加缓存，按 D-6 标 `[DEVIATED]④NFR 允许`，**需用户确认豁免** |
| T4.8 | 真实分支 100+ + getStatus execSync 阻塞期间按 Esc → 阻塞后事件不丢 | **待走查** | 真实 execSync 同步阻塞无法在 vitest 复现；**且 auto 排队单测缺失，建议 Wave 2 补** |
| T7.2 | 非 git 目录下外部 `git init` → 重开 popover / 等缓存 TTL → branch chip 恢复 | **待走查** | 依赖外部 git init + git-info 缓存 TTL（本期不改 git-info） |

## §6 Verdict: **pending**

**Wave 4 未达 PASS，原因（三者均需闭合才能转 pass）：**

1. **手工走查未执行**：M-1~M-7（§5.1）+ manual 用例走查（§5.2，T3.3/T3.4/T4.3/T4.5/T4.8/T7.2）全部待人工走查。**手工走查需用户在真实 Electron 环境执行，subagent 无法驱动 OS 原生 dialog（NSOpenPanel/IFileOpenDialog）/ 真实 git 进程 / 真实窗口交互**。任一未走查 = Wave 4 未完成（e2e-test-plan §5 DoD 第 2 项）。

2. **T4.8 auto 单测缺口**：test-cases-layered 设计的 `describe('Esc 排队')`（gitApi.status pending 期间 emit Esc）在 use-new-task-flow.test.ts 中**未实现**。建议回流 Wave 2 补单测后再转 pass。

3. **runtime tsc 类型错误**（§1）：`git-service.ts:122` 用 `'branch'` 但 GitCommand 白名单不含；`git-service.test.ts:26` 泛型约束不匹配。vitest 全绿但 `tsc --noEmit` EXIT=2。建议回流 Wave 1-3 修（扩 GitCommand 或改 getStatus 调用）。

**已闭合部分**：
- DoD 第 1 项（§2 自动化场景 E2E-1~7）：vitest 前端 75 + runtime 24 = 99 用例全绿；E2E-3~7 直接覆盖，E2E-1/2 组合覆盖（按 e2e-test-plan §1「能 mock 的全测」口径达标）。
- DoD 第 3 项（39 用例状态列全填）：execution-plan.md「测试验收清单」39 用例状态列已全部从「待验」更新为实际状态（PASS/DEVIATED/待走查/待验独立）。

**转 pass 的前置条件**（按优先级）：
1. 用户在真实 Electron 环境执行 M-1~M-7 + §5.2 manual 走查，逐条登记 PASS/FAIL + 走查人 + 日期
2. Wave 2 补 T4.8 auto 单测（`describe('Esc 排队')`）
3. Wave 1-3 修 runtime tsc 2 个类型错误（扩 GitCommand 加 `'branch'` 或改 getStatus 调用）
4. 用户确认 T4.7 的 `[DEVIATED]④NFR 允许` 豁免

---

> 本报告由 Wave 4 自动化验收 subagent 生成，日期 2026-06-27。诚实反映：自动化全绿但手工未走查 + 1 auto 缺口 + 2 tsc 类型错误 → verdict=**pending**。
