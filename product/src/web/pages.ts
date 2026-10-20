import type {
  EscalationReply,
  EscalationResolution,
  Guest,
  GuestEscalation,
  Household,
  Tenant,
  Wedding,
  WeddingGuest,
} from '@wedding-planner/shared'

import type { TeamView } from '../accounts/membership_service'
import type { BillingActivityEntry } from '../billing/billing_activity'
import type { GuestListView } from '../guests/guest_list_service'
import { FEEDBACK_PAGES, type FeedbackPage } from '../feedback/feedback_service'
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

/**
 * Wrap themed content in the full document, injecting the validated brand colors via custom properties. Signed-in
 * pages (issue #12) carry a footer with the "Send feedback" link, which names the page by a FIXED key from a closed
 * list (never its title: a wedding page's title is the couple's names, which must not be copied into feedback).
 */
function themedShell(theme: Tenant['theme'], slug: string, title: string, content: SafeHtml, feedbackPage?: FeedbackPage): string {
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
${
  feedbackPage !== undefined
    ? html`<footer style="max-width:56rem;margin:0 auto;padding:0 1.5rem 1.5rem" class="note"><a href="/t/${slug}/feedback?page=${feedbackPage}">Send feedback</a> — tell us what is wrong or missing.</footer>`
    : html``
}
</body>
</html>`)
}

/** The shell of a page only a signed-in planner or couple reaches: the themed shell plus the feedback footer. */
function signedInShell(theme: Tenant['theme'], slug: string, title: string, content: SafeHtml, page: FeedbackPage): string {
  return themedShell(theme, slug, title, content, page)
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

/**
 * How the login page renders since issue #10 (ADR 0041). Absent ⇒ the legacy picker-only page (hand-built
 * fixtures without accounts).
 */
export interface LoginPageOptions {
  /** The pre-session anti-forgery token the password, forgot and reset forms carry (double-submit cookie). */
  readonly preCsrf: string
  /** Whether the simulated role picker is offered (the demo tenant, in demo mode). */
  readonly simulated: boolean
  readonly notice?: 'credentials' | 'rate_limited' | 'expired' | 'reset_done'
}

const LOGIN_NOTICES: Readonly<Record<NonNullable<LoginPageOptions['notice']>, string>> = Object.freeze({
  credentials: 'That email or password was not accepted.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  expired: 'That form expired. Please try again.',
  reset_done: 'Your password is set. Sign in with it below.',
})

/** The themed sign-in page: email + password, and (demo only, clearly labeled) the simulated role picker. */
export function renderLogin(theme: Tenant['theme'], slug: string, invalid = false, options?: LoginPageOptions): string {
  const warning = invalid
    ? html`<p class="note" style="color:#b00">That login could not be completed. Check the role and wedding id.</p>`
    : html``
  const picker = html`<form method="post" action="/t/${slug}/login">
    <label for="role">Role</label>
    <select id="role" name="role">
      <option value="planner">Planner (workspace staff)</option>
      <option value="couple">Couple (one wedding)</option>
    </select>
    <label for="wedding_id">Wedding id <span class="note">(couples only)</span></label>
    <input id="wedding_id" name="wedding_id" type="text" placeholder="wedding_…" autocomplete="off">
    <p><button type="submit">Sign in</button></p>
  </form>`
  if (options === undefined) {
    return themedShell(
      theme,
      slug,
      'Sign in',
      html`<div class="card">
  <h2>Sign in to ${theme.brand_name}</h2>
  <p class="note">Simulated login — no password (offline demo). Planners see every wedding in the
  workspace; couples see only their own.</p>
  ${warning}
  ${picker}
</div>`,
    )
  }
  const notice =
    options.notice === undefined
      ? html``
      : html`<p class="note" style="color:${options.notice === 'reset_done' ? '#1a7f37' : '#b00'}">${LOGIN_NOTICES[options.notice]}</p>`
  const simulated = options.simulated
    ? html`<div class="card">
  <h2>Demo workspace: simulated sign-in</h2>
  <p class="note">This is the offline demo workspace, so you can also sign in without a password by picking a
  role. Planners see every wedding; couples see only their own. Real workspaces never offer this.</p>
  ${warning}
  ${picker}
</div>`
    : html``
  return themedShell(
    theme,
    slug,
    'Sign in',
    html`<div class="card">
  <h2>Sign in to ${theme.brand_name}</h2>
  ${notice}
  <form method="post" action="/t/${slug}/login">
    <input type="hidden" name="_csrf" value="${options.preCsrf}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <p><button type="submit">Sign in</button></p>
  </form>
  <p class="note"><a href="/t/${slug}/forgot">Forgot your password?</a></p>
</div>
${simulated}`,
  )
}

/** The "forgot password" page: ask for the email; afterwards the same answer whether or not an account exists. */
export function renderForgot(
  theme: Tenant['theme'],
  slug: string,
  preCsrf: string,
  state: 'form' | 'sent' | 'rate_limited' | 'expired' = 'form',
): string {
  if (state === 'sent') {
    return themedShell(
      theme,
      slug,
      'Check your email',
      html`<div class="card">
  <h2>Check your email</h2>
  <p>If an account exists for that address, we have sent it a link to choose a new password. The link works
  once and expires in an hour.</p>
  <p class="note"><a href="/t/${slug}/login">Back to sign in</a></p>
</div>`,
    )
  }
  const notice =
    state === 'rate_limited'
      ? html`<p class="note" style="color:#b00">Too many requests. Wait a while and try again.</p>`
      : state === 'expired'
        ? html`<p class="note" style="color:#b00">That form expired. Please try again.</p>`
        : html``
  return themedShell(
    theme,
    slug,
    'Reset your password',
    html`<div class="card">
  <h2>Reset your password</h2>
  ${notice}
  <form method="post" action="/t/${slug}/forgot">
    <input type="hidden" name="_csrf" value="${preCsrf}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required>
    <p><button type="submit">Send a reset link</button></p>
  </form>
  <p class="note"><a href="/t/${slug}/login">Back to sign in</a></p>
</div>`,
  )
}

const RESET_NOTICES = Object.freeze({
  weak: 'Choose a password of 10 to 128 characters.',
  mismatch: 'The two passwords did not match.',
  invalid: 'This link is invalid or has expired. Ask for a new one.',
  expired: 'That form expired. Please try again.',
})

/** The "choose a new password" page, reached from a reset or account-setup link. */
export function renderReset(
  theme: Tenant['theme'],
  slug: string,
  preCsrf: string,
  token: string,
  notice?: keyof typeof RESET_NOTICES,
): string {
  const warning = notice === undefined ? html`` : html`<p class="note" style="color:#b00">${RESET_NOTICES[notice]}</p>`
  const askAgain = html`<p class="note"><a href="/t/${slug}/forgot">Ask for a new link</a></p>`
  return themedShell(
    theme,
    slug,
    'Choose a password',
    html`<div class="card">
  <h2>Choose a password</h2>
  ${warning}
  <form method="post" action="/t/${slug}/reset">
    <input type="hidden" name="_csrf" value="${preCsrf}">
    <input type="hidden" name="token" value="${token}">
    <label for="password">New password <span class="note">(10 to 128 characters)</span></label>
    <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" required>
    <label for="confirm">Repeat it</label>
    <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" maxlength="128" required>
    <p><button type="submit">Set password</button></p>
  </form>
  ${notice === 'invalid' ? askAgain : html``}
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
  return signedInShell(
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
    'weddings',
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
  return signedInShell(
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
    'guests',
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
  /** Issue #11: present for a planner (the team read answered) — members and pending invitations. */
  readonly team?: { readonly members: number; readonly pending: number }
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
  return signedInShell(
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
  ${
    overview.team === undefined
      ? html``
      : html`<div class="card">
    <h3><a href="/t/${slug}?view=team">Team →</a></h3>
    <p>${`${overview.team.members} member(s) · ${overview.team.pending} pending invitation(s)`}</p>
  </div>`
  }
  <p><a href="/t/${slug}/strategy">View the planning strategy →</a></p>`,
    'home',
  )
}

/** Notices on the team page after an action (issue #11). */
export type TeamNotice = 'invited' | 'exists' | 'invalid' | 'resent' | 'revoked' | 'removed' | 'not_allowed'

const TEAM_NOTICES: Readonly<Record<TeamNotice, string>> = Object.freeze({
  invited: 'Invitation sent.',
  exists: 'That email already has an account here or a pending invitation.',
  invalid: 'That invitation could not be sent. Check the email address.',
  resent: 'A fresh invitation link was sent; the old one no longer works.',
  revoked: 'Invitation revoked.',
  removed: 'Member removed. Their sessions have ended.',
  not_allowed: 'Only the workspace owner can do that.',
})

/**
 * The team page (issue #11): members and pending invitations, an "invite a planner" form for every planner, and —
 * for the workspace owner only — Resend / Revoke on invitations and Remove on other members. Every value is escaped.
 */
export function renderTeam(theme: Tenant['theme'], slug: string, team: TeamView, csrfToken: string, notice?: TeamNotice): string {
  const banner = notice === undefined ? html`` : html`<p class="note">${TEAM_NOTICES[notice]}</p>`
  const members = team.members.map(
    (m) => html`<div class="card">
    <div><strong>${m.email}</strong> <span class="status">${m.role}</span></div>
    <div class="note">${m.wedding_id === undefined ? '' : `Wedding ${m.wedding_id} · `}${m.has_password ? 'active' : 'has not set a password yet'}</div>
    ${
      team.viewer_is_owner && m.user_id !== team.viewer_id
        ? html`<form class="inline" method="post" action="/t/${slug}/team/remove">${csrfField(csrfToken)}<input type="hidden" name="user_id" value="${m.user_id}"><button type="submit">Remove</button></form>`
        : html``
    }
  </div>`,
  )
  const invitations =
    team.invitations.length === 0
      ? html`<p class="note">No pending invitations.</p>`
      : team.invitations.map(
          (i) => html`<div class="card">
    <div><strong>${i.email}</strong> <span class="status">${i.role}</span></div>
    <div class="note">${i.wedding_id === undefined ? '' : `Wedding ${i.wedding_id} · `}invited by ${i.invited_by_email ?? 'someone no longer a member'} · expires ${i.expires_at}</div>
    ${
      team.viewer_is_owner
        ? html`<form class="inline" method="post" action="/t/${slug}/team/resend">${csrfField(csrfToken)}<input type="hidden" name="invitation_id" value="${i.invitation_id}"><button type="submit">Resend</button></form>
    <form class="inline" method="post" action="/t/${slug}/team/revoke">${csrfField(csrfToken)}<input type="hidden" name="invitation_id" value="${i.invitation_id}"><button type="submit">Revoke</button></form>`
        : html``
    }
  </div>`,
        )
  return signedInShell(
    theme,
    slug,
    'Team',
    html`<p><a href="/t/${slug}">← Home</a></p>
  <h2>Team</h2>
  ${banner}
  <div class="card">
    <h3>Invite a planner</h3>
    <form method="post" action="/t/${slug}/team/invite">
      ${csrfField(csrfToken)}
      <input type="hidden" name="role" value="planner">
      <label for="invite_email">Email</label>
      <input id="invite_email" name="email" type="email" required autocomplete="off">
      <p><button type="submit">Send invitation</button></p>
    </form>
    <p class="note">They get a link (through the outbox while email is simulated) that works once for 7 days. To invite a couple, open their wedding.</p>
  </div>
  <h3>Members</h3>
  ${members}
  <h3>Pending invitations</h3>
  ${invitations}`,
    'team',
  )
}

const ACCEPT_NOTICES = Object.freeze({
  weak: 'Choose a password of 10 to 128 characters.',
  mismatch: 'The two passwords did not match.',
  invalid: 'This invitation link is invalid, used or expired. Ask the person who invited you for a new one.',
  exists: 'An account with this email already exists here. Sign in instead.',
  expired: 'That form expired. Please try again.',
})

/** The invitation accept page (issue #11): choose a password; accepting creates the account and signs you in. */
export function renderInviteAccept(
  theme: Tenant['theme'],
  slug: string,
  preCsrf: string,
  token: string,
  notice?: keyof typeof ACCEPT_NOTICES,
): string {
  const warning = notice === undefined ? html`` : html`<p class="note" style="color:#b00">${ACCEPT_NOTICES[notice]}</p>`
  return themedShell(
    theme,
    slug,
    'Accept your invitation',
    html`<div class="card">
  <h2>Join ${theme.brand_name}</h2>
  <p>Choose a password to accept your invitation. You will be signed in straight away.</p>
  ${warning}
  <form method="post" action="/t/${slug}/invite">
    <input type="hidden" name="_csrf" value="${preCsrf}">
    <input type="hidden" name="token" value="${token}">
    <label for="password">Password <span class="note">(10 to 128 characters)</span></label>
    <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" required>
    <label for="confirm">Repeat it</label>
    <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" maxlength="128" required>
    <p><button type="submit">Accept and sign in</button></p>
  </form>
</div>`,
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
 * The label for a reply turn's author. EXHAUSTIVE three-way (NOT a binary `planner`-else fallthrough, which
 * would mislabel a Phase-35 `guest` follow-up turn as "Couple" — a trust-presentation bug). Module-level so the
 * inbox (`renderEscalations`) AND the per-conversation transcript (`renderConversation`) share ONE mapping.
 */
function senderLabel(sender: EscalationReply['sender']): string {
  return sender === 'guest' ? 'Guest' : sender === 'planner' ? 'Planner' : 'Couple'
}

/** The label for a status transition in the conversation transcript (raw history — NOT an effective-status fold). */
function transitionLabel(status: EscalationResolution['status']): string {
  return status === 'resolved' ? 'Marked resolved' : status === 'dismissed' ? 'Dismissed' : 'Reopened'
}

/**
 * One event in a single escalation's chronological transcript (Phase 38). A discriminated union over the THREE
 * sources the scoped `GET /t/:slug/escalations` already returns — the question (singleton), each reply turn, and
 * each status transition — each NORMALIZED to one `at` (the source's own ISO-8601 stamp: `received_at` /
 * `sent_at` / `resolved_at`) and its own per-source `seq`. Built and rendered ONLY from already-scoped data.
 */
export type ConversationEvent =
  | { readonly kind: 'question'; readonly at: string; readonly seq: number; readonly text: string; readonly from_ref: string; readonly channel: string }
  | { readonly kind: 'reply'; readonly at: string; readonly seq: number; readonly sender: EscalationReply['sender']; readonly body: string }
  | { readonly kind: 'transition'; readonly at: string; readonly seq: number; readonly status: EscalationResolution['status']; readonly by: EscalationResolution['resolved_by'] }

/**
 * The equal-timestamp GROUP rank `G` for the transcript comparator. The ONLY load-bearing distinctions are the
 * CROSS-SOURCE reply↔transition ties that genuinely occur within ONE synchronous handler block:
 *   - a `reopened` transition (G1) precedes a same-instant `reply` (G2): an inbound auto-reopen (Phase 37,
 *     `product_api.ts` inbound branch) writes the `reopened` transition STRICTLY BEFORE the guest reply turn,
 *     both from the same un-advanced `clock.now()` — so the reopen must render before the guest turn it enabled.
 *   - a `reply` (G2) precedes a same-instant close transition (G3): a Phase-28 console reply writes the reply
 *     turn, then (a separate action) the resolve — a close FOLLOWS the dialogue that prompted it.
 * INVARIANT: production NEVER writes two transitions at one `at` (exactly two `transition()` call sites — the
 * operator route, one-per-request; and the inbound branch, one `reopened` + a *reply*), so the transition↔
 * transition `G` order (reopened<close) is an UNREACHED don't-care (a same-instant `resolved`→`reopened` is only
 * constructible in a fixture that omits a clock advance; SystemClock always advances). A characterization test
 * freezes that don't-care so it is never silently implementation-defined.
 */
function conversationEventRank(e: ConversationEvent): number {
  if (e.kind === 'question') return 0
  if (e.kind === 'transition') return e.status === 'reopened' ? 1 : 3
  return 2 // reply
}

/**
 * The TOTAL, transitive transcript order: lexicographic over `(at, G, seq)`. Primary `at` (ISO-8601 strings sort
 * chronologically) is correct whenever the clock advanced between events (the production reality). The `(G, seq)`
 * tiebreak only disambiguates same-instant fixtures and the cross-source ties above, and being a plain
 * lexicographic tuple it can never form an inconsistent (non-transitive) comparator.
 */
function compareConversationEvents(a: ConversationEvent, b: ConversationEvent): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  const ga = conversationEventRank(a)
  const gb = conversationEventRank(b)
  if (ga !== gb) return ga - gb
  return a.seq - b.seq
}

/**
 * Build the chronological transcript for ONE escalation (Phase 38). Takes the escalation OBJECT (so the join key
 * is provably the trusted, in-scope `escalation.escalation_id` — never the client `?conversation=` string) plus
 * the FULL scoped `resolutions` and `replies` arrays, and OWNS the join: it filters each to this escalation_id
 * (single-sourcing the "which rows belong to this conversation" decision, like `countOpenEscalations`). It renders
 * RAW transition history and computes NO effective status — the timeline's last event is a DISPLAY order
 * (`compareConversationEvents`), NOT the max-`seq` effective-status fold (`effectiveTransitionByEscalation`); any
 * current-status summary must come from that fold, never from "the last timeline event".
 */
export function buildConversationTimeline(
  escalation: GuestEscalation,
  resolutions: readonly EscalationResolution[],
  replies: readonly EscalationReply[],
): readonly ConversationEvent[] {
  const id = escalation.escalation_id
  const events: ConversationEvent[] = [
    { kind: 'question', at: escalation.received_at, seq: 0, text: escalation.text, from_ref: escalation.from_ref, channel: escalation.channel },
  ]
  for (const reply of replies) {
    if (reply.escalation_id !== id) continue
    events.push({ kind: 'reply', at: reply.sent_at, seq: reply.seq, sender: reply.sender, body: reply.body })
  }
  for (const transition of resolutions) {
    if (transition.escalation_id !== id) continue
    events.push({ kind: 'transition', at: transition.resolved_at, seq: transition.seq, status: transition.status, by: transition.resolved_by })
  }
  return events.sort(compareConversationEvents)
}

/**
 * The themed per-conversation TRANSCRIPT page (Phase 38) — the read-only legibility companion to the inbox. Shows
 * ONE escalation's full chronological story: the original question, every reply turn (operator AND the Phase-35
 * bi-directional `guest` follow-ups) and every status transition (resolved / dismissed / reopened, with who +
 * when), interleaved by time via `buildConversationTimeline`. Pure render-time composition over the SAME scoped
 * `GET /t/:slug/escalations` body the inbox reads (no new data path). READ-ONLY — no forms, so no CSRF token; the
 * "← Back to all questions" link returns to the inbox where the Reply/Resolve/Reopen actions live. Every dynamic
 * value (guest `text`/`body`, `from_ref`, timestamps, `resolved_by`) flows through `html` as escaped TEXT — a
 * guest turn is never reflected to the guest. The page title is a CONSTANT (never the client `conversation` value).
 */
export function renderConversation(
  theme: Tenant['theme'],
  slug: string,
  escalation: GuestEscalation,
  resolutions: readonly EscalationResolution[],
  replies: readonly EscalationReply[],
): string {
  const timeline = buildConversationTimeline(escalation, resolutions, replies)
  const eventCard = (e: ConversationEvent): SafeHtml => {
    if (e.kind === 'question') {
      return html`<div class="card">
    <div class="note">${e.at} · guest <code>${e.from_ref}</code> · via ${e.channel} · <strong>asked</strong></div>
    <div><strong>“${e.text}”</strong></div>
  </div>`
    }
    if (e.kind === 'reply') {
      return html`<div class="card">
    <div class="note">${e.at} · ${senderLabel(e.sender)} <strong>replied</strong></div>
    <div>“${e.body}”</div>
  </div>`
    }
    return html`<div class="note">${e.at} · <strong>${transitionLabel(e.status)}</strong> by ${e.by}</div>`
  }
  const cards = timeline.map(eventCard)
  return signedInShell(
    theme,
    slug,
    'Guest conversation',
    html`<p><a href="/t/${slug}?view=escalations">← Back to all questions</a></p>
  <div class="card">
    <h2>Conversation</h2>
    <p class="note">The full history of this guest question — every message and status change, in order. <a href="/t/${slug}?wedding=${escalation.wedding_id}">Set the missing details →</a></p>
  </div>
  ${cards}`,
    'conversation',
  )
}

/**
 * The themed "no such conversation" notice (Phase 38) — returned at status 200 when the scoped read succeeded but
 * the requested `conversation` id is NOT in the principal's scoped escalations (ABSENT or a couple probing a
 * sibling-wedding's escalation — byte-identical, since the scoped read already excluded the foreign row). It is a
 * FROZEN themed fragment with ZERO interpolation of the client `conversation` value (the `renderDetail` "never
 * reflect the id" rule), so absent ≡ foreign discloses nothing about other weddings. NOT a `GENERIC_404` (that is
 * the unknown-tenant mask; the read already proved this tenant active — a 404 here would be leakier, not safer).
 */
export function renderConversationNotFound(theme: Tenant['theme'], slug: string): string {
  return signedInShell(
    theme,
    slug,
    'Guest conversation',
    html`<p><a href="/t/${slug}?view=escalations">← Back to all questions</a></p>
  <div class="card">
    <h2>Conversation</h2>
    <p class="note">We couldn't find that conversation.</p>
  </div>`,
    'conversation',
  )
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
  // The author label is the module-level `senderLabel` (shared with the Phase-38 transcript) — an EXHAUSTIVE
  // three-way map so a guest turn is never mislabeled as "Couple". Empty when no turns yet.
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
    <div class="note">Wedding <code>${e.wedding_id}</code> · <a href="/t/${slug}?wedding=${e.wedding_id}">Set the missing details →</a> · <a href="/t/${slug}?view=escalations&amp;conversation=${e.escalation_id}">View full conversation →</a></div>
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
    <div class="note">From <code>${e.from_ref}</code> · ${e.received_at} · <a href="/t/${slug}?view=escalations&amp;conversation=${e.escalation_id}">View full conversation →</a></div>
    <div class="inline">${actionForm(e.escalation_id, 'reopened', 'Reopen')}</div>
  </div>`
  })

  const openBody =
    open.length === 0
      ? html`<p class="note">No open questions — guests haven't asked anything we couldn't answer (or you've handled them all).</p>`
      : html`${openRows}`
  const handledBody =
    handled.length === 0 ? html`` : html`<h3>Handled</h3>${handledRows}`
  return signedInShell(
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
    'questions',
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
  inviteCouple?: { readonly notice?: 'sent' | 'exists' | 'invalid' },
): string {
  // Issue #11: a planner can invite this wedding's couple (role couple, bound to this wedding).
  const inviteNotices = {
    sent: 'Invitation sent to the couple.',
    exists: 'That email already has an account here or a pending invitation.',
    invalid: 'That invitation could not be sent. Check the email address.',
  } as const
  const inviteCard =
    inviteCouple === undefined
      ? html``
      : html`<div class="card"><h3>Invite the couple</h3>
    ${inviteCouple.notice === undefined ? html`` : html`<p class="note">${inviteNotices[inviteCouple.notice]}</p>`}
    <form method="post" action="/t/${slug}/team/invite">
      ${csrfField(csrfToken)}
      <input type="hidden" name="role" value="couple">
      <input type="hidden" name="wedding_id" value="${wedding.wedding_id}">
      <label for="couple_email">Couple's email</label>
      <input id="couple_email" name="email" type="email" required autocomplete="off">
      <p><button type="submit">Send invitation</button></p>
    </form>
    <p class="note">They get their own sign-in and see only this wedding.</p>
  </div>`
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
  return signedInShell(
    theme,
    slug,
    wedding.couple_display_name,
    html`<p><a href="/t/${slug}?view=weddings">← All weddings</a></p>
  <div class="card">
    <h2>${wedding.couple_display_name}</h2>
    <p>Date: <strong>${wedding.event_date}</strong></p>
    ${logistics}
    <p>Status: <span class="status">${wedding.status}</span></p>
    <p><a href="/t/${slug}?wedding=${wedding.wedding_id}&amp;tab=guests">Guest list →</a></p>
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
  </div>
  ${inviteCard}`,
    'wedding',
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
  return signedInShell(
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
    'strategy',
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
  return signedInShell(
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
    'billing',
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

/**
 * The "Send feedback" form (issue #12): what were you trying to do, what happened, and (prefilled from the footer
 * link) the page you came from. Only what the person types is sent.
 */
export function renderFeedback(
  theme: Tenant['theme'],
  slug: string,
  csrfToken: string,
  page: FeedbackPage | undefined,
  notice?: 'invalid' | 'rate_limited',
): string {
  const options = (Object.keys(FEEDBACK_PAGES) as FeedbackPage[]).map((key) =>
    key === page
      ? html`<option value="${key}" selected>${FEEDBACK_PAGES[key]}</option>`
      : html`<option value="${key}">${FEEDBACK_PAGES[key]}</option>`,
  )
  const warning =
    notice === 'invalid'
      ? html`<p class="note" style="color:#b00">Please fill in both boxes (up to 1,000 and 4,000 characters).</p>`
      : notice === 'rate_limited'
        ? html`<p class="note" style="color:#b00">That is a lot of feedback at once. Please try again later.</p>`
        : html``
  return signedInShell(
    theme,
    slug,
    'Send feedback',
    html`<p><a href="/t/${slug}">← Home</a></p>
  <div class="card">
    <h2>Send feedback</h2>
    <p class="note">Tell us what is wrong or missing. We see only what you write here, which page you came from, and whether you are a planner or a couple.</p>
    ${warning}
    <form method="post" action="/t/${slug}/feedback/send">
      ${csrfField(csrfToken)}
      <label for="trying">What were you trying to do?</label>
      <textarea id="trying" name="trying" rows="3" maxlength="1000" required style="width:100%"></textarea>
      <label for="happened">What happened?</label>
      <textarea id="happened" name="happened" rows="5" maxlength="4000" required style="width:100%"></textarea>
      <label for="page">Which page were you on?</label>
      <select id="page" name="page"><option value="">(not sure)</option>${options}</select>
      <p><button type="submit">Send</button></p>
    </form>
  </div>`,
    'other',
  )
}

/** After sending feedback (issue #12). */
export function renderFeedbackThanks(theme: Tenant['theme'], slug: string): string {
  return signedInShell(
    theme,
    slug,
    'Thank you',
    html`<div class="card"><h2>Thank you</h2><p>Your feedback was sent.</p><p><a href="/t/${slug}">← Back to your workspace</a></p></div>`,
    'other',
  )
}

/** Notices on the guest list after an action (issue #27). */
export type GuestListNotice = 'saved' | 'removed' | 'invalid' | 'conflict'

const GUEST_LIST_NOTICES: Readonly<Record<GuestListNotice, string>> = Object.freeze({
  saved: 'Saved.',
  removed: 'Removed.',
  invalid: 'That could not be saved. Check the fields (names are required; an email must look like one).',
  conflict: 'That is not possible right now (a guest already has a plus-one, or the list is full).',
})

const SIDE_LABELS: Readonly<Record<WeddingGuest['side'], string>> = Object.freeze({
  partner_one: 'Partner one',
  partner_two: 'Partner two',
  both: 'Both',
})

/** The side select, preselected. */
function sideOptions(selected: WeddingGuest['side'] = 'both'): SafeHtml[] {
  return (Object.keys(SIDE_LABELS) as WeddingGuest['side'][]).map((side) =>
    side === selected
      ? html`<option value="${side}" selected>${SIDE_LABELS[side]}</option>`
      : html`<option value="${side}">${SIDE_LABELS[side]}</option>`,
  )
}

/** The guest fields of the add and edit forms. */
function guestFields(prefix: string, guest?: WeddingGuest): SafeHtml {
  return html`<label for="${prefix}_first">First name</label>
      <input id="${prefix}_first" name="first_name" maxlength="80" required value="${guest?.first_name ?? ''}">
      <label for="${prefix}_last">Last name</label>
      <input id="${prefix}_last" name="last_name" maxlength="80" value="${guest?.last_name ?? ''}">
      <label for="${prefix}_side">Side</label>
      <select id="${prefix}_side" name="side">${sideOptions(guest?.side)}</select>
      <label for="${prefix}_tags">Tags <span class="note">(comma-separated)</span></label>
      <input id="${prefix}_tags" name="tags" maxlength="400" value="${(guest?.tags ?? []).join(', ')}">
      <label for="${prefix}_dietary">Dietary needs</label>
      <input id="${prefix}_dietary" name="dietary" maxlength="300" value="${guest?.dietary ?? ''}">
      <label for="${prefix}_email">Email</label>
      <input id="${prefix}_email" name="email" type="email" maxlength="254" value="${guest?.email ?? ''}">
      <label for="${prefix}_phone">Phone</label>
      <input id="${prefix}_phone" name="phone" maxlength="40" value="${guest?.phone ?? ''}">`
}

/**
 * A wedding's guest list (issue #27): counts, every household with its guests, and the forms to add, edit and remove
 * (collapsible, no script). Every value is escaped; contact details appear only here, for the planner and the couple.
 */
export function renderGuestList(
  theme: Tenant['theme'],
  slug: string,
  wedding: Wedding,
  list: GuestListView,
  csrfToken: string,
  notice?: GuestListNotice,
): string {
  const w = wedding.wedding_id
  const banner = notice === undefined ? html`` : html`<p class="note">${GUEST_LIST_NOTICES[notice]}</p>`
  const hidden = (fields: Record<string, string>): SafeHtml[] =>
    Object.entries(fields).map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`)
  const guestLine = (g: WeddingGuest): SafeHtml => {
    const host = g.plus_one_of === undefined ? undefined : list.guests.find((x) => x.guest_id === g.plus_one_of)
    const hasPlusOne = list.guests.some((x) => x.plus_one_of === g.guest_id)
    const details = [
      SIDE_LABELS[g.side],
      ...(host === undefined ? [] : [`plus-one of ${host.first_name}`]),
      ...(g.plus_one_allowed ? [hasPlusOne ? 'has a plus-one' : 'may bring a plus-one'] : []),
      ...(g.tags.length === 0 ? [] : [g.tags.join(', ')]),
      ...(g.dietary === undefined ? [] : [`dietary: ${g.dietary}`]),
      ...(g.email === undefined ? [] : [g.email]),
      ...(g.phone === undefined ? [] : [g.phone]),
    ].join(' · ')
    return html`<li><strong>${g.first_name} ${g.last_name}</strong> <span class="note">${details}</span>
      <a href="/t/${slug}?wedding=${w}&amp;tab=guests&amp;guest=${g.guest_id}">Edit</a>
      <form class="inline" method="post" action="/t/${slug}/guest-list/guest-remove">${csrfField(csrfToken)}${hidden({ wedding_id: w, guest_id: g.guest_id })}<button type="submit">Remove</button></form>
      ${
        g.plus_one_allowed && !hasPlusOne
          ? html`<details><summary>Add their plus-one</summary>
        <form method="post" action="/t/${slug}/guest-list/guest-add">${csrfField(csrfToken)}${hidden({ wedding_id: w, plus_one_of: g.guest_id, side: g.side })}
          <label>First name <input name="first_name" maxlength="80" required></label>
          <label>Last name <input name="last_name" maxlength="80"></label>
          <button type="submit">Add plus-one</button>
        </form></details>`
          : html``
      }</li>`
  }
  const households = list.households.map((h: Household) => {
    const members = list.guests.filter((g) => g.household_id === h.household_id)
    return html`<div class="card">
    <h3>${h.name}</h3>
    ${h.address === undefined ? html`` : html`<p class="note">${h.address}</p>`}
    <ul>${members.map(guestLine)}</ul>
    <details><summary>Add a guest to this household</summary>
      <form method="post" action="/t/${slug}/guest-list/guest-add">${csrfField(csrfToken)}${hidden({ wedding_id: w, household_id: h.household_id })}
        ${guestFields(`add_${h.household_id}`)}
        <label><input type="checkbox" name="plus_one_allowed" value="true"> May bring a plus-one</label>
        <p><button type="submit">Add guest</button></p>
      </form></details>
    <details><summary>Edit or remove this household</summary>
      <form method="post" action="/t/${slug}/guest-list/household-update">${csrfField(csrfToken)}${hidden({ wedding_id: w, household_id: h.household_id })}
        <label>Name <input name="name" maxlength="120" required value="${h.name}"></label>
        <label>Mailing address <input name="address" maxlength="300" value="${h.address ?? ''}"></label>
        <p><button type="submit">Save household</button></p>
      </form>
      <form method="post" action="/t/${slug}/guest-list/household-remove">${csrfField(csrfToken)}${hidden({ wedding_id: w, household_id: h.household_id })}
        <button type="submit">Remove the household and its guests</button>
      </form></details>
  </div>`
  })
  const c = list.counts
  return signedInShell(
    theme,
    slug,
    'Guest list',
    html`<p><a href="/t/${slug}?wedding=${w}">← ${wedding.couple_display_name}</a></p>
  <h2>Guest list</h2>
  ${banner}
  <div class="card">
    <p><strong>${`${c.guests} guest(s)`}</strong> in ${`${c.households} household(s)`} · ${`${c.plus_ones} plus-one(s)`}</p>
    <p class="note">${`Partner one: ${c.by_side.partner_one} · Partner two: ${c.by_side.partner_two} · Both: ${c.by_side.both}`}</p>
  </div>
  <div class="card">
    <h3>Add a household</h3>
    <form method="post" action="/t/${slug}/guest-list/household-add">${csrfField(csrfToken)}${hidden({ wedding_id: w })}
      <label for="h_name">Name <span class="note">(e.g. "The Rivera family")</span></label>
      <input id="h_name" name="name" maxlength="120" required>
      <label for="h_address">Mailing address <span class="note">(optional)</span></label>
      <input id="h_address" name="address" maxlength="300">
      <p><button type="submit">Add household</button></p>
    </form>
  </div>
  ${households}`,
    'wedding',
  )
}

/** Edit one guest (issue #27). A plus-one stays in their host's household. */
export function renderGuestEdit(
  theme: Tenant['theme'],
  slug: string,
  wedding: Wedding,
  guest: WeddingGuest,
  households: readonly Household[],
  csrfToken: string,
  invalid = false,
): string {
  const w = wedding.wedding_id
  const householdField =
    guest.plus_one_of === undefined
      ? html`<label for="e_household">Household</label>
      <select id="e_household" name="household_id">${households.map((h) =>
        h.household_id === guest.household_id
          ? html`<option value="${h.household_id}" selected>${h.name}</option>`
          : html`<option value="${h.household_id}">${h.name}</option>`,
      )}</select>
      <label><input type="checkbox" name="plus_one_allowed" value="true"${guest.plus_one_allowed ? html` checked` : html``}> May bring a plus-one</label>`
      : html`<p class="note">A plus-one stays in their host's household.</p>`
  return signedInShell(
    theme,
    slug,
    'Edit guest',
    html`<p><a href="/t/${slug}?wedding=${w}&amp;tab=guests">← Guest list</a></p>
  <div class="card">
    <h2>Edit guest</h2>
    ${invalid ? html`<p class="note" style="color:#b00">${GUEST_LIST_NOTICES.invalid}</p>` : html``}
    <form method="post" action="/t/${slug}/guest-list/guest-update">
      ${csrfField(csrfToken)}
      <input type="hidden" name="wedding_id" value="${w}">
      <input type="hidden" name="guest_id" value="${guest.guest_id}">
      ${guestFields('e', guest)}
      ${householdField}
      <p><button type="submit">Save guest</button></p>
    </form>
  </div>`,
    'wedding',
  )
}

/** The themed forbidden page (a capability the role lacks — a 403, not a masked resource). */
export function renderForbidden(theme: Tenant['theme'], slug: string): string {
  return signedInShell(
    theme,
    slug,
    'Not allowed',
    html`<div class="card"><h2>Not allowed</h2><p class="note">Your role can't perform that action here.</p></div>`,
    'other',
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
