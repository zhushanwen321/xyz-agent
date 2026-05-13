# Group 3: Agent 扫描与 CRUD — E2E 测试用例

> **测试范围**：Agents tab 的扫描源选择、扫描执行、导入、toggle 启停、删除 confirm-bar、策略切换全流程。
> **前置依赖**：Group 0（基础连通性）全部通过。
> **环境要求**：Sidecar 端口 3210、Electron debugging 端口 9222。

---

## 环境信息

| 项目 | 值 |
|------|-----|
| Sidecar 端口 | 3210 |
| Electron DevTools 端口 | 9222 |
| Agent 扫描源（Pi） | `~/.pi/agent/agents/` |
| Agent 扫描源（Claude） | `~/.claude/agents/` |
| Agent 扫描源（Agents） | `~/.agents/agents/` |
| 持久化文件 | `.xyz-agent/agents.json` |
| 项目根目录 | `/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider` |

---

## 测试用例

---

### TC-3.1: Agent 扫描源 Chips 交互

| 字段 | 内容 |
|------|------|
| **ID** | TC-3.1 |
| **目标** | 确认 Agents tab 包含 Pi / Claude / Agents 三个 source chips，且 Pi 默认选中 |
| **前置条件** | Group 0 全部通过；应用已启动并显示 Settings 页面 |
| **依赖** | TC-0.1 ~ TC-0.6 |

**测试步骤**：

1. 点击 Settings 左侧导航的 **Agents** tab，切换到 Agent 配置视图
2. 通过 CDP 执行 DOM 查询，检查扫描源区域：

```bash
# CDP: 获取 Agents 面板中的 source chips
# 每个 source chip 的结构: div.border.rounded-md 内含 icon span + label
```

```javascript
// CDP 执行
const chips = document.querySelectorAll('.section .flex.flex-wrap.gap-2 > div[class*="rounded-md"]');
const chipLabels = Array.from(chips).map(chip => {
  const label = chip.querySelector('.font-medium')?.textContent?.trim();
  const isActive = chip.classList.contains('border-[var(--accent)]')
    || chip.className.includes('accent');
  return { label, isActive };
});
console.log(JSON.stringify(chipLabels, null, 2));
```

3. 目视确认三个 chip 的图标字母：
   - Pi: 图标显示 **P**
   - Claude: 图标显示 **C**
   - Agents: 图标显示 **A**

**期望结果**：

| 检查项 | 期望 |
|--------|------|
| Source chip 数量 | 等于 3 |
| Pi chip 标签 | "Pi Agents" |
| Claude chip 标签 | "Claude Code" |
| Agents chip 标签 | "Agents" |
| Pi chip 状态 | **Active**（边框 `var(--accent)`，背景 `var(--accent-light)`） |
| Claude chip 状态 | Inactive |
| Agents chip 状态 | Inactive |
| Pi chip 默认路径文本 | `~/.pi/agent/agents/` |

**衡量方法**：

- DOM 查询：source chip 数量 `=== 3`
- DOM 查询：Pi chip 的 `className` 包含 `accent` 关键字
- 截图对比：source chips 区域视觉一致

**结果记录**：

| 检查项 | 结果 | 备注 |
|--------|------|------|
| Source chip 数量 = 3 | ⬜ Pass / ⬜ Fail | |
| 标签文本正确 | ⬜ Pass / ⬜ Fail | |
| Pi 默认 active | ⬜ Pass / ⬜ Fail | |
| Claude/Agents inactive | ⬜ Pass / ⬜ Fail | |

---

### TC-3.2: Agent 扫描执行

| 字段 | 内容 |
|------|------|
| **ID** | TC-3.2 |
| **目标** | 选中 Pi source chip 后点击扫描按钮，验证 WS 发送 `config.scanAgents` 消息，收到 `config.scannedAgents` 响应，结果渲染到 DOM |
| **前置条件** | TC-3.1 通过；`~/.pi/agent/agents/` 目录下至少存在一个 agent 定义文件 |
| **依赖** | TC-3.1 |

**测试步骤**：

1. **确认扫描源目录有数据**：

```bash
ls -la ~/.pi/agent/agents/ 2>/dev/null
# 应至少有一个 .md 文件或目录
# 如果目录为空或不存在，创建一个测试 agent:
mkdir -p ~/.pi/agent/agents/
cat > ~/.pi/agent/agents/test-agent.md << 'EOF'
---
name: Test Agent
description: A test agent for E2E testing
triggers:
  - test
---

You are a test agent.
EOF
```

2. **连接 WS 监听消息**（在另一个终端或通过 Node.js 脚本）：

```javascript
// tools/ws-spy.mjs — 监听 sidecar WS 消息
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
const messages = [];

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  messages.push(msg);
  if (msg.type === 'config.scannedAgents') {
    console.log('=== 扫描结果 ===');
    console.log('type:', msg.type);
    console.log('agents count:', msg.payload.agents?.length);
    console.log('agents:', JSON.stringify(msg.payload.agents?.map(a => ({
      id: a.id, name: a.name, sourceType: a.sourceType
    })), null, 2));
  }
});

ws.on('open', () => console.log('WS 已连接，等待消息...'));
setTimeout(() => { ws.close(); process.exit(0); }, 30000);
```

3. **在 UI 中操作**：
   - 确认 Pi source chip 已选中（active 状态）
   - 点击 **扫描** 按钮（"扫描" 文本的 outline 按钮）

4. **验证 WS 出站消息**（前端 → Sidecar）：

```json
{
  "type": "config.scanAgents",
  "payload": {
    "sources": ["~/.pi/agent/agents/"]
  }
}
```

5. **验证 WS 入站消息**（Sidecar → 前端）：

```json
{
  "type": "config.scannedAgents",
  "payload": {
    "agents": [
      {
        "id": "<agent-id>",
        "name": "Test Agent",
        "description": "A test agent for E2E testing",
        "sourceType": "pi",
        "sourcePath": "~/.pi/agent/agents/test-agent.md",
        "alreadyImported": false
      }
    ],
    "success": true
  }
}
```

6. **验证 DOM 渲染**：

```javascript
// CDP 执行: 检查扫描结果列表
const results = document.querySelectorAll('.section .border-t .flex.items-center.gap-2\\.5');
console.log('扫描结果数量:', results.length);
// 每个结果项应包含 agent 名称
results.forEach((el, i) => {
  const name = el.querySelector('.font-semibold')?.textContent?.trim();
  console.log(`[${i}] name: ${name}`);
});
```

**期望结果**：

| 检查项 | 期望 |
|--------|------|
| WS 出站 `config.scanAgents` | `sources` 包含 `~/.pi/agent/agents/` |
| WS 入站 `config.scannedAgents` | `success: true`，`agents` 数组长度 >= 1 |
| 扫描按钮状态 | 扫描中时显示 loading spinner + "扫描中…" |
| DOM 扫描结果 | 每条结果显示名称、描述、来源类型标签 |
| 已导入标记 | 未导入的 agent 无 "已导入" badge |
| 底部操作栏 | 出现 "导入选中" 按钮，初始 disabled |

**衡量方法**：

- WS 消息抓取：出站消息 `type === 'config.scanAgents'`
- WS 消息抓取：入站消息 `type === 'config.scannedAgents'` 且 `payload.success === true`
- DOM 查询：扫描结果列表项数量 > 0
- 截图：扫描结果区域

**结果记录**：

| 检查项 | 结果 | 备注 |
|--------|------|------|
| WS 出站 config.scanAgents | ⬜ Pass / ⬜ Fail | |
| WS 入站 config.scannedAgents | ⬜ Pass / ⬜ Fail | |
| 扫描中 loading 状态 | ⬜ Pass / ⬜ Fail | |
| DOM 扫描结果渲染 | ⬜ Pass / ⬜ Fail | |
| "导入选中" 按钮出现 | ⬜ Pass / ⬜ Fail | |

---

### TC-3.3: Agent 导入选中项

| 字段 | 内容 |
|------|------|
| **ID** | TC-3.3 |
| **目标** | 勾选扫描结果中的 agent，点击 "导入选中"，验证 WS 发送 `config.setAgent`，agent 出现在列表中，持久化到 `.xyz-agent/agents.json` |
| **前置条件** | TC-3.2 通过，扫描结果中至少有一条可导入的 agent |
| **依赖** | TC-3.2 |

**测试步骤**：

1. **勾选扫描结果中的 agent**：

```javascript
// CDP 执行: 找到第一个可导入的 agent 并点击其 checkbox
const checkboxes = document.querySelectorAll('.section .w-4.h-4.rounded-\\[3px\\]');
for (const cb of checkboxes) {
  // 跳过已导入的（opacity-40）
  const row = cb.closest('.flex.items-center');
  if (!row?.classList.contains('opacity-40')) {
    cb.click();
    console.log('已点击 checkbox');
    break;
  }
}
```

2. **验证 checkbox 选中状态**：

```javascript
// CDP 执行: 确认 checkbox 变为选中样式（bg-[var(--accent)]）
const checkedBox = document.querySelector('.bg-\\[var\\(--accent\\)\\].rounded-\\[3px\\]');
console.log('选中状态:', !!checkedBox);
```

3. **验证底部操作栏更新**：

```javascript
// CDP 执行: 检查已选计数
const countText = document.querySelector('.text-\\[11px\\].text-muted')?.textContent;
console.log('计数文本:', countText);
// 期望: "已选 1 个"
```

4. **点击 "导入选中" 按钮**：

```javascript
// CDP 执行
const importBtn = Array.from(document.querySelectorAll('button')).find(
  b => b.textContent?.includes('导入选中')
);
importBtn?.click();
```

5. **验证 WS 出站消息**（前端 → Sidecar）：

```json
{
  "type": "config.setAgent",
  "payload": {
    "agent": {
      "id": "<agent-id>",
      "name": "Test Agent",
      "description": "A test agent for E2E testing",
      "enabled": true,
      "modelStrategy": "auto",
      "source": "pi",
      "sourceType": "pi"
    }
  }
}
```

6. **验证 WS 入站广播**（Sidecar → 所有客户端）：

```json
{
  "type": "config.agents",
  "payload": {
    "agents": [
      {
        "id": "<agent-id>",
        "name": "Test Agent",
        "enabled": true,
        "modelStrategy": "auto",
        "sourceType": "pi"
      }
    ]
  }
}
```

7. **验证 DOM — Agent Section 出现**：

```javascript
// CDP 执行: 检查 AgentSection 组件渲染
const agentSections = document.querySelectorAll('.border.border-border.rounded-lg.mb-3');
console.log('Agent section 数量:', agentSections.length);
// 期望 >= 1

// 检查 agent 名称
agentSections.forEach((section, i) => {
  const name = section.querySelector('.text-\\[13px\\].font-semibold')?.textContent?.trim();
  console.log(`[${i}] name: ${name}`);
});
```

8. **验证持久化文件**：

```bash
cat /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/agents.json | python3 -m json.tool
```

**期望结果**：

| 检查项 | 期望 |
|--------|------|
| Checkbox 选中样式 | 背景变为 `var(--accent)`，显示白色勾号 |
| 底部计数更新 | "已选 1 个" |
| WS `config.setAgent` | `agent.enabled === true`，`agent.modelStrategy === 'auto'` |
| WS `config.agents` 广播 | 列表包含新导入的 agent |
| DOM AgentSection | 出现新的 agent section 卡片 |
| AgentSection header | 显示 agent 名称 + source 副标题 |
| AgentSection body | 显示 "模型策略" select，值为 "auto" |
| agents.json | 文件存在，JSON 数组包含导入的 agent 对象 |
| 扫描结果标记 | 导入的 agent 在扫描结果中显示 "已导入" badge |

**衡量方法**：

- WS 消息抓取：`config.setAgent` 的 `payload.agent` 字段
- WS 消息抓取：`config.agents` 广播的 agents 数组
- DOM 查询：`AgentSection` 组件数量
- 文件检查：`.xyz-agent/agents.json` 内容

**结果记录**：

| 检查项 | 结果 | 备注 |
|--------|------|------|
| Checkbox 选中 | ⬜ Pass / ⬜ Fail | |
| 底部计数更新 | ⬜ Pass / ⬜ Fail | |
| WS config.setAgent 发出 | ⬜ Pass / ⬜ Fail | |
| WS config.agents 广播 | ⬜ Pass / ⬜ Fail | |
| DOM AgentSection 渲染 | ⬜ Pass / ⬜ Fail | |
| agents.json 持久化 | ⬜ Pass / ⬜ Fail | |
| 扫描结果 "已导入" badge | ⬜ Pass / ⬜ Fail | |

---

### TC-3.4: Agent Toggle 启停

| 字段 | 内容 |
|------|------|
| **ID** | TC-3.4 |
| **目标** | 点击 agent section 的 toggle 开关，切换 agent 启停状态，验证 WS 发送 `config.setAgent` 且 `enabled` 值翻转 |
| **前置条件** | TC-3.3 通过，列表中至少有一个已导入且 `enabled: true` 的 agent |
| **依赖** | TC-3.3 |

**测试步骤**：

1. **确认 agent 当前状态**：

```javascript
// CDP 执行: 获取第一个 agent section 的 toggle 状态
const firstSection = document.querySelector('.border.border-border.rounded-lg.mb-3');
const toggle = firstSection?.querySelector('button[class*="toggle"], [role="switch"], .relative.inline-flex');
console.log('Toggle 元素存在:', !!toggle);
console.log('Section 是否有 opacity-60 (disabled):', firstSection?.classList.contains('opacity-60'));
// 初始状态: enabled=true, 无 opacity-60
```

2. **点击 toggle**：

```javascript
// CDP 执行: 点击 toggle 开关
const toggleBtn = firstSection?.querySelector('.relative');
toggleBtn?.click();
```

3. **验证 WS 出站消息**：

```json
{
  "type": "config.setAgent",
  "payload": {
    "agent": {
      "id": "<agent-id>",
      "name": "Test Agent",
      "enabled": false,
      "modelStrategy": "auto",
      "..."
    }
  }
}
```

> 注意：`toggleAgent` 的实现是 `setAgent({ ...a, enabled: !a.enabled })`，因此 `enabled` 从 `true` 变为 `false`。

4. **验证 DOM 变化**：

```javascript
// CDP 执行: 确认 section 变为 disabled 样式
const firstSection2 = document.querySelector('.border.border-border.rounded-lg.mb-3');
console.log('Section 有 opacity-60:', firstSection2?.classList.contains('opacity-60'));
// 期望: true
```

5. **再次点击 toggle 恢复**：

```javascript
// CDP 执行
const toggleBtn2 = firstSection2?.querySelector('.relative');
toggleBtn2?.click();
```

6. **验证恢复**：

```javascript
// CDP 执行
const firstSection3 = document.querySelector('.border.border-border.rounded-lg.mb-3');
console.log('opacity-60 已移除:', !firstSection3?.classList.contains('opacity-60'));
// 期望: true
```

**期望结果**：

| 检查项 | 期望 |
|--------|------|
| Toggle off → WS 消息 | `config.setAgent`，`agent.enabled === false` |
| Section 视觉变化 | 添加 `opacity-60` class |
| Toggle on → WS 消息 | `config.setAgent`，`agent.enabled === true` |
| Section 视觉恢复 | `opacity-60` class 被移除 |

**衡量方法**：

- WS 消息抓取：两次 `config.setAgent` 的 `enabled` 字段值
- DOM 查询：section 的 `opacity-60` class 变化

**结果记录**：

| 检查项 | 结果 | 备注 |
|--------|------|------|
| Toggle off WS 消息 | ⬜ Pass / ⬜ Fail | |
| Section opacity-60 出现 | ⬜ Pass / ⬜ Fail | |
| Toggle on WS 消息 | ⬜ Pass / ⬜ Fail | |
| Section opacity-60 消失 | ⬜ Pass / ⬜ Fail | |

---

### TC-3.5: Agent 删除 confirm-bar

| 字段 | 内容 |
|------|------|
| **ID** | TC-3.5 |
| **目标** | 点击删除按钮后显示红色 confirm-bar，支持取消和确认删除两级操作，确认后 WS 发送 `config.deleteAgent` 并从 DOM 和持久化文件中移除 |
| **前置条件** | TC-3.3 通过，列表中至少有一个已导入的 agent |
| **依赖** | TC-3.3 |

**测试步骤**：

#### 阶段 A：取消删除

1. **定位 agent section 的删除按钮**：

```javascript
// CDP 执行: 找到第一个 agent section 的删除按钮
const firstSection = document.querySelector('.border.border-border.rounded-lg.mb-3');
const deleteBtn = Array.from(firstSection.querySelectorAll('button')).find(
  b => b.textContent?.trim() === '删除'
);
console.log('删除按钮存在:', !!deleteBtn);
```

2. **点击删除按钮**：

```javascript
// CDP 执行
deleteBtn?.click();
```

3. **验证 confirm-bar 出现**：

```javascript
// CDP 执行: 检查红色 confirm-bar
const confirmBar = firstSection.querySelector('.bg-\\[var\\(--danger-light\\)\\]');
console.log('Confirm bar 存在:', !!confirmBar);
console.log('Confirm bar 文本:', confirmBar?.textContent?.trim());
// 期望包含: "确认删除" + agent 名称 + "不可撤销"

// 检查按钮
const confirmBtn = Array.from(confirmBar?.querySelectorAll('button') || []).find(
  b => b.textContent?.includes('确认删除')
);
const cancelBtn = Array.from(confirmBar?.querySelectorAll('button') || []).find(
  b => b.textContent?.trim() === '取消'
);
console.log('确认删除按钮存在:', !!confirmBtn);
console.log('取消按钮存在:', !!cancelBtn);
```

4. **点击取消**：

```javascript
// CDP 执行
cancelBtn?.click();
```

5. **验证 confirm-bar 消失**：

```javascript
// CDP 执行
const confirmBar2 = firstSection.querySelector('.bg-\\[var\\(--danger-light\\)\\]');
console.log('Confirm bar 已消失:', !confirmBar2);
// 期望: true (confirm-bar 不存在)
```

6. **验证 agent section 仍然存在**：

```javascript
// CDP 执行
const sections = document.querySelectorAll('.border.border-border.rounded-lg.mb-3');
console.log('Agent section 仍然存在, 数量:', sections.length);
// 期望: >= 1 (与删除前相同)
```

#### 阶段 B：确认删除

7. **再次点击删除按钮**：

```javascript
// CDP 执行
const deleteBtn2 = Array.from(firstSection.querySelectorAll('button')).find(
  b => b.textContent?.trim() === '删除'
);
deleteBtn2?.click();
```

8. **确认 confirm-bar 再次出现**：

```javascript
// CDP 执行
const confirmBar3 = firstSection.querySelector('.bg-\\[var\\(--danger-light\\)\\]');
console.log('Confirm bar 再次出现:', !!confirmBar3);
```

9. **点击 "确认删除"**：

```javascript
// CDP 执行
const confirmBtn2 = Array.from(confirmBar3?.querySelectorAll('button') || []).find(
  b => b.textContent?.includes('确认删除')
);
confirmBtn2?.click();
```

10. **验证 WS 出站消息**：

```json
{
  "type": "config.deleteAgent",
  "payload": {
    "agentId": "<被删除的 agent ID>"
  }
}
```

11. **验证 WS 入站响应**：

```json
{
  "type": "config.agentDeleted",
  "payload": {
    "agentId": "<agent-id>",
    "success": true
  }
}
```

12. **验证 DOM — agent section 被移除**：

```javascript
// CDP 执行: 等待 DOM 更新后检查
setTimeout(() => {
  const remaining = document.querySelectorAll('.border.border-border.rounded-lg.mb-3');
  console.log('剩余 agent section 数量:', remaining.length);
  // 期望: 比删除前少 1
}, 500);
```

13. **验证持久化文件**：

```bash
cat /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/agents.json | python3 -m json.tool
# 期望: 被删除的 agent 不在数组中
```

**期望结果**：

| 阶段 | 检查项 | 期望 |
|------|--------|------|
| A | 点击删除 → confirm-bar 出现 | 红色背景 `var(--danger-light)`，包含警告图标 + 文字 + 两个按钮 |
| A | Confirm-bar 文字 | "确认删除 {name}？此操作不可撤销。" |
| A | 确认删除按钮样式 | 红色背景 `var(--danger)`，白色文字 |
| A | 点击取消 → confirm-bar 消失 | Agent section 完整保留 |
| B | 点击删除 → confirm-bar 出现 | 同阶段 A |
| B | 点击确认删除 → WS 消息 | `config.deleteAgent`，`payload.agentId` 正确 |
| B | WS 响应 | `config.agentDeleted`，`success: true` |
| B | WS 广播 | `config.agents`，列表不包含被删除 agent |
| B | DOM | 被删除的 agent section 从 DOM 移除 |
| B | agents.json | 被删除的 agent 从文件中移除 |

**衡量方法**：

- DOM 查询：confirm-bar 的出现/消失/背景色
- WS 消息抓取：`config.deleteAgent` 和 `config.agentDeleted`
- 文件检查：`.xyz-agent/agents.json` 不包含被删除的 agent

**结果记录**：

| 检查项 | 结果 | 备注 |
|--------|------|------|
| 删除按钮点击 → confirm-bar 出现 | ⬜ Pass / ⬜ Fail | |
| Confirm-bar 样式正确（红色底色） | ⬜ Pass / ⬜ Fail | |
| 取消 → confirm-bar 消失 | ⬜ Pass / ⬜ Fail | |
| 取消后 agent section 保留 | ⬜ Pass / ⬜ Fail | |
| 确认删除 → WS config.deleteAgent | ⬜ Pass / ⬜ Fail | |
| 确认删除 → DOM section 移除 | ⬜ Pass / ⬜ Fail | |
| 确认删除 → agents.json 更新 | ⬜ Pass / ⬜ Fail | |

---

### TC-3.6: Agent 策略切换

| 字段 | 内容 |
|------|------|
| **ID** | TC-3.6 |
| **目标** | 在 agent section body 中修改模型策略 select 的值，验证 WS 发送 `config.setAgent` 且 `modelStrategy` 更新 |
| **前置条件** | TC-3.3 通过，列表中至少有一个已导入的 agent |
| **依赖** | TC-3.3 |

**测试步骤**：

1. **重新导入一个 agent（如果 TC-3.5 已删除所有 agent）**：

> 如果 TC-3.5 已将 agent 删除，需要先重新扫描导入一个 agent（重复 TC-3.2 + TC-3.3 的步骤），再继续本测试。

2. **确认 agent section 的策略 select 当前值**：

```javascript
// CDP 执行: 获取第一个 agent section 的策略 select
const firstSection = document.querySelector('.border.border-border.rounded-lg.mb-3');

// 策略 select 在 body 区域（非 confirm-bar 时才显示）
const strategySelect = firstSection?.querySelector('select');
console.log('策略 select 存在:', !!strategySelect);
console.log('当前值:', strategySelect?.value);
// 期望: "auto" (导入时默认)

// 也可通过旁边的 label 确认
const strategyLabel = firstSection?.querySelector('.text-xs.font-medium');
console.log('标签:', strategyLabel?.textContent?.trim());
// 期望: "模型策略"
```

3. **修改策略值为 "tag"**：

```javascript
// CDP 执行: 模拟 select change 事件
// 方法 1: 直接修改 value 并触发事件
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLSelectElement.prototype, 'value'
).set;
nativeInputValueSetter.call(strategySelect, 'tag');
strategySelect.dispatchEvent(new Event('change', { bubbles: true }));

// 方法 2: 如果方法 1 不生效（Vue 组件封装），查找并点击 select 打开下拉，选择 tag 选项
// 先点击 select 打开下拉
strategySelect?.click();
// 等待下拉展开后点击 "tag — 按标签" 选项
```

4. **验证 WS 出站消息**：

```json
{
  "type": "config.setAgent",
  "payload": {
    "agent": {
      "id": "<agent-id>",
      "name": "Test Agent",
      "enabled": true,
      "modelStrategy": "tag",
      "..."
    }
  }
}
```

> 注意：策略切换通过 `handleUpdateStrategy` → `setAgent({ ...agent, modelStrategy: payload.strategy })` 实现，发送完整的 agent 对象。

5. **验证 DOM 更新**：

```javascript
// CDP 执行: 检查策略显示是否更新
const firstSection2 = document.querySelector('.border.border-border.rounded-lg.mb-3');
const subtitle = firstSection2?.querySelector('.text-\\[11px\\].text-muted.font-mono');
console.log('副标题更新:', subtitle?.textContent?.trim());
// 期望包含 "tag"
```

6. **验证持久化文件**：

```bash
cat /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/agents.json | python3 -m json.tool
# 检查 agent 的 modelStrategy 字段是否为 "tag"
```

7. **切换回 "auto" 恢复状态**（可选，保持数据干净）：

```javascript
// CDP 执行
nativeInputValueSetter.call(strategySelect, 'auto');
strategySelect.dispatchEvent(new Event('change', { bubbles: true }));
```

**期望结果**：

| 检查项 | 期望 |
|--------|------|
| 策略 select 默认值 | "auto"（导入时默认 `modelStrategy: 'auto'`） |
| Select 选项 | 包含 "auto — 自动匹配"、"tag — 按标签"、"bind — 绑定" |
| 选择 tag → WS 消息 | `config.setAgent`，`agent.modelStrategy === 'tag'` |
| Section 副标题更新 | 显示 "tag · ..." |
| agents.json 更新 | `modelStrategy` 字段为 `"tag"` |
| 切回 auto | 恢复初始状态 |

**衡量方法**：

- WS 消息抓取：`config.setAgent` 的 `agent.modelStrategy` 字段
- DOM 查询：select 当前值、副标题文本
- 文件检查：`.xyz-agent/agents.json` 中对应 agent 的 `modelStrategy`

**结果记录**：

| 检查项 | 结果 | 备注 |
|--------|------|------|
| 默认策略 auto | ⬜ Pass / ⬜ Fail | |
| Select 选项完整 | ⬜ Pass / ⬜ Fail | |
| 切换 tag → WS 消息 | ⬜ Pass / ⬜ Fail | |
| 副标题更新 | ⬜ Pass / ⬜ Fail | |
| agents.json 更新 | ⬜ Pass / ⬜ Fail | |

---

## 测试执行顺序与依赖图

```
TC-3.1 (Source Chips)
  │
  └──▶ TC-3.2 (扫描执行)
         │
         ├──▶ TC-3.3 (导入)
         │      │
         │      ├──▶ TC-3.4 (Toggle)
         │      │
         │      ├──▶ TC-3.5 (删除 confirm-bar)
         │      │
         │      └──▶ TC-3.6 (策略切换)
         │             ⚠ 如 TC-3.5 已删 agent，需先重新导入
         │
```

**执行建议**：

1. TC-3.1 → 3.2 → 3.3 顺序执行（扫描导入链路）
2. TC-3.4 和 TC-3.6 可在 TC-3.3 后任意顺序执行
3. TC-3.5（删除）建议最后执行，因为会破坏后续 TC 的前置数据
4. 如果 TC-3.5 必须先执行，后续 TC 需要重新导入 agent

---

## WS 消息协议速查

| 方向 | 消息类型 | Payload 关键字段 |
|------|---------|-----------------|
| 前端 → Sidecar | `config.scanAgents` | `{ sources: string[] }` |
| Sidecar → 前端 | `config.scannedAgents` | `{ agents: ScannedAgentInfo[], success: boolean }` |
| 前端 → Sidecar | `config.setAgent` | `{ agent: AgentInfo }` |
| Sidecar → 前端 | `config.agentUpdated` | `{ agent: AgentInfo, success: boolean }` |
| Sidecar → 广播 | `config.agents` | `{ agents: AgentInfo[] }` |
| 前端 → Sidecar | `config.deleteAgent` | `{ agentId: string }` |
| Sidecar → 前端 | `config.agentDeleted` | `{ agentId: string, success: boolean }` |

---

## 清理脚本

测试完成后清理测试数据：

```bash
# 删除测试 agent 文件（如果创建了测试用 agent）
rm -f ~/.pi/agent/agents/test-agent.md

# 清理持久化数据
rm -f /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/agents.json

echo "Group 3 测试数据已清理"
```
