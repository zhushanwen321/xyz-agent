# E2E Group 0: 基础连通性测试

> **优先级**: P0 — 阻塞所有后续测试组
> **前置依赖**: 无
> **通过条件**: 全部 6 个 TC 通过

## 目录

| TC | 名称 | 验证目标 |
|----|------|----------|
| TC-0.1 | Sidecar 健康检查 | HTTP 健康端点可用 |
| TC-0.2 | WS 连接建立 | 前端到 sidecar 的 WebSocket 连通 |
| TC-0.3 | 初始广播 providers | 连接后推送 providers 配置 |
| TC-0.4 | 初始广播 skills | 连接后推送 skills 配置 |
| TC-0.5 | 初始广播 agents | 连接后推送 agents 配置 |
| TC-0.6 | Settings 页面渲染 | Electron 窗口 + Settings 页面正常 |

## 环境准备

```bash
# 项目目录
cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider

# 1. 启动 sidecar（终端 1）
npx tsx src-electron/sidecar/src/index.ts --port 3210 --project-root "$(pwd)"

# 2. 启动前端（终端 2）
npm run dev

# 3. 等待 Vite 就绪（端口 1420）和 Electron 窗口出现
# Electron remote debugging 端口: 9222
```

---

## TC-0.1: Sidecar 健康检查

| 字段 | 内容 |
|------|------|
| **ID** | TC-0.1 |
| **目标** | 确认 sidecar 进程启动且 HTTP 健康检查端点可用 |
| **前置条件** | sidecar 进程已启动（环境准备步骤 1） |

### 测试步骤

```bash
curl -s http://localhost:3210/health
```

### 期望结果

- HTTP 状态码 `200`
- 响应体为 JSON，包含 `status` 字段值为 `"ok"`
- 响应体包含 `uptime` 字段（数字，单位秒）

```json
{"status":"ok","uptime":12}
```

### 衡量方法

```bash
# 自动化验证脚本
response=$(curl -s -w "\n%{http_code}" http://localhost:3210/health)
http_code=$(echo "$response" | tail -1)
body=$(echo "$response" | sed '$d')

[ "$http_code" = "200" ] && \
echo "$body" | jq -e '.status == "ok"' > /dev/null && \
echo "$body" | jq -e '.uptime | type == "number"' > /dev/null && \
echo "PASS" || echo "FAIL"
```

### 结果记录

| 项目 | 值 |
|------|----|
| 执行时间 | |
| HTTP 状态码 | |
| 响应体 | |
| 结果 | PASS / FAIL |
| 备注 | |

---

## TC-0.2: WS 连接建立

| 字段 | 内容 |
|------|------|
| **ID** | TC-0.2 |
| **目标** | 确认前端能通过 WebSocket 连接到 sidecar |
| **前置条件** | TC-0.1 通过 |

### 测试步骤

创建临时测试脚本：

```javascript
// /tmp/tc-0.2-ws-connect.mjs
import { WebSocket } from 'ws'

const ws = new WebSocket('ws://localhost:3210')
let result = 'FAIL'

ws.on('open', () => {
  console.log('状态:', ws.readyState, '(1 = OPEN)')
  result = 'PASS'
  ws.close()
})

ws.on('error', (err) => {
  console.error('连接错误:', err.message)
  result = 'FAIL'
})

ws.on('close', () => {
  console.log('结果:', result)
  process.exit(result === 'PASS' ? 0 : 1)
})

// 5 秒超时
setTimeout(() => {
  console.error('超时：5 秒内未连接')
  ws.close()
  process.exit(1)
}, 5000)
```

```bash
node /tmp/tc-0.2-ws-connect.mjs
```

### 期望结果

- 连接成功建立，无报错
- `ws.readyState` 为 `1`（OPEN）
- 脚本退出码为 `0`

### 衡量方法

- 控制台输出 `状态: 1 (1 = OPEN)`
- 控制台输出 `结果: PASS`
- 进程退出码 `0`

### 结果记录

| 项目 | 值 |
|------|----|
| 执行时间 | |
| 连接状态 | |
| 错误信息（如有） | |
| 结果 | PASS / FAIL |
| 备注 | |

---

## TC-0.3: 初始广播 providers

| 字段 | 内容 |
|------|------|
| **ID** | TC-0.3 |
| **目标** | WS 连接后 sidecar 主动推送 `config.providers` 消息 |
| **前置条件** | TC-0.2 通过 |

### 测试步骤

```javascript
// /tmp/tc-0.3-providers.mjs
import { WebSocket } from 'ws'

const ws = new WebSocket('ws://localhost:3210')
const messages = []

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString())
    messages.push(msg)
  } catch {}
})

ws.on('open', () => {
  // 等待 sidecar 推送初始消息
  setTimeout(() => {
    ws.close()
  }, 3000)
})

ws.on('close', () => {
  const providersMsg = messages.find(m => m.type === 'config.providers')

  if (!providersMsg) {
    console.log('FAIL: 未收到 config.providers 消息')
    console.log('收到的消息类型:', messages.map(m => m.type))
    process.exit(1)
  }

  const { payload } = providersMsg
  const isArray = Array.isArray(payload?.providers)

  console.log('消息类型:', providersMsg.type)
  console.log('payload.providers 类型:', isArray ? 'Array' : typeof payload?.providers)
  console.log('providers 数量:', isArray ? payload.providers.length : 'N/A')

  if (isArray) {
    console.log('PASS')
    process.exit(0)
  } else {
    console.log('FAIL: payload.providers 不是数组')
    process.exit(1)
  }
})

setTimeout(() => { process.exit(1) }, 10000)
```

```bash
node /tmp/tc-0.3-providers.mjs
```

### 期望结果

- 收到 `type === 'config.providers'` 消息
- `payload.providers` 是数组
- 数组内容为当前配置的 providers 列表（可为空数组）

### 衡量方法

- 控制台输出 `PASS`
- 打印了 providers 数量
- 进程退出码 `0`

### 结果记录

| 项目 | 值 |
|------|----|
| 执行时间 | |
| providers 数量 | |
| 消息原始内容 | |
| 结果 | PASS / FAIL |
| 备注 | |

---

## TC-0.4: 初始广播 skills

| 字段 | 内容 |
|------|------|
| **ID** | TC-0.4 |
| **目标** | WS 连接后 sidecar 主动推送 `config.skills` 消息 |
| **前置条件** | TC-0.2 通过 |

### 测试步骤

```javascript
// /tmp/tc-0.4-skills.mjs
import { WebSocket } from 'ws'

const ws = new WebSocket('ws://localhost:3210')
const messages = []

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString())
    messages.push(msg)
  } catch {}
})

ws.on('open', () => {
  setTimeout(() => { ws.close() }, 3000)
})

ws.on('close', () => {
  const skillsMsg = messages.find(m => m.type === 'config.skills')

  if (!skillsMsg) {
    console.log('FAIL: 未收到 config.skills 消息')
    console.log('收到的消息类型:', messages.map(m => m.type))
    process.exit(1)
  }

  const { payload } = skillsMsg
  const isArray = Array.isArray(payload?.skills)

  console.log('消息类型:', skillsMsg.type)
  console.log('payload.skills 类型:', isArray ? 'Array' : typeof payload?.skills)
  console.log('skills 数量:', isArray ? payload.skills.length : 'N/A')

  if (isArray) {
    console.log('PASS')
    process.exit(0)
  } else {
    console.log('FAIL: payload.skills 不是数组')
    process.exit(1)
  }
})

setTimeout(() => { process.exit(1) }, 10000)
```

```bash
node /tmp/tc-0.4-skills.mjs
```

### 期望结果

- 收到 `type === 'config.skills'` 消息
- `payload.skills` 是数组（初始可为空数组）

### 衡量方法

- 控制台输出 `PASS`
- 进程退出码 `0`

### 结果记录

| 项目 | 值 |
|------|----|
| 执行时间 | |
| skills 数量 | |
| 消息原始内容 | |
| 结果 | PASS / FAIL |
| 备注 | |

---

## TC-0.5: 初始广播 agents

| 字段 | 内容 |
|------|------|
| **ID** | TC-0.5 |
| **目标** | WS 连接后 sidecar 主动推送 `config.agents` 消息 |
| **前置条件** | TC-0.2 通过 |

### 测试步骤

```javascript
// /tmp/tc-0.5-agents.mjs
import { WebSocket } from 'ws'

const ws = new WebSocket('ws://localhost:3210')
const messages = []

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString())
    messages.push(msg)
  } catch {}
})

ws.on('open', () => {
  setTimeout(() => { ws.close() }, 3000)
})

ws.on('close', () => {
  const agentsMsg = messages.find(m => m.type === 'config.agents')

  if (!agentsMsg) {
    console.log('FAIL: 未收到 config.agents 消息')
    console.log('收到的消息类型:', messages.map(m => m.type))
    process.exit(1)
  }

  console.log('消息类型:', agentsMsg.type)
  console.log('payload:', JSON.stringify(agentsMsg.payload, null, 2))

  console.log('PASS')
  process.exit(0)
})

setTimeout(() => { process.exit(1) }, 10000)
```

```bash
node /tmp/tc-0.5-agents.mjs
```

### 期望结果

- 收到 `type === 'config.agents'` 消息
- 消息包含 `payload` 字段

### 衡量方法

- 控制台输出 `PASS`
- 进程退出码 `0`

### 结果记录

| 项目 | 值 |
|------|----|
| 执行时间 | |
| payload 内容 | |
| 结果 | PASS / FAIL |
| 备注 | |

---

## TC-0.6: Settings 页面渲染

| 字段 | 内容 |
|------|------|
| **ID** | TC-0.6 |
| **目标** | 确认 Electron 窗口打开后，Settings 页面可以正常渲染 |
| **前置条件** | TC-0.1 ~ TC-0.5 全部通过，`npm run dev` 已启动 |

### 测试步骤

#### 步骤 1: 确认 Electron remote debugging 可用

```bash
curl -s http://localhost:9222/json/version | jq '.Browser'
```

期望返回 Electron 版本信息。

#### 步骤 2: 检查 DOM 中 sidebar 存在

```bash
# 获取第一个页面的 webSocketDebuggerUrl
WS_URL=$(curl -s http://localhost:9222/json | jq -r '.[0].webSocketDebuggerUrl')

# 通过 CDP 执行 JS，检查 sidebar-item 元素
node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('${WS_URL}');
let id = 1;

function send(method, params = {}) {
  return new Promise(resolve => {
    const msgId = id++;
    ws.send(JSON.stringify({ id: msgId, method, params }));
    ws.on('message', function handler(raw) {
      const msg = JSON.parse(raw);
      if (msg.id === msgId) {
        ws.removeListener('message', handler);
        resolve(msg);
      }
    });
  });
}

ws.on('open', async () => {
  // 检查 sidebar-item 元素
  const sidebarResult = await send('Runtime.evaluate', {
    expression: 'document.querySelectorAll(\"[data-testid=\\\"sidebar\\\"]\").length'
  });
  console.log('Sidebar 元素数量:', sidebarResult.result?.result?.value);

  // 点击 settings 导航项（如果有）
  await send('Runtime.evaluate', {
    expression: 'document.querySelector(\"[data-testid=\\\"sidebar-settings\\\"]\")?.click()'
  });

  // 等待渲染
  await new Promise(r => setTimeout(r, 1000));

  // 检查 settings 内容区域
  const settingsResult = await send('Runtime.evaluate', {
    expression: 'document.querySelector(\"[data-testid=\\\"settings-page\\\"]\") !== null'
  });
  console.log('Settings 页面存在:', settingsResult.result?.result?.value);

  ws.close();
});
" 2>&1
```

> **注意**: 如果项目未使用 `data-testid` 属性，替换选择器为实际使用的 CSS 选择器或组件类名。可通过以下命令先行探测：

```bash
# 探测实际 DOM 结构
node -e "
const { WebSocket } = require('ws');
const WS_URL = '$(curl -s http://localhost:9222/json | jq -r '.[0].webSocketDebuggerUrl')';
const ws = new WebSocket(WS_URL);
let id = 1;
ws.on('open', () => {
  const msgId = id++;
  ws.send(JSON.stringify({
    id: msgId,
    method: 'Runtime.evaluate',
    params: { expression: 'document.body.innerHTML.substring(0, 2000)' }
  }));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id === msgId) {
      console.log(msg.result?.result?.value);
      ws.close();
    }
  });
});
"
```

### 期望结果

- Electron DevTools 可连接（端口 9222）
- DOM 中存在 sidebar 相关元素
- 点击 settings 导航后，settings 页面内容区域出现

### 衡量方法

| 检查项 | 期望值 |
|--------|--------|
| DevTools 版本接口 | 返回 JSON，含 Browser 字段 |
| Sidebar 元素 | 数量 > 0 |
| Settings 页面 | `true` |

### 结果记录

| 项目 | 值 |
|------|----|
| 执行时间 | |
| Electron 版本 | |
| Sidebar 元素数量 | |
| Settings 页面存在 | |
| DOM 片段（调试用） | |
| 结果 | PASS / FAIL |
| 备注 | |

---

## 汇总

| TC | 名称 | 结果 | 耗时 | 备注 |
|----|------|------|------|------|
| TC-0.1 | Sidecar 健康检查 | | | |
| TC-0.2 | WS 连接建立 | | | |
| TC-0.3 | 初始广播 providers | | | |
| TC-0.4 | 初始广播 skills | | | |
| TC-0.5 | 初始广播 agents | | | |
| TC-0.6 | Settings 页面渲染 | | | |

**通过条件**: 6/6 PASS

**如果 TC-0.6 的选择器不匹配**: 先用探测脚本获取实际 DOM 结构，更新选择器后重新执行。
