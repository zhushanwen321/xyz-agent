# E2E Group 4: System Tab 测试

> 依赖：Group 0（应用启动 + Settings 页面打开）
> 设计稿截图：`expected-system-tab.png`

## 工具与常量

```bash
CDP="/Users/zhushanwen/.pi/agent/skills/chrome-automation/scripts/cdp.js"
VISION="/Users/zhushanwen/.pi/agent/skills/zai-vision/scripts/zai_vision.py"
SCREENSHOT_DIR="/Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots"
WS_URL=$(curl -s http://localhost:9222/json/list | python3 -c "import sys,json; tabs=json.load(sys.stdin); print([t for t in tabs if 'localhost:1420' in t.get('url','')][0]['webSocketDebuggerUrl'])")
```

## 截图函数

```bash
screenshot() {
  local name="$1"
  node "$CDP" "$WS_URL" Page.captureScreenshot '{"format":"png","captureBeyondViewport":true}' \
    | python3 -c "import sys,json,base64; r=json.load(sys.stdin); data=r.get('result',{}).get('value',''); open('$SCREENSHOT_DIR/$name','wb').write(base64.b64decode(data)) if data else print('fail')"
}
```

## 前置：切换到 System Tab

```bash
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var items=document.querySelectorAll(\".sidebar-item\");var s=Array.from(items).find(function(e){return e.textContent.includes(\"系统\")||e.textContent.includes(\"System\")});if(s)s.click();return \"clicked\"})()"}'
```

---

## TC-4.1: System Settings Section 渲染

### 目标
验证 System Tab 页面结构正确渲染：2 个 section + 10 个 palette 圆点。

### 前置
- Group 0 通过
- System tab 已点击激活

### DOM 验证

```bash
# 4.1.1 检查 section 数量和 header 文本
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sections=document.querySelectorAll(\"section.settings-section, [class*=section]\");var result=[];sections.forEach(function(s){var h=s.querySelector(\"h2,h3,[class*=header],[class*=title]\");result.push({index:result.length,text:h?h.textContent.trim():\"(no header)\"})});return JSON.stringify({count:sections.length,sections:result})})()"}'
# 期望：count=2, sections 包含"语言与外观"和"配色主题"

# 4.1.2 检查 palette 圆点数量（5 Muted + 5 Colorful = 10）
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var dots=document.querySelectorAll(\"[class*=palette] button, [class*=color-dot], [data-palette]\");return JSON.stringify({count:dots.length,palettes:Array.from(dots).map(function(d){return d.dataset.palette||d.getAttribute(\"aria-label\")||d.title||\"\"})})})()"}'
# 期望：count=10, palettes 包含 5 个 muted 前缀 + 5 个 colorful 前缀
```

### 视觉验证

```bash
# 4.1.3 截图对比
screenshot "actual-system-tab.png"

python3 "$VISION" compare \
  "$SCREENSHOT_DIR/expected-system-tab.png" \
  "$SCREENSHOT_DIR/actual-system-tab.png" \
  --prompt "对比两张截图：布局结构是否一致，section 标题位置、palette 圆点排列是否匹配。输出 PASS 或 FAIL 及差异描述。"
```

### 期望
| 检查项 | 期望值 |
|--------|--------|
| section 数量 | 2 |
| section headers | 包含"语言与外观"和"配色主题" |
| palette 圆点数 | 10（5 Muted + 5 Colorful） |
| 视觉对比 | 与设计稿一致 |

### 实际结果
- [ ] 4.1.1 section 数量：______
- [ ] 4.1.2 palette 圆点数：______
- [ ] 4.1.3 视觉对比：______

---

## TC-4.2: 语言切换

### 目标
验证语言切换功能：UI 语言变更 + localStorage 持久化。

### 前置
- TC-4.1 通过
- 当前语言为 zh-CN（默认）

### DOM 验证

```bash
# 4.2.1 查找语言 select 并获取当前值
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sel=document.querySelector(\"select[class*=locale], select[class*=lang], [class*=language] select\");if(!sel){var allSel=document.querySelectorAll(\"select\");return JSON.stringify({found:false,allSelects:allSel.length,hint:\"未找到语言 select，列出所有 select 的父级文本\",parents:Array.from(allSel).map(function(s){return s.parentElement.textContent.trim().substring(0,50)})})}return JSON.stringify({found:true,currentValue:sel.value,optionCount:sel.options.length,options:Array.from(sel.options).map(function(o){return {value:o.value,text:o.text}})})})()"}'
# 期望：found=true, currentValue="zh-CN"

# 4.2.2 切换到 en-US
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sel=document.querySelector(\"select[class*=locale], select[class*=lang], [class*=language] select\");if(!sel)return \"select not found\";var nativeSetter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,\"value\").set;nativeSetter.call(sel,\"en-US\");sel.dispatchEvent(new Event(\"change\",{bubbles:true}));return sel.value})()"}'
# 期望："en-US"

# 4.2.3 检查 localStorage 持久化
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var raw=localStorage.getItem(\"xyz-settings\");var settings=raw?JSON.parse(raw):null;return JSON.stringify({raw:raw?raw.substring(0,200):null,locale:settings?settings.locale:null})})()"}'
# 期望：locale="en-US"

# 4.2.4 检查 UI 文本是否切换为英文（sidebar 文案变化）
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var items=document.querySelectorAll(\".sidebar-item\");return JSON.stringify(Array.from(items).map(function(i){return i.textContent.trim()}).filter(function(t){return t.length>0}).slice(0,5))})()"}'
# 期望：包含英文文案如 "General"/"System"/"About"

# 4.2.5 切换回 zh-CN（还原）
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var sel=document.querySelector(\"select[class*=locale], select[class*=lang], [class*=language] select\");if(!sel)return \"select not found\";var nativeSetter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,\"value\").set;nativeSetter.call(sel,\"zh-CN\");sel.dispatchEvent(new Event(\"change\",{bubbles:true}));return sel.value})()"}'
# 期望："zh-CN"
```

### 视觉验证
无。

### 期望
| 检查项 | 期望值 |
|--------|--------|
| 初始 select 值 | zh-CN |
| 切换后 select 值 | en-US |
| localStorage locale | en-US |
| UI 文案 | 变为英文 |
| 还原后 select 值 | zh-CN |

### 实际结果
- [ ] 4.2.1 初始值：______
- [ ] 4.2.2 切换后值：______
- [ ] 4.2.3 localStorage：______
- [ ] 4.2.4 UI 文案：______
- [ ] 4.2.5 还原：______

---

## TC-4.3: 外观模式切换

### 目标
验证 light/dark 模式切换：data-theme 属性变化 + 背景色变化 + 视觉确认。

### 前置
- TC-4.2 通过（语言已还原为 zh-CN）
- 当前模式为 light

### DOM 验证

```bash
# 4.3.1 记录 light 模式状态
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var theme=document.documentElement.getAttribute(\"data-theme\")||\"light\";var bgColor=getComputedStyle(document.documentElement).backgroundColor;return JSON.stringify({theme:theme,bgColor:bgColor})})()"}'
# 期望：theme="light", bgColor 为浅色值（如 rgb(255,255,255) 或类似）

# 4.3.2 截图 light 模式作为基准
screenshot "actual-light-mode.png"

# 4.3.3 找到外观模式切换控件并切换到 dark
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var radios=document.querySelectorAll(\"input[type=radio][name*=theme], input[type=radio][name*=appearance], input[type=radio][name*=mode]\");if(radios.length===0){var btns=document.querySelectorAll(\"[class*=theme-toggle], [class*=mode-switch], button[class*=appearance]\");return JSON.stringify({found:false,radios:0,buttons:btns.length,hint:\"查找所有 radio 和 toggle 按钮\"})}var dark=Array.from(radios).find(function(r){return r.value===\"dark\"});if(dark){dark.click();return JSON.stringify({clicked:true,value:dark.value})}return JSON.stringify({clicked:false,values:Array.from(radios).map(function(r){return r.value})})})()"}'
# 备选：如果 radio 没找到，尝试其他选择器
# node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var toggles=document.querySelectorAll(\"[class*=toggle], [class*=switch], [role=switch]\");return JSON.stringify({count:toggles.length,texts:Array.from(toggles).map(function(t){return t.textContent.trim().substring(0,30)})})})()"}'

# 4.3.4 检查 dark 模式已激活
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var theme=document.documentElement.getAttribute(\"data-theme\")||\"light\";var bgColor=getComputedStyle(document.documentElement).backgroundColor;return JSON.stringify({theme:theme,bgColor:bgColor})})()"}'
# 期望：theme="dark", bgColor 为深色值（如 rgb(18,18,18) 或类似）

# 4.3.5 截图 dark 模式
screenshot "actual-dark-mode.png"
```

### 视觉验证

```bash
# 4.3.6 对比 light 和 dark 截图，确认视觉差异明显
python3 "$VISION" compare \
  "$SCREENSHOT_DIR/actual-light-mode.png" \
  "$SCREENSHOT_DIR/actual-dark-mode.png" \
  --prompt "对比两张截图：确认第二张（dark mode）的背景色明显变深，文字颜色变为浅色，整体配色方案从 light 切换为 dark。输出 PASS 或 FAIL。"
```

### 期望
| 检查项 | 期望值 |
|--------|--------|
| light data-theme | light |
| light 背景色 | 浅色（rgb 值明亮） |
| dark data-theme | dark |
| dark 背景色 | 深色（rgb 值暗） |
| 视觉对比 | dark 模式明显变暗 |

### 实际结果
- [ ] 4.3.1 light 状态：______
- [ ] 4.3.4 dark 状态：______
- [ ] 4.3.6 视觉对比：______

---

## TC-4.4: 配色主题切换

### 目标
验证配色主题（palette）切换：data-palette 属性变化 + active 按钮状态 + 视觉差异。

### 前置
- TC-4.3 通过
- 当前仍为 dark 模式（或先切回 light 以便对比更清晰）

### DOM 验证

```bash
# 4.4.1 查看当前 palette 状态
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var palette=document.documentElement.getAttribute(\"data-palette\")||\"default\";var dots=document.querySelectorAll(\"[data-palette]\");var activeDot=Array.from(dots).find(function(d){return d.classList.contains(\"active\")||d.getAttribute(\"aria-checked\")===\"true\"||d.classList.contains(\"ring\")});return JSON.stringify({currentPalette:palette,dotCount:dots.length,activePalette:activeDot?activeDot.dataset.palette:\"none\",allPalettes:Array.from(dots).map(function(d){return {palette:d.dataset.palette,classes:d.className,ariaChecked:d.getAttribute(\"aria-checked\")}})})})()"}'
# 期望：currentPalette 为默认值（如 warm-teal），1 个 dot 为 active 状态

# 4.4.2 截图当前 palette 作为基准
screenshot "actual-palette-default.png"

# 4.4.3 点击 terracotta palette 按钮
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var dots=document.querySelectorAll(\"[data-palette]\");var terracotta=Array.from(dots).find(function(d){return d.dataset.palette===\"terracotta\"||d.dataset.palette.includes(\"terracotta\")});if(!terracotta){return JSON.stringify({found:false,available:Array.from(dots).map(function(d){return d.dataset.palette})})}terracotta.click();return JSON.stringify({clicked:true,palette:terracotta.dataset.palette})})()"}'
# 期望：clicked=true

# 4.4.4 验证 data-palette 属性已变更
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var palette=document.documentElement.getAttribute(\"data-palette\");var dots=document.querySelectorAll(\"[data-palette]\");var activeDot=Array.from(dots).find(function(d){return d.classList.contains(\"active\")||d.getAttribute(\"aria-checked\")===\"true\"||d.classList.contains(\"ring\")});var terracottaDot=Array.from(dots).find(function(d){return d.dataset.palette.includes(\"terracotta\")});return JSON.stringify({htmlPalette:palette,activePalette:activeDot?activeDot.dataset.palette:\"none\",terracottaClasses:terracottaDot?terracottaDot.className:\"not found\"})})()"}'
# 期望：htmlPalette 包含 terracotta，terracotta 按钮有 active/ring 类名

# 4.4.5 检查 active 按钮的 border 和 ring 样式
node "$CDP" "$WS_URL" Runtime.evaluate '{"returnByValue":true,"expression":"(function(){var dots=document.querySelectorAll(\"[data-palette]\");var terracotta=Array.from(dots).find(function(d){return d.dataset.palette.includes(\"terracotta\")});if(!terracotta)return \"not found\";var cs=getComputedStyle(terracotta);return JSON.stringify({borderColor:cs.borderColor,borderWidth:cs.borderWidth,boxShadow:cs.boxShadow,outline:cs.outline})})()"}'
# 期望：borderColor 为 accent 色, boxShadow/outline 包含 ring 效果

# 4.4.6 截图 terracotta palette
screenshot "actual-terracotta.png"
```

### 视觉验证

```bash
# 4.4.7 对比 warm-teal 和 terracotta 截图
python3 "$VISION" compare \
  "$SCREENSHOT_DIR/actual-palette-default.png" \
  "$SCREENSHOT_DIR/actual-terracotta.png" \
  --prompt "对比两张截图：配色主题从 warm-teal 切换到 terracotta，检查 accent 色（按钮、选中态、标题等）是否从 teal/绿调 变为 terracotta/暖橙调。输出 PASS 或 FAIL。"
```

### 期望
| 检查项 | 期望值 |
|--------|--------|
| 初始 palette | warm-teal（或项目默认） |
| 点击 terracotta 后 data-palette | 包含 terracotta |
| terracotta 按钮 active 状态 | 有 border-accent + ring 样式 |
| 视觉对比 | accent 色调从 teal 变为暖橙 |

### 实际结果
- [ ] 4.4.1 初始 palette：______
- [ ] 4.4.3 点击 terracotta：______
- [ ] 4.4.4 data-palette 变更：______
- [ ] 4.4.5 active 样式：______
- [ ] 4.4.7 视觉对比：______

---

## 结果汇总

| TC | 描述 | 状态 |
|----|------|------|
| TC-4.1 | System Settings Section 渲染 | [ ] PASS / [ ] FAIL |
| TC-4.2 | 语言切换 | [ ] PASS / [ ] FAIL |
| TC-4.3 | 外观模式切换 | [ ] PASS / [ ] FAIL |
| TC-4.4 | 配色主题切换 | [ ] PASS / [ ] FAIL |
