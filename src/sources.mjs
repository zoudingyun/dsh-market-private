import { config } from './config.mjs';
import { getSetting } from './settings.mjs';
import { parseMarketIndex } from '../vendor/dsh-plugin-market-index.mjs';

/**
 * 外部市场源（官方 catalog 或任意 format 1 索引）的透传缓存。
 * 拉取是异步的（刷新时做），索引生成是同步的（只读缓存），避免 async 传染到审核链路。
 */
const cache = { at: 0, entries: [], errors: [], sources: [] };

export const OFFICIAL_INDEX = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json';

function normalize(doc, url) {
  // format 1：直接可用；未来在这里加其它格式的适配（awesome / dsh-index 等）
  if (doc && doc.format === 1) return parseMarketIndex(doc, url);
  throw new Error('不支持的索引格式（只接受 format 1，其它格式的适配待实现）');
}

export async function refreshSources() {
  if (getSetting('sources.enabled') !== '1') {
    Object.assign(cache, { at: Date.now(), entries: [], errors: [], sources: [] });
    return { at: cache.at, sources: [], errors: [], plugins: 0, disabled: true };
  }
  const urls = String(getSetting('sources.urls') ?? '').split(/[\s,]+/).filter(Boolean);
  const errors = [];
  const entries = [];
  const okSources = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(config.upstream.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = normalize(await res.json(), url);
      okSources.push({ url, title: parsed.title, plugins: parsed.plugins.length });
      for (const p of parsed.plugins) {
        entries.push({ ...p, __source: url });
      }
    } catch (e) {
      errors.push({ url, error: String(e.message ?? e) });
    }
  }
  cache.at = Date.now();
  cache.entries = entries;
  cache.errors = errors;
  cache.sources = okSources;
  return { at: cache.at, sources: okSources, errors, plugins: entries.length };
}

export function sourceEntries() {
  return cache.entries;
}

export function sourceStatus() {
  return { at: cache.at, sources: cache.sources, errors: cache.errors, plugins: cache.entries.length };
}
