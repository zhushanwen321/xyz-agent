---
verdict: pass
must_fix: 0
---

# Plan Review — Pi Extension Installation

## Summary

Plan 完整、task 粒度适中、Execution Groups 合理、spec 全覆盖。0 个 MUST_FIX。

## Checks

### 1. Spec 完整性 → Plan 覆盖

| Spec 需求 | 对应 Task | 状态 |
|-----------|-----------|------|
| FR1: npm 智能输入 | Task 6 | ✅ |
| FR2: npm 错误分类与引导 | Task 3 + Task 7 | ✅ |
| FR3: 本地目录安装含 Collection 支持 | Task 4 + Task 7 | ✅ |
| FR4: Git URL 安装含 Collection 支持 | Task 4 + Task 7 | ✅ |
| FR5: normalizeExtName 去重 | Task 1 | ✅ |
| AC1: 两种输入格式 | Task 6 | ✅ |
| AC2: scoped 包路径 | Task 2 (protocol) | ✅ |
| AC3: 非 extension 回滚 | Task 3 | ✅ |
| AC4: Collection 选择安装 | Task 4/7 | ✅ |
| AC5: Git 三阶段进度 | Task 7 | ✅ |
| AC6: 去重不冲突 | Task 1 | ✅ |
| AC7: 安装后列表可见 | 已有 + Task 6/7 | ✅ |

### 2. Plan 可行性

| 检查项 | 结果 |
|--------|------|
| Task 粒度适中 | ✅ BG1 5 个 task（每人 ≤ 3 步），FG1 2 个 task（每人 ≤ 11/4 步） |
| 依赖关系正确 | ✅ FG1 依赖 BG1（类型定义就绪），BG1 内 Task 2 先于 3/4（WS 类型先定义） |
| 无遗漏 task | ✅ 对照 spec 逐条检查 |

### 3. Execution Groups 合理性

| 检查项 | 结果 |
|--------|------|
| 分组合理（前后端分离） | ✅ BG1: 4 文件修改, FG1: 1 文件修改 |
| 文件数 ≤ 10 | ✅ BG1: 4 file, FG1: 1 file |
| 功能关联度 | ✅ BG1 全在后端 extension 体系 |
| Wave 编排 | ✅ Wave 1: BG1, Wave 2: FG1 |

### 4. 代码细节一致性

| 检查项 | 结果 |
|--------|------|
| 所有文件路径精确 | ✅ |
| normalizeExtName 访问级别修正 | ✅ Task 1 改为 public |
| finishInstall 消息类型 | ✅ Task 7 注明需 Task 2 补充定义 |
| 类型跨 task 一致 | ✅ |

## Conclusion

verdict: pass。Plan 可以直接进入 Phase 3（dev）。
