import http from 'node:http'

import type { Clock } from '@wedding-planner/shared'

import type { ApiRequest } from '../http/api_message'
import { formatRequestLog, logMethod, routePattern } from '../operability/request_log'
import { MAX_BODY_BYTES } from '../http/node_server'
import type { ProductWebUi } from './product_web_ui'
import { LARGE_TRANSFER_BYTES } from './transfer_budget'

/**
 * @canonical product_web_server -- the thin Node `http` adapter for the combined web UI + JSON API.
 *
 * The single deployed front door for Phase 14. Like the JSON-only `createProductApiServer`, it does only
 * socket mechanics and NO policy: read the body (capped at the limit `ProductWebUi.bodyLimit` names for the request —
 * `MAX_BODY_BYTES` unless it is a signed-in document upload — -> `413`, refused up front when the declared
 * `content-length` is already over it), build an {@link ApiRequest} (lowercased headers, raw body and its bytes), hand
 * it to `ProductWebUi.handle`, and write the returned {@link HttpResult} verbatim (its explicit status, header map,
 * and string body or bytes). Issue #48: a large upload body takes one of a few places and must arrive within a
 * deadline, and a large response is held against the process-wide budget until it is written (`ui.transfers`,
 * transfer_budget.ts) — 503 when either is full. All routing,
 * tenant resolution, auth, theming, and rendering live in the pure handler, so this adapter needs no
 * test beyond a wiring smoke check. The JSON-only `node_server.ts` is left untouched for pure-API use.
 *
 * related: product_web_ui.ts (the pure handler), node_server.ts (the JSON-only adapter it reuses the cap from).
 */
/**
 * Issue #13: the per-request log. Injected by the entrypoint (the edge): where a line goes, the wall clock for `ts`,
 * and a monotonic millisecond counter for `duration_ms`. Absent ⇒ no request logging (tests, embedding).
 */
export interface RequestLogging {
  readonly write: (line: string) => void
  readonly clock: Clock
  readonly elapsedMs: () => number
}

export function createProductWebUiServer(ui: ProductWebUi, logging?: RequestLogging): http.Server {
  return http.createServer((req, res) => {
    const startedMs = logging?.elapsedMs()
    // One line per request, after the response: the route PATTERN only (request_log.ts) — never the path's ids or
    // query, a header, a cookie, or the body.
    res.on('finish', () => {
      if (logging === undefined || startedMs === undefined) return
      try {
        const { route, tenant } = routePattern(req.url ?? '/')
        logging.write(
          formatRequestLog({
            ts: logging.clock.now(),
            method: logMethod(req.method ?? 'GET'),
            route,
            status: res.statusCode,
            duration_ms: Math.round((logging.elapsedMs() - startedMs) * 10) / 10,
            ...(tenant === undefined ? {} : { tenant }),
          }),
        )
      } catch {
        // Logging must never take a request down.
      }
    })
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    const headers = lowercaseHeaders(req.headers)
    let limit = MAX_BODY_BYTES
    try {
      limit = ui.bodyLimit(req.method ?? 'GET', req.url ?? '/', headers)
    } catch {
      // A storage failure while checking the session: the default limit (never a crash outside the handler).
    }
    const refuse = (status: number, error: string, extra: Record<string, string> = {}): void => {
      aborted = true
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...extra })
      res.end(JSON.stringify({ error }))
      req.destroy()
    }
    // A declared length over the limit is refused before a byte of the body is read.
    if (Number(headers['content-length'] ?? 0) > limit) {
      refuse(413, 'payload_too_large')
      return
    }
    if (limit > MAX_BODY_BYTES) {
      // A large upload: one of a few places, and a deadline for the whole body.
      const release = ui.transfers.holdUpload()
      if (release === undefined) {
        refuse(503, 'busy', { 'retry-after': '10' })
        return
      }
      const deadline = setTimeout(() => {
        if (!aborted && !res.headersSent) refuse(408, 'request_timeout')
      }, ui.transfers.limits.upload_deadline_ms)
      const done = (): void => {
        clearTimeout(deadline)
        release()
      }
      req.once('end', () => clearTimeout(deadline))
      res.once('close', done)
    }

    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      total += chunk.length
      if (total > limit) {
        refuse(413, 'payload_too_large')
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (aborted) return
      try {
        const bytes = chunks.length === 0 ? undefined : Buffer.concat(chunks)
        // A multipart body is binary: only its bytes are passed (no UTF-8 copy nobody reads).
        const multipart = (headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data')
        const apiReq: ApiRequest = {
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          headers,
          ...(bytes === undefined ? {} : multipart ? { bodyBytes: bytes } : { rawBody: bytes.toString('utf8') }),
        }
        const result = ui.handle(apiReq)
        if (res.headersSent) return
        const size = result.bytes?.byteLength ?? Buffer.byteLength(result.body)
        if (size >= LARGE_TRANSFER_BYTES) {
          // Held until it is written or the connection closes; a response that does not fit is not held at all.
          const release = ui.transfers.holdResponse(size)
          if (release === undefined) {
            res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ error: 'busy' }))
            return
          }
          res.once('close', release)
        }
        res.writeHead(result.status, result.headers)
        res.end(result.bytes ?? result.body)
        // Issue #10: work whose cost must not show in the response's timing runs after the response is written.
        setImmediate(() => ui.runDeferredWork())
      } catch {
        // The pure handler never throws (it maps slips to a constant 500), but stay fail-closed.
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal_error' }))
        }
      }
    })

    req.on('error', () => {
      if (!aborted && !res.headersSent) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'bad_request' }))
      }
    })
  })
}

/** Normalize incoming headers to a lowercased single-value map (Node lowercases keys; coalesce arrays). */
function lowercaseHeaders(headers: http.IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value
  }
  return out
}
