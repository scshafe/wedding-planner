import type { Tenant } from '@wedding-planner/shared'

import type { OutboxMessage } from '../email/simulated_email_adapter'
import { FEEDBACK_PAGES, type FeedbackSubmission } from '../feedback/feedback_service'
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
      : html`<a href="/admin/tenants">Tenants</a>
    <a href="/admin/outbox">Outbox</a>
    <a href="/admin/feedback">Feedback</a>
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
export function renderOutbox(messages: readonly OutboxMessage[], csrf: string, notice?: 'sent' | 'invalid', tenantId?: string): string {
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
invitations) is recorded here instead, newest first. Showing the most recent ${String(messages.length)}${tenantId === undefined ? '' : ` for tenant ${tenantId}`}.
${tenantId === undefined ? html`` : html`<a href="/admin/outbox">Show every tenant</a>`}</p>
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

/** Notices on the tenants page after an owner setup. */
export type TenantsNotice = 'owner_sent' | 'owner_invalid' | 'owner_conflict' | 'owner_inactive'

const TENANTS_NOTICES: Readonly<Record<TenantsNotice, string>> = Object.freeze({
  owner_sent: 'Owner account set up. The set-your-password link is in the outbox.',
  owner_invalid: 'That email address was not accepted.',
  owner_conflict: 'That email already belongs to a non-owner member of the workspace.',
  owner_inactive: 'Only an active workspace can have its owner set up.',
})

/** Every tenant, with a form to set up (or re-invite) the workspace owner of each active one (issue #10). */
export function renderTenants(tenants: readonly Tenant[], csrf: string, notice?: TenantsNotice): string {
  const banner =
    notice === undefined
      ? html``
      : html`<p class="${notice === 'owner_sent' ? 'note' : 'error'}">${TENANTS_NOTICES[notice]}</p>`
  const rows =
    tenants.length === 0
      ? html`<div class="card"><p class="note">No tenants yet.</p></div>`
      : tenants.map(
          (tenant) => html`<div class="card">
  <div><strong>${tenant.display_name}</strong> · <code>/t/${tenant.slug}</code> · <a href="/admin/outbox?tenant=${tenant.tenant_id}">Outbox</a></div>
  <div class="meta">${tenant.lifecycle_status} · ${tenant.plan_tier} · ${tenant.tenant_id} · created ${tenant.created_at}</div>
  ${
    tenant.lifecycle_status === 'active'
      ? html`<form method="post" action="/admin/tenants/owner">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="tenant_id" value="${tenant.tenant_id}">
    <label for="owner_${tenant.tenant_id}">Set up the owner account (or send a new setup link)</label>
    <input id="owner_${tenant.tenant_id}" name="email" type="email" required autocomplete="off">
    <button type="submit">Send setup link</button>
  </form>`
      : html``
  }
</div>`,
        )
  return operatorShell(
    'Tenants',
    html`<h1>Tenants</h1>
<p class="note">Every workspace. Setting up an owner creates their account and sends a set-your-password link
through the (simulated) email outbox.</p>
${banner}
${rows}`,
    csrf,
  )
}

/** In-app feedback, newest first (issue #12). Every field is untrusted text, escaped and shown in `<pre>`. */
export function renderFeedbackList(submissions: readonly FeedbackSubmission[], csrf: string): string {
  const list =
    submissions.length === 0
      ? html`<div class="card"><p class="note">No feedback yet.</p></div>`
      : submissions.map(
          (f) => html`<div class="card">
  <div class="meta">${f.tenant_slug} · ${f.role} · ${f.created_at}</div>
  <div class="meta">Page: ${f.page === undefined ? 'not given' : FEEDBACK_PAGES[f.page]}</div>
  <p><strong>Trying to:</strong></p>
  <pre>${f.trying}</pre>
  <p><strong>What happened:</strong></p>
  <pre>${f.happened}</pre>
</div>`,
        )
  return operatorShell(
    'Feedback',
    html`<h1>Feedback</h1>
<p class="note">What planners and couples sent from inside the product, newest first (the most recent ${String(submissions.length)}).
Each entry holds only what the person typed, which page they chose, their workspace and their role.</p>
${list}`,
    csrf,
  )
}
