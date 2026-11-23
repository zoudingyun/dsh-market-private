import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { inspectTarball } from '../src/manifest.mjs';

const base = {
  name: '@team-a/dsh-foo',
  version: '1.0.0',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  engines: { dsh: '>=0.2.2-rc.3 <0.3.0' },
  exports: { '.': './index.js' },
};

function makeTarball(pkg = {}, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-fx-'));
  const dir = path.join(root, 'package');
  fs.mkdirSync(path.join(dir, 'locale'), { recursive: true });
  const manifest = { ...base, ...pkg };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), "- insert:\n    - id: foo\n      name: '@team-a/dsh-foo'\n");
  fs.writeFileSync(path.join(dir, 'locale/en.json'), JSON.stringify({ meta: { title: 'Foo', description: 'Adds foo.' } }));
  fs.writeFileSync(path.join(dir, 'locale/zh.json'), JSON.stringify({ meta: { title: 'Foo 工具', description: '增加 foo。' } }));
  fs.writeFileSync(path.join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  const out = path.join(root, 'pkg.tgz');
  tar.c({ gzip: true, file: out, cwd: root, portable: true, sync: true }, ['package']);
  return out;
}

const codes = (r) => r.findings.filter((f) => f.level === 'error').map((f) => f.code);

test('合法组合包通过，且能抽出中英标题与图标', async () => {
  const r = await inspectTarball(makeTarball());
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.equal(r.name, '@team-a/dsh-foo');
  assert.equal(r.version, '1.0.0');
  assert.equal(r.meta.title.zh, 'Foo 工具');
  assert.equal(r.enginesDsh, '>=0.2.2-rc.3 <0.3.0');
  assert.ok(r.icon && r.icon.bytes.length > 0);
  assert.match(r.integrity, /^sha512-/);
});

test('没有 dsh.bundle.patch 的不是组合包', async () => {
  const r = await inspectTarball(makeTarball({ dsh: undefined }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('not-bundle'));
});

test('安装脚本一律拒收', async () => {
  const r = await inspectTarball(makeTarball({ scripts: { postinstall: 'node evil.js' } }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('install-script'));
});

test('包名越界（不在自己的 scope 下）', async () => {
  const r = await inspectTarball(makeTarball(), { scope: '@team-b/' });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('out-of-scope'));
});

test('缺 engines.dsh 会拒收，因为市场算不出兼容性', async () => {
  const r = await inspectTarball(makeTarball({ engines: {} }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('no-engines'));
});

test('SVG 图标带脚本拒收', async () => {
  const r = await inspectTarball(makeTarball({}, { 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('bad-icon'));
});

test('版本不是合法 semver', async () => {
  const r = await inspectTarball(makeTarball({ version: 'v1.0' }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('bad-version'));
});

test('依赖宿主包 @deepseek-ai/* 拒收', async () => {
  const r = await inspectTarball(makeTarball({ dependencies: { '@deepseek-ai/dsh': '0.2.2' } }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('host-dep'));
});
