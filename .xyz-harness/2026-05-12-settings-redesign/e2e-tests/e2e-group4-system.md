# Group 4: System Settings — E2E 测试

> **依赖**: Group 0 全部通过（sidecar 运行、WS 连接正常、前端渲染正常）

---

## TC-4.1: System Settings Section 渲染

### 目标
确认 System tab 渲染为两个 section：语言与外观 + 配色主题。

### 前置条件
- Group 0 通过

### 测试步骤

```javascript
// 切换到 System tab
const items = document.querySelectorAll('.sidebar-item');
const systemTab = Array.from(items).find(el => el.textContent?.includes('系统') || el.textContent?.includes('System'));
if (systemTab) { systemTab.click(); '已点击 System tab'; } else { '未找到 System tab'; }
```

```javascript
// 检查 section 结构
setTimeout(() => {
  const sections = document.querySelectorAll('[class*="rounded-lg"]');
  const headers = Array.from(sections).map(s => {
    const h = s.querySelector('[class*="section-bg"], [class*="bg-\\[var"]');
    return h?.textContent?.trim();
  });
  
  // 检查语言 select
  const selects = document.querySelectorAll('select, [role="combobox"], [class*="select"]');
  const langSelect = Array.from(selects).find(s => {
    const parent = s.closest('[class*="border"]');
    return parent?.textContent?.includes('语言');
  });
  
  // 检查配色主题按钮
  const paletteBtns = document.querySelectorAll('[class*="rounded-full"][class*="w-4"]');
  
  JSON.stringify({
    sectionCount: sections.length,
    sectionHeaders: headers,
    hasLangSelect: !!langSelect,
    paletteDotCount: paletteBtns.length,
  });
}, 500);
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| Section 数量 | 2 个 |
| 第一个 section header | 包含「语言与外观」 |
| 第二个 section header | 包含「配色主题」 |
| 语言 select | 存在 |
| 外观模式 select | 存在 |
| 配色圆点 | 10 个（5 Muted + 5 Colorful） |

### 衡量方法
- DOM 检查：section 容器数量和 header 文本
- Select 元素存在性
- Palette 按钮数量

### 结果

| 检查项 | 结果 | 备注 |
|--------|------|------|
| Section 数量 | ⬜ PASS / ❌ FAIL | |
| 语言与外观 section | ⬜ PASS / ❌ FAIL | |
| 配色主题 section | ⬜ PASS / ❌ FAIL | |
| Select 元素 | ⬜ PASS / ❌ FAIL | |
| 配色圆点数量 | ⬜ PASS / ❌ FAIL | |

---

## TC-4.2: 语言切换

### 目标
切换语言 select 后 locale 变更，localStorage 更新。

### 前置条件
- TC-4.1 通过

### 测试步骤

```javascript
// 找到语言 select 并修改值
const selects = document.querySelectorAll('select');
const langSelect = selects[0]; // 第一个 select 应该是语言
if (langSelect) {
  // 记录当前值
  const before = langSelect.value;
  // 切换到 English
  langSelect.value = 'en-US';
  langSelect.dispatchEvent(new Event('change', { bubbles: true }));
  langSelect.dispatchEvent(new Event('input', { bubbles: true }));
  
  // 检查 localStorage
  const settings = JSON.parse(localStorage.getItem('xyz-settings') || '{}');
  JSON.stringify({
    beforeLocale: before,
    afterLocale: langSelect.value,
    storedLocale: settings.locale,
  });
} else {
  'Language select not found';
}
```

如果前端使用 xyz-ui 的 Select 组件（非原生 select），需要通过点击方式操作：

```javascript
// xyz-ui Select 操作（通过点击打开下拉 → 选择选项）
const labels = document.querySelectorAll('.text-xs');
const langLabel = Array.from(labels).find(l => l.textContent?.includes('语言'));
if (langLabel) {
  // 找到同一行的 Select 触发器
  const row = langLabel.closest('[class*="flex"]');
  const trigger = row?.querySelector('[class*="select"], [role="combobox"]');
  if (trigger) { trigger.click(); '已点击语言 select'; }
}
// 然后点击下拉菜单中的 English 选项
setTimeout(() => {
  const options = document.querySelectorAll('[class*="option"], [role="option"]');
  const enOption = Array.from(options).find(o => o.textContent?.includes('English'));
  if (enOption) { enOption.click(); '已选择 English'; }
}, 200);
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| Select 值变更 | 值从 zh-CN 变为 en-US |
| localStorage | xyz-settings 中 locale 为 en-US |
| UI 文案 | 部分文案变为英文（如 sidebar 标签） |

### 衡量方法
- DOM: select 值
- localStorage: xyz-settings 中 locale 字段

### 结果

| 检查项 | 结果 | 备注 |
|--------|------|------|
| Select 值 | ⬜ PASS / ❌ FAIL | |
| localStorage | ⬜ PASS / ❌ FAIL | |
| UI 文案变化 | ⬜ PASS / ❌ FAIL | |

---

## TC-4.3: 外观模式切换

### 目标
切换外观模式后 `data-theme` 属性变化。

### 前置条件
- TC-4.1 通过

### 测试步骤

```javascript
// 记录当前 data-theme
const before = document.documentElement.getAttribute('data-theme');
JSON.stringify({ currentTheme: before });
```

```javascript
// 找到外观模式 select，切换到「深色」
const selects = document.querySelectorAll('select');
// 第二个 select 或含「外观」label 的行
const labels = document.querySelectorAll('.text-xs');
const themeLabel = Array.from(labels).find(l => l.textContent?.includes('外观'));
const row = themeLabel?.closest('[class*="flex"]');
const themeSelect = row?.querySelector('select') || selects[1];

if (themeSelect) {
  themeSelect.value = 'dark';
  themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  
  setTimeout(() => {
    const after = document.documentElement.getAttribute('data-theme');
    const bg = getComputedStyle(document.documentElement).backgroundColor;
    JSON.stringify({
      themeBefore: before,
      themeAfter: after,
      bodyBg: bg,
    });
  }, 300);
} else {
  'Theme select not found - trying xyz-ui component';
}
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| data-theme | 从 light 变为 dark |
| 视觉效果 | 背景色变深 |
| localStorage | xyz-settings 中 theme 为 dark |

### 结果

| 检查项 | 结果 | 备注 |
|--------|------|------|
| data-theme 变化 | ⬜ PASS / ❌ FAIL | |
| 背景色变深 | ⬜ PASS / ❌ FAIL | |
| localStorage | ⬜ PASS / ❌ FAIL | |

---

## TC-4.4: 配色主题切换

### 目标
点击 palette 按钮后 `data-palette` 属性变化，按钮 active 状态正确。

### 前置条件
- TC-4.1 通过

### 测试步骤

```javascript
// 记录当前 palette
const before = document.documentElement.getAttribute('data-palette');
JSON.stringify({ currentPalette: before });
```

```javascript
// 找到并点击 Terracotta palette 按钮
const buttons = document.querySelectorAll('button');
const terracottaBtn = Array.from(buttons).find(b => b.textContent?.includes('Terracotta'));
if (terracottaBtn) {
  terracottaBtn.click();
  
  setTimeout(() => {
    const after = document.documentElement.getAttribute('data-palette');
    const isActive = terracottaBtn.classList.contains('border-[var(--accent)]') ||
                     terracottaBtn.className.includes('ring');
    const settings = JSON.parse(localStorage.getItem('xyz-settings') || '{}');
    JSON.stringify({
      paletteBefore: before,
      paletteAfter: after,
      buttonActive: isActive,
      storedPalette: settings.themePreset,
    });
  }, 300);
} else {
  'Terracotta button not found';
}
```

```javascript
// 切换回默认 warm-teal
const warmBtn = Array.from(buttons).find(b => b.textContent?.includes('Warm Teal'));
if (warmBtn) {
  warmBtn.click();
  setTimeout(() => {
    const restored = document.documentElement.getAttribute('data-palette');
    JSON.stringify({ restoredPalette: restored });
  }, 300);
}
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| data-palette | 从 warm-teal 变为 terracotta |
| 按钮 active 状态 | Terracotta 按钮有 accent border + ring |
| localStorage | themePreset 为 terracotta |
| 恢复 | 切回 warm-teal 后 palette 恢复 |

### 结果

| 检查项 | 结果 | 备注 |
|--------|------|------|
| data-palette 变化 | ⬜ PASS / ❌ FAIL | |
| 按钮 active 状态 | ⬜ PASS / ❌ FAIL | |
| localStorage | ⬜ PASS / ❌ FAIL | |
| 恢复默认 | ⬜ PASS / ❌ FAIL | |
