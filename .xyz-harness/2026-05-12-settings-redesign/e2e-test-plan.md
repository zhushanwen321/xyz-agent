# E2E 测试计划：Settings 模块重设计

## 第一章：测试概览

### 测试目标
验证 Settings 模块重设计的前后端全链路功能：WS 协议正确性、Section Groups 风格 UI 渲染、Skill/Agent 扫描导入 CRUD、数据持久化。

### 测试范围
基于 spec.md 中的以下功能点：
- WS 协议扩展（§3）：6 个新 ClientMessage + 8 个新 ServerMessage
- 数据流（§4）：Skill/Agent 扫描 → 勾选 → 导入 → CRUD 完整流程
- 组件结构（§6）：4 个新组件 + 4 个重写组件 + 12 个删除组件
- 视觉规范（§8）：Section Groups 风格对齐设计稿

### 设计稿引用
| 设计稿 | 路径 | 对应测试组 |
|--------|------|-----------|
| Provider tab | `docs/designs/settings-final.html` Provider 区域 | G2 |
| Skill tab | `docs/designs/settings-final.html` Skill 区域 | G3 |
| Agent tab | `docs/designs/settings-final.html` Agent 区域 | G4 |
| System tab | `docs/designs/settings-final.html` System 区域 | G5 |

### 前置条件
- 项目代码已按 plan.md 完成（Phase 2 编码已完成）
- Chrome 浏览器可用（Layer 2/3 必需）
- Z_AI_API_KEY 环境变量已设置（Layer 3 必需）

### 排除范围
- ProviderModal 的连接测试功能（spec 明确标注 no-op）
- Mock 模式测试
- Electron 主进程相关（窗口管理、快捷键等）

---

## 第二章：测试环境配置

### 2.1 Chrome 浏览器（Layer 2/3 必需）

设计稿截图基准（首次执行时生成）：
```bash
# 打开设计稿 HTML
open -a "Google Chrome" /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/docs/designs/settings-final.html
sleep 2

# 获取 Chrome WS URL
CHROME_WS=$(curl -s http://localhost:9222/json/list | python3 -c "import sys,json; tabs=json.load(sys.stdin); m=[t for t in tabs if 'settings-final' in t.get('url','')]; print(m[0]['webSocketDebuggerUrl'] if m else '')")
echo "CHROME_WS=$CHROME_WS"
```

设计稿基准截图生成命令见各测试组 Layer 3 章节。

### 2.2 后端 Sidecar

```bash
# 终端 1：启动 sidecar
cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider
npx tsx src-electron/sidecar/src/index.ts --port 3210 --project-root "$(pwd)"

# 验证
curl -s http://localhost:3210/health
# 期望: {"status":"ok","uptime":...}
```

### 2.3 前端 Electron

```bash
# 终端 2：启动前端
cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider
npm run dev

# 等待 Electron 窗口弹出，获取 CDP 连接
ELECTRON_WS=$(curl -s http://localhost:9222/json/list | python3 -c "import sys,json; tabs=json.load(sys.stdin); m=[t for t in tabs if 'localhost:1420' in t.get('url','')]; print(m[0]['webSocketDebuggerUrl'] if m else '')")
echo "ELECTRON_WS=$ELECTRON_WS"
```

### 2.4 通用变量

```bash
# 所有测试脚本共用
CDP="/Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js"
ZAI="/Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py"
EVIDENCE="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/evidence"
PROJECT="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider"
SKILLS_JSON="$PROJECT/.xyz-agent/skills.json"
AGENTS_JSON="$PROJECT/.xyz-agent/agents.json"
SIDECAR_WS="ws://localhost:3210"
```

### 2.5 测试数据准备

```bash
# 清理旧测试数据
rm -f "$SKILLS_JSON" "$AGENTS_JSON"

# 确认扫描源目录存在
for d in ~/.pi/agent/skills ~/.claude/skills ~/.agents/skills ~/.pi/agent/agents ~/.claude/agents ~/.agents/agents; do
  [ -d "$d" ] && echo "EXISTS: $d" || echo "MISSING: $d"
done
```

| 数据 | 创建方式 | 清理方式 |
|------|----------|----------|
| Provider 配置 | Provider 编辑保存 | `rm ~/.xyz-agent/config.json` 中的 providers |
| Skill 记录 | 扫描导入流程 | `rm $SKILLS_JSON` |
| Agent 记录 | 扫描导入流程 | `rm $AGENTS_JSON` |

### 2.6 清理方式

```bash
rm -f "$SKILLS_JSON" "$AGENTS_JSON"
echo "Test data cleaned"
```

---

## 第三章：测试分组与依赖关系

### 分组列表

| 组号 | 组名 | 用例数 | 验证层级 | 说明 |
|------|------|--------|---------|------|
| G1 | 基础连通性 | 4 | L1+L2+L3 | Sidecar、WS、CDP、页面渲染 |
| G2 | Provider Tab | 5 | L1+L2+L3+L4 | Section 重设计 + CRUD |
| G3 | Skill Tab | 6 | L1+L2+L3+L4 | 扫描/导入/CRUD + 视觉 |
| G4 | Agent Tab | 6 | L1+L2+L3+L4 | 扫描/导入/CRUD/confirm-bar |
| G5 | System Tab | 4 | L2+L3+L4 | 语言/外观/主题 |
| G6 | 跨 Tab 持久化 | 4 | L1+L2+L3+L4 | 刷新保持 + 全局视觉 |

### 依赖矩阵

| 测试组 | 前置依赖 | 说明 |
|--------|---------|------|
| G1 | 无 | 基础连通性 |
| G2 | G1 | 需要 CDP 连通 |
| G3 | G1 | 需要 CDP 连通 + 扫描源目录 |
| G4 | G1 | 需要 CDP 连通 + 扫描源目录 |
| G5 | G1 | 需要 CDP 连通 |
| G6 | G2+G3+G4 | 需要已创建的 Provider/Skill/Agent 数据 |

### 执行顺序

```
G1（基础连通） → G2 / G3 / G4 / G5（可并行） → G6（持久化）
```

---

## 第四章：验证方式操作指南

### Layer 1: WS 协议验证

本项目不是 REST API，而是 WebSocket 协议。验证方式：

```bash
# 通用 WS 测试脚本
# 用法: ws_test "发送JSON" "期望响应type" 超时秒
ws_test() {
  node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$SIDECAR_WS');
const expectedType = '$2';
const timeout = ($3 || 10) * 1000;
ws.on('open', () => ws.send(JSON.stringify($1)));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === expectedType) {
    console.log(JSON.stringify(msg.payload, null, 2));
    ws.close();
  }
});
setTimeout(() => { console.error('TIMEOUT waiting for $2'); process.exit(1); }, timeout);
"
}
```

### Layer 2: DOM/A11y 验证

使用 CDP Accessibility Tree 获取语义化 UI 结构：

```bash
# 获取精简 A11y Tree（只保留可交互元素 + heading + 文本叶子）
a11y_tree() {
  node "$CDP" "$ELECTRON_WS" Accessibility.getFullAXTree '{}' | python3 -c "
import sys, json
raw = json.load(sys.stdin)
for n in raw.get('result',{}).get('nodes',[]):
    role = n.get('role',{}).get('value','')
    name = n.get('name',{}).get('value','')
    interesting = role in {'button','link','textbox','checkbox','combobox','heading','table','row','cell','alert','dialog','tabpanel','menuitem','switch','listbox','option'}
    if not interesting and name and not n.get('childIds') and role not in ('WebArea','generic','paragraph'):
        interesting = True
    if not interesting: continue
    props = {p['name']:p['value'] for p in n.get('properties',[]) if p['name'] in ('disabled','checked','expanded','level','url','required','invalid')}
    parts = [n['nodeId'], role]
    if name: parts.append(repr(name))
    if props: parts.append(str(props))
    print(' '.join(str(p) for p in parts))
"
}

# 检查特定元素是否存在
a11y_find() {
  local role="$1" text="$2"
  node "$CDP" "$ELECTRON_WS" Accessibility.getFullAXTree '{}' | python3 -c "
import sys, json
raw = json.load(sys.stdin)
found = False
for n in raw.get('result',{}).get('nodes',[]):
    r = n.get('role',{}).get('value','')
    name = n.get('name',{}).get('value','')
    if r == '$role' and '$text' in (name or ''):
        print(f'FOUND: {n[\"nodeId\"]} {r} {repr(name)}')
        found = True
if not found: print('NOT FOUND: $role with text containing \"$text\"')
"
}

# DOM evaluate 快捷方式
dom_eval() {
  node "$CDP" "$ELECTRON_WS" Runtime.evaluate "{\"returnByValue\":true,\"expression\":\"$1\"}"
}
```

### Layer 3: 视觉对比

```bash
# 截图并保存
screenshot() {
  local output="$1"
  node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | \
    python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$output','wb').write(base64.b64decode(data)) if data else print('screenshot failed')"
}

# 拼图对比：设计稿（左） + 实际截图（右）→ 合成图
# 需要安装 Pillow: pip3 install Pillow
combine_images() {
  local design="$1" actual="$2" output="$3"
  python3 -c "
from PIL import Image, ImageDraw, ImageFont
import sys
design = Image.open(sys.argv[1])
actual = Image.open(sys.argv[2])
h = max(design.height, actual.height)
design = design.resize((int(design.width * h / design.height), h))
actual = actual.resize((int(actual.width * h / actual.height), h))
combined = Image.new('RGB', (design.width + actual.width + 20, h + 60), 'white')
combined.paste(design, (0, 30))
combined.paste(actual, (design.width + 20, 30))
draw = ImageDraw.Draw(combined)
draw.text((10, 5), 'Design', fill='black')
draw.text((design.width + 30, 5), 'Actual', fill='black')
combined.save(sys.argv[3])
" "$design" "$actual" "$output"
}

# AI 视觉对比
uidiff() {
  python3 "$ZAI" ui-diff "$1" "$2" "$3"
}

# AI 分析单张图
analyze_img() {
  python3 "$ZAI" analyze-image "$1" "$2"
}
```

### Layer 4: 数据/文件验证

```bash
# 检查 JSON 文件存在且格式正确
check_json() {
  local path="$1" expected_count="$2"
  [ -f "$path" ] || { echo "FAIL: file not found: $path"; return 1; }
  local count=$(python3 -c "import json; print(len(json.load(open('$path'))))")
  [ "$count" = "$expected_count" ] || { echo "FAIL: expected $expected_count items, got $count"; return 1; }
  echo "OK: $path has $count items"
}
```

---

## 第五章：测试用例

### G1: 基础连通性（4 TC）

详见 [e2e-tests/g1-foundation.md](e2e-tests/g1-foundation.md)

| TC | 目标 | L1 | L2 | L3 | 依赖 | 严重度 |
|----|------|----|----|-----|------|--------|
| TC-1-01 | Sidecar 健康检查 | ✅ | - | - | 无 | 阻塞 |
| TC-1-02 | WS 连接 + 初始广播 | ✅ | - | - | TC-1-01 | 阻塞 |
| TC-1-03 | CDP + Settings 页面渲染 | - | ✅ | ✅ | TC-1-01 | 阻塞 |
| TC-1-04 | Sidebar 四 Tab 渲染 | - | ✅ | ✅ | TC-1-03 | 阻塞 |

---

### G2: Provider Tab（5 TC）

详见 [e2e-tests/g2-provider.md](e2e-tests/g2-provider.md)

| TC | 目标 | L1 | L2 | L3 | L4 | 依赖 | 严重度 |
|----|------|----|----|-----|-----|------|--------|
| TC-2-01 | Provider Section 渲染 | ✅ | ✅ | ✅ | - | G1 | 阻塞 |
| TC-2-02 | Provider Toggle | ✅ | ✅ | ✅ | - | TC-2-01 | 重要 |
| TC-2-03 | Provider 编辑 Modal | ✅ | ✅ | - | ✅ | TC-2-01 | 重要 |
| TC-2-04 | Provider 删除 | ✅ | ✅ | ✅ | ✅ | TC-2-01 | 重要 |
| TC-2-05 | Model Row Toggle | ✅ | ✅ | - | ✅ | TC-2-01 | 重要 |
| TC-2-06 | ProviderModal 保留 Enabled | ✅ | ✅ | - | ✅ | TC-2-05 | 重要 |

---

### G3: Skill Tab（6 TC）

详见 [e2e-tests/g3-skill.md](e2e-tests/g3-skill.md)

| TC | 目标 | L1 | L2 | L3 | L4 | 依赖 | 严重度 |
|----|------|----|----|-----|-----|------|--------|
| TC-3-01 | Skill 扫描源 Chips | - | ✅ | ✅ | - | G1 | P2 |
| TC-3-02 | Skill 扫描执行 | ✅ | ✅ | ✅ | - | TC-3-01 | P1 阻塞 |
| TC-3-03 | Skill 导入 | ✅ | ✅ | ✅ | ✅ | TC-3-02 | P1 阻塞 |
| TC-3-04 | Skill Toggle | ✅ | ✅ | - | - | TC-3-03 | P2 |
| TC-3-05 | Skill 删除 | ✅ | ✅ | - | ✅ | TC-3-03 | P1 |
| TC-3-06 | Skill 展开详情 | - | ✅ | ✅ | - | TC-3-03 | P2 |

---

### G4: Agent Tab（6 TC）

详见 [e2e-tests/g4-agent.md](e2e-tests/g4-agent.md)

| TC | 目标 | L1 | L2 | L3 | L4 | 依赖 | 严重度 |
|----|------|----|----|-----|-----|------|--------|
| TC-4-01 | Agent 扫描源 Chips | - | ✅ | ✅ | - | G1 | 阻塞 |
| TC-4-02 | Agent 扫描执行 | ✅ | ✅ | ✅ | - | TC-4-01 | 阻塞 |
| TC-4-03 | Agent 导入 | ✅ | ✅ | ✅ | ✅ | TC-4-02 | 阻塞 |
| TC-4-04 | Agent Toggle | ✅ | ✅ | - | - | TC-4-03 | 一般 |
| TC-4-05 | Agent 删除 confirm-bar | ✅ | ✅ | ✅ | ✅ | TC-4-03 | 重要 |
| TC-4-06 | Agent 策略切换 | ✅ | ✅ | - | ✅ | TC-4-03 | 重要 |

---

### G5: System Tab（4 TC）

详见 [e2e-tests/g5-system.md](e2e-tests/g5-system.md)

| TC | 目标 | L1 | L2 | L3 | L4 | 依赖 | 严重度 |
|----|------|----|----|-----|-----|------|--------|
| TC-5-01 | System Section 渲染 | - | ✅ | ✅ | - | G1 | Critical |
| TC-5-02 | 语言切换 | - | ✅ | - | ✅ | TC-5-01 | Major |
| TC-5-03 | 外观模式切换 | - | ✅ | ✅ | ✅ | TC-5-01 | Major |
| TC-5-04 | 配色主题切换 | - | ✅ | ✅ | ✅ | TC-5-01 | Major |

---

### G6: 跨 Tab 持久化 + 全局视觉（4 TC）

详见 [e2e-tests/g6-persistence.md](e2e-tests/g6-persistence.md)

| TC | 目标 | L1 | L2 | L3 | L4 | 依赖 | 严重度 |
|----|------|----|----|-----|-----|------|--------|
| TC-6-01 | Provider 刷新保持 | ✅ | ✅ | - | ✅ | G2 | 重要 |
| TC-6-02 | Skill 刷新保持 | ✅ | ✅ | - | ✅ | G3 | 重要 |
| TC-6-03 | Agent 刷新保持 | ✅ | ✅ | - | ✅ | G4 | 重要 |
| TC-6-04 | 全局视觉对比 | - | - | ✅ | - | G2+G3+G4+G5 | 重要 |

---

## 第六章：测试结果记录模板

测试执行后，结果写入 `evidence/e2e-test-report.md`：

```markdown
# E2E 测试执行报告

## 执行信息
- 执行时间: {ISO 时间}
- Chrome 版本: {版本}
- Sidecar: localhost:3210

## 摘要
| 指标 | 值 |
|------|---|
| 总用例数 | 29 |
| 通过 (PASS) | X |
| 失败 (FAIL) | X |
| 跳过 (SKIP) | X |
| 通过率 | X% |

## 结果明细

| TC 编号 | 用例名 | L1 WS | L2 A11y | L3 Visual | L4 File | 状态 | 备注 |
|---------|--------|--------|---------|-----------|---------|------|------|
| TC-1-01 | ... | ✅/❌ | ✅/❌/- | ✅/❌/- | ✅/❌/- | PASS/FAIL/SKIP | |

## 失败分析
{每个失败 TC 的根因分析}

## 视觉对比结果
{Layer 3 每对对比的结论和差异描述}

## 结论
- [ ] 全部通过 — 可进入下一阶段
- [ ] 存在失败 — 需要回退编码修复后重新执行
```
