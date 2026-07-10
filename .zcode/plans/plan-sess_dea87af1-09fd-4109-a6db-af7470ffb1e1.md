# 修复 9 WARNING + 17 SUGGESTION 代码审查发现

## 决策记录
- **W1+W2**: 串行锁 + 安装后重读版本（长期方案，合并 S5 公共方法抽取）
- **W3**: 保持现状（用户决策——实际扩展数量少，75s 是理论极端值）
- **W8+W9**: 首屏冒烟 + 关键交互测试

## 分 5 组并行（无文件重叠）

---

### Group A — Runtime 后端 (W1, W2, W6, S1, S2, S3, S4, S5)

**文件**: `extension-service.ts`, `npm-installer.ts`, `workspace-message-handler.ts`, `extension-upgrade.test.ts`（runtime）

**W1 + S5 — 串行锁 + 公共方法抽取** (`extension-service.ts`)
1. 新增私有串行锁字段 + 方法：
   ```typescript
   private installChain: Promise<void> = Promise.resolve()
   private withInstallLock<T>(fn: () => Promise<T>): Promise<T> {
     const result = this.installChain.then(fn)
     this.installChain = result.then(() => undefined, () => undefined)
     return result
   }
   ```
2. `installExtension` / `upgradeExtension` / `uninstallExtension` / `checkAndAutoUpgrade` 的方法体都包进 `return this.withInstallLock(() => { ... })`
3. 抽取公共方法 `private async installAndValidate(pkgName, npmDir): Promise<void>`，合并 260-274 + 377-390（installNpm + 错误分类）和 277-290 + 393-405（isValidPiExtension 验证 + 回滚）。两个调用方改为 `await this.installAndValidate(...)`

**W2 — 安装后重读版本** (`extension-service.ts`)
1. 新增 `private readInstalledVersion(pkgName, npmDir): string`——读 `node_modules/<name>/package.json` 的 version
2. `upgradeExtension` 末尾改为：`const actual = this.readInstalledVersion(name, npmDir); return { upgraded: true, from: currentVersion, to: actual || latestVersion }`

**W6 — workspace.record 校验失败时 reply** (`workspace-message-handler.ts:35`)
- 空 cwd 时改为 `ctx.reply(ws, msg.id, 'workspace.recentList', { records: ctx.workspaceService.list() })` 然后 return，不破坏 RPC 契约

**S1 — fetchJson body 超时** (`npm-installer.ts:166-186`)
- fetchJson 的 body 读取 Promise 加超时：`setTimeout(() => { final.destroy(new Error('Body read timeout')) }, timeout ?? DEFAULT_TIMEOUT)`，在 end/error 时 `clearTimeout`

**S2 — 重复 spyOn** (`extension-upgrade.test.ts:408-409`)
- 合并为一行 `const spy = vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')`

**S3 — 弱断言加强** (`extension-upgrade.test.ts:565-586`)
- getLatestVersion 抛错断言改为 `.rejects.toMatchObject({ code: 'not_found' })`

**S4 — npm 包名校验** (`extension-service.ts`)
- 新增 `isValidNpmPackageName(name)` 正则函数（`/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/`）
- `installExtension` 入口 `source.slice(NPM_PREFIX_LENGTH)` 后校验；`upgradeExtension` 入口校验

---

### Group B — Composer 交互 (W4, W5, S7, S8)

**文件**: `useContenteditableInput.ts`, `Composer.vue`, `useComposerHistory.ts`

**W4 + S7 — getCaretLineRect 简化** (`useContenteditableInput.ts:238-296`)
- 删除 255-293 行的全部 Range 重建逻辑（textOffset 计算 + 遍历子节点 + setStart）
- 理由：调用方传入的是 `sel.getRangeAt(0).cloneRange()`，probe 操作的是 clone，**实际 selection 从未被修改**——重建 Selection 完全多余且引入 W4 光标错放 bug
- probe 操作包 try/finally（S7），简化为：
  ```typescript
  const probe = document.createTextNode('\u200B')
  try {
    range.insertNode(probe)
    const probeRect = document.createRange().selectNode(probe).getBoundingClientRect()
    return (probeRect.top === 0 && probeRect.bottom === 0) ? null : probeRect
  } finally {
    const parent = probe.parentNode
    probe.remove()
    if (parent?.nodeType === Node.ELEMENT_NODE) (parent as Element).normalize()
  }
  ```
- 从 ~55 行减到 ~12 行

**W5 — ↑/↓ 修饰键守卫** (`Composer.vue:338,344`)
- 条件改为 `e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey`（↓ 同理）
- 更新注释说明：修饰键组合放行原生 word/line 导航

**S8 — handleArrowDown undefined 防御** (`useComposerHistory.ts:134`)
- `deps.setText(h[index] ?? savedDraft, 'end')`——极端场景 history 变更时回退到草稿

---

### Group C — Panel/UI (W7, S9, S10, S11, S17)

**文件**: `markdown.ts`, `Panel.vue`, `Turn.vue`, `workspace.ts`(store), `mermaid.ts`

**W7 — trimEnd 注释更新** (`markdown.ts:362-365`)
- 注释改为：`trimEnd：markdown-it 输出末尾带 \n（如 "<p>hi</p>\n"），防御性清理。breaks:true 后不再依赖 pre-wrap 容器，但末尾空白文本节点无意义，保留清理`

**S9 — isGenerating 重命名** (`Panel.vue:156-164,58,66,183`)
- computed `isGenerating` → `isSessionActive`，更新所有内部引用（3 处 + 定义 + 注释）

**S10 — --panel-bg fallback** (`Turn.vue:118`)
- `bg-[var(--panel-bg)]` → `bg-[var(--panel-bg,var(--surface))]`

**S11 — 删除无效自赋值** (`workspace.ts:46`)
- 删除 catch 块的 `records.value = [...records.value]`，保留注释

**S17 — mermaid 注释补全** (`mermaid.ts:13`)
- 注释改为列出全部更新色值，或改为指引式「色值取自 style.css :root，详见 resolveMermaidThemeVariables 内注释」

---

### Group D — Sidebar (S13, S14, S15)

**文件**: `SessionItem.vue`, `SessionList.vue`, `useSidebar.ts`

**S13 — 减少 keydown listener** (`SessionItem.vue` + `SessionList.vue`)
- SessionList：新增单一 `useEventListener(window, 'keydown')` 监听 Esc，通过 `provide('sessionEscTrigger', escTrigger)` 暴露递增计数 ref
- SessionItem：移除自身的 `useEventListener(window, 'keydown')`，改用 `inject('sessionEscTrigger')` + `watch` 重置 confirming

**S14 — 冗余 hover 类** (`SessionItem.vue:53`)
- 确认态 Button class 去掉重复的 `hover:bg-danger hover:text-white`（与基态相同无视觉效果）

**S15 — deleteSession 覆盖 focusedSessionId** (`useSidebar.ts:325`)
- 删除前增加对 panel store 的 focusedSessionId 检查：若删除的是聚焦面板的 session，触发面板回退/清空（需要先读 panel store 结构确认具体 API）

---

### Group E — 测试补充 (W8, W9, S16, S12)

**文件**: 新建 `extension-page.test.ts`、新建 `provider-page.test.ts`、`fg6-overview.test.ts`、`mock/index.ts`

**W8 — ExtensionPage 渲染测试** (新建 `__tests__/settings/extension-page.test.ts`)
- Mock `@/api`（extension.upgrade/setAutoUpgrade/fetchRecommended/onExtensions 返回 vi.fn()）
- Mount ExtensionPage with props `{ extensions: [userInstalledExt, builtinExt] }`
- 断言：user-installed 项含升级按钮（title="升级"）+ 自动升级 Switch；built-in 项不含
- 断言：点击升级按钮后 transport.send 发送 `extension.upgrade`

**W9 — ProviderPage 渲染测试** (新建 `__tests__/settings/provider-page.test.ts`)
- Mock `@/api` + `@/stores/settings`
- Mount ProviderPage with props `{ providers: [] }`
- 断言：「添加供应商」按钮存在
- 断言：点击后 dialog 出现在 document.body（reka-ui teleport）

**S16 — fg6-overview.test.ts 更新** (`__tests__/fg6-overview.test.ts`)
- Overview.vue 已改读 `focusedSessionId`，但测试仍断言 `session.activeId`。更新断言或补充 focusedSessionId 高亮测试

**S12 — mock this 绑定** (`api/mock/index.ts:670`)
- `record` 方法内 `this.listRecent()` 改为抽内部函数 `function buildRecentRecords()` 复用，消除 `this` 依赖

---

## S6 不修（PR 范围观察）
`shared/protocol.ts` 的 `workspace.record` 混入 extension-upgrade PR 属于 PR hygiene，当前 PR 已推送，代码层面无 action。

## 执行顺序
1. Group A-E 并行启动 5 个 subagent（无文件重叠）
2. 全部完成后：lint + runtime test + renderer test 验证
3. 统一 commit + push 更新 PR #81

## 验证标准
- `npx vitest run`（runtime + renderer 全绿）
- `npm run lint`（0 error）
- runtime test 数量不减少
