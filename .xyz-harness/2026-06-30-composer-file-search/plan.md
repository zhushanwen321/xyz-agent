# Composer `#` 文件候选 real 化实现计划

## 业务目标

将 Composer `#` 文件候选从 mock 假数据（`FILE_CANDIDATES` 的 3 条编造路径）改为当前 session cwd 的真实文件列表。成功标准：`npm run dev`（real 模式）下，输入 `#` 或经 `+` 菜单点「文件」，浮层展示当前 session cwd 下真实文件（全量递归 + ignore 过滤），选中后插入的文件名对应真实路径。同时去掉 `@` 入口（技能已由 slash 实现、符号无 LSP 无法 real 化）。

## 约束 / 不做

约束：复用 FileService 现有积木；性能防护三件套（前端 debounce 300ms + 后端内建 ignore 兜底 + 递归深度上限 8 层 + 结果数上限 500）；session 级缓存按 fileChanges 失效；协议归 file 域。

不做：`@` 符号/技能候选；跨 session 搜索；fuzzy 排序库（沿用 `includes` 子串过滤）；文件树缓存与侧边栏共享（YAGNI）；pending.ts 超时改造（既有问题，标注已知风险不在本次范围）。

## 关键设计决策（吸收禁读重建盲区）

1. **searchFiles 不能照搬 listTree 的「抛错即终止」语义**（G12）：全量递归必须 per-directory try/catch，单子目录 EACCES/ENOENT 跳过继续，不中断整个搜索。
2. **symlink 目录成环防护**（G6）：递归维护 visited Set（realpath 去重），遇到已访问路径跳过，防栈溢出。
3. **DTO 映射层**（G16）：FileNode 与现有 CommandPopover 期望的候选形状（中文 `kind:'目录'`, name 带斜杠）不同构。新增映射函数。
4. **深度契约钉死**（G1/G2）：根 cwd = depth 0，递归到 depth 8 时停止下钻（第 8 层节点仍返回，但不展开其子目录）。
5. **内建 ignore 优先级**（G3/G4）：内建 ignore（node_modules/.git/dist/build/coverage/.next/.cache/.turbo）是安全兜底，不可被用户 .gitignore 的 `!` 取反覆盖。独立 Set 短路，与 matchPath 是两道独立关卡。
6. **结果数上限**（G13）：递归收集到 500 个文件节点即停止。
7. **query 从签名删除**（G7）：最终签名 `searchFiles(sessionId, showIgnored?)`。
8. **landing 态守门**（G10）：无 session 时 AddMenuPopover 不显示「文件」入口。
9. **handler 运行时闭合**（G15）：protocol.ts 5 处类型闭合 + handler handles + switch case = 6 处。
10. **失效语义明确**（G9）：fileChanges 触发 invalidate 后不自动刷新，下次打开才生效。

## 技术改动点

### 协议层（shared）
- 修改 `src-electron/shared/src/protocol.ts` — 新增 `file.search` 类型（5 处闭合）

### runtime 层
- 修改 `src-electron/runtime/src/services/file-service.ts` — 新增 `searchFiles(sessionId, showIgnored?)` + BUILTIN_IGNORE_DIRS 常量
- 修改 `src-electron/runtime/src/transport/file-message-handler.ts` — handles 加 `'file.search'`；switch 加 case（第 6 处闭合）

### renderer 层
- 创建 `src-electron/renderer/src/api/domains/composer.ts` — real composer domain
- 修改 `src-electron/renderer/src/api/index.ts` — :38 改三元
- 创建 `src-electron/renderer/src/stores/fileSearch.ts` — session 级缓存 store
- 创建 `src-electron/renderer/src/composables/features/useFileSearch.ts` — debounce + invalidation
- 创建 `src-electron/renderer/src/lib/file-candidates.ts` — DTO 映射
- 修改 `src-electron/renderer/src/components/panel/CommandPopover.vue` — 接 store + 删 mention
- 修改 `src-electron/renderer/src/components/panel/Composer.vue` — cmdType 去 mention
- 修改 `src-electron/renderer/src/components/panel/AddMenuPopover.vue` — 删 mention + landing 守门

## Wave 拆分与依赖

| Wave | 改动文件 | 依赖 | 说明 |
|------|---------|------|------|
| W1 | protocol.ts | - | Prefactor 协议类型闭合 |
| W2 | file-service.ts + test | W1 | runtime service：searchFiles 递归 |
| W3 | file-message-handler.ts + test | W2 | runtime handler：file.search case |
| W4 | composer.ts + file-candidates.ts + fileSearch.ts + useFileSearch.ts + api/index.ts + tests | W1,W3 | renderer 数据层 |
| W5 | CommandPopover.vue + Composer.vue + AddMenuPopover.vue + tests | W4 | renderer 消费层 + 去 @ 入口 |
| W6 | 验收 | W1-W5 | 全量单测 + 覆盖率 + lint + E2E |

全串行（跨层调用依赖）。

## 单测用例清单（AC 级）

### W2 — file-service.ts:searchFiles
| U1 | searchFiles | sid='s1'(cwd='/repo')，顶层[src(dir),README.md]，src下[index.ts] | files 含 3 项 path='src'/'README.md'/'src/index.ts' | 正常 |
| U2 | searchFiles | 顶层含 node_modules(dir) | files 不含任何 'node_modules' 前缀项（内建 ignore 短路） | 边界 |
| U3 | searchFiles | .gitignore 含 `dist/`，顶层 dist(dir)下[a.js] | files 不含 'dist' 及子 | 正常 |
| U4 | searchFiles | a/b/c/d/e/f/g/h（8层），h 下 leaf.txt（第9层）| files 含 'a'...'h'，不含 'leaf.txt' | 边界 |
| U5 | searchFiles | 第8层是 dir，其下 leaf.ts | files 含第8层目录壳，不含 leaf.ts；listDir 对该 dir 未调用 | 边界 |
| U6 | searchFiles | sid 不存在 | reject FileError code='session_not_found' | 异常 |
| U7 | searchFiles | good/(下 a.ts) + locked/(EACCES) | files 含 'good/a.ts'，resolve 不抛（per-dir 容错）| 异常 |
| U8 | searchFiles | symlink 环 link→cwd | resolve 不爆栈；files 含 'link' 一次 | 边界 |
| U9 | searchFiles | 空目录 | resolve files=[] | 边界 |
| U10 | searchFiles | >500 个文件 | files.length === 500 | 边界 |
| U11 | searchFiles | .gitignore 含 `!dist/keep.ts` + 内建 ignore 含 dist | files 不含 'dist/keep.ts'（内建不可被 ! 覆盖）| 边界 |

### W3 — file-message-handler.ts
| U12 | handleFileMessage | msg={type:'file.search',id:'1',payload:{sessionId:'s1'}} | replies[0] 匹配{id:'1',type:'file.search:result'} | 正常 |
| U13 | handleFileMessage | sessionId='sX'，searchFiles reject session_not_found | errors[0] 匹配{code:'session_not_found'} | 异常 |
| U14 | handles | 读 handler.handles | 含 'file.search' | 正常 |

### W4 — composer domain + 映射 + store + composable
| U15 | composer.ts:getFileCandidates | mock transport.send 捕获 | msg.type='file.search'，无 query 字段 | 正常 |
| U16 | composer.ts:getFileCandidates | mock resolve {files:[{path:'x'}]} | resolve [{path:'x'}] | 正常 |
| U17 | composer.ts:getMentionCandidates | 调用 | resolve [] | 边界 |
| U18 | file-candidates.ts | [{type:'dir',name:'src'},{type:'file',name:'a.ts'}] | [{name:'src/',kind:'目录'},{name:'a.ts',kind:'文件'}] | 正常 |
| U19 | file-candidates.ts | [] | [] | 边界 |
| U20 | fileSearch.ts:load | 首次 load('s1') 返回[a,b] | store 长度2；api 调1次 | 正常 |
| U21 | fileSearch.ts:load | 已缓存再 load | api 仍1次 | 正常 |
| U22 | fileSearch.ts:load | load('s1')后 load('s2') | 两 session 独立，api 调2次 | 正常 |
| U23 | fileSearch.ts:invalidate | load→invalidate→load | api 调2次 | 正常 |
| U24 | useFileSearch.ts | 连续 load 2 次（间隔0）| fake timers advance 300，api 调1次 | 边界 |
| U25 | useFileSearch.ts | fileChanges 变化含 'src/a.ts' | store.invalidate('s1',['src/a.ts']) | 正常 |
| U26 | useFileSearch.ts | invalidate 后不自动刷新 | store.get 返回旧值，不触发 load | 边界 |

### W5 — CommandPopover + Composer + AddMenuPopover
| U27 | CommandPopover.vue | type='file' sid='s1' 候选[{name:'a.ts',kind:'文件'}] | DOM body 含 'a.ts' button | 正常 |
| U28 | CommandPopover.vue | 候选空 | PopoverContent 不渲染 | 边界 |
| U29 | CommandPopover.vue | 候选含 kind='目录' | 该项图标 folder | 正常 |
| U30 | AddMenuPopover.vue | 有 session | 含 '文件'(#) '命令'(/)，不含 '引用'(@) | 正常 |
| U31 | AddMenuPopover.vue | 无 session | 不含 '文件'(#)'引用'(@)，含 '命令'(/) | 边界 |
| U32 | Composer.vue | onAddSelect('file') | cmdType='file'，cmdOpen=true | 正常 |

## E2E 用例清单

项目有 Playwright（`e2e/file-tree.spec.ts` 模板，VITE_MOCK=true + VITE_E2E=true）。

| E1 | `#` 文件候选 happy | e2e/fixtures/sample-project | 启动→选 session→`+`→「文件」 | 浮层展示真实文件 | `npx playwright test e2e/composer-file-search.spec.ts` |
| E2 | `@` 入口已移除 | 同上 | `+` 菜单 | 无「引用」(@) 项 | 同上 |
| E3 | `#` 选中插 chip | 同上 | 打开文件浮层→↓→Enter | 插入 `#文件名` chip | 同上 |
| E4 | landing 无 `#` 入口 | 无 session | `+` 菜单 | 无「文件」(#) 项 | 同上 |

## 覆盖率 gate

- runtime：`cd src-electron/runtime && npx vitest run --coverage`
- renderer：`cd src-electron/renderer && npx vitest run --coverage`
- 增量：`git diff --name-only main` 看改动文件报告
- 阈值：新增文件 ≥ 80%；searchFiles 8 条分支全覆盖

## 实现步骤

1. [W1] 修改 protocol.ts 新增 file.search 5 处闭合。tsc + vue-tsc 验类型。提交。
2. [W2] file-service.ts 新增 searchFiles + BUILTIN_IGNORE_DIRS。先写 U1-U11 到 runtime/test/file-service.test.ts（U7/U8/U10 是与 listTree 不同的容错/防环/上限语义）。`cd src-electron/runtime && npx vitest run test/file-service.test.ts`。提交。
3. [W3] file-message-handler.ts 加 file.search case + handles。先写 U12-U14 到 runtime/test/file-message-handler.test.ts（新建）。提交。
4. [W4] 创建 composer.ts/file-candidates.ts/fileSearch.ts/useFileSearch.ts，改 api/index.ts。先写 U15-U26。`cd src-electron/renderer && npx vitest run`。提交。
5. [W5] 改 CommandPopover.vue/Composer.vue/AddMenuPopover.vue。先写 U27-U32，适配 composer-slash-trigger.test.ts 的 vi.mock factory。AddMenuPopover 加 landing 守门。提交。
6. [W6] 验收：runtime + renderer vitest --coverage，新增文件≥80% + searchFiles 8 分支全覆盖。`npm run lint`。新增 e2e/composer-file-search.spec.ts 跑 E1-E4。全绿才完成。

## 已知风险（本次不修）

- **pending.ts 无超时**（G14）：transport 断连时 composer.getFileCandidates 的 pending 可能永挂。pending.ts 既有问题，本次不改造，后续统一加 pending 超时。
