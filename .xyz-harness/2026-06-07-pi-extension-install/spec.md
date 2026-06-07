---
verdict: pass
---

# Pi Extension Installation — Settings UX 设计

## Background

xyz-agent 使用 pi 作为 AI agent 引擎。Pi 支持通过 `--extension` CLI 参数加载扩展。目前 xyz-agent 的 `ExtensionService` 已支持：

- **npm 来源** (`npm:pi-xxx`) — `npm install` 到 `~/.xyz-agent/pi/agent/npm/`，注册到 `settings.json packages[]`
- **五源扫描** (`ExtensionResolver`) — npm > user > settings > third-party > bundled
- **传递进 pi** — `session-service.ts` → `getExtensionPaths()` → `--extension <path>` 参数

但缺少本地目录安装和 Git URL 安装，且 npm 安装的用户体验需优化（输入格式不灵活、缺少错误引导）。

## Functional Requirements

### FR1: npm 安装 — 智能输入

用户可在 Extension 设置页输入 npm 包名安装 pi 扩展。系统应自动适配以下输入格式：

- 纯包名: `pi-subagents` → 自动识别为 `npm:pi-subagents`
- Scoped 包: `@zhushanwen/pi-goal` → 自动添加 `npm:` 前缀
- 传统格式: `npm:pi-ask-user` → 保持原样

### FR2: npm 安装 — 错误分类与引导

当 npm 安装失败时，按错误类型显示不同的引导信息：

| 错误类型 | 检测方式 | 用户提示 |
|---------|---------|---------|
| 包不存在 (404) | npm install stderr 含 404 / E404 | 检查拼写、scope、registry |
| 非 pi 扩展 | npm install 成功但 isValidPiExtension 失败 → rollback | 检查 pi manifest 字段 |
| 网络/权限错误 | npm install 异常退出 (ETIMEOUT/EACCES) | 检查网络和 npm config |

安装失败时自动 `npm uninstall` 回滚。

### FR3: 本地目录安装（含 Collection 支持）

用户提供本地路径，系统扫描并展示其中发现的所有 pi 扩展，由用户选择安装。

流程：
1. 用户选择/输入路径
2. 系统复制到临时目录 `~/.xyz-agent/pi/agent/tmp/ext-scan-{timestamp}/`
3. 递归扫描，发现所有满足 `isValidPiExtension()` 的子目录
4. 前端展示列表（名称、版本、描述），用户勾选
5. 确认后将选中的扩展 `cp -r` 到 `~/.xyz-agent/pi/agent/extensions/{name}/`
6. 清理临时目录

### FR4: Git URL 安装（含 Collection 支持）

用户提供 Git 仓库 URL（GitHub / GitLab / 自建），流程与 FR3 类似但增加克隆阶段：

1. 用户输入 URL
2. 系统显示 Clone 进度（Clone → Scan → Select 三阶段）
3. `git clone --depth 1 <url> ~/.xyz-agent/pi/agent/tmp/ext-scan-{timestamp}/`
4. 如有 `package.json`，运行 `npm install` 安装依赖
5. 扫描发现 pi 扩展列表
6. 用户选择 → 安装 → 清理

支持输入格式：
- `github:user/repo`
- `https://github.com/user/repo.git`
- `git@github.com:user/repo.git`
- `ssh://git@github.com/user/repo`

### FR5: normalizeExtName 去重修复

当前 `normalizeExtName()` 去掉了 scope，导致 `@scope1/pi-goal` 和 `@scope2/pi-goal` 冲突。改为保留 scope 前缀，仅去掉 `pi-` 前缀：

```typescript
// @zhushanwen/pi-goal → @zhushanwen/goal
// pi-subagents → subagents
```

## Acceptance Criteria

1. **AC1**: 用户输入 `pi-subagents` 或 `npm:pi-subagents` 均可成功安装 pi 扩展
2. **AC2**: scoped 包 `@zhushanwen/pi-goal` 安装后路径解析正确，settings.json 中记录 `npm:@zhushanwen/pi-goal`
3. **AC3**: 安装非 pi 扩展（如 `lodash`）时显示明确错误提示，自动回滚
4. **AC4**: 选择包含 3 个扩展的本地目录，扫描后展示列表，用户勾选 2 个，仅这 2 个被安装
5. **AC5**: Git URL 安装显示 Clone→Scan→Select 三阶段进度，Collection 支持与 AC4 一致
6. **AC6**: `normalizeExtName` 去重 key 保留 scope 信息，`@scope1/pi-goal` 和 `@scope2/pi-goal` 互不冲突
7. **AC7**: 安装后的扩展出现在 Extension 列表，可 toggle 启用/禁用，可 uninstall

## Constraints

1. **C1**: 数据目录隔离 — ## Out of Scope

以下需求不在本 spec 范围内，后续阶段单独评估：

- **Pi 的 `pi install` CLI 命令的重新实现** — xyz-agent 只在 Settings UI 中提供安装功能，不复制 pi 的命令行接口
- **Extension 的自动更新检查** — 当前只做安装，版本更新由用户手动操作
- **Extension 的依赖冲突检测** — 假设 npm 的依赖解析和 peerDep 检查足够
- **Extension 的 Hot Reload** — 安装后需要重启 session 或使用 pi 的 `/reload` 命令
- **xyz-agent Plugin 安装** — Plugin 体系（Worker Thread、`xyzAgent` manifest）已有自己的安装器（`PluginInstaller`），不在本设计范围内

## Constraints `~/.xyz-agent/pi/agent/` 下，不得读写 `~/.pi/`
2. **C2**: npm 安装目录沿用现有结构: `~/.xyz-agent/pi/agent/npm/node_modules/<pkg>/`
3. **C3**: 本地/Git 安装统一到扩展目录: `~/.xyz-agent/pi/agent/extensions/<name>/`（已由 `scanThirdPartyExtensions()` 自动扫描）
4. **C4**: 临时目录: `~/.xyz-agent/pi/agent/tmp/ext-scan-{ts}/`，安装完成后清理
5. **C5**: extension 去向 pi 的路径不变 — 仍通过 `--extension <path>` CLI 参数传入
6. **C6**: 前端 UX 复用现有 design system 样式（`ExtensionsPane.vue` 的 section-group 视觉风格）

## Complexity Assessment

中等复杂度。涉及 3 个子系统：

| 子系统 | 涉及文件 | 复杂度 |
|--------|---------|--------|
| 共享协议 | `shared/src/protocol.ts` | 低 — 新增 2 个消息类型 |
| 后端 (Runtime) | `extension-service.ts`, `server.ts` | 中 — 新增 installDir/installGit 方法 + 临时目录管理 |
| 前端 (Renderer) | `ExtensionsPane.vue` | 中 — 3-tab 安装 UI + 发现列表 + 错误引导面板 |

## 架构设计

### 数据流

```
Frontend (ExtensionsPane.vue)
  │ WS: extension.installDir { path }
  │ WS: extension.installGit { url }
  ▼
runtime/server.ts
  │ => ExtensionService.installLocalDirectory(path)
  │ => ExtensionService.installGitRepository(url)
  ▼
ExtensionService
  ├── npm:   npm install → npm/node_modules/
  │         → validate → rollback on fail → settings.json
  ├── local: cp -r → tmp/ext-scan-{ts}/
  │         → discover → user selects → cp → extensions/<name>/
  │         → cleanup tmp
  └── git:  git clone → tmp/ext-scan-{ts}/
            → npm install deps → discover → user selects
            → cp → extensions/<name>/ → cleanup tmp
  ▼
ExtensionResolver (next resolve())
  └── scanThirdPartyExtensions() 自动发现 extensions/<name>/
  ▼
session-service → getExtensionPaths() → --extension args
  ▼
pi Agent → jiti loader → extension activated
```

### WS 协议扩展

```typescript
// 新增 ClientMessageType
'extension.installDir'  // payload: { path: string }
'extension.installGit'  // payload: { url: string }

// 新增 ServerMessageType
'extension.discovered'  // payload: { candidates: ExtensionInfo[], tempDir: string }
'extension.installProgress'  // payload: { phase: 'clone'|'scan'|'install', status: 'running'|'done'|'error' }
```

### normalizeExtName 修改

```typescript
// extension-resolver.ts
private normalizeExtName(name: string): string {
  // 保留 scope，仅去掉 pi- 前缀
  // @zhushanwen/pi-goal → @zhushanwen/goal
  // pi-subagents → subagents
  const parts = name.split('/')
  const last = parts[parts.length - 1].replace(/^pi-/, '')
  if (parts.length > 1) {
    return parts.slice(0, -1).join('/') + '/' + last
  }
  return last
}
```

### 错误引导设计

npm 安装失败时，ExtensionService 按以下优先级判断错误类型：

1. npm stderr 含 `404 Not Found` / `E404` → "Package not found"
2. `isValidPiExtension()` 返回 false → "Not a pi extension"（自动 rollback）
3. 其他 npm 异常 → "Network / npm error"

每种错误类型对应一组建议，从 frontend 硬编码或从后端透传。

## ADR 评估

以下决策需要记录：

| 决策 | 满足三条件？ | 需要 ADR？ |
|------|------------|-----------|
| 本地/Git 安装统一到 extensions/ 目录而非单独子目录 | 扫描代码零改动，但未来切换目录结构需改所有路径引用 | 否 — 决策简单，可逆 |
| normalizeExtName 保留 scope 信息 | 冲突修复方案选择，可逆（改回不保留 scope 即可） | 否 |
| 临时目录流程（clone→发现→选择→安装→清理） | 架构决策，临时目录生命周期管理需明确 | **是** — 见 ADR 0017 |
| npm 安装立即校验+回滚（而非 pi 的延迟发现策略） | 影响用户体验，更改需前后端协同修改 | 否 — 与 pi 行为差异已有明确理由 |

### ADR 0017: 临时目录用于 Collection 扩展发现

**Decision**: 使用临时目录 `~/.xyz-agent/pi/agent/tmp/ext-scan-{ts}/` 作为本地/Git 安装的中转站。所有操作在此完成（复制/克隆、扫描、依赖安装），用户选择后 `cp -r` 到最终 `extensions/` 目录。安装完成后清理临时目录。

**Rationale**: 
- 避免部分安装导致 `extensions/` 目录下出现不完整扩展
- 支持用户取消操作（取消时只清理临时目录，不影响现有扩展）
- 临时目录的生命周期由单个安装操作绑定，不存在竞争条件

**Alternatives considered**:
- 直接安装到 `extensions/` 再回滚：回滚逻辑复杂，无法干净处理 Collection 中部分安装成功、部分失败的场景
