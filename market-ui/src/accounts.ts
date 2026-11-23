/**
 * Accounts for private markets.
 *
 * dsh-market reads catalogs from anywhere a URL can point, but until now a
 * catalog that wanted a credential could only get one from an organization's
 * `policy.json` — a user could not add their own private market at all
 * (`UserCatalog` carried no headers). This module is the missing piece: it
 * keeps one bearer token per market origin, the catalog loader injects it, and
 * the login route fills it.
 *
 * Deliberately dumb about persistence. The tokens live in the profile's market
 * state (see `hot.ts`) and are seeded here at boot and after every mutation,
 * because this module is imported by `catalogs.ts`, which `hot.ts` already
 * imports — reading the state file from here would close that cycle.
 *
 * Nothing here is ever sent to the browser: `listAccounts` returns origins and
 * user names, never tokens.
 */

import { marketFetch } from './net.ts'

/** What a successful login left behind for one market origin. */
export interface MarketAccount {
  /** Bearer token, as issued by the market's `/api/v1/auth/login`. */
  token: string
  /** Display name of the account, for the UI only. */
  user: string
  /** Role the market reported ('admin' | 'publisher' | ...), for the UI only. */
  role?: string
  /** ISO timestamp of the login that produced this token. */
  at: string
}

export type AccountMap = Record<string, MarketAccount>

/** What `/api/v1/market/info` says about a market. Anonymous by contract. */
export interface MarketInfo {
  name?: string
  requiresAuth: boolean
  authenticated?: boolean
  indexUrl?: string
  version?: string
}

let accounts: AccountMap = {}

/** Called at boot and after every state mutation; the file is the source of truth. */
export function setAccounts(next: AccountMap): void {
  accounts = next
}

/** Origins with a token, for the UI. Never includes the token itself. */
export function listAccounts(): { server: string; user: string; role?: string; at: string }[] {
  return Object.entries(accounts).map(([server, account]) => ({
    server,
    user: account.user,
    ...(account.role === undefined ? {} : { role: account.role }),
    at: account.at,
  }))
}

export function accountFor(url: string): MarketAccount | null {
  const origin = originOf(url)
  if (origin === null) return null
  return accounts[origin] ?? null
}

/**
 * Headers for a catalog request. Empty when the origin has no token, so a
 * public catalog keeps going out anonymously — and so `marketFetch` can still
 * fall back to an `.npmrc` credential when we have none of our own.
 */
export function marketAuthorizationFor(url: string | undefined): Record<string, string> {
  if (url === undefined) return {}
  const account = accountFor(url)
  return account === null ? {} : { authorization: `Bearer ${account.token}` }
}

/** `scheme://host[:port]`, lowercased; null for anything that is not http(s). */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin.toLowerCase()
  } catch {
    return null
  }
}

/** Trim a market address down to its origin, so pasting an index URL still works. */
export function marketOrigin(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const withScheme = /^https?:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`
  return originOf(withScheme)
}

/**
 * Ask a market whether it wants a credential, before anything is saved.
 *
 * Returns null when the address is not one of ours: a plain static catalog has
 * no `/api/v1/market/info` and answers 404, which is a perfectly good answer —
 * it means "add it like before".
 */
/** Probes are cheap but not free; one per origin per half minute is plenty. */
const probeCache = new Map<string, { at: number; info: MarketInfo | null }>()
const PROBE_TTL_MS = 30_000

export async function probeMarket(server: string, signal?: AbortSignal): Promise<MarketInfo | null> {
  const origin = marketOrigin(server)
  if (origin === null) return null
  const cached = probeCache.get(origin)
  if (cached !== undefined && Date.now() - cached.at < PROBE_TTL_MS) return cached.info
  const info = await probeMarketUncached(origin, signal)
  probeCache.set(origin, { at: Date.now(), info })
  return info
}

async function probeMarketUncached(origin: string, signal?: AbortSignal): Promise<MarketInfo | null> {
  let response: Response
  try {
    response = await marketFetch(`${origin}/api/v1/market/info`, {
      ...(signal === undefined ? {} : { signal }),
      headers: { accept: 'application/json', ...marketAuthorizationFor(origin) },
    })
  } catch {
    return null
  }
  if (!response.ok) return null
  const text = await response.text()
  try {
    const doc = JSON.parse(text) as Record<string, unknown>
    if (typeof doc !== 'object' || doc === null) return null
    // Only a market that says so explicitly can force a login. A random JSON
    // endpoint that happens to answer 200 must not lock the market page.
    if (typeof doc.requiresAuth !== 'boolean') return null
    return {
      requiresAuth: doc.requiresAuth,
      ...(typeof doc.name === 'string' ? { name: doc.name } : {}),
      ...(typeof doc.authenticated === 'boolean' ? { authenticated: doc.authenticated } : {}),
      ...(typeof doc.indexUrl === 'string' ? { indexUrl: doc.indexUrl } : {}),
      ...(typeof doc.version === 'string' ? { version: doc.version } : {}),
    }
  } catch {
    return null
  }
}

export interface LoginOutcome {
  server: string
  user: string
  role?: string
  token: string
  at: string
  info: MarketInfo | null
}

/**
 * Exchange a password for a token and keep it.
 *
 * The password is used for exactly one request and never stored — not in the
 * state file, not in a log line. Callers pass it straight from the request.
 */
export async function loginRemote(server: string, name: string, password: string, signal?: AbortSignal): Promise<LoginOutcome> {
  const origin = marketOrigin(server)
  if (origin === null) throw new AccountError('bad-server', '市场地址不对 / invalid market address')
  if (name.trim() === '') throw new AccountError('bad-credentials', '用户名不能为空 / user name is required')
  if (password === '') throw new AccountError('bad-credentials', '密码不能为空 / password is required')

  let response: Response
  try {
    response = await marketFetch(`${origin}/api/v1/auth/login`, {
      ...(signal === undefined ? {} : { signal }),
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name: name.trim(), password }),
    })
  } catch (error) {
    throw new AccountError('network', `连不上这个市场 / cannot reach the market: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  if (!response.ok) {
    let detail = `HTTP ${String(response.status)}`
    try {
      const body = JSON.parse(text) as { error?: unknown }
      if (typeof body.error === 'string') detail = body.error
    } catch { /* not JSON: keep the status */ }
    // 401 here is a wrong password, not a missing feature — say so plainly.
    throw new AccountError(response.status === 401 ? 'bad-credentials' : 'refused', detail)
  }
  let doc: { token?: unknown; user?: { name?: unknown; role?: unknown } }
  try {
    doc = JSON.parse(text) as typeof doc
  } catch {
    throw new AccountError('refused', '市场返回的不是 JSON / the market did not answer with JSON')
  }
  if (typeof doc.token !== 'string' || doc.token === '') {
    throw new AccountError('refused', '市场没有返回 token / the market returned no token')
  }
  const user = typeof doc.user?.name === 'string' ? doc.user.name : name.trim()
  const role = typeof doc.user?.role === 'string' ? doc.user.role : undefined
  const at = new Date().toISOString()
  accounts = { ...accounts, [origin]: { token: doc.token, user, ...(role === undefined ? {} : { role }), at } }
  // The cached probe predates this login; ask again so `authenticated` is true.
  probeCache.delete(origin)
  const info = await probeMarket(origin, signal).catch(() => null)
  return { server: origin, user, ...(role === undefined ? {} : { role }), token: doc.token, at, info }
}

export function forgetAccount(server: string): boolean {
  const origin = marketOrigin(server)
  if (origin === null || accounts[origin] === undefined) return false
  const next = { ...accounts }
  delete next[origin]
  accounts = next
  probeCache.delete(origin)
  return true
}

export class AccountError extends Error {
  constructor(readonly code: 'bad-server' | 'bad-credentials' | 'network' | 'refused', message: string) {
    super(message)
    this.name = 'AccountError'
  }
}
