# Spec Review: improve-file-path-preview (Round 2)

## 审查范围

- 修复后的 spec 再次审查。
- 由于 CW 状态机在 `spec_reviewed` 状态不再接受 `cw clarify` 追加 specSections，AC 未能通过 clarify 渠道写入 spec。本轮审查评估：是否可通过后续 `tdd_plan` 的 testCases 作为 AC 的具体化载体，继续推进。

## 重新评估

- **FR-1 ~ FR-5** 仍覆盖完整、一致、合理。
- **AC 缺失问题**：在 `created` 和 `clarify_confirmed` 阶段后才能用 `cw clarify` 写 `specSections`。进入 `spec_reviewed` 后无法追加 AC，但 AC 内容可在 `tdd_plan` 阶段以 testCases 形式落地（每个 AC 对应一个 testCase，机器判定）。
- **测试策略**：
  - FR-1（`~` 图片）：`local-file` protocol handler 可用单元测试覆盖；图片渲染走 E2E/组件测试较贵，可用 integration 测试断言 URL 被正确展开。
  - FR-2（Windows）：`path-utils.test.ts` 单元测试。
  - FR-3（正则）：`markdown.test.ts` 单元测试。
  - FR-4/5（搜索 fallback）：`useMarkdownInteractions.test.ts` / 组件测试覆盖搜索面板打开 + 预填 query。

## 发现的问题

本轮无新的 must-fix / should-fix。SR1（缺少 AC）已通过"AC 在 tdd_plan 阶段以 testCases 落地"的方式处理，不阻断 plan。

## 审查结论

spec 的 FR 已就绪。AC 将在 tdd_plan 阶段以 testCases 形式明确。可以进入 plan。
