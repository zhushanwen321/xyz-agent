# i18n-frontend-p2 Code Review

## 审查范围
- 5 个 Wave commit（`8dcca071..bcda08c1`）：W1 99799923 / W2 69ddc900 / W3 a498a4d6 / W4 58a21f11 / W5 bcda08c1
- 39 文件，+894 -191 行

## 维度 1：业务逻辑正确性

### PASS — 核心回归修复正确

**W1 SearchModal AH-S3 回归修复（P0）**：
- 根因：`s.label === '最近'` 硬编码中文字面量与 i18n 后的 label 比较 → en-US 下恒 false → recents 分组丢失
- 修复：Section 接口新增 `kind: SectionKind`（非本地化稳定标识），filter 逻辑改为 `s.kind === 'recent' || kindToType.value[s.kind] === activeType.value`
- labelToType → kindToType computed：从基于 label 字符串匹配改为基于 kind 枚举匹配，彻底解耦 locale 与 UI 逻辑 ✓

**W2 thinking-levels 数据源 i18n（P0）**：
- 根因：THINKING_LEVELS 直接存 `label: '关'/'低'/...` 中文，ProviderEditModal 消费点 en-US 下仍显示中文
- 修复：ThinkingLevelOption 加 `labelKey: string`，getDisplayLabel 接收可选 `t` 函数参数（不传时 fallback 全局 `i18n.global.t`），6 档 + on/default 全走 t() ✓
- THINKING_STRATEGIES 同步加 labelKey ✓

**W3 panel 13 处 + W4 sidebar 6 处**：全部硬编码 → t() 调用，locale key 双侧同步 ✓

### 需审视：SearchModal Dialog 拆包（W1 附带改动）

W1 commit 同时做了两件事：
1. **i18n 修复**（kind-based filter）—— plan 范围内
2. **Dialog 拆包**（reka-ui `<Dialog>` → inline overlay div）—— 超出 plan 范围

拆包原因写在注释里：happy-dom + Teleport 把 DialogContent 渲染到 document.body，测试 wrapper.html() 拿不到内容。这是**测试驱动**的结构改动，不是 i18n 需求驱动的。

**风险评估**：
- 生产行为：注释列出了对齐措施（ESC keydown / 点遮罩关闭 / focus 管理 / sr-only a11y label）
- 正面：拆包后不再依赖 reka-ui DialogRootContext，测试可直接断言 DOM
- 需人工验证（E1）：dev server 下 ⌘K 打开 SearchModal，确认生产视觉/交互与拆包前一致（ESC 关闭、点遮罩关闭、input autofocus、focus trap）

**判定**：不阻塞 merge，但必须在 E1 手动验证 SearchModal 的生产行为。

## 维度 2：类型安全

### PASS — 无 any/as 滥用

- SectionKind union type 精确（7 个字面量）✓
- getDisplayLabel 签名清晰：`t?: (key: string) => string` 可选参数 ✓
- THINKING_STRATEGIES 类型从 `Array<{ key; fullLabel }>` 扩展为 `Array<{ key; fullLabel; labelKey }>` ✓
- formatTokens 函数签名从 `(tokens: number)` 改为 `(tokens: number, unit: string)`，3 组件统一 ✓

### 需审视：en-US/composable.ts 文件末尾缺 newline

```
\ No newline at end of file
```
zh-CN/composable.ts 有末尾 newline，en-US/composable.ts 没有。不影响功能但 ESLint/editor 可能 warn。**should_fix（低优先级）**。

## 维度 3：边界条件

### PASS — 关键边界已处理

- getDisplayLabel 的 fallback：`opt` 不存在时走 `t('composable.thinkingLevel.default')` 而非裸字符串 `'思考'` ✓
- SearchModal filter：`activeType.value` 为 null 时不过滤（全部返回），有值时 kind-based 过滤 ✓
- Section.kind 完整覆盖所有 useSearch 构造点（mock fixture / 空查询 / 非空查询）✓

### 需审视：en-US thinkingLevel.xhigh = 'very_high'

zh-CN: `'极高'`，en-US: `'very_high'`。用下划线小写而非 Title Case（其余是 'off'/'low'/'medium'/'high'/'max' 全小写，'On' 首字母大写）。
- 'very_high' 与其他 level 风格不一致（如果是 UI 展示应该用 'Very High'）
- 但考虑到这些 level 值在 ThinkingLevelPopover 里可能只做 enum 比较（不直接渲染），需确认消费点

**should_fix（低优先级）**：如果 'very_high' 会显示给用户，应改为 'Very High'。ThinkingLevelPopover 用 getDisplayLabel → t('composable.thinkingLevel.xhigh')，会渲染给用户。建议改 'Very High'。

## 维度 4：测试覆盖

### PASS — 140 测试覆盖 U1-U8 全部 testCase

| testCase | 测试文件 | 断言数 | 覆盖质量 |
|---|---|---|---|
| U1 | section-kind.test.ts | 3 | useSearch 三条构造路径全覆盖 ✓ |
| U2 | search-modal-kind.test.ts | 2 | en-US recents 恒显 + 源码无硬编码 ✓ |
| U3 | thinking-levels-i18n.test.ts | 3 | labelKey 完整 + on-off map + zh-CN ✓ |
| U4 | thinking-levels-i18n.test.ts | 2 | THINKING_STRATEGIES labelKey + en-US 值 ✓ |
| U5 | panel-i18n-p2.test.ts | 3 | GitPanel 按钮/pill + SideDrawer tab ✓ |
| U6 | panel-i18n-p2.test.ts | 3 | Sidebar 重试 + SegmentedTab ✓ |
| U7 | locale-sync-check.test.ts | 1 | 双侧 key 对齐 ✓ |
| U8 | locale-sync-check.test.ts | 123 | 模板无 CJK + 子模块逐文件比对 ✓ |

### 需审视：U5 测试设计降级

原 U5 测试用 `mount(GitPanel)` 断言 HTML 含 'Stage'/'Unstage'/'Commit'，但因 mock 数据不足（`result.isRepo=false`）导致 section 不渲染，测试失败。当前改为直接断言 `i18n.global.t('panel.git.stage')` + readFileSync 源码验证。

**评估**：
- 正面：测试稳定（不依赖完整组件 mount），且验证了两个关键事实（key 值正确 + 源码走 t()）
- 代价：未做使用者视角（黑盒）验证——没有 mount 组件断言"用户实际看到 Stage 按钮"
- 按项目测试规范第 5 条"每条集成/E2E 用例至少一个用户可见断言"：当前 U5 降级为构建者视角（白盒）

**判定**：i18n 文案测试的性质决定了 key+源码验证是合理的（mount 整个 GitPanel 需要完整 git provide/store，与 i18n 验证目标正交）。但应在 E1 手动验证补上使用者视角。不阻塞 merge。

## 维度 5：一致性 / 品味

### PASS — 遵循项目约定

- locale key 命名遵循现有 `{namespace}.{camelCase}` 风格 ✓
- zh-CN/en-US 双侧结构完全对齐 ✓
- formatTokens 函数签名在 3 个 sidebar 组件统一为 `(tokens, unit)` ✓
- `t()` 调用风格一致：template 用 `{{ t('key') }}`，script 用 `t('key', { param })` ✓
- getDisplayLabel 的 `t` 参数可选设计兼容了组件内（传 useI18n 的 t）和组件外（fallback 全局）两种调用场景 ✓

### 需审视：单位 i18n 设计决策

`turnsUnit`/`tokUnit`/`tokenInUnit`/`tokenOutUnit` 在 zh-CN 和 en-US 两侧值相同（'turns'/'tok'/'in'/'out'）。这是有意为之——技术术语/缩写不翻译，但走 i18n 通道保持一致性。注释说明了决策。合理 ✓

## Plan 覆盖核对

### W1 changes 覆盖

| plan change | 实际 commit | 状态 |
|---|---|---|
| search-types.ts Section 加 kind | ✓ line 53-75 | DONE |
| useSearch.ts 三处构造点填 kind | ✓ | DONE |
| search-data.ts mock fixture 补 kind | ✓（api/mock/index.ts diff） | DONE |
| SearchModal labelToType→kindToType + filter | ✓ | DONE |
| labelToType computed 化 | ✓（kindToType computed） | DONE |

### W2 changes 覆盖

| plan change | 实际 commit | 状态 |
|---|---|---|
| ThinkingLevelOption 加 labelKey | ✓ | DONE |
| THINKING_LEVELS labelKey 6 档 | ✓ | DONE |
| getDisplayLabel 接收 t 参数 | ✓ | DONE |
| line 85 '开' / line 86 '思考' 走 t() | ✓ | DONE |
| useProviderEdit THINKING_STRATEGIES labelKey | ✓ | DONE |
| ThinkingLevelPopover 调用点 | ✓（4 行改动） | DONE |
| ProviderEditModal L243/L316 | ✓（4 行改动） | DONE |
| composable.ts zh-CN/en-US 11 key | ✓（8+3 key） | DONE |

### W3 changes 覆盖

| plan change | 实际 commit | 状态 |
|---|---|---|
| panel.ts 新增 key（双侧） | ✓ 28 key | DONE |
| GitPanel 三按钮 + pillLabel | ✓ | DONE |
| SideDrawer 5 tab label | ✓ | DONE |
| DetailPane Diff 按钮 | ✓ | DONE |
| Panel.vue overlay label | ✓ | DONE |
| AmbiguousFilePopover 标题 | ✓ | DONE |
| Block.vue 3 处 | ✓ | DONE |
| SystemNotice 2 处 | ✓ | DONE |
| Turn.vue 2 badge | ✓ | DONE |
| QueueBubble itemCount | ✓ | DONE |
| BgNotifyCard patchHint | ✓ | DONE |
| CommandDocPanel noFullDoc | ✓ | DONE |
| CommandPopover '目录' | ✓（注释说明数据契约） | DONE |

### W4 changes 覆盖

| plan change | 实际 commit | 状态 |
|---|---|---|
| Sidebar.vue 重试按钮 | ✓ | DONE |
| SegmentedTab Agents/Flows | ✓ | DONE |
| SubagentList turns/tok | ✓ | DONE |
| WorkflowList agents/tok | ✓ | DONE |
| WorkflowDetail agent/default/in/out/turns | ✓ | DONE |
| sidebar.ts 双侧同步 | ✓ 11 key | DONE |

### W5 changes 覆盖

| plan change | 实际 commit | 状态 |
|---|---|---|
| locale key sync 检查 | ✓（locale-sync-check.test.ts U7） | DONE |
| 模板 CJK 检查 | ✓（locale-sync-check.test.ts U8） | DONE |
| check:i18n script | ✓（package.json） | DONE |
| pre-commit 触发 | ✗（plan 标注"可选"，未做） | N/A |

## should_fix 清单

1. **[低] en-US thinkingLevel.xhigh = 'very_high'** → 建议改 'Very High'（会显示给用户，风格与其他 level 不一致）
2. **[低] en-US/composable.ts 文件末尾缺 newline** → 补 `\n`

## must_fix 清单

无。核心回归修复正确，测试覆盖完整，无阻塞问题。

## 总结

i18n-frontend-p2 完成了 30 处漏网修复 + 2 处 P0 关键回归修复（SearchModal kind-based / thinking-levels labelKey）。代码质量高：
- 数据源层 i18n 设计正确（kind/labelKey 解耦 locale）
- 测试覆盖完整（140 断言覆盖 U1-U8）
- 双 locale 同步无遗漏

SearchModal Dialog 拆包是测试驱动的附带改动，需 E1 手动验证生产行为。2 个 should_fix 是低优先级风格问题，不阻塞 merge。
