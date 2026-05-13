# Settings 重设计 — E2E 测试方案 v2

> 测试目标：验证 Settings 模块重设计的端到端功能，覆盖 WS 协议正确性、数据持久化、**UI 视觉还原度**。
> 核心方法：chrome-automation skill（CDP 截图 + DOM 操作）+ zai-vision skill（AI 视觉对比）+ WS 协议脚本。

---

## 1. 测试策略

### 1.1 三层验证模型

```
Layer 1: 协议层 — WS 消息格式、往返正确性（Node.js 脚本）
Layer 2: DOM 层 — 组件渲染、交互响应、状态变化（CDP JS evaluate）
Layer 3: 视觉层 — 设计稿还原度、间距/颜色/布局（CDP 截图 + zai-vision ui-diff）
```

| 层 | 工具 | 关注点 | 何时用 |
|----|------|--------|--------|
| 协议层 | Node.js WS 客户端 | WS 消息 type/payload 格式 | 每个 CRUD 操作 |
| DOM 层 | chrome-automation `Runtime.evaluate` | 组件挂载、class 状态、属性值 | 每个 UI 交互 |
| 视觉层 | chrome-automation 截图 + zai-vision `ui-diff` | 设计稿还原度 | 每个 Tab 的整体视觉 + 关键交互状态 |

### 1.2 视觉测试方案

**核心思路**：设计稿 HTML (`docs/designs/settings-final.html`) 在浏览器中打开截图作为"期望图"，实际 Electron 应用截图作为"实际图"，用 `zai-vision ui-diff` 做 AI 视觉对比。

**优势**：
- 不依赖像素级 diff（设计稿和实际 DOM 不同，但视觉风格应一致）
- AI 能理解"视觉等价"（如颜色接近、间距微调是 OK 的）
- 能输出具体差异描述和严重程度

**操作流程**：
1. 在 Chrome 中打开设计稿 HTML → 截图各 Tab 区域 → 保存为 `expected-*.png`
2. 在 Electron 中操作到对应状态 → 截图 → 保存为 `actual-*.png`
3. 运行 `zai-vision ui-diff expected-X.png actual-X.png "检查布局和颜色差异"`
4. AI 输出差异报告（相似度评估 + 具体差异列表）

### 1.3 截图对比矩阵

| 截图 ID | 设计稿区域 | 实际对应 | 对比重点 |
|---------|-----------|---------|---------|
| `expected-provider-tab.png` | Provider tab 全页 | `actual-provider-tab.png` | Section 卡片风格、header 底色、model rows |
| `expected-provider-section.png` | Anthropic section 特写 | `actual-provider-section.png` | Avatar、status dot、toggle、badge |
| `expected-skill-scan.png` | Skill 扫描区域 | `actual-skill-scan.png` | Source chips、扫描结果列表、导入栏 |
| `expected-skill-imported.png` | Skill 已导入列表 | `actual-skill-imported.png` | SkillSection 卡片、展开详情、MetaGrid |
| `expected-agent-scan.png` | Agent 扫描区域 | `actual-agent-scan.png` | Source chips、扫描结果 |
| `expected-agent-section.png` | Agent section（含 confirm-bar）| `actual-agent-section.png` | Avatar、策略 select、工具行、confirm-bar |
| `expected-system-tab.png` | System tab 全页 | `actual-system-tab.png` | 两个 section、palette 按钮 |

---

## 2. 前置条件

### 2.1 环境准备

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider

# 安装依赖
npm install

# 确认端口空闲
lsof -i :1420 -P | grep LISTEN && echo "1420 in use" || echo "1420 free"
lsof -i :3210 -P | grep LISTEN && echo "3210 in use" || echo "3210 free"

# 确认 zai-vision 可用
python3 /Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py --help
echo $Z_AI_API_KEY | head -c 5 && echo "... (API key set)"
```

### 2.2 启动服务

```bash
# 终端 1：启动 sidecar
cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider
npx tsx src-electron/sidecar/src/index.ts --port 3210 --project-root "$(pwd)"
```

```bash
# 终端 2：启动前端
cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider
npm run dev
```

等待 Electron 窗口弹出。

### 2.3 准备 CDP 连接

```bash
# Electron 默认 remote debugging 端口 9222
# 获取 WS URL
WS_URL=$(curl -s http://localhost:9222/json/list | python3 -c "import sys,json; tabs=json.load(sys.stdin); print(tabs[0]['webSocketDebuggerUrl'])")
echo "CDP WS URL: $WS_URL"

# CDP 脚本路径
CDP="/Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js"

# 验证 CDP 连通
node "$CDP" "$WS_URL" Runtime.evaluate '{"expression":"document.title","returnByValue":true}'
```

### 2.4 生成设计稿基准截图

```bash
# 在 Chrome 中打开设计稿 HTML
open -a "Google Chrome" /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/docs/designs/settings-final.html

# 等待加载
sleep 2

# 获取 Chrome 的 CDP WS URL
CHROME_WS=$(curl -s http://localhost:9222/json/list | python3 -c "import sys,json; tabs=json.load(sys.stdin); matching=[t for t in tabs if 'settings-final' in t.get('url','')]; print(matching[0]['webSocketDebuggerUrl'] if matching else '')")

# 截图各 Tab（通过 JS 切换 tab 后截图）
SCREENSHOT_DIR="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots"
mkdir -p "$SCREENSHOT_DIR"

# Provider tab
node "$CDP" "$CHROME_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var el=document.querySelector(\"[data-tab=providers]\");if(el)el.click();return \"clicked\"})()"}'
sleep 0.5
node "$CDP" "$CHROME_WS" Page.captureScreenshot '{"format":"png"}' | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SCREENSHOT_DIR/expected-provider-tab.png','wb').write(base64.b64decode(data)) if data else print('fail')"

# Skill tab
node "$CDP" "$CHROME_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var el=document.querySelector(\"[data-tab=skills]\");if(el)el.click();return \"clicked\"})()"}'
sleep 0.5
node "$CDP" "$CHROME_WS" Page.captureScreenshot '{"format":"png"}' | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SCREENSHOT_DIR/expected-skill-scan.png','wb').write(base64.b64decode(data)) if data else print('fail')"

# Agent tab
node "$CDP" "$CHROME_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var el=document.querySelector(\"[data-tab=agents]\");if(el)el.click();return \"clicked\"})()"}'
sleep 0.5
node "$CDP" "$CHROME_WS" Page.captureScreenshot '{"format":"png"}' | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SCREENSHOT_DIR/expected-agent-tab.png','wb').write(base64.b64decode(data)) if data else print('fail')"

# System tab
node "$CDP" "$CHROME_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var el=document.querySelector(\"[data-tab=system]\");if(el)el.click();return \"clicked\"})()"}'
sleep 0.5
node "$CDP" "$CHROME_WS" Page.captureScreenshot '{"format":"png"}' | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SCREENSHOT_DIR/expected-system-tab.png','wb').write(base64.b64decode(data)) if data else print('fail')"
```

---

## 3. 测试组依赖关系

```
Group 0: 基础连通性 + CDP 就绪
  └── 所有后续 Group 依赖

Group 1: Provider Tab（WS 协议 + DOM + 视觉截图）
  ├── 依赖 Group 0

Group 2: Skill Tab（WS 协议 + DOM + 视觉截图）
  ├── 依赖 Group 0
  ├── TC-2.3 依赖 TC-2.2
  └── TC-2.5/2.6 依赖 TC-2.3

Group 3: Agent Tab（WS 协议 + DOM + 视觉截图）
  ├── 依赖 Group 0
  ├── TC-3.3 依赖 TC-3.2
  └── TC-3.5/3.6 依赖 TC-3.3

Group 4: System Tab（DOM + 视觉截图）
  ├── 依赖 Group 0

Group 5: 跨 Tab 持久化 + 全局视觉
  ├── 依赖 Group 1/2/3
```

---

## 4. 每个 TC 的验证维度

每个测试用例包含以下验证维度：

| 维度 | 方法 | 何时必须 |
|------|------|---------|
| **协议正确性** | WS 消息 type + payload 检查 | 所有 CRUD 操作 |
| **DOM 状态** | CDP `Runtime.evaluate` 检查 class/属性/文本 | 所有 UI 交互 |
| **视觉截图** | CDP `Page.captureScreenshot` | 每个 Tab 的整体视觉 + 关键交互状态变化 |
| **视觉对比** | `zai-vision ui-diff` | 每个视觉截图与设计稿对比 |
| **持久化** | 文件系统检查 | 导入/删除后 |

---

## 5. 测试文件索引

| 文件 | 测试组 | 说明 |
|------|--------|------|
| `README.md` | — | 本文件：策略、环境准备、工具说明 |
| `e2e-group0-foundation.md` | Group 0 | 基础连通性：sidecar、WS、CDP、初始广播 |
| `e2e-group1-provider.md` | Group 1 | Provider Tab：CRUD + 视觉截图对比 |
| `e2e-group2-skill.md` | Group 2 | Skill Tab：扫描/导入/CRUD + 视觉截图对比 |
| `e2e-group3-agent.md` | Group 3 | Agent Tab：扫描/导入/CRUD/confirm-bar + 视觉截图对比 |
| `e2e-group4-system.md` | Group 4 | System Tab：语言/外观/主题 + 视觉截图对比 |
| `e2e-group5-persistence.md` | Group 5 | 跨 Tab 持久化 + 刷新恢复 + 全局视觉 |

---

## 6. 测试结果汇总

### 6.1 功能测试结果

| TC ID | 测试目标 | 协议 | DOM | 视觉 | 持久化 | 总体 |
|-------|---------|------|-----|------|--------|------|
| TC-0.1 | Sidecar 健康检查 | ⬜ | — | — | — | ⬜ |
| TC-0.2 | WS 连接 + 初始广播 | ⬜ | — | — | — | ⬜ |
| TC-0.3 | CDP 连通 + 页面渲染 | — | ⬜ | ⬜ | — | ⬜ |
| TC-1.1 | Provider Section 渲染 | ⬜ | ⬜ | ⬜ | — | ⬜ |
| TC-1.2 | Provider Toggle | ⬜ | ⬜ | ⬜ | — | ⬜ |
| TC-1.3 | Provider 编辑 | ⬜ | ⬜ | — | ⬜ | ⬜ |
| TC-1.4 | Provider 删除 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| TC-1.5 | Model Row Toggle | ⬜ | ⬜ | — | — | ⬜ |
| TC-2.1 | Skill 扫描源 Chips | — | ⬜ | ⬜ | — | ⬜ |
| TC-2.2 | Skill 扫描执行 | ⬜ | ⬜ | ⬜ | — | ⬜ |
| TC-2.3 | Skill 导入 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| TC-2.4 | Skill Toggle | ⬜ | ⬜ | — | ⬜ | ⬜ |
| TC-2.5 | Skill 删除 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| TC-2.6 | Skill 展开详情 | — | ⬜ | ⬜ | — | ⬜ |
| TC-3.1 | Agent 扫描源 Chips | — | ⬜ | ⬜ | — | ⬜ |
| TC-3.2 | Agent 扫描执行 | ⬜ | ⬜ | ⬜ | — | ⬜ |
| TC-3.3 | Agent 导入 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| TC-3.4 | Agent Toggle | ⬜ | ⬜ | — | ⬜ | ⬜ |
| TC-3.5 | Agent 删除 confirm-bar | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| TC-3.6 | Agent 策略切换 | ⬜ | ⬜ | — | ⬜ | ⬜ |
| TC-4.1 | System 渲染 | — | ⬜ | ⬜ | — | ⬜ |
| TC-4.2 | 语言切换 | — | ⬜ | — | ⬜ | ⬜ |
| TC-4.3 | 外观模式切换 | — | ⬜ | ⬜ | ⬜ | ⬜ |
| TC-4.4 | 配色主题切换 | — | ⬜ | ⬜ | ⬜ | ⬜ |
| TC-5.1 | Provider 刷新保持 | ⬜ | ⬜ | — | ⬜ | ⬜ |
| TC-5.2 | Skill 刷新保持 | ⬜ | ⬜ | — | ⬜ | ⬜ |
| TC-5.3 | Agent 刷新保持 | ⬜ | ⬜ | — | ⬜ | ⬜ |
| TC-5.4 | 全局视觉对比 | — | — | ⬜ | — | ⬜ |

### 6.2 视觉对比结果

| 对比 ID | 期望图 | 实际图 | zai-vision 评估 | 主要差异 |
|---------|--------|--------|----------------|---------|
| VIS-1 | expected-provider-tab.png | actual-provider-tab.png | ⬜ | |
| VIS-2 | expected-skill-scan.png | actual-skill-scan.png | ⬜ | |
| VIS-3 | expected-agent-tab.png | actual-agent-tab.png | ⬜ | |
| VIS-4 | expected-system-tab.png | actual-system-tab.png | ⬜ | |

---

## 7. 通用工具脚本

### 7.1 CDP 截图函数

```bash
# 用法: screenshot "$WS_URL" "$OUTPUT_PATH"
screenshot() {
  node "$CDP" "$1" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | \
    python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$2','wb').write(base64.b64decode(data)) if data else print('screenshot failed')"
}
```

### 7.2 zai-vision ui-diff 函数

```bash
# 用法: uidiff "$EXPECTED" "$ACTUAL" "$DESCRIPTION"
uidiff() {
  python3 /Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py \
    ui-diff "$1" "$2" "$3"
}
```

### 7.3 WS 协议测试函数

```bash
# 用法: ws_test "$MESSAGE_JSON" "$EXPECTED_TYPE" "$TIMEOUT_SEC"
ws_test() {
  node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
const expectedType = '$2';
const timeout = ($3 || 10) * 1000;
ws.on('open', () => ws.send('$1'));
const results = [];
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === expectedType) {
    console.log(JSON.stringify(msg.payload, null, 2));
    ws.close();
  } else {
    results.push(msg.type);
  }
});
setTimeout(() => { console.error('TIMEOUT. Received:', results.join(', ')); process.exit(1); }, timeout);
"
}
```

### 7.4 DOM 检查函数

```bash
# 用法: dom_check "$WS_URL" "$JS_EXPRESSION"
dom_check() {
  node "$CDP" "$1" Runtime.evaluate "{\"returnByValue\":true,\"expression\":\"$2\"}"
}
```
