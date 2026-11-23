import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};

export const config = {
  root,
  port: Number(env('PORT', 4874)),
  host: env('HOST', '0.0.0.0'),
  // 数据目录：sqlite、tarball、图标等
  dataDir: path.resolve(root, env('DATA_DIR', 'data')),
  // 索引静态产物目录（可交给 nginx 直接托管）
  siteDir: path.resolve(root, env('SITE_DIR', 'site')),
  // 公开给客户端的 registry 地址（写进索引的 source.registry）
  publicRegistryUrl: env('PUBLIC_REGISTRY_URL', `http://127.0.0.1:${Number(env('PORT', 4874))}/registry`).replace(/\/+$/, ''),
  publicBaseUrl: env('PUBLIC_BASE_URL', `http://127.0.0.1:${Number(env('PORT', 4874))}`).replace(/\/+$/, ''),
  // 上游代理：本地没有的包（通常是依赖）透明转发到公网镜像。内网纯离线时设 UPSTREAM_ENABLED=0
  upstream: {
    enabled: env('UPSTREAM_ENABLED', '1') !== '0',
    url: env('UPSTREAM_REGISTRY', 'https://registry.npmmirror.com').replace(/\/+$/, ''),
    timeoutMs: Number(env('UPSTREAM_TIMEOUT_MS', 20000)),
  },
  // 市场是否需要登录才能读索引（供客户端探测；默认关，内网匿名可读）
  requireAuth: env('MARKET_REQUIRE_AUTH', '0') === '1',
  maxTarballBytes: Number(env('MAX_TARBALL_BYTES', 20 * 1024 * 1024)),
  maxUnpackedBytes: Number(env('MAX_UNPACKED_BYTES', 100 * 1024 * 1024)),
  maxFiles: Number(env('MAX_FILES', 2000)),
  defaultCategory: 'general',
};

export function ensureDirs() {
  for (const dir of [
    config.dataDir,
    path.join(config.dataDir, 'tarballs'),
    path.join(config.siteDir),
    path.join(config.siteDir, 'icons'),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
