# G2: Provider Tab 重设计（5 TC | L1+L2+L3+L4 | 依赖 G1）

> 依赖：G1 全部通过（Settings 窗口打开 + Sidebar 渲染 + Tab 切换正常）。
> 前置条件：至少有 1 个已配置的 provider。

---

### TC-2-01: Provider Section 渲染

**测试目标**: 验证每个 provider 以 Section Groups 风格渲染（圆角卡片、header 底色、model rows 平铺）。

**前置条件**: G1 通过，至少有 1 个已配置 provider。

**测试步骤**:

1. 切换到 Provider tab
2. WS 发送 `config.getProviders` 获取 provider 列表
3. 检查 A11y tree 中 provider heading + switch 元素
4. 检查 DOM section 样式（rounded-lg、section-bg）
5. 截图与设计稿 Provider 区域做 ui-diff

**验证**:

#### Layer 1: WS 协议
```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'config.getProviders', id: 'tc201', payload: {} }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.providers') {
    const providers = msg.payload.providers;
    console.log('providers count:', providers.length);
    console.assert(Array.isArray(providers), 'providers must be array');
    providers.forEach(p => {
      console.log('  -', p.id, p.name, p.status, 'models:', (p.models || []).length);
    });
    ws.close();
  }
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 10000);
"
```

#### Layer 2: DOM/A11y 验证
```bash
# 切换到 Provider tab
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var items=document.querySelectorAll(\".sidebar-item\");var p=Array.from(items).find(function(e){return e.textContent.includes(\"Provider\")});if(p)p.click();return \"clicked\"})()"}'
sleep 0.5

# A11y: 检查 switch 和 heading 元素
node "$CDP" "$ELECTRON_WS" Accessibility.getFullAXTree '{}' | python3 -c "
import sys, json
raw = json.load(sys.stdin)
switches = 0
headings = []
for n in raw.get('result',{}).get('nodes',[]):
    role = n.get('role',{}).get('value','')
    name = n.get('name',{}).get('value','')
    if role == 'switch': switches += 1
    if role == 'heading' and name: headings.append(name)
print(f'switches: {switches}')
print(f'headings: {headings[:5]}')
assert switches > 0, 'FAIL: no switch elements found'
print('PASS: switch and heading elements found')
"

# DOM: 检查 section 样式类
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var s=document.querySelector(\".border.rounded-lg\");if(!s)return \"NO_SECTION\";return JSON.stringify({roundedLg:s.classList.contains(\"rounded-lg\"),border:s.classList.contains(\"border\"),overflowHidden:s.classList.contains(\"overflow-hidden\")})})()"}'
# 期望: { roundedLg: true, border: true, overflowHidden: true }
```

#### Layer 3: 视觉对比
```bash
mkdir -p "$EVIDENCE"

# 截图实际 Provider tab
node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "
import sys,json,base64
r = json.load(sys.stdin)
data = r.get('result',{}).get('value','')
if data: open('$EVIDENCE/tc-201_actual-provider.png','wb').write(base64.b64decode(data)); print('saved')
"

# AI 视觉对比（与设计稿 Provider 区域截图对比）
python3 "$ZAI" ui-diff \
  "$EVIDENCE/baselines/design-provider.png" \
  "$EVIDENCE/tc-201_actual-provider.png" \
  "对比 Provider tab：检查 section 是否有 8px 圆角、header 是否有浅底色、model rows 是否平铺。列出所有差异。"
```

#### Layer 4: 文件验证
不适用

**回退影响**: 失败则跳过 TC-2-02~TC-2-05。
**严重程度**: 阻塞

---

### TC-2-02: Provider Toggle 启停

**测试目标**: 点击 toggle switch 后 provider 启停切换，section opacity 变化。

**前置条件**: TC-2-01 通过。

**验证**:

#### Layer 1: WS 协议
```bash
# 在另一个终端监听 WS，捕获 config.setProvider
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.setProvider') console.log('CAPTURED:', JSON.stringify(msg.payload));
  if (msg.type === 'config.providers') { console.log('broadcast count:', msg.payload.providers.length); ws.close(); }
});
setTimeout(() => process.exit(0), 10000);
"
```

#### Layer 2: DOM/A11y 验证
```bash
# 点击第一个 section 的 toggle switch
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var s=document.querySelector(\".border.rounded-lg\");if(!s)return \"NO_SECTION\";var sw=s.querySelector(\"[role=\\\"switch\\\"]");if(!sw)return \"NO_SWITCH\";sw.click();return \"clicked\"})()"}'
sleep 0.3

# 检查 section opacity
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var s=document.querySelector(\".border.rounded-lg\");return JSON.stringify({hasOpacity50:s.classList.contains(\"opacity-50\"),opacity:getComputedStyle(s).opacity})})()"}'
# 期望: opacity = "0.5" 或 hasOpacity50 = true

# 恢复
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var s=document.querySelector(\".border.rounded-lg\");var sw=s.querySelector(\"[role=\\\"switch\\\"]");sw.click();return \"restored\"})()"}'
```

#### Layer 3: 视觉对比
```bash
# 截图 toggle OFF 状态
node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png"}' | python3 -c "
import sys,json,base64
r = json.load(sys.stdin)
data = r.get('result',{}).get('value','')
if data: open('$EVIDENCE/tc-202_toggle-off.png','wb').write(base64.b64decode(data)); print('saved')
"
```

**回退影响**: 无。
**严重程度**: 重要

---

### TC-2-03: Provider 编辑 Modal

**测试目标**: 点击编辑弹出 Modal，修改后保存，WS 发送 config.setProvider。

**前置条件**: TC-2-01 通过。

**验证**:

#### Layer 1: WS 协议
```bash
# 监听 WS（同 TC-2-02）
```

#### Layer 2: DOM/A11y 验证
```bash
# 点击编辑按钮
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var btns=document.querySelectorAll(\"button\");var edit=Array.from(btns).find(function(b){return b.textContent.trim()===\"编辑\"});if(edit)edit.click();return \"clicked\"})()"}'
sleep 0.3

# 检查 Modal 出现
node "$CDP" "$ELECTRON_WS" Accessibility.getFullAXTree '{}' | python3 -c "
import sys, json
raw = json.load(sys.stdin)
for n in raw.get('result',{}).get('nodes',[]):
    role = n.get('role',{}).get('value','')
    name = n.get('name',{}).get('value','')
    if role == 'dialog' or 'modal' in (n.get('name',{}).get('value','').lower() if n.get('name',{}).get('value','') else ''):
        print(f'FOUND: {role} {name}')
"

# 关闭 Modal
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var overlay=document.querySelector(\"[data-modal-overlay]\");if(overlay){var btn=overlay.querySelector(\"button\");if(btn)btn.click()}return \"closed\"})()"}'
```

**回退影响**: 无。
**严重程度**: 重要

---

### TC-2-04: Provider 删除

**测试目标**: 点击删除后 section 移除，WS 发送 config.deleteProvider，config.json 更新。

**前置条件**: TC-2-01 通过，至少 2 个 provider。

**验证**:

#### Layer 1: WS 协议
```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.deleteProvider') console.log('CAPTURED delete:', JSON.stringify(msg.payload));
  if (msg.type === 'config.providers') { console.log('remaining:', msg.payload.providers.length); ws.close(); }
});
setTimeout(() => process.exit(0), 10000);
"
```

#### Layer 2: DOM/A11y 验证
```bash
# 记录删除前数量
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"document.querySelectorAll(\".border.rounded-lg\").length"}'

# 点击最后一个 section 的删除按钮
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".border.rounded-lg\");if(sections.length<2)return \"NEED_2\";var last=sections[sections.length-1];var btns=last.querySelectorAll(\"button\");var del=Array.from(btns).find(function(b){return b.textContent.trim()===\"删除\"});if(del)del.click();return \"clicked\"})()"}'
sleep 0.5

# 检查数量减少
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"document.querySelectorAll(\".border.rounded-lg\").length"}'
```

#### Layer 4: 文件验证
```bash
CONFIG_FILE="$HOME/.xyz-agent/config.json"
python3 -c "
import json
config = json.load(open('$CONFIG_FILE'))
providers = config.get('providers', {})
print(f'remaining providers: {len(providers)}')
for pid, p in providers.items(): print(f'  - {pid}: {p.get(\"name\",\"\")}')
"
```

**回退影响**: 删除了一个 provider，需手动恢复。
**严重程度**: 重要

---

### TC-2-05: Model Row Toggle（乐观更新 + 协议 + 持久化）

**测试目标**: 点击 model row toggle 后：(1) UI 乐观更新（立即变半透明），(2) WS 发送 model.toggle，(3) sidecar 回复 model.toggled + 广播 model.list，(4) config.json 持久化 enabled 字段。

**前置条件**: TC-2-01 通过。

**验证**:

#### Layer 1: WS 协议（model.toggle + model.toggled）
```bash
cd src-electron && node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
const events = [];
let modelInfo = null;

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  events.push(msg.type);

  if (msg.type === 'model.list' && !modelInfo && msg.payload.models.length > 0) {
    modelInfo = msg.payload.models[0];
    console.log('Toggle target:', modelInfo.id, 'provider:', modelInfo.providerId, 'current enabled:', modelInfo.enabled);

    ws.send(JSON.stringify({
      type: 'model.toggle',
      id: 'tc205',
      payload: { providerId: modelInfo.providerId, modelId: modelInfo.id, enabled: false }
    }));
  }

  if (msg.type === 'model.toggled') {
    console.log('model.toggled:', JSON.stringify(msg.payload));
    if (msg.payload.success !== true) { console.log('FAIL: expected success=true'); process.exit(1); }
    if (msg.payload.enabled !== false) { console.log('FAIL: expected enabled=false'); process.exit(1); }
  }

  if (msg.type === 'model.list' && events.filter(t => t === 'model.list').length === 2) {
    const m = msg.payload.models.find(m => m.id === modelInfo.id && m.providerId === modelInfo.providerId);
    if (m && m.enabled === false) {
      console.log('PASS: model.list broadcast confirmed enabled=false');
    } else {
      console.log('FAIL: model not updated, enabled=', m?.enabled);
      process.exit(1);
    }

    ws.send(JSON.stringify({
      type: 'model.toggle',
      id: 'tc205-restore',
      payload: { providerId: modelInfo.providerId, modelId: modelInfo.id, enabled: true }
    }));
  }

  if (msg.type === 'model.toggled' && events.filter(t => t === 'model.toggled').length === 2) {
    console.log('Restored. All PASS');
    ws.close();
  }
});

setTimeout(() => { console.log('Events:', [...new Set(events)].join(', ')); ws.close(); process.exit(0); }, 10000);
"
```

#### Layer 2: DOM/A11y 验证（乐观更新）
```bash
ELECTRON_WS=$(curl -s http://localhost:9333/json/list | python3 -c "import sys,json; tabs=json.load(sys.stdin); m=[t for t in tabs if '1420' in t.get('url','')]; print(m[0]['webSocketDebuggerUrl'])")
CDP=~/.pi/agent/skills/chrome-automation/scripts/cdp.js

# 确保在 Provider tab
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var items=document.querySelectorAll(\'.sidebar-item\');var p=Array.from(items).find(function(e){return e.textContent.includes(\'Provider\')||e.textContent.includes(\'供应商\')});if(p)p.click();return \'clicked\'})()"}'
sleep 0.5

# 点击第一个 model row 的 toggle
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var rows=document.querySelectorAll(\'.flex.items-center.gap-2\\.5\');for(var i=0;i<rows.length;i++){var sw=rows[i].querySelector(\'[role=\"switch\"]\');if(sw){sw.click();return \'clicked\'}}return \'NO_TOGGLE\'})()"}'
sleep 0.2

# 检查乐观更新（opacity-50）
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var rows=document.querySelectorAll(\'.flex.items-center.gap-2\\.5\');for(var i=0;i<rows.length;i++){if(rows[i].classList.contains(\'opacity-50\'))return JSON.stringify({index:i,opacity:getComputedStyle(rows[i]).opacity})}return \'none\'})()"}'
# 期望: opacity = "0.5"

# 恢复
sleep 1
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var rows=document.querySelectorAll(\'.flex.items-center.gap-2\\.5\');for(var i=0;i<rows.length;i++){var sw=rows[i].querySelector(\'[role=\"switch\"]\');if(sw){sw.click();return \'restored\'}}return \'none\'})()"}'
```

#### Layer 4: config.json 持久化
```bash
CONFIG_FILE=~/.xyz-agent/config.json
python3 -c "
import json
config = json.load(open('$CONFIG_FILE'))
found = False
for pid, prov in config['providers'].items():
    models = prov.get('models', [])
    for m in models:
        if isinstance(m, dict) and 'enabled' in m:
            print(f'  {pid}/{m[\"id\"]}: enabled={m[\"enabled\"]}')
            found = True
if found:
    print('PASS: enabled field present in config.json')
else:
    print('INFO: no enabled fields found (models may not have been toggled yet)')
"
```

**回退影响**: toggle 后会恢复原始状态。
**严重程度**: 重要

---

### TC-2-06: ProviderModal 保存保留 Model Enabled 状态

**测试目标**: 先 toggle 一个 model 为 disabled，然后打开 ProviderModal 保存（不做任何修改），验证 model 的 disabled 状态不丢失。

**前置条件**: TC-2-05 通过。

**验证**:

#### Step 1: Toggle model 为 disabled（L1）
```bash
cd src-electron && node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
let targetModel = null;
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'model.list' && msg.payload.models.length > 0 && !targetModel) {
    targetModel = msg.payload.models[0];
    ws.send(JSON.stringify({
      type: 'model.toggle',
      id: 'tc206-disable',
      payload: { providerId: targetModel.providerId, modelId: targetModel.id, enabled: false }
    }));
  }
  if (msg.type === 'model.toggled' && msg.payload.success) {
    console.log('Disabled model:', msg.payload.modelId);
    ws.close();
  }
});
setTimeout(() => process.exit(1), 8000);
"
```

#### Step 2: 打开并关闭 ProviderModal（L2 DOM 操作）
```bash
ELECTRON_WS=$(curl -s http://localhost:9333/json/list | python3 -c "import sys,json; tabs=json.load(sys.stdin); m=[t for t in tabs if '1420' in t.get('url','')]; print(m[0]['webSocketDebuggerUrl'])")
CDP=~/.pi/agent/skills/chrome-automation/scripts/cdp.js

# 点击编辑按钮
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var btns=document.querySelectorAll(\'button\');var edit=Array.from(btns).find(function(b){return b.textContent.trim()===\'编辑\'||b.textContent.trim()===\'Edit\'});if(edit){edit.click();return \'opened\'}return \'no edit btn\'})()"}'
sleep 1

# 直接保存
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var btns=document.querySelectorAll(\'button\');var save=Array.from(btns).find(function(b){return b.textContent.includes(\'保存\')||b.textContent.includes(\'Save\')});if(save){save.click();return \'saved\'}return \'no save btn\'})()"}'
sleep 2
```

#### Step 3: 验证 model 仍为 disabled（L1 + L4）
```bash
# L1: WS 广播
cd src-electron && node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'model.list') {
    const m = msg.payload.models[0];
    if (m.enabled === false) {
      console.log('PASS: model still disabled after modal save');
    } else {
      console.log('FAIL: model enabled was lost, enabled=', m.enabled);
      process.exit(1);
    }
    ws.close();
  }
});
setTimeout(() => process.exit(1), 5000);
"

# 恢复
cd src-electron && node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'model.list' && msg.payload.models.length > 0) {
    const m = msg.payload.models[0];
    ws.send(JSON.stringify({ type: 'model.toggle', id: 'restore', payload: { providerId: m.providerId, modelId: m.id, enabled: true } }));
  }
  if (msg.type === 'model.toggled') { console.log('Restored'); ws.close(); }
});
setTimeout(() => process.exit(0), 5000);
"
```

**回退影响**: 恢复 model 为 enabled。
**严重程度**: 重要

---

## G2 执行清单

| TC | 依赖 | L1 | L2 | L3 | L4 | 关键验证 |
|----|------|----|----|----|----|---------|
| TC-2-01 | G1 | ✅ | ✅ | ✅ | - | Provider Section 渲染 |
| TC-2-02 | TC-2-01 | ✅ | ✅ | ✅ | - | Provider Toggle |
| TC-2-03 | TC-2-01 | ✅ | ✅ | - | ✅ | Provider 编辑 Modal |
| TC-2-04 | TC-2-01 | ✅ | ✅ | ✅ | ✅ | Provider 删除 |
| TC-2-05 | TC-2-01 | ✅ | ✅ | - | ✅ | Model Row Toggle（model.toggle + 乐观更新 + 持久化） |
| TC-2-06 | TC-2-05 | ✅ | ✅ | - | ✅ | ProviderModal 保存保留 Model Enabled |
