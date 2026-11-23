import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import * as tar from 'tar';
import YAML from 'yaml';
import semver from 'semver';
import { config } from './config.mjs';

const ICON_EXT = ['.svg', '.png', '.jpg', '.jpeg', '.webp'];
const BAD_TYPES = new Set(['SymbolicLink', 'Link', 'CharacterDevice', 'BlockDevice', 'FIFO']);
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
const PATCH_FILE = (pkg) => {
  const b = pkg?.dsh?.bundle;
  if (!b) return null;
  const p = b.patch;
  return Array.isArray(p) ? p[0] : p;
};

/** 只列条目，不落盘：用于安全检查 */
async function listEntries(file) {
  const entries = [];
  await tar.t({
    file,
    onentry(entry) {
      entries.push({
        path: entry.path,
        type: entry.type,
        size: entry.size ?? 0,
        linkpath: entry.linkpath,
      });
      entry.resume();
    },
  });
  return entries;
}

export function sha512(buf) {
  return {
    sha512: crypto.createHash('sha512').update(buf).digest('hex'),
    integrity: 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64'),
    shasum: crypto.createHash('sha1').update(buf).digest('hex'),
  };
}

/**
 * 校验一个 npm tarball 是否可作为市场组合包发布。
 * 返回 { ok, findings, ... }，不抛异常；调用方决定是否拒收。
 */
export async function inspectTarball(file, { scope } = {}) {
  const findings = [];
  const err = (code, message, at) => findings.push({ level: 'error', code, message, at });
  const warn = (code, message, at) => findings.push({ level: 'warn', code, message, at });

  const buf = fs.readFileSync(file);
  if (buf.length > config.maxTarballBytes) {
    err('too-large', `tarball 超过 ${config.maxTarballBytes} 字节`, 'tarball');
  }

  let entries = [];
  try {
    entries = await listEntries(file);
  } catch (e) {
    err('bad-tarball', `无法解析 tarball：${e.message}`, 'tarball');
    return { ok: false, findings, name: null, version: null };
  }

  // 1. 结构与体积
  let total = 0;
  for (const e of entries) {
    total += e.size;
    if (e.type && BAD_TYPES.has(e.type)) err('bad-entry', `不允许的条目类型 ${e.type}`, e.path);
    if (e.path.startsWith('/') || e.path.includes('..')) err('path-traversal', '路径非法', e.path);
  }
  if (entries.length > config.maxFiles) err('too-many-files', `文件数 ${entries.length} 超过 ${config.maxFiles}`, 'tarball');
  if (total > config.maxUnpackedBytes) err('too-large', `解包后 ${total} 字节超过上限`, 'tarball');
  if (findings.some((f) => f.level === 'error')) return { ok: false, findings, name: null, version: null, bytes: buf.length };

  // 2. 解开到临时目录（已在上面排除了越界路径与链接）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-'));
  try {
    await tar.x({ file, cwd: tmp, strict: true });
    const pkgDir = path.join(tmp, 'package');
    const pkgFile = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgFile)) {
      err('no-manifest', 'tarball 内缺少 package/package.json', 'package.json');
      return { ok: false, findings, name: null, version: null, bytes: buf.length };
    }
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));

    // 3. 清单
    if (typeof pkg.name !== 'string' || !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(pkg.name)) {
      err('bad-name', 'package.json 的 name 非法', 'package.json#name');
    }
    if (scope && typeof pkg.name === 'string' && !pkg.name.startsWith(scope)) {
      err('out-of-scope', `包名必须位于 ${scope} 之下`, 'package.json#name');
    }
    if (!semver.valid(pkg.version)) err('bad-version', `版本 ${pkg.version} 不是合法 semver`, 'package.json#version');

    const patchRel = PATCH_FILE(pkg);
    if (!patchRel) err('not-bundle', 'package.json 缺少 dsh.bundle.patch，不是组合包', 'package.json#dsh');
    else {
      const patchPath = path.join(pkgDir, patchRel);
      if (!fs.existsSync(patchPath)) err('missing-patch', `patch 文件不存在：${patchRel}`, patchRel);
      else {
        try {
          const doc = YAML.parse(fs.readFileSync(patchPath, 'utf8'));
          const rows = (Array.isArray(doc) ? doc : []).flatMap((x) => x?.insert ?? []);
          if (!rows.length) warn('empty-patch', 'patch 里没有任何 insert 行', patchRel);
          for (const [i, row] of rows.entries()) {
            if (!row?.id) err('bad-patch-row', `第 ${i + 1} 行缺少 id`, patchRel);
            if (!row?.name) err('bad-patch-row', `第 ${i + 1} 行缺少 name`, patchRel);
            else if (typeof row.name === 'string' && row.name.startsWith('.')) {
              const rel = row.name.replace(/^\.\//, '');
              if (!fs.existsSync(path.join(pkgDir, rel))) err('bad-patch-row', `patch 引用的文件不存在：${row.name}`, patchRel);
            }
          }
        } catch (e) {
          err('bad-yaml', `patch 不是合法 YAML：${e.message}`, patchRel);
        }
      }
    }

    // 4. 元数据（市场卡片全靠它）
    const locale = {};
    for (const lang of ['zh', 'en']) {
      const f = path.join(pkgDir, 'locale', `${lang}.json`);
      if (fs.existsSync(f)) {
        try {
          locale[lang] = JSON.parse(fs.readFileSync(f, 'utf8'))?.meta ?? {};
        } catch {
          err('bad-locale', `locale/${lang}.json 不是合法 JSON`, `locale/${lang}.json`);
        }
      }
    }
    const zh = locale.zh ?? {};
    const en = locale.en ?? {};
    if (!zh.title && !en.title) err('no-title', '缺少 locale 里的 meta.title，市场里只能显示包名', 'locale');
    if (!zh.description && !en.description) warn('no-description', '缺少 meta.description，卡片描述会是空的', 'locale');

    // 5. 图标
    const iconField = typeof pkg.icon === 'string' ? pkg.icon : null;
    const iconPath = iconField
      ? path.join(pkgDir, iconField)
      : ICON_EXT.map((e) => path.join(pkgDir, 'icon' + e)).find((p) => fs.existsSync(p));
    let icon = null;
    if (!iconPath || !fs.existsSync(iconPath)) {
      warn('no-icon', '没有图标，市场会显示默认插图', 'icon');
    } else {
      const bytes = fs.readFileSync(iconPath);
      const ext = path.extname(iconPath).toLowerCase();
      if (bytes.length > 256 * 1024) err('icon-too-large', '图标超过 256 KiB', iconPath);
      if (!ICON_EXT.includes(ext)) err('bad-icon', `不支持的图标格式 ${ext}`, iconPath);
      if (ext === '.svg') {
        const text = bytes.toString('utf8');
        if (/<script/i.test(text) || /foreignObject/i.test(text) || /(href|xlink:href)\s*=\s*["']https?:/i.test(text)) {
          err('bad-icon', 'SVG 含脚本、foreignObject 或外链', iconPath);
        }
      }
      icon = { path: iconPath, ext, bytes };
    }

    // 6. 依赖与安装脚本（供应链）
    for (const name of INSTALL_SCRIPTS) {
      if (pkg.scripts?.[name]) err('install-script', `禁止安装脚本 scripts.${name}`, `package.json#scripts.${name}`);
    }
    for (const [dep, spec] of Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) })) {
      if (dep.startsWith('@deepseek-ai/')) err('host-dep', `不要声明宿主包 ${dep}，由 DSH 解析`, 'package.json#dependencies');
      if (/^(git|git\+|file:|link:|https?:|workspace:)/.test(String(spec))) err('bad-dep', `依赖 ${dep} 使用了不可分发的规格 ${spec}`, 'package.json#dependencies');
      if (!semver.validRange(String(spec)) || /[\^~*x]|\s-\s|\|\|/.test(String(spec))) warn('loose-dep', `依赖 ${dep}@${spec} 不是精确版本，内网可能解析到不同副本`, 'package.json#dependencies');
    }

    // 7. engines
    const enginesDsh = pkg.engines?.dsh ?? null;
    if (!enginesDsh) err('no-engines', '缺少 engines.dsh，市场无法判断兼容性', 'package.json#engines.dsh');
    else if (!semver.validRange(String(enginesDsh))) err('bad-engines', `engines.dsh 不是合法范围：${enginesDsh}`, 'package.json#engines.dsh');

    // 8. exports 指向的文件必须存在
    const exportsField = pkg.exports;
    if (exportsField && typeof exportsField === 'object') {
      for (const [key, value] of Object.entries(exportsField)) {
        if (!key.startsWith('.')) continue;
        if (typeof value !== 'string' || value.includes('*')) continue;
        if (!fs.existsSync(path.join(pkgDir, value))) {
          err('bad-exports', `exports["${key}"] 指向的文件不存在：${value}`, `package.json#exports`);
        }
      }
    }

    const hasError = findings.some((f) => f.level === 'error');
    return {
      ok: !hasError,
      findings,
      name: pkg.name ?? null,
      version: pkg.version ?? null,
      enginesDsh,
      bytes: buf.length,
      // 完整 package.json：registry 的 packument 必须原样带上 dependencies/engines，
      // 否则 npm/pnpm 会装出一个缺依赖的树（实测踩过）。
      pkg,
      manifest: {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description ?? null,
        keywords: Array.isArray(pkg.keywords) ? pkg.keywords : [],
        repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? null,
        homepage: pkg.homepage ?? null,
        author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name ?? null,
      },
      meta: {
        title: { en: en.title ?? zh.title ?? pkg.name, zh: zh.title ?? en.title ?? pkg.name },
        description: { en: en.description ?? pkg.description ?? '', zh: zh.description ?? pkg.description ?? '' },
      },
      icon,
      ...sha512(buf),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
