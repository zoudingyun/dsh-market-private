import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import semver from 'semver';
import { config, ensureDirs } from './config.mjs';
import { openDb, q, audit as writeAudit } from './db.mjs';
import { login, userFromToken, isAdmin, listUsers, updateUser, resetPassword, createUser, issueToken, listTokens, revokeToken } from './auth.mjs';
import { allSettings, setSettings, upstream, getSetting } from './settings.mjs';
import { refreshSources, sourceStatus } from './sources.mjs';
import { renderFormat1, renderCatalog } from './index-format.mjs';
import {
  publishRelease, listCategories, createCategory, updateCategory, archiveCategory, listReleases,
  approveRelease, rejectRelease, yankRelease, rebuildIndex, updatePlugin, getPlugin, httpError,
} from './service.mjs';

ensureDirs();
openDb();

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,x-labels',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body, null, 2) : body;
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : 'application/octet-stream',
    'cache-control': 'no-store',
    ...CORS,
    ...headers,
  });
  res.end(payload);
}

const ADMIN_DIR = path.join(config.root, 'src', 'admin');
const ADMIN_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function sendAdminFile(res, name) {
  const file = path.join(ADMIN_DIR, path.basename(name || 'index.html'));
  if (!fs.existsSync(file)) return send(res, 404, { error: 'admin asset not found', name });
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'content-type': ADMIN_MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(fs.readFileSync(file));
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, `请求体超过 ${limit} 字节`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw httpError(400, '请求体不是合法 JSON');
  }
}

function packument(name) {
  const rows = q.all(
    `SELECT r.version, r.integrity, r.sha512, r.manifest, r.engines_dsh, r.created_at
       FROM releases r JOIN plugins p ON p.id = r.plugin_id
      WHERE p.name = ? AND r.status IN ('pending','published')
      ORDER BY r.created_at`,
    name,
  );
  if (!rows.length) return null;
  const versions = {};
  // 标准 packument 带 time：pnpm 的 minimumReleaseAge（供应链策略）靠它判断
  // 版本发布了多久，缺了会报 "missing the time field" 并跳过这项检查。
  const time = {};
  let latest = null;
  for (const r of rows) {
    const info = JSON.parse(r.manifest);
    const short = name.startsWith('@') ? name.split('/')[1] : name;
    versions[r.version] = {
      ...info,
      name,
      version: r.version,
      dist: {
        tarball: `${config.publicRegistryUrl}/${name}/-/${short}-${r.version}.tgz`,
        integrity: r.integrity,
        shasum: crypto.createHash('sha1').update(fs.readFileSync(tarballOf(name, r.version))).digest('hex'),
      },
    };
    time[r.version] = r.created_at;
    if (!latest || semver.gt(r.version, latest)) latest = r.version;
  }
  time.created = time.created ?? rows[0].created_at;
  time.modified = rows[rows.length - 1].created_at;
  return { name, 'dist-tags': { latest }, versions, time, modified: time.modified };
}


const encodeName = (name) => (name.startsWith('@') ? name.replace('/', '%2f') : name);
const packumentCache = new Map();

async function upstreamPackument(name) {
  const up = upstream();
  if (!up.enabled) return null;
  const hit = packumentCache.get(name);
  if (hit && Date.now() - hit.at < 60000) return hit.doc;
  const res = await fetch(`${up.url}/${encodeName(name)}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    signal: AbortSignal.timeout(up.timeoutMs),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const doc = await res.json();
  // 把上游 tarball 指回我们自己的域名，客户端不需要能上公网
  for (const v of Object.values(doc.versions ?? {})) {
    if (v?.dist?.tarball) {
      const file = v.dist.tarball.split('/').pop();
      v.dist.tarball = `${config.publicRegistryUrl}/${name}/-/${file}`;
    }
  }
  packumentCache.set(name, { at: Date.now(), doc });
  return doc;
}

function tarballOf(name, version) {
  const safe = name.replace(/^@/, '').replaceAll('/', '__').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(config.dataDir, 'tarballs', safe, `${version}.tgz`);
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  const auth = () => userFromToken(req.headers.authorization);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  try {
    // ---------- 健康检查 ----------
    if (p === '/api/v1/health') return send(res, 200, { ok: true, mode: 'builtin', version: '0.2.0' });

    // ---------- 市场元信息（永远匿名可读，供客户端探测是否需要登录） ----------
    if (p === '/api/v1/market/info') {
      const requiresAuth = getSetting('market.requireAuth') === '1';
      return send(res, 200, {
        name: '团队插件市场',
        requiresAuth,
        authenticated: Boolean(auth()),
        indexUrl: `${config.publicBaseUrl}/api/v1/index.json`,
        version: '0.3.0',
      });
    }

    // ---------- 索引（静态产物，DSH 直接读这个 URL） ----------
    if (p === '/api/v1/index.json' || p === '/api/v1/catalog.json') {
      if (getSetting('market.requireAuth') === '1' && !auth()) {
        return send(res, 401, { error: '这个市场需要登录后才能读取' });
      }
      const rendered = p === '/api/v1/index.json' ? renderFormat1() : renderCatalog();
      if (req.headers['if-none-match'] === rendered.etag) {
        res.writeHead(304, { etag: rendered.etag, ...CORS });
        return res.end();
      }
      return send(res, 200, rendered.body, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=30',
        etag: rendered.etag,
      });
    }

    // ---------- 图标（索引里的相对路径解析到 /api/v1/icons/） ----------
    if (p.startsWith('/api/v1/icons/')) {
      const file = path.join(config.siteDir, 'icons', path.basename(p));
      if (!fs.existsSync(file)) return send(res, 404, { error: 'icon not found' });
      const ext = path.extname(file).toLowerCase();
      const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext] ?? 'application/octet-stream';
      return send(res, 200, fs.readFileSync(file), { 'content-type': mime, 'cache-control': 'public, max-age=300' });
    }

    // ---------- 登录 / 我是谁 ----------
    if (p === '/api/v1/auth/login' && req.method === 'POST') {
      const { name, password } = await readJson(req);
      const out = login(String(name ?? ''), String(password ?? ''));
      if (!out) return send(res, 401, { error: '用户名或密码错误' });
      return send(res, 200, out);
    }
    if (p === '/api/v1/auth/me') {
      const user = auth();
      if (!user) return send(res, 401, { error: '未登录' });
      return send(res, 200, { user });
    }

    // ---------- 管理端：概览 / 用户 / 审计 ----------
    const adminOnly = () => {
      const user = auth();
      if (!user) { send(res, 401, { error: '未登录' }); return null; }
      if (!isAdmin(user)) { send(res, 403, { error: '仅管理员可访问' }); return null; }
      return user;
    };

    if (p === '/api/v1/stats') {
      if (!adminOnly()) return;
      return send(res, 200, {
        plugins: q.get('SELECT COUNT(*) AS n FROM plugins').n,
        published: q.get("SELECT COUNT(*) AS n FROM releases WHERE status = 'published'").n,
        pending: q.get("SELECT COUNT(*) AS n FROM releases WHERE status = 'pending'").n,
        categories: q.get("SELECT COUNT(*) AS n FROM categories WHERE status = 'active'").n,
        users: q.get("SELECT COUNT(*) AS n FROM users WHERE status = 'active'").n,
      });
    }

    if (p === '/api/v1/users' && req.method === 'GET') {
      if (!adminOnly()) return;
      return send(res, 200, { users: listUsers() });
    }
    if (p === '/api/v1/users' && req.method === 'POST') {
      const actor = adminOnly();
      if (!actor) return;
      const body = await readJson(req);
      const id = createUser({
        name: String(body.name ?? ''),
        role: body.role ?? 'publisher',
        scope: body.scope || null,
        password: body.password || null,
      });
      const out = { id, name: body.name, role: body.role ?? 'publisher' };
      if (body.withToken) out.token = issueToken(id, 'admin-ui');
      writeAudit(actor.id, 'user.create', body.name, { role: out.role, scope: body.scope ?? null });
      return send(res, 201, out);
    }
    const userMatch = /^\/api\/v1\/users\/(u_[\w]+)(\/token|\/password)?$/.exec(p);
    if (userMatch) {
      const actor = adminOnly();
      if (!actor) return;
      const [, id, action] = userMatch;
      if (!action && req.method === 'PATCH') {
        const out = updateUser(actor, id, await readJson(req));
        writeAudit(actor.id, 'user.update', out.name, {});
        return send(res, 200, out);
      }
      if (action === '/token' && req.method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        const out = { token: issueToken(id, body.label || 'admin-ui') };
        writeAudit(actor.id, 'user.token', id, {});
        return send(res, 200, out);
      }
      if (action === '/password' && req.method === 'POST') {
        const body = await readJson(req);
        const out = resetPassword(actor, id, body.password);
        writeAudit(actor.id, 'user.password', id, {});
        return send(res, 200, out);
      }
    }

    // ---------- 外部源（官方 catalog 等）----------
    if (p === '/api/v1/sources' && req.method === 'GET') {
      const actor = adminOnly();
      if (!actor) return;
      return send(res, 200, sourceStatus());
    }
    if (p === '/api/v1/sources/refresh' && req.method === 'POST') {
      const actor = adminOnly();
      if (!actor) return;
      const out = await refreshSources();
      rebuildIndex();
      return send(res, 200, out);
    }

    // ---------- 设置（上游透传开关等）----------
    if (p === '/api/v1/settings') {
      const actor = adminOnly();
      if (!actor) return;
      if (req.method === 'GET') return send(res, 200, { settings: allSettings() });
      if (req.method === 'PUT') {
        const out = setSettings(actor, await readJson(req));
        packumentCache.clear();
        return send(res, 200, { settings: out });
      }
    }

    // ---------- token 管理 ----------
    if (p === '/api/v1/tokens' && req.method === 'GET') {
      const actor = adminOnly();
      if (!actor) return;
      return send(res, 200, { tokens: listTokens(u.query.userId || null) });
    }
    const tokenMatch = /^\/api\/v1\/tokens\/(t_[\w]+)\/revoke$/.exec(p);
    if (tokenMatch && req.method === 'POST') {
      const actor = adminOnly();
      if (!actor) return;
      const out = revokeToken(actor, tokenMatch[1]);
      writeAudit(actor.id, 'token.revoke', tokenMatch[1], {});
      return send(res, 200, out);
    }

    if (p === '/api/v1/audit') {
      if (!adminOnly()) return;
      const limit = Math.min(Number(u.query.limit ?? 100) || 100, 500);
      return send(res, 200, {
        entries: q.all('SELECT id, actor, action, target, detail, at FROM audit ORDER BY at DESC LIMIT ?', limit),
      });
    }

    // ---------- 分类 ----------
    if (p === '/api/v1/categories' && req.method === 'GET') {
      return send(res, 200, { categories: listCategories({ includeArchived: u.query.all === '1' && isAdmin(auth()) }) });
    }
    if (p === '/api/v1/categories' && req.method === 'POST') {
      const user = auth();
      if (!user) return send(res, 401, { error: '未登录' });
      const body = await readJson(req);
      return send(res, 201, createCategory(user, body));
    }
    const catMatch = /^\/api\/v1\/categories\/([\w-]+)$/.exec(p);
    if (catMatch && req.method === 'PATCH') {
      const user = auth();
      if (!user) return send(res, 401, { error: '未登录' });
      return send(res, 200, updateCategory(user, catMatch[1], await readJson(req)));
    }
    if (catMatch && req.method === 'DELETE') {
      const user = auth();
      if (!user) return send(res, 401, { error: '未登录' });
      return send(res, 200, archiveCategory(user, catMatch[1]));
    }

    // ---------- 标签字典 ----------
    if (p === '/api/v1/labels' && req.method === 'GET') {
      return send(res, 200, { labels: q.all('SELECT id, title_en, title_zh, color FROM labels ORDER BY id') });
    }
    if (p === '/api/v1/labels' && req.method === 'POST') {
      const user = auth();
      if (!user || !isAdmin(user)) return send(res, 403, { error: '只有管理员能维护标签' });
      const { id, titleEn, titleZh, color } = await readJson(req);
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(String(id))) return send(res, 400, { error: '标签 id 非法' });
      q.run('INSERT INTO labels (id, title_en, title_zh, color, created_at) VALUES (?,?,?,?,?)', id, titleEn, titleZh, color ?? null, new Date().toISOString());
      return send(res, 201, { id });
    }

    // ---------- 插件列表（市场页用） ----------
    if (p === '/api/v1/plugins') {
      const user = auth();
      const rows = q.all(`
        SELECT p.name, p.category_id, r.version, r.status, r.manifest
          FROM plugins p JOIN releases r ON r.plugin_id = p.id
         WHERE r.status = 'published' OR (? AND r.created_by = ?)
         ORDER BY p.name, r.version`, user ? 1 : 0, user?.id ?? '');
      const map = new Map();
      for (const row of rows) {
        const info = JSON.parse(row.manifest);
        if (!map.has(row.name)) {
          map.set(row.name, {
            name: row.name,
            category: row.category_id,
            meta: info.meta,
            labels: q.all('SELECT label_id FROM plugin_labels pl JOIN plugins p ON p.id = pl.plugin_id WHERE p.name = ?', row.name).map((r) => r.label_id),
            versions: [],
          });
        }
        map.get(row.name).versions.push({ version: row.version, status: row.status });
      }
      const category = u.query.category;
      const items = [...map.values()].filter((x) => !category || x.category === category);
      return send(res, 200, { plugins: items, categories: listCategories() });
    }

    // ---------- 改插件归属（分类/标签）----------
    const pluginMatch = /^\/api\/v1\/plugins\/(.+)$/.exec(p);
    if (pluginMatch && req.method === 'GET') {
      const one = getPlugin(decodeURIComponent(pluginMatch[1]));
      if (!one) return send(res, 404, { error: '插件不存在' });
      return send(res, 200, one);
    }
    if (pluginMatch && req.method === 'PATCH') {
      const user = auth();
      if (!user) return send(res, 401, { error: '未登录' });
      return send(res, 200, updatePlugin(user, decodeURIComponent(pluginMatch[1]), await readJson(req)));
    }

    // ---------- 发布（原始 tgz，octet-stream） ----------
    if (p === '/api/v1/releases' && req.method === 'POST') {
      const user = auth();
      if (!user) return send(res, 401, { error: '未登录' });
      const body = await readBody(req, config.maxTarballBytes + 1024);
      if (!body.length) return send(res, 400, { error: '没有收到包体' });
      const tmp = path.join(config.dataDir, 'upload.tmp.tgz');
      fs.writeFileSync(tmp, body);
      const labels = String(req.headers['x-labels'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const result = await publishRelease(user, {
        tarballPath: tmp,
        category: String(u.query.category ?? config.defaultCategory),
        labels,
        source: 'upload',
      });
      fs.rmSync(tmp, { force: true });
      return send(res, 201, result);
    }

    // ---------- 审核列表与动作 ----------
    if (p === '/api/v1/releases' && req.method === 'GET') {
      const user = auth();
      if (!user) return send(res, 401, { error: '未登录' });
      const all = listReleases(u.query.status);
      return send(res, 200, { releases: isAdmin(user) ? all : all.filter((r) => r.createdBy === user.id) });
    }
    const relMatch = /^\/api\/v1\/releases\/(r_[\w]+)\/(approve|reject|yank)$/.exec(p);
    if (relMatch && req.method === 'POST') {
      const user = auth();
      if (!user) return send(res, 401, { error: '未登录' });
      const [, id, action] = relMatch;
      if (action === 'approve') return send(res, 200, approveRelease(user, id));
      if (action === 'yank') return send(res, 200, yankRelease(user, id));
      const body = await readJson(req);
      return send(res, 200, rejectRelease(user, id, body.reason));
    }

    // ---------- npm registry：packument + tarball ----------
    if (p.startsWith('/registry/')) {
      const rest = decodeURIComponent(p.slice('/registry/'.length));
      const cut = rest.indexOf('/-/');
      if (cut >= 0) {
        const name = rest.slice(0, cut);
        const file = path.basename(rest.slice(cut + 3));
        const version = file.replace(/\.tgz$/, '').split('-').pop();
        const target = tarballOf(name, version);
        if (!fs.existsSync(target)) {
          const cfgUp = upstream();
          if (!cfgUp.enabled) return send(res, 404, { error: 'tarball not found' });
          const fetched = await fetch(`${cfgUp.url}/${encodeName(name)}/-/${file}`, {
            signal: AbortSignal.timeout(cfgUp.timeoutMs),
          }).catch(() => null);
          if (!fetched || !fetched.ok) return send(res, 404, { error: 'tarball not found' });
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=86400', ...CORS });
          return Readable.fromWeb(fetched.body).pipe(res);
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', ...CORS });
        return fs.createReadStream(target).pipe(res);
      }
      const doc = packument(rest) ?? (await upstreamPackument(rest));
      if (!doc) return send(res, 404, { error: 'package not found' });
      return send(res, 200, doc, { 'cache-control': 'public, max-age=60' });
    }

    // ---------- 插件详情页（catalog 里没有仓库地址时作为 url 落地） ----------
    if (p.startsWith('/p/')) {
      const name = decodeURIComponent(p.slice(3));
      const plugin = getPlugin(name);
      if (!plugin) return send(res, 404, { error: '插件不存在' });
      const published = plugin.versions.filter((v) => v.status === 'published');
      const row = q.get('SELECT manifest FROM releases r JOIN plugins p ON p.id = r.plugin_id WHERE p.name = ? AND r.status = \'published\' ORDER BY r.published_at DESC LIMIT 1', name);
      const meta = row ? JSON.parse(row.manifest).meta : { title: { zh: name, en: name }, description: { zh: '', en: '' } };
      const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(meta.title?.zh || name)}</title>
<style>body{margin:0;background:#f6f7f9;color:#1c1f23;font:14px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 24px}h1{font-size:22px;margin:0 0 6px}.pkg{font-family:ui-monospace,monospace;color:#6b7280;font-size:12px}
.card{background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:18px;margin-top:18px}code{background:#f1f3f5;padding:2px 6px;border-radius:5px}
.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eef0f3}.row:last-child{border:0}.muted{color:#6b7280}</style></head>
<body><main><h1>${esc(meta.title?.zh || meta.title?.en || name)}</h1><div class="pkg">${esc(name)}</div>
<p class="muted">${esc(meta.description?.zh || meta.description?.en || '')}</p>
<div class="card"><strong>已上架版本</strong>
${published.length ? published.map((v) => `<div class="row"><span>${esc(v.version)}</span><span class="muted">${esc(v.status)}</span></div>`).join('') : '<p class="muted">暂无上架版本</p>'}
</div>
<div class="card"><strong>安装</strong><p>在 DSH 的「发现」或市场里搜索 ${esc(meta.title?.zh || name)}；或命令行：</p>
<p><code>npm install ${esc(name)}@${esc(published[0]?.version ?? 'latest')} --registry ${esc(config.publicRegistryUrl)}/</code></p></div>
</main></body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...CORS });
      return res.end(html);
    }

    // ---------- 管理端页面 ----------
    if (p === '/admin' || p === '/admin/') return sendAdminFile(res, 'index.html');
    if (p.startsWith('/admin/')) return sendAdminFile(res, p.slice('/admin/'.length));

    return send(res, 404, { error: 'not found', path: p });
  } catch (e) {
    const status = e.status ?? 500;
    if (status >= 500) console.error(e);
    return send(res, status, { error: e.message, detail: e.detail ?? null });
  }
});

server.listen(config.port, config.host, () => {
  const users = q.get('SELECT COUNT(*) AS n FROM users').n;
  console.log(`dsh-market  http://${config.host}:${config.port}  (管理端 /admin)`);
  console.log(`  registry: builtin  ->  ${config.publicRegistryUrl}`);
  console.log(`  index:    ${config.publicBaseUrl}/api/v1/index.json`);
  console.log(`  auth:     ${getSetting('market.requireAuth') === '1' ? '索引需登录' : '匿名可读'}`);
  if (getSetting('sources.enabled') === '1') {
    refreshSources().then((r) => console.log(`  sources:  ${r.sources.length} 个源 / ${r.plugins} 个外部插件`)).catch(() => {});
  }
  if (!users) console.log('  还没有账号：node src/cli.mjs user add admin --role admin --password <口令> --scope @team-a/');
});
