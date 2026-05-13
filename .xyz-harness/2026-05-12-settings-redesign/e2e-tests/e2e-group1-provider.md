# E2E 测试 — Group 1: Provider Tab

> **依赖**: Group 0 全部通过（WS 连通、初始广播、Settings 页面渲染正常、CDP 连通）
> **覆盖组件**: `ProviderSection.vue`、`ProviderPane.vue`、`ModelRow.vue`、`ProviderModal.vue`
> **验证维度**: 每个 TC 包含协议层 + DOM 层 + 视觉层（如适用）三层验证

---

## 环境变量（所有 TC 共用）

```bash
# CDP 连接
WS_URL=$(curl -s http://localhost:9222/json/list | python3 -c "import sys,json; tabs=json.load(sys.stdin); print([t for t in tabs if 'localhost:1420' in t.get('url','')][0]['webSocketDebuggerUrl'])")
CDP="/Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js"

# 截图 & 视觉对比
SCREENSHOT_DIR="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots"
ZAI_VISION="python3 /Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py"

# 验证 CDP 连通
node "$CDP" "$WS_URL" Runtime.evaluate '{"expression":"document.title","returnByValue":true}'
```

## 前置条件

1. **Group 0 全部通过**（TC-0.1 ~ TC-0.6 均为 PASS）
2. Sidecar 运行在 `ws://localhost:3210`，健康检查通过
3. Electron 已启动，Vite dev server 在 `:1420`，remote debugging 端口 `9222`
4. Settings 页面已打开，Provider tab 可见
5. `~/.xyz-agent/config.json` 中至少存在 1 个 Provider

### 测试数据快照（执行前记录）

```bash
cat ~/.xyz-agent/config.json | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
providers = cfg.get('providers', {})
print(f'Provider 总数: {len(providers)}')
for pid, p in providers.items():
    enabled = p.get('enabled', True)
    models = p.get('models', [])
    print(f'  {pid} ({p.get(\"name\", \"?\")}): enabled={enabled}, models={len(models)}')
"
```

### 导航到 Provider Tab

```bash
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var items=document.querySelectorAll(\".sidebar-item\");var p=Array.from(items).find(function(e){return e.textContent.includes(\"Provider\")});if(p)p.click();return \"clicked\"})()"}'
```

---

## TC-1.1: Provider Section 渲染验证

### 目标

确认已有 Provider 以 Section Groups 风格渲染：圆角卡片、header 有底色、model rows 平铺在 body 中。

### 前置条件

- TC-0.3 通过（初始广播 `config.providers` 成功）
- TC-0.6 通过（Settings 页面渲染成功，Provider tab 可见）

### 测试步骤

#### 协议验证

发送 `config.getProviders`，确认返回 providers 数组：

```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'config.getProviders', payload: {} }));
});
const results = [];
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  results.push(msg);
  if (msg.type === 'config.providers') {
    const providers = msg.payload?.providers;
    console.log('type:', msg.type);
    console.log('providers is array:', Array.isArray(providers));
    console.log('providers count:', Array.isArray(providers) ? providers.length : 'N/A');
    if (Array.isArray(providers) && providers.length > 0) {
      const p = providers[0];
      console.log('first provider:', JSON.stringify({ id: p.id, name: p.name, enabled: p.enabled, modelCount: (p.models || []).length }));
    }
    ws.close();
  }
});
setTimeout(() => { console.error('TIMEOUT. Received types:', results.map(m=>m.type)); process.exit(1); }, 10000);
"
```

#### DOM 验证

检查 `.section` 容器存在，header 有 section-bg 底色，有 model rows：

```bash
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".border.rounded-lg\");var result={sectionCount:sections.length,sections:[]};for(var i=0;i<sections.length;i++){var s=sections[i];var header=s.querySelector(\".bg-\\[var\\\\28--section-bg\\\\29\\\"]\")||s.querySelector(\"[class*=section-bg]\");var nameEl=s.querySelector(\".text-\\[13px\\].font-semibold\");var modelRows=s.querySelectorAll(\".flex.items-center\");var toggle=s.querySelector(\"[role=\\\"switch\\\"]\");var avatar=s.querySelector(\".w-\\[30px\\]\");result.sections.push({hasHeader:!!header,hasToggle:!!toggle,hasAvatar:!!avatar,providerName:nameEl?nameEl.textContent.trim():null,modelRowCount:modelRows.length,borderRadius:getComputedStyle(s).borderRadius,overflow:getComputedStyle(s).overflow,marginBottom:getComputedStyle(s).marginBottom})}return JSON.stringify(result})()"}'
```

#### 视觉验证

截图并与设计稿对比：

```bash
# 截图：Provider tab 全页
node "$CDP" "$WS_URL" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SCREENSHOT_DIR/actual-provider-tab.png','wb').write(base64.b64decode(data)) if data else print('fail')"

# 视觉对比
python3 /Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py ui-diff "$SCREENSHOT_DIR/expected-provider-tab.png" "$SCREENSHOT_DIR/actual-provider-tab.png" "对比 Provider tab 整体布局：section 圆角 8px、header 浅底色、model rows 平铺、hover border 变深"
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| 协议: providers 数组 | `Array.isArray(providers) === true`，长度 ≥ 1 |
| 协议: provider 字段 | 包含 `id`, `name`, `enabled`, `models` |
| DOM: section 容器数量 | ≥ 1，与 config.json 中 providers 数量一致 |
| DOM: section 样式 | `borderRadius: 8px`，`overflow: hidden`，有 `mb-3` |
| DOM: header 底色 | 存在 `section-bg` class，`backgroundColor` 非透明 |
| DOM: header 内容 | toggle + avatar + provider name + status dot + url + model badge + 编辑/删除按钮 |
| DOM: body model rows | 数量与该 Provider 的 models 数组长度一致 |
| 视觉: section 风格 | 圆角卡片、header 浅底色、model rows 平铺 |
| 视觉: hover 效果 | hover 时 border 变深（需鼠标 hover 后截图验证） |

### 实际结果

| 验证层 | 结果 | 详细记录 |
|--------|------|----------|
| 协议 | ⬜ PASS / ⬜ FAIL | |
| DOM | ⬜ PASS / ⬜ FAIL | |
| 视觉 | ⬜ PASS / ⬜ FAIL | |

---

## TC-1.2: Provider Toggle 启停

### 目标

点击 toggle 后 Provider 启停切换，section 整体 opacity 变化，WS 发出 `config.setProvider` 消息。

### 前置条件

- TC-1.1 通过（Provider section 正常渲染）
- 至少 1 个 Provider 当前为启用状态

### 测试步骤

#### 协议验证

启动 WS 监听，捕获 `config.setProvider` 消息：

```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
console.log('WS 监听已启动，等待 config.setProvider 消息...');
ws.on('message', (data) => {
  var msg = JSON.parse(data.toString());
  if (msg.type === 'config.setProvider' || msg.type === 'config.providers') {
    console.log(JSON.stringify({ type: msg.type, payload: msg.payload }));
  }
});
ws.on('close', function() { process.exit(0); });
setTimeout(function() { console.log('TIMEOUT: 15s 内未收到消息'); ws.close(); }, 15000);
" 2>&1 | tee /tmp/ws-tc1.2.log &
WS_PID=$!
echo "WS 监听 PID: $WS_PID"
```

点击 toggle：

```bash
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var section=document.querySelector(\".border.rounded-lg\");var toggle=section.querySelector(\"[role=\\\"switch\\\"]\");if(toggle){toggle.click();return \"CLICKED_TOGGLE\"}return \"TOGGLE_NOT_FOUND\"})()"}'
```

等待 2 秒后检查 WS 消息：

```bash
sleep 2
cat /tmp/ws-tc1.2.log
kill $WS_PID 2>/dev/null
```

#### DOM 验证

点击前记录初始状态：

```bash
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var section=document.querySelector(\".border.rounded-lg\");return JSON.stringify({hasOpacity50:before:section.classList.contains(\"opacity-50\"),classes:before:section.className})})()"}'
```

点击 toggle 后验证 opacity 变化：

```bash
# 先点击
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var section=document.querySelector(\".border.rounded-lg\");var toggle=section.querySelector(\"[role=\\\"switch\\\"]\");if(toggle){toggle.click();return \"CLICKED\"}return \"NO_TOGGLE\"})()"}'

# 等待动画
sleep 0.3

# 检查 opacity 变化
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var section=document.querySelector(\".border.rounded-lg\");return JSON.stringify({hasOpacity50:section.classList.contains(\"opacity-50\"),classes:section.className})})()"}'
```

#### 视觉验证

截图 toggle 前后对比：

```bash
# 截图：toggle 前（恢复到 enabled 状态）
node "$CDP" "$WS_URL" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SCREENSHOT_DIR/tc1.2-before-toggle.png','wb').write(base64.b64decode(data)) if data else print('fail')"

# 执行 toggle
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var section=document.querySelector(\".border.rounded-lg\");var toggle=section.querySelector(\"[role=\\\"switch\\\"]\");if(toggle){toggle.click();return \"CLICKED\"}return \"NO_TOGGLE\"})()"}'
sleep 0.5

# 截图：toggle 后
node "$CDP" "$WS_URL" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SCREENSHOT_DIR/tc1.2-after-toggle.png','wb').write(base64.b64decode(data)) if data else print('fail')"

# 视觉对比
python3 /Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py ui-diff "$SCREENSHOT_DIR/tc1.2-before-toggle.png" "$SCREENSHOT_DIR/tc1.2-after-toggle.png" "对比 Provider toggle 前后：期望 toggle 后 section 整体变为半透明（opacity-50）"
```

**恢复初始状态**：

```bash
# 再次点击 toggle 恢复
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var section=document.querySelector(\".border.rounded-lg\");var toggle=section.querySelector(\"[role=\\\"switch\\\"]\");if(toggle){toggle.click();return \"RESTORED\"}return \"NO_TOGGLE\"})()"}'
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| 协议: WS 消息 | 收到 `config.setProvider`，payload 含 `enabled: false` |
| 协议: sidecar 响应 | 广播 `config.providers` 更新列表 |
| DOM: 点击前 | section 无 `opacity-50` class |
| DOM: 点击后 | section 添加 `opacity-50` class |
| 视觉: toggle 后 | section 整体半透明 |

### 实际结果

| 验证层 | 结果 | 详细记录 |
|--------|------|----------|
| 协议 | ⬜ PASS / ⬜ FAIL | |
| DOM | ⬜ PASS / ⬜ FAIL | |
| 视觉 | ⬜ PASS / ⬜ FAIL | |

---

## TC-1.3: Provider 编辑 Modal

### 目标

编辑按钮弹出 `ProviderModal`，可修改 Provider 名称后保存，WS 发送 `config.setProvider` 消息。

### 前置条件

- TC-1.1 通过
- 至少 1 个 Provider 可供编辑

> **注意**: Modal 样式未重设计，本 TC 不需要视觉验证。

### 测试步骤

#### 协议验证

启动 WS 监听：

```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
console.log('WS 监听已启动，等待编辑保存消息...');
ws.on('message', (data) => {
  var msg = JSON.parse(data.toString());
  if (msg.type.includes('Provider') || msg.type.includes('provider')) {
    console.log(JSON.stringify({ type: msg.type, payload: msg.payload }));
  }
});
ws.on('close', function() { process.exit(0); });
setTimeout(function() { console.log('TIMEOUT'); ws.close(); }, 20000);
" 2>&1 | tee /tmp/ws-tc1.3.log &
WS_PID=$!
```

记录当前名称，点击编辑：

```bash
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var section=document.querySelector(\".border.rounded-lg\");var nameEl=section.querySelector(\".text-\\[13px\\].font-semibold\");var editBtn=Array.from(section.querySelectorAll(\"button\")).find(function(b){return b.textContent.includes(\"编辑\")});if(editBtn){var originalName=nameEl?nameEl.textContent.trim():null;editBtn.click();return JSON.stringify({action:\"CLICKED_EDIT\",originalName:originalName})}return \"EDIT_BUTTON_NOT_FOUND\"})()"}'
```

修改名称并保存：

```bash
# 等待 Modal 打开
sleep 0.5

# 修改名称输入框
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var modal=document.querySelector(\"[role=\\\"dialog\\\"]\");if(!modal)return \"MODAL_NOT_FOUND\";var nameInput=modal.querySelector(\"input[type=\\\"text\\\"]\");if(!nameInput)return \"NAME_INPUT_NOT_FOUND\";var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,\"value\").set;setter.call(nameInput,\"Router-Edited\");nameInput.dispatchEvent(new Event(\"input\",{bubbles:true}));nameInput.dispatchEvent(new Event(\"change\",{bubbles:true}));return \"NAME_CHANGED\"})()"}'

# 点击保存
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var saveBtn=Array.from(document.querySelectorAll(\"[role=\\\"dialog\\\"] button\")).find(function(b){return b.textContent.includes(\"保存\")||b.textContent.includes(\"Save\")||b.textContent.includes(\"确定\")});if(saveBtn){saveBtn.click();return \"CLICKED_SAVE\"}return \"SAVE_BUTTON_NOT_FOUND\"})()"}'
```

检查 WS 消息：

```bash
sleep 2
cat /tmp/ws-tc1.3.log
kill $WS_PID 2>/dev/null
```

**恢复原始名称**：重复上述编辑流程，将名称改回。

#### DOM 验证

检查 Modal 已弹出（`data-modal-visible` 或 `[role="dialog"]`）：

```bash
# 检查 Modal 存在
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var modal=document.querySelector(\"[role=\\\"dialog\\\"]\");if(!modal)return JSON.stringify({modalExists:false});var title=modal.querySelector(\"h2,h3\");var nameInput=modal.querySelector(\"input[type=\\\"text\\\"]\");var urlInput=modal.querySelector(\"input[placeholder*=\\\"url\\\" i]\")||modal.querySelector(\"input:nth-of-type(2)\");var keyInput=modal.querySelector(\"input[type=\\\"password\\\"]\");return JSON.stringify({modalExists:true,modalVisible:getComputedStyle(modal).display!==\"none\",modalTitle:title?title.textContent.trim():null,hasNameInput:!!nameInput,hasUrlInput:!!urlInput,hasKeyInput:!!keyInput,nameValue:nameInput?nameInput.value:null})})()"}'
```

保存后验证 Modal 已关闭、section 名称已更新：

```bash
sleep 0.5

node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var modal=document.querySelector(\"[role=\\\"dialog\\\"]\");var nameEl=document.querySelector(\".border.rounded-lg .text-\\[13px\\].font-semibold\");return JSON.stringify({modalClosed:!modal||getComputedStyle(modal).display===\"none\",updatedName:nameEl?nameEl.textContent.trim():null})})()"}'
```

#### 视觉验证

不需要（Modal 样式未重设计）。

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| 协议: 编辑保存 | WS 发送 `config.setProvider`，payload 含新名称 |
| 协议: sidecar 响应 | 广播 `config.providers` 更新列表 |
| DOM: Modal 弹出 | `[role="dialog"]` 存在且可见 |
| DOM: Modal 表单 | 包含 name / url / key 输入框 |
| DOM: 保存后关闭 | Modal 关闭，section header 名称更新 |
| DOM: 恢复验证 | 名称改回后 section 显示正确 |

### 实际结果

| 验证层 | 结果 | 详细记录 |
|--------|------|----------|
| 协议 | ⬜ PASS / ⬜ FAIL | |
| DOM | ⬜ PASS / ⬜ FAIL | |
| 视觉 | N/A | Modal 样式未重设计，跳过视觉验证 |

---

## TC-1.4: Provider 删除

### 目标

点击删除按钮后 Provider section 从 DOM 中移除，WS 发送 `config.deleteProvider` 消息，`config.json` 中对应 Provider 被删除。

### 前置条件

- TC-1.1 通过
- 至少存在 1 个 Provider

> **注意**: 本测试会删除 Provider。执行前备份 config.json。

```bash
cp ~/.xyz-agent/config.json ~/.xyz-agent/config.json.bak.tc1.4
echo "已备份 config.json"
```

### 测试步骤

#### 协议验证

启动 WS 监听：

```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
console.log('WS 监听已启动，等待删除消息...');
ws.on('message', (data) => {
  var msg = JSON.parse(data.toString());
  if (msg.type.includes('delete') || msg.type.includes('Provider') || msg.type.includes('provider')) {
    console.log(JSON.stringify({ type: msg.type, payload: msg.payload }));
  }
});
ws.on('close', function() { process.exit(0); });
setTimeout(function() { console.log('TIMEOUT'); ws.close(); }, 15000);
" 2>&1 | tee /tmp/ws-tc1.4.log &
WS_PID=$!
```

记录删除前状态并点击删除：

```bash
# 记录删除前 section 数量
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".border.rounded-lg\");var firstName=sections[0]?sections[0].querySelector(\".text-\\[13px\\].font-semibold\"):null;return JSON.stringify({sectionCountBefore:sections.length,firstProviderName:firstName?firstName.textContent.trim():null})})()"}'

# 点击删除
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var section=document.querySelector(\".border.rounded-lg\");var deleteBtn=Array.from(section.querySelectorAll(\"button\")).find(function(b){return b.textContent.includes(\"删除\")});if(deleteBtn){deleteBtn.click();return \"CLICKED_DELETE\"}return \"DELETE_BUTTON_NOT_FOUND\"})()"}'
```

> **备注**: 根据 spec，Provider 删除没有 confirm-bar（confirm-bar 仅用于 Skill/Agent），点击后直接删除。如果实际实现中有确认弹窗，需在此后点击确认。

检查 WS 消息：

```bash
sleep 2
cat /tmp/ws-tc1.4.log
kill $WS_PID 2>/dev/null
```

#### DOM 验证

检查 section 已移除：

```bash
sleep 0.3

node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".border.rounded-lg\");var emptyState=document.querySelector(\".flex.flex-col.items-center.justify-center\");return JSON.stringify({sectionCountAfter:sections.length,emptyStateVisible:!!emptyState&&getComputedStyle(emptyState).display!==\"none\",emptyStateText:emptyState?emptyState.querySelector(\".text-base\")?emptyState.querySelector(\".text-base\").textContent.trim():null:null})})()"}'
```

#### 视觉验证

截图确认移除：

```bash
node "$CDP" "$WS_URL" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SCREENSHOT_DIR/tc1.4-after-delete.png','wb').write(base64.b64decode(data)) if data else print('fail')"

python3 /Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py ui-diff "$SCREENSHOT_DIR/actual-provider-tab.png" "$SCREENSHOT_DIR/tc1.4-after-delete.png" "对比 Provider 删除前后：期望删除后 section 消失，若为最后一个 Provider 则显示空状态"
```

#### 持久化验证

检查 `config.json`：

```bash
cat ~/.xyz-agent/config.json | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
providers = cfg.get('providers', {})
print(f'Remaining providers: {len(providers)}')
for pid in providers:
    print(f'  {pid}')
"
```

**恢复测试数据**：

```bash
cp ~/.xyz-agent/config.json.bak.tc1.4 ~/.xyz-agent/config.json
rm ~/.xyz-agent/config.json.bak.tc1.4
echo "已恢复 config.json"

# 刷新页面重新加载
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"location.reload()"}'
sleep 2
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| 协议: WS 消息 | 收到 `config.deleteProvider`，payload 含 `providerId` |
| 协议: sidecar 响应 | 广播 `config.providers` 更新列表 |
| DOM: section 移除 | section 数量减少 1 |
| DOM: 空状态（若最后一个） | 显示「尚未配置任何供应商」 |
| 视觉: 截图确认 | section 已消失，布局无错位 |
| 持久化: config.json | 被删除的 Provider 键不存在 |
| 恢复: 刷新后 | Provider 列表恢复原始状态 |

### 实际结果

| 验证层 | 结果 | 详细记录 |
|--------|------|----------|
| 协议 | ⬜ PASS / ⬜ FAIL | |
| DOM | ⬜ PASS / ⬜ FAIL | |
| 视觉 | ⬜ PASS / ⬜ FAIL | |
| 持久化 | ⬜ PASS / ⬜ FAIL | |

---

## TC-1.5: Model Row Toggle

### 目标

在 Provider section body 中 toggle 单个 model，验证 WS 发送 `model.switch` 消息，model row 的 opacity class 变化。

### 前置条件

- TC-1.1 通过（Provider section 正常渲染，model rows 可见）
- Provider 下至少有 1 个已启用的 model

> **注意**: Model row toggle 是局部状态变化，不需要视觉验证。

### 测试步骤

#### 协议验证

启动 WS 监听：

```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
console.log('WS 监听已启动，等待 model.switch 消息...');
ws.on('message', (data) => {
  var msg = JSON.parse(data.toString());
  if (msg.type === 'model.switch' || msg.type.includes('model') || msg.type.includes('Model')) {
    console.log(JSON.stringify({ type: msg.type, payload: msg.payload }));
  }
});
ws.on('close', function() { process.exit(0); });
setTimeout(function() { console.log('TIMEOUT'); ws.close(); }, 15000);
" 2>&1 | tee /tmp/ws-tc1.5.log &
WS_PID=$!
```

记录初始状态并点击 model toggle：

```bash
# 记录 model rows 初始状态 + 点击第一个已启用 model 的 toggle
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var body=document.querySelector(\".border.rounded-lg\");var rows=Array.from(body.querySelectorAll(\".flex.items-center\"));var enabledRow=rows.find(function(r){return !r.classList.contains(\"opacity-50\")});if(!enabledRow)return \"NO_ENABLED_MODEL\";var toggle=enabledRow.querySelector(\"[role=\\\"switch\\\"]\");if(!toggle)return \"NO_TOGGLE\";var modelName=enabledRow.querySelector(\".font-mono.text-\\[13px\\]\");toggle.click();return JSON.stringify({action:\"CLICKED\",modelName:modelName?modelName.textContent.trim():null,beforeOpacity:enabledRow.classList.contains(\"opacity-50\")})})()"}'
```

检查 WS 消息：

```bash
sleep 2
cat /tmp/ws-tc1.5.log
kill $WS_PID 2>/dev/null
```

#### DOM 验证

验证 model row opacity 变化：

```bash
sleep 0.3

node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var body=document.querySelector(\".border.rounded-lg\");var rows=body.querySelectorAll(\".flex.items-center\");var firstRow=rows[0];var sectionOpacity=document.querySelector(\".border.rounded-lg\").classList.contains(\"opacity-50\");var rowData=[];for(var i=0;i<Math.min(rows.length,6);i++){var name=rows[i].querySelector(\".font-mono.text-\\[13px\\]\");rowData.push({index:i,name:name?name.textContent.trim():null,isDisabled:rows[i].classList.contains(\"opacity-50\")})}return JSON.stringify({sectionHasOpacity50:sectionOpacity,modelRows:rowData})})()"}'
```

**恢复 model 状态**：

```bash
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var body=document.querySelector(\".border.rounded-lg\");var rows=Array.from(body.querySelectorAll(\".flex.items-center\"));var disabledRow=rows.find(function(r){return r.classList.contains(\"opacity-50\")});if(!disabledRow)return \"NO_DISABLED_MODEL\";var toggle=disabledRow.querySelector(\"[role=\\\"switch\\\"]\");if(toggle){toggle.click();return \"RESTORED\"}return \"NO_TOGGLE\"})()"}'
```

#### 视觉验证

不需要。

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| 协议: WS 消息 | 收到 `model.switch`，payload 含 `{ modelId, enabled: false }` |
| DOM: row 变化 | 被点击的 model row 添加 `opacity-50` class |
| DOM: section 隔离 | Provider section 整体无 `opacity-50`（仅单个 model row 变化） |
| DOM: 恢复 | 二次 toggle 后 `opacity-50` 移除 |

### 实际结果

| 验证层 | 结果 | 详细记录 |
|--------|------|----------|
| 协议 | ⬜ PASS / ⬜ FAIL | |
| DOM | ⬜ PASS / ⬜ FAIL | |
| 视觉 | N/A | Model row toggle 不需要视觉验证 |

---

## 测试后清理

```bash
# 1. 恢复所有备份
if [ -f ~/.xyz-agent/config.json.bak.tc1.4 ]; then
  cp ~/.xyz-agent/config.json.bak.tc1.4 ~/.xyz-agent/config.json
  rm ~/.xyz-agent/config.json.bak.tc1.4
  echo "已恢复 config.json 并清理备份"
fi

# 2. 验证恢复后状态
cat ~/.xyz-agent/config.json | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
providers = cfg.get('providers', {})
print(f'Provider 总数: {len(providers)}')
for pid, p in providers.items():
    enabled = p.get('enabled', True)
    models = p.get('models', [])
    modelEnabled = sum(1 for m in models if m.get('enabled', True))
    print(f'  {pid}: enabled={enabled}, models={len(models)} (enabled: {modelEnabled})')
"

# 3. 清理临时文件
rm -f /tmp/ws-tc1.2.log /tmp/ws-tc1.3.log /tmp/ws-tc1.4.log /tmp/ws-tc1.5.log
```

---

## Group 1 汇总

| TC ID | 测试目标 | 协议 | DOM | 视觉 | 总体 | 阻断后续 |
|-------|---------|------|-----|------|------|----------|
| TC-1.1 | Provider Section 渲染验证 | ⬜ | ⬜ | ⬜ | ⬜ | 是 — 阻断 1.2~1.5 |
| TC-1.2 | Provider Toggle 启停 | ⬜ | ⬜ | ⬜ | ⬜ | 否 |
| TC-1.3 | Provider 编辑 Modal | ⬜ | ⬜ | N/A | ⬜ | 否 |
| TC-1.4 | Provider 删除 | ⬜ | ⬜ | ⬜ | ⬜ | 否 |
| TC-1.5 | Model Row Toggle | ⬜ | ⬜ | N/A | ⬜ | 否 |

**通过标准**: TC-1.1 必须通过，其余 TC 至少 3/4 通过。
