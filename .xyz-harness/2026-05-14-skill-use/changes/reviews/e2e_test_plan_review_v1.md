# E2E 测试计划评审 v1

## 评审记录
- 评审时间：2026-05-14
- 评审类型：E2E 测试计划独立评审
- 评审对象：e2e-test-plan.md
- 评审轮次：第 1 轮

---

### Spec AC 覆盖矩阵

spec.md 中标记了 10 条验收标准（均标记"已实现"），以下逐条检查 E2E 用例覆盖：

| AC | 描述 | 覆盖状态 | 测试用例 | 备注 |
|----|------|---------|----------|------|
| AC1 | pi 进程启动时传递所有 enabled skill 的 `--skill` 路径参数 | ✅ 完整覆盖 | E2E-01(正向), E2E-02(反向), E2E-03(路径不存在), E2E-04(restoreSession) | 正向+反向+边界均有覆盖 |
| AC2 | SlashMenu 中 skill 命令展示名称、描述和参数提示 | ✅ 完整覆盖 | E2E-05(正向), E2E-06(无skill), E2E-07(键盘导航) |  |
| AC3 | parseSkillMd() 从 frontmatter 提取 argument-hint | ✅ 间接覆盖 | E2E-05, E2E-08 | 实现细节，通过 UI 行为间接验证 |
| AC4 | ScannedSkillInfo/SkillInfo 接口含 argumentHint | ✅ 间接覆盖 | E2E-05, E2E-08 | 类型定义，通过数据流端点验证 |
| AC5 | importSkills() 透传 argumentHint | ✅ 间接覆盖 | E2E-05, E2E-08 | 实现细节，通过 UI 行为间接验证 |
| AC6 | mergeSkillCommands() 使用 s.argumentHint | ✅ 间接覆盖 | E2E-05, E2E-08 | 实现细节，通过 UI 行为间接验证 |
| AC7 | 选择 skill 后输入框预填 argumentHint 文本 | ✅ 完整覆盖 | E2E-08(有hint), E2E-09(无hint), E2E-10(取消恢复) | 正向+反向+取消恢复 |
| AC8 | 发送 /skill:name text 后 pi 正确展开 skill 内容 | ✅ 完整覆盖 | E2E-11(带文本), E2E-12(不带文本) | 正向+边界 |
| AC9 | Settings 变更 skill 列表后，新 session 使用更新后的列表 | ✅ 完整覆盖 | E2E-14(新session不传被禁用skill), E2E-15(旧session不受影响) | 新旧session隔离 |
| AC10 | 无 enabled skill 时，SlashMenu 仅展示内置命令，不报错 | ✅ 完整覆盖 | E2E-06(SlashMenu), E2E-02(pi进程) | UI + 后端双重验证 |

spec 边界验证场景覆盖：

| 边界场景 | 覆盖状态 | 测试用例 |
|---------|---------|----------|
| skill 路径不存在时不崩溃 | ✅ | E2E-03 |
| 无 skill 时 SlashMenu 正常 | ✅ | E2E-06 |
| skill 名称含特殊字符时正确编码 | ⚠️ 弱覆盖 | Section 4 提及但无独立步骤 |

**覆盖结论**：所有 10 条 AC 均有对应测试用例，覆盖充分。

---

### 四层策略合理性

> 本项目是手动测试的 Electron 桌面应用，非自动化 E2E。验证方式为日志/DOM/视觉/交互。

| 用例 | 验证方式 | 场景 | 评估 |
|------|---------|------|------|
| E2E-01 ~ E2E-04 | 日志检查（sidecar终端 + ps aux） | 后端 skill 路径传递 | ✅ 合理，后端链路用日志验证 |
| E2E-05 ~ E2E-07 | DOM检查 + 视觉对比 | SlashMenu UI 展示 | ✅ 合理，UI 用例含 DOM 和视觉验证 |
| E2E-08 ~ E2E-10 | DOM检查 + 交互验证 | 输入框预填行为 | ✅ 合理 |
| E2E-11 ~ E2E-13 | 消息内容 + LLM回复 + 日志 | 端到端全链路 | ✅ 合理，E2E-11/12 用 LLM 回复内容做断言 |
| E2E-14 ~ E2E-15 | 日志检查 + LLM回复 | Settings 变更隔离 | ✅ 合理 |

**策略结论**：无问题。验证方式与场景匹配，无需 DB 验证（无数据库），L3 仅用于 UI 视觉确认。

---

### 发现的问题

| # | 优先级 | 维度 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|------|---------|
| 1 | **MUST FIX** | 依赖关系 | Section 2 执行顺序 | **E2E-02 → E2E-03 之间缺少 skill 重新启用步骤**。计划建议执行顺序为 E2E-01 → E2E-04 → E2E-02 → E2E-03。E2E-02 禁用所有 skill，E2E-03 前置条件要求"一个 enabled skill 的 sourcePath 为不存在路径"。两者之间需要重新启用 skill 并用 jq 修改 sourcePath，但计划未提供此过渡步骤。 | 方案一（推荐）：调整 Group A 执行顺序为 E2E-01 → E2E-04 → E2E-03 → E2E-02。先在 skill enabled 状态下执行 E2E-03（用 jq 改 sourcePath 为不存在路径），然后再禁用所有 skill 执行 E2E-02。方案二：在 E2E-02 和 E2E-03 之间增加明确的恢复/重配步骤。 |
| 2 | **MUST FIX** | 依赖关系 | Group A → Group B/C/D/E 过渡 | **E2E-03 后缺少 skills.json 恢复步骤**。E2E-03 使用 `jq` 将 xyz-test-skill 的 sourcePath 改为 `/tmp/nonexistent-skill/SKILL.md`。此后 skills.json 处于损坏状态，Groups B-E 均要求"至少一个 enabled skill 且 sourcePath 有效"。计划未提供恢复命令，导致按建议顺序执行后 Groups B-E 全部无法进行。 | 在 E2E-03 验证完成后、进入 Group B 之前，添加环境恢复步骤：`jq 'map(if .name=="xyz-test-skill" then .sourcePath = "/tmp/xyz-test-skill/SKILL.md" else . end)' .xyz-agent/skills.json > /tmp/skills-fixed.json && mv /tmp/skills-fixed.json .xyz-agent/skills.json`，并验证 Settings > Skills 页面 skill 状态恢复正常。 |
| 3 | **MUST FIX** | 步骤可执行性 | Section 4 边界场景 | **边界场景仅有标题映射，缺少可执行操作步骤**。"skill 路径含空格"、"skill 名称含特殊字符"、"多个 enabled skill"、"快速连续选择不同 skill" 四个场景只写了"对应用例 + 额外操作"，但没有具体的操作步骤和期望结果。作为 E2E 执行 agent，无法仅凭标题完成测试。 | 每个边界场景补充：① 具体的准备命令（如创建含空格路径的 skill 目录）② 操作步骤 ③ 期望结果 ④ 验证方式。或者如果这些场景优先级低，明确标注为"可选"并说明理由。 |
| 4 | LOW | 测试环境 | Section 1 | 测试完成后无清理步骤。E2E-03 修改了 skills.json，E2E-14 禁用了 skill，测试结束后环境处于脏状态。 | 在 Section 1 或文末增加"测试清理"步骤：恢复 skills.json、删除 /tmp/xyz-test-skill 目录、关闭应用。 |
| 5 | LOW | 用例质量 | E2E-04 | E2E-04 要求"重启应用"（Cmd+Q 退出 → 重新 npm run dev），这是最重的操作步骤之一。该步骤会影响所有已有 session 的 sidecar 连接，后续测试依赖此重启后的状态。计划未说明重启后应验证哪些环境状态。 | 在 E2E-04 步骤 3-4 之间增加：重启后确认 Vite dev server 正常加载（Electron 窗口无白屏），确认 DevTools Console 无 WS 连接错误。 |
| 6 | LOW | 步骤可执行性 | E2E-13 | E2E-13 的期望结果"消息气泡中显示 skill 名称或标签"较模糊。spec 数据流中发送内容为 `/skill:name user text`，但未定义消息气泡是否有专门的 skill 标签渲染逻辑（vs 纯文本显示）。如果只是纯文本 `/skill:name`，则 E2E-13 与 E2E-11 的验证重复。 | 明确 E2E-13 验证的是：(a) 消息气泡纯文本含 `/skill:name` 前缀（已由 E2E-11 覆盖），还是 (b) 有独立的 skill 标签 UI 元素。如果是 (a)，可合并到 E2E-11；如果是 (b)，需在期望结果中明确该 UI 元素的 DOM 选择器或视觉特征。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

### 结论

**需修改后重审**

### Summary

E2E 测试计划评审完成，第 1 轮，3 条 MUST FIX（依赖顺序错误导致 Group A 内部不可执行、E2E-03 后缺恢复步骤导致后续 Group 全部阻塞、边界场景缺操作步骤），6 条 LOW，结论为需修改后重审。AC 覆盖矩阵显示 10 条验收标准全部有对应用例，覆盖充分，主要问题集中在执行依赖链的完整性上。
