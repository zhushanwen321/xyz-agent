## 修复两个问题

### 问题 1：以 `/` 或 `~/` 开头的绝对路径只被识别后半段为链接

**根因**：`FILEPATH_RE`（`packages/renderer/src/composables/logic/markdown.ts:219`）捕获组首字符集 `[a-zA-Z0-9._\-]` 不含 `/` 和 `~`。markdown-it inline 解析器逐 pos 遍历，filepath rule 在 pos=0（路径起点）匹配失败，等 text rule 把 pos 推进到路径中间的 `_`（punctuation，text rule 会停）时，filepath rule 再次被调用，`state.src.slice(pos)` 的 `^` 分支让 `_j5s7bn3...` 看起来像合法路径起点 → 只匹配后半段。

**修复**：`FILEPATH_RE` 捕获组首段加 `(?:~\/|\/)?` 前缀，支持绝对路径（`/...`）和家目录路径（`~/...`）：

```diff
- const FILEPATH_RE = /(?:^|[\s(>"'(\[,{;:])([a-zA-Z0-9._\-]+(?:\/[a-zA-Z0-9._\-]+)+\.(?=\d*[a-zA-Z])[a-zA-Z0-9]{1,8})(?![a-zA-Z0-9._\-/])/g
+ const FILEPATH_RE = /(?:^|[\s(>"'(\[,{;:])((?:~\/|\/)?[a-zA-Z0-9._\-]+(?:\/[a-zA-Z0-9._\-]+)+\.(?=\d*[a-zA-Z])[a-zA-Z0-9]{1,8})(?![a-zA-Z0-9._\-/])/g
```

实测验证（完整 markdown-it 渲染）：
- 问题路径整段识别 ✓
- 相对路径 `src/foo.ts` 不变 ✓
- 新支持 `/abs/path/file.ts`、`~/Code/project/main.ts` ✓
- 不误伤 `/usr/bin`（无扩展名）、`2026/07/08`（日期）、`node/18.0`（纯数字扩展名）✓

BASENAME_RE（裸文件名）不需要改——它匹配的是无 `/` 的 basename，前缀问题不存在。

### 问题 2：无 git 差异的文件默认展示空 diff，应降级展示文件预览

**根因**：`useDetailPane.openPreview`（`packages/renderer/src/composables/features/useDetailPane.ts:108-120`）按 `gitOverlay` 有无记录决定 mode——untracked 文件有记录 → mode='diff'。但 `git diff -- <untracked>` 在 git 语义下无输出 → 空 patch → DiffView 显示「无差异内容」空态。

**修复**（用户已确认 toggle 保持现状，允许手动点回空 Diff）：在 `loadContent` 的 diff 分支，拿到 patch 后判断若无 hunk（非二进制），自动切 preview 并补取 file.read：

```ts
// useDetailPane.ts loadContent 内 diff 分支改造
if (mode === 'diff') {
  const result = await gitApi.getDiff(sid, path)
  state.value.binary = result.binary
  state.value.content = result.patch
  // diff 无 hunk 且非二进制 → 自动降级 preview（untracked 文件 git diff 必空）
  if (!result.binary && parseDiff(result.patch).hunks.length === 0) {
    state.value.viewMode = 'preview'
    const fileResult = await fileApi.read(path, sid)
    state.value.content = fileResult.content
    state.value.truncated = fileResult.truncated
  }
} else { ... }
```

用户手动点 toggle 切回 Diff（`toggleView`）仍走原逻辑显示空态——这是用户的主动选择，不改。

### 改动文件清单（3 个源文件 + 2 个测试文件）

| 文件 | 改动 |
|------|------|
| `packages/renderer/src/composables/logic/markdown.ts:219` | `FILEPATH_RE` 加 `(?:~\/|\/)?` 前缀 |
| `packages/renderer/src/composables/features/useDetailPane.ts:90-106` | `loadContent` diff 分支加空 patch 降级逻辑（import parseDiff） |
| `packages/renderer/src/api/mock/git.ts:80-99` | mock getDiff 对 untracked 文件返回空 patch（贴近真实 runtime，让测试能覆盖降级） |
| `packages/renderer/src/__tests__/composables/markdown.test.ts` | 加用例：绝对路径、家目录路径、`/var/folders/.../x.md` 整段识别 |
| `packages/renderer/src/__tests__/composables/useDetailPane.test.ts`（新建） | 加用例：untracked 文件 diff 空 → 自动降级 preview；modified 文件 diff 非空 → 保持 diff |

### 验证

- 单测：`npx vitest run src/__tests__/composables/markdown.test.ts` + 新建的 `useDetailPane.test.ts`
- lint：`pnpm run lint`（检查 pre-commit 不引入问题）