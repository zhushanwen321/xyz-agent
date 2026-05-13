# G4: Agent Tab E2E 测试报告

**执行时间**: 2026-05-13 13:09 ~ 13:35
**执行环境**: Sidecar WS ws://localhost:3210, Electron CDP :9333, Vite :1420
**测试用例文件**: `.xyz-harness/2026-05-12-settings-redesign/e2e-tests/g4-agent.md`

---

## 汇总

| 用例 | 结果 | 说明 |
|------|------|------|
| TC-4-01 Agent 扫描源 Chips | **PASS** | 3 chips 渲染，Pi Agents 默认 active |
| TC-4-02 Agent 扫描执行 | **FAIL** | WS 协议正常，但扫描结果为空（symlink bug） |
| TC-4-03 Agent 导入 | **PASS** | WS/DOM/文件三层验证均通过 |
| TC-4-04 Agent Toggle | **PASS** | toggle 切换正常，opacity-60 样式生效 |
| TC-4-05 Agent 删除 confirm-bar | **PASS** | confirm-bar 出现/取消/确认删除全流程通过 |
| TC-4-06 Agent 策略切换 | **PASS** | select 切换正常，agents.json 同步更新 |

**结果: 5 passed, 1 failed, 0 skipped**

---

## 详细结果

### TC-4-01: Agent 扫描源 Chips — PASS

**测试目标**: 3 个 source chips 渲染，Pi 默认 active。

**验证层级**:
- **L2 DOM**: 通过 `document.querySelectorAll('div.border.rounded-md.cursor-pointer')` 找到 6 个 chip（Skill 区域 3 个 + Agent 区域 3 个）
- Agent 区域 3 个 chip: Pi Agents, Claude Code, Agents
- Pi Agents chip 的 borderColor 为 `oklch(0.22 0.04 195)`（有色彩），其余为 `oklch(0.16 0.008 75)`（灰色），说明 Pi Agents 处于选中状态
- **注意**: AX Tree (Accessibility) 未识别到这些 chip 元素（role 未设置），但 DOM 验证通过

**截图**: `evidence/tc-401_agent-scan.png`

---

### TC-4-02: Agent 扫描执行 — FAIL

**测试目标**: WS config.scanAgents → config.scannedAgents，结果列表渲染。

**验证层级**:
- **L1 WS 协议**: `config.scanAgents` 命令发出，收到 `config.scannedAgents` 响应，`success: true`，但 `agents count: 0` — **协议正常，但结果为空**
- **L2 DOM**: 扫描后无 checkbox 出现（因为 0 个结果）
- **根因**: `agent-scanner.ts` 中 `readdirSync(dir, { withFileTypes: true })` 返回的 Dirent 对象调用 `entry.isDirectory()` 对 symlink 返回 `false`。所有 agent 目录都是 symlink（`~/.pi/agent/agents/batch-code-tracer -> /actual/path/`），因此全部被过滤掉。需要改用 `statSync(join(dir, entry.name)).isDirectory()` 或 `lstatSync` + `statSync` 组合来判断。

**Bug 详情**:
- 文件: `src-electron/sidecar/src/agent-scanner.ts` 第 39 行
- 当前代码: `if (!entry.isDirectory()) continue`
- 修复建议: `if (!statSync(join(source, entry.name)).isDirectory()) continue`

**截图**: `evidence/tc-402_after-agent-scan.png`

---

### TC-4-03: Agent 导入 — PASS

**测试目标**: WS config.setAgent，DOM section 出现，agents.json 持久化。

**验证层级**:
- **L1 WS**: 发送 `config.setAgent` 导入 2 个 agent，收到 `config.agentUpdated` (success:true) + `config.agents` (count:2) — PASS
- **L2 DOM**: `document.querySelectorAll('.border.rounded-lg.mb-3')` 中出现 `test-agent` 和 `test-agent-2` section — PASS
- **L4 文件**: `src-electron/.xyz-agent/agents.json` 存在，包含 2 条记录 — PASS

**注意**: 实际 agents.json 路径为 `src-electron/.xyz-agent/agents.json`，而非项目根目录下的 `.xyz-agent/agents.json`。

**截图**: `evidence/tc-403_agents-imported.png`

---

### TC-4-04: Agent Toggle — PASS

**测试目标**: toggle 切换 agent 启停，opacity 变化。

**验证层级**:
- **L2 DOM**: 
  - Toggle switch (`[role="switch"]`) 点击后 `aria-checked` 从 `"true"` → `"false"` — PASS
  - Section 获得 `opacity-60` CSS 类，`getComputedStyle().opacity` 返回 `"0.6"` — PASS
  - 恢复 toggle 后 opacity 恢复正常 — PASS

---

### TC-4-05: Agent 删除 confirm-bar — PASS

**测试目标**: 删除 → 红色 confirm-bar → 取消 → bar 消失 → 确认删除 → section 移除。

**验证层级**:
- **L2 DOM**:
  - 点击"删除"按钮后，confirm bar 出现，内容："确认删除 test-agent-2？此操作不可撤销。" + "确认删除" + "取消" 按钮 — PASS
  - confirm bar 样式: `bg-[var(--danger-light)] text-xs text-[var(--danger)]`（红色/危险色） — PASS
  - 点击"取消"后 section 保留（6 个 section 不变） — PASS
  - 再次删除并点击"确认删除"后 section 从 6 减至 5（test-agent-2 被移除） — PASS
- **L4 文件**: agents.json 从 2 条变为 1 条 — PASS

**注意**: 截图因 CDP 数据量大（PNG ~150KB）偶发超时，未能保存 confirm-bar 截图。confirm bar 的存在通过 DOM 查询验证确认。

---

### TC-4-06: Agent 策略切换 — PASS

**测试目标**: 切换模型策略 select，agents.json 更新。

**验证层级**:
- **L2 DOM**: 
  - 策略 select 选项为 `auto, tag, bind` — 确认
  - 切换 select value 从 `auto` → `tag` 后，DOM 中 select.value 确认变为 `tag` — PASS
  - 恢复为 `auto` 成功 — PASS
- **L4 文件**: agents.json 中 `test-agent` 的 `modelStrategy` 从 `"auto"` 变为 `"tag"`，确认更新持久化 — PASS

---

## 发现的 Bug

### BUG-1: Agent 扫描器无法识别 symlink 目录（阻塞级）

- **文件**: `src-electron/sidecar/src/agent-scanner.ts`
- **行号**: 第 39 行 `if (!entry.isDirectory()) continue`
- **影响**: 所有通过 symlink 安装的 agent 都无法被扫描发现
- **原因**: Node.js `fs.readdirSync` 的 `withFileTypes: true` 选项返回的 `Dirent.isDirectory()` 对 symlink 返回 `false`
- **修复**: 使用 `statSync(join(source, entry.name)).isDirectory()` 替代 `entry.isDirectory()`
- **验证**: 测试确认 `statSync(path).isDirectory()` 对 symlink 目录返回 `true`，而 `entry.isDirectory()` 返回 `false`

### NOTE-1: agents.json 实际路径

- 测试文件假设路径: `.xyz-agent/agents.json`（项目根目录）
- 实际路径: `src-electron/.xyz-agent/agents.json`
- 原因: sidecar 运行在 `src-electron/` 目录下，相对路径基于 `process.cwd()`

### NOTE-2: AX Tree 未覆盖 Agent Chips

- TC-4-01 的 AX Tree 验证失败，扫描源 chip 元素没有设置 ARIA role
- DOM 直接查询验证通过，但可访问性需要改进
