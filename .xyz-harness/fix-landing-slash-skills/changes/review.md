# Code Review: cw-2026-07-21-fix-landing-slash-skills (W1+W2)

**审查对象**: commit 6f1bd47b (W1) + 5c95f630 (W2)
**审查方法**: 三维度（correctness / design-consistency / test-quality）+ 源码 + 数据流核实
**关键修正**: 主 agent 核实用户原现象 + 数据流后，将 reviewer 标记的 #1 从 should-fix 升级为 must-fix。

## 用户原现象核实（关键）

用户报告：修复前 landing 敲 / 只看到 `/goal` 等 extension 命令 + **一些全局 skill**，**项目维度 skill 不显示**。

这印证了数据流分析：
- publicSession 的 cwd = `getDataDir()`（~/.xyz-agent/），pi 对它 get_commands 扫描的强制目录 `.xyz-agent/skills` 相对该 cwd = `~/.xyz-agent/.xyz-agent/skills`（不存在），扫不到用户项目的 `.xyz-agent/skills`
- settingsStore.skills 扫描时 `.xyz-agent/skills` 相对 runtime 进程 cwd（用户打开的项目），能扫到真实项目级 skill
- 所以 publicSession pi 返回的 skill（用户看到的"全局 skill"）与 settingsStore.skills **有重叠**（`<piAgentDir>/skills` + 全局），settingsStore 独有的是项目级 `.xyz-agent/skills`

## 发现的问题

| # | Severity | Dimension | Ref | Description | 状态 |
|---|----------|-----------|-----|-------------|------|
| 1 | must-fix | design-consistency | CommandPopover.vue slashCommands landing 分支 | landing 合并源不去重... | ✅ resolved（d32bae04） |
| 2 | must-fix | test-coverage | command-popover-landing.test.ts L9 | L9 未覆盖重叠场景... | ✅ resolved（d32bae04，新增 L10） |
| 3 | should-fix | test-coverage | command-popover-landing.test.ts | 无 sessionId=undefined 用例... | ✅ resolved（d32bae04，新增 L11） |

review turn 2 复查：空 issues，进 test。

## 去重策略分析（#1 修复方向）

publicSession pi skill 命令与 settingsStore.skills 重叠时，去重保留哪个？

| 策略 | 含义 | 取舍 |
|------|------|------|
| A. pi 源优先 | 保留 publicSession pi 返回的 skill，丢弃 settingsStore 同名项 | pi 源是运行态真源（该 session 实际加载的），但 landing 态 publicSession 不是用户真实工作 session，pi 源意义弱 |
| B. settingsStore 优先 | 保留 settingsStore 的，丢弃 pi 同名项 | settingsStore 是配置态全局扫描，范围更广（含 discovery），但 landing 态用户更关心"这个项目能用什么" |
| C. 合并描述，任选一个 name | 取 pi 源 name（已是 `/skill:<name>` 格式），描述用更完整的 | 实现复杂，收益低 |

**推荐 A（pi 源优先）**：理由——publicSession 的 pi 命令是 pi 对真实 skill 目录扫描的结果（运行态），settingsStore 是 config 层独立扫描（配置态）。两者描述同一批 skill，pi 源更接近"pi 实际会加载的"。settingsStore 独有的项目级 skill（pi 扫不到的）自然保留填补。

实现：landing 分支先放 pi 的 extCmds（含 pi skill 命令），再 append settingsStore 中**pi 源没有**的 skill。

## 三维度小结

- **correctness**：核心归一化链路（/skill:<name> → items → onSelect）正确，variant 判定与 Composer.vue:280 对齐。**唯一 must-fix 是合并源不去重**（常态重复，非边缘）。
- **design-consistency**：ADR D1/D2/D3 落实。但 ADR-0037 未提及去重——需在 review_fix 后补 ADR 说明去重策略（pi 源优先）。
- **test-quality**：AC 覆盖齐全，防线有效，但**缺重叠去重场景**（#2）。

## 审查结论

**有 1 个 must-fix（#1）+ 1 个 must-fix（#2 测试）**，需进 review_fix 修代码 + 补测试后再复查。#3 should-fix 一并处理。

修复后需同步更新 ADR-0037（补充去重策略说明）。
