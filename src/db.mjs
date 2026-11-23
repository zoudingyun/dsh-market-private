import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, ensureDirs } from './config.mjs';

let db;

export const now = () => new Date().toISOString();
export const uid = (prefix = '') => prefix + crypto.randomUUID().replaceAll('-', '').slice(0, 24);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL,
  scope TEXT,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  title_en TEXT NOT NULL,
  title_zh TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 100,
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  allowed_scopes TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  title_en TEXT NOT NULL,
  title_zh TEXT NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  category_id TEXT NOT NULL,
  owner_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_labels (
  plugin_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (plugin_id, label_id)
);
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  engines_dsh TEXT,
  sha512 TEXT NOT NULL,
  integrity TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  tarball_path TEXT NOT NULL,
  icon_path TEXT,
  manifest TEXT NOT NULL,
  findings TEXT,
  reject_reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  reviewed_by TEXT,
  yanked_at TEXT,
  UNIQUE (plugin_id, version)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_releases_status ON releases (status);
`;

export function openDb(file = path.join(config.dataDir, 'market.db')) {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

function migrate(conn) {
  const cols = conn.prepare('PRAGMA table_info(tokens)').all().map((c) => c.name);
  if (!cols.includes('label')) conn.exec('ALTER TABLE tokens ADD COLUMN label TEXT');
}

function seed(conn) {
  const general = conn.prepare('SELECT id FROM categories WHERE id = ?').get('general');
  if (!general) {
    conn.prepare(
      `INSERT INTO categories (id, title_en, title_zh, sort, is_default, status, allowed_scopes, created_by, created_at)
       VALUES ('general', 'General', '通用插件', 0, 1, 'active', '[]', 'system', ?)`,
    ).run(now());
  }
}

export const q = {
  run(sql, ...params) {
    return openDb().prepare(sql).run(...params);
  },
  get(sql, ...params) {
    return openDb().prepare(sql).get(...params);
  },
  all(sql, ...params) {
    return openDb().prepare(sql).all(...params);
  },
  exec(sql) {
    return openDb().exec(sql);
  },
};

export function audit(actor, action, target, detail) {
  q.run('INSERT INTO audit (id, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)',
    uid('a_'), actor ?? null, action, target ?? null, detail ? JSON.stringify(detail) : null, now());
}

/** 测试用：换一个全新的库 */
export function resetDbForTest() {
  db = undefined;
}
