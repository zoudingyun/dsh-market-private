import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin');

/** 极简 React 替身：只满足 apply 阶段用到的那点 API */
const React = {
  createElement: () => ({}),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
};

function loadBundle() {
  const code = fs.readFileSync(path.join(dir, 'client.js'), 'utf8');
  let loaded;
  const sandbox = {
    window: { __ModuleLoader__: { load: (b) => { loaded = b; } } },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { getElementById: () => null, createElement: () => ({ set textContent(v) {}, set id(v) {} }), head: { append() {} } },
    console,
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
  };
  const fn = new Function('window', 'localStorage', 'document', 'fetch', 'console', code);
  fn(sandbox.window, sandbox.localStorage, sandbox.document, sandbox.fetch, sandbox.console);
  return loaded;
}

test('插件包结构齐全（bundle patch / client / locale）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.match(pkg.dsh.bundle.patch, /cordis\.patch\.yml$/);
  assert.ok(fs.existsSync(path.join(dir, pkg.dsh.bundle.patch)), 'patch 文件存在');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'), '要等 tab 槽位的声明者');
  assert.ok(pkg.files.includes('client.js'), 'client.js 必须打包进去');
  for (const lang of ['zh', 'en']) {
    const locale = JSON.parse(fs.readFileSync(path.join(dir, 'locale', `${lang}.json`), 'utf8'));
    assert.ok(locale.meta.title && locale.meta.description, `${lang} 要有 title/description`);
  }
});

test('client bundle 注册到 plugins.tab，id 与包名一致', () => {
  const loaded = loadBundle();
  assert.ok(loaded, '应该调用 __ModuleLoader__.load');
  assert.equal(loaded.id, '@local/dsh-market-tab', 'bundle id 必须等于包名');

  const mod = loaded.factory((name) => {
    if (name === 'react') return React;
    throw new Error('未知依赖: ' + name);
  });
  assert.equal(typeof mod.apply, 'function');

  const registered = [];
  const ctx = {
    effect: (fn) => fn(),
    locale: { register() {}, bind: () => (k) => k, subscribe: () => () => {} },
    slots: { inject: (_name, fn) => fn(), register: (options, Component) => { registered.push({ options, Component }); } },
  };
  mod.apply(ctx);

  assert.equal(registered.length, 1);
  const { options, Component } = registered[0];
  assert.equal(options.name, 'plugins.tab');
  assert.equal(options.id, 'market');
  assert.equal(typeof options.label(), 'string');
  assert.equal(typeof Component, 'function');
});

test('插件清单版本范围与当前 DSH 基线一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.match(pkg.engines.dsh, /0\.2\.2-rc\.3/);
});
