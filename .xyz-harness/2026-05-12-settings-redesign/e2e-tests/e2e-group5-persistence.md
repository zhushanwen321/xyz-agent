# E2E Group 5: 跨 Tab 持久化 + 全局视觉测试

> 依赖: Group 1 (基础 Tab 切换), Group 2 (Provider CRUD), Group 3 (Skill CRUD)
> 每个 TC 包含: 协议验证 + DOM 验证 + 视觉验证 + 持久化验证

## 工具路径

| 工具 | 路径 |
|------|------|
| CDP 脚本 | `/Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js` |
| zai-vision | `/Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py` |
| 截图目录 | `/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots/` |

## 项目路径

```
项目: /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider
```

## 持久化路径

| 类型 | 文件路径 |
|------|----------|
| Provider | `~/.xyz-agent/config.json` |
| Skills | `<project>/.xyz-agent/skills.json` |
| Agents | `<project>/.xyz-agent/agents.json` |

## CDP 连接

```bash
# 同其他 group，连接已有 Electron renderer
WS_URL=$(node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js ws-url)
```

---

## TC-5.1: Provider 刷新保持

### 目标
验证 Provider 配置在 Electron 窗口刷新/重启后完整保留，包括 WS 广播内容和 DOM 渲染。

### 前置
- Group 1 通过（Tab 切换正常）
- Group 2 通过（Provider CRUD 正常）
- 至少存在 1 个已配置的 Provider
- Electron 应用正在运行且 CDP 可连接

### 协议验证

```bash
# 1. 记录刷新前的 Provider 列表（WS 初始广播）
BEFORE_PROVIDERS=$(node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'window.__wsMessages?.find(m => m.type === "providers") || "no-capture"')
echo "刷新前 Provider 数据: $BEFORE_PROVIDERS"

# 2. 记录刷新前 provider section 数量
BEFORE_COUNT=$(node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'document.querySelectorAll("[data-testid=settings-provider-section]").length')
echo "刷新前 Provider Section 数量: $BEFORE_COUNT"
```

```bash
# 3. 刷新页面（等同关闭重开）
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'location.reload()'

# 4. 等待 WS 重连和初始广播
sleep 3

# 5. 获取刷新后的 Provider 列表
AFTER_PROVIDERS=$(node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'window.__wsMessages?.find(m => m.type === "providers") || "no-capture"')
echo "刷新后 Provider 数据: $AFTER_PROVIDERS"
```

**断言**: `AFTER_PROVIDERS` 中的 provider 列表与 `BEFORE_PROVIDERS` 一致（相同数量、相同 id/name/model 字段）

### DOM 验证

```bash
# 检查刷新后 DOM 中 provider section 数量
AFTER_COUNT=$(node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'document.querySelectorAll("[data-testid=settings-provider-section]").length')
echo "刷新后 Provider Section 数量: $AFTER_COUNT"
```

**断言**: `AFTER_COUNT === BEFORE_COUNT`

```bash
# 检查每个 provider section 的文本内容是否保留
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'Array.from(document.querySelectorAll("[data-testid=settings-provider-section]")).map(el => el.textContent.substring(0, 100)).join("\\n")'
```

**断言**: 每个 section 显示的 provider 名称和模型信息与刷新前一致

### 视觉验证

```bash
# 刷新后截图
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  screenshot /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots/actual-after-refresh-provider.png
```

**断言**: 截图中 Provider Tab 页面布局完整，所有 provider card 正确渲染

### 持久化验证

```bash
# 检查 config.json 中 providers 数据完整性
cat ~/.xyz-agent/config.json | python3 -c "
import json, sys
config = json.load(sys.stdin)
providers = config.get('providers', [])
print(f'config.json 中 provider 数量: {len(providers)}')
for p in providers:
    print(f'  - {p.get(\"id\", \"?\")}: {p.get(\"name\", \"?\")} ({p.get(\"model\", \"?\")})')
"
```

**断言**: `config.json` 中 providers 数组非空，每个 provider 包含完整的 id/name/model 字段

### 期望结果
| 维度 | 期望 |
|------|------|
| 协议 | 刷新后 WS 初始广播 provider 列表与刷新前一致 |
| DOM | provider section 数量不变，文本内容不变 |
| 视觉 | 截图无空白/缺失区域 |
| 持久化 | config.json 数据完整 |

### 实际结果

> 执行后填写

---

## TC-5.2: Skill 刷新保持

### 目标
验证 Skill 配置在 Electron 窗口刷新后完整保留，包括文件持久化和 DOM 渲染。

### 前置
- Group 1 通过（Tab 切换正常）
- Group 3 通过（Skill CRUD 正常）
- 至少存在 1 个已配置的 Skill
- TC-5.1 已通过（验证刷新机制可用）

### 协议验证

```bash
# 1. 记录刷新前的 Skill 列表
BEFORE_SKILLS=$(node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'window.__wsMessages?.find(m => m.type === "skills") || "no-capture"')
echo "刷新前 Skill 数据: $BEFORE_SKILLS"

# 2. 记录刷新前 SkillSection 数量
BEFORE_SKILL_COUNT=$(node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'document.querySelectorAll("[data-testid=settings-skill-section]").length')
echo "刷新前 Skill Section 数量: $BEFORE_SKILL_COUNT"
```

```bash
# 3. 刷新页面
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'location.reload()'
sleep 3

# 4. 获取刷新后的 Skill 列表
AFTER_SKILLS=$(node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'window.__wsMessages?.find(m => m.type === "skills") || "no-capture"')
echo "刷新后 Skill 数据: $AFTER_SKILLS"
```

**断言**: `AFTER_SKILLS` 中的 skill 列表与 `BEFORE_SKILLS` 一致（相同数量、相同 name/path/enabled 字段）

### DOM 验证

```bash
# 检查刷新后 DOM 中 SkillSection 数量
AFTER_SKILL_COUNT=$(node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'document.querySelectorAll("[data-testid=settings-skill-section]").length')
echo "刷新后 Skill Section 数量: $AFTER_SKILL_COUNT"
```

**断言**: `AFTER_SKILL_COUNT === BEFORE_SKILL_COUNT`

```bash
# 检查每个 skill section 的启用状态
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'Array.from(document.querySelectorAll("[data-testid=settings-skill-section]")).map(el => { const name = el.querySelector("[data-testid=skill-name]")?.textContent || "?"; const toggle = el.querySelector("[data-testid=skill-toggle]"); return `${name}: ${toggle?.getAttribute("aria-checked") || toggle?.checked || "?"}`; }).join("\\n")'
```

**断言**: 每个 skill 的名称和启用状态与刷新前一致

### 视觉验证

```bash
# 刷新后截图（Skill Tab）
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  screenshot /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots/actual-after-refresh-skill.png
```

**断言**: 截图中 Skill Tab 页面布局完整，所有 skill item 正确渲染

### 持久化验证

```bash
# 检查 skills.json 文件数据完整性
SKILLS_FILE="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/skills.json"
cat "$SKILLS_FILE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
skills = data.get('skills', data) if isinstance(data, dict) else data
if isinstance(skills, list):
    print(f'skills.json 中 skill 数量: {len(skills)}')
    for s in skills:
        print(f'  - {s.get(\"name\", \"?\")}: enabled={s.get(\"enabled\", \"?\")}')
else:
    print(f'skills.json 结构: {list(data.keys()) if isinstance(data, dict) else type(data)}')
"
```

**断言**: `skills.json` 文件存在且内容与刷新前一致，每个 skill 包含 name/path/enabled 字段

### 期望结果
| 维度 | 期望 |
|------|------|
| 协议 | 刷新后 WS 初始广播 skill 列表与刷新前一致 |
| DOM | SkillSection 数量不变，启用状态不变 |
| 视觉 | 截图无空白/缺失区域 |
| 持久化 | skills.json 数据完整 |

### 实际结果

> 执行后填写

---

## TC-5.3: Agent 刷新保持

### 目标
验证 Agent 配置在 Electron 窗口刷新后完整保留，包括文件持久化和 DOM 渲染。

### 前置
- Group 1 通过（Tab 切换正常）
- 至少存在 1 个已配置的 Agent
- TC-5.1 已通过（验证刷新机制可用）

### 协议验证

```bash
# 1. 记录刷新前的 Agent 列表
BEFORE_AGENTS=$(node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'window.__wsMessages?.find(m => m.type === "agents") || "no-capture"')
echo "刷新前 Agent 数据: $BEFORE_AGENTS"

# 2. 记录刷新前 AgentSection 数量
BEFORE_AGENT_COUNT=$(node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'document.querySelectorAll("[data-testid=settings-agent-section]").length')
echo "刷新前 Agent Section 数量: $BEFORE_AGENT_COUNT"
```

```bash
# 3. 刷新页面
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'location.reload()'
sleep 3

# 4. 获取刷新后的 Agent 列表
AFTER_AGENTS=$(node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'window.__wsMessages?.find(m => m.type === "agents") || "no-capture"')
echo "刷新后 Agent 数据: $AFTER_AGENTS"
```

**断言**: `AFTER_AGENTS` 中的 agent 列表与 `BEFORE_AGENTS` 一致（相同数量、相同 name/provider/model 字段）

### DOM 验证

```bash
# 检查刷新后 DOM 中 AgentSection 数量
AFTER_AGENT_COUNT=$(node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'document.querySelectorAll("[data-testid=settings-agent-section]").length')
echo "刷新后 Agent Section 数量: $AFTER_AGENT_COUNT"
```

**断言**: `AFTER_AGENT_COUNT === BEFORE_AGENT_COUNT`

```bash
# 检查每个 agent section 的详细信息
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  evaluate 'Array.from(document.querySelectorAll("[data-testid=settings-agent-section]")).map(el => { const name = el.querySelector("[data-testid=agent-name]")?.textContent || "?"; const provider = el.querySelector("[data-testid=agent-provider]")?.textContent || "?"; return `${name} -> ${provider}`; }).join("\\n")'
```

**断言**: 每个 agent 的名称和关联 provider 与刷新前一致

### 视觉验证

```bash
# 刷新后截图（Agent Tab）
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  screenshot /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots/actual-after-refresh-agent.png
```

**断言**: 截图中 Agent Tab 页面布局完整，所有 agent card 正确渲染

### 持久化验证

```bash
# 检查 agents.json 文件数据完整性
AGENTS_FILE="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/agents.json"
cat "$AGENTS_FILE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
agents = data.get('agents', data) if isinstance(data, dict) else data
if isinstance(agents, list):
    print(f'agents.json 中 agent 数量: {len(agents)}')
    for a in agents:
        print(f'  - {a.get(\"name\", \"?\")}: provider={a.get(\"provider\", \"?\")} model={a.get(\"model\", \"?\")}')
else:
    print(f'agents.json 结构: {list(data.keys()) if isinstance(data, dict) else type(data)}')
"
```

**断言**: `agents.json` 文件存在且内容与刷新前一致，每个 agent 包含 name/provider/model 字段

### 期望结果
| 维度 | 期望 |
|------|------|
| 协议 | 刷新后 WS 初始广播 agent 列表与刷新前一致 |
| DOM | AgentSection 数量不变，关联信息不变 |
| 视觉 | 截图无空白/缺失区域 |
| 持久化 | agents.json 数据完整 |

### 实际结果

> 执行后填写

---

## TC-5.4: 全局视觉对比总结

### 目标
对全部 Tab 进行截图和视觉对比，输出整体"设计还原度"评估。这是 Group 5 的汇总测试，也是所有 Group 的视觉回归验证。

### 前置
- Group 1/2/3/4 全部通过
- TC-5.1/5.2/5.3 通过（持久化确认正常）
- 设计稿文件存在于截图目录

### 协议验证

本 TC 以视觉为主，不涉及协议变更验证。确保应用处于正常运行状态即可。

### DOM 验证

```bash
# 遍历所有 Tab 并截图
# Tab 1: Provider
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  click "[data-testid=tab-provider]"
sleep 1
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  screenshot /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots/actual-tab-provider.png

# Tab 2: Skill
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  click "[data-testid=tab-skill]"
sleep 1
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  screenshot /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots/actual-tab-skill.png

# Tab 3: Agent
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  click "[data-testid=tab-agent]"
sleep 1
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  screenshot /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots/actual-tab-agent.png

# Tab 4: General（如存在）
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  click "[data-testid=tab-general]" 2>/dev/null
sleep 1
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  screenshot /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots/actual-tab-general.png
```

```bash
# 合成全 Tab 切换截图
node /Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js \
  screenshot /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots/actual-all-tabs.png
```

**断言**: 所有 Tab 截图无报错、无空白区域

### 视觉验证

```bash
# Step 1: 对每个 Tab 截图做 zai-vision 分析
SCREENSHOT_DIR="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots"

# Provider Tab 对比
python3 /Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py analyze-image \
  --image "$SCREENSHOT_DIR/actual-tab-provider.png" \
  --prompt "分析这个 Settings Provider Tab 的 UI 设计质量。评估: 1)布局是否整齐 2)间距是否均匀 3)颜色是否协调 4)文字是否清晰 5)交互元素是否可辨识。输出 JSON: {\"layout\": score, \"spacing\": score, \"color\": score, \"typography\": score, \"interactives\": score, \"overall\": score, \"issues\": [\"...\"]}"

# Skill Tab 对比
python3 /Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py analyze-image \
  --image "$SCREENSHOT_DIR/actual-tab-skill.png" \
  --prompt "分析这个 Settings Skill Tab 的 UI 设计质量。评估维度同上。输出 JSON 格式。"

# Agent Tab 对比
python3 /Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py analyze-image \
  --image "$SCREENSHOT_DIR/actual-tab-agent.png" \
  --prompt "分析这个 Settings Agent Tab 的 UI 设计质量。评估维度同上。输出 JSON 格式。"
```

```bash
# Step 2: 如果设计稿存在，做 ui-diff 对比
DESIGN_DIR="$SCREENSHOT_DIR/design"  # 设计稿目录

for TAB in provider skill agent general; do
  DESIGN_FILE="$DESIGN_DIR/design-${TAB}.png"
  ACTUAL_FILE="$SCREENSHOT_DIR/actual-tab-${TAB}.png"

  if [ -f "$DESIGN_FILE" ]; then
    echo "=== 对比 ${TAB} Tab ==="
    python3 /Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py ui-diff \
      --image1 "$DESIGN_FILE" \
      --image2 "$ACTUAL_FILE" \
      --prompt "对比设计稿(左)与实际实现(右)的差异。输出: 1)差异列表 2)每个差异的严重程度(critical/major/minor) 3)整体还原度百分比"
    echo ""
  else
    echo "跳过 ${TAB} Tab: 无设计稿 $DESIGN_FILE"
  fi
done
```

```bash
# Step 3: 全局汇总截图分析
python3 /Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py analyze-image \
  --image "$SCREENSHOT_DIR/actual-all-tabs.png" \
  --prompt "这是 Settings 页面最终状态的截图。给出整体设计还原度评估: 1)整体视觉一致性(1-10) 2)跨 Tab 风格统一性 3)关键问题列表 4)设计还原度百分比。输出 JSON: {\"visual_consistency\": N, \"cross_tab_uniformity\": N, \"issues\": [...], \"restoration_percentage\": N}"
```

### 持久化验证

```bash
# 汇总检查所有持久化文件
echo "=== 持久化文件汇总 ==="
echo "--- config.json (Provider) ---"
python3 -c "
import json
with open('$HOME/.xyz-agent/config.json') as f:
    data = json.load(f)
providers = data.get('providers', [])
print(f'  Provider 数量: {len(providers)}')
for p in providers:
    print(f'    - {p.get(\"id\", \"?\")}: {p.get(\"name\", \"?\")}')
"

echo "--- skills.json ---"
SKILLS_FILE="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/skills.json"
python3 -c "
import json
with open('$SKILLS_FILE') as f:
    data = json.load(f)
skills = data.get('skills', data) if isinstance(data, dict) else data
if isinstance(skills, list):
    print(f'  Skill 数量: {len(skills)}')
    for s in skills:
        print(f'    - {s.get(\"name\", \"?\")}: enabled={s.get(\"enabled\", \"?\")}')
"

echo "--- agents.json ---"
AGENTS_FILE="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-agent/agents.json"
python3 -c "
import json
with open('$AGENTS_FILE') as f:
    data = json.load(f)
agents = data.get('agents', data) if isinstance(data, dict) else data
if isinstance(agents, list):
    print(f'  Agent 数量: {len(agents)}')
    for a in agents:
        print(f'    - {a.get(\"name\", \"?\")}: provider={a.get(\"provider\", \"?\")}')
"
```

### 期望结果
| 维度 | 期望 |
|------|------|
| DOM | 所有 Tab 截图正常生成，无空白页面 |
| 视觉 | 每个Tab分析得分 >= 7/10 |
| 设计还原度 | 如有设计稿，还原度 >= 85% |
| 持久化 | 三个 JSON 文件数据完整 |

### 实际结果

> 执行后填写

---

## 执行总结模板

| TC | 协议 | DOM | 视觉 | 持久化 | 结果 |
|----|------|-----|------|--------|------|
| TC-5.1 Provider 刷新保持 | | | | | PASS/FAIL |
| TC-5.2 Skill 刷新保持 | | | | | PASS/FAIL |
| TC-5.3 Agent 刷新保持 | | | | | PASS/FAIL |
| TC-5.4 全局视觉对比 | - | | | | PASS/FAIL |

**Group 5 结论**: ______/4 通过
