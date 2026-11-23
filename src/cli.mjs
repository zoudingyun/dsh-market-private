import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { config, ensureDirs } from './config.mjs';
import { openDb, q } from './db.mjs';
import { createUser, issueToken } from './auth.mjs';
import {
  publishRelease, approveRelease, rejectRelease, yankRelease, rebuildIndex, listCategories, listReleases,
} from './service.mjs';

ensureDirs();
openDb();

const [cmd, ...rest] = process.argv.slice(2);

function arg(name, fallback = undefined) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
}
const positional = rest.filter((x, i) => !x.startsWith('--') && !(i > 0 && rest[i - 1]?.startsWith('--')));
const userByName = (name) => q.get('SELECT id, name, role, scope FROM users WHERE name = ?', name);

function out(obj) {
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

switch (cmd) {
  case 'user': {
    const [sub, name] = positional;
    if (sub === 'add') {
      const id = createUser({
        name,
        role: arg('role', 'publisher'),
        scope: arg('scope', null),
        password: arg('password', null),
      });
      out({ created: name, id, role: arg('role', 'publisher'), scope: arg('scope', null) });
      if (rest.includes('--token')) out({ token: issueToken(id) });
    } else if (sub === 'list') {
      out(q.all('SELECT name, role, scope, status, created_at FROM users ORDER BY created_at'));
    } else if (sub === 'token') {
      const u = userByName(name);
      if (!u) throw new Error(`没有用户 ${name}`);
      out({ token: issueToken(u.id) });
    } else {
      out('用法: cli.mjs user add <name> [--role admin|publisher|viewer] [--scope @team-a/] [--password xxx] [--token]');
    }
    break;
  }

  case 'index': {
    out(rebuildIndex());
    break;
  }

  case 'categories': {
    out(listCategories({ includeArchived: arg('all') === '1' }));
    break;
  }

  case 'label': {
    const [sub, id] = positional;
    if (sub !== 'add') {
      out(q.all('SELECT id, title_en, title_zh FROM labels ORDER BY id'));
      break;
    }
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(String(id))) throw new Error('标签 id 只能是小写字母、数字、横线');
    q.run('INSERT INTO labels (id, title_en, title_zh, color, created_at) VALUES (?,?,?,?,?)',
      id, arg('en', id), arg('zh', arg('en', id)), arg('color', null), new Date().toISOString());
    out({ created: id });
    break;
  }

  case 'releases': {
    out(listReleases(arg('status')));
    break;
  }

  case 'approve':
  case 'reject':
  case 'yank': {
    const actor = userByName(arg('as', 'admin'));
    if (!actor) throw new Error('需要 --as <管理员用户名>');
    const id = positional[0];
    if (cmd === 'approve') out(approveRelease(actor, id));
    if (cmd === 'yank') out(yankRelease(actor, id));
    if (cmd === 'reject') out(rejectRelease(actor, id, arg('reason', '')));
    break;
  }

  case 'publish': {
    const target = positional[0];
    if (!target) throw new Error('用法: cli.mjs publish <目录|tgz> --as <用户名> [--category general] [--labels a,b]');
    const actor = userByName(arg('as', 'admin'));
    if (!actor) throw new Error('需要 --as <用户名>');
    let tgz = path.resolve(target);
    if (fs.statSync(tgz).isDirectory()) {
      const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-pack-'));
      const r = spawnSync('npm', ['pack', '--pack-destination', dest], { cwd: tgz, encoding: 'utf8', shell: process.platform === 'win32' });
      if (r.status !== 0) throw new Error(`npm pack 失败：${r.stderr || r.stdout}`);
      tgz = path.join(dest, fs.readdirSync(dest).find((f) => f.endsWith('.tgz')));
    }
    const labels = (arg('labels', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const result = await publishRelease(actor, { tarballPath: tgz, category: arg('category', config.defaultCategory), labels, source: 'cli' });
    out(result);
    break;
  }

  default:
    out(`dsh-market cli

  user add <name> [--role admin] [--scope @team-a/] [--password xxx] [--token]
  user list | user token <name>
  publish <目录|tgz> --as <用户名> [--category general] [--labels a,b]
  releases [--status pending]
  approve <releaseId> --as admin | reject <id> --reason "..." | yank <id> --as admin
  categories [--all 1]
  index`);
}
