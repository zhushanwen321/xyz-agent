---
verdict: pass
must_fix: 0
---

# Spec Review — Pi Extension Installation

## Summary

Spec 完整、边界清晰、验收标准可量化，无 MUST_FIX 问题。

## Issues Found

### 1. spec 完整性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 目标明确 | ✅ | "在 Settings 中提供三种 pi extension 安装方式，含 Collection 发现和 npm 体验优化" |
| 范围合理 | ✅ | In/Out of scope 均有明确边界 |
| 验收标准可量化 | ✅ | AC1-AC7 均可写测试验证 |
| [待决议]项 | ✅ | 无（所有设计问题已明确：normalizeExtName 方案A、临时目录、npm 错误分类） |
| 术语一致性 | ✅ | 未发现模糊术语 |

### 2. 项目架构约束一致性

| 约束 (来自 CLAUDE.md) | 检查结果 |
|----------------------|---------|
| 数据目录隔离 (~/.xyz-agent/ vs ~/.pi/) | ✅ C1 明确声明 |
| Plugin 与 Extension 分离 | ✅ Out of Scope 明确排除 Plugin 体系 |
| 前端复用 design system | ✅ C6 声明复用 ExtensionsPane.vue 样式 |
| emit 单 payload | ✅ 不涉及（WS 消息设计已定义单 payload 结构） |

### 3. 架构设计完整性

| 组件 | 覆盖情况 |
|------|---------|
| WS 协议扩展 | ✅ 明确列出新增消息类型和 payload 定义 |
| 数据流（含临时目录生命周期） | ✅ 完整端到端流程 |
| normalizeExtName 修改 | ✅ 精确到代码行 |
| 错误分类逻辑 | ✅ 优先级明确的 3 种错误类型 |

## Conclusion

verdict: pass。Spec 可以直接进入 Phase 2（plan）阶段。

不存在任何未解决问题。
