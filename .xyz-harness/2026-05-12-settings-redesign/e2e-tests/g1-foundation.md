# G1: 基础连通性（4 TC | L1+L2+L3 | 无前置依赖）

> 所有后续 G2-G6 依赖 G1 通过。G1 失败则停止全部测试。

---

### TC-1-01: Sidecar 健康检查

**测试目标**: 验证 Sidecar HTTP 服务已启动且响应健康检查。

**前置条件**: `npm run dev` 已启动，端口 3210 未被占用。

**测试步骤**: 向 Sidecar HTTP 端点发送 GET /health 请求。

**验证**:

#### Layer 1: WS 协议
```bash
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3210/health)
[ "$HTTP_CODE" = "200" ] || { echo "FAIL: expected 200, got $HTTP_CODE"; exit 1; }

RESP=$(curl -s http://localhost:3210/health)
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")
[ "$STATUS" = "ok" ] || { echo "FAIL: expected status=ok, got '$STATUS'"; exit 1; }
echo "PASS: sidecar health=$STATUS"
```

#### Layer 2: DOM/A11y 验证
不适用

#### Layer 3: 视觉对比
不适用

**回退影响**: 失败则跳过 TC-1-02~TC-1-04 及 G2-G6 全部用例。
**严重程度**: 阻塞

---

### TC-1-02: WS 连接 + 初始广播

**测试目标**: WS 连接后 5 秒内收到 4 种初始广播消息。

**前置条件**: TC-1-01 通过。

**验证**:

#### Layer 1: WS 协议
```bash
node -e "
const WebSocket = require('ws');
const REQUIRED = ['config.providers','config.skills','config.agents','model.list'];
const ws = new WebSocket('ws://localhost:3210');
const received = new Set();
const timeout = setTimeout(() => {
  const missing = REQUIRED.filter(t => !received.has(t));
  if (missing.length) {
    console.log('FAIL: missing:', missing.join(', '));
    console.log('received:', [...received].join(', '));
    process.exit(1);
  }
  console.log('PASS: all 4 broadcast types received:', [...received].join(', '));
  ws.close();
}, 5000);
ws.on('message', (raw) => {
  try { const msg = JSON.parse(raw.toString()); if (msg.type) received.add(msg.type); } catch {}
});
ws.on('error', (err) => { console.log('FAIL: ws error:', err.message); clearTimeout(timeout); process.exit(1); });
"
```

**回退影响**: 失败则跳过 TC-1-03~TC-1-04 及 G2-G6 全部。
**严重程度**: 阻塞

---

### TC-1-03: CDP 连通 + Settings 页面渲染

**测试目标**: 通过 CDP 连接 Electron 渲染进程，Settings 页面包含 sidebar + content。

**前置条件**: TC-1-01 通过，Electron 已启动，CDP 端口 9222 开放。

**验证**:

#### Layer 2: DOM/A11y 验证
```bash
# 获取 Electron CDP WS URL
ELECTRON_WS=$(curl -s http://localhost:9222/json/list | python3 -c "
import sys,json
tabs = json.load(sys.stdin)
m = [t for t in tabs if 'localhost:1420' in t.get('url','')]
print(m[0]['webSocketDebuggerUrl'] if m else '')
")
[ -z "$ELECTRON_WS" ] && { echo "FAIL: no Electron tab found"; exit 1; }
echo "ELECTRON_WS=$ELECTRON_WS"

# 检查 A11y Tree 中存在 Provider tab 按钮
node "$CDP" "$ELECTRON_WS" Accessibility.getFullAXTree '{}' | python3 -c "
import sys, json
raw = json.load(sys.stdin)
nodes = raw.get('result',{}).get('nodes',[])
found = False
for n in nodes:
    role = n.get('role',{}).get('value','')
    name = n.get('name',{}).get('value','')
    if role in ('button','tab','listitem') and name and 'provider' in name.lower():
        print(f'FOUND: {role} {name}')
        found = True
if not found:
    # 可能还在 chat 视图，尝试切换
    print('WARN: Provider tab not found, trying Cmd+,')
"

# 切换到 Settings（Cmd+,）
node "$CDP" "$ELECTRON_WS" Input.dispatchKeyEvent '{"type":"keyDown","key":",","code":"Comma","windowsVirtualKeyCode":188,"modifiers":4}'
node "$CDP" "$ELECTRON_WS" Input.dispatchKeyEvent '{"type":"keyUp","key":",","code":"Comma","windowsVirtualKeyCode":188,"modifiers":4}'
sleep 1

# 再次检查
node "$CDP" "$ELECTRON_WS" Accessibility.getFullAXTree '{}' | python3 -c "
import sys, json
raw = json.load(sys.stdin)
nodes = raw.get('result',{}).get('nodes',[])
tabs_found = []
for n in nodes:
    role = n.get('role',{}).get('value','')
    name = n.get('name',{}).get('value','')
    if role in ('button','tab','listitem') and name and any(kw in name.lower() for kw in ['provider','skill','agent','system','供应商','技能','系统']):
        tabs_found.append(f'{role} {name}')
if len(tabs_found) >= 3:
    print(f'PASS: found {len(tabs_found)} settings tabs')
    for t in tabs_found: print(f'  - {t}')
else:
    print(f'FAIL: only found {len(tabs_found)} tabs')
    for t in tabs_found: print(f'  - {t}')
"
```

#### Layer 3: 视觉对比
```bash
mkdir -p "$EVIDENCE"
node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "
import sys,json,base64
r = json.load(sys.stdin)
data = r.get('result',{}).get('value','')
if data:
    with open('$EVIDENCE/tc-1-03_settings-page.png','wb') as f: f.write(base64.b64decode(data))
    print('Saved: $EVIDENCE/tc-1-03_settings-page.png')
else: print('screenshot failed')
"

python3 "$ZAI" analyze-image "$EVIDENCE/tc-1-03_settings-page.png" \
  "This is a settings page of a desktop app. Confirm: (1) there is a sidebar on the left with navigation tabs, (2) there is a main content area on the right. Reply PASS or FAIL and reason."
```

**回退影响**: 失败则跳过 TC-1-04 及 G2-G6。
**严重程度**: 阻塞

---

### TC-1-04: Settings Sidebar 四 Tab 渲染

**测试目标**: 4 个 Tab（Provider/Skill/Agent/System）均渲染，点击后 content 区域变化。

**前置条件**: TC-1-03 通过。

**验证**:

#### Layer 2: DOM/A11y 验证
```bash
# 逐个点击 Tab 并验证 content 变化
for TAB in provider skill agent system; do
  echo "--- Tab: $TAB ---"
  HASH_BEFORE=$(node "$CDP" "$ELECTRON_WS" Runtime.evaluate "{\"returnByValue\":true,\"expression\":\"document.body.innerHTML.length\"}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('value',0))")

  node "$CDP" "$ELECTRON_WS" Runtime.evaluate "{\"returnByValue\":true,\"expression\":\"(function(){var items=document.querySelectorAll('.sidebar-item');var t=Array.from(items).find(function(e){return e.textContent.toLowerCase().includes('$TAB')});if(t)t.click();return 'clicked'})()\"}"

  sleep 0.8
  HASH_AFTER=$(node "$CDP" "$ELECTRON_WS" Runtime.evaluate "{\"returnByValue\":true,\"expression\":\"document.body.innerHTML.length\"}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('value',0))")

  if [ "$HASH_BEFORE" != "$HASH_AFTER" ]; then
    echo "  PASS: content changed ($HASH_BEFORE -> $HASH_AFTER)"
  else
    echo "  WARN: content unchanged after clicking $TAB"
  fi
done
```

#### Layer 3: 视觉对比
```bash
# 每个 Tab 截图
for TAB in provider skill agent system; do
  node "$CDP" "$ELECTRON_WS" Runtime.evaluate "{\"returnByValue\":true,\"expression\":\"(function(){var items=document.querySelectorAll('.sidebar-item');var t=Array.from(items).find(function(e){return e.textContent.toLowerCase().includes('$TAB')});if(t)t.click();return 'clicked'})()\"}"
  sleep 0.8
  node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png"}' | python3 -c "
import sys,json,base64
r = json.load(sys.stdin)
data = r.get('result',{}).get('value','')
if data: open('$EVIDENCE/tc-1-04_tab-$TAB.png','wb').write(base64.b64decode(data)); print('Saved: tab-$TAB')
"
done
```

**回退影响**: 失败则 G2-G5 的 Tab 切换可能受影响。
**严重程度**: 阻塞
