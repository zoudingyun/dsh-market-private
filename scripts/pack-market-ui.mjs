#!/usr/bin/env node
/**
 * 把 market-ui（fork 的 dsh-market）打成一个**能发布到本市场**的包。
 *
 * 为什么不能直接 `npm pack market-ui`：
 *   1. 它有 `scripts.prepare`，而市场禁止安装脚本（内网 install 时不跑任何脚本）；
 *   2. 没有 `engines.dsh`，市场无法判断兼容性，直接拒收；
 *   3. 包名 `dshmarket` 与公共 npm 上的同名包冲突，装进桌面端后容易分不清谁是谁。
 *
 * 这个脚本复制一份「发布视图」出去，只带运行时要的东西（lib / client / locale /
 * patch），改掉上面三处，再 `npm pack`。源码目录不动。
 *
 * 用法：
 *   node scripts/pack-market-ui.mjs                      # @local/dshmarket@1.0.0
 *   node scripts/pack-market-ui.mjs --version 1.0.1
 *   node scripts/pack-market-ui.mjs --name @team-a/dshmarket --no-build
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const source = path.join(repo, 'market-ui');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
/**
 * 包名必须保持 `dshmarket`：浏览器端 bundle 里的模块 id 是硬编码的
 * （`tsdown.config.ts` 的 `const id = 'dshmarket'`，preflight 还断言了这个前缀），
 * 改名会让加载器认不出自己的包，客户端半边直接不挂载（宿主半边却正常）。
 * 私有市场里不需要改名，用版本号区分即可。
 */
const name = arg('name', 'dshmarket');
const version = arg('version', '1.90.0');
const enginesDsh = arg('engines', '>=0.2.2-rc.3 <0.4.0');
if (name !== 'dshmarket') {
  console.warn(`! 包名 ${name} 与客户端 bundle 的模块 id（dshmarket）不一致，浏览器端会加载失败`);
}
const outDir = path.resolve(arg('out', path.join(repo, 'dist')));

if (!fs.existsSync(path.join(source, 'lib')) || !fs.existsSync(path.join(source, 'client', 'client.js'))) {
  console.error('market-ui 还没构建：先跑 `cd market-ui && npm install && npm run build`');
  process.exit(2);
}

if (!has('no-build')) {
  console.log('→ 构建 market-ui');
  const built = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: source, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-pack-'));
const pkgDir = path.join(stage, 'package');
fs.mkdirSync(pkgDir, { recursive: true });

/** 只带运行时需要的文件：源码、测试、构建脚本一律不进包。 */
const INCLUDE = ['lib', 'client', 'locale', 'assets', 'cordis.patch.yml', 'LICENSE', 'UPDATE-API-V1.md', 'README.zh.md', 'README.md'];
for (const item of INCLUDE) {
  const from = path.join(source, item);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(pkgDir, item), { recursive: true });
}

// 1) 去掉安装脚本、补 engines；依赖保持原样（js-yaml / undici 是运行时真需要）
const packed = {
  name,
  version,
  description: `${manifest.description ?? 'DeepSeek Harness plugin market'}（内网 fork：登录 / 鉴权探测 / 发布本机插件）`,
  type: manifest.type,
  main: manifest.main,
  keywords: manifest.keywords,
  license: manifest.license,
  author: manifest.author,
  homepage: manifest.homepage,
  repository: manifest.repository,
  dependencies: manifest.dependencies,
  peerDependencies: manifest.peerDependencies,
  peerDependenciesMeta: manifest.peerDependenciesMeta,
  dsh: manifest.dsh,
  // `exports` 必须原样保留：DSH 靠 `exports["./client"]` 找浏览器端 bundle，
  // 漏了这个键，宿主半边照常起来、客户端半边被静默跳过（表现为市场页整块消失，
  // `/plugins/<name>/client.js` 返回 404）。
  exports: manifest.exports,
  engines: { ...(manifest.engines ?? {}), dsh: enginesDsh },
  files: ['lib', 'client', 'locale', 'assets', 'cordis.patch.yml', 'icon.svg'],
};
// scripts 整个删掉：prepare / prepack 都会被市场拒收，install 时也不需要它们
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(packed, null, 2) + '\n');

// 2) patch 里的模块名必须跟着改名，否则宿主按旧名字找不到包
const patchFile = path.join(pkgDir, 'cordis.patch.yml');
if (fs.existsSync(patchFile)) {
  const text = fs.readFileSync(patchFile, 'utf8').replace(/name:\s*'dshmarket'/g, `name: '${name}'`);
  fs.writeFileSync(patchFile, text);
}

// 市场条目要有图标：用 fork 自己的 logo，缺了会显示默认插图
const logo = path.join(pkgDir, 'assets', 'logo.svg');
if (fs.existsSync(logo)) fs.copyFileSync(logo, path.join(pkgDir, 'icon.svg'));

fs.mkdirSync(outDir, { recursive: true });
const packed1 = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--pack-destination', outDir, '--json'], { cwd: pkgDir, encoding: 'utf8', shell: process.platform === 'win32' });
if (packed1.status !== 0) {
  console.error(packed1.stderr || packed1.stdout);
  process.exit(1);
}
const info = JSON.parse(packed1.stdout.slice(packed1.stdout.indexOf('[')))[0];
const tarball = path.join(outDir, info.filename);
fs.rmSync(stage, { recursive: true, force: true });

console.log(`\n打好了：${tarball}`);
console.log(`  ${name}@${version}  ${(info.size / 1024 / 1024).toFixed(1)} MB  ${info.entryCount} 个文件  engines.dsh=${enginesDsh}`);
console.log('\n发布到本市场：');
console.log(`  node src/cli.mjs publish ${JSON.stringify(tarball)} --as admin --category general`);
