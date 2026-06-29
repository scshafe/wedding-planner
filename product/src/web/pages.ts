import type { EscalationReply, EscalationResolution, Guest, GuestEscalation, Tenant, Wedding } from '@wedding-planner/shared'

import type { BillingActivityEntry } from '../billing/billing_activity'
import type { BillingSummary } from '../billing/billing_summary'
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

/** The wedding lifecycle statuses (mirrors the `status` enum in wedding_schema.json). */
const WEDDING_STATUSES: readonly Wedding['status'][] = ['planning', 'active', 'completed', 'cancelled']

/** A `<select>` of the wedding statuses, marking `selected` the current value (escaped via the template). */
function statusOptions(selected?: Wedding['status']): SafeHtml[] {
  return WEDDING_STATUSES.map((s) =>
    s === selected ? html`<option value="${s}" selected>${s}</option>` : html`<option value="${s}">${s}</option>`,
  )
}

/**
 * The shared labelled input set for the wedding create AND edit forms (Phase 23) — the required name/date/
 * status plus the four OPTIONAL Phase-22 logistics fields. Every value flows through the `html` template
 * (escaped into the `value="…"` attribute). `prefill` is the existing record on the edit form (empty on
 * create); an absent optional field renders an empty input. An empty input is sent as "" and the web handler
 * OMITS it from the request body, so create leaves it unset and update PRESERVES the stored value (the
 * Phase-22 contract — there is no clear-to-absent sentinel from the browser yet).
 */
type WeddingFormPrefill = Partial<
  Pick<
    Wedding,
    'couple_display_name' | 'event_date' | 'status' | 'ceremony_time' | 'venue_name' | 'parking_info' | 'dress_code'
  >
>
function weddingFormFields(prefill: WeddingFormPrefill = {}): SafeHtml {
  return html`<label for="couple_display_name">Couple display name</label>
    <input id="couple_display_name" name="couple_display_name" type="text" maxlength="200" value="${prefill.couple_display_name ?? ''}" placeholder="Alex &amp; Sam" autocomplete="off">
    <label for="event_date">Event date <span class="note">(YYYY-MM-DD)</span></label>
    <input id="event_date" name="event_date" type="text" value="${prefill.event_date ?? ''}" placeholder="2027-09-12" autocomplete="off">
    <label for="status">Status</label>
    <select id="status" name="status">${statusOptions(prefill.status)}</select>
    <label for="ceremony_time">Ceremony time <span class="note">(optional, HH:MM)</span></label>
    <input id="ceremony_time" name="ceremony_time" type="text" value="${prefill.ceremony_time ?? ''}" placeholder="15:30" autocomplete="off">
    <label for="venue_name">Venue <span class="note">(optional)</span></label>
    <input id="venue_name" name="venue_name" type="text" maxlength="200" value="${prefill.venue_name ?? ''}" placeholder="The Old Mill" autocomplete="off">
    <label for="parking_info">Parking <span class="note">(optional)</span></label>
    <input id="parking_info" name="parking_info" type="text" maxlength="500" value="${prefill.parking_info ?? ''}" placeholder="Free lot behind the venue" autocomplete="off">
    <label for="dress_code">Dress code <span class="note">(optional)</span></label>
    <input id="dress_code" name="dress_code" type="text" maxlength="200" value="${prefill.dress_code ?? ''}" placeholder="Cocktail attire" autocomplete="off">`
}

/**
 * The themed console: the list of weddings the principal may see (planner: all; couple: their one), plus the
 * Phase-23 CREATE form. The logout + create forms carry the per-session CSRF token (Phase 21) — a forged
 * submit is rejected like any other cookie-authenticated mutation. Create is planner-only at the JSON layer:
 * the form renders for every principal (a CAPABILITY affordance, no resource oracle), and a couple's submit
 * takes the honest themed 403. `invalid` re-renders the generic create-failure notice after a failed create.
 */
export function renderConsole(
  theme: Tenant['theme'],
  slug: string,
  weddings: readonly Wedding[],
  csrfToken: string,
  invalid = false,
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
  const createWarning = invalid
    ? html`<p class="note" style="color:#b00">That wedding could not be created. Check the name, date, and fields.</p>`
    : html``
  return themedShell(
    theme,
    slug,
    'Weddings',
    html`<div style="display:flex;justify-content:space-between;align-items:center">
    <h2>Weddings</h2>
    <form class="inline" method="post" action="/t/${slug}/logout">${csrfField(csrfToken)}<button type="submit">Sign out</button></form>
  </div>
  <p><a href="/t/${slug}">← Home</a> · <a href="/t/${slug}/strategy">View the planning strategy →</a> · <a href="/t/${slug}?view=guests">Manage guests →</a> · <a href="/t/${slug}?view=escalations">Guest questions →</a> · <a href="/t/${slug}?view=billing">Billing &amp; usage →</a></p>
  ${body}
  <div class="card"><h3>Create a wedding</h3>${createWarning}
    <form method="post" action="/t/${slug}/weddings/create">
      ${csrfField(csrfToken)}
      ${weddingFormFields()}
      <p><button type="submit">Create wedding</button></p>
    </form>
  </div>`,
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
  <p><a href="/t/${slug}">← Home</a></p>
  <div class="card"><h3>Register a guest</h3>${warning}${addForm}</div>
  <h3>Registered guests</h3>
  ${list}`,
  )
}

/**
 * The escalation_id → EFFECTIVE-transition join shared by the inbox (open/handled split) and the home
 * (open-count). The resolution log is an append-only TRANSITION history (Phase 36) — MANY rows per escalation_id
 * — so this folds to the HIGHEST-`seq` row per escalation (NOT `new Map(...)` last-in-array, which would mislabel
 * a reopened escalation depending on insertion order). SINGLE-SOURCING the fold here keeps the home's "N guest
 * questions need attention" count and the inbox's Open/Handled split using ONE definition of "handled" — they can
 * never drift (Phase 33). The effective status is read off the returned record by {@link isEffectiveOpen}.
 */
function effectiveTransitionByEscalation(resolutions: readonly EscalationResolution[]): Map<string, EscalationResolution> {
  const byEscalation = new Map<string, EscalationResolution>()
  for (const r of resolutions) {
    const current = byEscalation.get(r.escalation_id)
    if (current === undefined || r.seq > current.seq) byEscalation.set(r.escalation_id, r)
  }
  return byEscalation
}

/**
 * Whether an escalation is effective-OPEN given its highest-`seq` transition (or `undefined` if never handled):
 * no transition OR a `reopened` max-`seq` row ⇒ open (in the inbox); a `resolved`/`dismissed` max-`seq` ⇒ handled.
 * The ONE definition both the open-count and the inbox split read.
 */
function isEffectiveOpen(effective: EscalationResolution | undefined): boolean {
  return effective === undefined || effective.status === 'reopened'
}

/**
 * The count of OPEN escalations within the supplied — already scoped — arrays. Folds BOTH arrays from the one
 * scoped `GET /t/:slug/escalations` body (a handled escalation must not be counted, so counting
 * `escalations.length` alone would over-count). Used by the home overview; uses the SAME effective-transition
 * fold the inbox renders, so the count and the inbox's Open list always agree (incl. a reopened escalation,
 * which counts as open).
 */
export function countOpenEscalations(
  escalations: readonly GuestEscalation[],
  resolutions: readonly EscalationResolution[],
): number {
  const effective = effectiveTransitionByEscalation(resolutions)
  return escalations.reduce((n, e) => (isEffectiveOpen(effective.get(e.escalation_id)) ? n + 1 : n), 0)
}

/**
 * The principal-scoped figures the home overview renders — every one a COUNT/aggregate derived from a read the
 * principal is already authorized for at its existing scope (weddings/escalations/guests, and the planner-only
 * billing). It carries NO row detail and NO id, so it discloses strictly less than the views it links to. The
 * optional `billing` is present ONLY for a planner (a couple's `GET /billing` is a 403 → the card is omitted, an
 * affordance, not a masked value).
 */
export interface AccountOverview {
  readonly weddingsCount: number
  readonly openQuestionsCount: number
  readonly guestsCount: number
  readonly billing?: { readonly balanceCents: number; readonly planTier: string }
}

/**
 * The themed account HOME / overview (Phase 33) — the default `/t/:slug` landing and the console's hub. An
 * at-a-glance "what needs attention" summary: open guest questions (highlighted when any await handling), the
 * weddings/guests counts, and — for a planner only — the owed balance + plan, each a card that links into the
 * matching view. EVERY figure is a pure {@link AccountOverview} count composed at the web edge from the existing
 * scoped reads, so the page discloses only the union of those reads (no new oracle). The billing card renders iff
 * `overview.billing` is present (planner); a couple simply sees no billing card. Carries the Sign-out form, so it
 * issues the per-session CSRF token like every other authenticated page. All values flow through the `html` template.
 */
export function renderHome(
  theme: Tenant['theme'],
  slug: string,
  overview: AccountOverview,
  csrfToken: string,
): string {
  const attention =
    overview.openQuestionsCount > 0
      ? html`<p><strong>${`${overview.openQuestionsCount} need attention`}</strong></p>`
      : html`<p class="note">All caught up — no open guest questions.</p>`
  const billingCard =
    overview.billing === undefined
      ? html``
      : html`<div class="card">
    <h3><a href="/t/${slug}?view=billing">Billing &amp; usage →</a></h3>
    <p><strong>${`${dollars(overview.billing.balanceCents)} owed`}</strong> · <span class="status">${overview.billing.planTier}</span></p>
  </div>`
  return themedShell(
    theme,
    slug,
    'Home',
    html`<div style="display:flex;justify-content:space-between;align-items:center">
    <h2>Overview</h2>
    <form class="inline" method="post" action="/t/${slug}/logout">${csrfField(csrfToken)}<button type="submit">Sign out</button></form>
  </div>
  <div class="card">
    <h3><a href="/t/${slug}?view=escalations">Guest questions →</a></h3>
    ${attention}
  </div>
  <div class="card">
    <h3><a href="/t/${slug}?view=weddings">Weddings →</a></h3>
    <p>${`${overview.weddingsCount} wedding(s)`}</p>
  </div>
  <div class="card">
    <h3><a href="/t/${slug}?view=guests">Guests →</a></h3>
    <p>${`${overview.guestsCount} registered guest(s)`}</p>
  </div>
  ${billingCard}
  <p><a href="/t/${slug}/strategy">View the planning strategy →</a></p>`,
  )
}

/**
 * Group a flat reply list into per-escalation THREADS, each sorted NUMERICALLY by `seq` (`a.seq - b.seq`, never
 * lexicographic — or `10` would sort before `2`). Built from the ALREADY-SCOPED `replies` array the read
 * returned (never a request-supplied escalation_id), so it discloses only what the scoped read already did. A
 * forged far-future `seq` leaves only a harmless display gap — the numeric sort floats it to the end and the
 * next legit reply takes `thread.length`; the render never array-INDEXES by `seq`.
 */
function threadsByEscalation(replies: readonly EscalationReply[]): Map<string, EscalationReply[]> {
  const byEscalation = new Map<string, EscalationReply[]>()
  for (const reply of replies) {
    const thread = byEscalation.get(reply.escalation_id)
    if (thread === undefined) byEscalation.set(reply.escalation_id, [reply])
    else thread.push(reply)
  }
  for (const thread of byEscalation.values()) thread.sort((a, b) => a.seq - b.seq)
  return byEscalation
}

/**
 * The themed escalation-inbox page (Phase 26 read + Phase 27 resolve + Phase 28/34 multi-turn reply): the
 * questions guests asked that the platform could not answer, split into OPEN (still to handle) and HANDLED
 * (resolved/dismissed). Each row shows its reply THREAD (the question→answer transcript — Phase 34 replaced the
 * single Phase-29 `reply_text`); each OPEN row carries a CSRF-protected Reply form (a metered send that APPENDS
 * to the thread and does NOT resolve — so an operator can reply as many times as needed) plus Resolve and
 * Dismiss forms (Phase 27 — the page issues a CSRF token, unlike the read-only strategy page) plus a link to
 * the matching wedding's edit page. The Reply form carries a hidden `seq = (thread length)` — the render-time
 * double-submit key: a re-POST of the same form re-sends the same seq (the JSON layer dedups it to one send);
 * a fresh form (after a reply lands) carries `seq+1`. The guest's `text` AND every operator `body` are
 * interpolated through the `html` template (escaped text, never a `src`/`href`/attribute), so neither a hostile
 * question nor a reply can inject markup; an operator `body` is never reflected to the guest. Rendered from the
 * scoped `GET /t/:slug/escalations` (planner: whole tenant; couple: their wedding); the `resolutions` AND
 * `replies` are scoped by the SAME branch, joined here by `escalation_id`.
 */
export function renderEscalations(
  theme: Tenant['theme'],
  slug: string,
  escalations: readonly GuestEscalation[],
  resolutions: readonly EscalationResolution[],
  replies: readonly EscalationReply[],
  csrfToken: string,
): string {
  // Fold by escalation_id to the EFFECTIVE transition (Phase 36 — many transition rows per escalation): an
  // escalation whose max-`seq` row is resolved/dismissed is HANDLED; no row OR a `reopened` max-`seq` is OPEN
  // (the single-sourced definition lives in `isEffectiveOpen` — the home's open-count uses the SAME fold so the
  // two can't drift). NOTE: open-count is intentionally REPLY-AGNOSTIC — a replied-but-unresolved escalation
  // stays OPEN / needs-attention until an explicit resolve/dismiss; do NOT subtract replies from the open set.
  const effectiveOf = effectiveTransitionByEscalation(resolutions)
  const threadOf = threadsByEscalation(replies)
  const open = escalations.filter((e) => isEffectiveOpen(effectiveOf.get(e.escalation_id)))
  const handled = escalations.filter((e) => !isEffectiveOpen(effectiveOf.get(e.escalation_id)))

  const actionForm = (escalationId: string, status: 'resolved' | 'dismissed' | 'reopened', label: string): SafeHtml =>
    html`<form class="inline" method="post" action="/t/${slug}/escalations/resolve">${csrfField(csrfToken)}<input type="hidden" name="escalation_id" value="${escalationId}"><input type="hidden" name="status" value="${status}"><button type="submit">${label}</button></form>`

  // The reply THREAD (Phase 34): each turn as a "Sender: body" line, escaped via `html` like every other value.
  // Phase 35: the thread is BI-DIRECTIONAL — a `guest` turn (an inbound follow-up) sits beside operator turns.
  // The label is an EXHAUSTIVE three-way map (NOT a binary `planner`-else fallthrough, which would mislabel a
  // guest turn as "Couple" — a trust-presentation bug). Empty when no turns yet.
  const senderLabel = (sender: EscalationReply['sender']): string =>
    sender === 'guest' ? 'Guest' : sender === 'planner' ? 'Planner' : 'Couple'
  const threadView = (escalationId: string): SafeHtml => {
    const thread = threadOf.get(escalationId) ?? []
    if (thread.length === 0) return html``
    const lines = thread.map((m) => html`<div class="note">${senderLabel(m.sender)}: “${m.body}”</div>`)
    return html`${lines}`
  }

  // Phase 28/34: a Reply form on each OPEN row — answer the guest (a metered send over the channel they asked
  // on) which APPENDS to the thread (no auto-resolve). Posts to the 4-seg web route (CSRF), distinct from the
  // resolve form. The hidden `seq` = current thread length (the double-submit key). reply_text is the operator's
  // (trusted) body; it flows through `html` like every other value.
  const replyForm = (escalationId: string): SafeHtml => {
    const seq = (threadOf.get(escalationId) ?? []).length
    return html`<form method="post" action="/t/${slug}/escalations/reply">${csrfField(csrfToken)}<input type="hidden" name="escalation_id" value="${escalationId}"><input type="hidden" name="seq" value="${String(seq)}"><textarea name="reply_text" rows="2" placeholder="Reply to the guest…" required></textarea><button type="submit">Send reply</button></form>`
  }

  const openRows = open.map(
    (e) => html`<div class="card">
    <div><strong>“${e.text}”</strong></div>
    <div class="note">From <code>${e.from_ref}</code> · ${e.received_at} · via ${e.channel}</div>
    <div class="note">Wedding <code>${e.wedding_id}</code> · <a href="/t/${slug}?wedding=${e.wedding_id}">Set the missing details →</a></div>
    ${threadView(e.escalation_id)}
    ${replyForm(e.escalation_id)}
    <div class="inline">${actionForm(e.escalation_id, 'resolved', 'Mark resolved')} ${actionForm(e.escalation_id, 'dismissed', 'Dismiss')}</div>
  </div>`,
  )
  const handledRows = handled.map((e) => {
    // `effectiveOf` always has a row here (a handled escalation has a max-`seq` resolved/dismissed row), and its
    // status is NEVER `reopened` (a reopened escalation is effective-open → it renders in the OPEN column above,
    // never here — so the badge can only be Resolved/Dismissed; `reopened` is structurally unreachable here).
    const r = effectiveOf.get(e.escalation_id) as EscalationResolution
    const badge = r.status === 'resolved' ? 'Resolved' : 'Dismissed'
    // Phase 34: show the full reply thread beneath the guest's question — the question→answer transcript.
    // Each operator `body` is interpolated as plain TEXT through `html` (escaped exactly like e.text).
    // Phase 36: a Reopen form (CSRF) returns a handled escalation to the Open inbox so it can be replied to again
    // — posts status=reopened to the SAME /escalations/resolve route (no reply_text → routes to resolve).
    return html`<div class="card">
    <div><strong>“${e.text}”</strong> <span class="note">— ${badge} by ${r.resolved_by}</span></div>
    ${threadView(e.escalation_id)}
    <div class="note">From <code>${e.from_ref}</code> · ${e.received_at}</div>
    <div class="inline">${actionForm(e.escalation_id, 'reopened', 'Reopen')}</div>
  </div>`
  })

  const openBody =
    open.length === 0
      ? html`<p class="note">No open questions — guests haven't asked anything we couldn't answer (or you've handled them all).</p>`
      : html`${openRows}`
  const handledBody =
    handled.length === 0 ? html`` : html`<h3>Handled</h3>${handledRows}`
  return themedShell(
    theme,
    slug,
    'Guest questions',
    html`<p><a href="/t/${slug}">← Home</a></p>
  <div class="card">
    <h2>Questions we couldn't answer</h2>
    <p class="note">A guest texted in and we had no fact to answer from. Open the wedding to fill the detail — then the next guest who asks gets an automatic reply. Reply to the guest as many times as you need; mark a question resolved once you've handled it, or dismiss one that isn't actionable.</p>
  </div>
  ${openBody}
  ${handledBody}`,
  )
}

/** The hidden CSRF field every cookie-authenticated browser mutation carries (escaped via the html template). */
function csrfField(csrfToken: string): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${csrfToken}">`
}

/**
 * The themed single-wedding detail page. Reached via `?wedding=<id>` on the console route. Phase 23 adds the
 * prefilled EDIT form: it carries the per-session CSRF token + the wedding_id in a hidden field (the JSON PUT
 * takes the id from the URL the web handler builds; the hidden field tells the handler WHICH wedding to PUT).
 * Both a planner (any wedding) and a couple (their own only) reach this page and may submit — the pipeline
 * masks a couple's non-owned id to 404 before the form is ever rendered, so a forged id never reaches here.
 * `invalid` re-renders the generic edit-failure notice after a failed update (a 400 on an OWNED wedding).
 */
export function renderDetail(
  theme: Tenant['theme'],
  slug: string,
  wedding: Wedding,
  csrfToken: string,
  invalid = false,
): string {
  // Guest-visible logistics facts — rendered (escaped via `html`) only when the planner/couple has set them.
  // These are exactly the facts the guest-messaging responder answers from (see guest_qa_responder.ts).
  const logistics: SafeHtml[] = []
  if (wedding.ceremony_time !== undefined) logistics.push(html`<p>Ceremony: <strong>${wedding.ceremony_time}</strong></p>`)
  if (wedding.venue_name !== undefined) logistics.push(html`<p>Venue: <strong>${wedding.venue_name}</strong></p>`)
  if (wedding.parking_info !== undefined) logistics.push(html`<p>Parking: ${wedding.parking_info}</p>`)
  if (wedding.dress_code !== undefined) logistics.push(html`<p>Dress code: ${wedding.dress_code}</p>`)
  const editWarning = invalid
    ? html`<p class="note" style="color:#b00">Those changes could not be saved. Check the date, time, and fields.</p>`
    : html``
  return themedShell(
    theme,
    slug,
    wedding.couple_display_name,
    html`<p><a href="/t/${slug}?view=weddings">← All weddings</a></p>
  <div class="card">
    <h2>${wedding.couple_display_name}</h2>
    <p>Date: <strong>${wedding.event_date}</strong></p>
    ${logistics}
    <p>Status: <span class="status">${wedding.status}</span></p>
    <p class="note">Wedding id: <code>${wedding.wedding_id}</code> · created ${wedding.created_at}</p>
    <p class="note">Active strategy: <a href="/t/${slug}/strategy">the platform’s data-optimized planning defaults</a> (applied to every wedding in this workspace).</p>
  </div>
  <div class="card"><h3>Edit wedding</h3>${editWarning}
    <form method="post" action="/t/${slug}/weddings/update">
      ${csrfField(csrfToken)}
      <input type="hidden" name="wedding_id" value="${wedding.wedding_id}">
      ${weddingFormFields(wedding)}
      <p class="note">Edit any field and save. Blank an optional logistics field (ceremony, venue, parking, dress code) to clear it — guests will then be told to ask, rather than getting the old answer.</p>
      <p><button type="submit">Save changes</button></p>
    </form>
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
    html`<p><a href="/t/${slug}">← Home</a></p>
  <div class="card">
    <h2>${guidance.headline}</h2>
    <p>${guidance.autonomy.label} <span class="status">${guidance.autonomy.appliedAutomatically ? 'automatic' : 'needs approval'}</span></p>
    <p class="note">${guidance.autonomy.explanation}</p>
  </div>
  ${knobs}
  <p class="note">${guidance.disclaimer}</p>`,
  )
}

/** Format integer cents as a dollar string (e.g. 9900 -> "$99.00"). Plain text, escaped through `html`. */
function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/**
 * The themed "Billing & usage" page (Phase 30 read + Phase 31 pay) — the planner's OWN account summary: plan +
 * monthly price, metered-message usage (count + spend), subscription fees, payments, and the owed balance. Every
 * value is the pure `BillingSummary` projection (the tenant's own ledger fold + the tenant-facing price); all
 * numbers/enum flow through the `html` template (escaped), and the page exposes no provider cost / margin / engine
 * internals. When a balance is OWED it carries a CSRF-gated Pay form (Phase 31) that settles the FULL owed amount
 * (the amount is server-derived from the trusted balance — the form sends no amount); when settled it shows a
 * "nothing owed" note and no form.
 *
 * Phase 32 adds the read-only Activity card: the itemized financial line items (`activity`, newest-first) behind
 * the summary totals — each a fixed human label per kind (a FROZEN lookup with an escaped raw-`kind` fallback, so
 * an unexpected kind from the JSON read never throws), the amount via `dollars`, and the time as escaped text.
 * Empty list → a "No activity yet." note. Markers were already filtered out upstream (financial-only).
 */
export function renderBilling(
  theme: Tenant['theme'],
  slug: string,
  summary: BillingSummary,
  activity: readonly BillingActivityEntry[],
  csrfToken: string,
): string {
  // The Pay form posts to the 4-seg web route (CSRF), distinct from the 3-seg JSON route. It carries ONLY the
  // CSRF field — no amount: the JSON handler settles the trusted owed balance, so the browser cannot influence
  // the sum (a body amount is inert server-side). Shown only when something is owed; otherwise a settled note.
  const settlement =
    summary.balance_cents > 0
      ? html`<form method="post" action="/t/${slug}/billing/pay">${csrfField(csrfToken)}<button type="submit">${`Pay ${dollars(summary.balance_cents)} owed (simulated)`}</button></form>
    <p class="note">An offline demo settlement — no real money moves. This records a payment for the full owed amount.</p>`
      : html`<p class="note">Settled — nothing owed.</p>`
  // The itemized financial line items behind the totals (Phase 32), newest-first. The label is a frozen lookup
  // with an escaped raw-`kind` fallback (an unexpected kind from the JSON read never throws); amount via `dollars`,
  // time as escaped text. All values flow through the `html` template.
  const activityRows = activity.map(
    (entry) =>
      html`<li><span>${activityLabel(entry.kind)}</span> · <strong>${dollars(entry.amount_cents)}</strong> <span class="note">${entry.occurred_at}</span></li>`,
  )
  const activityBody =
    activity.length === 0 ? html`<p class="note">No activity yet.</p>` : html`<ul class="activity">${activityRows}</ul>`
  return themedShell(
    theme,
    slug,
    'Billing & usage',
    html`<p><a href="/t/${slug}">← Home</a></p>
  <div class="card">
    <h2>Your plan</h2>
    <p><strong>${summary.plan_tier}</strong> <span class="status">${`${dollars(summary.monthly_price_cents)} / month`}</span></p>
    <p class="note">An offline demo plan — no real charges are made.</p>
  </div>
  <div class="card">
    <h2>Messaging usage</h2>
    <p>${`${summary.messages_sent} message(s) sent`} · ${`${dollars(summary.messaging_spend_cents)} in metered messaging`}</p>
    <p class="note">Guest replies are metered per message and priced by your plan tier.</p>
  </div>
  <div class="card">
    <h2>Account balance</h2>
    <p><strong>${`${dollars(summary.balance_cents)} owed`}</strong></p>
    <p class="note">${`Subscription ${dollars(summary.subscription_charges_cents)} + messaging ${dollars(summary.messaging_spend_cents)} − payments ${dollars(summary.payments_cents)}.`}</p>
    ${settlement}
  </div>
  <div class="card">
    <h2>Activity</h2>
    <p class="note">Every charge and payment on your account, most recent first.</p>
    ${activityBody}
  </div>`,
  )
}

/** Human labels for the financial activity kinds (Phase 32) — a frozen lookup, NOT raw enum reflection. */
const ACTIVITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  charge: 'Subscription charge',
  usage_charge: 'Messaging usage',
  payment: 'Payment',
})

/** The display label for an activity kind; falls back to the raw (escaped) kind for an unexpected key (never throws). */
function activityLabel(kind: string): string {
  return ACTIVITY_LABELS[kind] ?? kind
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
