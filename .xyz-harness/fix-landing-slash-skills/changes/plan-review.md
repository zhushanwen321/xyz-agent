# Plan Review: fix-landing-slash-skills

**审查对象**: dev-plan.json 初稿（W1 实现 + W2 测试）
**审查方法**: 禁读重建 + 三维度（coverage / architecture / feasibility）
**代码核实**: 读 CommandPopover.vue / Composer.vue / command-popover-landing.test.ts 确认改动点描述准确。

## 1. 禁读重建（应有大纲）

基于 spec FR-1..FR-5 + AC-1..AC-5 重建 dev-plan 应有结构：

- **W1（实现，P0）**：
  - CommandPopover.vue：新增 `variant` prop（默认 `'panel'`）；`slashCommands` computed 改按 variant 分支替代 sessionId 互斥；landing 分支合并 commandStore ∪ settingsStore.skills，skill name 归一化为 `/skill:<name>`；panel 分支保持 compact + commandStore 不并入 skills
  - Composer.vue：CommandPopover 调用处透传 `:variant="variant"`
- **W2（测试，P0，dependsOn W1）**：command-popover-landing.test.ts L1-L4 mount 改 variant+非空 sessionId、L5 补 variant:panel、L7 断言改 /skill:、新增 AC-2 合并源 + AC-5 回归断言

## 2. 与初稿 diff

初稿与重建**基本一致**。唯一差异——初稿 W1 把 CommandPopover.vue 拆成两条 change（change[0] FR-1/2/3/5 重构 + change[1] FR-4 前缀修复），二者改的是同一个 `slashCommands` computed 的同一个 landing 分支，应合并（见 PR1）。

## 3. 代码核实结果

| 核实项 | 事实 | 与 plan 描述 |
|--------|------|-------------|
| CommandPopover.vue slashCommands computed | L140-162 用 `if (props.sessionId)` 互斥分支；landing 分支 name 补 `/${s.name}`（非 `/skill:`） | FR-4 潜伏 bug 属实 ✓ |
| CommandPopover.vue defineProps | 无 variant prop | FR-5 改动点准确 ✓ |
| Composer.vue CommandPopover 调用 | L17-24 传 sessionId 但未透传 variant | FR-5 配套改动准确 ✓ |
| 测试 L1-L4 / L5 / L7 | sessionId:undefined / sessionId:'s1' / 断言 '/code-review' | AC-5 改动点准确 ✓ |

## 4. 三维度审查

### coverage — 通过
5 FR 全覆盖（FR-1/2/3/4/5 在 W1，AC-1/2/4/5 在 W2）。AC-3（session 态不含 skills 独有项）由 L5 session 态用例 + 补 variant:panel 覆盖（L5 当前断言 4 项不含 skills，补 variant 后断言保留）。无 FR 被忽略。

### architecture — 1 个 should-fix
- **PR1**：W1 两条 CommandPopover.vue change 应合并为一条（见下表）。
- W2 dependsOn W1 正确（测试 mount 方式依赖 variant prop 存在）。
- 无巨型 wave，复杂度 low。
- 架构词表：`slashCommands` computed 是命令源切换的 seam，本次改 seam 判定条件（sessionId → variant）+ landing 分支合并逻辑。locality 好，改动收敛在一个 computed + 一处 prop 透传。两 adapter 判据：CommandPopover 消费 commandStore（session 源）+ settingsStore（config 源），landing 态同时消费两源但 adapter 边界没破坏，没新增第三源。

### feasibility — 通过
W1 实际 2 文件（CommandPopover + Composer）、W2 单文件测试，各一个 dev cycle 可完成。changes 描述可执行。

## 5. 审查结论

**plan 就绪进 tdd_plan**。无 must-fix。1 个 should-fix（PR1：W1 change 合并）不阻塞——即使不合并 dev 也能完成，合并让 description 更清晰。

| ID | severity | dimension | ref | 修订建议 | 状态 |
|----|----------|-----------|-----|---------|------|
| PR1 | should-fix | architecture | W1 change[0] + change[1] | 合并两条 CommandPopover change 为一条，description：「landing 分支 = 合并 commandStore.getCommands(sessionId) ∪ settingsStore.skills，skill name 归一化为 /skill:<name>（FR-1/2/4）；panel 分支 = compact + commandStore 不并入 skills（FR-3）；判定用 variant（FR-5）」 | ✅ resolved（replan 合并） |

plan_review turn 2 复查：空 issues，进 tdd_plan。
