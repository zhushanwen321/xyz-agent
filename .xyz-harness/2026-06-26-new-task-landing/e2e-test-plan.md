---
verdict: pass
---

# 新建任务 · E2E 测试计划

> 适配 v1「无 Playwright」现实：OS 原生 dialog（`dialog.showOpenDialog`）是 Electron 主进程 API，需真实窗口，CI 无法驱动。

## 1. 测试范围与策略

**v1 不上 Playwright 的理由**：①dialog.showOpenDialog 是主进程 API，CI 无头环境无法唤起原生 NSOpenPanel/IFileOpenDialog；②项目当前零 E2E 框架，新增 Playwright/Spectron 是 P3 需求（spec §6 遗留），违反 Ponytail；③本功能是单机桌面应用，非多用户 Web，无回归膨胀压力。

**分层替代**：
- **自动化端到端集成测试**（§2）：挂载完整前端组件树（Landing+4 popover/modal+useNewTaskFlow 状态机+Pinia stores），用 vitest `vi.mock` 替换进程边界（IPC/WS），验证状态机+组件+编排逻辑的端到端正确性。这是「能 mock 的全测」。
- **手工验收走查清单**（§3）：真实 OS dialog/git CLI/窗口交互，人手执行。这是「mock 不了的」。

## 2. 自动化端到端集成测试场景

> mock 边界：mock `sessionApi`/`gitApi`（WS 请求）、`ipc.pickDirectory`（OS dialog）、`transport` 层；**不 mock** `useNewTaskFlow` 状态机、`resolveDefaultCwd`/`recentWorkspaces` 纯函数、Vue 组件渲染、Pinia store 状态流转。

| ID | 场景 | mock 边界 | 断言 | 覆盖 AC | Wave |
|----|------|----------|------|---------|------|
| E2E-1 | 首次启动 ⌘N→chip 空态→点目录 chip→选列表项→点分支 chip→选干净分支→打字发送 | sessions=[]；pickDirectory 返回 fake path；gitApi.checkout resolve；sessionApi.create resolve | state 轨迹 idle→landing→dir-popover→landing→branch-popover→landing→completed；chip 逐步回灌；发送后 session 进对话流 | AC-1.1/1.7/3.1/4.1 | 1+2 |
| E2E-2 | 非首次启动 ⌘N→直接打字发送（不点 chip） | sessions 含历史；sessionApi.create resolve | cwd=最近活跃 session 的 cwd；state landing→completed | AC-2.1 | 1 |
| E2E-3 | 选目录「打开文件夹」→取消 OS dialog→落回 popover | pickDirectory reject `{canceled:true}` | state dir-popover→dir-dialog→dir-popover；chip 不变 | AC-5.3 | 2 |
| E2E-4 | 选 dirty 分支→二次确认条→「切走」→gitApi.checkout resolve | gitApi.status 返回 dirty；gitApi.checkout resolve | 弹二次确认条；切走后 chip 回灌；**未提交改动留工作区**（断言不调 stash） | AC-4.2 | 2 |
| E2E-5 | 点「创建分支」→modal→填合法名→提交→chip 回灌 | gitApi.createBranch resolve | state branch-popover→branch-modal→landing；chip 显示新分支名 | AC-6.1 | 3 |
| E2E-6 | 创建分支填非法名（空格/`..`）→按钮 disabled→修正→成功 | 无需 mock gitApi（前端校验拦） | 非法名按钮 disabled+错误提示；修正后 disabled 消失 | AC-6.3 | 3 |
| E2E-7 | 状态机非法转换：idle 下直接调 `openBranchModal()`→抛错→回 idle→Vue 错误边界不崩 | 无 | 抛错被捕获；state 回 idle；组件树不崩 | AC-3.1/3.8 | 1 |

## 3. 手工验收走查清单

> 非开发者可执行。每条标操作步骤 + 预期。覆盖 AC 见末列。

| ID | 操作步骤 | 预期 | 覆盖 AC |
|----|---------|------|---------|
| M-1 | **mac/win/linux 各一遍**：sidebar 空态→⌘N→点目录 chip→「打开文件夹」→原生选目录→选一个 git repo→确认 | 原生目录选择器弹出（系统收藏/搜索/快捷键可用）；选中后 chip 回灌路径；工作区载入该目录 | AC-5.1 |
| M-2 | 准备 2 个真实 git repo A/B；选 A 发消息→再 ⌘N→点目录 chip→选 B | 切到 B 后 chip 显示 B 路径；文件树/分支信息变为 B 的 | AC-3.1 |
| M-3 | 在 repo A 建一个改动文件（git add 不 commit）；⌘N→点分支 chip→选另一个分支→二次确认条点「切走」 | git checkout 真实执行；改动文件**保留在工作区**（`git status` 仍显示）；branch chip 更新 | AC-4.2 |
| M-4 | ⌘N→点分支 chip→「创建分支」→填 `test-e2e-branch`→「创建并切换」 | `.git/refs/heads/test-e2e-branch` 出现；当前分支切到它；branch chip 显示新名 | AC-6.1 |
| M-5 | 全屏/非全屏/已有会话/无会话 4 态各按 ⌘N | 4 态都能唤起落地空态；已有会话态先建新空 session 不误切 | AC-1.1 |
| M-6 | 拉窗口到极窄高度（chip 距顶部<300px）→点 chip 开 popover | popover 展开不崩（spec §6 fallback 未做，统一向上展开，验证不遮挡/不出屏即过） | 遗留项 |
| M-7 | 提交创建分支瞬间最小化/切走窗口→等 8s→恢复 | 超时/失败留 modal 显错；恢复后状态一致不卡死 | AC-7.7 |

## 4. 测试环境

- **开发机**：`npm run dev` 起完整 Electron（renderer+main+runtime WS 全活）。自动化部分用 vitest 单跑挂载的组件树。
- **测试 fixture**：本地准备 3 个 git repo——①干净 repo（有多分支）；②dirty repo（有未提交改动）；③unborn HEAD repo（`git init` 无 commit）。再备 1 个非 git 目录。
- **mock 工具**：vitest `vi.mock` 模拟 `sessionApi`/`gitApi`/`ipc.pickDirectory`/`transport`。
- **CI 局限**：CI 只跑 unit + integration（含 §2 自动化场景）。§3 手工清单需人工在本机执行，CI 不覆盖 OS dialog/git CLI/窗口交互。

## 5. Wave 4 验收 Gate（DoD）

Wave 4 验收 Wave 的完成定义（**三者全满足才算 PASS**）：
1. §2 自动化场景 **E2E-1~E2E-7 全 PASS**（vitest 跑绿）
2. §3 手工清单 **M-1~M-7 全部人工走查并记录结果**（每条标 PASS/FAIL + 走查人 + 日期）——**未走查 = 未完成**
3. execution-plan.md「测试验收清单」39 用例状态列**全填**（PASS/FAIL/`[DEVIATED]`+原因）

手工清单任一条未走查即整体未完成，回主 agent 补走查。

## 6. v2 展望

**何时引入 Playwright**：①多平台回归需求成形（mac/win/linux 三端 UI 一致性需自动化保障）；②CI 质量门槛从「unit+integration」升级到「含 E2E」时。
**OS dialog 处理**：Playwright Electron API 的 `page.on('dialog')` 可拦截 Web dialog，但 `dialog.showOpenDialog`（主进程原生）需在 main 进程注入 mock（`electron.dialog.showOpenDialog = () => Promise.resolve({canceled:false,filePaths:[fake]})`），或用 Spectron/`@playwright/test` electron 的 `beforeEach` override dialog。届时 §2 自动化场景可平迁为真实 Playwright 用例，§3 手工清单缩减至快捷键/窗口边界少数项。
