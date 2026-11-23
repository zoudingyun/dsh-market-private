/**
 * "Publish an installed plugin" — the one action the market never had.
 *
 * Until now a plugin author had to leave the app and run `npm publish`, then
 * hope the market's index picked the version up. This panel closes that loop:
 * it lists what is installed here that could be published, packs the chosen
 * one on the host, and posts it with the token from the market's login.
 *
 * Only markets this profile is logged in to are offered. Publishing anonymously
 * is not a thing — the market has to know who to credit and who to refuse.
 */

import { createElement as h, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import { api } from './market-data.ts'
import type { Translate } from './market-data.ts'
import { readAccounts } from './MarketAuthGate.tsx'
import type { HostMarket } from './MarketAuthGate.tsx'

interface Candidate {
  name: string
  version: string
  title?: string
  description?: string
  linked: boolean
  bundle: boolean
}

interface CandidatesReply {
  bundles: Candidate[]
  accounts: Array<{ server: string; user: string }>
}

interface PublishReply {
  ok?: boolean
  name?: string
  version?: string
  status?: string
  code?: string
  error?: string
}

export function PublishPanel({ t }: { t: Translate }): ReactElement | null {
  const [bundles, setBundles] = useState<Candidate[] | null>(null)
  const [markets, setMarkets] = useState<HostMarket[]>([])
  const [selected, setSelected] = useState('')
  const [server, setServer] = useState('')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const [candidates, account] = await Promise.all([
          fetch(api('/dsh-market/publish/candidates')).then(async response => (response.ok ? await response.json() as CandidatesReply : null)),
          readAccounts(),
        ])
        const list = (candidates?.bundles ?? []).filter(item => item.bundle)
        setBundles(list)
        if (list.length > 0) setSelected(list[0]!.name)
        // Only markets we can actually post to: a login is what makes the
        // token exist, and the publish route refuses without one.
        const loggedIn = new Set((candidates?.accounts ?? []).map(entry => entry.server))
        const usable = (account?.markets ?? []).filter(market => loggedIn.has(market.server))
        setMarkets(usable)
        if (usable.length > 0) setServer(usable[0]!.server)
      } catch {
        setBundles([])
      }
    })()
  }, [])

  if (bundles === null) return h('div', { className: css.pubBox }, h('div', { className: css.pubHint }, '…'))
  if (bundles.length === 0) {
    return h('div', { className: css.pubBox },
      h('div', { className: css.pubTitle }, t('pubTitle')),
      h('div', { className: css.pubHint }, t('pubNoBundle')))
  }

  const publish = (): void => {
    if (busy || selected === '' || server === '') return
    setBusy(true)
    setMessage(null)
    void (async () => {
      try {
        const response = await fetch(api('/dsh-market/publish'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ server, name: selected, ...(category.trim() === '' ? {} : { category: category.trim() }) }),
        })
        const body = await response.json() as PublishReply
        if (body.ok === true) {
          const pending = body.status === 'pending'
          setMessage({
            text: (pending ? t('pubQueued') : t('pubDone'))
              .replace('{0}', `${body.name ?? selected}@${body.version ?? ''}`),
            bad: false,
          })
        } else {
          setMessage({ text: body.error ?? t('loginFailed').replace('{0}', body.code ?? String(response.status)), bad: true })
        }
      } catch {
        setMessage({ text: t('loginFailed').replace('{0}', t('srcErrNetwork')), bad: true })
      } finally {
        setBusy(false)
      }
    })()
  }

  return h('div', { className: css.pubBox },
    h('div', { className: css.pubTitle }, t('pubTitle')),
    h('div', { className: css.pubHint }, t('pubHint')),
    h('div', { className: css.pubRow },
      h('label', { htmlFor: 'dsh-market-pub-plugin' }, t('pubPick')),
      h('select', {
        id: 'dsh-market-pub-plugin',
        className: css.pubSelect,
        value: selected,
        onChange: (event: { target: { value: string } }) => { setSelected(event.target.value) },
      }, bundles.map(item => h('option', { key: item.name, value: item.name },
        `${item.title ?? item.name} · ${item.name}@${item.version}${item.linked ? ' (link)' : ''}`)))),
    markets.length === 0
      ? h('div', { className: css.pubHint }, t('pubNoAccount'))
      : h('div', { className: css.pubRow },
        h('label', { htmlFor: 'dsh-market-pub-market' }, t('pubMarket')),
        h('select', {
          id: 'dsh-market-pub-market',
          className: css.pubSelect,
          value: server,
          onChange: (event: { target: { value: string } }) => { setServer(event.target.value) },
        }, markets.map(market => h('option', { key: market.server, value: market.server },
          `${market.name ?? market.server} · ${market.server}`)))),
    markets.length === 0
      ? null
      : h('div', { className: css.pubRow },
        h('label', { htmlFor: 'dsh-market-pub-category' }, t('pubCategory')),
        h(Input, {
          id: 'dsh-market-pub-category',
          className: css.inlineInput,
          value: category,
          placeholder: 'general',
          onChange: (event: { target: { value: string } }) => { setCategory(event.target.value) },
        })),
    markets.length === 0
      ? null
      : h('div', { className: css.pubFoot },
        h(Button, { variant: 'primary', disabled: busy || selected === '', onClick: publish },
          busy ? t('pubBusy') : t('pubSubmit'))),
    message === null ? null : h('div', { className: message.bad ? css.pubBad : css.pubGood, role: 'status' }, message.text))
}
