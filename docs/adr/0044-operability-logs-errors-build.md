# ADR 0044 — Operability: request logs, server errors, the build in /healthz

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #13 (M1 "Real foundations")
- **Scope:** one structured log line per request, an operator page of recent server errors, and the build commit
  in `/healthz`.
- **Builds on** durable storage and one transaction per request (ADR 0039), and the operator console (ADR 0040).

## Context

When something went wrong in production there was nothing to look at: no request log, no error record, and no
way to tell which build was running except through the deploy tooling.

## Decision

### One JSON line per request, carrying no request data

- The socket adapter (`createProductWebUiServer`) writes one line to stdout on each response's `finish`:
  `{ts, method, route, status, duration_ms, tenant?}`. The entrypoint injects the sink, the wall clock and a
  monotonic timer, so the rest stays deterministic.
- `route` is the route **pattern**. The query string is dropped first. Then every path segment that is not one
  of the product's static segment names (an allow-list) becomes `:id`, and the tenant position becomes `:slug`.
- `tenant` is that slug, and only when it has a valid slug shape. Slugs are public routing keys.
- `method` is a known HTTP method or `OTHER`.
- The result: no token (a reset link's `?token=`), cookie, header, body, query, id or free text from the request
  can reach a line. A real-socket test sends credentials, cookies, a reset token, an email address, a password
  and a guest's phone ref, and checks that none appears.

### Server errors, by code and location — never by message

- When a request ends in a 500, `ProductApi.handle` (and the web layer's catch) records it in `ErrorLog`.
- An entry holds the `DOMAIN.FAILURE_MODE` code (a `WeddingPlannerError`'s code, or `UNHANDLED.<ErrorName>`), the
  error's class name, the top five stack frames (file:line locations), the method, the route pattern, the tenant
  slug and the time.
- It **never** holds the message. Messages embed data: a JSON parse error quotes its input, and a storage error
  can quote a stored record. A test drives a fault whose message contains an email and a phone number, and checks
  that neither is recorded.
- Recording happens in the catch, after the request's transaction has rolled back (ADR 0039), so the entry
  survives the failed request. It never throws: if the store is what failed, the entry is lost rather than the
  process.
- 4xx responses are client errors and are not recorded.
- The log is bounded (newest 200) in the global partition. The operator reads it at `GET /admin/errors`, as the
  console page or as JSON.

### The build commit in /healthz

- `/healthz` answers `{status: "ok", commit}`. The commit comes from `WP_BUILD_COMMIT` (baked in with `docker build
  --build-arg`, which `scripts/docker_build.sh` does with the full sha). Failing that, it comes from the tag of
  `WP_IMAGE_REF`. Failing both, it is `unknown`.
- The deployed stack sets `WP_IMAGE_REF: ${WEDDING_PLANNER_IMAGE}`, the image the deploy pinned
  (`wedding-planner:<short sha>`; the stack validator allows the pin in `environment`). So production reports the
  short commit without any change to the host's build.
- Only a 7–40 character hex id is ever reported, never free text from the environment. The boot log names it too.

## Consequences

- The host's container logs now hold one line per request, readable with `docker logs wedding-planner` on the host.
  They carry routes and statuses, not people.
- `/admin/errors` gives the owner the code and code location of each server fault. Diagnosing one may still need
  reproducing it, because the inputs are deliberately not kept.
- Not done: log shipping, metrics and alerting (production operations, M5), and request ids correlating a log line
  with an error entry.
