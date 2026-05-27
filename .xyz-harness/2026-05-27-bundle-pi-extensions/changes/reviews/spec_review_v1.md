---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-28T10:30:00"
  target: ".xyz-harness/2026-05-27-bundle-pi-extensions/spec.md"
  verdict: fail
  summary: "计划评审完成，第1轮，1条MUST FIX，需修改后重审"

statistics:
  total_issues: 2
  must_fix: 1
  must_fix_resolved: 0
  low: 0
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-1"
    title: "缺少目标目录结构说明，shared/logger.ts 相对 import 路径可能断裂"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: INFO
    location: "spec.md:AC-1"
    title: "AC-1 验证方式依赖人工检查 console 输出"
    status: open
    raised_in_round: 1
    resolved_in_round: null

verdict: fail
must_fix: 1
---

# 计划评审 v1

## 评审记录

- 评审时间：2026-05-28 10:30
- 评审类型：计划评审（spec 完整性）
- 评审对象：`.xyz-harness/2026-05-27-bundle-pi-extensions/spec.md`

## 检查维度：spec 完整性

### 目标明确性 — ✅ 通过

目标明确：将 6 个 pi extension（goal/todo/subagent/workflow/usage-tracker/hooks）+ shared/logger.ts 内置到 xyz-agent 项目中，完成 wiring 和构建配置。一句话能说清。

### 范围合理性 — ✅ 通过

范围定义清晰：
- 包含：6 个 extension + 1 个共享模块 + SessionService 适配 + 构建配置 + gitignore
- 不包含：evolution-engine（有明确排除理由）
- 边界明确（Constraints 章节），FR-1 到 FR-5 逐条定义，无歧义

### 验收标准可量化 — ⚠️ 基本通过

| AC | 可量化性 | 说明 |
|----|---------|------|
| AC-1 | 部分可量化 | "无 extension 加载错误" 可检查 console，但未定义"错误"的精确含义（stderr 输出？RPC error code？）。无自动化验证手段建议 |
| AC-2 | 可量化 | 可通过前端检查斜杠命令菜单 + 渲染器是否正确展示 |
| AC-3 | 可量化 | 可通过检查文件系统确认日志写入路径 |
| AC-4 | 可量化 | 构建成功可验证，同步幂等性可验证 |
| AC-5 | 可量化 | 可通过 git add --dry-run 验证 |

### [待决议] 项 — ✅ 无

未发现任何 `[待决议]` 标记。FR 和 AC 均为 adopted 状态。

## 横切检查

### 项目架构约束合规性

对照 `CLAUDE.md` 关键规则逐项检查：

| CLAUDE.md 规则 | 合规 | 说明 |
|---------------|------|------|
| 规则 10: xyz-agent 与 pi 数据隔离 | ✅ | FR-2 明确修改 logger 路径，Decisions 第 1 条明确排除 `~/.pi/` 访问 |
| 规则 4: 外部系统对接先验证再编码 | ✅ | 未违反，spec 属需求层 |
| 规则 5: pi 适配层不信任外部格式 | ✅ | Extension 通过 `--extension` CLI 参数注入，不走自动发现 |
| 规则 7: Session 隔离 | ✅ | 不涉及 session 消息路由变更 |

### Spec 内部一致性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| FR 与 AC 对应关系 | ⚠️ | FR-1 对应的 AC 缺少对 shared/logger.ts 目录结构位置的验证 |
| Decisions 与 FR 一致 | ✅ | Decisions 5 条全部与 FR 对应 |
| Constraints 无遗漏 | ✅ | 数据隔离/Extension 不可修改/pi 启动参数/jiti 加载/技术栈 全部覆盖 |

## 发现的问题

### 1. MUST FIX — FR-1 缺少目标目录结构说明

| 字段 | 内容 |
|------|------|
| **位置** | `spec.md:FR-1` |
| **问题** | FR-1 要求将 6 个 extension 源码和 `shared/logger.ts` 复制到 `src-electron/resources/pi/agent/extensions/`，但**未描述复制后的目标目录结构**。subagent 和 usage-tracker 通过 `../shared/logger` 相对路径引用 `shared/logger.ts`（Decisions 第 4 条证实 shared/ 是"相对 import 目标"）。如果复制时只拷贝 extension 目录内容而未保持 shared/ 在兄弟层级，import 路径会断裂，导致 subagent 和 usage-tracker 加载失败。 |
| **影响** | Extension 加载失败 → 功能不可用（数据丢失 + 功能失效，符合校准规则 MUST FIX 条件 #2） |
| **修改方向** | 在 FR-1 下方明确说明目标目录结构，例如：<br>`src-electron/resources/pi/agent/extensions/` 下应保持与原仓库一致的目录布局，即 `shared/` 与各 extension 目录同级。可提供一份目录树示意。 |

### 2. INFO — AC-1 缺乏自动化验证建议

| 字段 | 内容 |
|------|------|
| **位置** | `spec.md:AC-1` |
| **问题** | "pi 启动时无 extension 加载错误" 目前只能通过人工观察 console 输出来验证。未定义什么是"错误"（stderr 输出/pi RPC error/crash？），也未提供自动化验证建议。 |
| **影响** | 低。不影响功能实现，仅影响测试效率和验收精确度。 |
| **建议** | 建议补充自动化验证方式，如：通过 pi RPC 调用获取已注册的工具列表，确认 `goal_manager`/`todo`/`subagent`/`analyze_image` 均存在。或在 spec 中注明"依赖于工观察 console"。 |

## 结论

**需修改后重审**。1 条 MUST FIX 待解决。

### Summary

计划评审完成，第1轮，1条MUST FIX需修改后重审。核心问题是 spec 未明确描述 extension 源码复制后的目标目录结构，导致 shared/logger.ts 的相对 import 路径存在断裂风险。
