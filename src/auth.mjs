import crypto from 'node:crypto';
import { q, now, uid } from './db.mjs';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [alg, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  const actual = crypto.scryptSync(password, salt, expected.length, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createUser({ name, role = 'publisher', scope = null, password = null }) {
  if (!['admin', 'publisher', 'viewer'].includes(role)) throw new Error(`未知角色 ${role}`);
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,30})$/.test(name)) throw new Error('用户名只能是 2-31 位小写字母、数字、点、横线');
  if (scope && !/^@[a-z0-9][\w.-]*\/$/.test(scope)) throw new Error('scope 必须形如 @team-a/');
  const id = uid('u_');
  q.run('INSERT INTO users (id, name, role, scope, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?)',
    id, name, role, scope, password ? hashPassword(password) : null, 'active', now());
  return id;
}

export function issueToken(userId, label = 'cli') {
  const plain = 'dshm_' + crypto.randomBytes(24).toString('base64url');
  q.run('INSERT INTO tokens (id, user_id, hash, label, created_at) VALUES (?,?,?,?,?)',
    uid('t_'), userId, sha256(plain), label, now());
  return plain;
}

/** 管理端：列出 token（可按用户过滤），绝不下发 hash */
export function listTokens(userId) {
  const sql = `SELECT t.id, t.user_id, u.name AS user_name, t.label, t.created_at, t.last_used_at, t.revoked_at
                 FROM tokens t JOIN users u ON u.id = t.user_id
                ${userId ? 'WHERE t.user_id = ?' : ''}
                ORDER BY t.created_at DESC`;
  return q.all(sql, ...(userId ? [userId] : []));
}

export function revokeToken(actor, id) {
  const row = q.get('SELECT id, revoked_at FROM tokens WHERE id = ?', id);
  if (!row) throw httpError(404, 'token 不存在');
  if (row.revoked_at) return { id, already: true };
  q.run('UPDATE tokens SET revoked_at = ? WHERE id = ?', now(), id);
  return { id, revokedAt: now() };
}

export function revokeTokens(userId) {
  q.run('UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now(), userId);
}

/** Bearer token → user；失败返回 null */
export function userFromToken(header) {
  const m = /^Bearer\s+(dshm_[\w-]+)$/.exec(header ?? '');
  if (!m) return null;
  const row = q.get(
    `SELECT u.id, u.name, u.role, u.scope, u.status, t.id AS token_id
       FROM tokens t JOIN users u ON u.id = t.user_id
      WHERE t.hash = ? AND t.revoked_at IS NULL`,
    sha256(m[1]),
  );
  if (!row || row.status !== 'active') return null;
  q.run('UPDATE tokens SET last_used_at = ? WHERE id = ?', now(), row.token_id);
  return { id: row.id, name: row.name, role: row.role, scope: row.scope };
}

export function login(name, password) {
  const user = q.get('SELECT * FROM users WHERE name = ? AND status = ?', name, 'active');
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  // 登录不再一刀切作废旧 token：那样在第二台设备登录就会把第一台踢下线。
  // 改成「保留最近 5 个 login token，更早的作废」——记录不会无限膨胀，多设备也能共存。
  q.run(`UPDATE tokens SET revoked_at = ?
          WHERE user_id = ? AND label = 'login' AND revoked_at IS NULL
            AND id NOT IN (
              SELECT id FROM tokens WHERE user_id = ? AND label = 'login' AND revoked_at IS NULL
               ORDER BY created_at DESC LIMIT 4
            )`, now(), user.id, user.id);
  return { user: { id: user.id, name: user.name, role: user.role, scope: user.scope }, token: issueToken(user.id, 'login') };
}

export const isAdmin = (user) => user?.role === 'admin';
export const canPublish = (user) => user?.role === 'admin' || user?.role === 'publisher';
export const canCreateCategory = (user) => canPublish(user);

/* ------------------------------- 管理端用 ------------------------------- */

export function listUsers() {
  return q.all(`SELECT u.id, u.name, u.role, u.scope, u.status, u.created_at,
                       (SELECT COUNT(*) FROM tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS active_tokens
                  FROM users u ORDER BY u.created_at`);
}

export function updateUser(actor, id, patch) {
  const user = q.get('SELECT * FROM users WHERE id = ?', id);
  if (!user) throw httpError(404, '用户不存在');
  if (patch.role && !['admin', 'publisher', 'viewer'].includes(patch.role)) throw httpError(400, '未知角色');
  if (patch.scope && !/^@[a-z0-9][\w.-]*\/$/.test(patch.scope)) throw httpError(400, 'scope 形如 @team-a/');

  // 不许把最后一个可用管理员降级或停用
  const losingAdmin = user.role === 'admin' && ((patch.role && patch.role !== 'admin') || patch.status === 'disabled');
  if (losingAdmin) {
    const others = q.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?", id).n;
    if (!others) throw httpError(400, '至少要保留一个启用状态的管理员');
  }

  q.run('UPDATE users SET role = ?, scope = ?, status = ? WHERE id = ?',
    patch.role ?? user.role, patch.scope === undefined ? user.scope : patch.scope, patch.status ?? user.status, id);
  if (patch.status === 'disabled' || losingAdmin) revokeTokens(id);
  return q.get('SELECT id, name, role, scope, status FROM users WHERE id = ?', id);
}

export function resetPassword(actor, id, password) {
  const user = q.get('SELECT id FROM users WHERE id = ?', id);
  if (!user) throw httpError(404, '用户不存在');
  if (!password || password.length < 6) throw httpError(400, '密码至少 6 位');
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), id);
  revokeTokens(id);
  return { id };
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
