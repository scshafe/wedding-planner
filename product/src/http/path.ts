/**
 * @canonical http_path -- the ONE path-splitting rule shared by the JSON pipeline and the web front door.
 *
 * Both the pure JSON handler (`product_api.ts`) and the HTML front door (`product_web_ui.ts`) route by
 * path segments, and the UI's correctness DEPENDS on splitting paths identically to the pipeline it
 * delegates to. A single canonical implementation removes the drift risk (arch P2-2): the query string
 * is dropped, then non-empty segments are returned, so `/t/alpha/weddings/` and `/t/alpha?x=1` reduce as
 * the routers expect. Header keys are not touched here — this is purely the path → segments rule.
 *
 * related: product_api.ts (#route), product_web_ui.ts (#route).
 */

/** Split a path into non-empty segments, dropping the query string. `/t/a?x=1` -> ['t','a']. */
export function splitPath(path: string): string[] {
  const query = path.indexOf('?')
  const clean = query === -1 ? path : path.slice(0, query)
  return clean.split('/').filter((s) => s.length > 0)
}
