import fs from 'node:fs';
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4874';
const TGZ = process.argv[2];
const NAME = process.env.LOGIN_NAME ?? 'admin';
const PASSWORD = process.env.LOGIN_PASSWORD;
if (!PASSWORD) {
  console.error('用法: LOGIN_PASSWORD=<口令> node scripts/smoke.mjs <plugin.tgz>');
  process.exit(2);
}

if (!TGZ) {
  console.error('用法: node scripts/smoke.mjs <plugin.tgz>');
  process.exit(1);
}

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const ok = (msg) => console.log(`    ✓ ${msg}`);

step(1, '登录');
const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: NAME, password: PASSWORD }),
});
if (!login.ok) throw new Error(`登录失败 ${login.status}: ${await login.text()}`);
const { token, user } = await login.json();
ok(`${user.name} / ${user.role}`);

step(2, '发布 tarball');
const tgz = fs.readFileSync(TGZ);
const pub = await fetch(`${BASE}/api/v1/releases?category=general`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-labels': 'internal' },
  body: tgz,
});
const pubBody = await pub.json();
if (!pub.ok) throw new Error(`发布失败 ${pub.status}: ${JSON.stringify(pubBody)}`);
ok(`${pubBody.name}@${pubBody.version} → ${pubBody.status}`);

step(3, '待审核列表');
const pending = await (await fetch(`${BASE}/api/v1/releases?status=pending`, { headers: { authorization: `Bearer ${token}` } })).json();
const target = pending.releases.find((r) => r.id === pubBody.id);
ok(`找到 ${target.name}@${target.version}（${target.findings.length} 条 findings）`);

step(4, '上架');
const ap = await fetch(`${BASE}/api/v1/releases/${pubBody.id}/approve`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
if (!ap.ok) throw new Error(`上架失败 ${ap.status}: ${await ap.text()}`);
ok((await ap.json()).status);

step(5, '读索引');
const index = await (await fetch(`${BASE}/api/v1/index.json`)).json();
const entry = index.plugins.find((p) => p.name === pubBody.name);
if (!entry) throw new Error('索引里没有这个插件');
ok(`${entry.title.zh} / 分类 ${entry.metadata.category} / ${entry.versions.length} 个版本`);

step(6, '拉 packument 并校验 tarball 完整性');
const pack = await (await fetch(`${BASE}/registry/${pubBody.name.replace('/', '%2f')}`)).json();
const dist = pack.versions[pubBody.version].dist;
const bin = Buffer.from(await (await fetch(dist.tarball)).arrayBuffer());
const integrity = 'sha512-' + crypto.createHash('sha512').update(bin).digest('base64');
if (integrity !== dist.integrity) throw new Error('integrity 不匹配');
ok(`${bin.length} 字节，sha512 与 packument 一致`);

console.log('\n全部通过：发布 → 审核 → 上架 → 索引 → registry 可安装。');
