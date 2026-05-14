# E2E 测试计划评审 v3

## 评审记录
- 评审时间：2026-05-14 22:15
- 评审类型：E2E 测试计划独立评审
- 评审对象：e2e-test-plan.md
- 评审轮次：第 3 轮
- 上轮结论：通过（v2，0 条 MUST FIX）

---

## Spec AC 覆盖矩阵

| AC | 场景 | 覆盖状态 | 测试用例 |
|----|------|---------|----------|
| AC1: pi 进程启动时传递所有 enabled skill 的 `--skill` 路径参数 | 正向：有 enabled skill | ✅ | E2E-01 |
| AC1 | 反向：无 enabled skill 不传 | ✅ | E2E-02 |
| AC1 | 边界：sourcePath 不存在被跳过 | ✅ | E2E-03 |
| AC1 | 补充：restoreSession 也传 | ✅ | E2E-04 |
| AC2: SlashMenu 中 skill 命令展示名称、描述和参数提示 | 正向：显示 skill 命令 + 标签 | ✅ | E2E-05 |
| AC2 | 反向：无 enabled skill 仅显示内置命令 | ✅ | E2E-06 |
| AC2 | 键盘导航 | ✅ | E2E-07 |
| AC3: 选择 skill 后输入框预填 `/skill:name ` 文本 | 有 argumentHint 预填 | ⚠️ | E2E-08（标注阻塞，数据源为空） |
| AC3 | 无 argumentHint placeholder 变化 | ✅ | E2E-09 |
| AC3 | 取消标签恢复默认 | ✅ | E2E-10 |
| AC4: 发送 `/skill:name text` 后 pi 正确展开 skill 内容 | 正向：带附加文本 | ✅ | E2E-11 |
| AC4 | 边界：无附加文本 | ✅ | E2E-12 |
| AC4 | 消息气泡显示 skill 标签 | ✅ | E2E-13 |
| AC5: Settings 变更 skill 列表后新 session 用最新列表 | 正向：禁用后新 session 不传 | ✅ | E2E-14 |
| AC5 | 已有活跃 session 不受影响 | ✅ | E2E-15 |
| AC6: 无 enabled skill 时 SlashMenu 仅展示内置命令不报错 | 正向 | ✅ | E2E-06 |

覆盖状态：
- ✅ 完整覆盖（13 条）
- ⚠️ 条件覆盖 — E2E-08，argumentHint 数据源为空（代码中 `argumentHint: undefined` 硬编码），用例已标注阻塞并提供临时硬编码方案，可接受

**覆盖评估**：6 个 AC 全部有对应测试用例，正向/反向/边界覆盖完整。

---

## 四层策略合理性

本项目是 Electron 桌面应用，无 REST API、无数据库。验证层级以日志 + DOM + 视觉为主，与项目架构匹配。

| 用例组 | 验证方式 | 层级映射 | 评估 |
|--------|---------|---------|------|
| Group A (E2E-01~04) | sidecar 日志 / `ps aux` | L1（日志验证） | ✅ 合理，纯后端 spawn 参数 |
| Group B (E2E-05~07) | DevTools DOM + 视觉截图 | L2 + L3 | ✅ 合理，UI 交互 |
| Group C (E2E-08~10) | DevTools DOM + 交互验证 | L2 | ✅ 合理，输入框 UI |
| Group D (E2E-11~13) | 消息内容 + LLM 回复 + 视觉 | L1 + L3 | ✅ 合理，全链路 |
| Group E (E2E-14~15) | sidecar 日志 + LLM 回复 | L1 | ✅ 合理，配置变更 |

Layer 2 的 DOM 检查使用"DevTools Elements 面板手动查看"，而非 skill 规范要求的 CDP Accessibility Tree 查询。但本项目是 Electron 桌面应用，测试方式以人工操作为主（"手动测试为主"已在文档开头声明），手动 DOM 检查在人工测试场景下是合理的降级。

---

## 步骤可执行性抽查

### 抽查 1: §1.3 测试 Skill 准备

```bash
mkdir -p /tmp/xyz-test-skill
cat > /tmp/xyz-test-skill/SKILL.md << 'EOF'
---
name: xyz-test-skill
description: "测试用 skill..."
---
...
EOF
```

**评估**：命令完整可复制执行。SKILL.md 含 `[XYZ-TEST-SKILL-ACTIVE]` 标记，E2E-11/15 可客观验证。

### 抽查 2: E2E-03 `jq` 命令

```bash
jq 'map(if .name=="xyz-test-skill" then .sourcePath = "/tmp/nonexistent-skill/SKILL.md" else . end)' ...
```

**评估**：语法正确，先写临时文件再 mv，安全。

### 抽查 3: E2E-11 完整链路

步骤：输入 `/` → 选中 skill → 输入文本 → Enter 发送 → 检查 LLM 回复含标记。

**评估**：前置条件明确（"创建新 session 确保 pi 启动时加载了 skill"），验证方式有客观标记。

### 抽查 4: E2E-14/E2E-15 衔接

E2E-15 要求"E2E-14 之前已创建一个活跃 session B"。时序要求：session B 需在 Group D 阶段创建且保持活跃。

**评估**：v2 已标注为 LOW #1，本评审认为风险可控。测试执行 agent 可以在 Group D 阶段自然保留一个活跃 session。

---

## 依赖关系检查

### 依赖矩阵

```
Group A: 无前置依赖
Group B: 无前置依赖
Group C: 依赖 Group B
Group D: 依赖 Group A + B + C
Group E: 依赖 Group A + D
```

执行顺序 A → B → C → D → E，无循环依赖。E2E-15 依赖 E2E-14 的状态变更结果，组内顺序正确。

---

## 测试环境检查

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 前端启动方式 | ✅ | `npm run dev`，端口 1420 |
| 前置条件表格 | ✅ | pi 已安装、skill 可用、WS 连接正常 |
| 测试数据准备 | ✅ | SKILL.md + skills.json + 验证命令 |
| 日志查看方式 | ✅ | sidecar 终端 / DevTools / ps aux |
| 清理方式 | LOW | 无专门清理章节（v2 已标注） |

---

## 发现的问题

| # | 优先级 | 维度 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|------|---------|
| 1 | LOW | 步骤可执行性 | E2E-04 | 关闭 session 的方式并列了"右键→关闭"和"点击 tab × 按钮"两种，可能造成执行歧义 | 统一为一种确定的方式，推荐"点击 session tab 上的 × 按钮" |
| 2 | LOW | 测试环境 | 全局 | 无测试完成后清理/回滚步骤。E2E-03 修改了 skills.json，E2E-02/06 禁用了所有 skill，状态变更可能残留 | 在 §5 后增加清理章节：`jq 'map(if .name=="xyz-test-skill" then .sourcePath = "/tmp/xyz-test-skill/SKILL.md" else . end)'` 恢复路径 + 重新启用所有 skill |
| 3 | LOW | 用例质量 | 全局 | 缺少严重程度标注 | 建议：E2E-01/E2E-11/E2E-14 为阻塞，E2E-03/E2E-04/E2E-15 为重要，其余为一般 |
| 4 | LOW | 执行指引 | E2E-14/E2E-15 | E2E-15 要求 session B 在 E2E-14 之前创建，但未在 E2E-14 步骤前明确提醒保留活跃 session | E2E-14 前增加说明："确保有一个 Group D 创建的活跃 session 仍处于打开状态" |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过
> - **LOW**：建议修复，不阻塞

---

## 关于 E2E-08（argumentHint 预填）的专项评估

**当前代码状态**：

- `useSlashCommands.ts:52` — `argumentHint: undefined` 硬编码
- `ChatInput.vue:187-188` — `if (cmd.action.type === 'skill' && cmd.argumentHint)` 预填逻辑已实现
- `SlashMenu.vue:31` — `v-if="cmd.argumentHint"` 显示 hint 标签已实现
- `ChatInput.vue:114` — placeholder 根据是否有 argumentHint 动态切换已实现

**结论**：预填逻辑和 UI 展示的代码已完成，但数据源（argumentHint 的值）恒为 `undefined`。E2E-08 的用例描述已正确标注此状态（"当前版本 argumentHint 数据源为空，此用例标记为阻塞"），并提供了临时硬编码方案（手动修改 `mergeSkillCommands` 中某 skill 的 `argumentHint` 为测试值）。

**评估**：用例处理方式合理，不构成 MUST FIX。测试执行 agent 可以：
1. 临时在 `mergeSkillCommands` 中硬编码 `argumentHint: '描述你要做什么'` 测试预填逻辑
2. 或跳过此用例，标记为"阻塞——依赖 argumentHint 数据源实现"

---

## 结论

**通过**

0 条 MUST FIX。4 条 LOW（v2 遗留），均不阻塞测试执行。

AC 覆盖完整（6 AC / 15 用例），测试数据准备具体可执行，依赖关系无循环。

v2 标注的 4 条 LOW 均未修复，维持原判定（LOW 不阻塞）。E2E-08 的 argumentHint 阻塞标注与代码现状一致，处理方式合理。

---

## Summary

E2E 测试计划评审完成，第 3 轮，0 条 MUST FIX，通过。AC 全覆盖，步骤可执行，E2E-08 argumentHint 阻塞标注与代码现状一致。
