import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { config } from './config.mjs';
import { q, now, uid, audit } from './db.mjs';
import { inspectTarball } from './manifest.mjs';
import { canCreateCategory, isAdmin } from './auth.mjs';
import { parseMarketIndex } from '../vendor/dsh-plugin-market-index.mjs';

const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const slug = (name) => name.replace(/^@/, '').replaceAll('/', '__');
const safeFile = (s) => s.replace(/[^a-zA-Z0-9._@-]/g, '_');

/* ---------------------------------- 分类 ---------------------------------- */

export function listCategories({ includeArchived = false } = {}) {
  const sql = includeArchived
    ? 'SELECT * FROM categories ORDER BY is_default DESC, sort, id'
    : "SELECT * FROM categories WHERE status = 'active' ORDER BY is_default DESC, sort, id";
  return q.all(sql).map((c) => ({ ...c, allowed_scopes: JSON.parse(c.allowed_scopes || '[]'), is_default: !!c.is_default }));
}

export function createCategory(actor, { id, titleEn, titleZh, sort = 100, allowedScopes = [] }) {
  if (!canCreateCategory(actor)) throw httpError(403, '没有创建分类的权限');
  if (!titleEn || !titleZh) throw httpError(400, '分类必须同时提供中英文标题');
  const cid = id ?? titleEn.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(cid)) throw httpError(400, `分类 id 非法：${cid}`);
  if (q.get('SELECT id FROM categories WHERE id = ?', cid)) throw httpError(409, `分类 ${cid} 已存在`);
  for (const s of allowedScopes) {
    if (!/^@[a-z0-9][\w.-]*\/$/.test(s)) throw httpError(400, `scope 形如 @team-a/：${s}`);
  }
  q.run('INSERT INTO categories (id, title_en, title_zh, sort, is_default, status, allowed_scopes, created_by, created_at) VALUES (?,?,?,?,0,\'active\',?,?,?)',
    cid, titleEn, titleZh, Number(sort), JSON.stringify(allowedScopes), actor.id, now());
  audit(actor.id, 'category.create', cid, { titleEn, titleZh, allowedScopes });
  return getCategory(cid);
}

export function getCategory(id) {
  const row = q.get('SELECT * FROM categories WHERE id = ?', id);
  return row ? { ...row, allowed_scopes: JSON.parse(row.allowed_scopes || '[]'), is_default: !!row.is_default } : null;
}

export function updateCategory(actor, id, patch) {
  const cat = getCategory(id);
  if (!cat) throw httpError(404, '分类不存在');
  if (!isAdmin(actor) && cat.created_by !== actor.id) throw httpError(403, '只有创建者或管理员能改分类');
  if (patch.id && patch.id !== id) throw httpError(400, '分类 id 不可修改');
  const next = {
    title_en: patch.titleEn ?? cat.title_en,
    title_zh: patch.titleZh ?? cat.title_zh,
    sort: patch.sort ?? cat.sort,
    allowed_scopes: patch.allowedScopes ?? cat.allowed_scopes,
  };
  q.run('UPDATE categories SET title_en = ?, title_zh = ?, sort = ?, allowed_scopes = ? WHERE id = ?',
    next.title_en, next.title_zh, Number(next.sort), JSON.stringify(next.allowed_scopes), id);
  audit(actor.id, 'category.update', id, next);
  return getCategory(id);
}

/** 归档 = 软删除：该分类下的插件迁到 general。 */
export function archiveCategory(actor, id) {
  const cat = getCategory(id);
  if (!cat) throw httpError(404, '分类不存在');
  if (cat.is_default) throw httpError(400, '通用插件是兜底分类，不能删除');
  if (!isAdmin(actor)) throw httpError(403, '只有管理员能归档分类');
  const moved = q.all('SELECT id, name FROM plugins WHERE category_id = ?', id);
  q.exec('BEGIN');
  try {
    q.run("UPDATE plugins SET category_id = ? WHERE category_id = ?", config.defaultCategory, id);
    q.run("UPDATE categories SET status = 'archived' WHERE id = ?", id);
    q.exec('COMMIT');
  } catch (e) {
    q.exec('ROLLBACK');
    throw e;
  }
  audit(actor.id, 'category.archive', id, { moved: moved.map((m) => m.name) });
  return { archived: id, moved: moved.length, movedPlugins: moved.map((m) => m.name) };
}

function assertCategoryUsable(cat, actor) {
  if (!cat) throw httpError(400, '分类不存在');
  if (cat.status !== 'active') throw httpError(400, '分类已归档');
  if (isAdmin(actor)) return;
  if (!cat.allowed_scopes.length) return;
  if (!actor.scope || !cat.allowed_scopes.includes(actor.scope)) {
    throw httpError(403, `分类「${cat.title_zh}」只允许 ${cat.allowed_scopes.join('、')} 发布`);
  }
}

/* ---------------------------------- 发布 ---------------------------------- */

export async function publishRelease(actor, { tarballPath, category = config.defaultCategory, labels = [], source = 'upload' }) {
  const scope = isAdmin(actor) ? null : actor.scope;
  const info = await inspectTarball(tarballPath, { scope });
  if (!info.ok) {
    const errs = info.findings.filter((f) => f.level === 'error');
    throw httpError(400, '包校验未通过', errs);
  }

  const cat = getCategory(category);
  assertCategoryUsable(cat, actor);

  for (const id of labels) {
    if (!q.get('SELECT id FROM labels WHERE id = ?', id)) throw httpError(400, `标签 ${id} 不存在`);
  }

  const existingPlugin = q.get('SELECT * FROM plugins WHERE name = ?', info.name);
  const pluginId = existingPlugin?.id ?? uid('p_');
  if (existingPlugin && q.get('SELECT id FROM releases WHERE plugin_id = ? AND version = ?', pluginId, info.version)) {
    throw httpError(409, `${info.name}@${info.version} 已存在，版本不可覆盖`);
  }

  // 落盘 tarball + 图标
  const destDir = path.join(config.dataDir, 'tarballs', safeFile(slug(info.name)));
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `${info.version}.tgz`);
  fs.copyFileSync(tarballPath, dest);

  const releaseId = uid('r_');
  let iconPath = null;
  if (info.icon) {
    iconPath = path.join(config.dataDir, 'icons', `${releaseId}${info.icon.ext}`);
    fs.mkdirSync(path.dirname(iconPath), { recursive: true });
    fs.writeFileSync(iconPath, info.icon.bytes);
  }

  const manifest = { ...info.pkg, meta: info.meta };

  q.exec('BEGIN');
  try {
    if (!existingPlugin) {
      q.run('INSERT INTO plugins (id, name, category_id, owner_id, created_at) VALUES (?,?,?,?,?)',
        pluginId, info.name, category, actor.id, now());
    } else if (category !== existingPlugin.category_id) {
      q.run('UPDATE plugins SET category_id = ? WHERE id = ?', category, pluginId);
      audit(actor.id, 'plugin.recategorize', info.name, { from: existingPlugin.category_id, to: category });
    }

    q.run(`INSERT INTO releases (id, plugin_id, version, status, engines_dsh, sha512, integrity, bytes, tarball_path, icon_path, manifest, findings, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      releaseId, pluginId, info.version, 'pending', info.enginesDsh, info.sha512, info.integrity, info.bytes,
      dest, iconPath, JSON.stringify(manifest), JSON.stringify(info.findings), actor.id, now());

    if (labels.length) setPluginLabels(actor, info.name, labels);
    audit(actor.id, 'release.publish', `${info.name}@${info.version}`, { category, source, findings: info.findings.length });
    q.exec('COMMIT');
  } catch (e) {
    q.exec('ROLLBACK');
    fs.rmSync(iconPath ?? '', { force: true });
    throw e;
  }

  return { id: releaseId, name: info.name, version: info.version, status: 'pending', findings: info.findings };
}

export function setPluginLabels(actor, name, labelIds) {
  const plugin = q.get('SELECT id FROM plugins WHERE name = ?', name);
  if (!plugin) throw httpError(404, '插件不存在');
  for (const id of labelIds) {
    if (!q.get('SELECT id FROM labels WHERE id = ?', id)) throw httpError(400, `标签 ${id} 不存在`);
  }
  q.run('DELETE FROM plugin_labels WHERE plugin_id = ?', plugin.id);
  for (const id of labelIds) q.run('INSERT OR IGNORE INTO plugin_labels (plugin_id, label_id) VALUES (?,?)', plugin.id, id);
  audit(actor.id, 'plugin.label', name, { labels: labelIds });
}

/* ---------------------------------- 插件 ---------------------------------- */

/** 改分类 / 改标签：只动市场元数据，不碰包体，也不用重新发版。 */
export function updatePlugin(actor, name, patch) {
  const plugin = q.get('SELECT * FROM plugins WHERE name = ?', name);
  if (!plugin) throw httpError(404, '插件不存在');
  if (!isAdmin(actor) && plugin.owner_id !== actor.id) throw httpError(403, '只有包所有者或管理员能改');

  if (patch.category && patch.category !== plugin.category_id) {
    const cat = getCategory(patch.category);
    assertCategoryUsable(cat, actor);
    q.run('UPDATE plugins SET category_id = ? WHERE id = ?', patch.category, plugin.id);
    audit(actor.id, 'plugin.recategorize', name, { from: plugin.category_id, to: patch.category });
  }
  if (Array.isArray(patch.labels)) setPluginLabels(actor, name, patch.labels);

  try {
    rebuildIndex();
  } catch (e) {
    throw httpError(500, `索引生成失败：${e.message}`);
  }
  return getPlugin(name);
}

export function getPlugin(name) {
  const row = q.get('SELECT * FROM plugins WHERE name = ?', name);
  if (!row) return null;
  const labels = q.all('SELECT label_id FROM plugin_labels WHERE plugin_id = ?', row.id).map((r) => r.label_id);
  const versions = q.all('SELECT version, status FROM releases WHERE plugin_id = ? ORDER BY created_at DESC', row.id);
  return { name: row.name, category: row.category_id, labels, versions };
}

/* ---------------------------------- 审核 ---------------------------------- */

export function listReleases(status) {
  const sql = `SELECT r.*, p.name, u.name AS creator_name
                 FROM releases r JOIN plugins p ON p.id = r.plugin_id
                 LEFT JOIN users u ON u.id = r.created_by
               ${status ? 'WHERE r.status = ?' : ''} ORDER BY r.created_at DESC`;
  return q.all(sql, ...(status ? [status] : [])).map((r) => ({
    id: r.id, name: r.name, version: r.version, status: r.status, bytes: r.bytes,
    enginesDsh: r.engines_dsh, createdAt: r.created_at, publishedAt: r.published_at,
    createdBy: r.creator_name ?? r.created_by, rejectReason: r.reject_reason, findings: r.findings ? JSON.parse(r.findings) : [],
    meta: JSON.parse(r.manifest).meta,
  }));
}

export function approveRelease(actor, id) {
  if (!isAdmin(actor)) throw httpError(403, '只有管理员能上架');
  const rel = q.get('SELECT * FROM releases WHERE id = ?', id);
  if (!rel) throw httpError(404, '版本不存在');
  if (rel.status !== 'pending') throw httpError(400, `当前状态 ${rel.status}，不能上架`);
  q.run("UPDATE releases SET status = 'published', published_at = ?, reviewed_by = ? WHERE id = ?", now(), actor.id, id);
  try {
    rebuildIndex();
  } catch (e) {
    q.run("UPDATE releases SET status = 'pending', published_at = NULL, reviewed_by = NULL WHERE id = ?", id);
    throw httpError(500, `索引生成失败，已回滚上架：${e.message}`);
  }
  audit(actor.id, 'release.approve', id, { version: rel.version });
  return { id, status: 'published' };
}

export function rejectRelease(actor, id, reason) {
  if (!isAdmin(actor)) throw httpError(403, '只有管理员能拒绝');
  const rel = q.get('SELECT * FROM releases WHERE id = ?', id);
  if (!rel) throw httpError(404, '版本不存在');
  if (rel.status !== 'pending') throw httpError(400, `当前状态 ${rel.status}，不能拒绝`);
  q.run("UPDATE releases SET status = 'rejected', reject_reason = ?, reviewed_by = ? WHERE id = ?", reason ?? '', actor.id, id);
  audit(actor.id, 'release.reject', id, { reason });
  return { id, status: 'rejected' };
}

export function yankRelease(actor, id) {
  if (!isAdmin(actor)) throw httpError(403, '只有管理员能下架');
  const rel = q.get('SELECT * FROM releases WHERE id = ?', id);
  if (!rel) throw httpError(404, '版本不存在');
  if (rel.status !== 'published') throw httpError(400, `当前状态 ${rel.status}，不能下架`);
  q.run("UPDATE releases SET status = 'yanked', yanked_at = ? WHERE id = ?", now(), id);
  try {
    rebuildIndex();
  } catch (e) {
    q.run("UPDATE releases SET status = 'published', yanked_at = NULL WHERE id = ?", id);
    throw httpError(500, `索引生成失败，已回滚下架：${e.message}`);
  }
  audit(actor.id, 'release.yank', id, {});
  rebuildIndex();
  return { id, status: 'yanked' };
}

/* --------------------------------- 索引生成 -------------------------------- */

export function buildIndexModel() {
  const categories = q.all("SELECT * FROM categories WHERE status = 'active' ORDER BY is_default DESC, sort, id");
  const labels = q.all('SELECT * FROM labels ORDER BY id');

  const rows = q.all(`
    SELECT p.name, p.category_id, r.version, r.manifest, r.icon_path, r.published_at, r.engines_dsh
      FROM plugins p JOIN releases r ON r.plugin_id = p.id
     WHERE r.status = 'published'
     ORDER BY p.name, r.version`);

  const byPlugin = new Map();
  for (const row of rows) {
    const info = JSON.parse(row.manifest);
    if (!byPlugin.has(row.name)) byPlugin.set(row.name, { row, info, versions: [] });
    byPlugin.get(row.name).versions.push({ version: row.version, info, iconPath: row.icon_path, publishedAt: row.published_at, enginesDsh: row.engines_dsh });
  }

  const plugins = [];
  for (const [name, entry] of byPlugin) {
    const versions = entry.versions
      .filter((v) => semver.valid(v.version))
      .sort((a, b) => semver.rcompare(a.version, b.version));
    if (!versions.length) continue;
    const latest = versions[0];
    const pluginLabels = q.all('SELECT label_id FROM plugin_labels pl JOIN plugins p ON p.id = pl.plugin_id WHERE p.name = ?', name).map((r) => r.label_id);
    const meta = latest.info.meta ?? { title: { en: name, zh: name }, description: { en: '', zh: '' } };
    const rawAuthor = latest.info.author;
    const author = typeof rawAuthor === 'string' ? rawAuthor : rawAuthor?.name;
    const item = {
      name,
      title: meta.title,
      description: meta.description,
      metadata: {
        category: entry.row.category_id,
        keywords: latest.info.keywords ?? [],
        labels: pluginLabels,
        sortKeys: {},
      },
      versions: versions.map((v) => ({
        version: v.version,
        publishTimestamp: Math.floor(new Date(v.publishedAt ?? Date.now()).getTime() / 1000),
        source: { type: 'npm', registry: config.publicRegistryUrl },
        engines: { dsh: v.enginesDsh },
      })),
    };
    const repoUrl = typeof latest.info.repository === 'string' ? latest.info.repository : latest.info.repository?.url;
    if (repoUrl && /^https?:\/\//.test(repoUrl)) item.repository = { url: repoUrl.replace(/\.git$/, '') };
    if (typeof latest.info.homepage === 'string' && /^https?:\/\//.test(latest.info.homepage)) item.homepage = latest.info.homepage;
    // 关键：author 有值才写键。缺了就干脆不加，绝不能留 undefined（校验器"字段存在即校验"）
    if (author && String(author).trim()) item.author = String(author).trim();
    const icon = iconFor(name, latest.iconPath);
    if (icon) item.icon = icon;
    plugins.push(item);
  }

  return {
    format: 1,
    title: { en: 'Team plugins', zh: '团队插件' },
    description: { en: 'Internal DSH bundles approved by the team.', zh: '团队审核通过的 DSH 组合包。' },
    metadata: {
      categories: Object.fromEntries(categories.map((c) => [c.id, { title: { en: c.title_en, zh: c.title_zh } }])),
      labels: Object.fromEntries(labels.map((l) => [l.id, { title: { en: l.title_en, zh: l.title_zh } }])),
      sortKeys: {},
    },
    plugins,
  };
}

function iconFor(name, iconPath) {
  if (!iconPath || !fs.existsSync(iconPath)) return null;
  const ext = path.extname(iconPath).toLowerCase();
  const bytes = fs.readFileSync(iconPath);
  if (bytes.length <= 16 * 1024) return `data:${MIME[ext] ?? 'image/svg+xml'};base64,${bytes.toString('base64')}`;
  const file = `${safeFile(slug(name))}${ext}`;
  fs.mkdirSync(path.join(config.siteDir, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(config.siteDir, 'icons', file), bytes);
  return `icons/${file}`;
}

/** 生成并校验索引；校验不通过直接抛错，绝不写出会被 DSH 拒绝的文件。 */
export function rebuildIndex() {
  const model = buildIndexModel();
  const url = `${config.publicBaseUrl}/api/v1/index.json`;
  // 硬断言：用 DSH 自带的校验器过一遍
  parseMarketIndex(model, url);
  fs.mkdirSync(config.siteDir, { recursive: true });
  const out = path.join(config.siteDir, 'index.json');
  fs.writeFileSync(out, JSON.stringify(model, null, 2) + '\n');
  return { path: out, plugins: model.plugins.length, url };
}

export function httpError(status, message, detail) {
  const e = new Error(message);
  e.status = status;
  e.detail = detail;
  return e;
}
