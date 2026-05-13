# G4: Agent Tab（6 TC | L1+L2+L3+L4 | 依赖 G1）

> 前置条件：G1 通过，至少一个扫描源目录存在 agent 配置。
> 执行建议：TC-4-01 → TC-4-02 → TC-4-03（导入 ≥2 条）→ TC-4-06 → TC-4-04 → TC-4-05。

设计稿关键视觉：agent section 有 avatar + name + strategy select + tools 行 + 红色 confirm-bar 删除确认。

---

### TC-4-01: Agent 扫描源 Chips

**测试目标**: 3 个 source chips 渲染，Pi 默认 active。

**前置条件**: G1 通过。

**验证**:

#### Layer 2: DOM/A11y 验证
```bash
# 切换到 Agents tab
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var items=document.querySelectorAll(\".sidebar-item\");var a=Array.from(items).find(function(e){return e.textContent.includes(\"Agent\")});if(a)a.click();return \"clicked\"})()"}'
sleep 0.5

# 检查 source chips
node "$CDP" "$ELECTRON_WS" Accessibility.getFullAXTree '{}' | python3 -c "
import sys, json
raw = json.load(sys.stdin)
chips = []
for n in raw.get('result',{}).get('nodes',[]):
    name = n.get('name',{}).get('value','')
    r = n.get('role',{}).get('value','')
    if any(kw in (name or '') for kw in ['Pi Agents', 'Claude Code', 'Agents', 'Pi']):
        chips.append(f'{r} \"{name}\"')
print(f'source chips: {len(chips)}')
for c in chips: print(f'  - {c}')
assert len(chips) >= 3, f'FAIL: expected >=3 chips, got {len(chips)}'
print('PASS')
"
```

#### Layer 3: 视觉对比
```bash
mkdir -p "$EVIDENCE"
node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "
import sys,json,base64
r = json.load(sys.stdin)
data = r.get('result',{}).get('value','')
if data: open('$EVIDENCE/tc-401_agent-scan.png','wb').write(base64.b64decode(data)); print('saved')
"
python3 "$ZAI" ui-diff "$EVIDENCE/baselines/design-agent.png" "$EVIDENCE/tc-401_agent-scan.png" "对比 Agent 扫描区域。列出差异。"
```

**回退影响**: 无。
**严重程度**: 阻塞

---

### TC-4-02: Agent 扫描执行

**测试目标**: WS config.scanAgents → config.scannedAgents，结果列表渲染。

**前置条件**: TC-4-01 通过。

**验证**:

#### Layer 1: WS 协议
```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'config.scanAgents', id: 'tc402', payload: { sources: ['~/.pi/agent/agents/'] } }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.scannedAgents') {
    console.log('success:', msg.payload.success);
    console.log('agents count:', (msg.payload.agents || []).length);
    if (msg.payload.agents && msg.payload.agents.length > 0) {
      const a = msg.payload.agents[0];
      console.log('first:', JSON.stringify({id:a.id,name:a.name,sourceType:a.sourceType,alreadyImported:a.alreadyImported}));
    }
    ws.close();
  }
});
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);
"
```

#### Layer 2: DOM/A11y 验证
```bash
# 点击扫描按钮
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var btns=document.querySelectorAll(\"button\");var scan=Array.from(btns).find(function(b){return b.textContent.includes(\"扫描\")});if(scan)scan.click();return \"clicked\"})()"}'
sleep 3

# 检查 checkbox 出现
node "$CDP" "$ELECTRON_WS" Accessibility.getFullAXTree '{}' | python3 -c "
import sys, json
raw = json.load(sys.stdin)
cbs = [n for n in raw.get('result',{}).get('nodes',[]) if n.get('role',{}).get('value','') == 'checkbox']
print(f'checkbox count: {len(cbs)}')
assert len(cbs) > 0, 'FAIL: no scan results'
print('PASS')
"
```

**回退影响**: 只读操作。
**严重程度**: 阻塞

---

### TC-4-03: Agent 导入

**测试目标**: WS config.setAgent，DOM section 出现，agents.json 持久化。

**前置条件**: TC-4-02 通过。

**验证**:

#### Layer 1: WS 协议
```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
const agent = {
  id: 'test-agent-' + Date.now(),
  name: 'test-agent',
  description: 'E2E test agent',
  enabled: true,
  modelStrategy: 'auto',
};
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'config.setAgent', id: 'tc403', payload: { agent } }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.agentUpdated') console.log('agentUpdated:', JSON.stringify(msg.payload));
  if (msg.type === 'config.agents') { console.log('agents count:', msg.payload.agents.length); ws.close(); }
});
setTimeout(() => process.exit(1), 10000);
"
```

#### Layer 2: DOM/A11y 验证
```bash
sleep 1
node "$CDP" "$ELECTRON_WS" Accessibility.getFullAXTree '{}' | python3 -c "
import sys, json
raw = json.load(sys.stdin)
for n in raw.get('result',{}).get('nodes',[]):
    name = n.get('name',{}).get('value','')
    if 'test-agent' in (name or ''): print(f'FOUND: {n.get(\"role\",{}).get(\"value\",\"\")} \"{name}\"')
"
```

#### Layer 4: 文件验证
```bash
[ -f "$AGENTS_JSON" ] || { echo "FAIL: agents.json not found"; exit 1; }
python3 -c "import json; agents=json.load(open('$AGENTS_JSON')); print(f'agents.json: {len(agents)} items')"
```

**回退影响**: agents.json 新增记录。
**严重程度**: 阻塞

---

### TC-4-04: Agent Toggle

**测试目标**: toggle 切换 agent 启停，opacity 变化。

**前置条件**: TC-4-03 通过。

**验证**:

#### Layer 1: WS 协议
```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.agentUpdated') console.log('updated:', JSON.stringify(msg.payload));
  if (msg.type === 'config.agents') { console.log('count:', msg.payload.agents.length); ws.close(); }
});
setTimeout(() => process.exit(0), 10000);
"
```

#### Layer 2: DOM/A11y 验证
```bash
# 点击 toggle
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".border.rounded-lg.mb-3\");for(var i=0;i<sections.length;i++){var h=sections[i].querySelector(\".text-\\[13px\\].font-semibold\");if(h&&h.textContent.includes(\"test-agent\")){sections[i].querySelector(\"[role=\\\"switch\\\"]").click();return \"toggled\"}}return \"not found\"})()"}'
sleep 0.3
# 检查 opacity
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".border.rounded-lg.mb-3\");for(var i=0;i<sections.length;i++){if(sections[i].classList.contains(\"opacity-60\"))return \"has opacity-60\"}return \"no opacity\"})()"}'
# 恢复
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".border.rounded-lg.mb-3\");for(var i=0;i<sections.length;i++){var h=sections[i].querySelector(\".text-\\[13px\\].font-semibold\");if(h&&h.textContent.includes(\"test-agent\")){sections[i].querySelector(\"[role=\\\"switch\\\"]").click();return \"restored\"}}return \"not found\"})()"}'
```

**回退影响**: 恢复 toggle 状态。
**严重程度**: 一般

---

### TC-4-05: Agent 删除 confirm-bar

**测试目标**: 删除 → 红色 confirm-bar → 取消 → bar 消失 → 确认删除 → section 移除。

**前置条件**: TC-4-03 通过。

**验证**:

#### Layer 1: WS 协议
```bash
AGENT_ID=$(python3 -c "import json; agents=json.load(open('$AGENTS_JSON')); print(agents[-1]['id'])")
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'config.deleteAgent', id: 'tc405', payload: { agentId: '$AGENT_ID' } }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.agentDeleted') console.log('deleted:', JSON.stringify(msg.payload));
  if (msg.type === 'config.agents') { console.log('remaining:', msg.payload.agents.length); ws.close(); }
});
setTimeout(() => process.exit(1), 10000);
"
```

#### Layer 2: DOM/A11y 验证（confirm-bar 交互）
```bash
# 点击删除按钮
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".border.rounded-lg.mb-3\");var last=sections[sections.length-1];var btns=last.querySelectorAll(\"button\");var del=Array.from(btns).find(function(b){return b.textContent.trim()===\"删除\"});if(del)del.click();return \"clicked delete\"})()"}'
sleep 0.3

# 检查 confirm-bar 出现
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var bar=document.querySelector(\".bg-\\\\[var\\\\(--danger-light\\\\)\\\\]\");return bar?\"CONFIRM_BAR_VISIBLE\":\"NO_CONFIRM_BAR\"})()"}'

# 截图 confirm-bar
node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png"}' | python3 -c "
import sys,json,base64
r = json.load(sys.stdin)
data = r.get('result',{}).get('value','')
if data: open('$EVIDENCE/tc-405_confirm-bar.png','wb').write(base64.b64decode(data)); print('saved')
"

# 取消
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var btns=document.querySelectorAll(\"button\");var cancel=Array.from(btns).find(function(b){return b.textContent.trim()===\"取消\"});if(cancel)cancel.click();return \"cancelled\"})()"}'
sleep 0.3

# 再次删除并确认
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".border.rounded-lg.mb-3\");var last=sections[sections.length-1];var btns=last.querySelectorAll(\"button\");var del=Array.from(btns).find(function(b){return b.textContent.trim()===\"删除\"});if(del)del.click();return \"clicked\"})()"}'
sleep 0.3
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var btns=document.querySelectorAll(\"button\");var confirm=Array.from(btns).find(function(b){return b.textContent.includes(\"确认删除\")});if(confirm)confirm.click();return \"confirmed\"})()"}'
sleep 1

# 检查 section 移除
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"document.querySelectorAll(\".border.rounded-lg.mb-3\").length"}'
```

#### Layer 4: 文件验证
```bash
python3 -c "import json; agents=json.load(open('$AGENTS_JSON')); print(f'remaining agents: {len(agents)}')"
```

**回退影响**: 删除一条 agent。
**严重程度**: 重要

---

### TC-4-06: Agent 策略切换

**测试目标**: 切换模型策略 select，WS config.setAgent { modelStrategy }, agents.json 更新。

**前置条件**: TC-4-03 通过（需保留至少 1 个 agent）。

**验证**:

#### Layer 1: WS 协议
```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.agentUpdated') console.log('updated:', JSON.stringify(msg.payload));
  if (msg.type === 'config.agents') { console.log('count:', msg.payload.agents.length); ws.close(); }
});
setTimeout(() => process.exit(0), 10000);
"
```

#### Layer 2: DOM/A11y 验证
```bash
# 找到策略 select 并切换
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var selects=document.querySelectorAll(\"select\");if(selects.length===0)return \"NO_SELECT\";selects[0].value=\"tag\";selects[0].dispatchEvent(new Event(\"change\",{bubbles:true}));return \"changed to tag\"})()"}'
sleep 0.5

# 检查恢复
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var selects=document.querySelectorAll(\"select\");if(selects.length===0)return \"NO_SELECT\";selects[0].value=\"auto\";selects[0].dispatchEvent(new Event(\"change\",{bubbles:true}));return \"restored to auto\"})()"}'
```

#### Layer 4: 文件验证
```bash
python3 -c "
import json
agents = json.load(open('$AGENTS_JSON'))
if agents:
    print(f'agent modelStrategy: {agents[0].get(\"modelStrategy\",\"?\")}')
"
```

**回退影响**: 恢复为 auto。
**严重程度**: 重要
