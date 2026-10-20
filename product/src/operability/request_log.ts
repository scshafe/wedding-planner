import { normalizeSlugForRoute } from '../web/html'

/**
 * @canonical request_log -- one structured JSON line per request (issue #13, ADR 0044).
 *
 * A line carries exactly: `ts`, `method`, `route` (the route PATTERN), `status`, `duration_ms`, and `tenant` (the
 * route's slug, when it is a valid slug). Never a token, a cookie, a header, a body, a query string, or any free text
 * from the request: the pattern is built from an ALLOW-LIST of the product's static path segments — every other
 * segment becomes `:id` (or `:slug` in the tenant position), and the query string is dropped before anything else.
 * So a reset token in `?token=`, a guest's phone number in a path, or an email in a body cannot reach a log line.
 *
 * related: web_server.ts (writes the line after each response), error_log.ts (the operator's error list).
 */

/** The product's static path segments; any other segment is an id (or the tenant slug) and is not logged. */
const STATIC_SEGMENTS: ReadonlySet<string> = new Set([
  'healthz', 't', 'admin',
  'login', 'logout', 'forgot', 'reset', 'invite', 'strategy', 'feedback', 'send',
  'sessions', 'weddings', 'guests', 'escalations', 'billing', 'messaging', 'inbound',
  'password-reset', 'complete', 'invitations', 'accept', 'resend', 'revoke', 'members', 'remove', 'team',
  'create', 'update', 'resolve', 'reply', 'pay', 'guest-list', 'households', 'import', 'export',
  'household-add', 'household-update', 'household-remove', 'guest-add', 'guest-update', 'guest-remove',
  'events', 'rsvps', 'event-add', 'event-update', 'event-remove', 'rsvp-set',
  'rsvp', 'household-rsvp', 'rsvp-link', 'rsvp-links', 'rsvp-settings', 'rsvp-close',
  'tasks', 'status', 'apply-template', 'shift', 'checklist', 'task-add', 'task-update', 'task-remove', 'task-status',
  'date-move', 'keep-dates', 'due-tasks',
  'vendors', 'installments', 'vendor-add', 'vendor-update', 'vendor-remove', 'installment-paid',
  'budget', 'budget-add', 'budget-update', 'budget-remove',
  'tenants', 'owner', 'activate', 'suspend', 'reactivate', 'outbox', 'errors',
])

/** HTTP methods logged by name; anything else is `OTHER` (the method is client-controlled text). */
const KNOWN_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/** What one request contributes to the log. */
export interface RequestLogEntry {
  readonly ts: string
  readonly method: string
  readonly route: string
  readonly status: number
  readonly duration_ms: number
  readonly tenant?: string
}

/** The route pattern of a request path (query dropped; non-static segments masked) and its tenant slug. */
export function routePattern(path: string): { readonly route: string; readonly tenant?: string } {
  const query = path.indexOf('?')
  const clean = query === -1 ? path : path.slice(0, query)
  const segments = clean.split('/').filter((s) => s.length > 0)
  let tenant: string | undefined
  const masked = segments.map((segment, index) => {
    if (index === 1 && segments[0] === 't') {
      tenant = normalizeSlugForRoute(segment)
      return ':slug'
    }
    return STATIC_SEGMENTS.has(segment) ? segment : ':id'
  })
  return { route: `/${masked.join('/')}`, ...(tenant === undefined ? {} : { tenant }) }
}

/** The logged method name. */
export function logMethod(method: string): string {
  const upper = method.toUpperCase()
  return KNOWN_METHODS.has(upper) ? upper : 'OTHER'
}

/** One JSON line, keys in a fixed order. */
export function formatRequestLog(entry: RequestLogEntry): string {
  return JSON.stringify({
    ts: entry.ts,
    method: entry.method,
    route: entry.route,
    status: entry.status,
    duration_ms: entry.duration_ms,
    ...(entry.tenant === undefined ? {} : { tenant: entry.tenant }),
  })
}
