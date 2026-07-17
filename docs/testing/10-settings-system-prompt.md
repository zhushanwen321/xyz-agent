# 10 · 系统提示词配置（Settings · SystemPrompt）测试流程

> 覆盖：Settings → 「系统提示词」菜单 → 三卡片（替换 pi 核心提示词 / 追加注入额外提示词 / 查看当前生效提示词快照）→ 保存/失败 toast / 快照刷新 / corrupted 兜底。
>
> 先读 [00-test-strategy-overview.md](./00-test-strategy-overview.md) 理解双轨制和公共前置。

## 1. 功能概述

「系统提示词」配置页是 Settings 下的一个菜单页（W1-W8 落地，FR-4/FR-5/FR-6/FR-7），允许用户在不动代码的前提下调整 pi agent 的系统提示词行为。三种互不冲突的能力：

```
卡 1 替换 pi 核心系统提示词
  → ConfigService.getReplaceSystemPrompt() 读取 → spawn pi 时透传 --system-prompt
  → 仅对【新建会话】生效（已存在的会话不会改 spawn 参数）

卡 2 追加注入额外提示词
  → xyz-system-prompt-extension.js 注册 before_agent_start hook
  → 每轮读 <dataDir>/system-prompt.json，append 到 event.systemPrompt 末尾
  → 保存后【下一轮】即生效（hook 每轮读配置，热生效）

卡 3 当前生效提示词快照
  → hook 每轮把最终 systemPrompt 写入 <dataDir>/system-prompt-snapshot.md
  → ConfigService.getSystemPromptSnapshot() 读快照文件（mtime 为「最后写入时间」）
  → 只读展示，给用户一个「实际生效提示词长什么样」的窗口
```

**关键设计**：replace（启动期 CLI 注入）与 append（运行期 hook 注入）走两条独立链路；配置存独立文件 `<configDir>/system-prompt.json`（不复用 `config.json`），插件每轮直读，故追加保存后立即生效。快照是多 session 共享的单一文件（最后写入者胜出）。

## 2. 组件树

```
SettingsModal.vue
  └─ SystemPromptPage.vue (data-testid="system-prompt-page")  ← activeMenu === 'systemPrompt' 时渲染
       ├─ corrupted 提示条（v-if="corrupted"，警告色）
       ├─ 卡 1 替换系统提示词
       │    ├─ Switch (data-testid="system-prompt-replace-switch")
       │    ├─ Textarea (data-testid="system-prompt-replace-input")
       │    └─ Button 保存 (data-testid="system-prompt-replace-save")
       ├─ 卡 2 注入额外提示词
       │    ├─ Switch (data-testid="system-prompt-append-switch")
       │    ├─ Textarea (data-testid="system-prompt-append-input")
       │    └─ Button 保存 (data-testid="system-prompt-append-save")
       └─ 卡 3 当前生效提示词
            ├─ Button 刷新 (data-testid="system-prompt-snapshot-refresh")
            ├─ 内容区 (data-testid="system-prompt-snapshot-content")
            └─ 更新时间 (data-testid="system-prompt-snapshot-updated-at")
```

**渲染条件**（`SettingsModal.vue`）：
- `SystemPromptPage` 渲染：`activeMenu === 'systemPrompt'`（菜单项 `menus[4]`，`labelKey: 'settings.menu.systemPrompt'`）
- 菜单 label key 故意不翻译（见 §6 已知坑），定位按钮靠 textContent 含 `'systemPrompt'`
- 两张编辑卡 Switch 关闭时 Textarea + 保存按钮 `:disabled`；快照卡恒显

## 3. data-testid 清单

| testid | 文件:行 | 触发/可见条件 |
|--------|---------|--------------|
| `system-prompt-page` | SystemPromptPage.vue:8 | 切到 systemPrompt 菜单后恒显（页面根容器） |
| `system-prompt-replace-switch` | SystemPromptPage.vue:26 | 卡 1 恒显（Switch 控件，model-value 绑 replaceEnabled） |
| `system-prompt-replace-input` | SystemPromptPage.vue:38 | 卡 1 恒显，`!replaceEnabled` 时 disabled |
| `system-prompt-replace-save` | SystemPromptPage.vue:48 | 卡 1 恒显，`!replaceEnabled` 时 disabled，点击调 `saveReplace` |
| `system-prompt-append-switch` | SystemPromptPage.vue:67 | 卡 2 恒显（model-value 绑 appendEnabled） |
| `system-prompt-append-input` | SystemPromptPage.vue:79 | 卡 2 恒显，`!appendEnabled` 时 disabled |
| `system-prompt-append-save` | SystemPromptPage.vue:89 | 卡 2 恒显，`!appendEnabled` 时 disabled，点击调 `saveAppend` |
| `system-prompt-snapshot-refresh` | SystemPromptPage.vue:108 | 卡 3 恒显，`snapshotRefreshing` 时 disabled |
| `system-prompt-snapshot-content` | SystemPromptPage.vue:120 | 卡 3 恒显，快照为空时显示占位文案 |
| `system-prompt-snapshot-updated-at` | SystemPromptPage.vue:128 | 卡 3 恒显，无快照时显示 `snapshotNoTime` 占位 |

## 4. MOCK 模式测试

### 4.1 mock 策略

`vi.mock('@/api')` 提供 `config` 门面（三个系统提示词方法 + SettingsModal/store 依赖的 `listProviders`/`setSkillDirs`/`setAgentDirs`）：

```typescript
// 典型 mock（system-prompt-page.test.ts）
const configMock = vi.hoisted(() => ({
  getSystemPrompt: vi.fn(() => Promise.resolve({ config: defaultConfig(), corrupted: false })),
  setSystemPrompt: vi.fn((cfg) => Promise.resolve({ config: cfg, corrupted: false })),
  getSystemPromptSnapshot: vi.fn(() => Promise.resolve({ exists: false })),
  listProviders: vi.fn(() => Promise.resolve([])),
  setSkillDirs: vi.fn(() => Promise.resolve()),
  setAgentDirs: vi.fn(() => Promise.resolve()),
}))
```

> **坑 1**：`SettingsModal` 挂载时 `useSettings` 会调 `settings.getSystem`，必须一并 mock `settings.getSystem`（返回 `{ locale, theme, themePreset }`）。
> **坑 2**：菜单 label key 未翻译，`openSystemPromptPage()` 靠 `nav button.textContent.includes('systemPrompt')` 定位按钮后 click。

### 4.2 集成测试（vitest，已有）

| 测试文件 | 覆盖用例 |
|---------|---------|
| [`__tests__/settings/system-prompt-page.test.ts`](../../packages/renderer/src/__tests__/settings/system-prompt-page.test.ts) | 渲染 gate（10 testid 全在）/ 替换卡警告文案 / 保存成功 toast / 保存失败 error toast / 快照渲染 + 刷新 / corrupted 提示 |

**运行**：
```bash
cd packages/renderer && npx vitest run src/__tests__/settings/system-prompt-page.test.ts
```

**典型用例**：
- 渲染 gate：`openSystemPromptPage()` 后遍历 10 个 requiredIds 断言 `hasTestId(id) === true`
- 保存流：`trigger('click')` 替换 Switch → `setValue('自定义系统提示词')` → 点保存 → 断言 `setSystemPrompt` 被调且 payload.replace.enabled===true，且出现 info toast
- 失败反馈：`setSystemPrompt.mockRejectedValueOnce(new Error('保存失败'))` → 点保存 → 断言出现 error toast 含「保存失败」
- 快照卡：`getSystemPromptSnapshot.mockResolvedValueOnce({ exists: true, content: 'PROMPT_TEXT', updatedAt: '...' })` → 断言内容区含 PROMPT_TEXT → 点刷新 → 断言被调 2 次
- corrupted：`getSystemPrompt.mockResolvedValueOnce({ ..., corrupted: true })` → 断言页内文本含「损坏」

### 4.3 调用链（前端 → runtime → 磁盘）

```
SystemPromptPage.saveReplace()
  → config.setSystemPrompt(buildConfig())            (api/domains/config.ts:149)
  → command('config.setSystemPrompt', { config })    (WS 请求)
  → SettingsMessageHandler.handleSettingsMessage     (settings-message-handler.ts:163)
  → ConfigService.setSystemPromptConfig(config)      (config-service.ts:509)
       ├─ 长度校验：replace.prompt > SYSTEM_PROMPT_MAX_LENGTH(16000) → { ok:false, error }
       └─ atomicWrite(<configDir>/system-prompt.json)
  → reply 'config.systemPrompt' { config, corrupted:false }
  → broadcast 'config.systemPrompt'（多 panel 同步）

SystemPromptPage.loadConfig()
  → config.getSystemPrompt()                         (api/domains/config.ts:143)
  → command('config.getSystemPrompt', {})
  → ConfigService.getSystemPromptConfig()            (config-service.ts:494)
       ├─ 文件不存在 → 默认配置，corrupted:false
       ├─ JSON.parse 失败 → 默认配置，corrupted:true
       └─ 字段缺失/类型错 → mergeSystemPromptConfig 容错，corrupted:false

SystemPromptPage.loadSnapshot()
  → config.getSystemPromptSnapshot()                 (api/domains/config.ts:155)
  → ConfigService.getSystemPromptSnapshot()          (config-service.ts:532)
       └─ 读 <configDir>/system-prompt-snapshot.md + statSync mtime
```

**长度上限 SSOT**：`SYSTEM_PROMPT_MAX_LENGTH = 16000`（`packages/shared/src/constants.ts:53`），ConfigService 与前端 textarea 计数器同源引用。

## 5. 非 MOCK 测试步骤（真实 runtime）

```bash
pnpm dev
```

### 5.1 ConfigService 单测（`packages/runtime/test/`）

| 测试文件 | 覆盖用例 |
|---------|---------|
| [`config-service.test.ts`](../../packages/runtime/test/config-service.test.ts) | system-prompt.json 读写、损坏兜底、超长拒绝、mergeSystemPromptConfig 字段级容错 |
| [`settings-message-handler-system-prompt.test.ts`](../../packages/runtime/test/settings-message-handler-system-prompt.test.ts) | 3 个 WS case 路由：`config.getSystemPrompt`（含 corrupted 透传）/ `config.setSystemPrompt`（成功 reply+broadcast、失败按 D10 错误信封不广播）/ `config.getSystemPromptSnapshot` |
| [`rpc-client-system-prompt.test.ts`](../../packages/runtime/test/rpc-client-system-prompt.test.ts) | spawn pi 时 `--system-prompt` CLI arg 注入：有值/仅空白/未传 三态 |

**运行**：
```bash
cd packages/runtime && npx vitest run test/config-service.test.ts test/settings-message-handler-system-prompt.test.ts test/rpc-client-system-prompt.test.ts
```

### 5.2 插件单测（before_agent_start hook 行为）

| 测试文件 | 覆盖用例 |
|---------|---------|
| [`system-prompt-extension.test.ts`](../../packages/runtime/test/system-prompt-extension.test.ts) | append 开启且非空 → BASE+\n\n+EXTRA / append 关闭 → undefined / 配置缺失 → undefined / JSON 损坏 → undefined / append.prompt 纯空白 → undefined / 写入快照内容一致 / 相同内容第二次不更新 mtime（防抖）/ append 关闭也写原 prompt 快照 / PI_CODING_AGENT_DIR 回退定位 |
| [`extension-service-system-prompt.test.ts`](../../packages/runtime/test/extension-service-system-prompt.test.ts) | `getExtensionPaths()`：xyz-system-prompt-extension.js 存在时排在 xyz-agent-extension.js 之后；不存在时不包含 |

**插件文件**：[`xyz-system-prompt-extension.js`](../../xyz-system-prompt-extension.js)（repo root，无 build step / 无 npm deps，pi 经 `--extension <path>` 加载）

**关键 hook 行为**（`xyz-system-prompt-extension.js:109`）：
- 每轮 `before_agent_start` 读 `<dataDir>/system-prompt.json`（不缓存）
- append.enabled && append.prompt 非空白 → `newPrompt = basePrompt + '\n\n' + append.prompt`，返回 `{ systemPrompt: newPrompt }`；否则返回 `undefined`（放行）
- 快照无条件写入（append 关闭也写原 prompt），用 tmp+rename 原子写，内容相同则跳过（保 mtime）
- 任何异常吞掉返回 `undefined`，绝不阻塞 agent loop

**运行**：
```bash
cd packages/runtime && npx vitest run test/system-prompt-extension.test.ts test/extension-service-system-prompt.test.ts
```

### 5.3 手工冒烟清单（每项必做，MOCK 测不出真实 spawn/hook）

| 步骤 | 操作 | 期望 |
|------|------|------|
| 1 | Settings → 系统提示词 → 开替换卡开关 + 填文本 → 保存 | toast 提示成功；`~/.xyz-agent-dev/system-prompt.json` 写入 |
| 2 | 新建会话发一条消息 | runtime 日志 spawn pi 时 args 含 `--system-prompt "..."`
（rpc-client.ts:132-133） |
| 3 | 切回 append 卡开关 + 填追加文本 → 保存 | config 写入；在已有会话发下一轮 → 快照卡刷新含追加文本 |
| 4 | 点快照卡刷新 | `system-prompt-snapshot.md` 读出 + mtime 显示为最后写入时间 |
| 5 | 手动把 system-prompt.json 改成非法 JSON 后刷新页 | corrupted 提示条出现，控件回退默认值（不崩） |
| 6 | replace.prompt 填超 16000 字符 → 保存 | runtime 返回 error 信封，前端 error toast |

## 6. 已知坑 / 注意事项

| 坑 | 说明 |
|----|------|
| ⚠️ 菜单 label key 故意不翻译 | `settings.menu.systemPrompt` 未走 i18n，按钮 textContent 含字面量 `'systemPrompt'`。测试定位按钮用 `textContent.includes('systemPrompt')`，不要按翻译文案找 |
| ⚠️ 替换模式仅对新建会话生效 | replace 走 spawn 期 `--system-prompt` CLI，已存在的会话不会重新 spawn。改完 replace 后必须新建会话才看到效果（rpc-client.ts:55-56 spawn options 语义） |
| ✅ 追加模式下一轮即生效 | append 走 before_agent_start hook，hook 每轮读配置（不缓存）。保存后同一会话下一轮即可生效 |
| ⚠️ 快照是多 session 共享 | `<dataDir>/system-prompt-snapshot.md` 是全局单文件，最后写入者胜出。多 panel / 多会话并存时快照反映最后一次 hook 执行，不一定是当前 panel 的会话 |
| ⚠️ corrupted 仅 JSON.parse 失败才置 true | 字段缺失/类型错走 `mergeSystemPromptConfig` 字段级容错（corrupted=false）。只有文件整个不是合法 JSON 才回退默认 + corrupted=true 提示用户 |
| ⚠️ 长度上限 16000 | `SYSTEM_PROMPT_MAX_LENGTH`（shared/constants.ts:53），ConfigService 拒绝超长（ok:false），前端 textarea 显示 `len/16000` 计数 |
| ⚠️ hook 绝不阻塞 agent | xyz-system-prompt-extension.js 顶层 try/catch 兜底，任何异常返回 `undefined`（放行）。测试注入坏 dataDir 不会让 pi 卡住 |

## 7. 相关文档

- 组件源码：[`components/settings/SystemPromptPage.vue`](../../packages/renderer/src/components/settings/SystemPromptPage.vue)
- 菜单注册：[`components/settings/SettingsModal.vue`](../../packages/renderer/src/components/settings/SettingsModal.vue)（`menus[4] = { id: 'systemPrompt', ... }`）
- 数据层：[`api/domains/config.ts`](../../packages/renderer/src/api/domains/config.ts) §System prompt config
- runtime 配置：[`services/config-service.ts`](../../packages/runtime/src/services/config-service.ts) §System prompt config（line 445+）
- WS 路由：[`transport/settings-message-handler.ts`](../../packages/runtime/src/transport/settings-message-handler.ts)（line 154-185）
- 插件扩展：[`xyz-system-prompt-extension.js`](../../xyz-system-prompt-extension.js)（repo root）
- 集成测试：[`__tests__/settings/system-prompt-page.test.ts`](../../packages/renderer/src/__tests__/settings/system-prompt-page.test.ts)
- 架构约束：[AGENTS.md §11 Plugin System](../../AGENTS.md)（builtin 文件型 pi 扩展条目）
