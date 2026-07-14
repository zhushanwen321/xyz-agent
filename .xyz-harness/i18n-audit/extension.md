# Extension 模块 i18n 审计报告

## 审查时间
2026-07-14

## 审查范围

按子模块列出实际审查的文件：

- **components/extension/**
  - `ExtensionUIDialog.vue`
- **components/extension/ask-user/**
  - `AskUserOverlay.vue`（该目录下唯一的 .vue 文件）
- **扩展相关 composables**
  - `composables/useExtensionUI.ts`
  - `composables/extensionUI.ts` — **不存在**（仅 `useExtensionUI.ts` 存在；同名 locale 文件在 `i18n/locales/{zh-CN,en-US}/extensionUI.ts`）
- **locale 文件**（用于交叉对照）
  - `i18n/locales/zh-CN/extensionUI.ts`
  - `i18n/locales/en-US/extensionUI.ts`

## 总体结论
**PASS** —— Extension 模块的 i18n 覆盖完整，无漏网硬编码中英文用户可见字符串。所有用户可见的文案均通过 `t()` / `$t()` 调用提取并写入两个 locale 文件，键集严格对齐。

## locale keys 现状
- `extensionUI.ts`: zh-CN=8, en-US=8
- 共同 key: `other`、`customAnswerPlaceholder`、`inputPlaceholder`、`additionalComment`、`commentPlaceholder`、`unansweredHint`、`dialogTitle`、`selectPlaceholder`
- 键集 1:1 对齐，无缺失键。
- 公用 `common.*` 键（`common.cancel`、`common.confirm`、`common.next`、`common.submit`）由全局 locale 提供，未在本审计范围内检查，但 `ExtensionUIDialog.vue` 与 `AskUserOverlay.vue` 均按预期使用这些键。

## 漏网字符串清单

### `components/extension/ExtensionUIDialog.vue`
无漏网。所有用户可见位置均通过 `t()` 处理：

- L67 DialogTitle：`{{ req?.title || t('extensionUI.dialogTitle') }}`（`req?.title` 为 extension 推送的运行时数据，不属于源码硬编码）
- L73, L94, L114 Cancel 按钮：`t('common.cancel')`
- L74, L95, L115 Confirm 按钮：`t('common.confirm')`
- L81 SelectValue placeholder：`t('extensionUI.selectPlaceholder')`
- L68 DialogDescription：`{{ req.message }}`（来自 extension 推送数据）

### `components/extension/ask-user/AskUserOverlay.vue`
无漏网。所有用户可见位置均通过 `t()` 处理：

- L418 Other 选项 label：`{{ t('extensionUI.other') }}`
- L425 Other 输入框 placeholder：`t('extensionUI.customAnswerPlaceholder')`
- L440 自由文本 placeholder：`t('extensionUI.inputPlaceholder')`
- L446 评论标签：`{{ t('extensionUI.additionalComment') }}`
- L449 评论 placeholder：`t('extensionUI.commentPlaceholder')`
- L464 Cancel 按钮：`t('common.cancel')`
- L473 Next 按钮：`t('common.next')`
- L480 Submit 按钮 title：`allAnswered ? t('common.submit') : t('extensionUI.unansweredHint', { count: unansweredCount })`
- L483 Submit 按钮 label：`t('common.submit')`
- L276, L293, L310, L324, L333, L377, L382 等位置渲染的 `question`、`context`、`option.label`、`option.description` 均来自 props（extension 推送数据），不属于源码硬编码。

### `composables/useExtensionUI.ts`
无用户可见字符串。

- `useExtensionNotify` 内部将 extension 推送的 `message` 直接透传给 toast（`error(message)` / `warning(message)` / `info(message)`），但 `message` 是运行时数据，不属于源码硬编码。
- 文件中所有中文均位于 JSDoc/块注释中（`/** ... */`），不在审计范围内。

## 误报排除

以下项在初筛中曾出现中文/英文匹配，但最终判定为**误报**，不计入漏网：

1. **`ExtensionUIDialog.vue` L81** —— `"t('extensionUI.selectPlaceholder')"` 被扫描器识别为带英文的属性值字符串。实际是 `:placeholder="t('extensionUI.selectPlaceholder')"`，`attr="..."` 中是 Vue i18n 调用表达式，已国际化。
2. **`AskUserOverlay.vue` L358 / L360 / L406 / L408** —— 这些行的 `attr="..."` 实际是 `:model-value="isSelected(...)"` / `@update:model-value="toggleOption(...)"`，是 JS 函数调用绑定，扫描器误抓为属性值。已国际化/非用户可见。
3. **`AskUserOverlay.vue` L425 / L440 / L449 / L480** —— 同 L81，是 `:placeholder="t(...)"` / `:title="..."`，是 i18n 表达式，已国际化。
4. **`AskUserOverlay.vue` 中所有 Chinese 字符（L55, L57, L90–92, L130, L133, L138, L141, L256–257, L389, L420）** —— 全部位于 `//` 单行注释、`/** */` 块注释或 `<!-- -->` 模板注释中。不影响 UI 渲染，按规则排除。
5. **`useExtensionUI.ts` 中所有 Chinese 字符** —— 全部位于 JSDoc `/** */` 注释中（L1–18、L106–117 范围内的 `Extension UI 交互 composable`、`extension.ui_request`、`ExtensionTimeoutManager 5 分钟无响应` 等），按规则排除。

## 统计

- **漏网数**: 0
- **误报数**: 5（详见上节）
- **严重程度（用户频繁可见的高优先级）**: 0

## 关键发现 / 备注

- Extension UI 的"提问文本"和"选项 label/description"全部来自 extension 侧推送数据（runtime 通过 `extension.ui_request` WS 帧传入），不属于 renderer 源码硬编码，因此本审计不追溯 extension 内容。
- locale 文件键集完整对齐（zh-CN / en-US 各 8 键，1:1 对应），无悬空引用、无缺失键。
- `useExtensionNotify` 中的 toast `message` 是透传运行时数据，若需要本地化应在 extension 侧处理，不由 renderer i18n 覆盖。
- 跨模块公用 `common.cancel`、`common.confirm`、`common.next`、`common.submit` 引用本审计范围外的全局 locale，命名一致性良好。