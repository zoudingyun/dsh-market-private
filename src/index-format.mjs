import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { buildIndexModel, getIndexVersion, dataSignature } from './service.mjs';
import { sourceStatus } from './sources.mjs';
import { parseMarketIndex } from '../vendor/dsh-plugin-market-index.mjs';

/**
 * 索引渲染：同一份数据模型，按请求渲染成不同格式。
 *   format1 → DSH 原生「发现」页 / plugin_market 工具
 *   catalog → dsh-market 那套 awesome 形状（plugins[] 每条必须有 url + category）
 *
 * 缓存键是 service 里的 indexVersion：上架/下架/改分类会 +1，缓存自然失效。
 */
const cache = { version: -1, format1: null, catalog: null, icons: null };

/**
 * 缓存键：进程内计数 + 数据签名 + 外部源时间戳。
 *
 * 必须在**每次渲染前**比对，不能只在下游重建时比对 —— 之前就是这样漏的：
 * 渲染函数先命中 `cache.format1` 直接返回，永远走不到比对那一步，于是上架/
 * 下架在同一进程内不生效，直到重启（CLI 在另一个进程改数据时看着正常）。
 */
function fresh() {
  const version = `${getIndexVersion()}|${dataSignature()}|${sourceStatus().at}`;
  if (cache.version !== version) {
    cache.version = version;
    cache.format1 = null;
    cache.catalog = null;
    cache.icons = null;
  }
}


/** format 1：硬断言，绝不返回 DSH 会拒绝的文档 */
export function renderFormat1() {
  fresh();
  if (cache.format1) return cache.format1;
  const doc = buildIndexModel();
  parseMarketIndex(doc, `${config.publicBaseUrl}/api/v1/index.json`);
  const body = JSON.stringify(doc, null, 2) + '\n';
  cache.format1 = { body, etag: etagOf(body) };
  return cache.format1;
}

/** awesome 形状：dsh-market / 任何按该形状实现的市场都能直接消费 */
export function renderCatalog() {
  fresh();
  if (cache.catalog) return cache.catalog;
  const doc = buildIndexModel();
  const plugins = doc.plugins.map((p) => {
    const repo = p.repository?.url;
    const owner = p.name.startsWith('@') ? p.name.slice(1).split('/')[0] : (p.author ?? 'unknown');
    return {
      name: p.name,
      owner,
      // 人类可读的名字：dsh-market 的卡片标题只认 `name`（包名），中英标题靠
      // 这个字段带给客户端（fork 已改渲染优先取它）。上游不认也不会出错。
      ...(p.title ? { title: p.title } : {}),
      // dsh-market 要求 url 是 http(s)：优先仓库地址，没有就给市场详情页
      url: repo ?? `${config.publicBaseUrl}/p/${encodeURIComponent(p.name)}`,
      category: [p.metadata?.category ?? 'general'],
      description: p.description ?? { zh: '', en: '' },
      npm: p.name,
      /**
       * 包文件的绝对地址。装了本市场的 fork 会优先用它安装（见 `installTargetFor`）：
       * 用包名安装要先去问 registry，而内网客户端默认问的是公网镜像——私有版本
       * 在那里不存在，于是「装 A 却报 B 找不到」。给地址就绕开了整个 registry 解析。
       */
      registryTarball: true,
      tarball: `${config.publicRegistryUrl}/${p.name}/-/${p.name.startsWith('@') ? p.name.split('/')[1] : p.name}-${p.versions[0].version}.tgz`,
      // 图标统一走接口的绝对地址：base64 data URL 会被客户端的安全校验丢掉，
      // 而相对路径只有本市场自己的索引能用。
      ...(p.icon ? { icon: `${config.publicBaseUrl}/api/v1/plugins/${encodeURIComponent(p.name)}/icon` } : {}),
      ...(p.homepage ? { homepage: p.homepage } : {}),
      keywords: p.metadata?.keywords ?? [],
      versions: p.versions.map((v) => v.version),
    };
  });
  const body = JSON.stringify({
    updated: new Date().toISOString(),
    count: plugins.length,
    categories: Object.fromEntries(
      Object.entries(doc.metadata.categories).map(([id, c]) => [id, { zh: c.title.zh, en: c.title.en }]),
    ),
    labels: doc.metadata.labels,
    plugins,
  }, null, 2) + '\n';
  cache.catalog = { body, etag: etagOf(body) };
  return cache.catalog;
}

function etagOf(text) {
  return '"' + crypto.createHash('sha1').update(text).digest('base64url').slice(0, 20) + '"';
}

/** 把最新结果落一份静态文件：nginx 直出/排查用，也作为接口故障时的兜底 */
export function writeStatic() {
  const { body } = renderFormat1();
  fs.mkdirSync(config.siteDir, { recursive: true });
  fs.writeFileSync(path.join(config.siteDir, 'index.json'), body);
  return { plugins: JSON.parse(body).plugins.length };
}

export { etagOf };
