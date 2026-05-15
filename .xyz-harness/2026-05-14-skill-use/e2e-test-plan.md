# E2E 测试计划 — Skill Slash 命令使用

> 手动测试为主，Electron + Vue 3 桌面应用，无自动化 E2E 框架。

## 1. 测试环境配置

### 1.1 启动应用

```bash
cd <project-root>
npm run dev
```

应用启动后 Electron 窗口应加载 `http://localhost:1420`。确认 Vite dev server 正常启动（控制台无端口占用错误）。

### 1.2 前置条件

| 条件 | 说明 | 验证方式 |
|------|------|----------|
| pi 已安装 | `pi --version` 有输出 | 终端执行 |
| pi 配置了有效 API key | 终端执行 `pi` 进入交互模式，发送一条简单消息确认有回复 | 终端执行 |
| 至少一个可用的 skill | 项目 `.xyz-agent/skills.json` 中配置了 enabled skill，且 `sourcePath` 指向的目录存在 SKILL.md | Settings > Skills 页面可见 skill |
| Sidecar WebSocket 连接正常 | DevTools Console 无 WS 连接错误 | Electron 窗口 F12 → Console |

### 1.3 测试用 Skill 准备

创建最小测试 skill：

```bash
mkdir -p /tmp/xyz-test-skill
cat > /tmp/xyz-test-skill/SKILL.md << 'EOF'
---
name: xyz-test-skill
description: "测试用 skill，验证 skill 展开是否生效。回复中必须包含 [XYZ-TEST-SKILL-ACTIVE] 标记。"
argument-hint: "[描述你要测试的内容]"
---

# 测试 Skill

当用户触发此 skill 时，在回复中包含 [XYZ-TEST-SKILL-ACTIVE] 标记。
EOF
```

对应 skills.json 示例（写入项目根目录 `.xyz-agent/skills.json`）：

```json
[{
  "id": "custom-xyz-test-skill",
  "name": "xyz-test-skill",
  "description": "测试用 skill",
  "enabled": true,
  "source": "custom",
  "triggers": [],
  "sourcePath": "/tmp/xyz-test-skill/SKILL.md"
}]
```

验证准备结果：

```bash
# 确认 SKILL.md 存在且含 argument-hint
cat /tmp/xyz-test-skill/SKILL.md
# 确认 skills.json 格式正确
python3 -c "import json; json.load(open('.xyz-agent/skills.json'))"
```

| 用途 | 配置方式 |
|------|----------|
| 正常 skill | 按上述命令创建 `/tmp/xyz-test-skill`，确认 Settings > Skills 页面可见并已启用 |
| 异常 skill | 用 E2E-03 的 `jq` 命令将 sourcePath 改为不存在路径 |
| 空 skill 列表 | Settings > Skills 中禁用所有 skill |

### 1.4 日志查看方式

- **Sidecar 日志**：`npm run dev` 的终端输出，包含 pi spawn args、skill 路径 skip 信息
- **前端 DevTools**：Electron 窗口 F12 → Console，查看 WS 消息
- **pi 进程参数**：终端中 `ps aux | grep pi` 查看 spawn 参数，或在 sidecar 源码 `rpc-client.ts` 的 `start()` 方法中临时加 `console.log('spawn args:', args)`

---

## 2. 用例分组与依赖关系

```
Group A: Skill 路径传递 (后端链路)
  E2E-01 ── E2E-02 ── E2E-03
     └──── E2E-04

Group B: SlashMenu 交互 (前端 UI)
  E2E-05 ── E2E-06
     └──── E2E-07

Group C: 输入框预填 (前端 UI)
  依赖: Group B (SlashMenu 交互正常)
  E2E-08 ── E2E-09 ── E2E-10

Group D: 端到端发送 (全链路)
  依赖: Group A + Group B + Group C 全部通过
  E2E-11 ── E2E-12 ── E2E-13

Group E: Settings 变更验证 (AC5)
  依赖: Group A + Group D
  E2E-14
  E2E-15
```

执行顺序建议：A（内部 E2E-01 → E2E-04 → E2E-03 → 恢复 → E2E-02）→ B → C → D → E

> **注意**：Group A 内部执行顺序严格按上述顺序。E2E-03 破坏 sourcePath 后必须在进入 Group B 之前执行恢复步骤。E2E-02（禁用所有 skill）放在最后，因为后续 Group B-E 都需要有效的 skill 配置。

---

## 3. 测试用例

### Group A: Skill 路径传递（Task 1+4）

#### E2E-01: 有 enabled skill 时 pi 进程收到 --skill 参数

| 项目 | 内容 |
|------|------|
| **测试目标** | 确认 pi 进程 spawn 时 args 中包含 `--skill <path>` |
| **前置条件** | 至少一个 skill 已 enabled，其 sourcePath 目录存在 |
| **操作步骤** | 1. 确认 Settings > Skills 中有 enabled skill<br>2. 创建新 session（点击 + 按钮）<br>3. 查看 sidecar 终端日志 |
| **期望结果** | pi spawn 参数中包含 `--skill` 及对应 skill 目录路径（`dirname(sourcePath)`） |
| **验证方式** | **日志检查**：sidecar 终端输出或 `ps aux \| grep "pi.*--skill"`，确认 args 数组中含 `['--skill', '/path/to/skill/dir']` |

#### E2E-02: 无 enabled skill 时不传 --skill

| 项目 | 内容 |
|------|------|
| **测试目标** | 所有 skill 禁用时 pi spawn args 不含 `--skill` |
| **前置条件** | 所有 skill 已 disabled，或 `.xyz-agent/skills.json` 为空 |
| **操作步骤** | 1. Settings > Skills 禁用所有 skill<br>2. 创建新 session<br>3. 查看 sidecar 终端日志 |
| **期望结果** | pi spawn 参数中**不含** `--skill` |
| **验证方式** | **日志检查**：sidecar 终端或 `ps aux \| grep pi`，确认无 `--skill` 字样 |

#### E2E-03: sourcePath 不存在的 skill 被跳过

| 项目 | 内容 |
|------|------|
| **测试目标** | sourcePath 指向不存在路径的 skill 不阻塞 pi 进程启动 |
| **前置条件** | 一个 enabled skill 的 sourcePath 为不存在路径（如 `/tmp/nonexistent-skill/SKILL.md`）|
| **操作步骤** | 1. 执行以下命令将 xyz-test-skill 的 sourcePath 改为不存在路径：<br>`jq 'map(if .name==\"xyz-test-skill\" then .sourcePath = \"/tmp/nonexistent-skill/SKILL.md\" else . end)' .xyz-agent/skills.json > /tmp/skills-fixed.json && mv /tmp/skills-fixed.json .xyz-agent/skills.json`<br>2. 创建新 session<br>3. 查看 sidecar 终端日志 |
| **期望结果** | 1. 应用**不崩溃**<br>2. 不存在的 skill 被跳过，pi 正常启动<br>3. 存在的 skill 路径仍被传递 |
| **验证方式** | **日志检查**：sidecar 日志无报错；`ps aux` 确认 pi 进程存活，args 中仅有存在路径的 `--skill` |
| **恢复步骤** | E2E-03 验证完成后，**必须**执行以下命令恢复 skills.json：

```bash
# 恢复 sourcePath
jq 'map(if .name=="xyz-test-skill" then .sourcePath = "/tmp/xyz-test-skill/SKILL.md" else . end)' .xyz-agent/skills.json > /tmp/skills-fixed.json && mv /tmp/skills-fixed.json .xyz-agent/skills.json
# 验证恢复
cat .xyz-agent/skills.json | python3 -c "import json,sys; skills=json.load(sys.stdin); print('sourcePath:', skills[0]['sourcePath'])"
```

恢复后确认 Settings > Skills 页面 skill 状态正常，再继续执行 E2E-02 及后续 Group。 |

#### E2E-04: restoreSession 也传递 skill 路径

| 项目 | 内容 |
|------|------|
| **测试目标** | 恢复非活跃 session 时启动的 pi 进程同样传递 `--skill` 参数 |
| **前置条件** | 有 enabled skill，存在一个非活跃（已关闭）的 session |
| **操作步骤** | 1. 创建 session A，发送一条消息确认正常<br>2. 在左侧 sidebar 右键 session A → 关闭（或点击 session tab 上的 × 按钮）关闭 session A<br>3. 重启应用：Cmd+Q 退出 Electron，然后重新 `npm run dev` 启动<br>4. 在左侧 sidebar 的 session 历史列表中找到 session A 并点击<br>5. 查看 sidecar 终端日志 |
| **期望结果** | 恢复 session A 时 pi spawn 参数中包含 `--skill` 路径 |
| **验证方式** | **日志检查**：sidecar 日志显示 restoreSession 调用时 pi spawn args 含 `--skill`；恢复后发送 `/skill:name` 可正常展开 |

---

### Group B: SlashMenu 交互（Task 2）

#### E2E-05: 输入 / 后弹出 SlashMenu，显示 skill 命令

| 项目 | 内容 |
|------|------|
| **测试目标** | 输入 `/` 后 SlashMenu 弹出，skill 命令和内置命令同时显示，skill 命令展示参数提示 |
| **前置条件** | 至少一个 skill 已 enabled |
| **操作步骤** | 1. 聚焦聊天输入框<br>2. 输入 `/` 字符 |
| **期望结果** | 1. SlashMenu 弹出<br>2. 列表中同时显示内置命令（如 `/help`、`/compact`）和 skill 命令<br>3. skill 命令右侧有 `skill` 标签（vs 内置命令的 `command` 标签）<br>4. 有 `argumentHint` 的 skill 在命令项中显示参数提示文本 |
| **验证方式** | **DOM 检查**：F12 DevTools → Elements，检查 SlashMenu 内 `.command-item` 元素：<br>- 含 `skill` 标签（非 `command`）<br>- argumentHint 元素可见（如有）<br>**视觉对比**：截图确认 skill/command 标签颜色区分 |

#### E2E-06: 无 enabled skill 时只显示内置命令

| 项目 | 内容 |
|------|------|
| **测试目标** | 所有 skill 禁用时 SlashMenu 仅显示内置命令，不报错 |
| **前置条件** | 所有 skill 已 disabled |
| **操作步骤** | 1. 禁用所有 skill<br>2. 聚焦聊天输入框<br>3. 输入 `/` |
| **期望结果** | SlashMenu 正常弹出，列表中**仅有**内置命令（`/help`、`/compact` 等），无 skill 命令，无错误提示 |
| **验证方式** | **DOM 检查**：SlashMenu 内无 `skill` 标签的命令项<br>**日志检查**：DevTools Console 无报错 |

#### E2E-07: 键盘导航（上下箭头、Enter 选择）

| 项目 | 内容 |
|------|------|
| **测试目标** | SlashMenu 打开后支持键盘上下选择和 Enter 确认 |
| **前置条件** | 至少一个 skill 和一个内置命令存在 |
| **操作步骤** | 1. 输入 `/` 打开 SlashMenu<br>2. 按 `↓` 箭头键，高亮移到下一项<br>3. 按 `↑` 箭头键，高亮移回上一项<br>4. 按 `Enter` 选中当前高亮的 skill 命令 |
| **期望结果** | 1. `↓`/`↑` 正确移动高亮项<br>2. `Enter` 后 SlashMenu 关闭，输入框显示 skill 标签（`/skill:name`）<br>3. Escape 关闭 SlashMenu 不选择 |
| **验证方式** | **视觉对比**：高亮项有视觉反馈（背景色变化）<br>**DOM 检查**：选中后 ChatInput 内出现 skill 标签元素 |

---

### Group C: 输入框预填（Task 3）

#### E2E-08: 选中有 argumentHint 的 skill 后 textarea 预填参数文本

| 项目 | 内容 |
|------|------|
| **测试目标** | 选中带 argumentHint 的 skill 后，输入框 textarea 中预填 hint 文本 |
| **前置条件** | 一个 skill 的 SKILL.md frontmatter 中声明了 `argument-hint` 字段（如 `argument-hint: "[描述你要做什么]"`），且该 skill 已 enabled |
| **操作步骤** | 1. 确认测试 skill 的 SKILL.md frontmatter 含 `argument-hint: "[描述你要做什么]"`<br>2. 在 Settings > Skills 页面执行 scan 或重启应用，确保 argumentHint 被加载<br>3. 输入 `/`，选中该 skill<br>4. 观察 textarea 内容 |
| **期望结果** | textarea 中出现预填的 argumentHint 文本（如 `描述你要做什么`），用户可直接编辑或删除 |
| **验证方式** | **DOM 检查**：textarea 的 value 属性含预填文本<br>**交互验证**：预填文本可被用户输入覆盖 |

#### E2E-09: 选中无 argumentHint 的 skill 后 placeholder 动态变化

| 项目 | 内容 |
|------|------|
| **测试目标** | 选中无 argumentHint 的 skill 后，textarea placeholder 显示 skill 相关提示，textarea 文本为空 |
| **前置条件** | 一个 enabled skill 的 argumentHint 为 undefined |
| **操作步骤** | 1. 输入 `/`，选中该 skill（无 argumentHint）<br>2. 观察 textarea 的 placeholder 和文本内容 |
| **期望结果** | 1. textarea 文本为空<br>2. placeholder 显示 `输入附加文本…`（无 argumentHint 时 ChatInput 的 skill 模式默认提示） |
| **验证方式** | **DOM 检查**：textarea 的 value 为空，placeholder 属性值不为默认的"Type a message..." |

#### E2E-10: 取消 skill 标签后恢复默认状态

| 项目 | 内容 |
|------|------|
| **测试目标** | 点击 skill 标签的关闭按钮后，输入框恢复默认状态 |
| **前置条件** | 已选中一个 skill，标签栏显示 `/skill:name` |
| **操作步骤** | 1. 选中一个 skill，标签栏可见<br>2. 点击标签上的关闭按钮（×） |
| **期望结果** | 1. skill 标签消失<br>2. textarea 文本清空<br>3. placeholder 恢复为默认值<br>4. activeCommand 被重置 |
| **验证方式** | **DOM 检查**：标签区域不可见（`v-if="activeCommand"` 为 false）；textarea placeholder 为默认值 |

---

### Group D: 端到端发送（全链路）

> **前置条件**：Group A + B + C 全部通过。以下用例需要完整的 skill 导入 → 创建 session → 发送链路。

#### E2E-11: 选择 skill → 输入文本 → 发送 → pi 正确展开 skill

| 项目 | 内容 |
|------|------|
| **测试目标** | 完整链路：选 skill → 输入附加文本 → 发送 → pi 展开并注入 SKILL.md → LLM 回复体现 skill 上下文 |
| **前置条件** | 1. 一个 enabled skill，其 sourcePath 指向有效的 SKILL.md<br>2. 创建新 session（确保 pi 启动时加载了 skill） |
| **操作步骤** | 1. 在新 session 中输入 `/`<br>2. 从 SlashMenu 选中目标 skill<br>3. 在 textarea 中输入附加文本（如 `帮我分析这段代码`）<br>4. 按 Enter 发送 |
| **期望结果** | 1. 发送的消息内容为 `/skill:name 帮我分析这段代码`<br>2. pi 收到后 `_expandSkillCommand()` 展开 SKILL.md 内容注入上下文<br>3. LLM 的回复体现了该 skill 的指令内容（如按 skill 定义的格式、风格回复） |
| **验证方式** | **消息内容**：消息气泡文本显示 `/skill:name` 前缀<br>**LLM 回复**：回复内容体现 skill 上下文（需要人工判断）<br>**sidecar 日志**：无错误 |

#### E2E-12: 不输入文本直接发送 skill 命令（仅 /skill:name）

| 项目 | 内容 |
|------|------|
| **测试目标** | 选中 skill 后不输入附加文本，直接发送纯 `/skill:name` 命令 |
| **前置条件** | 同 E2E-11 |
| **操作步骤** | 1. 输入 `/` 选中 skill<br>2. 不输入任何附加文本<br>3. 直接按 Enter 发送 |
| **期望结果** | 1. 发送的消息内容为 `/skill:name`（无附加文本）<br>2. pi 正确展开 skill<br>3. LLM 按 skill 默认行为回复 |
| **验证方式** | **消息气泡**：显示纯 `/skill:name`<br>**LLM 回复**：正常生成，体现 skill 上下文 |

#### E2E-13: 消息气泡显示 skill 标签

| 项目 | 内容 |
|------|------|
| **测试目标** | 发送 skill 命令后，消息气泡中可见 skill 名称标签 |
| **前置条件** | 同 E2E-11 |
| **操作步骤** | 1. 选中 skill 并发送消息（同 E2E-11 步骤）<br>2. 观察消息气泡 |
| **期望结果** | 消息气泡中显示 skill 名称或标签，与其他普通消息视觉区分 |
| **验证方式** | **视觉对比**：截图确认消息气泡含 skill 标识<br>**DOM 检查**：消息元素含 skill 相关属性或子元素 |

---

### Group E: Settings 变更验证（AC5）

> **前置条件**：Group A 和 Group D 全部通过。验证 Settings 变更 skill 配置后新/旧 session 的行为隔离。

#### E2E-14: 禁用 skill 后创建新 session 不传递被禁用 skill 路径

| 项目 | 内容 |
|------|------|
| **测试目标** | Settings 禁用 skill 后，新创建的 session 启动的 pi 进程不传递被禁用 skill 的 `--skill` 路径 |
| **前置条件** | 1. xyz-test-skill 已 enabled 且 sourcePath 有效<br>2. 已有至少一个 session 使用了该 skill（Group D 验证通过） |
| **操作步骤** | 1. 进入 Settings > Skills 页面<br>2. 将 xyz-test-skill 的开关设为禁用（enabled = false）<br>3. 返回聊天页面，点击 + 创建新 session<br>4. 查看 sidecar 终端日志 |
| **期望结果** | 1. pi spawn 参数中**不含** xyz-test-skill 的 `--skill` 路径<br>2. 应用无报错，pi 正常启动 |
| **验证方式** | **日志检查**：sidecar 终端输出中 pi spawn args 不含 `/tmp/xyz-test-skill` |
| **恢复步骤** | E2E-02 验证完成后，**必须**重新启用所有 skill 才能继续后续 Group。进入 Settings > Skills 页面将 xyz-test-skill 重新启用，或执行：

```bash
# 恢复 skill 启用状态
jq 'map(if .name=="xyz-test-skill" then .enabled = true else . end)' .xyz-agent/skills.json > /tmp/skills-fixed.json && mv /tmp/skills-fixed.json .xyz-agent/skills.json
# 验证恢复
cat .xyz-agent/skills.json | python3 -c "import json,sys; skills=json.load(sys.stdin); print('enabled:', skills[0]['enabled'])"
```

恢复后确认 Settings > Skills 页面 skill 状态为已启用，再继续 Group B。 |

#### E2E-15: 禁用 skill 后已有活跃 session 发送 /skill:name 仍正常

| 项目 | 内容 |
|------|------|
| **前置条件** | 1. 在 E2E-14 之前已创建一个活跃 session（session B），该 session 启动时 xyz-test-skill 仍为 enabled<br>2. E2E-14 已执行（xyz-test-skill 已被禁用） |
| **操作步骤** | 1. 切换到 session B（E2E-14 之前创建的活跃 session）<br>2. 输入 `/xyz-test-skill` 并发送消息<br>3. 等待 LLM 回复 |
| **期望结果** | 1. `/xyz-test-skill` 命令正常展开（pi 不报错）<br>2. LLM 回复包含 `[XYZ-TEST-SKILL-ACTIVE]` 标记，证明 skill 上下文仍被注入 |
| **验证方式** | **消息内容**：LLM 回复中包含 `[XYZ-TEST-SKILL-ACTIVE]` 字符串<br>**sidecar 日志**：无 skill 展开相关错误 |

---

## 4. 边界与回归场景

> 以下场景为**可选**扩展验证，优先级低于 E2E-01 ~ E2E-15。时间充裕时执行。

### 边界-1: skill 路径含空格

| 项目 | 内容 |
|------|------|
| **测试目标** | skill 目录名含空格时，pi spawn args 正确处理路径 |
| **准备** | `mkdir -p "/tmp/xyz test skill" && cp /tmp/xyz-test-skill/SKILL.md "/tmp/xyz test skill/SKILL.md"`<br>在 skills.json 中临时添加一个 sourcePath 指向 `/tmp/xyz test skill/SKILL.md` 的 skill |
| **操作** | 创建新 session → 查看 sidecar 日志中 pi spawn args |
| **期望** | args 中包含 `--skill /tmp/xyz test skill`（路径含空格但 spawn 正确） |
| **验证** | sidecar 日志 / `ps aux \| grep pi` |
| **清理** | 恢复 skills.json、删除 `/tmp/xyz test skill` |

### 边界-2: skill 名称含特殊字符

| 项目 | 内容 |
|------|------|
| **测试目标** | skill name 含 `-` 或 `_` 时 SlashMenu 显示和发送命令正确 |
| **准备** | 在 `/tmp/xyz-test-skill/SKILL.md` frontmatter 中将 name 改为 `my-test_skill`，Settings > Skills 重新 scan |
| **操作** | 输入 `/` → SlashMenu 中找到 `my-test_skill` → 选中 → 发送消息 |
| **期望** | SlashMenu 正确显示名称；发送内容为 `/skill:my-test_skill ...`；pi 正确展开 |
| **验证** | SlashMenu DOM + 消息气泡文本 + LLM 回复含 `[XYZ-TEST-SKILL-ACTIVE]` |
| **清理** | 恢复 SKILL.md name 为 `xyz-test-skill` |

### 边界-3: 多个 enabled skill

| 项目 | 内容 |
|------|------|
| **准备** | 创建第二个 skill 目录 `/tmp/xyz-test-skill-2/SKILL.md`，在 skills.json 中添加并启用 |
| **操作** | 创建新 session → 查看 sidecar 日志 |
| **期望** | pi spawn args 包含两个 `--skill` 参数（两个 skill 的目录路径） |
| **验证** | `ps aux \| grep pi` 确认 args 含两个 `--skill` |
| **清理** | 从 skills.json 移除第二个 skill，删除 `/tmp/xyz-test-skill-2` |

### 边界-4: 快速连续选择不同 skill

| 项目 | 内容 |
|------|------|
| **前置条件** | 至少两个 enabled skill（可用边界-3 准备的第二个 skill） |
| **操作** | 1. 输入 `/` → 选中 skill A → 输入框显示 skill A 标签<br>2. 点击标签 × 取消<br>3. 输入 `/` → 选中 skill B → 输入附加文本<br>4. 发送 |
| **期望** | 消息内容为 `/skill:B-name 附加文本`（不含 skill A 残留） |
| **验证** | 消息气泡文本 |

---

## 5. 测试结果记录模板

| 用例 ID | 结果 | 测试人 | 日期 | 备注 |
|---------|------|--------|------|------|
| E2E-01 | ⬜ | | | |
| E2E-02 | ⬜ | | | |
| E2E-03 | ⬜ | | | |
| E2E-04 | ⬜ | | | |
| E2E-05 | ⬜ | | | |
| E2E-06 | ⬜ | | | |
| E2E-07 | ⬜ | | | |
| E2E-08 | ⬜ | | | |
| E2E-09 | ⬜ | | | |
| E2E-10 | ⬜ | | | |
| E2E-11 | ⬜ | | | |
| E2E-12 | ⬜ | | | |
| E2E-13 | ⬜ | | | |
| E2E-14 | ⬜ | | | |
| E2E-15 | ⬜ | | | |
