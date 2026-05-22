---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-22T21:38:00"
  target: ".xyz-harness/2026-05-22-pixyz-agent-1-windowsmaclinux-2-xyz-agentpi/spec.md"
  verdict: fail
  summary: "Spec 评审完成，第1轮，1条 MUST FIX，需补充 [待决议] 标记后重审"

statistics:
  total_issues: 6
  must_fix: 1
  must_fix_resolved: 0
  low: 2
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-1 + FR-8"
    title: "Windows binary .exe 后缀未标记为 [待决议]"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "spec.md:FR-8"
    title: "pi binary 版本来源未指定"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "spec.md:FR-1 + Constraints"
    title: "6 平台描述与 3 平台约束的 scope 歧义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: INFO
    location: "spec.md:FR-4"
    title: "process.cwd() 等于 resourcesPath 是未验证的假设"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: INFO
    location: "spec.md:FR-5"
    title: "buildProviderEnv() 引用未验证是否已存在"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "spec.md:FR-7"
    title: "Git submodule CI 认证和 clone 策略未说明"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-22 21:38
- 评审类型：Spec Review（计划评审的子集，因 plan.md 尚不存在）
- 评审对象：`.xyz-harness/2026-05-22-pixyz-agent-1-windowsmaclinux-2-xyz-agentpi/spec.md`

---

## 按方法论逐项审查

### 1. 目标是否明确（一段话能说清楚要做什么）

**结论：✅ 通过**

Background 章节清晰定义了当前问题（pi 作为外部 npm 依赖带来 3 个痛点）和解决方案（打包 pi Bun binary + extension/skill 到 Electron extraResources）。目标可以用一句话概括："将 pi binary + 预装 extension/skill 打包进 xyz-agent 安装包，实现开箱即用。"

### 2. 范围是否合理（不过大不过小，有明确边界）

**结论：✅ 通过**

9 个 FR 覆盖了从 binary 下载、extension/skill 打包、运行时发现、CI 构建到本地开发脚本的完整链路。Out of Scope 段落清晰划定了不包含的内容（自动更新、自定义 extension 管理、settings 迁移等），边界明确。

### 3. 验收标准是否可量化（能写测试验证而非模糊描述）

**结论：✅ 通过**

所有 AC（AC-1 ~ AC-7）都是可测试的：

| AC | 验证方式 | 可量化？ |
|----|---------|---------|
| AC-1 | 打包后发送消息确认 AI 回复 | 明确 |
| AC-2 | 发送 `/subagent`/`/goal` 确认加载 | 明确 |
| AC-3 | 使用任一 xyz-harness skill 确认触发 | 明确，但 19 个 skill 建议至少抽样覆盖 |
| AC-4 | GitHub Release 产物正常上传 | 明确 |
| AC-5 | `npm run dev` 正常工作 | 明确 |
| AC-6 | 有系统 pi 时使用 bundled 版本 | 明确 |
| AC-7 | 配置 provider 后 API 调用正常 | 明确 |

> 注：AC-3 的"使用任一 skill"存在抽样风险——如果只有个别 skill 因为加载路径问题不可用，而刚好测试了另一个可用 skill，会遗漏问题。建议改为 "AC-3b: xyz-harness 全部 19 个 skill 均在 pi skill list 中可见"。这不是 MUST FIX，是计划阶段可细化的点。

### 4. 是否标记了 `[待决议]` 项（如有，评估风险）

**结论：❌ 有未标记的待决议项**

Spec 中存在至少 2 个已知但不明确的项，**均未使用 `[待决议]` 标记**：

#### 问题 1：Windows binary .exe 后缀（MUST FIX）

FR-1 中写："Windows binary 可能带 `.exe` 后缀（需确认解压后实际文件名）"

这是一个已知未知——如果实际文件名为 `pi-windows-x64.exe`，但 CI 脚本下载的是 `pi-windows-x64`（无后缀），Windows 构建会失败：
- `gh release download ... -p "pi-windows-x64.*"` 可能匹配不到
- 即使下载成功，`chmod +x` 对 `.exe` 文件非必需但无害
- 如果 CI 直接使用 `fs.chmodSync` 或 `chmod`，且没有处理 `.exe` 后缀，spawn 时可能找不到文件路径

**影响评估**：Windows CI 构建失败 → AC-4 不通过 → Windows Release 产物缺失。属于"功能失效"级别。

**修复方向**：在 FR-1 或 FR-8 的对应位置添加 `[待决议]` 标记，明确：
1. 需验证 `pi-windows-x64.exe` 的实际文件名
2. CI 脚本需处理带/不带 `.exe` 后缀两种情况
3. 在 plan 阶段 resolve 此决议项

#### 问题 2：pi binary 版本来源未指定（LOW）

FR-8 使用 `gh release download v{VERSION}`，但未定义 `VERSION` 来自何处：
- 硬编码为常量？
- 环境变量？
- 配置文件中读取？
- 与 xyz-agent 版本联动？

**影响评估**：CI 脚本实现者需要自行决定版本策略，可能导致不同平台使用不同版本、版本不匹配等问题。但不会直接导致构建失败（因为实现者可以选择合理策略），所以归为 LOW。

**修复方向**：在 FR-8 中添加 `[待决议]` 标记，说明 VERSION 的来源策略待定。

---

## 其他发现

### LOW：6 平台 vs 3 平台 scope 歧义

FR-1 描述 "3 平台 6 架构全覆盖"（darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-arm64, windows-x64），但 Constraints 表格中支持平台为 "macOS arm64, Windows x64, Linux x64"（仅 3 种）。

这本身不是矛盾（pi 提供 6 种 variant，xyz-agent 只打包其中 3 种），但可能让实现者困惑：
- electron-builder 目前只配置了 macOS arm64 + Windows x64 + Linux x64
- FR-1 提到 "6 架构" 容易让读者以为需要 6 个 CI pipeline

**建议**：在 Constraints 表格后加一句话："CI 构建矩阵与当前 electron-builder 配置一致，每个 Job 仅下载对应平台的 pi binary。"

### INFO：process.cwd() 等于 resourcesPath 是未验证的假设

FR-4 的核心约束是 "打包后 Sidecar 的 cwd = process.resourcesPath"。但该行为由 `runtime-manager.ts` 设置，本 spec 未确认该文件是否已实现此功能，也未将其作为本 feature 的 task。

- 如果 `runtime-manager.ts` 已经设置了 cwd → 无需额外工作
- 如果未设置 → 需要修改 `runtime-manager.ts` 或调整 binary 查找逻辑

**建议**：在 plan 阶段验证 `runtime-manager.ts` 当前行为，如果尚未设置 cwd，则将此项加入 plan task。

### INFO：buildProviderEnv() 引用未验证

FR-5 引用 `buildProviderEnv()` 作为环境变量注入函数，但：
- 该函数是否已存在？
- 参数签名是什么？
- 是否需要修改以适配 pi 的环境变量格式？

**建议**：plan 阶段定位 `buildProviderEnv()` 的实际位置，确认其签名和当前行为。

### INFO：Git submodule CI 认证和 clone 策略未说明

FR-7 添加 vendor/ 子模块，但未说明：
1. `xyz-pi-extensions` 和 `xyz-harness` 仓库是公开还是私有？
2. CI 中是否需要 `GITHUB_TOKEN` 或 deploy key 来 clone 私有仓库？
3. `actions/checkout` 是否需要 `submodules: recursive`？

---

## 结论

**需修改后重审**。1 条 MUST FIX（Windows binary .exe 后缀未标记为 `[待决议]`），需修复后进入下一轮评审。

## Summary

Spec 评审完成，第1轮，1条 MUST FIX，需补充待决议标记后重审。
