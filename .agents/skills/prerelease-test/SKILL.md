---
name: prerelease-test
description: >-
  Use when you need to test Electron build artifacts (DMG/EXE/AppImage)
  locally before an official release, or when the user says "发测试版",
  "构建测试 DMG", "生成测试包", "pre-release test", "beta release",
  "draft release", "测版". Only for xyz-agent project.
  Not for official releases — use merge skill instead.
---

# prerelease-test

## 概述

创建 `-beta.N` 后缀的预发布版本，触发 CI 构建产物（DMG/EXE/AppImage），
供本地安装测试。测试通过后自动还原代码版本号，不占用正式版本号。

## 核心流程

1. 确认工作区干净（可在 main 或开发分支运行）
2. 从最新正式 release 计算 beta 版本（自动递增序号）
3. 临时 bump 版本号 + commit + tag + push → 触发 CI
4. 轮询 CI 直到 Release 创建完成
5. 验证产物完整性（dmg + exe + AppImage）
6. **用户确认测试通过后**，还原代码版本，删除 beta tag 和 release

## AI 操作步骤

### [MANDATORY] 1. 执行预发布脚本

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/main
bash scripts/prerelease-test.sh
```

脚本会自动依次执行所有阶段。AI 只需执行这一步，等待脚本完成。

**脚本 exit 0 前不得宣布"已完成"。** 脚本内部已包含 CI 轮询和产物验证，
只有所有检查通过才会到达阶段 6 的用户确认提示。

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 手动 `npm version` + `git tag` + `git push`，然后说"已推送，CI 会构建" | 运行 `bash scripts/prerelease-test.sh`，等脚本自己完成 |
| 脚本还在跑 CI 轮询就 Ctrl+C 或说"CI 应该没问题" | 必须等脚本 exit 0，失败了修修复后重跑 |
| 跳过产物验证直接说"产物应该生成了" | 脚本会自动验证 dmg/exe/AppImage 存在，等它输出结果 |

### [MANDATORY] 2. 产物下载和测试指导

脚本阶段 5 完成后会输出产物链接。用户需要：
- macOS: 下载 `.dmg`，拖入 Applications 安装测试
- Windows: 下载 `.exe` 安装测试
- Linux: 下载 `.AppImage` 运行测试

### [MANDATORY] 3. 确认还原

脚本阶段 6 会询问"测试通过？输入 yes 还原版本"。
AI 必须等待用户明确确认后再输入 `yes`。

### [OPTIONAL] 4. CI 失败时的处理

如果 CI 失败，脚本会自动还原版本。AI 应：
1. 打开 CI 链接查看失败日志
2. 修复问题后重新运行脚本（会自动递增 beta 序号，如 `-beta.2`）

## 版本命名

| 操作 | 版本号 | 说明 |
|------|--------|------|
| 初始状态 | 代码 `0.4.6`，release `v0.4.6` | 最新正式版 |
| Bump 后 | 代码 `0.4.7-beta.1`，tag `v0.4.7-beta.1` | 测试版 |
| 还原后 | 代码 `0.4.6`，tag 已删除 | 回到初始状态 |
| 正式发布 | `v0.4.7` | 不受测试版影响 |

## 常见问题

- **Q: 为什么要用 `-beta.N` 而不是直接 bump？**
  直接 bump 会占用 `v0.4.7` 的 tag，导致正式发布时版本号被跳过。

- **Q: 多次测试迭代怎么处理？**
  脚本自动检测已有 beta 版本并递增序号，如 `v0.4.7-beta.1` → `v0.4.7-beta.2`。

- **Q: 测试版是否影响正式发布？**
  不影响。版本校验（`scripts/check-version-bump.sh`）只比较正式 release，
  忽略所有 prerelease（测试版）。

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
