# E2E 测试 — Group 1: Provider Section 重设计

> 依赖：Group 0 全部通过（WS 连通、初始广播、Settings 页面渲染正常）
> 覆盖组件：`ProviderSection.vue`、`ProviderPane.vue`、`ModelRow.vue`、`ProviderModal.vue`

---

## 前置条件

1. **Group 0 全部通过**（TC-0.1 ~ TC-0.6 均为 PASS）
2. Sidecar 运行在 `ws://localhost:3210`，健康检查通过
3. Electron 已启动，Vite dev server 在 `:1420`，remote debugging 端口 `9222`
4. Settings 页面已打开，Provider tab 可见
5. `~/.xyz-agent/config.json` 中至少存在 1 个 Provider（测试环境有 `router` Provider，含 6 个 model）

### 测试数据快照（执行前记录）

```bash
# 记录当前 Provider 数量和名称，用于测试后恢复对比
cat ~/.xyz-agent/config.json | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
providers = cfg.get('providers', {})
print(f'Provider 总数: {len(providers)}')
for pid, p in providers.items():
    enabled = p.get('enabled', True)
    models = p.get('models', [])
    print(f'  {pid} ({p.get(\"name\", \"?\")}): enabled={enabled}, models={len(models)}')
"
```

执行前预期输出：
```
Provider 总数: 1
  router (Router): enabled=True, models=6
```

---

## TC-1.1: Provider Section 渲染验证

### 目标

确认已有 Provider 以 Section Groups 风格渲染：圆角卡片、header 有底色、model rows 平铺在 body 中。

### 前置条件

- TC-0.3 通过（初始广播 `config.providers` 成功）
- TC-0.6 通过（Settings 页面渲染成功，Provider tab 可见）

### 测试步骤

#### 步骤 1：导航到 Provider tab

通过 CDP 确保 Settings 页面当前 tab 为 Provider：

```bash
# 获取 CDP WebSocket URL
DEBUG_URL=$(curl -s http://localhost:9222/json | python3 -c "import json,sys; tabs=json.load(sys.stdin); print(tabs[0]['webSocketDebuggerUrl'])" 2>/dev/null)
echo "DEBUG_URL=$DEBUG_URL"
```

通过 CDP 执行 JS，检查当前活跃 tab：

```javascript
// CDP Runtime.evaluate
// 检查 Settings 页面的 active tab
const activeTab = document.querySelector('[data-testid="settings-tab"].active, .sidebar-item.active, .tab-item.active');
activeTab ? activeTab.textContent : 'NO_ACTIVE_TAB_FOUND';
```

如果当前不在 Provider tab，点击 Provider sidebar item：

```javascript
// CDP Runtime.evaluate
const providerTab = document.querySelector('[data-settings-tab="provider"], .sidebar-item:nth-child(1)');
if (providerTab) { providerTab.click(); 'CLICKED_PROVIDER_TAB'; } else { 'PROVIDER_TAB_NOT_FOUND'; }
```

#### 步骤 2：检查 Provider section 容器结构

```javascript
// CDP Runtime.evaluate
// 验证：Provider section 容器存在，具备圆角和 border 样式
const sections = document.querySelectorAll('.max-w-\\[860px\\] > .border.rounded-lg');
({
  sectionCount: sections.length,
  sections: Array.from(sections).map((s, i) => ({
    index: i,
    classes: s.className,
    hasBorder: s.classList.contains('border-border') || s.className.includes('border'),
    hasRoundedLg: s.classList.contains('rounded-lg'),
    hasOverflowHidden: s.classList.contains('overflow-hidden'),
    hasMb3: s.classList.contains('mb-3'),
    opacityClass: s.classList.contains('opacity-50') ? 'opacity-50' : 'full-opacity',
  }))
});
```

#### 步骤 3：检查 section header 结构

```javascript
// CDP Runtime.evaluate
// 验证：header 有 bg-[var(--section-bg)] 底色，包含 toggle/avatar/name/url/badge/buttons
const header = document.querySelector('.border.rounded-lg .bg-\\[var\\(--section-bg\\)\\]');
if (!header) {
  'HEADER_NOT_FOUND - 检查 section-bg class';
} else {
  const toggle = header.querySelector('.toggle-switch, [role="switch"], button[class*="toggle"]');
  const avatar = header.querySelector('.w-\\[30px\\].h-\\[30px\\].rounded-\\[5px\\]');
  const nameEl = header.querySelector('.text-\\[13px\\].font-semibold');
  const urlEl = header.querySelector('.text-\\[11px\\].font-mono');
  const statusDot = header.querySelector('.w-\\[7px\\].h-\\[7px\\].rounded-full');
  const modelBadge = header.querySelector('.text-\\[10px\\].font-medium');
  const editBtn = Array.from(header.querySelectorAll('button')).find(b => b.textContent.includes('编辑'));
  const deleteBtn = Array.from(header.querySelectorAll('button')).find(b => b.textContent.includes('删除'));
  ({
    hasToggle: !!toggle,
    hasAvatar: !!avatar,
    avatarText: avatar ? avatar.textContent : null,
    providerName: nameEl ? nameEl.textContent.trim() : null,
    providerUrl: urlEl ? urlEl.textContent.trim() : null,
    hasStatusDot: !!statusDot,
    statusDotClasses: statusDot ? statusDot.className : null,
    modelBadgeText: modelBadge ? modelBadge.textContent.trim() : null,
    hasEditBtn: !!editBtn,
    hasDeleteBtn: !!deleteBtn,
    headerMinHeight: getComputedStyle(header).minHeight,
    headerBgColor: getComputedStyle(header).backgroundColor,
  });
}
```

#### 步骤 4：检查 section body 中的 model rows

```javascript
// CDP Runtime.evaluate
// 验证：body 中有 model row 列表，每个 row 有 toggle/name/ctx/tags
const body = document.querySelector('.border.rounded-lg > div:not(.bg-\\[var\\(--section-bg\\)\\])');
if (!body) {
  'BODY_NOT_FOUND';
} else {
  const modelRows = body.querySelectorAll('.flex.items-center.gap-2\\.5');
  ({
    bodyChildCount: body.children.length,
    modelRowCount: modelRows.length,
    rows: Array.from(modelRows).slice(0, 3).map((row, i) => {
      const name = row.querySelector('.font-mono.text-\\[13px\\]');
      const ctx = row.querySelector('.text-\\[11px\\].font-mono');
      const toggle = row.querySelector('.toggle-switch, [role="switch"]');
      const tags = row.querySelectorAll('.tag-pill, [class*="tag"]');
      return {
        index: i,
        name: name ? name.textContent.trim() : null,
        ctx: ctx ? ctx.textContent.trim() : null,
        hasToggle: !!toggle,
        tagCount: tags.length,
        opacityClass: row.classList.contains('opacity-50') ? 'opacity-50' : 'full-opacity',
      };
    }),
  });
}
```

#### 步骤 5：截图保存基准图

```bash
# 通过 CDP 截图，保存为基准对比图
# 使用 chrome-automation skill 或手动截图
# 保存路径: .xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots/tc-1.1-provider-section.png
mkdir -p /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-agent-provider/.xyz-harness/2026-05-12-settings-redesign/e2e-tests/screenshots
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| Provider section 数量 | ≥ 1（与 config.json 中 providers 数量一致） |
| section 容器样式 | `border rounded-lg overflow-hidden mb-3` |
| header 底色 | `bg-[var(--section-bg)]`，计算后为 `oklch(95% 0.014 70)` |
| header 最小高度 | ≥ 42px |
| header 内容 | toggle + avatar（首字母大写）+ name + status dot + url + model badge + 编辑/删除按钮 |
| avatar 尺寸 | 30×30px，border-radius 5px |
| status dot | 7×7px 圆形，connected 时 `bg-[var(--success)]` |
| body model rows | 数量与该 Provider 的 models 数组长度一致 |
| model row 内容 | toggle + mono name + ctx 值 + tag pills |
| 禁用 Provider | section 整体 `opacity-50` |

### 衡量方法

1. **DOM 结构断言**：步骤 2~4 的 JS 返回值中所有 `has*` 字段为 `true`，计数与 config.json 一致
2. **CSS 样式验证**：header `backgroundColor` 非透明，`minHeight` ≥ 42px
3. **截图视觉对比**：截图应与 `docs/designs/settings-final.html` 的 Provider section 视觉一致

### 结果记录

| 检查项 | 结果 | 备注 |
|--------|------|------|
| section 容器数量与样式 | ⬜ PASS / ⬜ FAIL | |
| header 底色与结构 | ⬜ PASS / ⬜ FAIL | |
| model rows 数量与内容 | ⬜ PASS / ⬜ FAIL | |
| 截图视觉对比 | ⬜ PASS / ⬜ FAIL | |

---

## TC-1.2: Provider Toggle 启停

### 目标

点击 ToggleSwitch 后 Provider 启停状态切换，section 整体 opacity 变化，WS 发出 `config.setProvider` 消息。

### 前置条件

- TC-1.1 通过（Provider section 正常渲染）
- 至少 1 个 Provider 当前为启用状态（`enabled !== false`）

### 测试步骤

#### 步骤 1：记录初始状态

```javascript
// CDP Runtime.evaluate
// 记录第一个 Provider section 的初始 enabled 状态
const section = document.querySelector('.border.rounded-lg');
const providerName = section.querySelector('.text-\\[13px\\].font-semibold')?.textContent?.trim();
const initialOpacity = section.classList.contains('opacity-50') ? 'disabled' : 'enabled';
const toggle = section.querySelector('.bg-\\[var\\(--section-bg\\)\\] [role="switch"], .bg-\\[var\\(--section-bg\\)\\] .toggle-switch');
const toggleChecked = toggle ? (toggle.classList.contains('active') || toggle.getAttribute('aria-checked') === 'true' || toggle.dataset.state === 'checked') : null;
({
  providerName,
  initialOpacity,
  toggleChecked,
});
```

#### 步骤 2：监听 WS 消息

在另一个终端，连接 WS 监听 `config.setProvider` 消息：

```bash
# 启动 WS 监听脚本，过滤 config.setProvider 和 config.providers 消息
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
console.log('WS 监听已启动，等待 config.setProvider 消息...');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'config.setProvider' || msg.type === 'config.providers' || msg.type === 'config.providerUpdated') {
    console.log('收到:', msg.type, JSON.stringify(msg.payload).slice(0, 300));
  }
});
ws.on('close', () => { console.log('WS 关闭'); process.exit(0); });
setTimeout(() => { console.log('超时，未收到消息'); ws.close(); }, 15000);
" 2>&1 | tee /tmp/ws-tc1.2.log &
WS_PID=$!
echo "WS 监听 PID: $WS_PID"
```

#### 步骤 3：点击 toggle

```javascript
// CDP Runtime.evaluate
// 点击第一个 Provider 的 toggle switch
const section = document.querySelector('.border.rounded-lg');
const headerToggle = section.querySelector('.bg-\\[var\\(--section-bg\\)\\] .toggle-switch, .bg-\\[var\\(--section-bg\\)\\] [role="switch"]');
if (headerToggle) {
  headerToggle.click();
  'CLICKED_TOGGLE';
} else {
  'TOGGLE_NOT_FOUND';
}
```

#### 步骤 4：验证 DOM 变化

```javascript
// CDP Runtime.evaluate（点击后等待 200ms 动画完成）
// 检查 section opacity 变化
const section = document.querySelector('.border.rounded-lg');
({
  hasOpacity50: section.classList.contains('opacity-50'),
  currentClasses: section.className,
});
```

#### 步骤 5：检查 WS 消息

```bash
# 检查 WS 监听捕获的消息
sleep 2
cat /tmp/ws-tc1.2.log
# 期望看到 config.setProvider 消息，payload 含 enabled: false

# 清理监听进程
kill $WS_PID 2>/dev/null
```

#### 步骤 6：恢复初始状态

再次点击 toggle 恢复启用：

```javascript
// CDP Runtime.evaluate
const section = document.querySelector('.border.rounded-lg');
const headerToggle = section.querySelector('.bg-\\[var\\(--section-bg\\)\\] .toggle-switch, .bg-\\[var\\(--section-bg\\)\\] [role="switch"]');
if (headerToggle) {
  headerToggle.click();
  'RESTORED - CLICKED_TOGGLE_AGAIN';
}
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| 点击前 section 状态 | 无 `opacity-50`，enabled |
| 点击后 section 状态 | 添加 `opacity-50` class |
| WS 发出消息 | `config.setProvider`，payload 含 `enabled: false` |
| Sidecar 响应 | 广播 `config.providers` 更新列表 |
| 恢复后 section 状态 | `opacity-50` 被移除 |

### 衡量方法

1. **DOM class 变化**：步骤 4 返回 `hasOpacity50: true`
2. **WS 消息确认**：`/tmp/ws-tc1.2.log` 中包含 `config.setProvider` 且 payload 含 `enabled: false`
3. **状态可逆**：二次 toggle 后 section 恢复原状态

### 结果记录

| 检查项 | 结果 | 备注 |
|--------|------|------|
| Toggle 点击后 opacity 变化 | ⬜ PASS / ⬜ FAIL | |
| WS config.setProvider 消息 | ⬜ PASS / ⬜ FAIL | |
| Sidecar 广播更新 | ⬜ PASS / ⬜ FAIL | |
| 恢复初始状态 | ⬜ PASS / ⬜ FAIL | |

---

## TC-1.3: Provider 编辑 Modal

### 目标

点击编辑按钮弹出 `ProviderModal`，可修改 Provider 名称后保存，WS 发送 `config.setProvider` 消息。

### 前置条件

- TC-1.1 通过
- 至少 1 个 Provider 可供编辑

### 测试步骤

#### 步骤 1：记录当前 Provider 名称

```javascript
// CDP Runtime.evaluate
const nameEl = document.querySelector('.border.rounded-lg .text-\\[13px\\].font-semibold');
const originalName = nameEl ? nameEl.textContent.trim() : null;
({ originalName });
```

#### 步骤 2：监听 WS 消息

```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
console.log('WS 监听已启动，等待编辑保存消息...');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type.includes('Provider') || msg.type.includes('provider')) {
    console.log('收到:', msg.type, JSON.stringify(msg.payload).slice(0, 300));
  }
});
ws.on('close', () => process.exit(0));
setTimeout(() => { console.log('超时'); ws.close(); }, 20000);
" 2>&1 | tee /tmp/ws-tc1.3.log &
WS_PID=$!
```

#### 步骤 3：点击编辑按钮

```javascript
// CDP Runtime.evaluate
// 找到第一个 Provider section 的编辑按钮
const section = document.querySelector('.border.rounded-lg');
const editBtn = Array.from(section.querySelectorAll('button')).find(b => b.textContent.includes('编辑'));
if (editBtn) {
  editBtn.click();
  'CLICKED_EDIT';
} else {
  'EDIT_BUTTON_NOT_FOUND';
}
```

#### 步骤 4：验证 Modal 已渲染

```javascript
// CDP Runtime.evaluate
// 检查 ProviderModal 是否弹出
const modal = document.querySelector('.modal-overlay, .modal-backdrop, [role="dialog"], .fixed.inset-0');
const modalTitle = document.querySelector('.modal-title, .modal h2, .modal h3, [role="dialog"] h2, [role="dialog"] h3');
({
  modalExists: !!modal,
  modalVisible: modal ? getComputedStyle(modal).display !== 'none' : false,
  modalTitle: modalTitle ? modalTitle.textContent.trim() : null,
  // 检查 modal 中的表单字段
  nameInput: !!document.querySelector('.modal input[type="text"], [role="dialog"] input[type="text"]'),
  urlInput: !!document.querySelector('.modal input[placeholder*="url" i], [role="dialog"] input[placeholder*="url" i], .modal input:nth-of-type(2)'),
  keyInput: !!document.querySelector('.modal input[type="password"], [role="dialog"] input[type="password"]'),
});
```

#### 步骤 5：修改 Provider 名称

```javascript
// CDP Runtime.evaluate
// 找到名称输入框并修改
const nameInput = document.querySelector('.modal input[type="text"], [role="dialog"] input[type="text"]');
if (nameInput) {
  // 清空并输入新名称
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeInputValueSetter.call(nameInput, 'Router-Edited');
  nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  nameInput.dispatchEvent(new Event('change', { bubbles: true }));
  'NAME_CHANGED_TO_Router-Edited';
} else {
  'NAME_INPUT_NOT_FOUND';
}
```

#### 步骤 6：点击保存

```javascript
// CDP Runtime.evaluate
// 找到 modal 中的保存按钮
const saveBtn = Array.from(document.querySelectorAll('.modal button, [role="dialog"] button')).find(b =>
  b.textContent.includes('保存') || b.textContent.includes('Save') || b.textContent.includes('确定')
);
if (saveBtn) {
  saveBtn.click();
  'CLICKED_SAVE';
} else {
  'SAVE_BUTTON_NOT_FOUND';
}
```

#### 步骤 7：验证保存结果

```javascript
// CDP Runtime.evaluate（保存后等待 300ms）
// 检查 modal 已关闭，Provider 名称已更新
const modal = document.querySelector('.modal-overlay, [role="dialog"]');
const nameEl = document.querySelector('.border.rounded-lg .text-\\[13px\\].font-semibold');
({
  modalClosed: !modal || getComputedStyle(modal).display === 'none',
  updatedName: nameEl ? nameEl.textContent.trim() : null,
});
```

#### 步骤 8：检查 WS 消息

```bash
sleep 2
cat /tmp/ws-tc1.3.log
# 期望看到 config.setProvider 消息

kill $WS_PID 2>/dev/null
```

#### 步骤 9：恢复原始名称

重复步骤 3~6，将名称改回原始值（如 "Router"），验证恢复成功。

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| 编辑按钮可点击 | 点击后 Modal 弹出 |
| Modal 标题 | 「编辑供应商」 |
| Modal 表单 | 包含 name / url / key 输入框 |
| 修改名称后保存 | Modal 关闭，section header 名称更新 |
| WS 消息 | 发送 `config.setProvider`，payload 含新名称 |
| 恢复原始名称 | 名称改回后 section 显示正确 |

### 衡量方法

1. **Modal DOM**：步骤 4 返回 `modalExists: true`，表单字段齐全
2. **WS 消息**：`/tmp/ws-tc1.3.log` 包含 `config.setProvider`
3. **UI 更新**：步骤 7 返回 `updatedName` 为新名称
4. **可恢复**：步骤 9 完成后名称回到原始值

### 结果记录

| 检查项 | 结果 | 备注 |
|--------|------|------|
| Modal 弹出与表单完整性 | ⬜ PASS / ⬜ FAIL | |
| 名称修改保存成功 | ⬜ PASS / ⬜ FAIL | |
| WS config.setProvider 消息 | ⬜ PASS / ⬜ FAIL | |
| 恢复原始名称 | ⬜ PASS / ⬜ FAIL | |

---

## TC-1.4: Provider 删除

### 目标

点击删除按钮后 Provider section 从 DOM 中移除，WS 发送 `config.deleteProvider` 消息，`~/.xyz-agent/config.json` 中对应 Provider 被删除。

### 前置条件

- TC-1.1 通过
- 至少存在 1 个 Provider

> **注意**：本测试会删除 Provider。如果只有一个 Provider，删除后需要重新添加。建议在测试前备份 config.json。

```bash
# 备份 config.json
cp ~/.xyz-agent/config.json ~/.xyz-agent/config.json.bak.tc1.4
echo "已备份 config.json"
```

### 测试步骤

#### 步骤 1：记录删除前状态

```javascript
// CDP Runtime.evaluate
const sections = document.querySelectorAll('.border.rounded-lg.mb-3, .max-w-\\[860px\\] > .border.rounded-lg');
({
  sectionCountBefore: sections.length,
  firstProviderName: sections[0]?.querySelector('.text-\\[13px\\].font-semibold')?.textContent?.trim(),
});
```

#### 步骤 2：监听 WS 消息

```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
console.log('WS 监听已启动，等待删除消息...');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type.includes('delete') || msg.type.includes('Provider') || msg.type.includes('provider')) {
    console.log('收到:', msg.type, JSON.stringify(msg.payload).slice(0, 300));
  }
});
ws.on('close', () => process.exit(0));
setTimeout(() => { console.log('超时'); ws.close(); }, 15000);
" 2>&1 | tee /tmp/ws-tc1.4.log &
WS_PID=$!
```

#### 步骤 3：点击删除按钮

```javascript
// CDP Runtime.evaluate
// 点击第一个 Provider 的删除按钮
const section = document.querySelector('.border.rounded-lg');
const deleteBtn = Array.from(section.querySelectorAll('button')).find(b => b.textContent.includes('删除'));
if (deleteBtn) {
  deleteBtn.click();
  'CLICKED_DELETE';
} else {
  'DELETE_BUTTON_NOT_FOUND';
}
```

> **备注**：根据 spec，Provider 删除没有 confirm-bar（confirm-bar 仅用于 Skill/Agent），点击后直接删除。如果实际实现中有确认弹窗，需在弹出后点击确认。

#### 步骤 4：验证 DOM 变化

```javascript
// CDP Runtime.evaluate（等待 300ms 动画）
const sections = document.querySelectorAll('.border.rounded-lg.mb-3, .max-w-\\[860px\\] > .border.rounded-lg');
const emptyState = document.querySelector('.flex.flex-col.items-center.justify-center');
({
  sectionCountAfter: sections.length,
  emptyStateVisible: !!emptyState && getComputedStyle(emptyState).display !== 'none',
  emptyStateText: emptyState ? emptyState.querySelector('.text-base')?.textContent?.trim() : null,
});
```

#### 步骤 5：检查 WS 消息

```bash
sleep 2
cat /tmp/ws-tc1.4.log
# 期望看到 config.deleteProvider 消息

kill $WS_PID 2>/dev/null
```

#### 步骤 6：验证数据文件变更

```bash
# 检查 config.json 中 Provider 是否已被删除
cat ~/.xyz-agent/config.json | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
providers = cfg.get('providers', {})
print(f'Remaining providers: {len(providers)}')
for pid in providers:
    print(f'  {pid}')
"
# 期望：Provider 数量减少 1，被删除的 Provider 不在列表中
```

#### 步骤 7：恢复测试数据

```bash
# 从备份恢复 config.json
cp ~/.xyz-agent/config.json.bak.tc1.4 ~/.xyz-agent/config.json
echo "已恢复 config.json"

# 刷新 Settings 页面验证恢复
# 重新连接 WS 或触发 config.getProviders
```

```javascript
// CDP Runtime.evaluate
// 刷新 Settings 页面使前端重新加载
// 如果 Provider 列表已恢复，section 数量应回到原始值
location.reload();
// 等待页面重载后重新检查
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| 点击删除后 section 移除 | DOM 中 Provider section 数量减少 1 |
| 空状态展示 | 最后一个 Provider 删除后显示空状态（「尚未配置任何供应商」） |
| WS 消息 | 发送 `config.deleteProvider`，payload 含 `providerId` |
| 数据持久化 | `config.json` 中对应 Provider 键被删除 |
| 恢复后正常 | 从备份恢复后刷新页面，Provider 列表恢复 |

### 衡量方法

1. **DOM 变化**：步骤 4 返回 `sectionCountAfter` = `sectionCountBefore - 1`
2. **WS 消息**：`/tmp/ws-tc1.4.log` 包含 `config.deleteProvider`
3. **数据文件**：步骤 6 输出中不包含被删除的 Provider
4. **恢复验证**：步骤 7 后 section 数量恢复原始值

### 结果记录

| 检查项 | 结果 | 备注 |
|--------|------|------|
| Section 从 DOM 移除 | ⬜ PASS / ⬜ FAIL | |
| WS config.deleteProvider 消息 | ⬜ PASS / ⬜ FAIL | |
| config.json 数据删除 | ⬜ PASS / ⬜ FAIL | |
| 空状态展示（若适用） | ⬜ PASS / ⬜ FAIL | |
| 恢复测试数据 | ⬜ PASS / ⬜ FAIL | |

---

## TC-1.5: Model Row Toggle

### 目标

在 Provider section body 中 toggle 单个 model，验证 WS 发送 `model.switch` 消息，model row 的 `opacity` class 变化。

### 前置条件

- TC-1.1 通过（Provider section 正常渲染，model rows 可见）
- Provider 下至少有 1 个已启用的 model

### 测试步骤

#### 步骤 1：记录 model row 初始状态

```javascript
// CDP Runtime.evaluate
// 获取第一个 Provider section 中所有 model rows 的状态
const body = document.querySelector('.border.rounded-lg > div:not(.bg-\\[var\\(--section-bg\\)\\])');
const rows = body.querySelectorAll('.flex.items-center');
const rowData = Array.from(rows).map((row, i) => {
  const name = row.querySelector('.font-mono.text-\\[13px\\]');
  const toggle = row.querySelector('.toggle-switch, [role="switch"]');
  return {
    index: i,
    name: name ? name.textContent.trim() : null,
    hasToggle: !!toggle,
    isDisabled: row.classList.contains('opacity-50'),
    toggleValue: toggle ? (toggle.classList.contains('active') || toggle.getAttribute('aria-checked') === 'true') : null,
  };
});
({
  totalModelRows: rowData.length,
  rows: rowData,
  // 选第一个已启用的 model 作为 toggle 目标
  targetModelIndex: rowData.findIndex(r => !r.isDisabled),
  targetModelName: rowData.find(r => !r.isDisabled)?.name,
});
```

#### 步骤 2：监听 WS 消息

```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3210');
console.log('WS 监听已启动，等待 model.switch 消息...');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'model.switch' || msg.type.includes('model') || msg.type.includes('Model')) {
    console.log('收到:', msg.type, JSON.stringify(msg.payload).slice(0, 300));
  }
});
ws.on('close', () => process.exit(0));
setTimeout(() => { console.log('超时'); ws.close(); }, 15000);
" 2>&1 | tee /tmp/ws-tc1.5.log &
WS_PID=$!
```

#### 步骤 3：点击第一个 model 的 toggle

```javascript
// CDP Runtime.evaluate
// 点击第一个已启用 model row 的 toggle
const body = document.querySelector('.border.rounded-lg > div:not(.bg-\\[var\\(--section-bg\\)\\])');
const rows = Array.from(body.querySelectorAll('.flex.items-center'));
const enabledRow = rows.find(r => !r.classList.contains('opacity-50'));
if (enabledRow) {
  const toggle = enabledRow.querySelector('.toggle-switch, [role="switch"]');
  if (toggle) {
    const modelName = enabledRow.querySelector('.font-mono.text-\\[13px\\]')?.textContent?.trim();
    toggle.click();
    ({ clicked: true, modelName });
  } else {
    'TOGGLE_NOT_FOUND_IN_ROW';
  }
} else {
  'NO_ENABLED_MODEL_FOUND';
}
```

#### 步骤 4：验证 DOM 变化

```javascript
// CDP Runtime.evaluate（等待 200ms 动画）
// 重新检查 model row 状态
const body = document.querySelector('.border.rounded-lg > div:not(.bg-\\[var\\(--section-bg\\)\\])');
const rows = body.querySelectorAll('.flex.items-center');
const firstRow = rows[0];
({
  firstRowNowDisabled: firstRow.classList.contains('opacity-50'),
  firstRowClasses: firstRow.className,
  // 记录所有 model 的当前状态
  allRows: Array.from(rows).map((r, i) => ({
    index: i,
    name: r.querySelector('.font-mono.text-\\[13px\\]')?.textContent?.trim(),
    isDisabled: r.classList.contains('opacity-50'),
  })),
});
```

#### 步骤 5：检查 WS 消息

```bash
sleep 2
cat /tmp/ws-tc1.5.log
# 期望看到 model.switch 消息，payload 含 modelId 和 enabled: false

kill $WS_PID 2>/dev/null
```

#### 步骤 6：恢复 model 状态

再次点击 toggle 恢复启用：

```javascript
// CDP Runtime.evaluate
const body = document.querySelector('.border.rounded-lg > div:not(.bg-\\[var\\(--section-bg\\)\\])');
const rows = Array.from(body.querySelectorAll('.flex.items-center'));
const disabledRow = rows.find(r => r.classList.contains('opacity-50'));
if (disabledRow) {
  const toggle = disabledRow.querySelector('.toggle-switch, [role="switch"]');
  if (toggle) {
    toggle.click();
    'RESTORED_MODEL';
  }
}
```

### 期望结果

| 检查项 | 期望值 |
|--------|--------|
| Model row toggle 可点击 | 点击 toggle 无报错 |
| 禁用后 row 样式 | 添加 `opacity-50` class |
| WS 消息 | 发送 `model.switch`，payload 含 `{ modelId, enabled: false }` |
| Provider section 不受影响 | section 整体仍为 enabled，仅单个 model row 变化 |
| 恢复后正常 | 二次 toggle 后 `opacity-50` 移除 |

### 衡量方法

1. **DOM class 变化**：步骤 4 返回 `firstRowNowDisabled: true`
2. **WS 消息**：`/tmp/ws-tc1.5.log` 包含 `model.switch` 且 `enabled: false`
3. **section 隔离**：Provider section 整体没有 `opacity-50`（只有 model row 有）
4. **状态可逆**：步骤 6 后 model row 恢复

### 结果记录

| 检查项 | 结果 | 备注 |
|--------|------|------|
| Model toggle 后 opacity 变化 | ⬜ PASS / ⬜ FAIL | |
| WS model.switch 消息 | ⬜ PASS / ⬜ FAIL | |
| Provider section 不受影响 | ⬜ PASS / ⬜ FAIL | |
| 恢复 model 状态 | ⬜ PASS / ⬜ FAIL | |

---

## 测试后清理

```bash
# 1. 恢复所有备份（如果有）
if [ -f ~/.xyz-agent/config.json.bak.tc1.4 ]; then
  cp ~/.xyz-agent/config.json.bak.tc1.4 ~/.xyz-agent/config.json
  rm ~/.xyz-agent/config.json.bak.tc1.4
  echo "已恢复 config.json 并清理备份"
fi

# 2. 验证恢复后状态
cat ~/.xyz-agent/config.json | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
providers = cfg.get('providers', {})
print(f'Provider 总数: {len(providers)}')
for pid, p in providers.items():
    enabled = p.get('enabled', True)
    models = p.get('models', [])
    modelEnabled = sum(1 for m in models if m.get('enabled', True))
    print(f'  {pid}: enabled={enabled}, models={len(models)} (enabled: {modelEnabled})')
"

# 3. 清理临时文件
rm -f /tmp/ws-tc1.2.log /tmp/ws-tc1.3.log /tmp/ws-tc1.4.log /tmp/ws-tc1.5.log
```

---

## Group 1 汇总

| TC ID | 测试目标 | 结果 | 阻断后续 |
|-------|---------|------|----------|
| TC-1.1 | Provider Section 渲染验证 | ⬜ PASS / ⬜ FAIL | 是 — 阻断 1.2~1.5 |
| TC-1.2 | Provider Toggle 启停 | ⬜ PASS / ⬜ FAIL | 否 |
| TC-1.3 | Provider 编辑 Modal | ⬜ PASS / ⬜ FAIL | 否 |
| TC-1.4 | Provider 删除 | ⬜ PASS / ⬜ FAIL | 否 |
| TC-1.5 | Model Row Toggle | ⬜ PASS / ⬜ FAIL | 否 |

**Group 1 通过标准**：TC-1.1 必须通过，其余 TC 至少 3/4 通过。
