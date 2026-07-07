# Handoff · settings · Provider

> Provider 菜单 · 左导航第 1 项 · settings modal **落地页**（默认进）。
> 配置 AI 模型供应商、API 凭据、模型清单、每模型的 thinking 策略。
> 字段与交互源自 `~/Code/xyz-agent-workspace/main/packages/renderer/src/components/settings/ProviderPane.vue` + `ProviderModal.vue` + `ProviderSection.vue` + `ModelRow.vue`。

## 1. 定位

- 主用模式：**C · Entity List**（供应商列表）+ 展开/Modal 内 **A · Setting Row**（key/url/默认模型）+ 模型子列表。
- Provider 是 modal 落地页：需同时演示三模式集成，给其余菜单定调。

## 2. 数据模型（字段）

```
ProviderInfo { id, name, api: 'anthropic-messages'|'openai-completions'|'ollama',
               baseUrl, apiKey/apiKeySet: bool, enabled: bool }
ModelInfo     { id, name, contextWindow: number,
               thinkingLevelMap: Record<…>,   // 策略 all-levels|on-off|high-max
               enabled: bool }
```

## 3. 布局

- page-header：`Provider` + 一句定位「配置 AI 模型供应商与 API 凭据。Key 本地加密存储，不出本机。」+ 右上「+ 添加供应商」按钮。
- 空状态：无 provider → 居中引导（虚线圆 + 标题 + 提示 + 「添加第一个供应商」）。
- 列表：每个供应商一个 Entity（模式 C）。
- Entity 展开后：key / 默认模型 / 连接 三行（模式 A）。

## 4. 关键交互（特异点）

- **列表行**：状态点（key 已设 + enabled？）+ name + `默认` pill（可选）+ 模型数 sub + 启用开关 + 展开箭头。
- **编辑 Modal**（点实体或「添加」打开）：
  - name / type select（Anthropic / OpenAI Compatible / …）/ baseUrl（anthropic → 默认 `https://api.anthropic.com`）/ apiKey（password，已设显 `••••••••`）/ 连接状态。
  - 「测试连接」按钮 → 结果行（ok 绿 / err 红 + 「找到 N 个模型」）。
  - 「自动发现模型」按钮 → 调 API 拉模型清单，合并进模型列表。
  - **模型列表行**：name（mono）+ contextWindow（静态/编辑态 select）+ **thinkingLevelMap 策略 pill 三档**：`all-levels`(All) / `on-off`(O/O) / `high-max`(H/M)，色编 binary=agent 色、highmax=accent。点行进入编辑态，pill 变可点分段。
  - 「手动添加模型」：name + ctx select + 默认 On/Off。
- **删除供应商**。

## 5. 校验（对齐 form-validation 规范：字段级 FormMessage / 表单级 toast）

- 字段级：新建必填 baseUrl + apiKey（ollama 除外）→ 缺项 FormMessage；key 格式不合法 → 字段级红字。
- 表单级：连接测试失败 / 自动发现错误 → inline status（loading/success/error/empty），不上 modal 级 toast。

## 6. 状态枚举

- 空（无 provider）/ 测试中 / 测试 ok·err / 发现中 / 发现空（「未找到模型」）/ 删除确认。

## 7. 验收 P0

- [ ] API key 加密显隐（password + 👁 toggle，已设显 `••••`）
- [ ] 测试连接有可见反馈（ok/err + 模型数）
- [ ] 模型 thinking 策略三档可选且色编正确
- [ ] 默认 provider 标记可见，新建会话遵循
- [ ] key 字段不外泄（真实加密属后端，本菜单只演示显隐交互）

## 8. 参考

- 现有 impl：`ProviderPane.vue` / `ProviderModal.vue` / `ProviderSection.vue` / `ModelRow.vue` / `composables/useProviderValidation.ts` / `useModelEditor.ts`
- 对齐：`PRODUCT.md` / `docs/page-design/design-system.md` / `~/.claude/rules/form-validation.md`

## 9. draft 细化说明（2026-06-19）

- **本菜单细化稿**：`draft-provider.html`（73KB，settings 最大最细）—— §1 供应商 Entity List（OpenAI/Anthropic/Google 真实名 + 模型清单）+ §2 编辑 Modal（key 显隐 password + 👁 toggle + 测试连接 inline 反馈 ok/err+模型数 + 自动发现模型）+ §3 模型行 thinking 策略三档 pill（all-levels·on-off·high-max，色编 binary=agent 色/highmax=accent）+ §4 字段表 + 连接/发现状态枚举。复用 shell token + 原语，全部可交互。
- handoff ↔ draft 对齐：§2 数据模型 = draft §4 字段表；§4 关键交互 = draft §2/§3；§7 验收 = draft 可交互样例。
