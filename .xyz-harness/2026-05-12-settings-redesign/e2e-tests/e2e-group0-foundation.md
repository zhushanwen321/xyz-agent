# E2E Group 0: 基础连通性测试

> 全部后续测试依赖本组。任何 TC 失败应阻塞后续 Group 执行。

## 环境信息

| 项目 | 值 |
|------|-----|
| Sidecar 端口 | 3210 |
| Vite 端口 | 1420 |
| CDP 端口 | 9222 |
| 截图目录 | `.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots/` |
| CDP 脚本 | `/Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js` |
| 视觉脚本 | `/Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py` |

### 公共变量

```bash
CDP="/Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js"
VISION="/Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py"
SS_DIR="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots"
WS_URL=$(curl -s http://localhost:9222/json/list | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['webSocketDebuggerUrl'])")
mkdir -p "$SS_DIR"
```

---

## TC-0.1: Sidecar 健康检查

### 目标

验证 sidecar 进程已启动且 HTTP 服务可用。

### 前置条件

- `npm run dev` 已执行，Electron 窗口已打开

### 测试步骤

#### 协议验证

```bash
curl -s http://localhost:3210/health
```

#### DOM 验证

> 不适用。本 TC 仅验证 HTTP 层。

#### 视觉验证

> 不适用。

### 期望结果

| 维度 | 期望 |
|------|------|
| 协议 | HTTP 200，body 为 `{"status":"ok"}` |
| DOM | N/A |
| 视觉 | N/A |

### 实际结果

| 维度 | 结果 | 证据 |
|------|------|------|
| 协议 | ⬜ PASS/FAIL | curl 输出: |
| DOM | — | N/A |
| 视觉 | — | N/A |

---

## TC-0.2: WS 连接 + 初始广播

### 目标

验证前端 WebSocket 连接 sidecar 后，能收到全部 4 种初始广播消息（config.providers、config.skills、config.agents、model.list）。

### 前置条件

- TC-0.1 通过（sidecar HTTP 健康）

### 测试步骤

#### 协议验证

```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
const expected = new Set([
  'config.providers',
  'config.skills',
  'config.agents',
  'model.list'
]);
const received = new Set();

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    if (msg.type && expected.has(msg.type)) {
      received.add(msg.type);
      console.log('[RECV]', msg.type, '| payload keys:', msg.payload ? Object.keys(msg.payload).slice(0,5).join(',') : 'none');
    }
  } catch(e) {}
});

ws.on('open', () => console.log('[OPEN] Connected'));

setTimeout(() => {
  ws.close();
  console.log('---');
  console.log('Expected:', [...expected].join(', '));
  console.log('Received:', [...received].join(', '));
  const missing = [...expected].filter(t => !received.has(t));
  if (missing.length === 0) {
    console.log('RESULT: PASS — all 4 broadcasts received');
  } else {
    console.log('RESULT: FAIL — missing:', missing.join(', '));
  }
  process.exit(missing.length === 0 ? 0 : 1);
}, 5000);
"
```

#### DOM 验证

> 不适用。本 TC 仅验证 WS 协议层。

#### 视觉验证

> 不适用。

### 期望结果

| 维度 | 期望 |
|------|------|
| 协议 | 5 秒内收到 4 种广播，每种至少 1 条 |
| DOM | N/A |
| 视觉 | N/A |

### 实际结果

| 维度 | 结果 | 证据 |
|------|------|------|
| 协议 | ⬜ PASS/FAIL | node 输出: |
| DOM | — | N/A |
| 视觉 | — | N/A |

---

## TC-0.3: CDP 连通 + 页面渲染

### 目标

验证 Chrome DevTools Protocol 可连接，Electron 渲染进程已加载页面，且页面包含基本的 sidebar 和 content 区域。

### 前置条件

- TC-0.1 通过
- Chrome/Electron 已启用 `--remote-debugging-port=9222`

### 测试步骤

#### 协议验证

> 不适用。本 TC 验证 CDP + DOM + 视觉层。

#### DOM 验证

```bash
# 1. 获取 CDP 连接地址
WS_URL=$(curl -s http://localhost:9222/json/list | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['webSocketDebuggerUrl'])")
echo "CDP WS_URL: $WS_URL"

# 2. 检查 document.title
node "$CDP" "$WS_URL" Runtime.evaluate '{"expression":"document.title"}'
# 期望: title 包含 "xyz-agent" 或项目名

# 3. 检查 sidebar-item 元素存在（设置页面应有 4 个 tab）
node "$CDP" "$WS_URL" Runtime.evaluate '{"expression":"document.querySelectorAll(\".sidebar-item\").length"}'
# 期望: result.value >= 4

# 4. 如果当前不在设置页面，通过 CDP 模拟 Cmd+, 打开设置
# 先检查当前视图状态
node "$CDP" "$WS_URL" Runtime.evaluate '{"expression":"document.querySelector(\"[data-view=settings]\") ? \"on-settings\" : \"not-on-settings\""}'
# 如果返回 not-on-settings，执行导航：
node "$CDP" "$WS_URL" Runtime.evaluate '{"expression":"document.querySelector(\".settings-trigger, .settings-btn, [aria-label=Settings]\")?.click()"}'
# 等待 500ms 让页面渲染
sleep 0.5
```

#### 视觉验证

```bash
# 1. 截图整个页面
node "$CDP" "$WS_URL" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SS_DIR/actual-settings-page.png','wb').write(base64.b64decode(data)) if data else print('fail')"

# 2. 用 zai-vision analyze-image 分析截图，确认包含 sidebar + content 区域
python3 "$VISION" analyze-image "$SS_DIR/actual-settings-page.png" \
  "这张截图是否包含左侧 sidebar 和右侧 content 主内容区域？请确认：1) 左侧是否有导航栏/sidebar，2) 右侧是否有内容区域，3) 页面整体布局是否为典型的设置页面。用 JSON 格式回答: {\"has_sidebar\": bool, \"has_content\": bool, \"layout\": \"settings/other\", \"confidence\": 0-1}"
```

### 期望结果

| 维度 | 期望 |
|------|------|
| 协议 | N/A |
| DOM | `document.title` 非空；`.sidebar-item` 数量 >= 4 |
| 视觉 | zai-vision 确认 has_sidebar=true, has_content=true |

### 实际结果

| 维度 | 结果 | 证据 |
|------|------|------|
| 协议 | — | N/A |
| DOM | ⬜ PASS/FAIL | title=, sidebar-item count= |
| 视觉 | ⬜ PASS/FAIL | 截图: `screenshots/actual-settings-page.png`, zai-vision 输出: |

---

## TC-0.4: 设置页面 Sidebar 渲染

### 目标

验证设置页面 sidebar 正确渲染 4 个 tab（Providers / Skills / Agents / System）。

### 前置条件

- TC-0.3 通过（CDP 连通 + 页面已渲染）

### 测试步骤

#### 协议验证

> 不适用。本 TC 验证 DOM + 视觉层。

#### DOM 验证

```bash
# 1. 获取 sidebar-item 的文本内容
node "$CDP" "$WS_URL" Runtime.evaluate '{"expression":"JSON.stringify([...document.querySelectorAll(\".sidebar-item\")].map(el => el.textContent.trim()))"}'
# 期望: 包含 "Providers", "Skills", "Agents", "System" 四个文本

# 2. 检查每个 sidebar-item 是否可点击（有 click handler 或 role="tab"）
node "$CDP" "$WS_URL" Runtime.evaluate '{"expression":"JSON.stringify([...document.querySelectorAll(\".sidebar-item\")].map(el => ({text: el.textContent.trim(), role: el.getAttribute(\"role\"), tabindex: el.getAttribute(\"tabindex\"), clickable: el.onclick !== null || el.getAttribute(\"role\") === \"tab\"})))"}'
# 期望: 每个元素 role="tab" 或 tabindex 可聚焦

# 3. 点击第一个 tab (Providers) 验证交互
node "$CDP" "$WS_URL" Runtime.evaluate '{"expression":"document.querySelectorAll(\".sidebar-item\")[0]?.click(); \"clicked\""}'
sleep 0.3

# 4. 检查点击后 content 区域是否有对应内容加载
node "$CDP" "$WS_URL" Runtime.evaluate '{"expression":"document.querySelector(\".settings-content, .content-area, [data-content]\") ? \"content-exists\" : \"no-content\""}'
```

#### 视觉验证

```bash
# 1. 截图设置页面 sidebar 特写 — 先获取 sidebar 元素的 bounding box，再裁剪
# 先截完整页面
node "$CDP" "$WS_URL" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SS_DIR/actual-settings-sidebar.png','wb').write(base64.b64decode(data)) if data else print('fail')"

# 2. 获取 sidebar 的布局信息用于定位
node "$CDP" "$WS_URL" Runtime.evaluate '{"expression":"JSON.stringify([...document.querySelectorAll(\".sidebar-item\")].map(el => {const r = el.getBoundingClientRect(); return {text: el.textContent.trim(), x: r.x, y: r.y, w: r.width, h: r.height}}))"}'
# 记录各 tab 的坐标用于后续裁剪或分析

# 3. 用 zai-vision 分析 sidebar 截图
python3 "$VISION" analyze-image "$SS_DIR/actual-settings-sidebar.png" \
  "这张截图是否显示了一个设置页面的左侧 sidebar？请确认：1) 能看到 Providers/Skills/Agents/System 四个导航项，2) 第一个 tab (Providers) 是否处于选中/高亮状态，3) sidebar 的视觉样式是否正常（无空白、无错位）。用 JSON 格式回答: {\"sidebar_visible\": bool, \"tabs\": [\"Providers\",\"Skills\",\"Agents\",\"System\"], \"active_tab\": string, \"visual_ok\": bool, \"confidence\": 0-1}"
```

### 期望结果

| 维度 | 期望 |
|------|------|
| 协议 | N/A |
| DOM | 4 个 `.sidebar-item`，文本分别为 Providers/Skills/Agents/System；点击后 content 区域有内容加载 |
| 视觉 | zai-vision 确认 sidebar_visible=true, tabs 包含全部 4 项, visual_ok=true |

### 实际结果

| 维度 | 结果 | 证据 |
|------|------|------|
| 协议 | — | N/A |
| DOM | ⬜ PASS/FAIL | sidebar-items=, content 状态= |
| 视觉 | ⬜ PASS/FAIL | 截图: `screenshots/actual-settings-sidebar.png`, zai-vision 输出: |

---

## Group 0 汇总

| TC | 协议 | DOM | 视觉 | 状态 |
|----|------|-----|------|------|
| TC-0.1 Sidecar 健康检查 | ⬜ | — | — | ⬜ PASS/FAIL |
| TC-0.2 WS 连接 + 初始广播 | ⬜ | — | — | ⬜ PASS/FAIL |
| TC-0.3 CDP 连通 + 页面渲染 | — | ⬜ | ⬜ | ⬜ PASS/FAIL |
| TC-0.4 设置页面 Sidebar 渲染 | — | ⬜ | ⬜ | ⬜ PASS/FAIL |

**通过条件**: 全部 4 个 TC 均为 PASS，否则阻塞后续 Group 执行。

### 失败排查指引

| 失败 TC | 可能原因 | 排查方向 |
|---------|---------|---------|
| TC-0.1 | sidecar 未启动 / 端口被占用 | `lsof -i :3210`，检查 `npm run dev` 输出 |
| TC-0.2 | WS 连接失败 / sidecar 未发送初始广播 | 检查 sidecar `server.ts` 的 `connection` handler |
| TC-0.3 | CDP 端口未启用 / 页面未加载 | 检查 Electron 启动参数 `--remote-debugging-port=9222`；`lsof -i :1420` 确认 Vite |
| TC-0.4 | 设置路由未正确渲染 / sidebar 组件问题 | 检查 `settingsStore.currentView` 和 sidebar 组件渲染逻辑 |
