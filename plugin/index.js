import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Host 半边：给「市场」标签页提供三个能力
 *   - 登录/登出市场（token 只存在 DSH 凭据里，不出现在浏览器）
 *   - 列出本机已装组合包及其源码目录（link: 安装会 realpath 回源码）
 *   - 打包并上传到市场（走 /api/v1/releases，校验与索引在服务端）
 */
export const inject = ['connection', 'credentials', 'pluginManager'];

const NS = 'dsh-market-tab';
const KEY = `${NS}/account`;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const PROFILES_DIR = path.join(os.homedir(), '.dsh', 'profiles');

/**
 * 找组合包的源码目录。顺序：
 *   1. source 是 link: → 直接 realpath 到源码目录（开发态最常见）
 *   2. 已知 profile 根目录（env / cwd / DSH_PROFILE）下的 node_modules
 *   3. 扫 ~/.dsh/profiles/* 兜底（宿主进程里通常没有 DSH_PROFILE_DIR）
 */
function resolvePackageDir(name, source) {
  if (typeof source === 'string' && source.startsWith('link:')) {
    const dir = source.slice(5);
    if (fs.existsSync(path.join(dir, 'package.json'))) return { dir: fs.realpathSync(dir), linked: true };
  }

  const roots = [
    process.env.DSH_PROFILE_DIR,
    process.cwd(),
    process.env.DSH_PROFILE ? path.join(PROFILES_DIR, process.env.DSH_PROFILE) : null,
  ].filter(Boolean);

  try {
    for (const entry of fs.readdirSync(PROFILES_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(PROFILES_DIR, entry.name));
    }
  } catch { /* 没有该目录就算了 */ }

  for (const base of roots) {
    const manifest = path.join(base, 'node_modules', name, 'package.json');
    if (fs.existsSync(manifest)) {
      const real = fs.realpathSync(manifest);
      return { dir: path.dirname(real), linked: real !== manifest };
    }
  }
  return null;
}

function packDirectory(dir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-pack-'));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const run = spawnSync(npm, ['pack', '--pack-destination', tmp, '--json'], {
    cwd: dir,
    encoding: 'utf8',
    // Windows 上 npm 是无扩展名的 shim，必须过 shell
    shell: process.platform === 'win32',
    timeout: 120000,
  });
  if (run.status !== 0) {
    throw new Error(`npm pack 失败：${(run.stderr || run.stdout || '').slice(-400)}`);
  }
  const file = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!file) throw new Error('npm pack 没有产出 tgz');
  return path.join(tmp, file);
}

export async function apply(ctx) {
  const readAccount = async () => {
    const rec = await ctx.credentials.readRecord(KEY);
    return { server: rec?.env?.DSHM_SERVER ?? '', user: rec?.env?.DSHM_USER ?? '', token: rec?.env?.DSHM_TOKEN ?? '' };
  };

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-market',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (request.method === 'GET' && url.searchParams.get('op') === 'session') {
          const account = await readAccount();
          return json({ loggedIn: Boolean(account.token), server: account.server, user: account.user });
        }

        if (request.method === 'GET' && url.searchParams.get('op') === 'installed') {
          const bundles = await ctx.pluginManager.listBundles();
          const items = bundles
            .filter((b) => b.installed && b.availability === 'profile')
            .map((b) => {
              const found = resolvePackageDir(b.name, b.source);
              return {
                name: b.name,
                version: b.version ?? null,
                enabled: Boolean(b.enabled),
                title: typeof b.meta?.title === 'string' ? b.meta.title : b.meta?.title?.zh ?? b.meta?.title?.en ?? null,
                description: b.description ?? null,
                source: b.source ?? null,
                dir: found?.dir ?? null,
                linked: Boolean(found?.linked),
              };
            });
          return json({ installed: items });
        }

        if (request.method !== 'POST') return json({ error: 'unsupported' }, 405);
        const body = JSON.parse((await request.text()) || '{}');

        if (body.action === 'login') {
          const server = String(body.server ?? '').replace(/\/+$/, '');
          if (!/^https?:\/\//.test(server)) return json({ error: '市场地址要以 http(s) 开头' }, 400);
          const res = await fetch(`${server}/api/v1/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: body.name, password: body.password }),
            signal: AbortSignal.timeout(15000),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) return json({ error: data.error ?? `登录失败 ${res.status}` }, res.status);
          await ctx.credentials.modifyRecord(KEY, async () => ({
            kind: 'api-key',
            env: { DSHM_SERVER: server, DSHM_USER: data.user?.name ?? String(body.name), DSHM_TOKEN: data.token },
          }));
          return json({ loggedIn: true, user: data.user?.name ?? body.name, server });
        }

        if (body.action === 'logout') {
          await ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'api-key', env: {} }));
          return json({ loggedIn: false });
        }

        if (body.action === 'publish') {
          const account = await readAccount();
          if (!account.token) return json({ error: '还没登录' }, 401);
          const name = String(body.name ?? '');
          const found = resolvePackageDir(name, body.source);
          if (!found) return json({ error: `找不到 ${name} 的源码目录（可能来自安装镜像）` }, 400);

          const tgz = packDirectory(found.dir);
          try {
            const qs = new URLSearchParams({ category: body.category ?? 'general' });
            const labels = Array.isArray(body.labels) ? body.labels.join(',') : '';
            const res = await fetch(`${account.server}/api/v1/releases?${qs}`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${account.token}`,
                'content-type': 'application/octet-stream',
                ...(labels ? { 'x-labels': labels } : {}),
              },
              body: fs.readFileSync(tgz),
              signal: AbortSignal.timeout(60000),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) return json({ error: data.error ?? `上传失败 ${res.status}`, detail: data.detail ?? null }, res.status);
            return json({ published: data, dir: found.dir, linked: found.linked });
          } finally {
            fs.rmSync(path.dirname(tgz), { recursive: true, force: true });
          }
        }

        return json({ error: 'unknown action' }, 400);
      } catch (e) {
        return json({ error: String(e.message ?? e) }, 500);
      }
    },
  }));
}
