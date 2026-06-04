# 测试代码品味审查报告

**分支**: `feat-integration-pi-extension` (main...HEAD)
**范围**: `src-electron/runtime/test/`
**变更**: 8 文件, +756 / -362 行

---

## 总评

整体质量中上。新文件（`extension-resolver.test.ts`、`event-adapter-bridge.test.ts`）结构清晰，describe/it 命名有描述性，覆盖了 happy path 和边界场景。旧文件重写（`extension-service.test.ts`）引入了真实文件系统操作，代价大于收益。部分测试有隐式状态依赖和断言不够严格的问题。

---

## 问题清单

### 1. MUST_FIX — extension-service.test.ts: 使用真实文件系统 + 非确定性断言

**文件**: `src-electron/runtime/test/extension-service.test.ts`
**行号**: 全文（`beforeEach` ~ `afterEach`）

**描述**: 从完全 mock `fs/promises` 重写为在 `/tmp/xyz-agent-test/extensions` 下创建真实文件。这引入了多个问题：

1. **`/tmp` 残留**: `afterEach` 中 `try { fs.rmSync(...) } catch {}` 静默吞掉清理失败。CI 环境下中断的测试会在 `/tmp` 留下脏数据，后续运行可能读到过期文件。
2. **非确定性**: `scanExtensions` 的 "returns empty array when no extensions found" 用例只断言 `Array.isArray(extensions)` 为 true，不验证内容为空。注释说 "Should still have built-in extensions from npm dependencies"——说明测试作者自己都不确定结果，用弱断言糊弄过去。
3. **`require('node:fs')`**: 第 56 行 `const fs = require('node:fs')` 在 ESM/TS 环境下用 `require` 是 code smell。文件顶部已经 `import { existsSync, ... } from 'node:fs'`，完全可以用已导入的 `rmSync`（加到 import 列表即可）。
4. **跨平台**: 硬编码 `/tmp` 路径，Windows 上行为不同。

**修复方向**:
- 回到 mock 策略（`vi.mock('node:fs')`），像 `extension-resolver.test.ts` 那样。Service 层的逻辑（read settings → resolve → filter disabled）不需要真实文件系统验证。
- 如果坚持用真实 fs，至少用 `os.tmpdir()` 获取路径，断言要精确，清理失败要抛错。

---

### 2. MUST_FIX — extension-service.test.ts: `marks disabled extensions` 断言不严格

**文件**: `src-electron/runtime/test/extension-service.test.ts`
**行号**: ~L82-90

```ts
const askUser = extensions.find(e => e.name === 'pi-ask-user')
if (askUser) {
  expect(askUser.enabled).toBe(false)
}
```

**描述**: `if (askUser)` 意味着找不到 `pi-ask-user` 时测试静默通过（0 断言执行）。这个测试的目的是验证 disabled 状态生效，但如果 resolver 因任何原因找不到该 extension，核心断言被跳过，测试变成空操作。

**修复方向**: 去掉 `if` 守卫，直接 `expect(askUser).toBeDefined()` + `expect(askUser!.enabled).toBe(false)`。与同文件第 72 行的写法对齐。

---

### 3. MUST_FIX — extension-service.test.ts: `installExtension` 测试通过真实副作用验证 mock 结果

**文件**: `src-electron/runtime/test/extension-service.test.ts`
**行号**: ~L99-120

**描述**: `throws when package is not a valid pi extension` 这个测试手动创建了一个 `invalid-pkg` 目录在真实文件系统上，然后 mock `execSync` 返回空字符串。测试隐含假设 `installExtension` 内部会用 `execSync('npm install ...')` 然后再去文件系统检查安装结果。这个链路太长、太脆弱——如果 `installExtension` 的实现改了 npm 调用时机，测试就废了，而且测试意图被文件操作细节淹没。

**修复方向**: 把 install 的端到端流程拆成：单元测试只验证参数校验和 npm 调用参数（mock execSync 并检查调用参数），集成测试留给真实环境。当前这个测试两者都没做好。

---

### 4. LOW — extension-resolver.test.ts: `mockDir` 辅助函数隐含过多假设

**文件**: `src-electron/runtime/test/extension-resolver.test.ts`
**行号**: ~L24-45

**描述**: `mockDir` 默认 entries 为 `['ext-a', 'ext-b', 'shared']`，硬编码了 `shared` 目录的特殊处理逻辑（basename 为 `shared` 就抛 ENOENT）。这意味着：
1. 调用者不传 entries 时，测试数据是什么完全不可见
2. `shared` 的跳过逻辑被嵌在 mock helper 里而非测试本身，如果 resolver 改了跳过规则（比如不跳 shared 了），mock 仍在模拟旧行为

**修复方向**: 可以接受，但建议让默认 entries 不含特殊目录（`['ext-a', 'ext-b']`），需要测试 shared 跳过时显式传入。

---

### 5. LOW — extension-resolver.test.ts: `scanThirdPartyExtensions` 依赖 `process.env.HOME`

**文件**: `src-electron/runtime/test/extension-resolver.test.ts`
**行号**: ~L246-255

```ts
const home = process.env.HOME ?? '/home/user'
const thirdPartyDir = `${home}/.xyz-agent/pi/agent/extensions`
```

**描述**: 这个测试用了真实 `process.env.HOME` 而不是 `vi.stubEnv('HOME', ...)`。同文件的 `scanSettingsExtensions` 用例正确地 `stubEnv` 了。如果 runner 环境没有 `HOME`（某些 CI），测试行为不一致。

**修复方向**: 统一用 `vi.stubEnv('HOME', '/home/user')`，与 `scanSettingsExtensions` 的写法一致。

---

### 6. LOW — event-adapter-bridge.test.ts: `vi.waitFor` 依赖隐式异步

**文件**: `src-electron/runtime/test/event-adapter-bridge.test.ts`
**行号**: 多处（L37, L62, L87 等）

**描述**: 每个测试都 `await vi.waitFor(() => sent.length > 0)` 来等待异步事件处理。如果 EventAdapter 内部的异步链路变成同步（重构后），`waitFor` 仍能工作，但断言语义从"等待异步完成"变成"无条件轮询"。

这不是大问题，但 139 行的新文件中 5 个测试全用同一个模式，说明 `createAdapter` + `attach` + `extract listener` 的 setup 仪式感太重。每个测试重复 4 行 boilerplate。

**修复方向**: 考虑提取一个 `setupWithListener` helper 把 `createAdapter → attach → extract listener` 封装起来，减少每个测试的 setup 行数。

---

### 7. LOW — extension-resolver.test.ts: `deduplicate` 测试不够全面

**文件**: `src-electron/runtime/test/extension-resolver.test.ts`
**行号**: `deduplicate` describe 块

**描述**: 4 个 deduplicate 测试覆盖了基本冲突场景，但缺少：
1. 空输入（`sources = []`）——应返回空 Map
2. 三个以上来源的同名冲突（npm > user > settings 同名）——验证优先级传递
3. `extensions` 为空 Map 的 source——验证不崩溃

**修复方向**: 补充边界 case，特别是空输入。

---

### 8. LOW — extension-resolver.test.ts: `resolve` 集成测试的 `readFileSync` mock 遗漏

**文件**: `src-electron/runtime/test/extension-resolver.test.ts`
**行号**: ~L356-378

**描述**: `integrates all 5 sources and deduplicates` 测试中，`readFileSync` mock 返回了 settings.json 和 project package.json 的内容，但没有 mock `pi-ask-user` 的 package.json（settings 扫描依赖它做 `isValidPiExtension` 校验）。测试能通过可能是因为 `existsSync` 对 `pkgDir` 返回 false 导致跳过了——这意味着 settings 源实际没产出任何 extension，测试名说的 "all 5 sources" 名不副实。

**修复方向**: 要么修正 mock 让 settings 源真正扫描到 pi-ask-user，要么改测试名反映实际情况（"integrates bundled + third-party + user sources"）。

---

### 9. INFO — extension-resolver.test.ts: mock `node:path` 的必要性和风险

**文件**: `src-electron/runtime/test/extension-resolver.test.ts`
**行号**: ~L8-10

```ts
vi.mock('node:path', () => ({
  join: vi.fn((...args: string[]) => args.join('/')),
  dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/')),
}))
```

**描述**: Mock `node:path` 让所有断言用 `/` 分隔符，跨平台一致。但自定义 `join` 不处理 `..`、`.`、重复分隔符等边界——如果 resolver 代码用了这些特性，mock 会隐藏 bug。

当前可接受（resolver 代码只用简单的 join），但如果 resolver 逻辑变复杂，建议去掉 path mock，在断言中用 `normalizePath()` 辅助函数（旧版 extension-service.test.ts 的做法）。

---

### 10. INFO — statusline-event-adapter.test.ts / event-adapter-extension.test.ts: 旧测试的断言更新

**文件**: `statusline-event-adapter.test.ts`, `event-adapter-extension.test.ts`

**描述**: 这些是旧测试的断言更新（从 "sent.length === 0" 改为 "sent.length === 1" + 验证 WS event 内容），反映 setStatus/setWidget 从 discard 改为 bridge 的行为变更。更新本身正确，但 "TC-1-02: setWidget still discarded" 这个 describe 名字现在有误导性——setWidget 不再 discarded，而是 bridged。

**修复方向**: 把 describe 名从 `setWidget still discarded` 改为 `setWidget bridges to extension.widget`。

---

### 11. INFO — bridge-reconnect.test.ts / bridge-sync.test.ts: 内部属性访问方式更新

**文件**: `bridge-reconnect.test.ts`, `bridge-sync.test.ts`

**描述**: 从 `bridgeRequestIds: Set<string>` 改为 `extensionTimeoutMgr.isBridgeRequest()`。这是内部 API 重构的适配，`as unknown as` 类型断言是测试中访问 private 成员的标准做法，可接受。

---

## 统计

| 优先级 | 数量 |
|--------|------|
| MUST_FIX | 3 |
| LOW | 5 |
| INFO | 3 |

**关键行动项**: MUST_FIX #1（extension-service.test.ts 的真实 fs）是最大的结构性问题，建议优先处理。MUST_FIX #2（弱断言）是快速修复。
