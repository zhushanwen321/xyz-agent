# Group 2: Skill 扫描与 CRUD — E2E 测试

> **依赖**: Group 0 全部通过（sidecar 运行、WS 连接正常、前端渲染正常）
> **阻断规则**: TC-2.2 失败 → 跳过 TC-2.3/2.4/2.5/2.6；TC-2.3 失败 → 跳过 TC-2.4/2.5/2.6

---

## WS 协议速查

| 方向 | 消息类型 | Payload |
|------|---------|---------|
| → Client | `config.scanSkills` | `{ sources: string[] }` |
| ← Server | `config.scannedSkills` | `{ skills: ScannedSkillInfo[], success: boolean }` |
| → Client | `config.setSkill` | `{ skill: SkillInfo }` |
| ← Server | `config.skillUpdated` | `{ skill: SkillInfo, success: boolean }` |
| ← Server | `config.skills` | `{ skills: SkillInfo[] }` (broadcast) |
| → Client | `config.deleteSkill` | `{ skillId: string }` |
| ← Server | `config.skillDeleted` | `{ skillId: string, success: boolean }` |

---

## TC-2.1: Skill 扫描源 Chips 交互

### 目标
确认 Skills tab 的扫描区域有 Pi/Claude/Agents 三个 source chips，默认 Pi 选中。

### 前置条件
- Group 0 通过
- 前端运行中，已切换到 Skills tab

### 测试步骤

```bash
# Step 1: 通过 CDP 切换到 Skills tab
# 在 Electron DevTools console 中执行：
# 找到 sidebar 中 Skills 对应的 sidebar-item，点击它
```

CDP JS 脚本：
```javascript
// 找到 Skills tab 的 sidebar item（通过文本内容）
const items = document.querySelectorAll('.sidebar-item');
const skillsTab = Array.from(items).find(el => el.textContent?.includes('Skill'));
if (skillsTab) { skillsTab.click(); '已点击 Skills tab'; } else { '未找到 Skills tab'; }
```

```bash
# Step 2: 检查 source chips 数量和默认状态
```

CDP JS 脚本：
```javascript
// 检查 ScanImportSection 的 source chips
const scanSection = document.querySelector('.section');
const chips = scanSection?.querySelectorAll('.source-chip, [class*="border"]');
// 由于新组件用 Tailwind 类，需要检查实际 DOM 结构

// 检查「已选 N 个来源」文案
const statusText = document.body.innerText;
const match = statusText.match(/已选 (\d+) 个来源/);
JSON.stringify({
  foundMatch: match?.[1] ?? 'not found',
  hasScanButton: !!document.querySelector('button')?.textContent?.includes('扫描'),
});
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| Source chips 数量 | 3 个（Pi/Claude/Agents） |
| 默认选中 | Pi chip 有 accent 边框/底色 |
| 来源计数文案 | 「已选 1 个来源」 |
| 扫描按钮 | 存在且可点击 |

### 衡量方法
- DOM 检查：source chip 元素的数量和 active 类名
- 文本内容匹配：来源计数文案

### 结果

| 检查项 | 结果 | 备注 |
|--------|------|------|
| Source chips 数量 | ⬜ PASS / ❌ FAIL | |
| 默认选中状态 | ⬜ PASS / ❌ FAIL | |
| 来源计数文案 | ⬜ PASS / ❌ FAIL | |
| 扫描按钮 | ⬜ PASS / ❌ FAIL | |

---

## TC-2.2: Skill 扫描执行

### 目标
点击扫描按钮后 WS 发送 `config.scanSkills`，sidecar 返回扫描结果并渲染。

### 前置条件
- TC-2.1 通过
- 至少有一个扫描源目录存在且有 SKILL.md 文件（如 ~/.pi/agent/skills/）

### 测试步骤

```bash
# Step 1: 直接通过 WS 发送扫描请求（绕过 UI，直接验证协议）
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
ws.on('open', () => {
  console.log('WS connected');
  ws.send(JSON.stringify({
    type: 'config.scanSkills',
    payload: { sources: ['~/.pi/agent/skills/'] }
  }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.scannedSkills') {
    const skills = msg.payload.skills || [];
    console.log('扫描结果数量:', skills.length);
    console.log('success:', msg.payload.success);
    if (skills.length > 0) {
      console.log('第一个 skill:', JSON.stringify(skills[0], null, 2));
    }
    ws.close();
  }
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 10000);
"
```

```bash
# Step 2: 通过 UI 点击扫描按钮
# CDP JS:
```

```javascript
// 点击扫描按钮
const buttons = Array.from(document.querySelectorAll('button'));
const scanBtn = buttons.find(b => b.textContent?.includes('扫描'));
if (scanBtn) { scanBtn.click(); '已点击扫描'; } else { '未找到扫描按钮'; }
```

```bash
# Step 3: 等待 3 秒后检查扫描结果是否渲染
```

```javascript
// 检查扫描结果
setTimeout(() => {
  const results = document.querySelectorAll('[class*="scan-results"], [class*="border-t"]');
  const imported = document.querySelectorAll('[class*="opacity-40"]');
  const importBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('导入选中'));
  JSON.stringify({
    resultItems: results.length,
    importedItems: imported.length,
    hasImportButton: !!importBtn,
  });
}, 3000);
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| WS config.scannedSkills | success: true, skills 为非空数组 |
| 每个 skill 有 | id, name, description, sourceType, sourcePath |
| UI 扫描结果 | 渲染了 scan-item 行 |
| 已导入 badge | 已导入的项显示「已导入」且 opacity 低 |
| 导入按钮 | 存在「导入选中」按钮 |

### 衡量方法
- WS 消息验证：Node.js 脚本检查响应格式
- DOM 检查：扫描结果行的数量
- 日志：sidecar 控制台输出

### 结果

| 检查项 | 结果 | 备注 |
|--------|------|------|
| WS 扫描响应 | ⬜ PASS / ❌ FAIL | |
| skill 字段完整性 | ⬜ PASS / ❌ FAIL | |
| UI 结果渲染 | ⬜ PASS / ❌ FAIL | |
| 已导入标记 | ⬜ PASS / ❌ FAIL | |
| 导入按钮 | ⬜ PASS / ❌ FAIL | |

---

## TC-2.3: Skill 导入选中项

### 目标
勾选扫描结果中的 skill，点击导入，WS 发送 `config.setSkill`，skill 出现在已导入列表。

### 前置条件
- TC-2.2 通过（扫描结果非空）

### 测试步骤

```bash
# Step 1: 通过 WS 直接发送 config.setSkill（协议验证）
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'config.setSkill',
    payload: {
      skill: {
        id: 'test-skill-001',
        name: 'test-skill',
        description: 'E2E 测试用 skill',
        enabled: true,
        source: 'pi',
        triggers: ['test', 'e2e'],
        sourcePath: '/tmp/test-skill/',
      }
    }
  }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.skillUpdated') {
    console.log('skillUpdated:', JSON.stringify(msg.payload));
  }
  if (msg.type === 'config.skills') {
    console.log('skills broadcast:', (msg.payload.skills || []).length, 'skills');
    ws.close();
  }
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 10000);
"
```

```bash
# Step 2: 检查持久化文件
cat /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/skills.json | python3 -m json.tool
```

```bash
# Step 3: 通过 UI 操作（如果 TC-2.2 扫描有结果）
# CDP JS: 勾选 checkbox → 点击导入选中
```

```javascript
// 勾选第一个未导入的 scan-item 的 checkbox
const checkboxes = document.querySelectorAll('[class*="cursor-pointer"][class*="border"]');
// 找到可点击的 checkbox（排除 disabled/opacity-40 的）
const activeCheckbox = Array.from(checkboxes).find(cb => {
  const parent = cb.closest('[class*="border-b"]');
  return parent && !parent.querySelector('[class*="opacity-40"]');
});
if (activeCheckbox) { activeCheckbox.click(); '已勾选'; } else { '无可勾选项'; }
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| WS config.skillUpdated | success: true |
| WS config.skills broadcast | 包含新导入的 skill |
| .xyz-agent/skills.json | 文件存在，包含导入的 skill |
| DOM 已导入 section | 出现新的 SkillSection |

### 衡量方法
- WS 消息验证
- 文件系统检查
- DOM 检查

### 结果

| 检查项 | 结果 | 备注 |
|--------|------|------|
| WS skillUpdated | ⬜ PASS / ❌ FAIL | |
| 持久化文件 | ⬜ PASS / ❌ FAIL | |
| DOM 已导入列表 | ⬜ PASS / ❌ FAIL | |

---

## TC-2.4: Skill Toggle 启停

### 目标
在已导入列表中 toggle skill 启停，WS 发送 `config.setSkill { enabled: false }`。

### 前置条件
- TC-2.3 通过（至少有一个已导入 skill）

### 测试步骤

```javascript
// 找到已导入 skill 的 ToggleSwitch 并点击
const skillSections = document.querySelectorAll('[class*="rounded-lg"]');
const firstSkill = skillSections[0];
if (firstSkill) {
  // 找到 toggle switch（class 含 rounded-full + cursor-pointer）
  const toggle = firstSkill.querySelector('[role="switch"]');
  if (toggle) { toggle.click(); '已 toggle'; } else { '未找到 toggle'; }
} else { '无已导入 skill'; }
```

```bash
# 验证 WS 消息和 DOM 变化
# 检查 .xyz-agent/skills.json 中 enabled 字段
cat /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/skills.json | python3 -c "import json,sys; skills=json.load(sys.stdin); print(json.dumps([{'id':s['id'],'enabled':s['enabled']} for s in skills]))"
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| DOM section | 添加 opacity-60 class |
| WS 消息 | config.setSkill { enabled: false } |
| 持久化 | skills.json 中 enabled 变为 false |

### 结果

| 检查项 | 结果 | 备注 |
|--------|------|------|
| DOM opacity | ⬜ PASS / ❌ FAIL | |
| WS 消息 | ⬜ PASS / ❌ FAIL | |
| 持久化 | ⬜ PASS / ❌ FAIL | |

---

## TC-2.5: Skill 删除

### 目标
点击删除按钮后 WS 发送 `config.deleteSkill`，skill 从 DOM 和持久化文件中移除。

### 前置条件
- TC-2.3 通过

### 测试步骤

```javascript
// 找到并点击删除按钮
const skillSections = document.querySelectorAll('[class*="rounded-lg"]');
for (const section of skillSections) {
  const deleteBtn = Array.from(section.querySelectorAll('button')).find(b => b.textContent?.includes('删除'));
  if (deleteBtn) { deleteBtn.click(); '已点击删除'; break; }
}
```

```bash
# 通过 WS 直接删除（协议验证）
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'config.deleteSkill',
    payload: { skillId: 'test-skill-001' }
  }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.skillDeleted') {
    console.log('skillDeleted:', JSON.stringify(msg.payload));
  }
  if (msg.type === 'config.skills') {
    console.log('剩余 skills:', (msg.payload.skills || []).length);
    ws.close();
  }
});
setTimeout(() => process.exit(1), 10000);
"
```

```bash
# 检查文件
cat /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/skills.json | python3 -m json.tool
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| WS config.skillDeleted | success: true, skillId 匹配 |
| DOM | 该 skill section 移除 |
| 持久化 | skills.json 中无该 skill |

### 结果

| 检查项 | 结果 | 备注 |
|--------|------|------|
| WS 删除响应 | ⬜ PASS / ❌ FAIL | |
| DOM 移除 | ⬜ PASS / ❌ FAIL | |
| 持久化移除 | ⬜ PASS / ❌ FAIL | |

---

## TC-2.6: Skill 展开详情

### 目标
点击 skill section header 后展开详情区域（MetaGrid + 可选编辑器）。

### 前置条件
- TC-2.3 通过

### 测试步骤

```javascript
// 点击 skill section header
const skillSections = document.querySelectorAll('[class*="rounded-lg"]');
const firstSection = Array.from(skillSections).find(s => {
  // 排除扫描 section
  return s.querySelector('[role="switch"]');
});
if (firstSection) {
  // 点击 header 行（不是 toggle 或按钮）
  const header = firstSection.querySelector('[class*="section-bg"], [class*="bg-\\[var\\(--section-bg\\)\\]"]');
  if (header) { header.click(); '已点击 header'; } else { '未找到 header'; }
}
```

```bash
# 等待展开后检查
```

```javascript
// 检查展开后的 detail 区域
setTimeout(() => {
  // 查找 MetaGrid（grid-template-columns: 100px 1fr 或 76px 1fr）
  const grid = document.querySelector('[class*="grid-cols"]');
  const chevrons = document.querySelectorAll('[class*="rotate-180"]');
  JSON.stringify({
    hasDetailGrid: !!grid,
    chevronRotated: chevrons.length > 0,
    gridContent: grid?.textContent?.slice(0, 200),
  });
}, 500);
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| Detail 区域 | 展开后可见 |
| MetaGrid 内容 | 包含名称/触发词/来源/文件大小/工具 |
| Chevron | 旋转 180 度 |

### 结果

| 检查项 | 结果 | 备注 |
|--------|------|------|
| 展开动画 | ⬜ PASS / ❌ FAIL | |
| MetaGrid 内容 | ⬜ PASS / ❌ FAIL | |
| Chevron 旋转 | ⬜ PASS / ❌ FAIL | |

---

## 清理脚本

```bash
# 测试完成后清理测试数据
rm -f /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/skills.json
echo "Skills test data cleaned"
```
