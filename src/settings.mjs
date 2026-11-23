import { config } from './config.mjs';
import { q, now, audit } from './db.mjs';

/** 默认值来自环境变量；运行时以数据库里的设置为准，管理端可随时改。 */
const DEFAULTS = {
  'upstream.enabled': config.upstream.enabled ? '1' : '0',
  'upstream.url': config.upstream.url,
  'upstream.timeoutMs': String(config.upstream.timeoutMs),
};

export const SETTING_KEYS = Object.keys(DEFAULTS);

export function getSetting(key) {
  const row = q.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : DEFAULTS[key];
}

export function allSettings() {
  const rows = q.all('SELECT key, value, updated_at, updated_by FROM settings');
  const map = Object.fromEntries(rows.map((r) => [r.key, r]));
  return SETTING_KEYS.map((key) => ({
    key,
    value: map[key]?.value ?? DEFAULTS[key],
    updated_at: map[key]?.updated_at ?? null,
    updated_by: map[key]?.updated_by ?? null,
  }));
}

export function setSettings(actor, patch) {
  const unknown = Object.keys(patch).filter((k) => !SETTING_KEYS.includes(k));
  if (unknown.length) throw httpError(400, `未知设置项：${unknown.join('、')}`);
  for (const [key, value] of Object.entries(patch)) {
    const v = String(value);
    if (key === 'upstream.url' && !/^https?:\/\/.+/.test(v)) throw httpError(400, '上游地址必须是 http(s) URL');
    if (key === 'upstream.timeoutMs' && !(Number(v) >= 1000 && Number(v) <= 120000)) throw httpError(400, '超时应在 1000–120000 毫秒之间');
    q.run(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      key, v, actor.id, now());
  }
  audit(actor.id, 'settings.update', Object.keys(patch).join(','), patch);
  return allSettings();
}

/** 每次请求读一次（SQLite 本地读，成本可忽略），改了立即生效 */
export function upstream() {
  return {
    enabled: getSetting('upstream.enabled') === '1',
    url: String(getSetting('upstream.url')).replace(/\/+$/, ''),
    timeoutMs: Number(getSetting('upstream.timeoutMs')) || 20000,
  };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
