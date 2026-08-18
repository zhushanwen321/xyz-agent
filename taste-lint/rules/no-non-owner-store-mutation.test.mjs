/**
 * no-non-owner-store-mutation 规则最小用例（data-source-governance R2 骨架）。
 *
 * taste-lint 既有 13 条规则不带测试文件（无先例），按 plan W4 验收 4 的兜底方式：
 * node:test + eslint Linter 直挂规则，不依赖仓库 eslint.config。
 * 运行：node --test taste-lint/rules/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './no-non-owner-store-mutation.mjs';

const RULE_ID = 'taste/no-non-owner-store-mutation';

function lint(code, filename = 'packages/renderer/src/stores/probe.ts') {
  const linter = new Linter();
  return linter.verify(
    code,
    {
      // flat config 默认不 lint .ts 扩展，须显式 files 才对 .ts 文件名生效；
      // parser 用 typescript-eslint（对齐仓库真实 lint，type-only import 用例需要 TS 语法）
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
      plugins: { taste: { rules: { 'no-non-owner-store-mutation': rule } } },
      rules: { [RULE_ID]: 'error' },
    },
    { filename },
  );
}

test('R2: import session store 后直调 updateLabel → 报错且文案指向登记表', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function rename(id, label) {\n' +
      '  const store = useSessionStore()\n' +
      '  store.updateLabel(id, label)\n' +
      '}\n',
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /updateLabel/);
  assert.match(messages[0].message, /data-source-registry\.md/);
});

test('R2: 工厂调用直连 useSessionStore().setGroups([]) → 报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function load() {\n' +
      '  useSessionStore().setGroups([])\n' +
      '}\n',
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /setGroups/);
});

test('R2: store 声明晚于引用它的函数体（词法序盲点）→ 仍报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function rename(id, label) {\n' +
      '  sessionStore.updateLabel(id, label)\n' +
      '}\n' +
      'const sessionStore = useSessionStore()\n',
  );
  assert.equal(messages.length, 1);
});

test('R2: 许可文件（useSidebar.ts）直调 → 通过', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function load() {\n' +
      '  const session = useSessionStore()\n' +
      '  session.setGroups([])\n' +
      '  session.updateLabel("sid", "name")\n' +
      '}\n',
    'packages/renderer/src/composables/features/sidebar/useSidebar.ts',
  );
  assert.equal(messages.length, 0);
});

test('R2: 非受管 mutation（revive）→ 通过', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function wake(id) {\n' +
      '  const store = useSessionStore()\n' +
      '  store.revive(id)\n' +
      '}\n',
  );
  assert.equal(messages.length, 0);
});

test('R2: type-only import（core port 注入形态）→ 通过', () => {
  const messages = lint(
    'import type { createSessionStore } from "./store"\n' +
      'export function rename(store, id, label) {\n' +
      '  store.updateLabel(id, label)\n' +
      '}\n',
  );
  assert.equal(messages.length, 0);
});

test('R2: 测试文件豁免 → 通过', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'const store = useSessionStore()\n' +
      'store.updateLabel("sid", "name")\n',
    'packages/renderer/src/stores/probe.test.ts',
  );
  assert.equal(messages.length, 0);
});

test('R2: 行内豁免注释 taste:allow-non-owner-mutation → 通过', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function rename(id, label) {\n' +
      '  const store = useSessionStore()\n' +
      '  // taste:allow-non-owner-mutation\n' +
      '  store.updateLabel(id, label)\n' +
      '}\n',
  );
  assert.equal(messages.length, 0);
});
