---
verdict: pass
complexity: L1
---

# Bundle Pi Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire 6 pi extensions (goal/todo/subagent/workflow/usage-tracker/hooks) into xyz-agent so their tools are available to the LLM and their output is rendered in the GUI.

**Architecture:** Extensions are bundled as TypeScript source files under `src-electron/resources/pi/agent/extensions/`. SessionService discovers their `index.ts` entry points and passes them to pi via `--extension <path>` CLI args. Pi's jiti loader compiles TS at runtime. In production, `migrateToPiSubdir()` copies bundled extensions from the app's Resources to `~/.xyz-agent/pi/agent/extensions/`.

**Tech Stack:** TypeScript, Node.js fs/path, pi ExtensionAPI, jiti TS compiler

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/resources/pi/agent/extensions/shared/logger.ts` | modify | BG1 | 修复日志路径：读 PI_CODING_AGENT_DIR 环境变量 |
| `src-electron/resources/pi/agent/extensions/evolution-engine/` | delete | BG1 | 删除不需要的 extension（14 个文件） |

No new files to create. No frontend changes. The wiring code (session-service.ts, .gitignore, pi-config-bridge.ts, electron-builder.yml) is already in place from prior work.

---

## Task List

### Task 1: Fix shared/logger.ts log directory path

**Type:** backend

**Files:**
- Modify: `src-electron/resources/pi/agent/extensions/shared/logger.ts:33`

**Context:** FR-2, AC-3. Logger hardcodes `join(homedir(), ".pi", "agent", "logs")`. Must read `PI_CODING_AGENT_DIR` env var to respect xyz-agent's data directory isolation (`~/.xyz-agent/pi/agent/`).

- [ ] **Step 1: Modify LOG_DIR computation**

Replace the hardcoded LOG_DIR constant (line 33) with env-var-aware logic:

```typescript
const LOG_DIR = join(
  process.env.PI_CODING_AGENT_DIR
    ? join(process.env.PI_CODING_AGENT_DIR, 'logs')
    : join(homedir(), ".pi", "agent", "logs")
);
```

This preserves backward compatibility: if `PI_CODING_AGENT_DIR` is not set (pi CLI mode), logs go to `~/.pi/agent/logs/` as before.

- [ ] **Step 2: Verify the change**

Run: `grep "LOG_DIR" src-electron/resources/pi/agent/extensions/shared/logger.ts`
Expected: single line showing `PI_CODING_AGENT_DIR` fallback

- [ ] **Step 3: Commit**

```bash
git add src-electron/resources/pi/agent/extensions/shared/logger.ts
git commit -m "fix: logger path reads PI_CODING_AGENT_DIR for xyz-agent isolation"
```

### Task 2: Remove evolution-engine extension

**Type:** backend

**Files:**
- Delete: `src-electron/resources/pi/agent/extensions/evolution-engine/` (14 files)

**Context:** FR-1 specifies 6 extensions. evolution-engine was copied but should not be bundled (CLI interactive self-improvement, not suitable for xyz-agent server-mode). getExtensionPaths() already skips directories without `index.ts` — but evolution-engine HAS an `index.ts`, so it would be loaded unless removed.

- [ ] **Step 1: Delete evolution-engine directory**

```bash
rm -rf src-electron/resources/pi/agent/extensions/evolution-engine
```

- [ ] **Step 2: Verify removal**

Run: `ls src-electron/resources/pi/agent/extensions/`
Expected: `goal  hooks  shared  subagent  todo  usage-tracker  workflow` (7 directories, no evolution-engine)

- [ ] **Step 3: Commit**

```bash
git add -u src-electron/resources/pi/agent/extensions/evolution-engine/
git commit -m "chore: remove evolution-engine (not bundled, CLI-only)"
```

---

## Interface Contracts

### Module: shared/logger

#### Function: createLogger

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| createLogger | (prefix: string, minLevel?: LogLevel) => Logger | Logger | PI_CODING_AGENT_DIR unset → fallback to ~/.pi/agent/logs/ | AC-3 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1: Extension 加载成功 | SessionService.getExtensionPaths() | scan dirs → filter index.ts → --extension args | wiring done |
| AC-2: 前端展示正常 | RenderDescriptor.vue / SubagentRenderer.vue | pi tool output → event adapter → Vue render | wiring done |
| AC-3: Logger 路径隔离 | createLogger | PI_CODING_AGENT_DIR → LOG_DIR → appendFileSync | Task 1 |
| AC-4: 生产构建 | migrateToPiSubdir | Resources/pi/agent/extensions/ → cpSync → ~/.xyz-agent/pi/agent/extensions/ | wiring done |
| AC-5: Git 跟踪 | .gitignore | !src-electron/resources/pi/agent/extensions/ | wiring done |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 Extension 加载成功 | adopted | wiring (pre-existing) |
| AC-2 前端展示正常 | adopted | wiring (pre-existing) |
| AC-3 Logger 路径隔离 | adopted | Task 1 |
| AC-4 生产构建 | adopted | wiring (pre-existing) |
| AC-5 Git 跟踪 | adopted | wiring (pre-existing) |

---

## Execution Groups

#### BG1: Extension Source Cleanup

**Description:** Fix logger path isolation and remove unwanted evolution-engine. These two tasks are independent but both operate on the bundled extension source tree.

**Tasks:** Task 1, Task 2

**Files (预估):** 2 operations (1 modify + 1 delete directory)

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: low |
| 注入上下文 | Task 1 + Task 2 描述、spec FR-2 + FR-1、CLAUDE.md 数据隔离规则 |
| 读取文件 | `src-electron/resources/pi/agent/extensions/shared/logger.ts` |
| 修改/创建文件 | `shared/logger.ts` (modify), `evolution-engine/` (delete) |

**Execution Flow (BG1 内部):** 串行。Task 1 → Task 2。

**Dependencies:** 无。与 wiring 代码独立。

---

## Dependency Graph & Wave Schedule

```
  BG1 (cleanup)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 唯一的执行组 |

---

## Pre-existing Wiring (for reference)

以下代码已在之前的分析阶段完成修改，不在本 plan 的 Task 范围内，但需在集成测试时验证：

1. **session-service.ts** — `getExtensionPaths()` 扫描 dev/prod 路径，`create()` 和 restore 流程调用它
2. **.gitignore** — 放行 `extensions/` 和 `skills/` 子目录
3. **pi-config-bridge.ts** — `migrateToPiSubdir()` 在 packaged 模式下同步 bundled extensions
4. **electron-builder.yml** — `extraResources` 从 `resources/pi` 打包
5. **Extension 源码复制** — 6 个 extension + shared/ 已复制到 `src-electron/resources/pi/agent/extensions/`
