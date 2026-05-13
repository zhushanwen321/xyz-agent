# G3: Skill Tab（6 TC | L1+L2+L3+L4 | 依赖 G1）

> 前置条件：G1 通过，至少一个扫描源目录存在 SKILL.md 文件。
> 执行建议：TC-3-01 → TC-3-02 → TC-3-03（导入 ≥2 条）→ TC-3-06 → TC-3-04 → TC-3-05。

---

### TC-3-01: Skill 扫描源 Chips 交互

**测试目标**: 验证 3 个 source chips（Pi/Claude/Agents）渲染，Pi 默认 active，计数文案「已选 1 个来源」。

**前置条件**: G1 通过。

**验证**:

#### Layer 2: DOM/A11y 验证
```bash
# 切换到 Skills tab
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var items=document.querySelectorAll(\".sidebar-item\");var s=Array.from(items).find(function(e){return e.textContent.includes(\"Skill\")});if(s)s.click();return \"clicked\"})()"}'
sleep 0.5

# 检查 A11y 中有 source chip 相关的按钮元素
node "$CDP" "$ELECTRON_WS" Accessibility.getFullAXTree '{}' | python3 -c "
import sys, json
raw = json.load(sys.stdin)
chips = []
for n in raw.get('result',{}).get('nodes',[]):
    name = n.get('name',{}).get('value','')
    r = n.get('role',{}).get('value','')
    if any(kw in (name or '') for kw in ['Pi Skills', 'Claude Code', 'Agents', 'Pi']):
        chips.append(f'{r} \"{name}\"')
if len(chips) >= 3:
    print(f'PASS: found {len(chips)} source elements')
    for c in chips: print(f'  - {c}')
else:
    print(f'WARN: found {len(chips)} source elements (expected 3)')
"

# 检查「已选 N 个来源」文本
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var text=document.body.innerText;var match=text.match(/已选 (\\d+) 个来源/);return match?match[0]:\"text not found\"})()"}'
```

#### Layer 3: 视觉对比
```bash
mkdir -p "$EVIDENCE"
node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "
import sys,json,base64
r = json.load(sys.stdin)
data = r.get('result',{}).get('value','')
if data: open('$EVIDENCE/tc-301_skill-scan.png','wb').write(base64.b64decode(data)); print('saved')
"

python3 "$ZAI" ui-diff \
  "$EVIDENCE/baselines/design-skill.png" \
  "$EVIDENCE/tc-301_skill-scan.png" \
  "对比 Skill 扫描区域：source chips 布局、计数文案、扫描按钮。列出差异。"
```

**回退影响**: 无状态变更。
**严重程度**: P2

---

### TC-3-02: Skill 扫描执行

**测试目标**: 点击扫描后 WS config.scanSkills → config.scannedSkills，扫描结果列表渲染。

**前置条件**: TC-3-01 通过。

**验证**:

#### Layer 1: WS 协议
```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'config.scanSkills', id: 'tc302', payload: { sources: ['~/.pi/agent/skills/'] } }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.scannedSkills') {
    console.log('success:', msg.payload.success);
    console.log('skills count:', (msg.payload.skills || []).length);
    if (msg.payload.skills && msg.payload.skills.length > 0) {
      const s = msg.payload.skills[0];
      console.log('first skill:', JSON.stringify({id:s.id,name:s.name,sourceType:s.sourceType,alreadyImported:s.alreadyImported}));
    }
    ws.close();
  }
});
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);
"
```

#### Layer 2: DOM/A11y 验证
```bash
# 点击扫描按钮（通过 UI）
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var btns=document.querySelectorAll(\"button\");var scan=Array.from(btns).find(function(b){return b.textContent.includes(\"扫描\")});if(scan)scan.click();return \"clicked scan\"})()"}'
sleep 3

# 检查 A11y 中 checkbox 元素出现
node "$CDP" "$ELECTRON_WS" Accessibility.getFullAXTree '{}' | python3 -c "
import sys, json
raw = json.load(sys.stdin)
checkboxes = [n for n in raw.get('result',{}).get('nodes',[]) if n.get('role',{}).get('value','') == 'checkbox']
print(f'checkbox count: {len(checkboxes)}')
if len(checkboxes) > 0:
    print('PASS: scan results rendered')
else:
    print('FAIL: no checkboxes found - scan may have returned empty')
"
```

#### Layer 3: 视觉对比
```bash
node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png"}' | python3 -c "
import sys,json,base64
r = json.load(sys.stdin)
data = r.get('result',{}).get('value','')
if data: open('$EVIDENCE/tc-302_skill-results.png','wb').write(base64.b64decode(data)); print('saved')
"
```

**回退影响**: 只读操作，不影响数据。
**严重程度**: P1 阻塞

---

### TC-3-03: Skill 导入选中项

**测试目标**: WS config.setSkill → config.skills broadcast，已导入列表更新，skills.json 持久化。

**前置条件**: TC-3-02 通过，扫描结果非空。

**验证**:

#### Layer 1: WS 协议
```bash
# 通过 WS 直接导入一个 skill
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
const skill = {
  id: 'test-skill-' + Date.now(),
  name: 'test-skill',
  description: 'E2E test skill',
  enabled: true,
  source: 'manual',
  triggers: ['test', 'e2e'],
};
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'config.setSkill', id: 'tc303', payload: { skill } }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.skillUpdated') console.log('skillUpdated:', JSON.stringify(msg.payload));
  if (msg.type === 'config.skills') { console.log('skills count:', msg.payload.skills.length); ws.close(); }
});
setTimeout(() => process.exit(1), 10000);
"
```

#### Layer 2: DOM/A11y 验证
```bash
sleep 1
# 检查已导入区域出现新 section
node "$CDP" "$ELECTRON_WS" Accessibility.getFullAXTree '{}' | python3 -c "
import sys, json
raw = json.load(sys.stdin)
for n in raw.get('result',{}).get('nodes',[]):
    name = n.get('name',{}).get('value','')
    if 'test-skill' in (name or ''):
        print(f'FOUND: {n.get(\"role\",{}).get(\"value\",\"\")} \"{name}\"')
"
```

#### Layer 3: 视觉对比
```bash
node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png"}' | python3 -c "
import sys,json,base64
r = json.load(sys.stdin)
data = r.get('result',{}).get('value','')
if data: open('$EVIDENCE/tc-303_skill-imported.png','wb').write(base64.b64decode(data)); print('saved')
"
```

#### Layer 4: 文件验证
```bash
[ -f "$SKILLS_JSON" ] || { echo "FAIL: skills.json not found"; exit 1; }
python3 -c "
import json
skills = json.load(open('$SKILLS_JSON'))
print(f'skills.json: {len(skills)} items')
for s in skills: print(f'  - {s[\"id\"]}: {s[\"name\"]} enabled={s.get(\"enabled\",True)}')
"
```

**回退影响**: skills.json 新增记录。TC-3-04/05/06 依赖此数据。
**严重程度**: P1 阻塞

---

### TC-3-04: Skill Toggle 启停

**测试目标**: toggle 切换 skill 启停状态。

**前置条件**: TC-3-03 通过。

**验证**:

#### Layer 1: WS 协议
```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.skillUpdated') console.log('updated:', JSON.stringify(msg.payload));
  if (msg.type === 'config.skills') { console.log('count:', msg.payload.skills.length); ws.close(); }
});
setTimeout(() => process.exit(0), 10000);
"
```

#### Layer 2: DOM/A11y 验证
```bash
# 点击已导入 skill 的 toggle
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".border.rounded-lg.mb-3\");for(var i=0;i<sections.length;i++){var h=sections[i].querySelector(\".text-\\[13px\\].font-semibold\");if(h&&h.textContent.includes(\"test-skill\")){sections[i].querySelector(\"[role=\\\"switch\\\"]").click();return \"toggled\"}}return \"not found\"})()"}'
sleep 0.3

# 检查 opacity-60
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".border.rounded-lg.mb-3\");for(var i=0;i<sections.length;i++){if(sections[i].classList.contains(\"opacity-60\"))return \"has opacity-60\"}return \"no opacity\"})()"}'

# 恢复
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".border.rounded-lg.mb-3\");for(var i=0;i<sections.length;i++){var h=sections[i].querySelector(\".text-\\[13px\\].font-semibold\");if(h&&h.textContent.includes(\"test-skill\")){sections[i].querySelector(\"[role=\\\"switch\\\"]").click();return \"restored\"}}return \"not found\"})()"}'
```

**回退影响**: toggle 状态恢复。
**严重程度**: P2

---

### TC-3-05: Skill 删除

**测试目标**: 删除后 section 消失，skills.json 更新。

**前置条件**: TC-3-03 通过。

**验证**:

#### Layer 1: WS 协议
```bash
SKILL_ID=$(python3 -c "import json; skills=json.load(open('$SKILLS_JSON')); print(skills[-1]['id'])")
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'config.deleteSkill', id: 'tc305', payload: { skillId: '$SKILL_ID' } }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.skillDeleted') console.log('deleted:', JSON.stringify(msg.payload));
  if (msg.type === 'config.skills') { console.log('remaining:', msg.payload.skills.length); ws.close(); }
});
setTimeout(() => process.exit(1), 10000);
"
```

#### Layer 2: DOM/A11y 验证
```bash
sleep 1
# section 应该减少
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"document.querySelectorAll(\".border.rounded-lg.mb-3\").length"}'
```

#### Layer 4: 文件验证
```bash
python3 -c "
import json
skills = json.load(open('$SKILLS_JSON'))
print(f'skills.json: {len(skills)} items (should be fewer than before)')
"
```

**回退影响**: 删除一条 skill 记录。
**严重程度**: P1

---

### TC-3-06: Skill 展开详情

**测试目标**: 点击 section header 展开详情，MetaGrid 可见，chevron 旋转。

**前置条件**: TC-3-03 通过（需保留至少 1 个 skill，如 TC-3-05 已删除则先重新导入）。

**验证**:

#### Layer 2: DOM/A11y 验证
```bash
# 点击第一个已导入 skill section 的 header
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\".border.rounded-lg.mb-3\");if(sections.length===0)return \"NO_SECTIONS\";var header=sections[0].querySelector(\".bg-\\\\[var\\\\(--section-bg\\\\)\\\\]\");if(header)header.click();return \"clicked header\"})()"}'
sleep 0.5

# 检查 chevron 旋转
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var chevrons=document.querySelectorAll(\"svg\");for(var i=0;i<chevrons.length;i++){var t=getComputedStyle(chevrons[i]).transform;if(t&&t!==\"none\")return JSON.stringify({transform:t})}return \"no rotated chevron\"})()"}'

# 检查 detail grid 文本
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var grid=document.querySelector(\".grid\");return grid?grid.textContent.substring(0,200):\"no grid\"})()"}'
```

#### Layer 3: 视觉对比
```bash
node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png"}' | python3 -c "
import sys,json,base64
r = json.load(sys.stdin)
data = r.get('result',{}).get('value','')
if data: open('$EVIDENCE/tc-306_skill-expanded.png','wb').write(base64.b64decode(data)); print('saved')
"
```

**回退影响**: 仅 UI 展开/折叠。
**严重程度**: P2
