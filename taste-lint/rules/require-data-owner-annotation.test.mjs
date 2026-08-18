/**
 * require-data-owner-annotation 规则最小用例（data-source-governance R3）。
 *
 * taste-lint 既有 13 条规则不带测试文件（无先例），按 plan W4 验收 4 的兜底方式：
 * node:test + eslint Linter 直挂规则，不依赖仓库 eslint.config。
 * 运行：node --test taste-lint/rules/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import rule from './require-data-owner-annotation.mjs';

const RULE_ID = 'taste/require-data-owner-annotation';
const STORES_FILE = 'packages/renderer/src/stores/probe.ts';

function lint(code, filename = STORES_FILE) {
  const linter = new Linter();
  return linter.verify(
    code,
    {
      // flat config 默认不 lint .ts 扩展，须显式 files 才对 .ts 文件名生效；
      // 用例代码刻意保持纯 JS 语法（规则不依赖 TS 专有节点），espree 即可解析
      files: ['**/*.ts'],
      plugins: { taste: { rules: { 'require-data-owner-annotation': rule } } },
      rules: { [RULE_ID]: 'error' },
    },
    { filename },
  );
}

test('R3: 模块级 new Map 无注解 → 报错且文案指向登记表', () => {
  const messages = lint('const cache = new Map()\nexport const size = () => cache.size\n');
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /@data-owner/);
  assert.match(messages[0].message, /data-source-registry\.md/);
});

test('R3: 模块级 ref 无注解 → 报错', () => {
  const messages = lint('const counter = ref(0)\nexport const read = () => counter.value\n');
  assert.equal(messages.length, 1);
});

test('R3: 相邻上方注释 @data-owner #1 → 通过', () => {
  const messages = lint('// @data-owner #1\nconst cache = new Map()\n');
  assert.equal(messages.length, 0);
});

test('R3: 同行尾注释 @data-owner P1 → 通过', () => {
  const messages = lint('const cache = new Map() // @data-owner P1\n');
  assert.equal(messages.length, 0);
});

test('R3: 引用不存在的登记条目 #99 → 报错（条目必须真实）', () => {
  const messages = lint('// @data-owner #99\nconst cache = new Map()\n');
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /#99/);
});

test('R3: 函数作用域内声明（非模块级）→ 通过', () => {
  const messages = lint(
    'export function setup() {\n  const local = new Map()\n  return local\n}\n',
  );
  assert.equal(messages.length, 0);
});

test('R3: 测试文件豁免 → 通过', () => {
  const messages = lint('const cache = new Map()\n', 'packages/renderer/src/stores/probe.test.ts');
  assert.equal(messages.length, 0);
});

test('R3: stores/ 之外的文件（首版范围裁定）→ 通过', () => {
  const messages = lint(
    'const cache = new Map()\nexport const read = () => cache.size\n',
    'packages/renderer/src/composables/probe.ts',
  );
  assert.equal(messages.length, 0);
});

test('R3: useSessionScopedState 原语本体豁免 → 通过', () => {
  const messages = lint(
    'const registry = new Set()\nexport const add = (fn) => registry.add(fn)\n',
    'packages/core/src/foundation/use-session-scoped-state.ts',
  );
  assert.equal(messages.length, 0);
});

test('R3: 行内豁免注释 taste:allow-no-data-owner → 通过', () => {
  const messages = lint('// taste:allow-no-data-owner\nconst cache = new Map()\n');
  assert.equal(messages.length, 0);
});
