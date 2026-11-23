import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { parseMarketIndex } from '../vendor/dsh-plugin-market-index.mjs';

// 先定目录，再加载会读取 env 的模块
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-idx-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.SITE_DIR = path.join(tmp, 'site');
process.env.PUBLIC_BASE_URL = 'http://market.test';
process.env.PUBLIC_REGISTRY_URL = 'http://market.test/registry';

const { createUser } = await import('../src/auth.mjs');
const service = await import('../src/service.mjs');
const { q } = await import('../src/db.mjs');

function makeTarball(name = '@team-a/dsh-foo', version = '1.0.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-pk-'));
  const dir = path.join(root, 'package');
  fs.mkdirSync(path.join(dir, 'locale'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name, version, dsh: { bundle: { patch: './cordis.patch.yml' } }, engines: { dsh: '>=0.2.2-rc.3 <0.3.0' },
    description: 'fixture', author: 'tester',
  }));
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), "- insert:\n    - id: foo\n      name: '@team-a/dsh-foo'\n");
  fs.writeFileSync(path.join(dir, 'locale/en.json'), JSON.stringify({ meta: { title: 'Foo', description: 'En desc' } }));
  fs.writeFileSync(path.join(dir, 'locale/zh.json'), JSON.stringify({ meta: { title: 'Foo 工具', description: '中文描述' } }));
  fs.writeFileSync(path.join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>');
  const out = path.join(root, 'p.tgz');
  tar.c({ gzip: true, file: out, cwd: root, portable: true, sync: true }, ['package']);
  return out;
}

const adminId = createUser({ name: 'admin', role: 'admin', scope: '@team-a/', password: 'pw' });
const admin = { id: adminId, role: 'admin', scope: '@team-a/', name: 'admin' };

test('发布 → 上架 → 索引可被官方校验器接受', async () => {
  const res = await service.publishRelease(admin, { tarballPath: makeTarball(), category: 'general' });
  assert.equal(res.status, 'pending');

  // 未上架前不应出现在索引里
  const model0 = service.buildIndexModel();
  assert.equal(model0.plugins.length, 0);

  service.approveRelease(admin, res.id);
  const model = service.buildIndexModel();
  assert.equal(model.plugins.length, 1);
  assert.equal(model.plugins[0].name, '@team-a/dsh-foo');
  assert.equal(model.plugins[0].metadata.category, 'general');
  assert.match(model.plugins[0].icon, /^data:image\/svg\+xml;base64,/);

  // 硬断言：DSH 的校验器必须接受
  const parsed = parseMarketIndex(model, 'http://market.test/api/v1/index.json');
  assert.equal(parsed.plugins[0].versions[0].engines.dsh, '>=0.2.2-rc.3 <0.3.0');
});

test('同版本不可覆盖', async () => {
  await assert.rejects(
    () => service.publishRelease(admin, { tarballPath: makeTarball(), category: 'general' }),
    /已存在/,
  );
});

test('归档分类后，插件自动迁到通用插件，索引仍然合法', async () => {
  const cat = service.createCategory(admin, { id: 'dev', titleEn: 'Development', titleZh: '开发' });
  assert.equal(cat.id, 'dev');

  const res = await service.publishRelease(admin, { tarballPath: makeTarball('@team-a/dsh-bar', '0.3.1'), category: 'dev' });
  service.approveRelease(admin, res.id);
  assert.equal(service.buildIndexModel().plugins.find((p) => p.name === '@team-a/dsh-bar').metadata.category, 'dev');

  const out = service.archiveCategory(admin, 'dev');
  assert.equal(out.moved, 1);

  const model = service.buildIndexModel();
  const moved = model.plugins.find((p) => p.name === '@team-a/dsh-bar');
  assert.equal(moved.metadata.category, 'general');
  assert.ok(model.metadata.categories.general, 'general 必须始终声明');
  assert.ok(!model.metadata.categories.dev, '归档的分类不再声明');
  parseMarketIndex(model, 'http://market.test/api/v1/index.json');
});

test('通用插件分类不可删除', () => {
  assert.throws(() => service.archiveCategory(admin, 'general'), /不能删除/);
});

test('分类绑 scope 后，其它团队发不进去', async () => {
  service.createCategory(admin, { id: 'team-b-only', titleEn: 'B only', titleZh: '仅 B', allowedScopes: ['@team-b/'] });
  const outsider = { id: createUser({ name: 'bob', role: 'publisher', scope: '@team-a/' }), role: 'publisher', scope: '@team-a/', name: 'bob' };
  await assert.rejects(
    () => service.publishRelease(outsider, { tarballPath: makeTarball('@team-a/dsh-baz', '1.0.0'), category: 'team-b-only' }),
    /只允许/,
  );
});

test('下架后索引里消失，包仍在库里', async () => {
  const rel = q.get("SELECT r.id FROM releases r JOIN plugins p ON p.id=r.plugin_id WHERE p.name = '@team-a/dsh-foo'");
  service.yankRelease(admin, rel.id);
  const model = service.buildIndexModel();
  assert.equal(model.plugins.some((p) => p.name === '@team-a/dsh-foo'), false);
  assert.ok(q.get("SELECT id FROM releases WHERE id = ?", rel.id), '记录保留');
});

test('渲染结果随数据变化，不能因为缓存而钉死', async () => {
  // 线上踩过的坑：renderFormat1 直接命中缓存就返回，版本比对永远走不到，
  // 于是同一进程内上架/下架后索引还是旧的（CLI 在另一个进程改数据时反而正常）。
  const { renderFormat1, renderCatalog } = await import('../src/index-format.mjs');
  const before = renderFormat1();
  const beforeCatalog = renderCatalog();
  assert.equal(JSON.parse(before.body).plugins.some((p) => p.name === '@team-a/dsh-foo'), false, '此时是下架状态');

  // 重新上架同一版本，数据签名应当变化 → 渲染结果跟着变
  const rel = q.get("SELECT r.id FROM releases r JOIN plugins p ON p.id=r.plugin_id WHERE p.name = '@team-a/dsh-foo'");
  q.run("UPDATE releases SET status = 'published', yanked_at = NULL, published_at = ? WHERE id = ?", new Date().toISOString(), rel.id);

  const after = renderFormat1();
  assert.notEqual(after.etag, before.etag, 'etag 必须变');
  assert.equal(JSON.parse(after.body).plugins.some((p) => p.name === '@team-a/dsh-foo'), true);
  assert.notEqual(renderCatalog().etag, beforeCatalog.etag, 'catalog 也要跟着变');
});
