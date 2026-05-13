# E2E Group 3: Agent Tab 测试

> **依赖**: Group 0（Settings 窗口打开，Agent tab 可见）
> **测试用例数**: 6
> **每 TC 验证层**: 协议 (WS) + DOM + 视觉截图

---

## 公共前置

### 工具路径

| 工具 | 路径 |
|------|------|
| CDP 脚本 | `/Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js` |
| zai-vision | `/Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py` |
| 截图目录 | `/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots/` |
| 设计稿截图 | `expected-agent-tab.png` |

### WS 协议消息一览

| 方向 | 消息类型 | 说明 |
|------|---------|------|
| FE → SC | `config.scanAgents` | 触发扫描 agent 目录 |
| SC → FE | `config.scannedAgents` | 返回扫描到的 agent 列表 |
| FE → SC | `config.setAgent` | 导入/更新 agent（payload: `{ sessionId, agentId, enabled }`) |
| SC → FE | `config.agentUpdated` | agent 配置变更确认 |
| FE → SC | `config.deleteAgent` | 删除 agent（payload: `{ sessionId, agentId }`) |

### CDP 连接 & Tab 切换

与 Group 2 相同流程：

```bash
# 1. 获取 CDP 端口
CDP_PORT=$(lsof -i -P | grep -m1 'Target.*LISTEN' | awk '{print $9}' | cut -d: -f2)

# 2. 切换到 Agent tab
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js click \
  --selector '[data-testid="tab-agent"]' --port "$CDP_PORT"

# 3. 等待 tab 内容渲染
sleep 0.5
```

### 截图辅助函数

```bash
SCREENSHOT_DIR="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots"

take_screenshot() {
  local name="$1"
  node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js screenshot \
    --port "$CDP_PORT" \
    --output "${SCREENSHOT_DIR}/${name}"
}

check_visual() {
  local actual="$1"
  local expected="$2"
  python3 /Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py \
    --image "${SCREENSHOT_DIR}/${actual}" \
    --expected "${SCREENSHOT_DIR}/${expected}" \
    --prompt "对比实际截图与设计稿，检查布局、颜色、间距、字体是否一致。列出所有差异。"
}
```

---

## TC-3.1: Agent 扫描源 Chips — DOM 检查 + 视觉截图

### 目标

验证 Agent tab 页面正确渲染扫描源选择 Chips（目录/文件类型筛选）。

### 前置

- Group 0 通过（Settings 窗口已打开）
- 已切换到 Agent tab

### 协议验证

无协议交互，纯 UI 渲染验证。

### DOM 验证

```bash
# 检查扫描源 chips 容器存在
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const container = document.querySelector("[data-testid=agent-scan-sources]");
  if (!container) throw new Error("agent-scan-sources container not found");

  const chips = container.querySelectorAll("[data-testid^=agent-source-chip-]");
  const chipTexts = Array.from(chips).map(c => c.textContent.trim());

  return JSON.stringify({
    chipCount: chips.length,
    chipTexts: chipTexts,
    hasActiveClass: Array.from(chips).some(c => c.classList.contains("chip--active"))
  });
'
```

**期望 DOM 状态：**
- `[data-testid="agent-scan-sources"]` 存在
- 包含 >= 1 个 chip 元素（`[data-testid^="agent-source-chip-"]`）
- 至少一个 chip 带有 `chip--active` 类

### 视觉验证

```bash
take_screenshot "actual-agent-scan-sources.png"
check_visual "actual-agent-scan-sources.png" "expected-agent-tab.png"
```

**期望视觉状态：**
- Chips 横向排列，圆角胶囊形状
- 激活态 chip 颜色与 accent 色一致
- 非激活态 chip 背景色为 muted / surface 变体

### 期望结果

| 验证层 | 期望 |
|--------|------|
| DOM | scan-sources 容器存在，chips >= 1，至少 1 个 active |
| 视觉 | Chips 布局与设计稿一致，激活/非激活态颜色正确 |

### 实际结果

> 待填写

---

## TC-3.2: Agent 扫描执行 — 协议 + DOM + 视觉截图

### 目标

验证点击扫描按钮后，WS 发送 `config.scanAgents`，接收 `config.scannedAgents` 响应，DOM 正确渲染扫描结果列表。

### 前置

- TC-3.1 通过
- Agent tab 已显示

### 协议验证

```bash
# 1. 拦截 WS 消息，监听 scannedAgents
node cdp.js evaluate --port "$CDP_PORT" --expr '
  window.__e2e_agent_messages = [];
  const origSend = WebSocket.prototype.send;
  // 拦截服务端推送消息需要通过 CDP Network domain
'

# 2. 通过 CDP 启用 Network domain 监听 WS 帧
node cdp.js evaluate --port "$CDP_PORT" --expr '
  // 记录发出去的消息
  window.__e2e_sent = [];
  const wsInstances = [];
  // 钩子已在 ws-client 层注入
'

# 3. 点击扫描按钮
node cdp.js click --selector '[data-testid="agent-scan-btn"]' --port "$CDP_PORT"

# 4. 等待扫描完成（最多 5s）
sleep 2

# 5. 验证发送了 config.scanAgents
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const sent = window.__e2e_sent || [];
  const scanMsg = sent.find(m => m.type === "config.scanAgents");
  if (!scanMsg) throw new Error("config.scanAgents not sent");
  return JSON.stringify({ sentType: scanMsg.type, payload: scanMsg.payload });
'

# 6. 验证收到了 config.scannedAgents
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const received = window.__e2e_received || [];
  const scanResult = received.find(m => m.type === "config.scannedAgents");
  if (!scanResult) throw new Error("config.scannedAgents not received");
  return JSON.stringify({
    type: scanResult.type,
    agentCount: scanResult.payload?.agents?.length || 0,
    agents: (scanResult.payload?.agents || []).map(a => ({ id: a.id, name: a.name }))
  });
'
```

**期望协议流：**
1. FE → SC: `{ type: "config.scanAgents", payload: { sessionId } }`
2. SC → FE: `{ type: "config.scannedAgents", payload: { agents: [...] } }`

### DOM 验证

```bash
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const list = document.querySelector("[data-testid=agent-scan-results]");
  if (!list) throw new Error("agent-scan-results not found");

  const items = list.querySelectorAll("[data-testid^=agent-item-]");
  const itemData = Array.from(items).map(item => ({
    id: item.dataset.testid,
    name: item.querySelector("[data-testid=agent-name]")?.textContent.trim(),
    hasImportBtn: !!item.querySelector("[data-testid^=agent-import-]"),
    hasToggle: !!item.querySelector("[data-testid^=agent-toggle-]"),
  }));

  return JSON.stringify({ itemCount: items.length, items: itemData });
'
```

**期望 DOM 状态：**
- `[data-testid="agent-scan-results"]` 存在
- 每个 agent item 包含 name + import 按钮
- 列表项数与 `scannedAgents` 返回的数组长度一致

### 视觉验证

```bash
take_screenshot "actual-agent-results.png"
check_visual "actual-agent-results.png" "expected-agent-tab.png"
```

**期望视觉状态：**
- 扫描结果列表纵向排列，每行显示 agent 名称 + 导入按钮
- 行间有分隔线或间距
- 空状态显示"未找到 agent"提示（如果无结果）

### 期望结果

| 验证层 | 期望 |
|--------|------|
| 协议 | 发送 `config.scanAgents`，收到 `config.scannedAgents` 且 agents 数组非空 |
| DOM | scan-results 列表渲染，每项含 name + import 按钮 |
| 视觉 | 截图 `actual-agent-results.png` 与设计稿布局一致 |

### 实际结果

> 待填写

---

## TC-3.3: Agent 导入 — 协议 + DOM + 持久化 + 视觉截图

### 目标

验证点击导入按钮后，WS 发送 `config.setAgent`，收到 `config.agentUpdated` 确认，DOM 中该 agent 从"扫描结果"区移到"已导入"区，刷新后持久化。

### 前置

- TC-3.2 通过
- 至少一个扫描结果可见

### 协议验证

```bash
# 1. 记录第一个 agent 的 ID
AGENT_ID=$(node cdp.js evaluate --port "$CDP_PORT" --expr '
  const first = document.querySelector("[data-testid^=agent-item-]");
  if (!first) throw new Error("No agent items found");
  return first.dataset.testid.replace("agent-item-", "");
')

# 2. 清空消息记录
node cdp.js evaluate --port "$CDP_PORT" --expr '
  window.__e2e_sent = [];
  window.__e2e_received = [];
'

# 3. 点击导入按钮
node cdp.js click --selector "[data-testid=agent-import-${AGENT_ID}]" --port "$CDP_PORT"
sleep 1

# 4. 验证发送了 config.setAgent
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const sent = window.__e2e_sent || [];
  const setMsg = sent.find(m => m.type === "config.setAgent");
  if (!setMsg) throw new Error("config.setAgent not sent");
  if (setMsg.payload.agentId !== "'"$AGENT_ID"'") throw new Error("agentId mismatch");
  return JSON.stringify({ type: setMsg.type, payload: setMsg.payload });
'

# 5. 验证收到了 config.agentUpdated
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const received = window.__e2e_received || [];
  const updateMsg = received.find(m => m.type === "config.agentUpdated");
  if (!updateMsg) throw new Error("config.agentUpdated not received");
  return JSON.stringify({ type: updateMsg.type, payload: updateMsg.payload });
'
```

**期望协议流：**
1. FE → SC: `{ type: "config.setAgent", payload: { sessionId, agentId, enabled: true } }`
2. SC → FE: `{ type: "config.agentUpdated", payload: { agentId, enabled: true } }`

### DOM 验证

```bash
# 导入后该 agent 应出现在已导入列表中
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const importedList = document.querySelector("[data-testid=agent-imported-list]");
  if (!importedList) throw new Error("agent-imported-list not found");

  const importedItems = importedList.querySelectorAll("[data-testid^=agent-imported-]");
  const found = Array.from(importedItems).some(
    item => item.dataset.testid === "agent-imported-'"$AGENT_ID"'"
  );
  if (!found) throw new Error("Imported agent not found in imported list");

  return JSON.stringify({
    importedCount: importedItems.length,
    found: true
  });
'
```

### 持久化验证

```bash
# 刷新页面后验证 agent 仍在已导入列表中
node cdp.js evaluate --port "$CDP_PORT" --expr 'location.reload()'
sleep 2

# 重新切换到 Agent tab
node cdp.js click --selector '[data-testid="tab-agent"]' --port "$CDP_PORT"
sleep 1

# 验证已导入列表仍包含该 agent
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const importedList = document.querySelector("[data-testid=agent-imported-list]");
  if (!importedList) throw new Error("agent-imported-list not found after reload");
  const items = importedList.querySelectorAll("[data-testid^=agent-imported-]");
  const found = Array.from(items).some(
    item => item.dataset.testid === "agent-imported-'"$AGENT_ID"'"
  );
  if (!found) throw new Error("Imported agent lost after refresh - persistence failed");
  return "PERSISTENCE_OK";
'
```

### 视觉验证

```bash
take_screenshot "actual-agent-imported.png"
check_visual "actual-agent-imported.png" "expected-agent-tab.png"
```

**期望视觉状态：**
- 已导入区显示 agent 卡片/行
- agent 名称 + toggle 开关 + 删除按钮可见
- 导入区与扫描区分隔清晰

### 期望结果

| 验证层 | 期望 |
|--------|------|
| 协议 | 发送 `config.setAgent`，收到 `config.agentUpdated`，agentId 匹配 |
| DOM | agent 出现在 imported-list，不在 scan-results 中 |
| 持久化 | 刷新后 agent 仍在 imported-list |
| 视觉 | 截图 `actual-agent-imported.png` 布局正确 |

### 实际结果

> 待填写

---

## TC-3.4: Agent Toggle — 协议 + DOM（opacity-60）

### 目标

验证点击 toggle 后，WS 发送 `config.setAgent`（enabled: false），DOM 中该 agent 行变为半透明（`opacity-60`）。

### 前置

- TC-3.3 通过
- 至少一个已导入 agent

### 协议验证

```bash
# 1. 清空消息记录
node cdp.js evaluate --port "$CDP_PORT" --expr '
  window.__e2e_sent = [];
  window.__e2e_received = [];
'

# 2. 点击 toggle（关闭）
node cdp.js click --selector "[data-testid=agent-toggle-${AGENT_ID}]" --port "$CDP_PORT"
sleep 1

# 3. 验证发送了 config.setAgent 且 enabled=false
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const sent = window.__e2e_sent || [];
  const setMsg = sent.find(m => m.type === "config.setAgent");
  if (!setMsg) throw new Error("config.setAgent not sent on toggle");
  if (setMsg.payload.enabled !== false) throw new Error("Expected enabled=false, got " + setMsg.payload.enabled);
  return JSON.stringify({ type: setMsg.type, enabled: setMsg.payload.enabled });
'

# 4. 验证收到了 config.agentUpdated
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const received = window.__e2e_received || [];
  const updateMsg = received.find(m => m.type === "config.agentUpdated");
  if (!updateMsg) throw new Error("config.agentUpdated not received on toggle");
  return JSON.stringify({ type: updateMsg.type, enabled: updateMsg.payload.enabled });
'
```

**期望协议流：**
1. FE → SC: `{ type: "config.setAgent", payload: { sessionId, agentId, enabled: false } }`
2. SC → FE: `{ type: "config.agentUpdated", payload: { agentId, enabled: false } }`

### DOM 验证

```bash
# 检查 agent 行变为半透明
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const agentRow = document.querySelector("[data-testid=agent-imported-'"$AGENT_ID"']");
  if (!agentRow) throw new Error("Agent row not found");

  const style = getComputedStyle(agentRow);
  const classes = agentRow.className;

  // 检查 opacity-60 或等效样式
  const hasOpacity = classes.includes("opacity-60") ||
                     classes.includes("opacity-[0.6]") ||
                     parseFloat(style.opacity) < 1;

  // 检查 toggle 状态
  const toggle = agentRow.querySelector("[data-testid=agent-toggle-'"$AGENT_ID"']");
  const toggleOff = toggle && !toggle.classList.contains("toggle--active");

  return JSON.stringify({
    hasOpacity,
    opacity: style.opacity,
    classes: classes,
    toggleOff
  });
'
```

**期望 DOM 状态：**
- agent 行包含 `opacity-60` 类或 computed opacity < 1
- toggle 不含 `toggle--active` 类

### 视觉验证

无（协议+DOM 覆盖足够，视觉变化微小）。

### 期望结果

| 验证层 | 期望 |
|--------|------|
| 协议 | 发送 `config.setAgent`（enabled: false），收到 `config.agentUpdated` |
| DOM | agent 行 opacity < 1，toggle 状态为 off |

### 实际结果

> 待填写

---

## TC-3.5: Agent 删除 confirm-bar — 协议 + DOM + 视觉截图 + 持久化

### 目标

验证删除流程：点击删除 → 出现红色 confirm-bar → 取消则消失 → 确认则发送 `config.deleteAgent` → 收到确认 → agent 从列表移除 → 刷新后持久化。

**特别关注：confirm-bar 两级操作（取消→消失，确认→删除）。**

### 前置

- TC-3.3 通过
- 至少一个已导入 agent（需重新 toggle 回 enabled 状态）

### Step 1: 触发删除 — 显示 confirm-bar

```bash
# 先确保 agent 是 enabled 状态
node cdp.js click --selector "[data-testid=agent-toggle-${AGENT_ID}]" --port "$CDP_PORT"
sleep 0.5

# 点击删除按钮
node cdp.js click --selector "[data-testid=agent-delete-${AGENT_ID}]" --port "$CDP_PORT"
sleep 0.5
```

### DOM 验证 — confirm-bar 出现

```bash
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const confirmBar = document.querySelector("[data-testid=agent-confirm-bar]");
  if (!confirmBar) throw new Error("confirm-bar not visible after delete click");

  const hasCancel = !!confirmBar.querySelector("[data-testid=confirm-cancel]");
  const hasConfirm = !!confirmBar.querySelector("[data-testid=confirm-delete]");
  const bgColor = getComputedStyle(confirmBar).backgroundColor;

  return JSON.stringify({
    visible: true,
    hasCancel,
    hasConfirm,
    bgColor,
    text: confirmBar.textContent.trim()
  });
'
```

**期望：**
- `[data-testid="agent-confirm-bar"]` 存在且可见
- 包含取消和确认按钮
- 背景色为红色系（confirm 意图）

### 视觉验证 — confirm-bar 截图

```bash
take_screenshot "actual-agent-confirm.png"
check_visual "actual-agent-confirm.png" "expected-agent-tab.png"
```

**期望视觉状态：**
- confirm-bar 红色底色，覆盖或嵌入 agent 行
- 取消/确认按钮文字清晰

### Step 2: 取消操作 — confirm-bar 消失

```bash
# 点击取消
node cdp.js click --selector '[data-testid=confirm-cancel]' --port "$CDP_PORT"
sleep 0.5

# 验证 confirm-bar 消失
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const confirmBar = document.querySelector("[data-testid=agent-confirm-bar]");
  const hidden = !confirmBar || confirmBar.classList.contains("hidden") ||
                 getComputedStyle(confirmBar).display === "none";
  return JSON.stringify({ confirmBarHidden: hidden });
'
```

**期望：** confirm-bar 不可见。

### Step 3: 再次触发删除 — 确认操作

```bash
# 再次点击删除
node cdp.js click --selector "[data-testid=agent-delete-${AGENT_ID}]" --port "$CDP_PORT"
sleep 0.5

# 确认 confirm-bar 再次出现
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const confirmBar = document.querySelector("[data-testid=agent-confirm-bar]");
  if (!confirmBar) throw new Error("confirm-bar should reappear");
  return "CONFIRM_BAR_VISIBLE";
'

# 清空消息记录
node cdp.js evaluate --port "$CDP_PORT" --expr '
  window.__e2e_sent = [];
  window.__e2e_received = [];
'

# 点击确认删除
node cdp.js click --selector '[data-testid=confirm-delete]' --port "$CDP_PORT"
sleep 1
```

### 协议验证 — 确认删除

```bash
# 验证发送了 config.deleteAgent
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const sent = window.__e2e_sent || [];
  const deleteMsg = sent.find(m => m.type === "config.deleteAgent");
  if (!deleteMsg) throw new Error("config.deleteAgent not sent");
  if (deleteMsg.payload.agentId !== "'"$AGENT_ID"'") throw new Error("agentId mismatch");
  return JSON.stringify({ type: deleteMsg.type, payload: deleteMsg.payload });
'

# 验证 agent 从 DOM 中移除
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const agentRow = document.querySelector("[data-testid=agent-imported-'"$AGENT_ID"']");
  return JSON.stringify({ agentRemoved: !agentRow });
'
```

### 持久化验证

```bash
# 刷新后验证 agent 确实被删除
node cdp.js evaluate --port "$CDP_PORT" --expr 'location.reload()'
sleep 2
node cdp.js click --selector '[data-testid="tab-agent"]' --port "$CDP_PORT"
sleep 1

node cdp.js evaluate --port "$CDP_PORT" --expr '
  const agentRow = document.querySelector("[data-testid=agent-imported-'"$AGENT_ID"']");
  if (agentRow) throw new Error("Agent still exists after delete + refresh - persistence failed");
  return "DELETE_PERSISTENCE_OK";
'
```

### 期望结果

| 验证层 | 期望 |
|--------|------|
| DOM Step 1 | confirm-bar 出现，红色底色，含取消+确认按钮 |
| 视觉 | 截图 `actual-agent-confirm.png` 红色 confirm-bar 清晰可见 |
| DOM Step 2 | 取消后 confirm-bar 消失，agent 仍在列表 |
| 协议 Step 3 | 确认后发送 `config.deleteAgent`，agentId 匹配 |
| DOM Step 3 | agent 行从 imported-list 移除 |
| 持久化 | 刷新后 agent 不再出现 |

### 实际结果

> 待填写

---

## TC-3.6: Agent 策略切换 — 协议 + DOM

### 目标

验证 Agent 策略（如"自动选择"/"手动选择"/"全部禁用"等）切换时，WS 发送正确消息，DOM 反映新策略状态。

### 前置

- TC-3.1 通过
- 至少一个已导入 agent（如 TC-3.3 未被 TC-3.5 完全清理，否则需重新导入一个）

### 协议验证

```bash
# 1. 清空消息记录
node cdp.js evaluate --port "$CDP_PORT" --expr '
  window.__e2e_sent = [];
  window.__e2e_received = [];
'

# 2. 获取当前策略
CURRENT_STRATEGY=$(node cdp.js evaluate --port "$CDP_PORT" --expr '
  const activeStrategy = document.querySelector("[data-testid^=agent-strategy-].strategy--active");
  if (!activeStrategy) return "none";
  return activeStrategy.dataset.testid.replace("agent-strategy-", "");
')

# 3. 切换到另一个策略（取非当前的第一个）
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const strategies = document.querySelectorAll("[data-testid^=agent-strategy-]");
  const current = "'"$CURRENT_STRATEGY"'";
  const target = Array.from(strategies).find(s => !s.classList.contains("strategy--active"));
  if (target) { target.click(); return target.dataset.testid.replace("agent-strategy-", ""); }
  return "no_alternative";
'
sleep 1

# 4. 验证发送了策略更新消息
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const sent = window.__e2e_sent || [];
  // 策略变更可能通过 config.setAgent 或独立消息类型
  const strategyMsg = sent.find(m =>
    m.type === "config.setAgent" || m.type === "config.setAgentStrategy"
  );
  if (!strategyMsg) throw new Error("No strategy update message sent");
  return JSON.stringify({ type: strategyMsg.type, payload: strategyMsg.payload });
'
```

**期望协议流：**
1. FE → SC: `{ type: "config.setAgent" | "config.setAgentStrategy", payload: { sessionId, strategy } }`
2. SC → FE: 相应确认消息

### DOM 验证

```bash
node cdp.js evaluate --port "$CDP_PORT" --expr '
  const strategies = document.querySelectorAll("[data-testid^=agent-strategy-]");
  const activeList = Array.from(strategies).filter(s => s.classList.contains("strategy--active"));

  return JSON.stringify({
    totalStrategies: strategies.length,
    activeCount: activeList.length,
    activeStrategy: activeList.length === 1
      ? activeList[0].dataset.testid.replace("agent-strategy-", "")
      : "INVALID",
    strategyNames: Array.from(strategies).map(s => ({
      id: s.dataset.testid.replace("agent-strategy-", ""),
      active: s.classList.contains("strategy--active")
    }))
  });
'
```

**期望 DOM 状态：**
- 恰好 1 个策略元素带 `strategy--active` 类
- active 策略的 id 与切换目标一致

### 视觉验证

无（协议+DOM 覆盖足够）。

### 期望结果

| 验证层 | 期望 |
|--------|------|
| 协议 | 策略切换触发 WS 消息（setAgent 或 setAgentStrategy） |
| DOM | 恰好 1 个 strategy--active，active 策略与点击目标一致 |

### 实际结果

> 待填写

---

## 执行顺序

```
TC-3.1 (扫描源 UI)
  └─→ TC-3.2 (执行扫描)
        └─→ TC-3.3 (导入 agent)
              ├─→ TC-3.4 (Toggle 开关)
              ├─→ TC-3.5 (删除流程，含两级 confirm)
              └─→ TC-3.6 (策略切换)
```

TC-3.4 / TC-3.5 / TC-3.6 之间无严格依赖，但都依赖 TC-3.3 的导入结果。若 TC-3.5 删除了 agent，TC-3.6 需要先重新导入一个。

---

## 汇总表

| TC | 协议 | DOM | 视觉 | 持久化 |
|----|------|-----|------|--------|
| 3.1 | — | chips 容器 + active | 截图 | — |
| 3.2 | scanAgents → scannedAgents | scan-results 列表 | actual-agent-results.png | — |
| 3.3 | setAgent → agentUpdated | imported-list + 刷新验证 | actual-agent-imported.png | 刷新 |
| 3.4 | setAgent(enabled:false) → agentUpdated | opacity-60 + toggle off | — | — |
| 3.5 | deleteAgent | confirm-bar 出现/消失/删除 | actual-agent-confirm.png | 刷新 |
| 3.6 | setAgent/setAgentStrategy | strategy--active 切换 | — | — |
