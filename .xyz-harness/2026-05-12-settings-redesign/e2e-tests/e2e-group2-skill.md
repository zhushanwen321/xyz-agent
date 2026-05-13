# E2E Group 2: Skill Tab 测试

> **依赖**: Group 0 (Settings 窗口打开)
> **测试用例数**: 6
> **验证层级**: 协议 + DOM + 视觉（每个 TC 三层验证）

## 公共常量

```bash
CDP="/Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js"
VISION="/Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py"
SCREENSHOT_DIR="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots"
EXPECTED_DIR="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests"
```

## 前置：切换到 Skills Tab

```bash
# 1. 获取 CDP WebSocket URL
WS_URL=$(curl -s http://localhost:9222/json/list | python3 -c "import sys,json; tabs=json.load(sys.stdin); print([t for t in tabs if 'localhost:1420' in t.get('url','')][0]['webSocketDebuggerUrl'])")
echo "WS_URL=$WS_URL"

# 2. 点击 sidebar 中的 Skill 项
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var items=document.querySelectorAll(\".sidebar-item\");var s=Array.from(items).find(function(e){return e.textContent.includes(\"Skill\")});if(s)s.click();return \"clicked\"})()"}'

# 3. 确认 tab 已激活（sidebar-item 包含 active class）
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var items=document.querySelectorAll(\".sidebar-item\");var s=Array.from(items).find(function(e){return e.textContent.includes(\"Skill\")});return s&&s.classList.contains(\"active\")})()"}'
```

---

## TC-2.1: Skill 扫描源 Chips 交互

**目标**: 验证 Skill tab 加载后，3 个 source chips 正确渲染，默认选中 Pi，计数文案显示「已选 1 个来源」

**前置**: Settings 窗口已打开，已切换到 Skill tab

### DOM 验证

```bash
# 验证 3 个 source chips 存在
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var chips=document.querySelectorAll(\".source-chip\");return {count:chips.length,labels:Array.from(chips).map(function(c){return c.textContent.trim()})}})()"}'

# 期望: { count: 3, labels: ["Pi", "Claude", "Agents"] }

# 验证 Pi chip 默认 active
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var chips=document.querySelectorAll(\".source-chip\");var piChip=Array.from(chips).find(function(c){return c.textContent.trim()===\"Pi\"});return piChip&&piChip.classList.contains(\"active\")})()"}'

# 期望: true

# 验证计数文案
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var el=document.querySelector(\".source-count\");return el?el.textContent.trim():\"not found\"})()"}'

# 期望: 包含 "已选 1 个来源" 或 "1 个来源"
```

### 视觉验证

```bash
# 截图
node "$CDP" "$WS_URL" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SCREENSHOT_DIR/actual-skill-scan.png','wb').write(base64.b64decode(data)) if data else print('fail')"

# AI 视觉对比
python3 "$VISION" --image1 "$SCREENSHOT_DIR/actual-skill-scan.png" --image2 "$EXPECTED_DIR/expected-skill-scan.png" --prompt "对比两张 Skill 扫描界面的截图。检查：1) 三个来源 chips (Pi/Claude/Agents) 是否可见 2) Pi 是否高亮/active 状态 3) 计数文案是否正确 4) 整体布局是否一致。输出 PASS 或 FAIL 并说明差异。"
```

### 结果记录

| 项目 | 期望 | 实际 |
|------|------|------|
| Source chips 数量 | 3 | |
| Chip 标签 | Pi, Claude, Agents | |
| Pi 默认 active | true | |
| 计数文案 | 「已选 1 个来源」 | |
| 视觉对比 | 与设计稿一致 | |

---

## TC-2.2: Skill 扫描执行

**目标**: 点击扫描按钮后，发送 WS `config.scanSkills`，收到 `config.scannedSkills` 响应，结果列表正确渲染

**前置**: TC-2.1 通过，Pi source chip 已选中

### 协议验证

```bash
# 方式 1: 前端 WS 拦截（在 click 前 hook）
# 注入 WS 消息监听，捕获 config.scannedSkills 响应
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){window.__e2e_skill_scan_result=null;var origSend=window.__wsSend||WebSocket.prototype.send;var _ws=null;var origAddEventListener=WebSocket.prototype.addEventListener;if(window.__wsInstance){_ws=window.__wsInstance}else{console.log(\"no ws instance captured\")}if(_ws){var origOnMsg=_ws.onmessage;_ws.onmessage=function(ev){var d=JSON.parse(ev.data);if(d.type===\"config.scannedSkills\"){window.__e2e_skill_scan_result=d}if(origOnMsg)origOnMsg.call(this,ev)}}return \"hooked\"})()"}'

# 点击扫描按钮
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var btn=document.querySelector(\".scan-btn\");if(btn)btn.click();return btn?\"clicked\":\"not found\"})()"}'

# 等待响应（扫描可能需要几秒）
sleep 3

# 读取捕获的协议响应
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var r=window.__e2e_skill_scan_result;if(!r)return \"no response captured\";return {type:r.type,success:r.payload&&r.payload.success,skillCount:r.payload&&r.payload.skills?r.payload.skills.length:0}})()"}'

# 期望: { type: "config.scannedSkills", success: true, skillCount: > 0 }
```

### DOM 验证

```bash
# 验证扫描结果列表渲染
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var items=document.querySelectorAll(\".scan-item\");return {count:items.length,firstItem:items[0]?items[0].textContent.trim().substring(0,80):\"none\"}})()"}'

# 期望: count > 0, firstItem 包含 skill 名称/描述
```

### 视觉验证

```bash
# 截图
node "$CDP" "$WS_URL" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SCREENSHOT_DIR/actual-skill-results.png','wb').write(base64.b64decode(data)) if data else print('fail')"

# AI 视觉检查
python3 "$VISION" --image "$SCREENSHOT_DIR/actual-skill-results.png" --prompt "分析这张 Skill 扫描结果界面截图。检查：1) 是否有扫描结果列表 2) 每个结果项是否包含 skill 名称、来源标签、描述等关键信息 3) 列表布局是否整齐。输出 PASS 或 FAIL。"
```

### 结果记录

| 项目 | 期望 | 实际 |
|------|------|------|
| 协议消息类型 | config.scannedSkills | |
| success | true | |
| skills 数量 | > 0 | |
| scan-item 行数 | > 0 | |
| 视觉检查 | 列表正确渲染 | |

---

## TC-2.3: Skill 导入

**目标**: 从扫描结果中导入 skill，验证 WS 协议 `config.setSkill`、DOM 已导入 section 更新、持久化文件写入

**前置**: TC-2.2 通过，扫描结果列表有可导入的 skill

### 协议验证

```bash
# Hook WS 捕获 config.skillUpdated 和 config.skills broadcast
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){window.__e2e_skill_import_result=null;window.__e2e_skills_broadcast=null;if(window.__wsInstance){var _ws=window.__wsInstance;var origOnMsg=_ws.onmessage;_ws.onmessage=function(ev){var d=JSON.parse(ev.data);if(d.type===\"config.skillUpdated\")window.__e2e_skill_import_result=d;if(d.type===\"config.skills\")window.__e2e_skills_broadcast=d;if(origOnMsg)origOnMsg.call(this,ev)}}return \"hooked\"})()"}'

# 点击第一个扫描结果的导入按钮
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var btns=document.querySelectorAll(\".scan-item .import-btn\");if(btns.length>0){btns[0].click();return \"clicked index 0\"}return \"no import buttons found\"})()"}'

# 等待导入完成
sleep 2

# 读取协议响应
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var r=window.__e2e_skill_import_result;var b=window.__e2e_skills_broadcast;return {importResponse:r?{type:r.type,success:r.payload&&r.payload.success}:\"no response\",broadcast:b?{type:b.type,skillCount:b.payload&&b.payload.skills?b.payload.skills.length:\"n/a\"}:\"no broadcast\"}})()"}'

# 期望: importResponse.success === true, broadcast 包含更新后的 skills 列表
```

### DOM 验证

```bash
# 验证已导入 section 出现新 SkillSection
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".skill-section\");return {count:sections.length,labels:Array.from(sections).map(function(s){var name=s.querySelector(\".skill-name\");return name?name.textContent.trim():\"unnamed\"})}})()"}'

# 期望: count >= 1, labels 包含刚导入的 skill 名称
```

### 持久化验证

```bash
# 检查 .xyz-agent/skills.json 文件
SKILLS_FILE="/Users/zhushanwen/.xyz-agent/skills.json"
if [ -f "$SKILLS_FILE" ]; then
  echo "skills.json exists"
  python3 -c "import json; d=json.load(open('$SKILLS_FILE')); print('skills count:', len(d) if isinstance(d, list) else len(d.get('skills',d)))"
else
  echo "FAIL: skills.json not found at $SKILLS_FILE"
fi
```

### 视觉验证

```bash
# 截图
node "$CDP" "$WS_URL" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SCREENSHOT_DIR/actual-skill-imported.png','wb').write(base64.b64decode(data)) if data else print('fail')"

# AI 视觉检查
python3 "$VISION" --image "$SCREENSHOT_DIR/actual-skill-imported.png" --prompt "分析这张 Skill 导入后的界面截图。检查：1) 已导入区域是否显示新 skill 2) skill 卡片是否包含名称、来源、状态等信息 3) 布局是否正确。输出 PASS 或 FAIL。"
```

### 结果记录

| 项目 | 期望 | 实际 |
|------|------|------|
| 协议消息类型 | config.skillUpdated | |
| import success | true | |
| broadcast config.skills | 包含新 skill | |
| skill-section 数量 | >= 1 | |
| skills.json 存在 | true | |
| 视觉检查 | 已导入 section 正确 | |

---

## TC-2.4: Skill Toggle（禁用）

**目标**: 切换已导入 skill 的启用/禁用状态，验证 WS 协议 `config.setSkill { enabled: false }`、DOM 视觉变化

**前置**: TC-2.3 通过，至少 1 个 skill 已导入

### 协议验证

```bash
# Hook WS
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){window.__e2e_skill_toggle_result=null;if(window.__wsInstance){var _ws=window.__wsInstance;var origOnMsg=_ws.onmessage;_ws.onmessage=function(ev){var d=JSON.parse(ev.data);if(d.type===\"config.skillUpdated\")window.__e2e_skill_toggle_result=d;if(origOnMsg)origOnMsg.call(this,ev)}}return \"hooked\"})()"}'

# 点击第一个 skill 的 toggle 开关
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var toggles=document.querySelectorAll(\".skill-section .toggle-switch\");if(toggles.length>0){toggles[0].click();return \"clicked\"}return \"no toggle found\"})()"}'

sleep 1

# 验证协议响应
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var r=window.__e2e_skill_toggle_result;return r?{type:r.type,enabled:r.payload&&r.payload.skill&&r.payload.skill.enabled}:\"no response\"})()"}'

# 期望: enabled === false
```

### DOM 验证

```bash
# 验证禁用样式（opacity-60 或类似 disabled class）
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".skill-section\");if(sections.length===0)return \"no sections\";var first=sections[0];var hasOpacity=first.classList.contains(\"opacity-60\")||first.classList.contains(\"disabled\");var style=window.getComputedStyle(first);var opacity=parseFloat(style.opacity);return {hasDisabledClass:hasOpacity,computedOpacity:opacity,isVisuallyDisabled:opacity<1||hasOpacity}})()"}'

# 期望: isVisuallyDisabled === true (opacity 降低或含 disabled class)
```

### 结果记录

| 项目 | 期望 | 实际 |
|------|------|------|
| 协议消息类型 | config.skillUpdated | |
| skill.enabled | false | |
| 视觉禁用效果 | opacity 降低 | |

### 恢复（重新启用）

```bash
# 再次点击 toggle 恢复启用状态
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var toggles=document.querySelectorAll(\".skill-section .toggle-switch\");if(toggles.length>0){toggles[0].click();return \"re-enabled\"}return \"no toggle\"})()"}'

sleep 1
```

---

## TC-2.5: Skill 删除

**目标**: 删除已导入的 skill，验证 WS 协议 `config.deleteSkill`、DOM section 移除、持久化文件更新

**前置**: TC-2.3 通过，至少 1 个 skill 已导入

### 协议验证

```bash
# Hook WS
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){window.__e2e_skill_delete_result=null;if(window.__wsInstance){var _ws=window.__wsInstance;var origOnMsg=_ws.onmessage;_ws.onmessage=function(ev){var d=JSON.parse(ev.data);if(d.type===\"config.skillUpdated\"||d.type===\"config.skills\")window.__e2e_skill_delete_result=d;if(origOnMsg)origOnMsg.call(this,ev)}}return \"hooked\"})()"}'

# 记录删除前的 skill 数量
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){window.__e2e_pre_delete_count=document.querySelectorAll(\".skill-section\").length;return window.__e2e_pre_delete_count})()"}'

# 点击第一个 skill 的删除按钮
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var btns=document.querySelectorAll(\".skill-section .delete-btn\");if(btns.length>0){btns[0].click();return \"clicked delete\"}return \"no delete button\"})()"}'

# 可能有确认弹窗，点击确认
sleep 1
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var confirmBtn=document.querySelector(\".confirm-dialog .confirm-btn\");if(confirmBtn){confirmBtn.click();return \"confirmed\"}return \"no confirm dialog\"})()"}'

sleep 1

# 读取协议响应
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var r=window.__e2e_skill_delete_result;return r?{type:r.type}:\"no response\"})()"}'

# 期望: 收到 config.skills broadcast（更新后的列表）
```

### DOM 验证

```bash
# 验证 skill section 已移除
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var currentCount=document.querySelectorAll(\".skill-section\").length;return {preDelete:window.__e2e_pre_delete_count,postDelete:currentCount,removed:currentCount<window.__e2e_pre_delete_count}})()"}'

# 期望: removed === true, postDelete = preDelete - 1
```

### 持久化验证

```bash
# 检查 skills.json 更新
SKILLS_FILE="/Users/zhushanwen/.xyz-agent/skills.json"
if [ -f "$SKILLS_FILE" ]; then
  python3 -c "import json; d=json.load(open('$SKILLS_FILE')); skills=d if isinstance(d,list) else d.get('skills',[]); print('remaining skills:', len(skills))"
fi

# 期望: skills 数量减少 1
```

### 结果记录

| 项目 | 期望 | 实际 |
|------|------|------|
| 协议 broadcast | config.skills | |
| 删除前 skill 数 | N | |
| 删除后 skill 数 | N - 1 | |
| skills.json 更新 | 数量减少 | |

---

## TC-2.6: Skill 展开详情

**目标**: 点击 skill 卡片展开详情，验证 MetaGrid 可见、chevron 旋转、视觉布局正确

**前置**: TC-2.3 通过（至少 1 个 skill 已导入，若 TC-2.5 已删除全部则需重新导入）

### DOM 验证

```bash
# 点击第一个 skill 的展开按钮（或整个卡片头部）
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var headers=document.querySelectorAll(\".skill-section .skill-header\");if(headers.length>0){headers[0].click();return \"clicked header\"}return \"no skill header\"})()"}'

sleep 0.5

# 验证 chevron 旋转
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var chevrons=document.querySelectorAll(\".skill-section .chevron\");if(chevrons.length===0)return \"no chevron\";var c=chevrons[0];var isRotated=c.classList.contains(\"rotate-180\")||c.style.transform.includes(\"180\");return {isRotated:isRotated,transform:c.style.transform,classes:c.className}})()"}'

# 期望: isRotated === true

# 验证 MetaGrid 可见
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var grids=document.querySelectorAll(\".skill-section .meta-grid\");if(grids.length===0)return \"no meta-grid\";var g=grids[0];var rect=g.getBoundingClientRect();var style=window.getComputedStyle(g);return {visible:rect.height>0&&style.display!==\"none\"&&style.visibility!==\"hidden\",height:rect.height,items:g.querySelectorAll(\".meta-item\").length}})()"}'

# 期望: visible === true, items > 0
```

### 视觉验证

```bash
# 截图
node "$CDP" "$WS_URL" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SCREENSHOT_DIR/actual-skill-expanded.png','wb').write(base64.b64decode(data)) if data else print('fail')"

# AI 视觉检查
python3 "$VISION" --image "$SCREENSHOT_DIR/actual-skill-expanded.png" --prompt "分析这张 Skill 展开详情的界面截图。检查：1) skill 详情区域是否展开可见 2) 是否显示 meta 信息（来源、路径、描述等） 3) 展开/收起箭头是否旋转朝上 4) 布局是否整齐。输出 PASS 或 FAIL。"
```

### 结果记录

| 项目 | 期望 | 实际 |
|------|------|------|
| chevron 旋转 | rotate-180 | |
| MetaGrid 可见 | true | |
| meta-item 数量 | > 0 | |
| 视觉检查 | 展开详情正确 | |

---

## 总结模板

| TC | 协议 | DOM | 视觉 | 持久化 | 状态 |
|----|------|-----|------|--------|------|
| TC-2.1 扫描源 Chips | N/A | | | N/A | |
| TC-2.2 扫描执行 | | | | N/A | |
| TC-2.3 Skill 导入 | | | | | |
| TC-2.4 Skill Toggle | | | N/A | N/A | |
| TC-2.5 Skill 删除 | | | N/A | | |
| TC-2.6 展开详情 | N/A | | | N/A | |
