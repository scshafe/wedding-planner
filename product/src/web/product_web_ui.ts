import type { EscalationResolution, Guest, GuestEscalation, Wedding } from '@wedding-planner/shared'

import type { BillingActivityEntry } from '../billing/billing_activity'
import type { BillingSummary } from '../billing/billing_summary'
import type { CsrfGuard } from '../auth/csrf_guard'
import type { ApiRequest } from '../http/api_message'
import { splitPath } from '../http/path'
import type { ProductApi } from '../http/product_api'
import type { StrategyGuidance } from '../strategy/strategy_guidance'
import { WEDDING_LOGISTICS_FIELDS } from '../wedding/wedding_repository'
import { normalizeSlugForRoute } from './html'
import {
  type AccountOverview,
  countOpenEscalations,
  ERROR_500,
  GENERIC_404,
  renderBilling,
  renderConsole,
  renderDetail,
  renderEscalations,
  renderForbidden,
  renderGuests,
  renderHome,
  renderLanding,
  renderLogin,
  renderStrategy,
} from './pages'
import type { ThemeResolver } from './theme_resolver'
import { htmlResult, type HttpResult, jsonResultFrom, redirect } from './web_response'

/**
 * @canonical product_web_ui -- the server-rendered HTML front door over the Phase-13 JSON pipeline.
 *
 * Holds `{ api, themes, csrf }` — no resolver, sessionStore, or repository (exactly as the Phase-13
 * dispatch handlers don't). Its only DATA path is `api.handle()`; `themes` is theme-only and `csrf` (Phase
 * 21) is an anti-forgery check that reads NO tenant data — neither is a data path. So the UI inherits BOTH
 * boundaries structurally — it cannot read a tenant's data except through the pipeline that enforces them,
 * and it makes NO independent existence decision (existence + auth + theme are all derived from `api.handle()`
 * calls, by status):
 *
 *   200 -> themed data page (console / detail)   401 -> themed login (active tenant, not yet authed)
 *   403 -> themed forbidden                       404/else -> the constant GENERIC_404 (no theme)
 *
 * The inbound `:slug` is VALIDATED at the edge (normalizeSlugForRoute) before any HTML/header use; a
 * non-match takes the SAME masked GENERIC_404 as an unknown tenant (never a distinct 400 — an oracle).
 * The browser carries the opaque Bearer token in a `wp_session` cookie; the UI forwards it VERBATIM as
 * `Authorization: Bearer <token>` and lets the pipeline's cross-tenant bind veto decide (the cookie adds
 * no new token authority; it is never short-circuited on).
 *
 * The browser MUTATIONS (Phase 21) — `POST /t/:slug/logout`, `/t/:slug/guests/create`, and
 * `/t/:slug/guests/remove` — are the place a cookie becomes a credential (the handler reads `wp_session` and
 * mints an internal Bearer), so each is CSRF-protected: it verifies the per-session `_csrf` token before any
 * mutation, and a forged token returns the masked 403 with NO state change (a forged logout therefore does
 * NOT clear the cookie). The JSON API is Bearer-only and NOT CSRF-reachable, so it carries no token. Login is
 * the documented exemption — no session yet to bind a token to (SameSite=Strict covers it).
 *
 * Routing is an ordered, exact-segment table: the UI owns `/`, `/t/:slug` (2 segs; `?wedding=ID` detail and
 * `?view=guests` management), `/t/:slug/login`, `/t/:slug/logout`, and the 4-seg `/t/:slug/guests/create` +
 * `/t/:slug/guests/remove` form posts; EVERYTHING else delegates to `api.handle()` (wrapped as a JSON
 * HttpResult), so the keystone-protected JSON paths (`/healthz`, `/t/:slug/sessions`, `/t/:slug/weddings...`,
 * the 3-seg `/t/:slug/guests` JSON API) reach the unchanged handler. The web form routes use DISTINCT names
 * from the JSON routes (mirroring `/login` ↔ `/sessions`), so they never collide and the JSON API stays
 * programmatically reachable; queries are stripped from the path before routing.
 *
 * related: pages.ts (the render fns), product_api.ts (the delegated JSON pipeline), theme_resolver.ts,
 * csrf_guard.ts (the anti-forgery boundary).
 */

/** The cookie that carries the opaque session token. */
const SESSION_COOKIE = 'wp_session'

/** A server-minted token charset guard — never emit a cookie value that could break the header. */
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/

export interface ProductWebUiDeps {
  readonly api: ProductApi
  readonly themes: ThemeResolver
  /**
   * Phase 21: the browser-form anti-forgery guard. Narrowed to {@link CsrfGuard} (issue/verify only — NOT the
   * SessionStore), so the UI can check a token but can neither mint nor resolve a principal. Reads no tenant
   * data, so the "only data path is api.handle()" invariant holds.
   */
  readonly csrf: CsrfGuard
}

export class ProductWebUi {
  readonly #api: ProductApi
  readonly #themes: ThemeResolver
  readonly #csrf: CsrfGuard

  constructor(deps: ProductWebUiDeps) {
    this.#api = deps.api
    this.#themes = deps.themes
    this.#csrf = deps.csrf
  }

  /** Run a request through the HTML front door. Never throws — any slip becomes the constant 500. */
  handle(req: ApiRequest): HttpResult {
    try {
      return this.#route(req)
    } catch {
      return ERROR_500
    }
  }

  #route(req: ApiRequest): HttpResult {
    const segments = splitPath(req.path)

    // GET / -> the generic, tenant-independent landing.
    if (segments.length === 0) {
      if (req.method === 'GET') return htmlResult(200, renderLanding())
      return this.#delegate(req)
    }

    if (segments[0] === 't' && segments.length >= 2) {
      // The slug is validated to the schema shape BEFORE any HTML/header use; a miss is masked as 404.
      const slug = normalizeSlugForRoute(segments[1] ?? '')

      // /t/:slug (exactly two segments) -> the console (list, or detail via ?wedding=ID).
      if (segments.length === 2 && req.method === 'GET') {
        return slug === undefined ? GENERIC_404 : this.#console(req, slug)
      }

      // /t/:slug/login, /t/:slug/logout, and the read-only /t/:slug/strategy (GET) are the UI routes.
      if (segments.length === 3) {
        if (segments[2] === 'login') return slug === undefined ? GENERIC_404 : this.#login(req, slug)
        if (segments[2] === 'logout') return slug === undefined ? GENERIC_404 : this.#logout(req, slug)
        // GET only — a non-GET /t/:slug/strategy falls through to the JSON pipeline (401/405).
        if (segments[2] === 'strategy' && req.method === 'GET') {
          return slug === undefined ? GENERIC_404 : this.#strategy(req, slug)
        }
      }

      // /t/:slug/guests/{create,remove} (Phase 21) — the browser FORM posts (CSRF-protected). DISTINCT names
      // from the JSON /t/:slug/guests route (3-seg) so they never collide. A malformed slug masks to 404
      // BEFORE any cookie read / CSRF verdict (the CSRF outcome is never a tenant-existence oracle).
      if (segments.length === 4 && segments[2] === 'guests' && req.method === 'POST') {
        if (slug === undefined) return GENERIC_404
        if (segments[3] === 'create') return this.#guestCreate(req, slug)
        if (segments[3] === 'remove') return this.#guestRemove(req, slug)
      }

      // /t/:slug/escalations/resolve (Phase 27) — the browser Resolve/Dismiss FORM post (CSRF-protected).
      // DISTINCT from the 3-seg JSON /t/:slug/escalations route (GET read / POST resolve), so they never
      // collide. A malformed slug masks to 404 BEFORE any cookie read / CSRF verdict (the CSRF outcome is never
      // a tenant-existence oracle), exactly like the guests/weddings form posts.
      if (segments.length === 4 && segments[2] === 'escalations' && segments[3] === 'resolve' && req.method === 'POST') {
        if (slug === undefined) return GENERIC_404
        return this.#escalationResolve(req, slug)
      }

      // /t/:slug/escalations/reply (Phase 28) — the browser Reply FORM post (CSRF-protected): answer the guest
      // directly (a metered send that auto-resolves). DISTINCT 4-seg name from the resolve form and the 3-seg
      // JSON route; slug masked to 404 BEFORE any cookie read / CSRF verdict, exactly like the resolve form.
      if (segments.length === 4 && segments[2] === 'escalations' && segments[3] === 'reply' && req.method === 'POST') {
        if (slug === undefined) return GENERIC_404
        return this.#escalationReply(req, slug)
      }

      // /t/:slug/billing/pay (Phase 31) — the browser Pay FORM post (CSRF-protected): settle the owed balance.
      // DISTINCT 4-seg name from the 3-seg JSON /t/:slug/billing route (GET read / POST settle), so they never
      // collide and the JSON pay route stays NOT CSRF-reachable. Slug masked to 404 BEFORE any cookie/CSRF read.
      if (segments.length === 4 && segments[2] === 'billing' && segments[3] === 'pay' && req.method === 'POST') {
        if (slug === undefined) return GENERIC_404
        return this.#billingPay(req, slug)
      }

      // /t/:slug/weddings/{create,update} (Phase 23) — the browser wedding FORM posts (CSRF-protected).
      // DISTINCT names from the JSON 4-seg /t/:slug/weddings/:id route (which accepts GET/PUT only); a
      // server-minted `wedding_…` id can never equal the literal `create`/`update`, so they never collide,
      // and this POST-only intercept runs BEFORE #delegate. Slug masked to 404 before any cookie/CSRF read.
      if (segments.length === 4 && segments[2] === 'weddings' && req.method === 'POST') {
        if (slug === undefined) return GENERIC_404
        if (segments[3] === 'create') return this.#weddingCreate(req, slug)
        if (segments[3] === 'update') return this.#weddingUpdate(req, slug)
      }
    }

    // Everything else is the JSON API (keystone-protected) — reached unchanged via the pipeline.
    return this.#delegate(req)
  }

  /**
   * GET /t/:slug — the account HOME overview by default (Phase 33), or one of the spoke views by query: the
   * `?wedding=ID` detail, `?view=weddings` list, `?view=guests|escalations|billing` management. Themed strictly
   * by status (each spoke makes its own `api.handle()` read).
   */
  #console(req: ApiRequest, slug: string): HttpResult {
    // ?view=weddings — the wedding list + create form (Phase 33 relocated it here; the home is now the default).
    if (queryParam(req.path, 'view') === 'weddings') return this.#weddingList(req, slug)
    // ?view=guests — the guest-management page (Phase 21 planner; Phase 24 couple, scoped to their wedding).
    if (queryParam(req.path, 'view') === 'guests') return this.#guestsPage(req, slug)
    // ?view=escalations — the read-only escalation inbox (Phase 26; planner whole-tenant, couple their wedding).
    if (queryParam(req.path, 'view') === 'escalations') return this.#escalationsPage(req, slug)
    // ?view=billing — the planner billing & usage summary (Phase 30; planner-only, a couple is themed Forbidden).
    if (queryParam(req.path, 'view') === 'billing') return this.#billingPage(req, slug)

    const weddingId = queryParam(req.path, 'wedding')
    if (weddingId !== undefined) return this.#detail(req, slug, weddingId)
    return this.#home(req, slug)
  }

  /**
   * GET /t/:slug — the account HOME / overview (Phase 33), the default landing and the console's hub. A pure
   * web-layer COMPOSITION of the principal's already-authorized scoped reads:
   *   - GET /weddings, /escalations, /guests form the GATE — both roles read all three (couples scoped to their
   *     wedding since Phase 24/26). Any non-200 takes the SAME `#renderNonData` masking as every other page (the
   *     `#guestsPage` no-half-page pattern): unknown/suspended/unauthenticated all mask identically, and an
   *     unwired `escalations` subresource 404s → the whole home masks to GENERIC_404 (intentional fail-closed,
   *     disclosure-equivalent — NOT a partial render).
   *   - GET /billing is read LAST and its status is consulted ONLY as `=== 200 ? card : omit`. It NEVER flows
   *     into `#renderNonData` (the load-bearing P1): a couple's 403 (the planner-only billing capability denial)
   *     must leave the home a 200 with the billing card simply ABSENT — an affordance, never a Forbidden wall.
   * The overview carries only COUNTS (and the planner's owed balance + plan), so it discloses strictly less than
   * the views it links to — no figure the principal couldn't already obtain by visiting each view directly.
   * Issues the per-session CSRF token (the Sign-out form), like every other authenticated page.
   */
  #home(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const weddingsRes = this.#api.handle(bearerGet(`/t/${slug}/weddings`, token))
    if (weddingsRes.status !== 200) return this.#renderNonData(slug, weddingsRes.status)
    const escRes = this.#api.handle(bearerGet(`/t/${slug}/escalations`, token))
    if (escRes.status !== 200) return this.#renderNonData(slug, escRes.status)
    const guestsRes = this.#api.handle(bearerGet(`/t/${slug}/guests`, token))
    if (guestsRes.status !== 200) return this.#renderNonData(slug, guestsRes.status)
    // The ONE intentionally-conditional read — 200 → planner billing card; any other status → omit it. Billing's
    // status is NEVER passed to #renderNonData (P1: a couple's 403 keeps the home a 200, card absent).
    const billingRes = this.#api.handle(bearerGet(`/t/${slug}/billing`, token))
    const summary = billingRes.status === 200 ? readBilling(billingRes.body) : undefined
    const theme = this.#themes.resolveActiveTheme(slug)
    const csrf = this.#csrf.issueCsrf(token)
    // A 200 means the session resolved; theme + CSRF token must exist in the same stores (mirrors #guestsPage).
    if (theme === undefined || csrf === undefined) return theme === undefined ? GENERIC_404 : ERROR_500
    const overview: AccountOverview = {
      weddingsCount: readWeddings(weddingsRes.body).length,
      openQuestionsCount: countOpenEscalations(readEscalations(escRes.body), readResolutions(escRes.body)),
      guestsCount: readGuests(guestsRes.body).length,
      ...(summary === undefined ? {} : { billing: { balanceCents: summary.balance_cents, planTier: summary.plan_tier } }),
    }
    return htmlResult(200, renderHome(theme, slug, overview, csrf))
  }

  /**
   * The wedding LIST page (`?view=weddings` since Phase 33 — the home is now the default landing). Issues the
   * per-session CSRF token (the create form on the page carries it). `invalid` re-renders with the generic
   * create-failure notice (a 400 page) after a failed create — the re-render's own read masks unknown/suspended
   * to GENERIC_404, so create-vs-conflict-vs-missing never leaks (mirrors `#guestsPage`).
   */
  #weddingList(req: ApiRequest, slug: string, invalid = false): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const apiRes = this.#api.handle(bearerGet(`/t/${slug}/weddings`, token))
    if (apiRes.status === 200) {
      const theme = this.#themes.resolveActiveTheme(slug)
      const weddings = readWeddings(apiRes.body)
      const csrf = this.#csrf.issueCsrf(token)
      // A 200 means the session resolved; its CSRF token must exist (same store). Absent ⇒ invariant break.
      if (theme === undefined || csrf === undefined) return theme === undefined ? GENERIC_404 : ERROR_500
      return htmlResult(invalid ? 400 : 200, renderConsole(theme, slug, weddings, csrf, invalid))
    }
    return this.#renderNonData(slug, apiRes.status)
  }

  /**
   * GET /t/:slug?wedding=ID — the single-wedding DETAIL page (carries the Phase-23 edit form, so it issues
   * the per-session CSRF token like the list page). The id is routed ONLY into the pipeline, encoded so it
   * stays one segment, and never reflected. Themed strictly by status: a couple's non-owned id is masked to
   * 404 BEFORE any render (the CSRF token is issued only inside the 200 block, so it adds no oracle). `invalid`
   * re-renders the generic edit-failure notice (a 400 page) after a failed update on an OWNED wedding.
   */
  #detail(req: ApiRequest, slug: string, weddingId: string, invalid = false): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const apiRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${encodeURIComponent(weddingId)}`, token))
    if (apiRes.status === 200) {
      const theme = this.#themes.resolveActiveTheme(slug)
      const wedding = readWedding(apiRes.body)
      const csrf = this.#csrf.issueCsrf(token)
      if (theme === undefined || wedding === undefined) return GENERIC_404
      // A 200 means the session resolved; its CSRF token must exist (same store). Absent ⇒ invariant break.
      if (csrf === undefined) return ERROR_500
      return htmlResult(invalid ? 400 : 200, renderDetail(theme, slug, wedding, csrf, invalid))
    }
    return this.#renderNonData(slug, apiRes.status)
  }

  /**
   * GET /t/:slug?view=guests — the guest-management page. TWO `api.handle()` reads: GUESTS FIRST, then
   * weddings (for the picker). Since Phase 24 a COUPLE also gets 200 here (their wedding's guests, scoped by
   * the JSON layer); the add-guest form on the page is a capability affordance — a couple's submit forwards to
   * the planner-only `POST /guests` and takes the honest themed 403 re-render (no role signal exists to hide
   * it, same call Phase 23 made for wedding-create). Rendered only on 200/200; if EITHER read is non-200 it
   * takes the SAME `#renderNonData` masking as every other page (no half-page, no distinguishable split).
   * `invalid` re-renders with a generic notice after a failed create (the PRG re-render).
   */
  #guestsPage(req: ApiRequest, slug: string, invalid = false): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const guestsRes = this.#api.handle(bearerGet(`/t/${slug}/guests`, token))
    if (guestsRes.status !== 200) return this.#renderNonData(slug, guestsRes.status)
    const weddingsRes = this.#api.handle(bearerGet(`/t/${slug}/weddings`, token))
    if (weddingsRes.status !== 200) return this.#renderNonData(slug, weddingsRes.status)
    const theme = this.#themes.resolveActiveTheme(slug)
    const csrf = this.#csrf.issueCsrf(token)
    if (theme === undefined || csrf === undefined) return theme === undefined ? GENERIC_404 : ERROR_500
    return htmlResult(
      invalid ? 400 : 200,
      renderGuests(theme, slug, readGuests(guestsRes.body), readWeddings(weddingsRes.body), csrf, invalid),
    )
  }

  /**
   * GET /t/:slug?view=escalations — the escalation inbox (Phase 26 read + Phase 27 resolve). ONE `api.handle()`
   * read of the scoped JSON `GET /t/:slug/escalations` (planner: whole tenant; couple: their wedding), themed
   * strictly by status: any non-200 takes the SAME `#renderNonData` masking as every other page (unknown/
   * suspended/unauthenticated all mask identically). Since Phase 27 the page carries Resolve/Dismiss forms, so
   * it issues the per-session CSRF token (mirrors `#guestsPage` — a 200 means the session resolved, so its CSRF
   * token must exist in the same store; absent ⇒ invariant break ⇒ ERROR_500). The body carries BOTH the
   * escalations and the resolutions (scoped identically by the JSON layer); the page joins them.
   */
  #escalationsPage(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const apiRes = this.#api.handle(bearerGet(`/t/${slug}/escalations`, token))
    if (apiRes.status === 200) {
      const theme = this.#themes.resolveActiveTheme(slug)
      const csrf = this.#csrf.issueCsrf(token)
      if (theme === undefined || csrf === undefined) return theme === undefined ? GENERIC_404 : ERROR_500
      return htmlResult(200, renderEscalations(theme, slug, readEscalations(apiRes.body), readResolutions(apiRes.body), csrf))
    }
    return this.#renderNonData(slug, apiRes.status)
  }

  /**
   * POST /t/:slug/escalations/resolve — the browser Resolve/Dismiss form (Phase 27). Verify the CSRF token
   * (forged ⇒ masked 403, no mutation) BEFORE translating the cookie to a Bearer and forwarding to the JSON
   * `POST /t/:slug/escalations`. Always PRG-redirect back to the inbox (the follow-up GET masks unknown-tenant /
   * non-owner outcomes); a foreign/absent escalation is the JSON layer's idempotent `{resolved:false}` no-op.
   */
  #escalationResolve(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    const body = { escalation_id: form.get('escalation_id') ?? '', status: form.get('status') ?? '' }
    this.#api.handle(bearerJson('POST', `/t/${slug}/escalations`, token, body))
    return redirect(303, `/t/${slug}?view=escalations`)
  }

  /**
   * POST /t/:slug/escalations/reply — the browser Reply form (Phase 28): answer the guest directly (a metered
   * send that auto-resolves). Verify the CSRF token (forged ⇒ masked 403, NO send) BEFORE translating the
   * cookie to a Bearer and forwarding to the JSON `POST /t/:slug/escalations` (which discriminates the
   * `reply_text` body to the reply handler). Always PRG-redirect back to the inbox; a foreign/absent/handled
   * escalation is the JSON layer's idempotent `{replied:false}` no-op. Only escalation_id + reply_text are
   * forwarded; channel/recipient come from the live escalation server-side (a smuggled field is inert).
   */
  #escalationReply(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    const body = { escalation_id: form.get('escalation_id') ?? '', reply_text: form.get('reply_text') ?? '' }
    this.#api.handle(bearerJson('POST', `/t/${slug}/escalations`, token, body))
    return redirect(303, `/t/${slug}?view=escalations`)
  }

  /**
   * POST /t/:slug/guests/create — the browser add-guest form. Verify the CSRF token (forged ⇒ masked 403, no
   * mutation) BEFORE translating the cookie to a Bearer and forwarding to the JSON `POST /t/:slug/guests`.
   * 201 ⇒ PRG redirect to the guests page; any failure ⇒ re-render the guests page with a generic notice
   * (which itself masks to 404 if the tenant is unknown — so create-vs-conflict-vs-missing never leaks).
   */
  #guestCreate(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    const body = {
      recipient_ref: form.get('recipient_ref') ?? '',
      wedding_id: form.get('wedding_id') ?? '',
      guest_id: form.get('guest_id') ?? '',
    }
    const apiRes = this.#api.handle(bearerJson('POST', `/t/${slug}/guests`, token, body))
    if (apiRes.status === 201) return redirect(303, `/t/${slug}?view=guests`)
    return this.#guestsPage(req, slug, true)
  }

  /**
   * POST /t/:slug/guests/remove — the browser remove form. Verify CSRF (forged ⇒ masked 403, no mutation),
   * then forward to the JSON `DELETE /t/:slug/guests` (idempotent) and PRG-redirect to the guests page (which
   * masks unknown-tenant/non-owner outcomes on the follow-up GET).
   */
  #guestRemove(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    this.#api.handle(bearerJson('DELETE', `/t/${slug}/guests`, token, { recipient_ref: form.get('recipient_ref') ?? '' }))
    return redirect(303, `/t/${slug}?view=guests`)
  }

  /**
   * POST /t/:slug/weddings/create — the browser create-wedding form (Phase 23). Verify CSRF (forged ⇒ masked
   * 403, no mutation) BEFORE the cookie→Bearer translation, then forward to the JSON `POST /t/:slug/weddings`.
   * 201 ⇒ PRG redirect to the console; 403 ⇒ themed Forbidden (a couple lacks the create CAPABILITY); any
   * other failure ⇒ re-render the console with a generic notice (which itself masks unknown-tenant on the
   * follow-up read, so create-vs-conflict-vs-missing never leaks).
   */
  #weddingCreate(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    const apiRes = this.#api.handle(bearerJson('POST', `/t/${slug}/weddings`, token, weddingBodyFromForm(form)))
    // PRG back to the wedding LIST it was submitted from (Phase 33 relocated the list to ?view=weddings; the home
    // is now the default). The follow-up GET masks unknown-tenant on its own read.
    if (apiRes.status === 201) return redirect(303, `/t/${slug}?view=weddings`)
    if (apiRes.status === 403) return this.#renderNonData(slug, 403)
    return this.#weddingList(req, slug, true)
  }

  /**
   * POST /t/:slug/weddings/update — the browser edit-wedding form (Phase 23). Verify CSRF (forged ⇒ masked
   * 403, no mutation), then forward to the JSON `PUT /t/:slug/weddings/:id`. The id comes from the FORM body
   * and is `encodeURIComponent`-encoded into the URL so it provably stays ONE segment (no route breakout); the
   * JSON handler stamps wedding_id from the route + tenant_id from the context (LAST), so a body-smuggled id
   * is inert. 200 ⇒ PRG redirect back to the detail page; any failure (400 invalid / 404 masked not-owned-or-
   * missing / 405 empty-id collapse) ⇒ re-render the detail page, whose own read masks an empty/non-owned id
   * to GENERIC_404 — byte-identical to a missing id (no raw 4xx oracle reaches the user).
   */
  #weddingUpdate(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    const weddingId = form.get('wedding_id') ?? ''
    // clearable: an empty optional input is sent as '' (the PUT clear-to-absent sentinel), so a planner can
    // blank a logistics field from the browser (Phase 25). Create omits empties (the default).
    const apiRes = this.#api.handle(
      bearerJson('PUT', `/t/${slug}/weddings/${encodeURIComponent(weddingId)}`, token, weddingBodyFromForm(form, { clearable: true })),
    )
    if (apiRes.status === 200) return redirect(303, `/t/${slug}?wedding=${encodeURIComponent(weddingId)}`)
    return this.#detail(req, slug, weddingId, true)
  }

  /**
   * GET /t/:slug/strategy — the themed planning-strategy page (Phase 17). Mirrors `#console` exactly: ONE
   * `api.handle()` and themed strictly by the returned status, so the page makes no independent existence
   * decision (200 → page; 401 → themed login; else the constant masked 404).
   */
  #strategy(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const apiRes = this.#api.handle(bearerGet(`/t/${slug}/strategy`, token))
    if (apiRes.status === 200) {
      const theme = this.#themes.resolveActiveTheme(slug)
      const guidance = readStrategy(apiRes.body)
      if (theme === undefined || guidance === undefined) return GENERIC_404
      return htmlResult(200, renderStrategy(theme, slug, guidance))
    }
    return this.#renderNonData(slug, apiRes.status)
  }

  /**
   * GET /t/:slug?view=billing — the planner billing & usage summary (Phase 30). ONE `api.handle()` read of the
   * planner-only JSON `GET /t/:slug/billing`, themed strictly by status (mirrors `#strategy`): 200 → the summary
   * page; a couple's 403 → themed Forbidden; 401 → themed login; everything else → the masked 404. The page makes
   * NO independent existence/authz decision — it renders exactly what the JSON layer returned (read-only, no CSRF
   * token needed, no body). `theme===undefined` on a 200 is an invariant break (a 200 means an active tenant
   * resolved) → GENERIC_404 (fail closed, consistent with `#strategy`).
   */
  #billingPage(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const apiRes = this.#api.handle(bearerGet(`/t/${slug}/billing`, token))
    if (apiRes.status === 200) {
      const theme = this.#themes.resolveActiveTheme(slug)
      const summary = readBilling(apiRes.body)
      // Phase 32: the same 200 read carries the itemized activity line items (tolerant — `[]` if absent/malformed).
      const activity = readBillingActivity(apiRes.body)
      // Phase 31: the page now carries a CSRF-gated Pay form, so it issues the per-session token (like
      // #guestsPage/#escalationsPage). A 200 means the session resolved, so its CSRF token must exist in the same
      // store; absent ⇒ invariant break ⇒ ERROR_500. theme absent on a 200 ⇒ GENERIC_404 (fail closed, like #strategy).
      const csrf = this.#csrf.issueCsrf(token)
      if (theme === undefined || summary === undefined) return GENERIC_404
      if (csrf === undefined) return ERROR_500
      return htmlResult(200, renderBilling(theme, slug, summary, activity, csrf))
    }
    return this.#renderNonData(slug, apiRes.status)
  }

  /**
   * POST /t/:slug/billing/pay — the browser Pay form (Phase 31): settle the owed balance. Verify the CSRF token
   * (forged ⇒ masked 403, NO mutation) BEFORE translating the cookie to a Bearer and forwarding to the JSON
   * `POST /t/:slug/billing`. The forwarded body is empty — the JSON handler settles the trusted owed balance and
   * reads nothing from the body, so the browser cannot influence the amount. Always PRG-redirect back to the
   * billing page; a couple-403 / unknown-tenant outcome is masked on the follow-up GET, and a zero-balance POST is
   * the JSON layer's idempotent `{paid:false}` no-op. Mirrors #escalationResolve.
   */
  #billingPay(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    this.#api.handle(bearerJson('POST', `/t/${slug}/billing`, token, {}))
    return redirect(303, `/t/${slug}?view=billing`)
  }

  /** Map a non-200 API status to a page. 401 -> themed login (active); 403 -> forbidden; else masked 404. */
  #renderNonData(slug: string, status: number): HttpResult {
    if (status === 401) {
      const theme = this.#themes.resolveActiveTheme(slug)
      return theme === undefined ? GENERIC_404 : htmlResult(200, renderLogin(theme, slug))
    }
    if (status === 403) {
      const theme = this.#themes.resolveActiveTheme(slug)
      return theme === undefined ? GENERIC_404 : htmlResult(403, renderForbidden(theme, slug))
    }
    return GENERIC_404
  }

  /** GET shows the themed login form; POST runs the simulated login and sets the session cookie. */
  #login(req: ApiRequest, slug: string): HttpResult {
    if (req.method === 'GET') {
      const theme = this.#themes.resolveActiveTheme(slug)
      return theme === undefined ? GENERIC_404 : htmlResult(200, renderLogin(theme, slug))
    }
    if (req.method !== 'POST') return this.#delegate(req)

    const form = parseForm(req.rawBody)
    const role = form.get('role') ?? ''
    const weddingId = form.get('wedding_id') ?? ''
    const loginBody: Record<string, string> = { role }
    if (weddingId.length > 0) loginBody.wedding_id = weddingId

    const apiRes = this.#api.handle({
      method: 'POST',
      path: `/t/${slug}/sessions`,
      headers: { 'content-type': 'application/json' },
      rawBody: JSON.stringify(loginBody),
    })

    if (apiRes.status === 201) {
      const token = readToken(apiRes.body)
      if (token === undefined || !SAFE_TOKEN.test(token)) return ERROR_500
      // Location + Set-Cookie are built ONLY from the validated slug + the server-minted token.
      return redirect(303, `/t/${slug}`, {
        'set-cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/t/${slug}`,
      })
    }
    if (apiRes.status === 404) return GENERIC_404 // unknown / suspended / onboarding tenant — masked
    // 400 (bad role / missing couple wedding_id): re-render the themed login with a generic notice.
    const theme = this.#themes.resolveActiveTheme(slug)
    return theme === undefined ? GENERIC_404 : htmlResult(400, renderLogin(theme, slug, true))
  }

  /**
   * POST /t/:slug/logout — clear the session cookie and return to the tenant root. CSRF-protected (Phase 21):
   * a forged-token logout returns the masked 403 and does NOT clear the cookie (closing a forced-logout CSRF).
   */
  #logout(req: ApiRequest, slug: string): HttpResult {
    if (req.method !== 'POST') return this.#delegate(req)
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    return redirect(303, `/t/${slug}`, {
      'set-cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/t/${slug}; Max-Age=0`,
    })
  }

  /** Delegate to the JSON pipeline and wrap its response — the keystone-protected handler, unchanged. */
  #delegate(req: ApiRequest): HttpResult {
    return jsonResultFrom(this.#api.handle(req))
  }
}

// ---------------------------------- request helpers (pure) ----------------------------------

/** Build a `GET` ApiRequest carrying the session token as a Bearer header (omitted when absent). */
function bearerGet(path: string, token: string | undefined): ApiRequest {
  return {
    method: 'GET',
    path,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  }
}

/**
 * Build a mutating ApiRequest (POST/DELETE) translating the cookie session token into a Bearer + a JSON body
 * (Phase 21). This is the SOLE cookie→Bearer translation for a mutation — it runs only AFTER the CSRF token
 * verified, so a forged cross-site form never reaches it.
 */
function bearerJson(method: string, path: string, token: string | undefined, body: unknown): ApiRequest {
  const headers: Record<string, string | undefined> = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  return { method, path, headers, rawBody: JSON.stringify(body) }
}

/** Read the `wp_session` token from a Cookie header, or undefined. */
function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = pair.slice(eq + 1).trim()
      return value.length === 0 ? undefined : value
    }
  }
  return undefined
}

/** Extract a single query parameter value from a path, or undefined. */
function queryParam(path: string, name: string): string | undefined {
  const q = path.indexOf('?')
  if (q === -1) return undefined
  const value = new URLSearchParams(path.slice(q + 1)).get(name)
  return value === null ? undefined : value
}

/** Parse a urlencoded form body into a params map (empty when absent). */
function parseForm(rawBody: string | undefined): URLSearchParams {
  return new URLSearchParams(rawBody ?? '')
}

/**
 * Build the JSON body for a wedding create/update from a form. The required name/date/status are always sent
 * (the form prefills them). The OPTIONAL logistics fields (the shared {@link WEDDING_LOGISTICS_FIELDS}) diverge
 * on exactly ONE axis — whether an empty input is sent — captured by `clearable` (Phase 25):
 *   - CREATE (`clearable:false`, the default): an empty optional is OMITTED, so create leaves it unset. A POST
 *     has nothing to clear, and the JSON API rejects a literal optional `''` (so omitting is the only sane shape).
 *   - UPDATE (`clearable:true`): every optional is ALWAYS sent — empty `''` reaches the PUT clear-to-absent
 *     sentinel (removes the field), a prefilled value PRESERVES, a new value SETS. This is what lets a planner
 *     blank a wrong dress code from the browser.
 * Only the FOUR optional fields are gated by `clearable`; the required fields stay always-sent (an empty
 * required input still 400s downstream — it can never silently no-op). Identity (tenant_id/wedding_id) is NEVER
 * carried in the body — the JSON pipeline stamps it from the route + context, so a smuggled key here is inert.
 */
function weddingBodyFromForm(form: URLSearchParams, { clearable }: { clearable: boolean } = { clearable: false }): Record<string, string> {
  const body: Record<string, string> = {
    couple_display_name: form.get('couple_display_name') ?? '',
    event_date: form.get('event_date') ?? '',
    status: form.get('status') ?? '',
  }
  for (const key of WEDDING_LOGISTICS_FIELDS) {
    const value = form.get(key) ?? ''
    // update sends '' (the PUT clear sentinel); create omits empty (an optional '' is malformed on POST).
    if (clearable || value.length > 0) body[key] = value
  }
  return body
}

/** Read the opaque token from a login (201) JSON body. */
function readToken(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const token = (body as { token?: unknown }).token
  return typeof token === 'string' ? token : undefined
}

/** Read the weddings array from a list (200) JSON body (tolerant — never throws on an odd shape). */
function readWeddings(body: unknown): readonly Wedding[] {
  if (typeof body !== 'object' || body === null) return []
  const weddings = (body as { weddings?: unknown }).weddings
  return Array.isArray(weddings) ? (weddings as Wedding[]) : []
}

/** Read the guests array from a list (200) JSON body (tolerant — never throws on an odd shape). */
function readGuests(body: unknown): readonly Guest[] {
  if (typeof body !== 'object' || body === null) return []
  const guests = (body as { guests?: unknown }).guests
  return Array.isArray(guests) ? (guests as Guest[]) : []
}

/** Read the escalations array from a list (200) JSON body (tolerant — never throws on an odd shape). */
function readEscalations(body: unknown): readonly GuestEscalation[] {
  if (typeof body !== 'object' || body === null) return []
  const escalations = (body as { escalations?: unknown }).escalations
  return Array.isArray(escalations) ? (escalations as GuestEscalation[]) : []
}

/** Read the resolutions array from a list (200) JSON body (tolerant — never throws on an odd shape). */
function readResolutions(body: unknown): readonly EscalationResolution[] {
  if (typeof body !== 'object' || body === null) return []
  const resolutions = (body as { resolutions?: unknown }).resolutions
  return Array.isArray(resolutions) ? (resolutions as EscalationResolution[]) : []
}

/** Read the single wedding from a detail (200) JSON body, or undefined. */
function readWedding(body: unknown): Wedding | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const wedding = (body as { wedding?: unknown }).wedding
  return typeof wedding === 'object' && wedding !== null ? (wedding as Wedding) : undefined
}

/** Read the strategy guidance from a strategy (200) JSON body, or undefined (tolerant — never throws). */
function readStrategy(body: unknown): StrategyGuidance | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const strategy = (body as { strategy?: unknown }).strategy
  return typeof strategy === 'object' && strategy !== null ? (strategy as StrategyGuidance) : undefined
}

/** Read the billing summary from a billing (200) JSON body, or undefined (tolerant — never throws). */
function readBilling(body: unknown): BillingSummary | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const billing = (body as { billing?: unknown }).billing
  return typeof billing === 'object' && billing !== null ? (billing as BillingSummary) : undefined
}

/**
 * Read the activity line items from a billing (200) JSON body, or `[]` (tolerant — never throws). An absent or
 * malformed `activity` yields the empty list (the page renders "No activity yet."), never a 500 on the 200 path.
 */
function readBillingActivity(body: unknown): readonly BillingActivityEntry[] {
  if (typeof body !== 'object' || body === null) return []
  const activity = (body as { activity?: unknown }).activity
  return Array.isArray(activity) ? (activity as BillingActivityEntry[]) : []
}
