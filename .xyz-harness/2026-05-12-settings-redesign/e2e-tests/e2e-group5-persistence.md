# E2E Group 5: 跨 Tab 持久化测试

> **优先级**: P1 — 数据持久化与多客户端一致性验证
> **前置依赖**: Group 1（Provider CRUD）、Group 2（Skill CRUD）、Group 3（Agent CRUD）至少部分通过
> **通过条件**: 全部 6 个 TC 通过

## 目录

| TC | 名称 | 验证目标 |
|----|------|----------|
| TC-5.1 | Provider 刷新保持 | Provider 数据在页面刷新/重启后持久化 |
| TC-5.2 | Skill 刷新保持 | Skill 数据在 sidecar 重启后持久化 |
| TC-5.3 | Agent 刷新保持 | Agent 数据在 sidecar 重启后持久化 |
| TC-5.4 | 多客户端广播一致性 | 操作变更通过 WS 广播同步到所有客户端 |
| TC-5.5 | Skill 文件格式验证 | `.xyz-agent/skills.json` 文件结构与字段完整性 |
| TC-5.6 | Agent 文件格式验证 | `.xyz-agent/agents.json` 文件结构与字段完整性 |

## 环境准备

```bash
# 项目目录
cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider

# 持久化路径
XYZ_AGENT_DIR="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent"

# Sidecar 端口
SIDECAR_PORT=3210

# Electron remote debugging 端口
ELECTRON_DEBUG_PORT=9222

# 1. 启动 sidecar（终端 1）
npx tsx src-electron/sidecar/src/index.ts --port 3210 --project-root "$(pwd)"

# 2. 启动前端（终端 2）
npm run dev

# 3. 确认 Group 1/2/3 至少部分通过，已有 Provider/Skill/Agent 数据
```

### 重启 sidecar 辅助函数

```bash
# 获取 sidecar 进程 PID
get_sidecar_pid() {
  lsof -i :3210 -t -sTCP:LISTEN 2>/dev/null | head -1
}

# 重启 sidecar
restart_sidecar() {
  local pid=$(get_sidecar_pid)
  if [ -n "$pid" ]; then
    kill "$pid"
    echo "已终止 sidecar (PID: $pid)"
    sleep 2
  fi
  npx tsx src-electron/sidecar/src/index.ts --port 3210 --project-root "$(pwd)" &
  echo "sidecar 重新启动，等待就绪..."
  sleep 3

  # 验证重启成功
  curl -sf http://localhost:3210/health > /dev/null && \
    echo "sidecar 已就绪" || echo "sidecar 启动失败"
}
```

---

## TC-5.1: Provider 刷新保持

| 字段 | 内容 |
|------|------|
| **ID** | TC-5.1 |
| **目标** | 添加/修改 Provider 后刷新页面，数据持久化并正确恢复 |
| **前置条件** | TC-1.3 通过（已添加或修改了至少一个 Provider） |

### 测试步骤

#### 步骤 1: 记录当前 Provider 列表

```bash
# 通过 WS 获取当前 provider 快照
node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://localhost:3210');
const messages = [];
ws.on('message', (raw) => {
  try { messages.push(JSON.parse(raw.toString())); } catch {}
});
ws.on('open', () => {
  setTimeout(() => {
    ws.close();
    const msg = messages.find(m => m.type === 'config.providers');
    if (!msg) { console.log('FAIL: 未收到 config.providers'); process.exit(1); }
    // 保存快照到临时文件
    require('fs').writeFileSync('/tmp/tc-5.1-providers-before.json',
      JSON.stringify(msg.payload.providers, null, 2));
    console.log('刷新前 providers:');
    console.log(JSON.stringify(msg.payload.providers, null, 2));
    console.log('数量:', msg.payload.providers.length);
    process.exit(0);
  }, 3000);
});
setTimeout(() => { console.log('FAIL: 超时'); process.exit(1); }, 10000);
"
```

记录输出中的 provider 数量和每个 provider 的关键字段（name、apiKey 等）。

#### 步骤 2: 同时从磁盘读取持久化配置

```bash
# Provider 配置可能存储在项目 .xyz-agent/ 或全局 ~/.xyz-agent/config.json
# 检查两处
echo "--- 项目级配置 ---"
cat /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/config.json 2>/dev/null | jq '.providers' || echo "(不存在)"

echo "--- 全局级配置 ---"
cat ~/.xyz-agent/config.json 2>/dev/null | jq '.providers' || echo "(不存在)"
```

#### 步骤 3: 刷新 Electron 页面

```bash
# 通过 CDP 刷新页面
WS_URL=$(curl -s http://localhost:9222/json | jq -r '.[0].webSocketDebuggerUrl')

node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('${WS_URL}');
let id = 1;
ws.on('open', () => {
  ws.send(JSON.stringify({ id: id++, method: 'Page.reload' }));
  console.log('页面已刷新');
  setTimeout(() => { ws.close(); process.exit(0); }, 1000);
});
"
```

等待页面重新加载和 WS 重连（约 5 秒）：

```bash
sleep 5
```

#### 步骤 4: 检查 WS 连接后的 config.providers 初始广播

```bash
node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://localhost:3210');
const messages = [];
ws.on('message', (raw) => {
  try { messages.push(JSON.parse(raw.toString())); } catch {}
});
ws.on('open', () => {
  setTimeout(() => {
    ws.close();
    const msg = messages.find(m => m.type === 'config.providers');
    if (!msg) { console.log('FAIL: 刷新后未收到 config.providers'); process.exit(1); }

    require('fs').writeFileSync('/tmp/tc-5.1-providers-after.json',
      JSON.stringify(msg.payload.providers, null, 2));
    console.log('刷新后 providers:');
    console.log(JSON.stringify(msg.payload.providers, null, 2));
    console.log('数量:', msg.payload.providers.length);
    process.exit(0);
  }, 3000);
});
setTimeout(() => { console.log('FAIL: 超时'); process.exit(1); }, 10000);
"
```

#### 步骤 5: 比对刷新前后数据

```bash
# 逐字节比对两个快照
diff /tmp/tc-5.1-providers-before.json /tmp/tc-5.1-providers-after.json && \
  echo "PASS: 刷新前后数据完全一致" || \
  echo "FAIL: 刷新前后数据不一致"
```

#### 步骤 6: 检查 DOM 中 Provider section

```bash
WS_URL=$(curl -s http://localhost:9222/json | jq -r '.[0].webSocketDebuggerUrl')

node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('${WS_URL}');
let id = 1;
function send(expr) {
  return new Promise(resolve => {
    const msgId = id++;
    ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression: expr } }));
    const handler = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === msgId) { ws.removeListener('message', handler); resolve(msg.result?.result?.value); }
    };
    ws.on('message', handler);
  });
}
ws.on('open', async () => {
  // 根据 Group 0 探测到的实际选择器调整
  const count = await send('document.querySelectorAll(\"[data-testid=\\\"provider-item\\\"]\").length');
  console.log('DOM 中 provider-item 数量:', count);
  ws.close();
});
"
```

### 期望结果

- 刷新前后 `config.providers` 广播数据完全一致（diff 无差异）
- 磁盘配置文件中的 providers 数据与 WS 广播一致
- DOM 中 provider 元素数量与 WS 广播的数组长度一致

### 衡量方法

| 检查项 | 期望值 |
|--------|--------|
| 磁盘 config 文件 | 存在且包含 providers 字段 |
| WS 初始广播 providers | 与刷新前快照完全一致 |
| DOM provider 元素数量 | 与 providers 数组长度一致 |
| diff 结果 | 无差异 |

### 结果记录

| 项目 | 值 |
|------|----|
| 执行时间 | |
| 刷新前 provider 数量 | |
| 刷新后 provider 数量 | |
| diff 结果 | |
| DOM 元素数量 | |
| 结果 | PASS / FAIL |
| 备注 | |

---

## TC-5.2: Skill 刷新保持

| 字段 | 内容 |
|------|------|
| **ID** | TC-5.2 |
| **目标** | 导入 Skill 后重启 sidecar + 刷新前端，skill 数据完整持久化 |
| **前置条件** | TC-2.3 通过（已导入至少一个 Skill） |

### 测试步骤

#### 步骤 1: 记录当前 Skill 列表

```bash
node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://localhost:3210');
const messages = [];
ws.on('message', (raw) => {
  try { messages.push(JSON.parse(raw.toString())); } catch {}
});
ws.on('open', () => {
  setTimeout(() => {
    ws.close();
    const msg = messages.find(m => m.type === 'config.skills');
    if (!msg) { console.log('FAIL: 未收到 config.skills'); process.exit(1); }
    require('fs').writeFileSync('/tmp/tc-5.2-skills-before.json',
      JSON.stringify(msg.payload.skills, null, 2));
    console.log('重启前 skills:');
    console.log(JSON.stringify(msg.payload.skills, null, 2));
    console.log('数量:', msg.payload.skills.length);
    process.exit(0);
  }, 3000);
});
setTimeout(() => { console.log('FAIL: 超时'); process.exit(1); }, 10000);
"
```

#### 步骤 2: 读取磁盘 skills.json 文件

```bash
SKILLS_FILE="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/skills.json"

echo "--- skills.json 内容 ---"
if [ -f "$SKILLS_FILE" ]; then
  cat "$SKILLS_FILE" | jq '.' | tee /tmp/tc-5.2-skills-from-disk.json
  echo "文件大小: $(wc -c < "$SKILLS_FILE") bytes"
else
  echo "文件不存在: $SKILLS_FILE"
  echo "FAIL"
fi
```

#### 步骤 3: 重启 sidecar

```bash
# 获取并终止 sidecar
SIDECAR_PID=$(lsof -i :3210 -t -sTCP:LISTEN 2>/dev/null | head -1)
if [ -n "$SIDECAR_PID" ]; then
  kill "$SIDECAR_PID"
  echo "已终止 sidecar (PID: $SIDECAR_PID)"
fi
sleep 2

# 重新启动 sidecar
npx tsx src-electron/sidecar/src/index.ts --port 3210 --project-root "$(pwd)" &
sleep 3

# 验证重启成功
curl -sf http://localhost:3210/health > /dev/null && echo "sidecar 已就绪" || { echo "sidecar 启动失败"; exit 1; }
```

#### 步骤 4: 检查 WS config.skills 初始广播

```bash
node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://localhost:3210');
const messages = [];
ws.on('message', (raw) => {
  try { messages.push(JSON.parse(raw.toString())); } catch {}
});
ws.on('open', () => {
  setTimeout(() => {
    ws.close();
    const msg = messages.find(m => m.type === 'config.skills');
    if (!msg) { console.log('FAIL: 重启后未收到 config.skills'); process.exit(1); }
    require('fs').writeFileSync('/tmp/tc-5.2-skills-after.json',
      JSON.stringify(msg.payload.skills, null, 2));
    console.log('重启后 skills:');
    console.log(JSON.stringify(msg.payload.skills, null, 2));
    console.log('数量:', msg.payload.skills.length);
    process.exit(0);
  }, 3000);
});
setTimeout(() => { console.log('FAIL: 超时'); process.exit(1); }, 10000);
"
```

#### 步骤 5: 三方比对（磁盘 / 重启前 WS / 重启后 WS）

```bash
echo "=== 磁盘 vs 重启前 WS ==="
diff /tmp/tc-5.2-skills-from-disk.json /tmp/tc-5.2-skills-before.json && echo "一致" || echo "不一致"

echo "=== 重启前 WS vs 重启后 WS ==="
diff /tmp/tc-5.2-skills-before.json /tmp/tc-5.2-skills-after.json && echo "一致" || echo "不一致"
```

#### 步骤 6: 检查 DOM Skill section

```bash
WS_URL=$(curl -s http://localhost:9222/json | jq -r '.[0].webSocketDebuggerUrl')

node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('${WS_URL}');
let id = 1;
function send(expr) {
  return new Promise(resolve => {
    const msgId = id++;
    ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression: expr } }));
    const handler = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === msgId) { ws.removeListener('message', handler); resolve(msg.result?.result?.value); }
    };
    ws.on('message', handler);
  });
}
ws.on('open', async () => {
  const count = await send('document.querySelectorAll(\"[data-testid=\\\"skill-item\\\"]\").length');
  console.log('DOM 中 skill-item 数量:', count);
  ws.close();
});
"
```

### 期望结果

- 磁盘 `skills.json` 文件存在且格式正确
- 重启 sidecar 后 WS 广播的 skills 与重启前完全一致
- 磁盘文件内容与 WS 广播一致
- DOM 中 skill 元素数量与 skills 数组长度一致

### 衡量方法

| 检查项 | 期望值 |
|--------|--------|
| `.xyz-agent/skills.json` | 存在、JSON 合法 |
| 磁盘 vs 重启前 WS | 一致 |
| 重启前 WS vs 重启后 WS | 一致 |
| DOM skill 元素数量 | 与 skills 数组长度一致 |

### 结果记录

| 项目 | 值 |
|------|----|
| 执行时间 | |
| 重启前 skill 数量 | |
| 重启后 skill 数量 | |
| 磁盘文件大小 | |
| diff 结果 | |
| DOM 元素数量 | |
| 结果 | PASS / FAIL |
| 备注 | |

---

## TC-5.3: Agent 刷新保持

| 字段 | 内容 |
|------|------|
| **ID** | TC-5.3 |
| **目标** | 导入 Agent 后重启 sidecar + 刷新前端，agent 数据完整持久化 |
| **前置条件** | TC-3.3 通过（已导入至少一个 Agent） |

### 测试步骤

#### 步骤 1: 记录当前 Agent 列表

```bash
node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://localhost:3210');
const messages = [];
ws.on('message', (raw) => {
  try { messages.push(JSON.parse(raw.toString())); } catch {}
});
ws.on('open', () => {
  setTimeout(() => {
    ws.close();
    const msg = messages.find(m => m.type === 'config.agents');
    if (!msg) { console.log('FAIL: 未收到 config.agents'); process.exit(1); }
    require('fs').writeFileSync('/tmp/tc-5.3-agents-before.json',
      JSON.stringify(msg.payload.agents, null, 2));
    console.log('重启前 agents:');
    console.log(JSON.stringify(msg.payload.agents, null, 2));
    console.log('数量:', msg.payload.agents.length);
    process.exit(0);
  }, 3000);
});
setTimeout(() => { console.log('FAIL: 超时'); process.exit(1); }, 10000);
"
```

#### 步骤 2: 读取磁盘 agents.json 文件

```bash
AGENTS_FILE="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/agents.json"

echo "--- agents.json 内容 ---"
if [ -f "$AGENTS_FILE" ]; then
  cat "$AGENTS_FILE" | jq '.' | tee /tmp/tc-5.3-agents-from-disk.json
  echo "文件大小: $(wc -c < "$AGENTS_FILE") bytes"
else
  echo "文件不存在: $AGENTS_FILE"
  echo "FAIL"
fi
```

#### 步骤 3: 重启 sidecar

```bash
SIDECAR_PID=$(lsof -i :3210 -t -sTCP:LISTEN 2>/dev/null | head -1)
if [ -n "$SIDECAR_PID" ]; then
  kill "$SIDECAR_PID"
  echo "已终止 sidecar (PID: $SIDECAR_PID)"
fi
sleep 2

npx tsx src-electron/sidecar/src/index.ts --port 3210 --project-root "$(pwd)" &
sleep 3

curl -sf http://localhost:3210/health > /dev/null && echo "sidecar 已就绪" || { echo "sidecar 启动失败"; exit 1; }
```

#### 步骤 4: 检查 WS config.agents 初始广播

```bash
node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://localhost:3210');
const messages = [];
ws.on('message', (raw) => {
  try { messages.push(JSON.parse(raw.toString())); } catch {}
});
ws.on('open', () => {
  setTimeout(() => {
    ws.close();
    const msg = messages.find(m => m.type === 'config.agents');
    if (!msg) { console.log('FAIL: 重启后未收到 config.agents'); process.exit(1); }
    require('fs').writeFileSync('/tmp/tc-5.3-agents-after.json',
      JSON.stringify(msg.payload.agents, null, 2));
    console.log('重启后 agents:');
    console.log(JSON.stringify(msg.payload.agents, null, 2));
    console.log('数量:', msg.payload.agents.length);
    process.exit(0);
  }, 3000);
});
setTimeout(() => { console.log('FAIL: 超时'); process.exit(1); }, 10000);
"
```

#### 步骤 5: 三方比对

```bash
echo "=== 磁盘 vs 重启前 WS ==="
diff /tmp/tc-5.3-agents-from-disk.json /tmp/tc-5.3-agents-before.json && echo "一致" || echo "不一致"

echo "=== 重启前 WS vs 重启后 WS ==="
diff /tmp/tc-5.3-agents-before.json /tmp/tc-5.3-agents-after.json && echo "一致" || echo "不一致"
```

#### 步骤 6: 检查 DOM Agent section

```bash
WS_URL=$(curl -s http://localhost:9222/json | jq -r '.[0].webSocketDebuggerUrl')

node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('${WS_URL}');
let id = 1;
function send(expr) {
  return new Promise(resolve => {
    const msgId = id++;
    ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression: expr } }));
    const handler = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === msgId) { ws.removeListener('message', handler); resolve(msg.result?.result?.value); }
    };
    ws.on('message', handler);
  });
}
ws.on('open', async () => {
  const count = await send('document.querySelectorAll(\"[data-testid=\\\"agent-item\\\"]\").length');
  console.log('DOM 中 agent-item 数量:', count);
  ws.close();
});
"
```

### 期望结果

- 磁盘 `agents.json` 文件存在且格式正确
- 重启 sidecar 后 WS 广播的 agents 与重启前完全一致
- 磁盘文件内容与 WS 广播一致
- DOM 中 agent 元素数量与 agents 数组长度一致

### 衡量方法

| 检查项 | 期望值 |
|--------|--------|
| `.xyz-agent/agents.json` | 存在、JSON 合法 |
| 磁盘 vs 重启前 WS | 一致 |
| 重启前 WS vs 重启后 WS | 一致 |
| DOM agent 元素数量 | 与 agents 数组长度一致 |

### 结果记录

| 项目 | 值 |
|------|----|
| 执行时间 | |
| 重启前 agent 数量 | |
| 重启后 agent 数量 | |
| 磁盘文件大小 | |
| diff 结果 | |
| DOM 元素数量 | |
| 结果 | PASS / FAIL |
| 备注 | |

---

## TC-5.4: 多客户端广播一致性

| 字段 | 内容 |
|------|------|
| **ID** | TC-5.4 |
| **目标** | 一个客户端的变更操作（如删除 Provider）通过 sidecar 广播到另一个客户端 |
| **前置条件** | TC-0.1 ~ TC-0.3 通过；至少有一个可删除的 Provider（TC-1.3 通过） |

### 测试步骤

#### 步骤 1: 建立两个 WS 连接

```bash
# 先通过连接 A 获取当前 providers 快照，确定要删除的目标
node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://localhost:3210');
const messages = [];
ws.on('message', (raw) => {
  try { messages.push(JSON.parse(raw.toString())); } catch {}
});
ws.on('open', () => {
  setTimeout(() => {
    ws.close();
    const msg = messages.find(m => m.type === 'config.providers');
    if (!msg || !msg.payload.providers.length) {
      console.log('FAIL: 没有 provider 可用于删除测试');
      process.exit(1);
    }
    // 记录第一个 provider 的 id 用于后续删除
    const target = msg.payload.providers[0];
    console.log('当前 providers:', JSON.stringify(msg.payload.providers.map(p => p.name || p.id)));
    console.log('将删除:', target.name || target.id);
    require('fs').writeFileSync('/tmp/tc-5.4-target.json', JSON.stringify(target));
    process.exit(0);
  }, 3000);
});
setTimeout(() => { process.exit(1); }, 10000);
"
```

#### 步骤 2: 连接 A 监听 + 连接 B 执行删除

```javascript
// /tmp/tc-5.4-broadcast.mjs
import { WebSocket } from 'ws'

// 读取要删除的 target
const target = JSON.parse(
  require('fs').readFileSync('/tmp/tc-5.4-target.json', 'utf8')
)
const targetId = target.id || target.name
console.log('目标 provider:', targetId)

// 连接 A: 被动监听广播
const wsA = new WebSocket('ws://localhost:3210')
const messagesA = []

wsA.on('message', (raw) => {
  try { messagesA.push(JSON.parse(raw.toString())) } catch {}
})

// 连接 B: 主动操作
const wsB = new WebSocket('ws://localhost:3210')
const messagesB = []

wsB.on('message', (raw) => {
  try { messagesB.push(JSON.parse(raw.toString())) } catch {}
})

await new Promise(resolve => {
  let connected = 0
  const checkBoth = () => { if (connected === 2) resolve() }
  wsA.on('open', () => { connected++; checkBoth() })
  wsB.on('open', () => { connected++; checkBoth() })
})

// 等待初始广播完成
await new Promise(r => setTimeout(r, 2000))
messagesA.length = 0  // 清空初始消息
messagesB.length = 0

console.log('两个连接已建立，开始删除操作...')

// 通过连接 B 发送删除命令
wsB.send(JSON.stringify({
  type: 'config.deleteProvider',
  payload: { id: targetId }
}))

// 等待广播
await new Promise(r => setTimeout(r, 3000))

// 检查连接 A 是否收到广播
const broadcastMsg = messagesA.find(m => m.type === 'config.providers')

if (!broadcastMsg) {
  console.log('FAIL: 连接 A 未收到 config.providers 广播')
  console.log('连接 A 收到的消息:', messagesA.map(m => m.type))
  wsA.close()
  wsB.close()
  process.exit(1)
}

// 验证被删除的 provider 不在列表中
const providers = broadcastMsg.payload.providers
const deleted = providers.find(p => (p.id || p.name) === targetId)

if (deleted) {
  console.log('FAIL: provider 仍然存在于广播列表中')
  wsA.close()
  wsB.close()
  process.exit(1)
}

console.log('连接 A 收到广播，providers 数量:', providers.length)
console.log('目标 provider 已不在列表中')
console.log('PASS')

wsA.close()
wsB.close()
process.exit(0)
```

```bash
node /tmp/tc-5.4-broadcast.mjs
```

#### 步骤 3: 恢复被删除的 Provider（可选）

如果需要保持测试幂等性，重新添加被删除的 provider：

```bash
node -e "
const { WebSocket } = require('ws');
const target = JSON.parse(require('fs').readFileSync('/tmp/tc-5.4-target.json', 'utf8'));
const ws = new WebSocket('ws://localhost:3210');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'config.addProvider', payload: target }));
  setTimeout(() => { ws.close(); console.log('Provider 已恢复'); process.exit(0); }, 2000);
});
"
```

### 期望结果

- 连接 A 被动收到 `config.providers` 广播消息
- 广播的 providers 列表中不包含被删除的 provider
- 连接 A 和连接 B 收到相同的广播内容

### 衡量方法

| 检查项 | 期望值 |
|--------|--------|
| 连接 A 收到广播 | `config.providers` 消息存在 |
| 被删除 provider 不在列表 | `providers.find(p => p.id === targetId)` 为 `undefined` |
| 脚本退出码 | `0` |

### 结果记录

| 项目 | 值 |
|------|----|
| 执行时间 | |
| 被删除的 provider | |
| 连接 A 收到广播消息 | 是 / 否 |
| 广播后 provider 数量 | |
| 结果 | PASS / FAIL |
| 备注 | |

---

## TC-5.5: Skill 文件格式验证

| 字段 | 内容 |
|------|------|
| **ID** | TC-5.5 |
| **目标** | 确认 `.xyz-agent/skills.json` 文件格式正确，字段完整 |
| **前置条件** | TC-2.3 通过（至少导入了一个 Skill） |

### 测试步骤

#### 步骤 1: 检查文件是否存在

```bash
SKILLS_FILE="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/skills.json"

if [ -f "$SKILLS_FILE" ]; then
  echo "文件存在: $SKILLS_FILE"
  echo "文件大小: $(wc -c < "$SKILLS_FILE") bytes"
  echo "最后修改: $(stat -f '%Sm' "$SKILLS_FILE")"
else
  echo "FAIL: 文件不存在: $SKILLS_FILE"
  exit 1
fi
```

#### 步骤 2: 检查 JSON 格式合法性

```bash
jq '.' "$SKILLS_FILE" > /dev/null 2>&1 && \
  echo "JSON 格式合法" || \
  echo "FAIL: JSON 格式不合法"
```

#### 步骤 3: 检查顶层结构为数组

```bash
jq 'if type == "array" then "顶层为数组，元素数量: \(length)" else "FAIL: 顶层不是数组，类型: \(type)" end' "$SKILLS_FILE"
```

#### 步骤 4: 检查每个元素的必需字段

```bash
echo "--- 字段完整性检查 ---"
jq '
  . as $skills |
  if ($skills | length) == 0 then
    "WARN: 数组为空，无 skill 数据可检查"
  else
    [
      $skills[] | {
        index: ([$skills[] | .] | index(.)),
        id: (if .id then "OK" else "MISSING" end),
        name: (if .name then "OK" else "MISSING" end),
        description: (if .description then "OK" else "MISSING" end),
        enabled: (if (.enabled | type) == "boolean" then "OK(\(.enabled))" else "MISSING" end),
        source: (if .source then "OK(\(.source))" else "MISSING" end),
        triggers: (if (.triggers | type) == "array" then "OK(\(.triggers | length))" else "MISSING" end)
      }
    ]
  end
' "$SKILLS_FILE"
```

#### 步骤 5: 自动化综合验证

```bash
# 一键验证脚本
SKILLS_FILE="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/skills.json"

result="PASS"
issues=""

# 检查 1: 文件存在
[ -f "$SKILLS_FILE" ] || { result="FAIL"; issues="$issues\n- 文件不存在"; }

# 检查 2: JSON 合法
jq '.' "$SKILLS_FILE" > /dev/null 2>&1 || { result="FAIL"; issues="$issues\n- JSON 格式不合法"; }

# 检查 3: 顶层为数组
[ "$(jq -r 'type' "$SKILLS_FILE")" = "array" ] || { result="FAIL"; issues="$issues\n- 顶层不是数组"; }

# 检查 4: 每个元素有必需字段
if [ "$(jq 'type' "$SKILLS_FILE")" = '"array"' ]; then
  count=$(jq 'length' "$SKILLS_FILE")
  for i in $(seq 0 $((count - 1))); do
    jq --argjson i "$i" '.[$i] | has("id") and has("name")' "$SKILLS_FILE" | grep -q true || \
      issues="$issues\n- skills[$i] 缺少 id 或 name"
    jq --argjson i "$i" '.[$i] | has("description")' "$SKILLS_FILE" | grep -q true || \
      issues="$issues\n- skills[$i] 缺少 description"
    jq --argjson i "$i" '.[$i] | (.enabled | type) == "boolean"' "$SKILLS_FILE" | grep -q true || \
      issues="$issues\n- skills[$i] enabled 不是 boolean"
    jq --argjson i "$i" '.[$i] | has("source")' "$SKILLS_FILE" | grep -q true || \
      issues="$issues\n- skills[$i] 缺少 source"
    jq --argjson i "$i" '.[$i] | (.triggers | type) == "array"' "$SKILLS_FILE" | grep -q true || \
      issues="$issues\n- skills[$i] triggers 不是数组"
  done
fi

echo "结果: $result"
[ -n "$issues" ] && echo -e "问题:$issues"
```

### 期望结果

- `.xyz-agent/skills.json` 文件存在
- JSON 格式合法
- 顶层为数组结构
- 每个元素包含以下字段：
  - `id`: 字符串，唯一标识
  - `name`: 字符串，技能名称
  - `description`: 字符串，技能描述
  - `enabled`: 布尔值，是否启用
  - `source`: 字符串，来源标识
  - `triggers`: 数组，触发词列表

### 衡量方法

| 检查项 | 期望值 |
|--------|--------|
| 文件存在 | 是 |
| JSON 合法 | `jq '.'` 无报错 |
| 顶层类型 | `array` |
| 必需字段 | id/name/description/enabled/source/triggers 均存在且类型正确 |

### 结果记录

| 项目 | 值 |
|------|----|
| 执行时间 | |
| 文件大小 | |
| skill 数量 | |
| 字段完整性检查结果 | |
| 缺失字段（如有） | |
| 结果 | PASS / FAIL |
| 备注 | |

---

## TC-5.6: Agent 文件格式验证

| 字段 | 内容 |
|------|------|
| **ID** | TC-5.6 |
| **目标** | 确认 `.xyz-agent/agents.json` 文件格式正确，字段完整 |
| **前置条件** | TC-3.3 通过（至少导入了一个 Agent） |

### 测试步骤

#### 步骤 1: 检查文件是否存在

```bash
AGENTS_FILE="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/agents.json"

if [ -f "$AGENTS_FILE" ]; then
  echo "文件存在: $AGENTS_FILE"
  echo "文件大小: $(wc -c < "$AGENTS_FILE") bytes"
  echo "最后修改: $(stat -f '%Sm' "$AGENTS_FILE")"
else
  echo "FAIL: 文件不存在: $AGENTS_FILE"
  exit 1
fi
```

#### 步骤 2: 检查 JSON 格式合法性

```bash
jq '.' "$AGENTS_FILE" > /dev/null 2>&1 && \
  echo "JSON 格式合法" || \
  echo "FAIL: JSON 格式不合法"
```

#### 步骤 3: 检查顶层结构为数组

```bash
jq 'if type == "array" then "顶层为数组，元素数量: \(length)" else "FAIL: 顶层不是数组，类型: \(type)" end' "$AGENTS_FILE"
```

#### 步骤 4: 检查每个元素的必需字段

```bash
echo "--- 字段完整性检查 ---"
jq '
  . as $agents |
  if ($agents | length) == 0 then
    "WARN: 数组为空，无 agent 数据可检查"
  else
    [
      $agents[] | {
        index: ([$agents[] | .] | index(.)),
        id: (if .id then "OK" else "MISSING" end),
        name: (if .name then "OK" else "MISSING" end),
        description: (if .description then "OK" else "MISSING" end),
        enabled: (if (.enabled | type) == "boolean" then "OK(\(.enabled))" else "MISSING" end),
        source: (if .source then "OK(\(.source))" else "MISSING" end),
        triggers: (if (.triggers | type) == "array" then "OK(\(.triggers | length))" else "MISSING" end)
      }
    ]
  end
' "$AGENTS_FILE"
```

#### 步骤 5: 自动化综合验证

```bash
AGENTS_FILE="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/agents.json"

result="PASS"
issues=""

# 检查 1: 文件存在
[ -f "$AGENTS_FILE" ] || { result="FAIL"; issues="$issues\n- 文件不存在"; }

# 检查 2: JSON 合法
jq '.' "$AGENTS_FILE" > /dev/null 2>&1 || { result="FAIL"; issues="$issues\n- JSON 格式不合法"; }

# 检查 3: 顶层为数组
[ "$(jq -r 'type' "$AGENTS_FILE")" = "array" ] || { result="FAIL"; issues="$issues\n- 顶层不是数组"; }

# 检查 4: 每个元素有必需字段
if [ "$(jq 'type' "$AGENTS_FILE")" = '"array"' ]; then
  count=$(jq 'length' "$AGENTS_FILE")
  for i in $(seq 0 $((count - 1))); do
    jq --argjson i "$i" '.[$i] | has("id") and has("name")' "$AGENTS_FILE" | grep -q true || \
      issues="$issues\n- agents[$i] 缺少 id 或 name"
    jq --argjson i "$i" '.[$i] | has("description")' "$AGENTS_FILE" | grep -q true || \
      issues="$issues\n- agents[$i] 缺少 description"
    jq --argjson i "$i" '.[$i] | (.enabled | type) == "boolean"' "$AGENTS_FILE" | grep -q true || \
      issues="$issues\n- agents[$i] enabled 不是 boolean"
    jq --argjson i "$i" '.[$i] | has("source")' "$AGENTS_FILE" | grep -q true || \
      issues="$issues\n- agents[$i] 缺少 source"
    jq --argjson i "$i" '.[$i] | (.triggers | type) == "array"' "$AGENTS_FILE" | grep -q true || \
      issues="$issues\n- agents[$i] triggers 不是数组"
  done
fi

echo "结果: $result"
[ -n "$issues" ] && echo -e "问题:$issues"
```

#### 步骤 6: 完整文件内容审查（人工复核）

```bash
echo "--- agents.json 完整内容 ---"
cat "$AGENTS_FILE" | jq '.'
```

### 期望结果

- `.xyz-agent/agents.json` 文件存在
- JSON 格式合法
- 顶层为数组结构
- 每个元素包含以下字段：
  - `id`: 字符串，唯一标识
  - `name`: 字符串，Agent 名称
  - `description`: 字符串，Agent 描述
  - `enabled`: 布尔值，是否启用
  - `source`: 字符串，来源标识
  - `triggers`: 数组，触发词列表

### 衡量方法

| 检查项 | 期望值 |
|--------|--------|
| 文件存在 | 是 |
| JSON 合法 | `jq '.'` 无报错 |
| 顶层类型 | `array` |
| 必需字段 | id/name/description/enabled/source/triggers 均存在且类型正确 |

### 结果记录

| 项目 | 值 |
|------|----|
| 执行时间 | |
| 文件大小 | |
| agent 数量 | |
| 字段完整性检查结果 | |
| 缺失字段（如有） | |
| 结果 | PASS / FAIL |
| 备注 | |

---

## 汇总

| TC | 名称 | 结果 | 耗时 | 备注 |
|----|------|------|------|------|
| TC-5.1 | Provider 刷新保持 | | | |
| TC-5.2 | Skill 刷新保持 | | | |
| TC-5.3 | Agent 刷新保持 | | | |
| TC-5.4 | 多客户端广播一致性 | | | |
| TC-5.5 | Skill 文件格式验证 | | | |
| TC-5.6 | Agent 文件格式验证 | | | |

**通过条件**: 6/6 PASS

**失败处理指引**:
- TC-5.1/5.2/5.3 失败 → 检查 sidecar 的文件读写逻辑，确认启动时正确加载持久化文件
- TC-5.4 失败 → 检查 sidecar 的 broadcast 机制，确认变更操作后向所有连接推送更新
- TC-5.5/5.6 失败 → 检查 sidecar 写入文件的序列化逻辑，确认字段映射完整
