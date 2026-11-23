/**
 * The gate in front of the market page.
 *
 * A private market can answer `/api/v1/market/info` with `requiresAuth: true`,
 * which means its catalog cannot be read anonymously. Rendering the market
 * anyway would show an empty shelf and a wall of "could not read the catalog"
 * errors, so the page asks the host first and, when a login is required, shows
 * the login form INSTEAD of the market.
 *
 * Fails open by design: an unreachable market, a plain static catalog, or a
 * host too old to answer `/dsh-market/account` all render the page exactly as
 * before. Locking someone out because a probe timed out would be worse than
 * letting them see an error row they can retry.
 */

import { createElement as h, useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import css from './Market.module.css'
import { api } from './market-data.ts'
import type { Translate } from './market-data.ts'
import { MarketLoginDialog } from './MarketLoginDialog.tsx'

/** One configured catalog source, as the host sees it. */
export interface HostMarket {
  server: string
  requiresAuth: boolean
  authed: boolean
  name?: string
}

export interface AccountReply {
  accounts: Array<{ server: string; user: string; role?: string; at: string }>
  markets: HostMarket[]
}

type Phase = { kind: 'checking' } | { kind: 'open' } | { kind: 'locked'; market: HostMarket }

export async function readAccounts(): Promise<AccountReply | null> {
  try {
    const response = await fetch(api('/dsh-market/account'))
    if (!response.ok) return null
    const body = await response.json() as Partial<AccountReply>
    if (!Array.isArray(body.accounts) || !Array.isArray(body.markets)) return null
    return { accounts: body.accounts, markets: body.markets }
  } catch {
    return null
  }
}

export function MarketAuthGate({ t, children }: { t: Translate; children?: ReactNode }): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })
  const [loggingIn, setLoggingIn] = useState(false)

  const check = (): void => {
    void (async () => {
      const reply = await readAccounts()
      if (reply === null) {
        // No answer (older host, network hiccup): behave like there is no gate.
        setPhase({ kind: 'open' })
        return
      }
      const locked = reply.markets.find(market => market.requiresAuth && !market.authed)
      setPhase(locked === undefined ? { kind: 'open' } : { kind: 'locked', market: locked })
    })()
  }

  useEffect(check, [])

  if (phase.kind === 'open') return h('div', { className: css.gateHost }, children)
  if (phase.kind === 'checking') return h('div', { className: css.gateHost, 'aria-busy': 'true' })

  const market = phase.market
  return h('div', { className: css.gateHost },
    h('div', { className: css.gateCard },
      h('div', { className: css.gateTitle }, t('gateTitle')),
      h('div', { className: css.gateText },
        t('gateBody').replace('{0}', market.name ?? market.server)),
      h('div', { className: css.gateActions },
        h('button', {
          type: 'button',
          className: css.gateButton,
          onClick: () => { setLoggingIn(true) },
        }, t('gateLogin')))),
    loggingIn
      ? h(MarketLoginDialog, {
        t,
        server: market.server,
        reason: t('gateBody').replace('{0}', market.name ?? market.server),
        onClose: () => { setLoggingIn(false) },
        onDone: () => { setLoggingIn(false); setPhase({ kind: 'checking' }); check() },
      })
      : null)
}
