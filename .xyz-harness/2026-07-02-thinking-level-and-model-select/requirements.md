---
verdict: pass
---

# 思考等级映射 + 模型选择联动 · 业务需求

## 1. 业务目标

### G1: 模型选择器在任意态（landing/active session）可用且生效
- **landing 态（无 session）选模型后**，显示立即跟随；首发提交 create session 后 apply
- **active session 切模型后**，思考等级自动适配新模型的可用档位

### G2: 思考等级 popover 只显示当前模型配置的档位
- 不可用档位不显示（非灰显）
- 切模型后自动选最高可用档（若当前档不在新模型可用集）

### G3: thinkingLevelMap 的 key/value 语义对齐 pi 官方
- key = pi 档位名（off/minimal/low/medium/high/xhigh），前端直接发 key 给 pi
- value = provider 实际值，pi 内部 provider 层自查 map 取 value 发给 API
- 前端不做 key→value 映射（pi 自己做）

## 2. 用例

### UC-1: landing 态选模型 + 选思考等级 → 发消息
1. 新建任务页，默认模型 A（high-max: off/high/max）
2. 点模型选择器，切到 B（on-off: off/high）
3. 思考等级显示从「最高」自动变为「高」（on-off 最高可用档）
4. 点思考等级 popover，只显示「关」「开」（on-off 的 off + high，label 动态）
5. 发消息 → create session → apply pendingModel + pendingThinkingLevel → pi 收到正确 model + level

### UC-2: active session 切模型 → 思考等级自动重置
1. session 使用 A 模型（high-max），thinkingLevel=xhigh（max 档的 value）
2. 切到 B 模型（on-off: off/high）
3. xhigh 不在 on-off 可用档（off/high）→ 自动重置为 high（on-off 最高档）
4. popover 高亮「开」（high 在 on-off 模式 label 为「开」）

## 3. 约束&不做
- **不做**：前端做 key→value 映射（pi 自己做，前端越权会导致 pi 存错值）
- **不做**：popover 显示全 6 档 + 灰显不可用（只显示可用的，UX 更干净）
- **不做**：前端自造 pi 不存在的档位名（max 不在 pi ThinkingLevel 枚举）
