# 复盘 — default-prompt-reference

> Topic: `cw-2026-07-17-default-prompt-reference` · 2026-07-17

## 目标

解决 system-prompt-config topic 的遗留痛点：用户在 Settings 配置替换提示词时看不到 pi 默认提示词，无从参考。方案：替换卡下方加可折叠只读参考区，展示从 pi 源码提取的默认核心提示词。

## 执行过程

| 阶段 | 结果 |
|------|------|
| clarify | 3 条确认（展示形态/来源/文案要点），用户已预确认方案 |
| spec_review / plan_review | 自审通过（任务极简） |
| tdd_plan | 5 个红灯（2 常量 + 3 参考区 DOM） |
| dev | 2/2 wave，每个 wave 一个 subagent，一次通过 |
| review | 0 must-fix / 0 should-fix |
| test | 5/5 全绿 |

## 做得好的

- **从根因出发**：前一个 topic 做完系统提示词配置后，用户发现「不知道默认提示词是什么」——这是功能完整性的真实缺口，而非 bug。直接从 pi 源码提取固定段内置为常量，方案简单可靠。
- **pi 版本标注**：`DEFAULT_PI_SYSTEM_PROMPT_VERSION = '0.80.3'` 让未来 pi 升级时能快速 diff 检查这段硬编码提示词是否变化。

## 遗留风险

| 风险 | 严重度 | 状态 |
|------|--------|------|
| pi 升级改了默认提示词，内置常量过时 | medium | VERSION 标注 + retrospect 记录，升级时需人工 diff |
| `<pi package dir>` 占位符不是真实路径 | low | 参考区是只读展示用途，用户理解这是模板即可 |

## 总结

小而完整的增量。2 wave 5 文件 5 测试，一次通过。核心价值：用户现在能在 Settings 里看到 pi 默认提示词全文，对照参考后编写替换内容。
