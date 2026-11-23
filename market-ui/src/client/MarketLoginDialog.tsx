/**
 * The login form for a private market.
 *
 * One dialog, two callers: the market page's gate (a market that refuses
 * anonymous reads has to be logged into before anything is shown) and the
 * catalogs panel (a market that allows anonymous reads still offers a login,
 * because reading is not the same as publishing).
 *
 * The password is posted once and never held anywhere else — no state file,
 * no localStorage, no log line. What comes back is a token, and the host keeps
 * that (see `src/accounts.ts`).
 */

import { createElement as h, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import { api } from './market-data.ts'
import type { Translate } from './market-data.ts'

export interface MarketLoginDialogProps {
  t: Translate
  /** Market address as the user typed it, or the origin of the saved catalog. */
  server: string
  onClose: () => void
  /** Called after the host accepted the credentials. */
  onDone: (server: string, user: string) => void
  /** Shown above the fields, for the "this market needs a login" case. */
  reason?: string
}

interface LoginReply {
  ok?: boolean
  server?: string
  user?: string
  code?: string
  error?: string
}

export function MarketLoginDialog({ t, server, onClose, onDone, reason }: MarketLoginDialogProps): ReactElement {
  const [address, setAddress] = useState(server)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        const response = await fetch(api('/dsh-market/account/login'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ server: address, name, password }),
        })
        const body = await response.json() as LoginReply
        if (body.ok === true) {
          // Drop the password from state before leaving: the dialog may be
          // remounted by a caller that keeps it around.
          setPassword('')
          onDone(body.server ?? address, body.user ?? name)
          return
        }
        setError(body.error ?? t('loginFailed').replace('{0}', body.code ?? String(response.status)))
      } catch {
        setError(t('loginFailed').replace('{0}', t('srcErrNetwork')))
      } finally {
        setBusy(false)
      }
    })()
  }

  return h(Modal, {
    open: true,
    onClose: busy ? () => { /* let the request finish */ } : onClose,
    title: t('loginTitle'),
    description: reason ?? t('loginHint'),
    footer: h('div', { className: css.dialogFoot },
      h(Button, { variant: 'ghost', onClick: onClose, disabled: busy }, t('cancel')),
      h(Button, {
        variant: 'primary',
        disabled: busy || name.trim() === '' || password === '' || address.trim() === '',
        onClick: submit,
      }, busy ? t('loginBusy') : t('loginSubmit'))),
  },
  h('div', { className: css.loginForm },
    h('label', { htmlFor: 'dsh-market-login-server' }, t('loginServer')),
    h(Input, {
      id: 'dsh-market-login-server',
      value: address,
      placeholder: 'http://market.internal:4874',
      onChange: (event: { target: { value: string } }) => { setAddress(event.target.value) },
      autoFocus: server === '',
    }),
    h('label', { htmlFor: 'dsh-market-login-name' }, t('loginUser')),
    h(Input, {
      id: 'dsh-market-login-name',
      value: name,
      autoComplete: 'username',
      onChange: (event: { target: { value: string } }) => { setName(event.target.value) },
      autoFocus: server !== '',
    }),
    h('label', { htmlFor: 'dsh-market-login-password' }, t('loginPassword')),
    h(Input, {
      id: 'dsh-market-login-password',
      type: 'password',
      value: password,
      autoComplete: 'current-password',
      onChange: (event: { target: { value: string } }) => { setPassword(event.target.value) },
      onKeyDown: (event: { key: string }) => { if (event.key === 'Enter') submit() },
    }),
    error === null ? null : h('div', { className: css.loginError, role: 'alert' }, error),
  ))
}
