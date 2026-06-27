import type { Guest, Tenant, Wedding } from '@wedding-planner/shared'

import type { StrategyGuidance } from '../strategy/strategy_guidance'
import { html, render, type SafeHtml, safeColor } from './html'
import { htmlResult, type HttpResult } from './web_response'

/**
 * @canonical web_pages -- the pure render functions for the web edge. NO I/O, NO store, NO socket.
 *
 * Every page is built ONLY through the `html` tagged template (so every dynamic value is escaped) and
 * the brand colors reach the document ONLY through `safeColor`, injected as CSS custom properties in the
 * body's quoted `style` attribute (never into `<style>` text). `logo_ref` is rendered as escaped TEXT
 * only — never a `src`/`href` — so a `javascript:`/`data:` logo cannot execute (doddy P0-2).
 *
 * The themed shell is applied ONLY to the authenticated/active surfaces (console, detail, login,
 * forbidden) — the surfaces the request reached only via a non-404 from `api.handle()` (arch P0-2). The
 * GENERIC_404 / ERROR_500 results are tenant-INDEPENDENT constants that never consult a theme, so they
 * are byte-identical for unknown / suspended / onboarding / not-owned / missing — the no-oracle masking,
 * carried into HTML.
 *
 * related: html.ts (the escapers), product_web_ui.ts (chooses which page per status), theme_resolver.ts.
 */

/** The static stylesheet — references the `--brand`/`--accent` custom properties; no interpolation. */
const STYLE = html`<style>
    :root { color-scheme: light; }
    body { font-family: system-ui, sans-serif; margin: 0; color: #1a1a1a; background: #fafafa; }
    header { background: var(--brand, #444); color: #fff; padding: 1.25rem 1.5rem; }
    .logo { display: inline-flex; align-items: center; gap: .6rem; }
    .logo .mark { width: 2rem; height: 2rem; border-radius: 50%; background: var(--accent, #888);
      display: inline-flex; align-items: center; justify-content: center; font-weight: 700; }
    .asset { font-size: .7rem; opacity: .7; }
    main { padding: 1.5rem; max-width: 56rem; margin: 0 auto; }
    a { color: var(--brand, #444); }
    .card { background: #fff; border: 1px solid #eee; border-radius: .5rem; padding: 1rem; margin: .75rem 0; }
    .status { display: inline-block; padding: .1rem .5rem; border-radius: 1rem; background: var(--accent, #888); color: #fff; font-size: .75rem; }
    label { display: block; margin: .75rem 0 .25rem; font-weight: 600; }
    input, select, button { font-size: 1rem; padding: .5rem; }
    button { background: var(--brand, #444); color: #fff; border: 0; border-radius: .4rem; cursor: pointer; }
    .note { color: #666; font-size: .85rem; }
    form.inline { display: inline; }
  </style>`

/** Wrap themed content in the full document, injecting the validated brand colors via custom properties. */
function themedShell(theme: Tenant['theme'], slug: string, title: string, content: SafeHtml): string {
  const brand = safeColor(theme.primary_color_hex)
  const accent = safeColor(theme.accent_color_hex)
  const initial = theme.brand_name.slice(0, 1)
  return render(html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${theme.brand_name}</title>
${STYLE}
</head>
<body style="--brand:${brand};--accent:${accent}">
<header>
  <div class="logo">
    <span class="mark">${initial}</span>
    <div>
      <div><strong>${theme.brand_name}</strong></div>
      <div class="asset">logo asset: ${theme.logo_ref}</div>
    </div>
  </div>
</header>
<main>
  <p class="note">Tenant <code>${slug}</code> · offline white-label demo.</p>
  ${content}
</main>
</body>
</html>`)
}

/** The generic landing page — tenant-independent, no theme (the front door at `/`). */
export function renderLanding(): string {
  return render(html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Wedding Planner — white-label</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem;">
<h1>Wedding Planner</h1>
<p>A white-label, multi-tenant wedding-planning product. Each planner organization has its own themed
space at <code>/t/&lt;slug&gt;</code>. This is an offline demo build — onboarding, billing, and comms are
simulated.</p>
</body>
</html>`)
}

/** The themed login form. A LABELED simulation: no password — pick a role (the Phase-13 auth model). */
export function renderLogin(theme: Tenant['theme'], slug: string, invalid = false): string {
  const warning = invalid
    ? html`<p class="note" style="color:#b00">That login could not be completed. Check the role and wedding id.</p>`
    : html``
  return themedShell(
    theme,
    slug,
    'Sign in',
    html`<div class="card">
  <h2>Sign in to ${theme.brand_name}</h2>
  <p class="note">Simulated login — no password (offline demo). Planners see every wedding in the
  workspace; couples see only their own.</p>
  ${warning}
  <form method="post" action="/t/${slug}/login">
    <label for="role">Role</label>
    <select id="role" name="role">
      <option value="planner">Planner (workspace staff)</option>
      <option value="couple">Couple (one wedding)</option>
    </select>
    <label for="wedding_id">Wedding id <span class="note">(couples only)</span></label>
    <input id="wedding_id" name="wedding_id" type="text" placeholder="wedding_…" autocomplete="off">
    <p><button type="submit">Sign in</button></p>
  </form>
</div>`,
  )
}

/**
 * The themed console: the list of weddings the principal may see (planner: all; couple: their one). The
 * logout form carries the per-session CSRF token (Phase 21) — a forged logout is rejected like any other
 * cookie-authenticated mutation.
 */
export function renderConsole(
  theme: Tenant['theme'],
  slug: string,
  weddings: readonly Wedding[],
  csrfToken: string,
): string {
  const rows = weddings.map(
    (w) => html`<div class="card">
  <div><a href="/t/${slug}?wedding=${w.wedding_id}"><strong>${w.couple_display_name}</strong></a></div>
  <div class="note">${w.event_date} · <span class="status">${w.status}</span></div>
</div>`,
  )
  const body =
    weddings.length === 0
      ? html`<p class="note">No weddings to show.</p>`
      : html`${rows}`
  return themedShell(
    theme,
    slug,
    'Weddings',
    html`<div style="display:flex;justify-content:space-between;align-items:center">
    <h2>Weddings</h2>
    <form class="inline" method="post" action="/t/${slug}/logout">${csrfField(csrfToken)}<button type="submit">Sign out</button></form>
  </div>
  <p><a href="/t/${slug}/strategy">View the planning strategy →</a> · <a href="/t/${slug}?view=guests">Manage guests →</a></p>
  ${body}`,
  )
}

/**
 * The themed guest-management page (Phase 21): the planner's list of registered guests (each with a remove
 * form) and an add-guest form whose `wedding_id` is a `<select>` of the workspace's weddings. EVERY value —
 * including the `_csrf` hidden field, the opaque `recipient_ref`, and the `<select>` wedding values — flows
 * through the `html` template (escaped text only, never a `src`/`href`). Planner-only (the JSON `GET
 * /t/:slug/guests` it is rendered from is planner-only; a couple never reaches this page).
 */
export function renderGuests(
  theme: Tenant['theme'],
  slug: string,
  guests: readonly Guest[],
  weddings: readonly Wedding[],
  csrfToken: string,
  invalid = false,
): string {
  const nameOf = new Map(weddings.map((w) => [w.wedding_id, w.couple_display_name]))
  const rows = guests.map(
    (g) => html`<div class="card">
    <div><strong>${g.guest_id}</strong> · <code>${g.recipient_ref}</code></div>
    <div class="note">Wedding: ${nameOf.get(g.wedding_id) ?? g.wedding_id} · <code>${g.wedding_id}</code></div>
    <form class="inline" method="post" action="/t/${slug}/guests/remove">${csrfField(csrfToken)}<input type="hidden" name="recipient_ref" value="${g.recipient_ref}"><button type="submit">Remove</button></form>
  </div>`,
  )
  const list = guests.length === 0 ? html`<p class="note">No guests registered yet.</p>` : html`${rows}`
  const options = weddings.map(
    (w) => html`<option value="${w.wedding_id}">${w.couple_display_name} (${w.wedding_id})</option>`,
  )
  const addForm =
    weddings.length === 0
      ? html`<p class="note">Create a wedding first — a guest is always bound to one wedding.</p>`
      : html`<form method="post" action="/t/${slug}/guests/create">
    ${csrfField(csrfToken)}
    <label for="recipient_ref">Guest contact <span class="note">(opaque handle, e.g. <code>sms:+1555…</code>)</span></label>
    <input id="recipient_ref" name="recipient_ref" type="text" placeholder="sms:+1555…" autocomplete="off">
    <label for="wedding_id">Wedding</label>
    <select id="wedding_id" name="wedding_id">${options}</select>
    <label for="guest_id">Guest id</label>
    <input id="guest_id" name="guest_id" type="text" placeholder="guest_…" autocomplete="off">
    <p><button type="submit">Register guest</button></p>
  </form>`
  const warning = invalid
    ? html`<p class="note" style="color:#b00">That guest could not be registered. Check the contact handle and wedding.</p>`
    : html``
  return themedShell(
    theme,
    slug,
    'Guests',
    html`<div style="display:flex;justify-content:space-between;align-items:center">
    <h2>Guests</h2>
    <form class="inline" method="post" action="/t/${slug}/logout">${csrfField(csrfToken)}<button type="submit">Sign out</button></form>
  </div>
  <p><a href="/t/${slug}">← All weddings</a></p>
  <div class="card"><h3>Register a guest</h3>${warning}${addForm}</div>
  <h3>Registered guests</h3>
  ${list}`,
  )
}

/** The hidden CSRF field every cookie-authenticated browser mutation carries (escaped via the html template). */
function csrfField(csrfToken: string): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${csrfToken}">`
}

/** The themed single-wedding detail page. Reached via `?wedding=<id>` on the console route. */
export function renderDetail(theme: Tenant['theme'], slug: string, wedding: Wedding): string {
  // Guest-visible logistics facts — rendered (escaped via `html`) only when the planner/couple has set them.
  // These are exactly the facts the guest-messaging responder answers from (see guest_qa_responder.ts).
  const logistics: SafeHtml[] = []
  if (wedding.ceremony_time !== undefined) logistics.push(html`<p>Ceremony: <strong>${wedding.ceremony_time}</strong></p>`)
  if (wedding.venue_name !== undefined) logistics.push(html`<p>Venue: <strong>${wedding.venue_name}</strong></p>`)
  if (wedding.parking_info !== undefined) logistics.push(html`<p>Parking: ${wedding.parking_info}</p>`)
  if (wedding.dress_code !== undefined) logistics.push(html`<p>Dress code: ${wedding.dress_code}</p>`)
  return themedShell(
    theme,
    slug,
    wedding.couple_display_name,
    html`<p><a href="/t/${slug}">← All weddings</a></p>
  <div class="card">
    <h2>${wedding.couple_display_name}</h2>
    <p>Date: <strong>${wedding.event_date}</strong></p>
    ${logistics}
    <p>Status: <span class="status">${wedding.status}</span></p>
    <p class="note">Wedding id: <code>${wedding.wedding_id}</code> · created ${wedding.created_at}</p>
    <p class="note">Active strategy: <a href="/t/${slug}/strategy">the platform’s data-optimized planning defaults</a> (applied to every wedding in this workspace).</p>
  </div>`,
  )
}

/**
 * The themed "Planning strategy" page (Phase 17) — the loop's champion strategy as planner-facing guidance.
 * Every dynamic value is the pure `StrategyGuidance` projection (human copy + the derived autonomy posture);
 * it carries no engine lineage/surface internals, and all values flow through the `html` template (escaped).
 */
export function renderStrategy(theme: Tenant['theme'], slug: string, guidance: StrategyGuidance): string {
  const knobs = guidance.knobs.map(
    (k) => html`<div class="card">
    <div><strong>${k.label}</strong> <span class="status">${`${k.level} of ${k.maxLevel}`}</span></div>
    <p class="note">${k.summary}</p>
  </div>`,
  )
  return themedShell(
    theme,
    slug,
    'Planning strategy',
    html`<p><a href="/t/${slug}">← All weddings</a></p>
  <div class="card">
    <h2>${guidance.headline}</h2>
    <p>${guidance.autonomy.label} <span class="status">${guidance.autonomy.appliedAutomatically ? 'automatic' : 'needs approval'}</span></p>
    <p class="note">${guidance.autonomy.explanation}</p>
  </div>
  ${knobs}
  <p class="note">${guidance.disclaimer}</p>`,
  )
}

/** The themed forbidden page (a capability the role lacks — a 403, not a masked resource). */
export function renderForbidden(theme: Tenant['theme'], slug: string): string {
  return themedShell(
    theme,
    slug,
    'Not allowed',
    html`<div class="card"><h2>Not allowed</h2><p class="note">Your role can't perform that action here.</p></div>`,
  )
}

/**
 * The generic, tenant-INDEPENDENT 404 — one frozen constant, byte-identical for unknown / suspended /
 * onboarding / malformed-slug / not-owned / missing. Never consults a theme, so it manufactures no
 * existence or lifecycle oracle. The HTML analogue of `product_api.ts`'s `RESP_NOT_FOUND`.
 */
export const GENERIC_404: HttpResult = Object.freeze(
  htmlResult(
    404,
    render(html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Not found</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem;">
<h1>Not found</h1>
<p>This page does not exist.</p>
</body>
</html>`),
  ),
)

/** The generic error page — a constant, no stack trace and no internal code leak (mirrors RESP_INTERNAL). */
export const ERROR_500: HttpResult = Object.freeze(
  htmlResult(
    500,
    render(html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Error</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem;">
<h1>Something went wrong</h1>
<p>Please try again.</p>
</body>
</html>`),
  ),
)
