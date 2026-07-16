# Retrospect — fix-homedir-record-guard

## 任务概览

在 WorkspaceService.record 加 homedir 拒绝守卫（方案A），一处堵死 homedir 进入最近工作区列表的全部路径。同时移除 W5 的 sessionCwd===requestedCwd 源头判断，homedir 过滤统一归位 service 层。

## 做对了什么

1. **方案选对了**：调查发现 W5 修复有漏洞（sendPrompt 路径漏掉），方案A 在 service 层一处堵死全部 4 条路径，比「分散在 lifecycle + dispatcher + handler 补守卫」更可靠。之前 W5 用的「堵源头」思路被证明不可靠（漏了 dispatcher），这次切到「service 层统一过滤」是正确的架构归位。
2. **review subagent 发现存量自愈缺口**：loadFromFile 不过滤磁盘已写入的 homedir 条目，守卫只挡新 record。review 后补了 loadFromFile 过滤，存量记录重启自愈。
3. **职责分层清晰**：lifecycle 不再关心 homedir（无条件 record），service 层统一过滤——调用方不需要知道 homedir 是什么，数据层保证「homedir 不入列表」。
4. **TDD 严格执行**：先写 service 守卫测试（红）→ 写实现（绿）→ 调整 lifecycle 测试（反映新语义）→ 集成回归。

## 教训

1. **CW expected.text 严格 `!==` 比较**：U2 的 actual.text 漏了 `/my/repo` 的单引号包裹（expected 是 `'/my/repo'`，我写成 `/my/repo`），CW 判 failed。教训：actual.text 一字不差复制 expected.text 原文，或从 expected.text 直接复制。
2. **「堵源头」策略有天然盲区**：W5 在 lifecycle.create 堵 homedir，但漏掉了 dispatcher.sendPrompt（session.cwd 已是 homedir 后发消息仍 record）。教训：当「源头」有多个时，堵一个不等于堵全部。在数据层（service/store）加统一过滤比分散堵源头更可靠。

## 流程数据

- Wave: 1
- commit: 2（W1 main + review fix）
- testCase: 6（U1-U5 + E1，全 passed）
- review 发现：0 must_fix + 1 should_fix（存量自愈，已在 review 后修）+ 3 nit
