# G6: 跨 Tab 持久化 + 全局视觉对比（4 TC | L1+L2+L3+L4）

> 前置条件：G2-G5 均执行完毕，至少 1 个 Provider/Skill/Agent 已配置。
> 执行顺序：TC-6-01/02/03 可并行，TC-6-04 最后。

---

### TC-6-01: Provider 刷新保持

**测试目标**: 关闭并重开 Electron 后 Provider 数据完整恢复。

**前置条件**: G2 已创建至少 1 个 Provider。

#### Step 1: 记录初始 Provider（L1）
```bash
PROVIDER_COUNT_BEFORE=$(node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.providers') {
    console.log(msg.payload.providers.length);
    ws.close();
  }
});
setTimeout(() => { process.exit(1); }, 10000);
")
echo "Provider count before: $PROVIDER_COUNT_BEFORE"

# 保存快照
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.providers') {
    require('fs').writeFileSync('$EVIDENCE/g6-providers-before.json', JSON.stringify(msg.payload.providers, null, 2));
    ws.close();
  }
});
setTimeout(() => process.exit(1), 10000);
"
```

#### Step 2: 重启 Electron（L1+L2）
```bash
# 关闭 Electron 窗口（不杀 sidecar）
node "$CDP" "$ELECTRON_WS" Browser.close '{}'
sleep 2

# 重启 Electron
cd "$PROJECT" && npm run dev &
sleep 8

# 重新获取 CDP 连接
ELECTRON_WS=$(curl -s http://localhost:9222/json/list | python3 -c "import sys,json; tabs=json.load(sys.stdin); m=[t for t in tabs if 'localhost:1420' in t.get('url','')]; print(m[0]['webSocketDebuggerUrl'] if m else '')")

# 检查初始广播
PROVIDER_COUNT_AFTER=$(node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.providers') {
    console.log(msg.payload.providers.length);
    ws.close();
  }
});
setTimeout(() => process.exit(1), 10000);
")
echo "Provider count after: $PROVIDER_COUNT_AFTER"
[ "$PROVIDER_COUNT_BEFORE" = "$PROVIDER_COUNT_AFTER" ] && echo "PASS" || echo "FAIL"

# DOM 检查
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var items=document.querySelectorAll(\".sidebar-item\");var p=Array.from(items).find(function(e){return e.textContent.includes(\"Provider\")});if(p)p.click();return \"clicked\"})()"}'
sleep 1
DOM_COUNT=$(node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"document.querySelectorAll(\".border.rounded-lg\").length"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('value',0))")
echo "DOM Provider sections: $DOM_COUNT"
```

#### Step 3: config.json 验证（L4）
```bash
CONFIG_FILE="$HOME/.xyz-agent/config.json"
if [ -f "$CONFIG_FILE" ]; then
  python3 -c "
import json
before = json.load(open('$EVIDENCE/g6-providers-before.json'))
config = json.load(open('$CONFIG_FILE'))
providers = config.get('providers', {})
print(f'config.json providers: {len(providers)} items')
for pid, p in providers.items(): print(f'  - {pid}: {p.get(\"name\",\"\")}')
"
fi
```

### 结果判定

| 层级 | 验证点 | 期望 | 实际 |
|------|--------|------|------|
| L1 | WS 广播 provider 数量 | = 重启前 | |
| L2 | DOM section 数量 | = 重启前 | |
| L4 | config.json 内容 | 匹配 | |

---

### TC-6-02: Skill 刷新保持

**测试目标**: 重启后 Skill 列表完整恢复。

**前置条件**: G3 已导入至少 1 个 Skill。

#### Step 1: 记录初始 Skill（L1）
```bash
SKILL_COUNT_BEFORE=$(node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.skills') {
    console.log(msg.payload.skills.length);
    ws.close();
  }
});
setTimeout(() => process.exit(1), 10000);
")
echo "Skill count before: $SKILL_COUNT_BEFORE"
```

#### Step 2: 重启并验证（L1+L2+L4）
```bash
# 同 TC-6-01 重启流程，改为检查 config.skills 广播和 skills.json
# 重启后检查:
SKILL_COUNT_AFTER=$(node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.skills') {
    console.log(msg.payload.skills.length);
    ws.close();
  }
});
setTimeout(() => process.exit(1), 10000);
")
[ "$SKILL_COUNT_BEFORE" = "$SKILL_COUNT_AFTER" ] && echo "PASS" || echo "FAIL"

# L4: skills.json
python3 -c "import json; skills=json.load(open('$SKILLS_JSON')); print(f'skills.json: {len(skills)} items')"
```

### 结果判定

| 层级 | 验证点 | 期望 | 实际 |
|------|--------|------|------|
| L1 | WS 广播 skill 数量 | = 重启前 | |
| L4 | skills.json 内容 | 匹配 | |

---

### TC-6-03: Agent 刷新保持

**测试目标**: 重启后 Agent 列表完整恢复。

**前置条件**: G4 已导入至少 1 个 Agent。

#### Step 1: 记录初始 Agent（L1）
```bash
AGENT_COUNT_BEFORE=$(node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.agents') {
    console.log(msg.payload.agents.length);
    ws.close();
  }
});
setTimeout(() => process.exit(1), 10000);
")
echo "Agent count before: $AGENT_COUNT_BEFORE"
```

#### Step 2: 重启并验证（L1+L4）
```bash
# 同 TC-6-01 重启流程
AGENT_COUNT_AFTER=$(node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.agents') {
    console.log(msg.payload.agents.length);
    ws.close();
  }
});
setTimeout(() => process.exit(1), 10000);
")
[ "$AGENT_COUNT_BEFORE" = "$AGENT_COUNT_AFTER" ] && echo "PASS" || echo "FAIL"

# L4: agents.json
python3 -c "import json; agents=json.load(open('$AGENTS_JSON')); print(f'agents.json: {len(agents)} items')"
```

### 结果判定

| 层级 | 验证点 | 期望 | 实际 |
|------|--------|------|------|
| L1 | WS 广播 agent 数量 | = 重启前 | |
| L4 | agents.json 内容 | 匹配 | |

---

### TC-6-04: 全局视觉对比总结

**测试目标**: 4 个 Tab 截图与设计稿做视觉对比，汇总整体设计还原度。

**前置条件**: G2-G5 数据均已就绪，设计稿 HTML 已在 Chrome 打开。

#### Step 1: 截取实际应用各 Tab（L3）
```bash
mkdir -p "$EVIDENCE/g6-visual"

for TAB in provider skill agent system; do
  node "$CDP" "$ELECTRON_WS" Runtime.evaluate "{\"returnByValue\":true,\"expression\":\"(function(){var items=document.querySelectorAll('.sidebar-item');var t=Array.from(items).find(function(e){return e.textContent.toLowerCase().includes('$TAB')});if(t)t.click();return 'clicked'})()\"}"
  sleep 1
  node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png"}' | python3 -c "
import sys,json,base64
r = json.load(sys.stdin)
data = r.get('result',{}).get('value','')
if data: open('$EVIDENCE/g6-visual/actual-$TAB.png','wb').write(base64.b64decode(data)); print('saved: $TAB')
"
done
```

#### Step 2: AI 视觉对比（L3）
```bash
for TAB in provider skill agent system; do
  echo "=== $TAB Tab UI Diff ==="
  python3 "$ZAI" ui-diff \
    "$EVIDENCE/baselines/design-$TAB.png" \
    "$EVIDENCE/g6-visual/actual-$TAB.png" \
    "$EVIDENCE/g6-visual/diff-$TAB.png"
  echo ""
done
```

#### Step 3: AI 设计还原度评分（L3）
```bash
for TAB in provider skill agent system; do
  echo "=== $TAB Tab 还原度 ==="
  python3 "$ZAI" analyze-image \
    "$EVIDENCE/g6-visual/actual-$TAB.png" \
    "这是一个桌面应用的 Settings 界面 $TAB tab 截图。请从以下维度评分(1-10)：1.布局还原度 2.配色还原度 3.间距/对齐还原度 4.交互元素还原度 5.整体设计还原度。给出简短理由。"
  echo "---"
done
```

### 结果判定

| 层级 | 验证点 | 期望 | 实际 |
|------|--------|------|------|
| L3 | 4 Tab ui-diff | 无重大布局/色彩偏差 | |
| L3 | 4 Tab 还原度评分 | 均 >= 7/10 | |

**通过标准**: 所有 4 个 Tab 的 AI 设计还原度评分均 >= 7/10，且 ui-diff 未报告重大偏差。

---

## G6 执行清单

| TC | 依赖 | L1 | L2 | L3 | L4 | 关键验证 |
|----|------|----|----|----|----|---------|
| TC-6-01 | G2 | WS 广播一致 | DOM 数量 | - | config.json | Provider 持久化 |
| TC-6-02 | G3 | WS 广播一致 | - | - | skills.json | Skill 持久化 |
| TC-6-03 | G4 | WS 广播一致 | - | - | agents.json | Agent 持久化 |
| TC-6-04 | G2+G3+G4+G5 | - | - | 4 Tab 截图 | - | 全局视觉还原度 |
