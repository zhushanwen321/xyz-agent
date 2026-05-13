# Settings 模块重设计 — E2E 测试方案

> 测试目标：验证 Settings 模块重设计的前后端全链路功能，包括 WS 协议、数据持久化、UI 交互。

---

## 1. 前置条件

### 1.1 环境准备

```bash
# 确认项目目录
cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider

# 确认 node 依赖已安装
npm install

# 确认 1420 (Vite) 和 3210 (Sidecar) 端口未被占用
lsof -i :1420 -P | grep LISTEN
lsof -i :3210 -P | grep LISTEN
# 如果有占用，kill 掉对应 PID
```

### 1.2 启动后端 Sidecar

```bash
# 终端 1：启动 sidecar，传入项目根目录作为 skills/agents 持久化路径
cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider
npx tsx src-electron/sidecar/src/index.ts --port 3210 --project-root "$(pwd)"
```

验证 sidecar 启动成功：
```bash
curl http://localhost:3210/health
# 期望: {"status":"ok","uptime":0.123}
```

### 1.3 启动前端 Dev Server

```bash
# 终端 2：启动 Vite dev server + Electron
cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider
npm run dev
```

等待 Vite 编译完成，Electron 窗口弹出。

### 1.4 连接 Chrome DevTools

```bash
# Electron 默认启用 remote debugging，端口 9222
# 打开 Chrome，访问 chrome://inspect 或直接:
open -a "Google Chrome" http://localhost:9222
# 或在终端用 CDP:
curl -s http://localhost:9222/json | python3 -m json.tool
```

测试过程中，前端 DOM 检查和截图通过 CDP (Chrome DevTools Protocol) 完成：
```bash
# 获取页面列表
curl -s http://localhost:9222/json

# 截图（需要具体的 webSocketDebuggerUrl）
# 方法：用 chrome-automation skill 或直接 CDP
```

### 1.5 测试数据准备

```bash
# 清理旧测试数据
rm -rf /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/skills.json
rm -rf /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/agents.json

# 确认扫描源目录存在（用于 Skill/Agent 扫描测试）
ls -d ~/.pi/agent/skills/ 2>/dev/null && echo "pi skills: EXISTS" || echo "pi skills: MISSING"
ls -d ~/.claude/skills/ 2>/dev/null && echo "claude skills: EXISTS" || echo "claude skills: MISSING"
ls -d ~/.agents/skills/ 2>/dev/null && echo "agents skills: EXISTS" || echo "agents skills: MISSING"
ls -d ~/.pi/agent/agents/ 2>/dev/null && echo "pi agents: EXISTS" || echo "pi agents: MISSING"
ls -d ~/.claude/agents/ 2>/dev/null && echo "claude agents: EXISTS" || echo "claude agents: MISSING"
ls -d ~/.agents/agents/ 2>/dev/null && echo "agents agents: EXISTS" || echo "agents agents: MISSING"
```

---

## 2. 测试组依赖关系

```
Group 0: 基础连通性 (Foundation)
  └── 所有后续 Group 依赖 Group 0 通过

Group 1: Provider CRUD (独立)
  ├── 依赖 Group 0

Group 2: Skill 扫描与 CRUD (独立)
  ├── 依赖 Group 0
  ├── TC-2.3 (导入) 依赖 TC-2.2 (扫描成功)
  └── TC-2.5 (删除) 依赖 TC-2.3 (导入成功)

Group 3: Agent 扫描与 CRUD (独立)
  ├── 依赖 Group 0
  ├── TC-3.3 (导入) 依赖 TC-3.2 (扫描成功)
  └── TC-3.5 (删除) 依赖 TC-3.3 (导入成功)

Group 4: System Settings (独立)
  ├── 依赖 Group 0

Group 5: 跨 Tab 持久化 (依赖 Group 1/2/3)
  ├── 依赖 Group 1、Group 2、Group 3 至少部分通过
```

**阻断规则**：如果 Group 0 不通过，停止所有测试。Group 内部按 TC 编号顺序执行，前置 TC 失败则跳过后续依赖的 TC。

---

## 3. 测试文件索引

| 文件 | 测试组 | 说明 |
|------|--------|------|
| `e2e-group0-foundation.md` | Group 0 | 基础连通性：WS 连接、初始广播、页面渲染 |
| `e2e-group1-provider.md` | Group 1 | Provider Section 重设计：CRUD、toggle、model rows |
| `e2e-group2-skill.md` | Group 2 | Skill 扫描/导入/CRUD/toggle/delete 全流程 |
| `e2e-group3-agent.md` | Group 3 | Agent 扫描/导入/CRUD/toggle/delete/confirm-bar |
| `e2e-group4-system.md` | Group 4 | System Settings：语言、外观模式、配色主题 |
| `e2e-group5-persistence.md` | Group 5 | 跨 Tab 持久化、刷新恢复 |

---

## 4. 测试结果记录

| TC ID | 测试目标 | 结果 | 备注 |
|-------|---------|------|------|
| TC-0.1 | Sidecar 健康检查 | ⬜ 待测 | |
| TC-0.2 | WS 连接建立 | ⬜ 待测 | |
| TC-0.3 | 初始广播 providers | ⬜ 待测 | |
| TC-0.4 | 初始广播 skills | ⬜ 待测 | |
| TC-0.5 | 初始广播 agents | ⬜ 待测 | |
| TC-0.6 | Settings 页面渲染 | ⬜ 待测 | |
| TC-1.1 | Provider Section 渲染 | ⬜ 待测 | |
| TC-1.2 | Provider Toggle | ⬜ 待测 | |
| TC-1.3 | Provider 编辑 Modal | ⬜ 待测 | |
| TC-1.4 | Provider 删除 | ⬜ 待测 | |
| TC-1.5 | Model Row Toggle | ⬜ 待测 | |
| TC-2.1 | Skill 扫描源 chips | ⬜ 待测 | |
| TC-2.2 | Skill 扫描执行 | ⬜ 待测 | |
| TC-2.3 | Skill 导入选中 | ⬜ 待测 | |
| TC-2.4 | Skill Toggle | ⬜ 待测 | |
| TC-2.5 | Skill 删除 | ⬜ 待测 | |
| TC-3.1 | Agent 扫描源 chips | ⬜ 待测 | |
| TC-3.2 | Agent 扫描执行 | ⬜ 待测 | |
| TC-3.3 | Agent 导入选中 | ⬜ 待测 | |
| TC-3.4 | Agent Toggle | ⬜ 待测 | |
| TC-3.5 | Agent 删除 confirm-bar | ⬜ 待测 | |
| TC-3.6 | Agent 策略切换 | ⬜ 待测 | |
| TC-4.1 | 语言切换 | ⬜ 待测 | |
| TC-4.2 | 外观模式切换 | ⬜ 待测 | |
| TC-4.3 | 配色主题切换 | ⬜ 待测 | |
| TC-5.1 | Provider 刷新保持 | ⬜ 待测 | |
| TC-5.2 | Skill 刷新保持 | ⬜ 待测 | |
| TC-5.3 | Agent 刷新保持 | ⬜ 待测 | |

---

## 5. 通用测试方法

### 5.1 WS 消息验证

使用 `websocat` 或 Node.js 脚本直接连接 sidecar WS，发送消息并观察响应：

```bash
# 安装 websocat（如果没有）
# brew install websocat
# 或用 cargo install websocat

# 连接到 sidecar
websocat ws://localhost:3210
# 然后手动发送 JSON 消息，如:
# {"type":"config.scanSkills","payload":{"sources":["~/.pi/agent/skills/"]}}
```

或者用 Node.js 脚本验证 WS 协议：

```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
ws.on('open', () => {
  ws.send(JSON.stringify({type:'config.getProviders',payload:{}}));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('收到:', msg.type, JSON.stringify(msg.payload).slice(0,200));
  if (msg.type === 'config.providers') ws.close();
});
ws.on('close', () => process.exit(0));
"
```

### 5.2 DOM 验证

通过 Electron 的 DevTools（端口 9222）执行 JS 检查 DOM：

```bash
# 获取 debugger URL
DEBUG_URL=$(curl -s http://localhost:9222/json | python3 -c "import json,sys; tabs=json.load(sys.stdin); print(tabs[0]['webSocketDebuggerUrl'])" 2>/dev/null)

# 用 CDP 执行 JS（示例：检查 settings sidebar 是否渲染）
# 实际操作中，AI 应使用 chrome-automation skill
```

### 5.3 数据文件验证

检查 sidecar 持久化的 JSON 文件：

```bash
# 检查 skills.json
cat /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/skills.json 2>/dev/null | python3 -m json.tool

# 检查 agents.json
cat /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/agents.json 2>/dev/null | python3 -m json.tool
```

### 5.4 截图验证

```bash
# 通过 CDP 截图（AI 使用 chrome-automation skill）
# 或者在 Electron 中按 Cmd+Shift+3 截屏
```
