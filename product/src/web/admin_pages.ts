import type { OutboxMessage } from '../email/simulated_email_adapter'
import { html, render, type SafeHtml } from './html'

/**
 * @canonical admin_pages -- the pure render functions of the operator console (issue #9). NO I/O, NO store.
 *
 * The console is the PLATFORM operator's, so it is never tenant-themed: one neutral shell, no brand colors, no
 * tenant chrome. Every dynamic value goes through the `html` tagged template (escaped), including message bodies,
 * which are plain text shown in `<pre>`. Like every page here, it runs under the strict CSP (no script at all).
 *
 * related: operator_console.ts (chooses the page), pages.ts (the tenant-facing pages).
 */

const STYLE = html`<style>
    :root { color-scheme: light; }
    body { font-family: system-ui, sans-serif; margin: 0; color: #1a1a1a; background: #f4f4f5; }
    header { background: #27272a; color: #fff; padding: 1rem 1.5rem; display: flex; gap: 1.5rem; align-items: center; }
    header a { color: #fff; }
    header .spacer { flex: 1; }
    main { padding: 1.5rem; max-width: 60rem; margin: 0 auto; }
    .card { background: #fff; border: 1px solid #e4e4e7; border-radius: .5rem; padding: 1rem; margin: .75rem 0; }
    .meta { color: #52525b; font-size: .85rem; }
    .note { color: #52525b; font-size: .85rem; }
    .error { color: #b00020; }
    label { display: block; margin: .75rem 0 .25rem; font-weight: 600; }
    input, button { font-size: 1rem; padding: .5rem; }
    button { background: #27272a; color: #fff; border: 0; border-radius: .4rem; cursor: pointer; }
    pre { white-space: pre-wrap; word-break: break-word; background: #fafafa; padding: .75rem; border-radius: .4rem; }
    form.inline { display: inline; }
  </style>`

/** The console shell. `csrf` present ⇒ signed in: the nav and the Sign out form are shown. */
function operatorShell(title: string, content: SafeHtml, csrf?: string): string {
  const nav =
    csrf === undefined
      ? html``
      : html`<a href="/admin/outbox">Outbox</a>
    <span class="spacer"></span>
    <form class="inline" method="post" action="/admin/logout">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button type="submit">Sign out</button>
    </form>`
  return render(html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Operator console</title>
${STYLE}
</head>
<body>
<header>
  <strong>Operator console</strong>
  ${nav}
</header>
<main>
  ${content}
</main>
</body>
</html>`)
}

/** The operator sign-in form: the operator credential, exchanged for an expiring console session. */
export function renderOperatorLogin(invalid = false): string {
  const warning = invalid ? html`<p class="error">That credential was not accepted.</p>` : html``
  return operatorShell(
    'Sign in',
    html`<div class="card">
  <h1>Operator sign-in</h1>
  <p class="note">Enter the operator credential (<code>WP_OPERATOR_TOKEN</code>). It is exchanged for a console
  session that lasts 12 hours; the credential itself is not stored in your browser.</p>
  ${warning}
  <form method="post" action="/admin/login">
    <label for="token">Operator credential</label>
    <input id="token" name="token" type="password" autocomplete="current-password" required>
    <p><button type="submit">Sign in</button></p>
  </form>
</div>`,
  )
}

/** The outbox: every simulated email, newest first, with a form to send a test message. */
export function renderOutbox(messages: readonly OutboxMessage[], csrf: string, notice?: 'sent' | 'invalid'): string {
  const banner =
    notice === 'sent'
      ? html`<p class="note">Test message recorded. It is the first entry below.</p>`
      : notice === 'invalid'
        ? html`<p class="error">That address was not accepted.</p>`
        : html``
  const list =
    messages.length === 0
      ? html`<div class="card"><p class="note">No messages yet.</p></div>`
      : messages.map(
          (message) => html`<div class="card">
  <div><strong>${message.subject}</strong></div>
  <div class="meta">To ${message.to} · ${message.purpose} · ${message.tenant_id ?? 'platform'} · ${message.created_at} · ${message.status}</div>
  <pre>${message.text_body}</pre>
</div>`,
        )
  return operatorShell(
    'Outbox',
    html`<h1>Outbox</h1>
<p class="note">Email is simulated: nothing leaves the system. Every message the product sends (password resets,
invitations) is recorded here instead, newest first. Showing the most recent ${String(messages.length)}.</p>
${banner}
<div class="card">
  <form method="post" action="/admin/outbox/send">
    <input type="hidden" name="_csrf" value="${csrf}">
    <label for="to">Send a test message to</label>
    <input id="to" name="to" type="email" required autocomplete="off">
    <button type="submit">Send test</button>
  </form>
</div>
${list}`,
    csrf,
  )
}
