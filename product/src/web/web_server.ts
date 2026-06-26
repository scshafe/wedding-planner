import http from 'node:http'

import type { ApiRequest } from '../http/api_message'
import { MAX_BODY_BYTES } from '../http/node_server'
import type { ProductWebUi } from './product_web_ui'

/**
 * @canonical product_web_server -- the thin Node `http` adapter for the combined web UI + JSON API.
 *
 * The single deployed front door for Phase 14. Like the JSON-only `createProductApiServer`, it does only
 * socket mechanics and NO policy: read the body (capped at {@link MAX_BODY_BYTES} -> `413`), build an
 * {@link ApiRequest} (lowercased headers, raw body), hand it to `ProductWebUi.handle`, and write the
 * returned {@link HttpResult} verbatim (its explicit status, header map, and string body). All routing,
 * tenant resolution, auth, theming, and rendering live in the pure handler, so this adapter needs no
 * test beyond a wiring smoke check. The JSON-only `node_server.ts` is left untouched for pure-API use.
 *
 * related: product_web_ui.ts (the pure handler), node_server.ts (the JSON-only adapter it reuses the cap from).
 */
export function createProductWebUiServer(ui: ProductWebUi): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false

    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        aborted = true
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'payload_too_large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (aborted) return
      try {
        const rawBody = chunks.length === 0 ? undefined : Buffer.concat(chunks).toString('utf8')
        const apiReq: ApiRequest = {
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          headers: lowercaseHeaders(req.headers),
          rawBody,
        }
        const result = ui.handle(apiReq)
        if (res.headersSent) return
        res.writeHead(result.status, result.headers)
        res.end(result.body)
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
