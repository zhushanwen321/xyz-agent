# Plan Review: message-content-segments

## 审查范围

审查 dev-plan.json 的 6 个 Wave：依赖关系、文件覆盖、AC 映射、粒度。

## Wave 依赖链

```
W1 (shared 类型+函数)
├── W2 (composer DOM 解析)
├── W3 (send 链路) ← 依赖 W1+W2
├── W4 (pi 回返解析)
├── W5 (渲染层) ← 依赖 W1+W3+W4
└── W6 (mock+测试) ← 依赖全部
```

依赖链合理：W1 是基础，W2/W4 可并行（互不依赖），W3 依赖 W2（send 需要 DOM 解析），W5 依赖 W3+W4（渲染需要 send 链路和 pi 回返都改好），W6 收尾。

## AC 映射检查

| Wave | 覆盖 AC | 缺失 AC |
|------|---------|---------|
| W1 | AC-1.1/1.2/3.1/3.2/7.1/7.2 | — |
| W2 | AC-2.1/2.2/2.3/2.4/2.5/2.6 | — |
| W3 | AC-3.3/5.1/5.2 | — |
| W4 | AC-4.1/4.2/4.3 | — |
| W5 | AC-6.1/6.2/6.3/6.4/7.3 | — |
| W6 | AC-1.3/8.1/8.2 | — |

所有 26 个 AC 都有对应 Wave。无遗漏。

## 粒度检查

- W1 改 3 文件（shared 层），粒度合理
- W3 改 4 文件（send 链路），是本任务最大 Wave——但 4 个文件紧密耦合（签名变更传导），不宜拆分
- 其余 Wave 1-2 文件，粒度合适

## 风险点

1. **W3 改 4 文件**是最大风险面：Composer.vue（draft 类型变更）→ useChat.ts（签名）→ chat.ts（store）→ chat.ts（API）。签名变更会传导，需要一次全改。
2. **W5 删除 skillChip/slashChip**：需要确认 Turn.vue 里所有读这两个 computed 的地方都适配。
3. **W6 mock 数据批量改**：约 11+ 处，体力活但需仔细。

## 审查结论

plan 质量良好，Wave 拆分合理，AC 全覆盖，依赖链无环。可以进入 tdd_plan。
