/**
 * no-non-owner-store-mutation 规则用例（data-source-governance R2）。
 *
 * W4 首版（直呼检测）+ W24 扩展（文件内调用图：形参转发 / 方法引用传递 / 工厂包装）。
 * 收紧是超集不是替换：W4 直呼用例全部保留。
 * node:test + eslint Linter 直挂规则，不依赖仓库 eslint.config；许可表条目经
 * taste-lint/lib/parse-registry.mjs 读真实登记表（登记表驱动的联测面）。
 * 运行：node --test taste-lint/rules/*.test.mjs（node 24 目录形式不发现用例，须 glob）
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

// ── W4 直呼用例（保留：收紧是超集，不是替换）──────────────────────────────

test('R2: import session store 后直调 applySnapshot → 报错且文案指向登记表', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function rename(id, label) {\n' +
      '  const store = useSessionStore()\n' +
      '  store.applySnapshot(id, { label })\n' +
      '}\n',
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /applySnapshot/);
  assert.match(messages[0].message, /data-source-registry\.md/);
});

test('R2: 工厂调用直连 useSessionStore().applySnapshot({}) → 报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function load() {\n' +
      '  useSessionStore().applySnapshot({ groups: [] })\n' +
      '}\n',
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /applySnapshot/);
});

test('R2: store 声明晚于引用它的函数体（词法序盲点）→ 仍报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function rename(id, label) {\n' +
      '  sessionStore.applySnapshot(id, { label })\n' +
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
      '  session.applySnapshot({ groups: [] })\n' +
      '  session.applySnapshot("sid", { label: "name" })\n' +
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
      '  store.applySnapshot(id, { label })\n' +
      '}\n',
  );
  assert.equal(messages.length, 0);
});

test('R2: 测试文件豁免 → 通过', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'const store = useSessionStore()\n' +
      'store.applySnapshot("sid", { label: "name" })\n',
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
      '  store.applySnapshot(id, { label })\n' +
      '}\n',
  );
  assert.equal(messages.length, 0);
});

// ── W24 调用图用例（一层转发起步）──────────────────────────────────────────

test('R2/W24: 三层转发（load → applyVia(形参 s) → mutation）→ 报错，W4 直呼形态不报的超集', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'function applyVia(s, snapshot) {\n' +
      '  s.applySnapshot(snapshot)\n' +
      '}\n' +
      'export function load(snapshot) {\n' +
      '  const store = useSessionStore()\n' +
      '  applyVia(store, snapshot)\n' +
      '}\n',
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /applySnapshot/);
  assert.match(messages[0].message, /形参 s/);
  assert.match(messages[0].message, /data-source-registry\.md/);
});

test('R2/W24: 同转发结构但实参非 store（未绑定写通道）→ 通过（超集不扩大误报面）', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'function applyVia(s, snapshot) {\n' +
      '  s.applySnapshot(snapshot)\n' +
      '}\n' +
      'export function load(other, snapshot) {\n' +
      '  applyVia(other, snapshot)\n' +
      '}\n' +
      'const keepFactoryVisible = useSessionStore\n',
  );
  assert.equal(messages.length, 0);
});

test('R2/W24: 方法引用传递 wire(store.applySnapshot) → 报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function wire(apply) {\n' +
      '  apply({ groups: [] })\n' +
      '}\n' +
      'export function setup() {\n' +
      '  const store = useSessionStore()\n' +
      '  wire(store.applySnapshot)\n' +
      '}\n',
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /applySnapshot/);
  assert.match(messages[0].message, /值传递|脱离/);
});

test('R2/W24: 工厂包装 getStore().applySnapshot → 报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'function getStore() {\n' +
      '  return useSessionStore()\n' +
      '}\n' +
      'export function load(snapshot) {\n' +
      '  getStore().applySnapshot(snapshot)\n' +
      '}\n',
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /getStore/);
});

test('R2/W24: 许可文件内的转发形态 → 通过（owner 文件内部组织自由）', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'function applyVia(s, snapshot) {\n' +
      '  s.applySnapshot(snapshot)\n' +
      '}\n' +
      'export function load(snapshot) {\n' +
      '  const store = useSessionStore()\n' +
      '  applyVia(store, snapshot)\n' +
      '}\n',
    'packages/renderer/src/composables/features/model/useModel.ts',
  );
  assert.equal(messages.length, 0);
});

test('R2/W24: 无工厂 import 边的文件（port 注入）转发形态 → 通过（S1 语义层管辖）', () => {
  const messages = lint(
    'import type { useSessionStore } from "@/stores/session"\n' +
      'function applyVia(s, snapshot) {\n' +
      '  s.applySnapshot(snapshot)\n' +
      '}\n' +
      'export function orchestrate(store, snapshot) {\n' +
      '  applyVia(store, snapshot)\n' +
      '}\n',
  );
  assert.equal(messages.length, 0);
});

test('R2/W24: 转发违规 + 行内豁免注释 → 通过', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'function applyVia(s, snapshot) {\n' +
      '  // taste:allow-non-owner-mutation\n' +
      '  s.applySnapshot(snapshot)\n' +
      '}\n' +
      'export function load(snapshot) {\n' +
      '  const store = useSessionStore()\n' +
      '  applyVia(store, snapshot)\n' +
      '}\n',
  );
  assert.equal(messages.length, 0);
});

// ── W24 R2 逃逸收口用例（verifier 打回 major：双重逃逸静默绕过路径）─────────

test('R2/W24: 表达式体箭头工厂 const grab = () => useSessionStore() → grab().applySnapshot 报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'const grab = () => useSessionStore()\n' +
      'export function load(snapshot) {\n' +
      '  grab().applySnapshot(snapshot)\n' +
      '}\n',
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /grab/);
});

test('R2/W24: 表达式体箭头 body 引用的实例绑定声明晚于箭头（词法序陷阱）→ 仍报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'const grab = () => s\n' +
      'const s = useSessionStore()\n' +
      'export function load(snapshot) {\n' +
      '  grab().applySnapshot(snapshot)\n' +
      '}\n',
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /grab/);
});

test('R2/W24: 对象方法包装 box.grab().applySnapshot（MemberExpression receiver）→ 报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'const box = {\n' +
      '  grab() {\n' +
      '    return useSessionStore()\n' +
      '  },\n' +
      '}\n' +
      'export function load(snapshot) {\n' +
      '  box.grab().applySnapshot(snapshot)\n' +
      '}\n',
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /grab/);
});

test('R2/W24: 非 store 的表达式体箭头 / 对象方法返回值调 applySnapshot → 通过（收口不扩大误报面）', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'const keepFactoryVisible = useSessionStore\n' +
      'function other() {\n' +
      '  return { v: 1 }\n' +
      '}\n' +
      'const get = () => other()\n' +
      'const box = {\n' +
      '  fetch() {\n' +
      '    return other()\n' +
      '  },\n' +
      '}\n' +
      'export function load(snapshot) {\n' +
      '  get().applySnapshot(snapshot)\n' +
      '  box.fetch().applySnapshot(snapshot)\n' +
      '}\n',
  );
  assert.equal(messages.length, 0);
});
