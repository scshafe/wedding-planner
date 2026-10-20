import type { EscalationReply, EscalationResolution, Guest, GuestEscalation, Wedding } from '@wedding-planner/shared'

import type { TeamView } from '../accounts/membership_service'
import type { GuestEventRsvp, HouseholdAnswer, HouseholdRsvpView, WeddingEventsView } from '../wedding_events/wedding_event_service'
import type { ChecklistView, DueAcrossWeddings } from '../checklist/checklist_service'
import { centsFromText, VENDOR_LIMITS, type VendorsView } from '../vendors/vendor_service'
import type { BudgetView } from '../budget/budget_service'
import { toGuestCsv } from '../guests/guest_csv'
import type { GuestImportResult, GuestListView } from '../guests/guest_list_service'
import type { BillingActivityEntry } from '../billing/billing_activity'
import type { BillingSummary } from '../billing/billing_summary'
import { constantTimeEqual, type CsrfGuard } from '../auth/csrf_guard'
import type { ApiRequest } from '../http/api_message'
import { splitPath } from '../http/path'
import type { ProductApi } from '../http/product_api'
import type { StrategyGuidance } from '../strategy/strategy_guidance'
import { WEDDING_LOGISTICS_FIELDS } from '../wedding/wedding_repository'
import { isFeedbackPage } from '../feedback/feedback_service'
import type { ErrorLog } from '../operability/error_log'
import { ProductError } from '../product_error'
import { readCookie } from './cookies'
import { normalizeSlugForRoute } from './html'
import { OperatorConsole } from './operator_console'
import {
  type AccountOverview,
  countOpenEscalations,
  ERROR_500,
  GENERIC_404,
  renderBilling,
  renderConsole,
  renderConversation,
  renderConversationNotFound,
  renderDetail,
  renderEscalations,
  renderEvents,
  renderForbidden,
  renderFeedback,
  renderFeedbackThanks,
  renderForgot,
  renderGuestEdit,
  renderGuestImport,
  renderGuestList,
  renderHouseholdRsvp,
  renderChecklist,
  renderVendors,
  renderBudget,
  type BudgetNotice,
  type VendorsNotice,
  BLANK_INSTALLMENT_ROWS,
  renderDueTasks,
  type ChecklistNotice,
  type HouseholdRsvpNotice,
  renderRsvpLinkMade,
  type GuestListNotice,
  renderGuests,
  renderInviteAccept,
  renderHome,
  renderLanding,
  renderLogin,
  renderReset,
  renderStrategy,
  renderTeam,
  type TeamNotice,
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

/**
 * Issue #10: the PRE-SESSION anti-forgery cookie (double-submit). The sign-in, forgot and reset forms run before
 * any session exists, so they cannot use the per-session CSRF token. Each render of those pages sets this cookie
 * (HttpOnly, SameSite=Strict, scoped to the tenant) and embeds the same value in the form; a POST must present
 * both, equal. A cross-site page can neither read the value nor make the browser send the cookie.
 */
const PRE_SESSION_COOKIE = 'wp_pre'
/** The most answer rows a household RSVP form is read for (the JSON layer bounds the list again). */
const HOUSEHOLD_FORM_ROWS = 240
/** The most fields a household RSVP form may carry: 6 per answer row, 3 per dietary row, and a few more. */
const HOUSEHOLD_FORM_MAX_FIELDS = 6 * HOUSEHOLD_FORM_ROWS + 3 * HOUSEHOLD_FORM_ROWS + 10

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
  /**
   * Issue #9: the operator store narrowed to {@link CsrfGuard} over operator CONSOLE sessions. Present ⇒ the
   * operator console (operator_console.ts) is mounted under /admin; absent ⇒ /admin is the JSON API only.
   */
  readonly operatorCsrf?: CsrfGuard
  /**
   * Issue #10: real sign-in. Present ⇒ the login page offers email + password (and forgot / reset pages exist),
   * with the simulated role picker only where `isSimulatedSlug` says (the demo tenant in demo mode); `newToken` mints the
   * pre-session anti-forgery values. Absent ⇒ the legacy picker-only page (hand-built fixtures).
   */
  readonly accounts?: { readonly isSimulatedSlug: (slug: string) => boolean; readonly newToken: () => string }
  /** Issue #13: where a web-layer fault (a constant 500 page) is recorded for the operator. */
  readonly errors?: Pick<ErrorLog, 'record'>
}

export class ProductWebUi {
  readonly #api: ProductApi
  readonly #themes: ThemeResolver
  readonly #csrf: CsrfGuard
  readonly #operatorConsole: OperatorConsole | undefined
  readonly #accounts: ProductWebUiDeps['accounts']
  readonly #errors: ProductWebUiDeps['errors']

  constructor(deps: ProductWebUiDeps) {
    this.#api = deps.api
    this.#themes = deps.themes
    this.#csrf = deps.csrf
    this.#operatorConsole =
      deps.operatorCsrf === undefined ? undefined : new OperatorConsole({ api: deps.api, csrf: deps.operatorCsrf })
    this.#accounts = deps.accounts
    this.#errors = deps.errors
  }

  /** Work to run after a response has been sent (issue #10) — forwarded to the pipeline. Never throws. */
  runDeferredWork(): void {
    this.#api.runDeferredWork()
  }

  /** Run a request through the HTML front door. Never throws — any slip becomes the constant 500. */
  handle(req: ApiRequest): HttpResult {
    try {
      return this.#route(req)
    } catch (error) {
      this.#errors?.record(error, req)
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

    // /admin pages (issue #9) — the operator console's browser routes; anything it does not own is the JSON API.
    if (segments[0] === 'admin' && this.#operatorConsole !== undefined) {
      const page = this.#operatorConsole.handle(req, segments)
      if (page !== undefined) return page
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
        // Issue #10: password recovery pages (only with real accounts wired).
        if (this.#accounts !== undefined && segments[2] === 'forgot') return slug === undefined ? GENERIC_404 : this.#forgot(req, slug)
        if (this.#accounts !== undefined && segments[2] === 'reset') return slug === undefined ? GENERIC_404 : this.#reset(req, slug)
        // Issue #12: the "Send feedback" form (GET only; its POST is the 4-seg /feedback/send below).
        if (segments[2] === 'feedback' && req.method === 'GET') return slug === undefined ? GENERIC_404 : this.#feedback(req, slug)
        // Issue #11: accept an invitation through its link.
        if (this.#accounts !== undefined && segments[2] === 'invite') return slug === undefined ? GENERIC_404 : this.#invite(req, slug)
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

      // /t/:slug/team/{invite,resend,revoke,remove} (issue #11) — the team FORM posts (CSRF-protected). Slug masked
      // to 404 BEFORE any cookie read / CSRF verdict, like every other form post.
      if (segments.length === 4 && segments[2] === 'team' && req.method === 'POST') {
        if (slug === undefined) return GENERIC_404
        const action = segments[3]
        if (action === 'invite' || action === 'resend' || action === 'revoke' || action === 'remove') {
          return this.#teamAction(req, slug, action)
        }
      }

      // /t/:slug/guest-list/<action> (issue #27) — the guest-list FORM posts (CSRF-protected), distinct from the
      // JSON routes under /t/:slug/weddings/:id/. Slug masked to 404 before any cookie read / CSRF verdict.
      if (segments.length === 4 && segments[2] === 'guest-list' && segments[3] === 'export' && req.method === 'GET') {
        return slug === undefined ? GENERIC_404 : this.#guestListExport(req, slug)
      }
      if (segments.length === 4 && segments[2] === 'guest-list' && segments[3] === 'import' && req.method === 'POST') {
        return slug === undefined ? GENERIC_404 : this.#guestListImport(req, slug)
      }
      if (segments.length === 4 && segments[2] === 'guest-list' && req.method === 'POST') {
        if (slug === undefined) return GENERIC_404
        return this.#guestListAction(req, slug, segments[3] ?? '')
      }
      // /t/:slug/rsvp/<token> (issue #30) — a household's PUBLIC RSVP page: the link's token is the credential (no
      // session); pre-session anti-forgery on the POST. A token that does not resolve is the generic not-found.
      if (segments.length === 4 && segments[2] === 'rsvp' && this.#accounts !== undefined) {
        return slug === undefined ? GENERIC_404 : this.#householdRsvp(req, slug, segments[3] ?? '')
      }
      // /t/:slug/budget/<action> (issue #34) — the budget FORM posts (CSRF-protected).
      if (segments.length === 4 && segments[2] === 'budget' && req.method === 'POST') {
        if (slug === undefined) return GENERIC_404
        return this.#budgetAction(req, slug, segments[3] ?? '')
      }
      // /t/:slug/vendors/<action> (issue #33) — the vendor FORM posts (CSRF-protected).
      if (segments.length === 4 && segments[2] === 'vendors' && req.method === 'POST') {
        if (slug === undefined) return GENERIC_404
        return this.#vendorsAction(req, slug, segments[3] ?? '')
      }
      // /t/:slug/checklist/<action> (issue #31) — the checklist FORM posts (CSRF-protected).
      if (segments.length === 4 && segments[2] === 'checklist' && req.method === 'POST') {
        if (slug === undefined) return GENERIC_404
        return this.#checklistAction(req, slug, segments[3] ?? '')
      }
      // /t/:slug/events/<action> (issue #29) — the events and RSVP FORM posts (CSRF-protected).
      if (segments.length === 4 && segments[2] === 'events' && req.method === 'POST') {
        if (slug === undefined) return GENERIC_404
        return this.#eventsAction(req, slug, segments[3] ?? '')
      }

      // /t/:slug/feedback/send (issue #12) — the feedback FORM post (CSRF-protected), distinct from the JSON
      // POST /t/:slug/feedback. Slug masked to 404 before any cookie read / CSRF verdict.
      if (segments.length === 4 && segments[2] === 'feedback' && segments[3] === 'send' && req.method === 'POST') {
        if (slug === undefined) return GENERIC_404
        return this.#feedbackSend(req, slug)
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
    // ?view=escalations&conversation=ID (Phase 38) — the per-conversation chronological transcript. The presence
    // of a `conversation` param (even empty) routes to the transcript page; absent → the inbox.
    if (queryParam(req.path, 'view') === 'escalations') {
      const conversation = queryParam(req.path, 'conversation')
      return conversation === undefined ? this.#escalationsPage(req, slug) : this.#conversationPage(req, slug, conversation)
    }
    // ?view=billing — the planner billing & usage summary (Phase 30; planner-only, a couple is themed Forbidden).
    if (queryParam(req.path, 'view') === 'billing') return this.#billingPage(req, slug)
    // ?view=due — the planner's overdue / due-this-week tasks across weddings (issue #32; a couple is themed Forbidden).
    if (queryParam(req.path, 'view') === 'due') return this.#duePage(req, slug)
    // ?view=team — members and invitations (issue #11; planners; a couple is themed Forbidden).
    if (queryParam(req.path, 'view') === 'team') return this.#teamPage(req, slug)

    const weddingId = queryParam(req.path, 'wedding')
    // ?wedding=ID&tab=guests (issue #27): the wedding's guest list (or one guest's edit page with &guest=ID).
    if (weddingId !== undefined && queryParam(req.path, 'tab') === 'guests') return this.#guestListPage(req, slug, weddingId)
    // ?wedding=ID&tab=budget (issue #34): the wedding's budget.
    if (weddingId !== undefined && queryParam(req.path, 'tab') === 'budget') return this.#budgetPage(req, slug, weddingId)
    // ?wedding=ID&tab=vendors (issue #33): the wedding's vendors and what is due next.
    if (weddingId !== undefined && queryParam(req.path, 'tab') === 'vendors') return this.#vendorsPage(req, slug, weddingId)
    // ?wedding=ID&tab=checklist (issue #31): the wedding's checklist.
    if (weddingId !== undefined && queryParam(req.path, 'tab') === 'checklist') return this.#checklistPage(req, slug, weddingId)
    // ?wedding=ID&tab=events (issue #29): the wedding's events and their RSVP counts.
    if (weddingId !== undefined && queryParam(req.path, 'tab') === 'events') return this.#eventsPage(req, slug, weddingId)
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
    // Issue #11: like billing, an affordance only — 200 (a planner) shows the Team card; anything else omits it.
    const team = readTeam(this.#api.handle(bearerGet(`/t/${slug}/team`, token)))
    const theme = this.#themes.resolveActiveTheme(slug)
    const csrf = this.#csrf.issueCsrf(token)
    // A 200 means the session resolved; theme + CSRF token must exist in the same stores (mirrors #guestsPage).
    if (theme === undefined || csrf === undefined) return theme === undefined ? GENERIC_404 : ERROR_500
    // Issue #32: like billing, an affordance only — 200 (a planner) shows the tasks-due card; anything else omits it.
    const dueRes = this.#api.handle(bearerGet(`/t/${slug}/due-tasks`, token))
    const due = dueRes.status === 200 ? (dueRes.body as DueAcrossWeddings) : undefined
    const overview: AccountOverview = {
      weddingsCount: readWeddings(weddingsRes.body).length,
      openQuestionsCount: countOpenEscalations(readEscalations(escRes.body), readResolutions(escRes.body)),
      guestsCount: readGuests(guestsRes.body).length,
      ...(summary === undefined ? {} : { billing: { balanceCents: summary.balance_cents, planTier: summary.plan_tier } }),
      ...(team === undefined ? {} : { team: { members: team.members.length, pending: team.invitations.length } }),
      ...(due === undefined ? {} : { due: { overdue: due.overdue, dueSoon: due.due_soon } }),
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
      // Issue #11: a planner (the team read answers 200) gets the "Invite the couple" form on the wedding.
      const canInvite = readTeam(this.#api.handle(bearerGet(`/t/${slug}/team`, token))) !== undefined
      const invite = queryParam(req.path, 'invite')
      const notice = invite === 'sent' || invite === 'exists' || invite === 'invalid' ? invite : undefined
      // Issue #29: the events card with live counts (same boundary as the wedding read; absent if not wired).
      const eventsRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${encodeURIComponent(weddingId)}/events`, token))
      const events = eventsRes.status === 200 ? (eventsRes.body as WeddingEventsView) : undefined
      // Issue #31: the checklist summary, and — when the server recorded that the date moved — the offer to move
      // the open tasks too (built from server data only, never from the URL).
      const checklistRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${encodeURIComponent(weddingId)}/tasks`, token))
      const tasks = checklistRes.status === 200 ? (checklistRes.body as ChecklistView) : undefined
      const checklist =
        tasks === undefined
          ? undefined
          : { overdue: tasks.overdue.length, open: tasks.overdue.length + tasks.upcoming.length, ...(tasks.date_move === undefined ? {} : { dateMove: tasks.date_move }) }
      return htmlResult(
        invalid ? 400 : 200,
        renderDetail(theme, slug, wedding, csrf, invalid, canInvite ? (notice === undefined ? {} : { notice }) : undefined, events, checklist),
      )
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
   * token must exist in the same store; absent ⇒ invariant break ⇒ ERROR_500). The body carries the
   * escalations, the resolutions AND the reply threads (scoped identically by the JSON layer); the page joins
   * them by escalation_id.
   */
  #escalationsPage(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const apiRes = this.#api.handle(bearerGet(`/t/${slug}/escalations`, token))
    if (apiRes.status === 200) {
      const theme = this.#themes.resolveActiveTheme(slug)
      const csrf = this.#csrf.issueCsrf(token)
      if (theme === undefined || csrf === undefined) return theme === undefined ? GENERIC_404 : ERROR_500
      return htmlResult(
        200,
        renderEscalations(theme, slug, readEscalations(apiRes.body), readResolutions(apiRes.body), readReplies(apiRes.body), csrf),
      )
    }
    return this.#renderNonData(slug, apiRes.status)
  }

  /**
   * GET /t/:slug?view=escalations&conversation=ID — the per-conversation TRANSCRIPT (Phase 38). A READ-ONLY
   * legibility page: the full chronological story of ONE escalation (question + reply turns + status
   * transitions, interleaved by time). Pure composition over the SAME scoped JSON read the inbox uses — ONE
   * `api.handle(GET /escalations)`, no new data path. NO oracle:
   *   - non-200 → `#renderNonData` (byte-identical masking as the inbox: unknown/suspended/unauthenticated).
   *   - 200 → SELECT the escalation by id FROM the principal's already-scoped `escalations` array (never an
   *     independent lookup; the `conversation` value is a pure filter key). An id NOT in the scoped array covers
   *     BOTH "absent" AND "a couple probing a sibling-wedding's escalation" IDENTICALLY (the scoped read already
   *     excluded the foreign row) → the frozen themed-200 `renderConversationNotFound` notice (NOT a `GENERIC_404`,
   *     which is the unknown-tenant mask — the read already proved this tenant active). Read-only ⇒ no CSRF token.
   */
  #conversationPage(req: ApiRequest, slug: string, conversationId: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const apiRes = this.#api.handle(bearerGet(`/t/${slug}/escalations`, token))
    if (apiRes.status !== 200) return this.#renderNonData(slug, apiRes.status)
    const theme = this.#themes.resolveActiveTheme(slug)
    // A 200 means the session resolved, so the active theme must exist in the same store (mirrors #escalationsPage).
    if (theme === undefined) return GENERIC_404
    const escalations = readEscalations(apiRes.body)
    const escalation = escalations.find((e) => e.escalation_id === conversationId)
    // Found → the transcript joins resolutions/replies on `escalation.escalation_id` (server data, never the
    // client `conversation` string). Not found → the frozen no-such-conversation notice (absent ≡ foreign).
    if (escalation === undefined) return htmlResult(200, renderConversationNotFound(theme, slug))
    return htmlResult(200, renderConversation(theme, slug, escalation, readResolutions(apiRes.body), readReplies(apiRes.body)))
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
   * POST /t/:slug/escalations/reply — the browser Reply form (Phase 28/34): answer the guest directly (a metered
   * send that APPENDS to the thread, multi-turn; it no longer auto-resolves). Verify the CSRF token (forged ⇒
   * masked 403, NO send) BEFORE translating the cookie to a Bearer and forwarding to the JSON `POST
   * /t/:slug/escalations` (which discriminates the `reply_text` body to the reply handler). Always PRG-redirect
   * back to the inbox; a foreign/absent/handled escalation is the JSON layer's idempotent `{replied:false}`
   * no-op. Forwards escalation_id + reply_text + `seq` (the render-time thread-position double-submit key the
   * form carries); channel/recipient come from the live escalation server-side (a smuggled field is inert). A
   * same-seq/different-body conflict (409) is swallowed by the redirect — the operator lands back on the inbox,
   * sees their message absent, and the now-`seq+1` form lets them resend.
   */
  #escalationReply(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    const body = {
      escalation_id: form.get('escalation_id') ?? '',
      reply_text: form.get('reply_text') ?? '',
      seq: form.get('seq') ?? '',
    }
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
  /**
   * GET /t/:slug/feedback (issue #12) — the feedback form, for any signed-in planner or couple. The weddings read is
   * the authentication gate (both roles may read it); anything but 200 takes the usual masking.
   */
  #feedback(req: ApiRequest, slug: string, status = 200, notice?: 'invalid' | 'rate_limited'): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const gate = this.#api.handle(bearerGet(`/t/${slug}/weddings`, token))
    if (gate.status !== 200) return this.#renderNonData(slug, gate.status)
    const theme = this.#themes.resolveActiveTheme(slug)
    const csrf = this.#csrf.issueCsrf(token)
    if (theme === undefined || csrf === undefined) return theme === undefined ? GENERIC_404 : ERROR_500
    const raw = queryParam(req.path, 'page') ?? ''
    return htmlResult(status, renderFeedback(theme, slug, csrf, isFeedbackPage(raw) ? raw : undefined, notice))
  }

  /** POST /t/:slug/feedback/send (issue #12) — CSRF first, then the JSON submit; a thank-you page or the form again. */
  #feedbackSend(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    const page = form.get('page') ?? ''
    const res = this.#api.handle(
      bearerJson('POST', `/t/${slug}/feedback`, token, {
        trying: form.get('trying') ?? '',
        happened: form.get('happened') ?? '',
        ...(page.length === 0 ? {} : { page }),
      }),
    )
    if (res.status === 201) {
      const theme = this.#themes.resolveActiveTheme(slug)
      return theme === undefined ? GENERIC_404 : htmlResult(200, renderFeedbackThanks(theme, slug))
    }
    if (res.status === 400 || res.status === 429) {
      const retry = { ...req, method: 'GET', path: `/t/${slug}/feedback?page=${encodeURIComponent(page)}` }
      return this.#feedback(retry, slug, res.status, res.status === 429 ? 'rate_limited' : 'invalid')
    }
    return this.#renderNonData(slug, res.status)
  }

  /**
   * GET /t/:slug?wedding=ID&tab=guests[&guest=GID] (issue #27) — the wedding's guest list, or one guest's edit page.
   * Two reads through the pipeline (the wedding, then its list): any non-200 takes the usual masking, so a couple
   * probing another wedding sees the same not-found as for a wedding that does not exist.
   */
  #guestListPage(req: ApiRequest, slug: string, weddingId: string, status = 200, editNotice?: 'saved' | 'invalid' | 'conflict'): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const id = encodeURIComponent(weddingId)
    const weddingRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${id}`, token))
    if (weddingRes.status !== 200) return this.#renderNonData(slug, weddingRes.status)
    const listRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${id}/guest-list`, token))
    if (listRes.status !== 200) return this.#renderNonData(slug, listRes.status)
    const theme = this.#themes.resolveActiveTheme(slug)
    const csrf = this.#csrf.issueCsrf(token)
    const wedding = readWedding(weddingRes.body)
    if (theme === undefined || wedding === undefined) return GENERIC_404
    if (csrf === undefined) return ERROR_500
    const list = listRes.body as GuestListView
    if (queryParam(req.path, 'import') === '1') return htmlResult(status, renderGuestImport(theme, slug, wedding, csrf, ''))
    const guestId = queryParam(req.path, 'guest')
    if (guestId !== undefined) {
      const guest = list.guests.find((g) => g.guest_id === guestId)
      if (guest === undefined) return this.#renderNonData(slug, 404)
      // Issue #29: the guest's answer per event (absent when events are not wired).
      const rsvpRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${id}/guests/${encodeURIComponent(guestId)}/rsvps`, token))
      const rsvps = rsvpRes.status === 200 ? (rsvpRes.body as { rsvps: GuestEventRsvp[] }).rsvps : undefined
      const rawNotice = queryParam(req.path, 'notice')
      const notice = editNotice ?? (['saved', 'invalid', 'conflict'] as const).find((n) => n === rawNotice)
      return htmlResult(status, renderGuestEdit(theme, slug, wedding, guest, list.households, csrf, notice, rsvps))
    }
    const raw = queryParam(req.path, 'notice')
    const notice = (['saved', 'removed', 'invalid', 'conflict', 'imported'] as const).find((n) => n === raw)
    // Issue #30: which households have an RSVP link (an affordance: absent when not wired).
    const linksRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${id}/rsvp-links`, token))
    const links =
      linksRes.status === 200
        ? new Map((linksRes.body as { links: { household_id: string; created_at: string }[] }).links.map((l) => [l.household_id, l.created_at]))
        : undefined
    return htmlResult(status, renderGuestList(theme, slug, wedding, list, csrf, notice, links))
  }

  /**
   * GET /t/:slug?wedding=ID&tab=events (issue #29) — the wedding's events and live counts. Two reads through the
   * pipeline (the wedding, then its events); any non-200 takes the usual masking.
   */
  #eventsPage(req: ApiRequest, slug: string, weddingId: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const id = encodeURIComponent(weddingId)
    const weddingRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${id}`, token))
    if (weddingRes.status !== 200) return this.#renderNonData(slug, weddingRes.status)
    const eventsRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${id}/events`, token))
    if (eventsRes.status !== 200) return this.#renderNonData(slug, eventsRes.status)
    const theme = this.#themes.resolveActiveTheme(slug)
    const csrf = this.#csrf.issueCsrf(token)
    const wedding = readWedding(weddingRes.body)
    if (theme === undefined || wedding === undefined) return GENERIC_404
    if (csrf === undefined) return ERROR_500
    const raw = queryParam(req.path, 'notice')
    const notice = (['saved', 'removed', 'invalid', 'conflict'] as const).find((n) => n === raw)
    return htmlResult(200, renderEvents(theme, slug, wedding, eventsRes.body as WeddingEventsView, csrf, notice))
  }

  /**
   * POST /t/:slug/events/<action> (issue #29) — CSRF first, then the matching JSON route of the form's wedding.
   * Event actions go back to the events page with a notice; an RSVP goes back to the guest's edit page.
   */
  #eventsAction(req: ApiRequest, slug: string, action: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    const weddingId = form.get('wedding_id') ?? ''
    const base = `/t/${slug}/weddings/${encodeURIComponent(weddingId)}`
    const value = (name: string): string => (form.get(name) ?? '').trim()
    const event = encodeURIComponent(value('event_id'))
    const call = (method: string, path: string, body?: unknown) => this.#api.handle(bearerJson(method, path, token, body ?? {}))
    // Meal rows pair a hidden id with a label, in order; the JSON layer bounds the list's length.
    const eventBody = () => {
      const ids = form.getAll('meal_id')
      const meal_options = form.getAll('meal_label').map((label, i) => ({ label, ...((ids[i] ?? '').length === 0 ? {} : { option_id: ids[i] }) }))
      return {
        name: value('name'),
        starts_at: value('starts_at'),
        ...(value('location').length === 0 ? {} : { location: value('location') }),
        ...(value('invitation').length === 0 ? {} : { invitation: value('invitation') }),
        meal_options: meal_options.filter((m) => m.label.trim().length > 0 || m.option_id !== undefined),
      }
    }
    if (action === 'rsvp-close') {
      const res = call('PUT', `${base}/rsvp-settings`, { closed: form.get('closed') === 'true' })
      if (res.status !== 200) return this.#renderNonData(slug, res.status === 400 ? 404 : res.status)
      return redirect(303, `/t/${slug}?wedding=${encodeURIComponent(weddingId)}&tab=events&notice=saved`)
    }
    if (action === 'rsvp-set') {
      const guest = encodeURIComponent(value('guest_id'))
      const res = call('PUT', `${base}/events/${event}/rsvps/${guest}`, {
        invited: form.get('invited') === 'true',
        status: value('status'),
        ...(value('meal_option_id').length === 0 ? {} : { meal_option_id: value('meal_option_id') }),
      })
      if (res.status === 404 || res.status === 401 || res.status === 403) return this.#renderNonData(slug, res.status)
      const notice = res.status === 200 ? 'saved' : 'invalid'
      return redirect(303, `/t/${slug}?wedding=${encodeURIComponent(weddingId)}&tab=guests&guest=${guest}&notice=${notice}`)
    }
    const res =
      action === 'event-add'
        ? call('POST', `${base}/events`, eventBody())
        : action === 'event-update'
          ? call('PUT', `${base}/events/${event}`, eventBody())
          : action === 'event-remove'
            ? call('DELETE', `${base}/events/${event}`)
            : undefined
    if (res === undefined) return GENERIC_404
    if (res.status === 404 || res.status === 401 || res.status === 403) return this.#renderNonData(slug, res.status)
    const notice =
      res.status === 200 || res.status === 201 ? (action === 'event-remove' ? 'removed' : 'saved') : res.status === 409 ? 'conflict' : 'invalid'
    return redirect(303, `/t/${slug}?wedding=${encodeURIComponent(weddingId)}&tab=events&notice=${notice}`)
  }

  /** GET /t/:slug?wedding=ID&tab=budget (issue #34) — the wedding, then its budget; any non-200 takes the masking. */
  #budgetPage(req: ApiRequest, slug: string, weddingId: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const id = encodeURIComponent(weddingId)
    const weddingRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${id}`, token))
    if (weddingRes.status !== 200) return this.#renderNonData(slug, weddingRes.status)
    const budgetRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${id}/budget`, token))
    if (budgetRes.status !== 200) return this.#renderNonData(slug, budgetRes.status)
    const theme = this.#themes.resolveActiveTheme(slug)
    const csrf = this.#csrf.issueCsrf(token)
    const wedding = readWedding(weddingRes.body)
    if (theme === undefined || wedding === undefined) return GENERIC_404
    if (csrf === undefined) return ERROR_500
    const raw = queryParam(req.path, 'notice')
    const notice = (['saved', 'removed', 'invalid', 'forbidden', 'conflict'] as const).find((n) => n === raw)
    return htmlResult(200, renderBudget(theme, slug, wedding, budgetRes.body as BudgetView, csrf, notice))
  }

  /** POST /t/:slug/budget/<action> (issue #34) — CSRF first, then the JSON route of the form's wedding; a notice back. */
  #budgetAction(req: ApiRequest, slug: string, action: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    const value = (name: string): string => (form.get(name) ?? '').trim()
    const weddingId = value('wedding_id')
    const base = `/t/${slug}/weddings/${encodeURIComponent(weddingId)}/budget`
    const category = encodeURIComponent(value('category_id'))
    const call = (method: string, path: string, body?: unknown) => this.#api.handle(bearerJson(method, path, token, body ?? {}))
    const money = (name: string): number => (value(name).length === 0 ? 0 : (centsFromText(value(name)) ?? -1))
    const lineBody = () => ({
      name: value('name'),
      estimated_cents: money('estimated'),
      actual_cents: money('actual'),
      paid_cents: money('paid'),
      shared_with_couple: value('shared_with_couple') === 'true',
      ...(value('vendor_id').length === 0 ? {} : { vendor_id: value('vendor_id') }),
    })
    const res =
      action === 'budget-add'
        ? call('POST', base, lineBody())
        : action === 'budget-update'
          ? call('PUT', `${base}/${category}`, lineBody())
          : action === 'budget-remove'
            ? call('DELETE', `${base}/${category}`)
            : undefined
    if (res === undefined) return GENERIC_404
    if (res.status === 404 || res.status === 401) return this.#renderNonData(slug, res.status)
    const notice: BudgetNotice =
      res.status === 200 || res.status === 201 ? (action === 'budget-remove' ? 'removed' : 'saved') : res.status === 403 ? 'forbidden' : res.status === 409 ? 'conflict' : 'invalid'
    return redirect(303, `/t/${slug}?wedding=${encodeURIComponent(weddingId)}&tab=budget&notice=${notice}`)
  }

  /** GET /t/:slug?wedding=ID&tab=vendors (issue #33) — the wedding, then its vendors; any non-200 takes the masking. */
  #vendorsPage(req: ApiRequest, slug: string, weddingId: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const id = encodeURIComponent(weddingId)
    const weddingRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${id}`, token))
    if (weddingRes.status !== 200) return this.#renderNonData(slug, weddingRes.status)
    const vendorsRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${id}/vendors`, token))
    if (vendorsRes.status !== 200) return this.#renderNonData(slug, vendorsRes.status)
    const theme = this.#themes.resolveActiveTheme(slug)
    const csrf = this.#csrf.issueCsrf(token)
    const wedding = readWedding(weddingRes.body)
    if (theme === undefined || wedding === undefined) return GENERIC_404
    if (csrf === undefined) return ERROR_500
    const raw = queryParam(req.path, 'notice')
    const notice = (['saved', 'removed', 'invalid', 'forbidden', 'conflict'] as const).find((n) => n === raw)
    return htmlResult(200, renderVendors(theme, slug, wedding, vendorsRes.body as VendorsView, csrf, notice))
  }

  /**
   * POST /t/:slug/vendors/<action> (issue #33) — CSRF first, then the JSON route of the form's wedding; back to the
   * vendors page with a notice. Installment rows are indexed fields (i<n>_…), read from a one-pass index.
   */
  #vendorsAction(req: ApiRequest, slug: string, action: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    const fields = new Map<string, string>()
    for (const [key, value] of form) if (!fields.has(key)) fields.set(key, value)
    const value = (name: string): string => (fields.get(name) ?? '').trim()
    const weddingId = value('wedding_id')
    const base = `/t/${slug}/weddings/${encodeURIComponent(weddingId)}/vendors`
    const vendor = encodeURIComponent(value('vendor_id'))
    const call = (method: string, path: string, body?: unknown) => this.#api.handle(bearerJson(method, path, token, body ?? {}))
    const vendorBody = () => {
      const installments: Record<string, unknown>[] = []
      for (let n = 0; n < VENDOR_LIMITS.installments + BLANK_INSTALLMENT_ROWS && fields.has(`i${n}_label`); n++) {
        const label = value(`i${n}_label`)
        const amount = value(`i${n}_amount`)
        if (label.length === 0) continue // a blank row, or a cleared one (removed)
        // A row with a label needs an amount (a missing or mistyped one is refused, never saved as $0). Whether it is
        // paid is not in this form — only the Mark paid button changes it, so a stale tab cannot undo a payment.
        installments.push({
          label,
          amount_cents: centsFromText(amount) ?? -1,
          due_date: value(`i${n}_due`),
          deposit: value(`i${n}_deposit`) === 'true',
          ...(value(`i${n}_id`).length === 0 ? {} : { installment_id: value(`i${n}_id`) }),
        })
      }
      const optional = (name: string) => (value(name).length === 0 ? {} : { [name]: value(name) })
      return {
        category: value('category'),
        business_name: value('business_name'),
        contract_status: value('contract_status'),
        shared_with_couple: value('shared_with_couple') === 'true',
        installments,
        ...(value('category') === 'other' ? optional('category_other') : {}),
        ...optional('contact_name'),
        ...optional('email'),
        ...optional('phone'),
        ...optional('notes'),
      }
    }
    const res =
      action === 'vendor-add'
        ? call('POST', base, vendorBody())
        : action === 'vendor-update'
          ? call('PUT', `${base}/${vendor}`, vendorBody())
          : action === 'vendor-remove'
            ? call('DELETE', `${base}/${vendor}`)
            : action === 'installment-paid'
              ? call('PUT', `${base}/${vendor}/installments/${encodeURIComponent(value('installment_id'))}`, { paid: value('paid') === 'true' })
              : undefined
    if (res === undefined) return GENERIC_404
    if (res.status === 404 || res.status === 401) return this.#renderNonData(slug, res.status)
    const removedNothing = action === 'vendor-remove' && (res.body as { removed?: boolean }).removed !== true
    const notice: VendorsNotice =
      res.status === 200 || res.status === 201
        ? action === 'vendor-remove'
          ? removedNothing
            ? 'invalid'
            : 'removed'
          : 'saved'
        : res.status === 403
          ? 'forbidden'
          : res.status === 409
            ? 'conflict'
            : 'invalid'
    return redirect(303, `/t/${slug}?wedding=${encodeURIComponent(weddingId)}&tab=vendors&notice=${notice}`)
  }

  /** GET /t/:slug?view=due (issue #32) — ONE pipeline read, themed by status (a couple's 403 is the themed Forbidden). */
  #duePage(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const res = this.#api.handle(bearerGet(`/t/${slug}/due-tasks`, token))
    if (res.status !== 200) return this.#renderNonData(slug, res.status)
    const theme = this.#themes.resolveActiveTheme(slug)
    if (theme === undefined) return GENERIC_404
    return htmlResult(200, renderDueTasks(theme, slug, res.body as DueAcrossWeddings))
  }

  /**
   * GET /t/:slug?wedding=ID&tab=checklist (issue #31) — the wedding's checklist. Two reads through the pipeline (the
   * wedding, then its tasks); any non-200 takes the usual masking.
   */
  #checklistPage(req: ApiRequest, slug: string, weddingId: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const id = encodeURIComponent(weddingId)
    const weddingRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${id}`, token))
    if (weddingRes.status !== 200) return this.#renderNonData(slug, weddingRes.status)
    const tasksRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${id}/tasks`, token))
    if (tasksRes.status !== 200) return this.#renderNonData(slug, tasksRes.status)
    const theme = this.#themes.resolveActiveTheme(slug)
    const csrf = this.#csrf.issueCsrf(token)
    const wedding = readWedding(weddingRes.body)
    if (theme === undefined || wedding === undefined) return GENERIC_404
    if (csrf === undefined) return ERROR_500
    const raw = queryParam(req.path, 'notice')
    const notice = (['saved', 'removed', 'invalid', 'forbidden', 'conflict', 'applied', 'shifted', 'kept'] as const).find((n) => n === raw)
    return htmlResult(200, renderChecklist(theme, slug, wedding, tasksRes.body as ChecklistView, csrf, notice))
  }

  /**
   * POST /t/:slug/checklist/<action> (issue #31) — CSRF first, then the matching JSON route of the form's wedding;
   * back to the checklist with a notice. A couple's planner-only action shows the "forbidden" notice (its own wedding:
   * the 403 is honest). A shift goes back to the checklist too.
   */
  #checklistAction(req: ApiRequest, slug: string, action: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    const weddingId = form.get('wedding_id') ?? ''
    const base = `/t/${slug}/weddings/${encodeURIComponent(weddingId)}/tasks`
    const value = (name: string): string => (form.get(name) ?? '').trim()
    const task = encodeURIComponent(value('task_id'))
    const call = (method: string, path: string, body?: unknown) => this.#api.handle(bearerJson(method, path, token, body ?? {}))
    const taskBody = () => ({ title: value('title'), due_date: value('due_date'), assignee: value('assignee'), ...(value('notes').length === 0 ? {} : { notes: value('notes') }) })
    const res =
      action === 'task-add'
        ? call('POST', base, taskBody())
        : action === 'task-update'
          ? call('PUT', `${base}/${task}`, taskBody())
          : action === 'task-remove'
            ? call('DELETE', `${base}/${task}`)
            : action === 'task-status'
              ? call('PUT', `${base}/${task}/status`, { status: value('status') })
              : action === 'apply-template'
                ? call('POST', `${base}/apply-template`)
                : action === 'shift'
                  ? call('POST', `${base}/shift`)
                  : action === 'keep-dates'
                    ? call('DELETE', `${base}/date-move`)
                    : undefined
    if (res === undefined) return GENERIC_404
    if (res.status === 404 || res.status === 401) return this.#renderNonData(slug, res.status)
    const ok = res.status === 200 || res.status === 201
    const notice: ChecklistNotice = ok
      ? action === 'task-remove'
        ? 'removed'
        : action === 'apply-template'
          ? 'applied'
          : action === 'shift'
            ? 'shifted'
            : action === 'keep-dates'
              ? 'kept'
              : 'saved'
      : res.status === 403
        ? 'forbidden'
        : res.status === 409
          ? 'conflict'
          : 'invalid'
    return redirect(303, `/t/${slug}?wedding=${encodeURIComponent(weddingId)}&tab=checklist&notice=${notice}`)
  }

  /** The page that shows a just-made RSVP link once (issue #30); any refusal takes the usual masking. */
  #rsvpLinkMade(slug: string, token: string | undefined, weddingId: string, householdId: string, res: { status: number; body: unknown }): HttpResult {
    if (res.status !== 201) return this.#renderNonData(slug, res.status === 400 ? 404 : res.status)
    const id = encodeURIComponent(weddingId)
    const wedding = readWedding(this.#api.handle(bearerGet(`/t/${slug}/weddings/${id}`, token)).body)
    const list = this.#api.handle(bearerGet(`/t/${slug}/weddings/${id}/guest-list`, token)).body as GuestListView
    const household = list.households?.find((h) => h.household_id === householdId)
    const theme = this.#themes.resolveActiveTheme(slug)
    if (wedding === undefined || household === undefined || theme === undefined) return GENERIC_404
    return htmlResult(201, renderRsvpLinkMade(theme, slug, wedding, household.name, (res.body as { url: string }).url))
  }

  /**
   * GET|POST /t/:slug/rsvp/<token> (issue #30) — the household's RSVP page, through the pipeline's public
   * `/household-rsvp/<token>` route (one transaction per submission). Unknown, replaced or foreign tokens are the
   * generic not-found; a POST checks the pre-session anti-forgery value first. `no-referrer`: the link is the secret.
   */
  #householdRsvp(req: ApiRequest, slug: string, rsvpToken: string): HttpResult {
    const theme = this.#themes.resolveActiveTheme(slug)
    const accounts = this.#accounts
    if (theme === undefined || accounts === undefined) return GENERIC_404
    const path = `/t/${slug}/household-rsvp/${rsvpToken}`
    const page = (status: number, view: HouseholdRsvpView, notice?: HouseholdRsvpNotice): HttpResult => {
      const preCsrf = accounts.newToken()
      return htmlResult(status, renderHouseholdRsvp(theme, slug, rsvpToken, view, preCsrf, notice), {
        ...this.#preCookie(slug, preCsrf),
        'referrer-policy': 'no-referrer',
      })
    }
    const read = () => this.#api.handle(bearerGet(path, undefined))
    if (req.method === 'GET') {
      const res = read()
      if (res.status !== 200) return GENERIC_404
      return page(200, res.body as HouseholdRsvpView, queryParam(req.path, 'saved') === '1' ? 'saved' : undefined)
    }
    if (req.method !== 'POST') return GENERIC_404
    // The token first: a link that does not resolve is the not-found before any form work (the anti-forgery value is
    // a double-submit anyone can supply, so it is no gate against a junk body).
    const current = read()
    if (current.status !== 200) return GENERIC_404
    // One pass indexes the form (first value wins), refusing an oversized one; every lookup below is then O(1).
    const fields = new Map<string, string>()
    let count = 0
    for (const [key, value] of parseForm(req.rawBody)) {
      if (++count > HOUSEHOLD_FORM_MAX_FIELDS) return page(400, current.body as HouseholdRsvpView, 'invalid')
      if (!fields.has(key)) fields.set(key, value)
    }
    const csrfOk = this.#preCsrfValid(req, new URLSearchParams([['_csrf', fields.get('_csrf') ?? '']]))
    if (!csrfOk) return page(400, current.body as HouseholdRsvpView, 'expired')
    // Only what the household changed on this page is sent (each row carries what it showed), so a tab left open
    // never reverts a newer answer recorded by the planner. Rows pair with their hidden ids by position; the JSON
    // layer bounds the lists and re-checks every one.
    const answers: HouseholdAnswer[] = []
    for (let n = 0; n < HOUSEHOLD_FORM_ROWS && fields.has(`g${n}`); n++) {
      const status = fields.get(`s${n}`)
      if (status !== 'attending' && status !== 'declined') continue
      const meal = fields.get(`m${n}`) ?? ''
      if (status === fields.get(`o${n}`) && meal === (fields.get(`om${n}`) ?? '')) continue
      answers.push({ guest_id: fields.get(`g${n}`) ?? '', event_id: fields.get(`e${n}`) ?? '', status, ...(meal.length === 0 ? {} : { meal_option_id: meal }) })
    }
    const dietary: { guest_id: string; note: string }[] = []
    for (let j = 0; j < HOUSEHOLD_FORM_ROWS && fields.has(`dg${j}`); j++) {
      const note = fields.get(`d${j}`) ?? ''
      if (note !== (fields.get(`od${j}`) ?? '')) dietary.push({ guest_id: fields.get(`dg${j}`) ?? '', note })
    }
    const res = this.#api.handle(bearerJson('POST', path, undefined, { answers, dietary }))
    if (res.status === 200) return redirect(303, `/t/${slug}/rsvp/${encodeURIComponent(rsvpToken)}?saved=1`, { 'referrer-policy': 'no-referrer' })
    if (res.status === 404) return GENERIC_404
    const again = read()
    if (again.status !== 200) return GENERIC_404
    const notice: HouseholdRsvpNotice = res.status === 409 ? 'closed' : res.status === 429 ? 'rate_limited' : 'invalid'
    return page(res.status === 429 ? 429 : res.status === 409 ? 409 : 400, again.body as HouseholdRsvpView, notice)
  }

  /**
   * GET /t/:slug/guest-list/export?wedding=ID (issue #28) — the guest list as a CSV download, built from the same
   * pipeline read as the page (so the same boundary and masking). Named by the wedding id, never the couple's names;
   * `no-store`, formula cells neutralized (guest_csv.ts).
   */
  #guestListExport(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const weddingId = queryParam(req.path, 'wedding') ?? ''
    const res = this.#api.handle(bearerGet(`/t/${slug}/weddings/${encodeURIComponent(weddingId)}/guest-list`, token))
    if (res.status !== 200) return this.#renderNonData(slug, res.status)
    const filename = /^[A-Za-z0-9_-]{1,128}$/.test(weddingId) ? `guest-list-${weddingId}.csv` : 'guest-list.csv'
    return {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
      body: toGuestCsv(res.body as GuestListView),
    }
  }

  /**
   * POST /t/:slug/guest-list/import (issue #28) — CSRF first; `commit=1` imports, anything else previews. A preview,
   * or an import with problems, re-renders the import page with the result; an applied import lands on the list.
   */
  #guestListImport(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    const weddingId = form.get('wedding_id') ?? ''
    const csv = form.get('csv') ?? ''
    const res = this.#api.handle(
      bearerJson('POST', `/t/${slug}/weddings/${encodeURIComponent(weddingId)}/guest-list/import`, token, {
        csv,
        commit: form.get('commit') === '1',
      }),
    )
    if (res.status === 401 || res.status === 403 || res.status === 404) return this.#renderNonData(slug, res.status)
    // Anything else that refused the import (a list changed since the preview, a bound): show it, keep the text.
    const result: GuestImportResult =
      res.status === 200
        ? (res.body as GuestImportResult)
        : { applied: false, problems: [{ row: 1, message: 'The import could not be applied. Preview it again.' }], creates: 0, updates: 0, households_created: 0 }
    if (result.applied) return redirect(303, `/t/${slug}?wedding=${encodeURIComponent(weddingId)}&tab=guests&notice=imported`)
    const weddingRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${encodeURIComponent(weddingId)}`, token))
    const wedding = readWedding(weddingRes.body)
    const theme = this.#themes.resolveActiveTheme(slug)
    const csrf = this.#csrf.issueCsrf(token)
    if (weddingRes.status !== 200 || wedding === undefined || theme === undefined || csrf === undefined) return GENERIC_404
    return htmlResult(result.problems.length > 0 ? 400 : 200, renderGuestImport(theme, slug, wedding, csrf, csv, result))
  }

  /**
   * POST /t/:slug/guest-list/<action> (issue #27) — CSRF first, then the cookie becomes the Bearer for the JSON
   * guest-list route of the form's wedding. PRG back to the list with a notice; a failed guest edit re-renders the
   * edit page. The wedding's boundary is the JSON layer's (a foreign wedding is the masked not-found).
   */
  #guestListAction(req: ApiRequest, slug: string, action: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    const weddingId = form.get('wedding_id') ?? ''
    const base = `/t/${slug}/weddings/${encodeURIComponent(weddingId)}`
    const value = (name: string): string => (form.get(name) ?? '').trim()
    const optional = (name: string): Record<string, string> => (value(name).length === 0 ? {} : { [name]: value(name) })
    const householdBody = { name: value('name'), ...optional('address') }
    const guestBody = {
      first_name: value('first_name'),
      last_name: value('last_name'),
      side: value('side'),
      tags: value('tags').split(',').map((t) => t.trim()).filter((t) => t.length > 0),
      plus_one_allowed: form.get('plus_one_allowed') === 'true',
      ...optional('household_id'),
      ...optional('dietary'),
      ...optional('email'),
      ...optional('phone'),
      ...optional('plus_one_of'),
    }
    const call = (method: string, path: string, body?: unknown) => this.#api.handle(bearerJson(method, path, token, body ?? {}))
    const household = encodeURIComponent(value('household_id'))
    const guest = encodeURIComponent(value('guest_id'))
    if (action === 'rsvp-link') return this.#rsvpLinkMade(slug, token, weddingId, value('household_id'), call('POST', `${base}/households/${household}/rsvp-link`))
    const res =
      action === 'household-add'
        ? call('POST', `${base}/households`, householdBody)
        : action === 'household-update'
          ? call('PUT', `${base}/households/${household}`, householdBody)
          : action === 'household-remove'
            ? call('DELETE', `${base}/households/${household}`)
            : action === 'guest-add'
              ? call('POST', `${base}/guests`, guestBody)
              : action === 'guest-update'
                ? call('PUT', `${base}/guests/${guest}`, guestBody)
                : action === 'guest-remove'
                  ? call('DELETE', `${base}/guests/${guest}`)
                  : undefined
    if (res === undefined) return GENERIC_404
    if (res.status === 404 || res.status === 401 || res.status === 403) return this.#renderNonData(slug, res.status)
    if (action === 'guest-update' && res.status !== 200) {
      const edit = { ...req, method: 'GET', path: `/t/${slug}?wedding=${encodeURIComponent(weddingId)}&tab=guests&guest=${guest}` }
      return res.status === 409
        ? this.#guestListPage(edit, slug, weddingId, 409, 'conflict')
        : this.#guestListPage(edit, slug, weddingId, 400, 'invalid')
    }
    const notice: GuestListNotice =
      res.status === 200 || res.status === 201 ? (action.endsWith('remove') ? 'removed' : 'saved') : res.status === 409 ? 'conflict' : 'invalid'
    return redirect(303, `/t/${slug}?wedding=${encodeURIComponent(weddingId)}&tab=guests&notice=${notice}`)
  }

  /** GET /t/:slug?view=team (issue #11) — the team page; a couple gets the themed Forbidden. */
  #teamPage(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const res = this.#api.handle(bearerGet(`/t/${slug}/team`, token))
    const team = readTeam(res)
    if (team === undefined) return this.#renderNonData(slug, res.status)
    const theme = this.#themes.resolveActiveTheme(slug)
    const csrf = this.#csrf.issueCsrf(token)
    if (theme === undefined || csrf === undefined) return theme === undefined ? GENERIC_404 : ERROR_500
    const raw = queryParam(req.path, 'notice')
    const notice = TEAM_NOTICE_VALUES.find((value) => value === raw)
    return htmlResult(200, renderTeam(theme, slug, team, csrf, notice))
  }

  /**
   * POST /t/:slug/team/{invite,resend,revoke,remove} (issue #11) — CSRF first (forged ⇒ masked 403, no change), then
   * the cookie becomes the Bearer for the JSON team route. PRG back to the team page (or, for a couple invitation, to
   * the wedding) with a notice. The capability (planner / owner) is the JSON layer's; a refusal shows a notice.
   */
  #teamAction(req: ApiRequest, slug: string, action: 'invite' | 'resend' | 'revoke' | 'remove'): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    if (action === 'invite') {
      const role = form.get('role') ?? ''
      const weddingId = form.get('wedding_id') ?? ''
      const res = this.#api.handle(
        bearerJson('POST', `/t/${slug}/invitations`, token, {
          email: form.get('email') ?? '',
          role,
          ...(weddingId.length === 0 ? {} : { wedding_id: weddingId }),
        }),
      )
      const outcome = res.status === 201 ? 'sent' : res.status === 409 ? 'exists' : res.status === 403 ? 'not_allowed' : 'invalid'
      if (role === 'couple' && weddingId.length > 0 && outcome !== 'not_allowed') {
        return redirect(303, `/t/${slug}?wedding=${encodeURIComponent(weddingId)}&invite=${outcome}`)
      }
      return redirect(303, `/t/${slug}?view=team&notice=${outcome === 'sent' ? 'invited' : outcome}`)
    }
    const [path, field, done] =
      action === 'resend'
        ? ['invitations/resend', 'invitation_id', 'resent']
        : action === 'revoke'
          ? ['invitations/revoke', 'invitation_id', 'revoked']
          : ['members/remove', 'user_id', 'removed']
    const res = this.#api.handle(bearerJson('POST', `/t/${slug}/${path}`, token, { [field]: form.get(field) ?? '' }))
    const notice = res.status === 200 ? done : res.status === 403 ? 'not_allowed' : 'invalid'
    return redirect(303, `/t/${slug}?view=team&notice=${notice}`)
  }

  /**
   * GET/POST /t/:slug/invite?token=… (issue #11) — accept an invitation: choose a password; on success the new member
   * is signed in (the session cookie is set) and lands on the console. Pre-session anti-forgery like sign-in; the
   * token is in the URL, so no referrer and no cache.
   */
  #invite(req: ApiRequest, slug: string): HttpResult {
    const theme = this.#themes.resolveActiveTheme(slug)
    if (theme === undefined || this.#accounts === undefined) return GENERIC_404
    const accounts = this.#accounts
    const page = (status: number, token: string, notice?: 'weak' | 'mismatch' | 'invalid' | 'exists' | 'expired'): HttpResult => {
      const preCsrf = accounts.newToken()
      return htmlResult(status, renderInviteAccept(theme, slug, preCsrf, token, notice), {
        ...this.#preCookie(slug, preCsrf),
        'referrer-policy': 'no-referrer',
      })
    }
    if (req.method === 'GET') {
      const token = queryParam(req.path, 'token') ?? ''
      return page(200, token, token.length === 0 ? 'invalid' : undefined)
    }
    if (req.method !== 'POST') return this.#delegate(req)
    const form = parseForm(req.rawBody)
    const token = form.get('token') ?? ''
    if (!this.#preCsrfValid(req, form)) return page(400, token, 'expired')
    const password = form.get('password') ?? ''
    if (password !== (form.get('confirm') ?? '')) return page(400, token, 'mismatch')
    const res = this.#api.handle(bearerJson('POST', `/t/${slug}/invitations/accept`, undefined, { token, password }))
    if (res.status === 201) return this.#signedIn(slug, res.body)
    if (res.status === 404) return GENERIC_404
    if (res.status === 409) return page(409, token, 'exists')
    const reason = (res.body as { error?: string } | undefined)?.error
    return page(400, token, reason === 'weak_password' ? 'weak' : 'invalid')
  }

  #renderNonData(slug: string, status: number): HttpResult {
    if (status === 401) return this.#loginPage(slug, 200)
    if (status === 403) {
      const theme = this.#themes.resolveActiveTheme(slug)
      return theme === undefined ? GENERIC_404 : htmlResult(403, renderForbidden(theme, slug))
    }
    return GENERIC_404
  }

  /** GET shows the themed login form; POST runs the simulated login and sets the session cookie. */
  /**
   * The themed sign-in page at `status`. With real accounts: the password form (carrying a fresh pre-session
   * anti-forgery value, set as the `wp_pre` cookie too) and, on the demo tenant only, the labeled picker.
   */
  #loginPage(slug: string, status: number, notice?: 'credentials' | 'rate_limited' | 'expired' | 'reset_done', invalid = false): HttpResult {
    const theme = this.#themes.resolveActiveTheme(slug)
    if (theme === undefined) return GENERIC_404
    if (this.#accounts === undefined) return htmlResult(status, renderLogin(theme, slug, invalid))
    const preCsrf = this.#accounts.newToken()
    const simulated = this.#accounts.isSimulatedSlug(slug)
    return htmlResult(
      status,
      renderLogin(theme, slug, invalid, { preCsrf, simulated, ...(notice === undefined ? {} : { notice }) }),
      this.#preCookie(slug, preCsrf),
    )
  }

  /** The Set-Cookie header for a fresh pre-session anti-forgery value. */
  #preCookie(slug: string, value: string): Record<string, string> {
    if (!SAFE_TOKEN.test(value)) throw new ProductError('PRODUCT.UNSAFE_TOKEN', 'A pre-session token must be URL- and header-safe.', {})
    return { 'set-cookie': `${PRE_SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/t/${slug}; Max-Age=3600` }
  }

  /** Whether a pre-session form POST carries the anti-forgery value its page set (cookie and field, equal). */
  #preCsrfValid(req: ApiRequest, form: URLSearchParams): boolean {
    const cookie = readCookie(req.headers.cookie, PRE_SESSION_COOKIE)
    const field = form.get('_csrf') ?? ''
    return cookie !== undefined && field.length > 0 && constantTimeEqual(cookie, field)
  }

  #login(req: ApiRequest, slug: string): HttpResult {
    if (req.method === 'GET') {
      return this.#loginPage(slug, 200, queryParam(req.path, 'reset') === '1' ? 'reset_done' : undefined)
    }
    if (req.method !== 'POST') return this.#delegate(req)

    const form = parseForm(req.rawBody)
    // Issue #10: the password form (anti-forgery checked first; the picker below is the demo-only legacy path).
    if (this.#accounts !== undefined && form.has('email')) {
      if (!this.#preCsrfValid(req, form)) return this.#loginPage(slug, 400, 'expired')
      const res = this.#api.handle(
        bearerJson('POST', `/t/${slug}/sessions`, undefined, { email: form.get('email') ?? '', password: form.get('password') ?? '' }),
      )
      if (res.status === 201) return this.#signedIn(slug, res.body)
      if (res.status === 404) return GENERIC_404
      return this.#loginPage(slug, res.status === 429 ? 429 : 401, res.status === 429 ? 'rate_limited' : 'credentials')
    }

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

    if (apiRes.status === 201) return this.#signedIn(slug, apiRes.body)
    if (apiRes.status === 404) return GENERIC_404 // unknown / suspended / onboarding tenant — masked
    // 400 (bad role / missing couple wedding_id / no picker here): re-render the themed login with a generic notice.
    return this.#loginPage(slug, 400, undefined, true)
  }

  /** A successful sign-in: set the session cookie from the server-minted token and land on the console. */
  #signedIn(slug: string, body: unknown): HttpResult {
    const token = readToken(body)
    if (token === undefined || !SAFE_TOKEN.test(token)) return ERROR_500
    // Location + Set-Cookie are built ONLY from the validated slug + the server-minted token.
    return redirect(303, `/t/${slug}`, {
      'set-cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/t/${slug}`,
    })
  }

  /**
   * GET/POST /t/:slug/forgot (issue #10) — request a reset link. The POST answers with the same "check your email"
   * page whether or not an account exists (the API's uniform 202); only a rate limit or an expired form differ.
   */
  #forgot(req: ApiRequest, slug: string): HttpResult {
    const theme = this.#themes.resolveActiveTheme(slug)
    if (theme === undefined || this.#accounts === undefined) return GENERIC_404
    const page = (status: number, state?: 'sent' | 'rate_limited' | 'expired'): HttpResult => {
      const preCsrf = (this.#accounts as NonNullable<ProductWebUiDeps['accounts']>).newToken()
      return htmlResult(status, renderForgot(theme, slug, preCsrf, state), this.#preCookie(slug, preCsrf))
    }
    if (req.method === 'GET') return page(200)
    if (req.method !== 'POST') return this.#delegate(req)
    const form = parseForm(req.rawBody)
    if (!this.#preCsrfValid(req, form)) return page(400, 'expired')
    const res = this.#api.handle(bearerJson('POST', `/t/${slug}/password-reset`, undefined, { email: form.get('email') ?? '' }))
    if (res.status === 202) return htmlResult(200, renderForgot(theme, slug, '', 'sent'))
    if (res.status === 429) return page(429, 'rate_limited')
    if (res.status === 404) return GENERIC_404
    return page(400)
  }

  /**
   * GET/POST /t/:slug/reset?token=… (issue #10) — choose a password through a reset or account-setup link. The
   * token is in the URL, so these pages send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. The new
   * password's length (and the confirmation) is checked before the link is used, so a typo never burns it.
   */
  #reset(req: ApiRequest, slug: string): HttpResult {
    const theme = this.#themes.resolveActiveTheme(slug)
    if (theme === undefined || this.#accounts === undefined) return GENERIC_404
    const accounts = this.#accounts
    const page = (status: number, token: string, notice?: 'weak' | 'mismatch' | 'invalid' | 'expired'): HttpResult => {
      const preCsrf = accounts.newToken()
      return htmlResult(status, renderReset(theme, slug, preCsrf, token, notice), {
        ...this.#preCookie(slug, preCsrf),
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      })
    }
    if (req.method === 'GET') {
      const token = queryParam(req.path, 'token') ?? ''
      return page(200, token, token.length === 0 ? 'invalid' : undefined)
    }
    if (req.method !== 'POST') return this.#delegate(req)
    const form = parseForm(req.rawBody)
    const token = form.get('token') ?? ''
    if (!this.#preCsrfValid(req, form)) return page(400, token, 'expired')
    const password = form.get('password') ?? ''
    if (password !== (form.get('confirm') ?? '')) return page(400, token, 'mismatch')
    const res = this.#api.handle(bearerJson('POST', `/t/${slug}/password-reset/complete`, undefined, { token, password }))
    if (res.status === 200) return redirect(303, `/t/${slug}/login?reset=1`)
    if (res.status === 404) return GENERIC_404
    const reason = (res.body as { error?: string } | undefined)?.error
    return page(400, token, reason === 'weak_password' ? 'weak' : 'invalid')
  }

  #logout(req: ApiRequest, slug: string): HttpResult {
    if (req.method !== 'POST') return this.#delegate(req)
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    // Sessions persist (issue #8), so sign-out revokes the session server-side, not just the cookie.
    this.#api.handle({ method: 'DELETE', path: `/t/${slug}/sessions`, headers: { authorization: `Bearer ${token}` } })
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
  return readCookie(cookieHeader, SESSION_COOKIE)
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
const TEAM_NOTICE_VALUES: readonly TeamNotice[] = ['invited', 'exists', 'invalid', 'resent', 'revoked', 'removed', 'not_allowed']

/** The team view from a `GET /t/:slug/team` answer, or undefined unless it was a 200 (a planner). */
function readTeam(res: { status: number; body: unknown }): TeamView | undefined {
  if (res.status !== 200) return undefined
  const body = res.body as Partial<TeamView> | undefined
  return Array.isArray(body?.members) && Array.isArray(body?.invitations) ? (body as TeamView) : undefined
}

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

/** Read the reply-thread array from a list (200) JSON body (Phase 34; tolerant — never throws on an odd shape). */
function readReplies(body: unknown): readonly EscalationReply[] {
  if (typeof body !== 'object' || body === null) return []
  const replies = (body as { replies?: unknown }).replies
  return Array.isArray(replies) ? (replies as EscalationReply[]) : []
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
