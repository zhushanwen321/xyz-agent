# Code Review: cw-2026-07-21-scan-project-agents-skills (W1+W2+W3)

**审查对象**: commit 79351df9 (W1) + 58311b7b (W2) + 33c563e9 (W3)
**审查方法**: 三维度（correctness / design-consistency / test-quality）+ 源码核实 + 测试实跑
**测试实跑**: runtime 32 passed + renderer 19 passed = 51/51 全绿（主 agent 实跑，reviewer subagent 无 bash 未跑）

## 发现的问题

| # | Severity | Dimension | Ref | Description | 状态 |
|---|----------|-----------|-----|-------------|------|
| R1 | must-fix | correctness | session-service.ts:686 getSkillPaths | W1 与 W2 家目录展开不对称。W1 getSkillPaths 对 `~/xxx` 前缀路径（如 discovery.json 实际配置的 `~/.pi/agent/skills`、`~/.agents/skills`）不展开——`isAbsolute('~/.pi/agent/skills')` false（`~` 非路径绝对标志）→ `resolve(cwd, '~/.pi/agent/skills')` = `<cwd>/~/.pi/agent/skills`（错位）→ existsSync false → 被 filter 掉。W2 loadSkills 用 expandHome 展开 `~` 正常。后果：全局 skill 目录在 pi `--skill` 注入时被丢，landing 显示的 skill（loadSkills 扫到）选中后 pi 不认（pi 没收到 --skill）。spec FR-1 明确要求覆盖 `~/xxx` 家目录。 | 待 review_fix |
| R2 | nit | design-consistency | CommandPopover.vue:186 注释 | 注释"全局 settingsStore.skills 先选，projectSkills 补项目独有项"与 L164"去重 pi 源优先 → 全局 → 项目"矛盾。实际代码顺序：extCmds(pi) 先入 seen → globalSkillCmds(全局) → projectSkillCmds(项目)，pi 优先级最高。L186 注释误导（应说"全局次之，项目最后"）。代码逻辑正确，仅注释错。 | 待 review_fix |
| R3 | should-fix | edge-case | useProjectSkills.ts:55 watch loadFor 竞态 | cwd 快速切换 A→B→A 时，若 A 的 RPC 仍 pending，`has(A)` false → 触发第二次 loadFor(A)。无 in-flight 去重。后果：重复 RPC（结果幂等，不破坏最终一致性，但浪费 RPC + 可能短暂覆盖）。 | 待 review_fix |

## R1 详细核实（主 agent）

discovery.json 实际配置（用户 dev 环境）：
```json
{ "skillDirs": ["~/.pi/agent/skills", "~/.agents/skills", ".agents/skills"] }
```

W1 getSkillPaths 对三条配置的处理：
- `~/.pi/agent/skills`: isAbsolute false → resolve(cwd, '~/.pi/agent/skills') 错位 → filter 掉 ✗
- `~/.agents/skills`: 同上 ✗
- `.agents/skills`: isAbsolute false → resolve(cwd, '.agents/skills') 正确 ✓（只有这条活下来）

W2 loadSkills 对同样的三条（经 orderedDirs + expandHome）：
- `~/.pi/agent/skills`: expandHome 展开 → 扫到 ✓
- `~/.agents/skills`: 同上 ✓
- `.agents/skills`: resolve(projectRoot, ...) → 扫到 ✓

**不对称后果**：landing 浮层显示 3 个目录的 skill（loadSkills 扫到），但 pi `--skill` 只注入 `.agents/skills` 一个（getSkillPaths filter 掉两个 `~` 前缀的）。用户选中全局 skill（来自 `~/.pi/agent/skills`）后 pi 报 unknown command。

## 审查结论

**有 1 个 must-fix（R1）+ 1 个 should-fix（R3）+ 1 个 nit（R2）**。R1 需进 review_fix 修代码 + 补测试。R3 补 in-flight 去重或接受现状（幂等）。R2 修注释。

R1 修复方向：getSkillPaths 对 `~` 前缀路径先 expandHome 再 isAbsolute/resolve 判断（与 W2 loadSkills 对称）。补测试覆盖 `~/.agents/skills` 配置场景。

核心修复目标（FR-1 getSkillPaths cwd resolve、FR-2 loadSkills + scanSessionSkills RPC、W3 useProjectSkills 三源合并）均已正确实现，测试 51/51 全绿，防线有效。R1 是 FR-1 的边界遗漏（`~` 展开），非核心逻辑错误。

---

## review_fix 闭环（turn 2 复查）

R1/R2/R3 已在 commit 66bd0414 修复：
- R1 (must-fix): getSkillPaths 加 expandHome，与 W2 loadSkills 对称。补测试 R1 用例。
- R2 (nit): CommandPopover L186 注释修正。
- R3 (should-fix): useProjectSkills 加 inFlight Set 去重。

review turn 2 复查：空 issues，进 test。测试 51/51 全绿（runtime 32 + renderer 19），typecheck 干净。
