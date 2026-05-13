# G5: System Tab（4 TC | L2+L3+L4 | 依赖 G1）

> 前置条件：G1 通过，Settings 页面已打开。

---

### TC-5-01: System Settings Section 渲染

**测试目标**: 2 个 section（语言与外观 + 配色主题），10 个 palette 圆点。

**验证**:

#### Layer 2: DOM/A11y 验证
```bash
# 切换到 System tab
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var items=document.querySelectorAll(\".sidebar-item\");var s=Array.from(items).find(function(e){return e.textContent.includes(\"系统\")||e.textContent.includes(\"System\")});if(s)s.click();return \"clicked\"})()"}'
sleep 0.5

# 检查 heading（语言与外观、配色主题）
node "$CDP" "$ELECTRON_WS" Accessibility.getFullAXTree '{}' | python3 -c "
import sys, json
raw = json.load(sys.stdin)
headings = []
for n in raw.get('result',{}).get('nodes',[]):
    if n.get('role',{}).get('value','') == 'heading':
        name = n.get('name',{}).get('value','')
        if name: headings.append(name)
print('headings:', headings[:10])
assert any('语言' in h or '外观' in h for h in headings), 'FAIL: missing language/appearance heading'
assert any('配色' in h or '主题' in h for h in headings), 'FAIL: missing palette heading'
print('PASS: both section headings found')
"

# 检查 palette 圆点数量
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"document.querySelectorAll(\".rounded-full.w-4.h-4\").length"}'
# 期望: 10
```

#### Layer 3: 视觉对比
```bash
mkdir -p "$EVIDENCE"
node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' | python3 -c "
import sys,json,base64
r = json.load(sys.stdin)
data = r.get('result',{}).get('value','')
if data: open('$EVIDENCE/tc-501_system.png','wb').write(base64.b64decode(data)); print('saved')
"

python3 "$ZAI" ui-diff "$EVIDENCE/baselines/design-system.png" "$EVIDENCE/tc-501_system.png" "对比 System Tab：检查 2 个 section 卡片、palette 圆点布局。列出差异。"
```

**回退影响**: 无。
**严重程度**: Critical

---

### TC-5-02: 语言切换

**测试目标**: 切换语言 select，页面文案更新。

**验证**:

#### Layer 2: DOM/A11y 验证
```bash
# 记录切换前某个标签文案
BEFORE=$(node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"document.querySelector(\".sidebar-item\")?.textContent || \"\""}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('value',''))")

# 切换语言为 English
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var selects=document.querySelectorAll(\"select\");if(!selects.length)return \"NO_SELECT\";selects[0].value=\"en\";selects[0].dispatchEvent(new Event(\"change\",{bubbles:true}));return \"changed\"})()"}'
sleep 1

# 检查文案变化
AFTER=$(node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"document.querySelector(\".sidebar-item\")?.textContent || \"\""}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('value',''))")

if [ "$BEFORE" != "$AFTER" ]; then
  echo "PASS: language changed ($BEFORE -> $AFTER)"
else
  echo "WARN: text unchanged ($BEFORE)"
fi

# 恢复中文
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var selects=document.querySelectorAll(\"select\");if(!selects.length)return \"NO_SELECT\";selects[0].value=\"zh\";selects[0].dispatchEvent(new Event(\"change\",{bubbles:true}));return \"restored\"})()"}'
sleep 1
```

#### Layer 4: 文件验证
```bash
CONFIG_FILE="$HOME/.xyz-agent/config.json"
if [ -f "$CONFIG_FILE" ]; then
  python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print('language:', c.get('language','?'))"
fi
```

**回退影响**: 恢复为中文。
**严重程度**: Major

---

### TC-5-03: 外观模式切换

**测试目标**: 切换 light/dark/system，页面主题立即变化。

**验证**:

#### Layer 2: DOM/A11y 验证
```bash
# 记录当前背景色
BG_BEFORE=$(node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"getComputedStyle(document.body).backgroundColor"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('value',''))")

# 切换到 dark
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var selects=document.querySelectorAll(\"select\");if(selects.length<2)return \"NO_SELECT\";selects[1].value=\"dark\";selects[1].dispatchEvent(new Event(\"change\",{bubbles:true}));return \"changed to dark\"})()"}'
sleep 1

# 检查背景色变化
BG_AFTER=$(node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"getComputedStyle(document.body).backgroundColor"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('value',''))")

if [ "$BG_BEFORE" != "$BG_AFTER" ]; then
  echo "PASS: theme changed ($BG_BEFORE -> $BG_AFTER)"
else
  echo "WARN: background unchanged ($BG_BEFORE)"
fi
```

#### Layer 3: 视觉对比
```bash
# 截图 dark 模式
node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png"}' | python3 -c "
import sys,json,base64
r = json.load(sys.stdin)
data = r.get('result',{}).get('value','')
if data: open('$EVIDENCE/tc-503_dark-mode.png','wb').write(base64.b64decode(data)); print('saved')
"
```

#### Layer 4: 文件验证
```bash
if [ -f "$CONFIG_FILE" ]; then
  python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print('appearance:', c.get('appearance','?'))"
fi

# 恢复
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var selects=document.querySelectorAll(\"select\");if(selects.length<2)return \"NO_SELECT\";selects[1].value=\"system\";selects[1].dispatchEvent(new Event(\"change\",{bubbles:true}));return \"restored\"})()"}'
sleep 1
```

**回退影响**: 恢复为 system。
**严重程度**: Major

---

### TC-5-04: 配色主题切换

**测试目标**: 点击 palette 圆点，CSS 变量 --accent 变化，config.json 更新。

**验证**:

#### Layer 2: DOM/A11y 验证
```bash
# 记录当前 accent
ACCENT_BEFORE=$(node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"getComputedStyle(document.documentElement).getPropertyValue(\"--accent\")"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('value','').strip())")

# 点击第 3 个 palette 圆点
node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var dots=document.querySelectorAll(\".rounded-full.w-4.h-4\");if(dots.length<3)return \"NO_DOTS\";dots[2].click();return \"clicked palette 3\"})()"}'
sleep 0.5

# 检查 accent 变化
ACCENT_AFTER=$(node "$CDP" "$ELECTRON_WS" Runtime.evaluate '{"returnByValue":true,"expression":"getComputedStyle(document.documentElement).getPropertyValue(\"--accent\")"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('value','').strip())")

if [ "$ACCENT_BEFORE" != "$ACCENT_AFTER" ]; then
  echo "PASS: accent changed ($ACCENT_BEFORE -> $ACCENT_AFTER)"
else
  echo "WARN: accent unchanged ($ACCENT_BEFORE)"
fi
```

#### Layer 3: 视觉对比
```bash
# 截图新配色
node "$CDP" "$ELECTRON_WS" Page.captureScreenshot '{"format":"png"}' | python3 -c "
import sys,json,base64
r = json.load(sys.stdin)
data = r.get('result',{}).get('value','')
if data: open('$EVIDENCE/tc-504_palette-changed.png','wb').write(base64.b64decode(data)); print('saved')
"
```

#### Layer 4: 文件验证
```bash
if [ -f "$CONFIG_FILE" ]; then
  python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print('paletteTheme:', c.get('paletteTheme','?'))"
fi
```

**回退影响**: 需手动恢复默认 palette。
**严重程度**: Major
